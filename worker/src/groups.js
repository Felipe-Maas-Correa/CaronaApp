// ============================================================
// MÓDULO: groups.js  (Cloudflare Worker)
// Ciclo de vida dos GRUPOS DE CARONA.
//
// Por que no servidor e não nas security rules?
// Cada operação aqui toca VÁRIOS documentos que precisam mudar juntos:
// criar um grupo mexe no grupo E no perfil do dono; aceitar um convite
// mexe no convite, no perfil do convidado e na contagem do grupo. As
// rules avaliam um documento por vez — não conseguem garantir que o
// conjunto fique coerente, nem impedir que alguém escreva só metade.
//
// Com a service account, o Worker é a ÚNICA porta de entrada: as rules
// negam escrita do cliente em `groups` e `invites`, e o campo `groupIds`
// do perfil (que é o que prova a associação) também só é escrito aqui.
// ============================================================

import { getDoc, patchDoc, deleteDoc, queryDocs, listDocs } from "./firebase.js";
import { json, authCaller, httpError } from "./http.js";

// ── CONSTANTES ───────────────────────────────────────────────

const SAFE_UID   = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_GID   = /^[A-Za-z0-9_-]{1,64}$/;
const SAFE_CODE  = /^[A-Z0-9]{6,12}$/;
const EMAIL_RE   = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

// Sem I, O, 0 e 1: o código é lido em voz alta e digitado à mão.
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const INVITE_TTL_MS   = 7 * 24 * 60 * 60 * 1000; // 7 dias
const MAX_OWNED       = 5;    // grupos que uma mesma pessoa pode criar
const MAX_OPEN_INVITE = 50;   // convites pendentes por grupo
const DEFAULT_TRIP_VALUE = 15;

// ── HELPERS ──────────────────────────────────────────────────

function randomCode(len = 8) {
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = "";
  for (const b of bytes) out += CODE_ALPHABET[b % CODE_ALPHABET.length];
  return out;
}

function newGroupId() {
  return "grp_" + crypto.randomUUID().replace(/-/g, "").slice(0, 20);
}

function normEmail(v) {
  return String(v || "").trim().toLowerCase();
}

function toMillis(v) {
  if (!v) return 0;
  if (v instanceof Date) return v.getTime();
  const t = new Date(v).getTime();
  return isNaN(t) ? 0 : t;
}

/** Perfil do chamador, já exigindo que exista e esteja ativo. */
async function callerProfile(env, uid) {
  const profile = await getDoc(env, "users/" + uid);
  if (!profile) throw httpError(403, "Perfil não encontrado.");
  if (profile.active === false) throw httpError(403, "Conta inativa.");
  return profile;
}

function isSuperAdmin(profile) {
  return !!profile && profile.role === "admin" && profile.active !== false;
}

/** Grupo existente, ou 404. */
async function loadGroup(env, gid) {
  if (!SAFE_GID.test(String(gid || ""))) throw httpError(400, "Grupo inválido.");
  const group = await getDoc(env, "groups/" + gid);
  if (!group) throw httpError(404, "Grupo não encontrado.");
  return group;
}

/**
 * Só o DONO do grupo (ou o ADM SUPREMO) passa daqui. É a fronteira entre os
 * dois níveis de administração: o dono manda no grupo dele e em mais nada.
 */
function assertCanAdminGroup(group, caller, profile) {
  if (group.ownerUid === caller.uid) return;
  if (isSuperAdmin(profile)) return;
  throw httpError(403, "Só o dono do grupo pode fazer isso.");
}

/** Acrescenta (ou atualiza) a associação do usuário a um grupo. */
function withMembership(profile, group, role) {
  const ids  = Array.isArray(profile.groupIds) ? profile.groupIds.slice() : [];
  if (!ids.includes(group.id)) ids.push(group.id);

  const list = (Array.isArray(profile.groups) ? profile.groups : [])
    .filter(g => g && g.id && g.id !== group.id);
  list.push({ id: group.id, name: group.name, role });

  return { groupIds: ids, groups: list };
}

/** Remove a associação; se era o grupo ativo, cai para outro (ou nenhum). */
function withoutMembership(profile, gid) {
  const ids  = (Array.isArray(profile.groupIds) ? profile.groupIds : []).filter(id => id !== gid);
  const list = (Array.isArray(profile.groups) ? profile.groups : [])
    .filter(g => g && g.id && g.id !== gid);

  let groupId   = profile.groupId ?? null;
  let groupRole = profile.groupRole ?? null;

  if (groupId === gid) {
    const fallback = list[0] || null;
    groupId   = fallback ? fallback.id   : null;
    groupRole = fallback ? fallback.role : null;
  }

  return { groupIds: ids, groups: list, groupId, groupRole };
}

const MEMBERSHIP_MASK = ["groupId", "groupRole", "groupIds", "groups"];

// Todos os perfis que participam de um grupo.
function membersOf(env, gid) {
  return queryDocs(env, "users", "groupIds", gid, "ARRAY_CONTAINS");
}

// ── CRIAR GRUPO ──────────────────────────────────────────────
// Quem cria vira DONO na hora — este é o segundo nível de administração.
// Não precisa de convite nem de aprovação: o grupo nasce vazio e só quem
// ele convidar entra.
export async function handleCreateGroup(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const name = String(body.name || "").trim().slice(0, 60);
  if (name.length < 2) return json(env, request, { error: "Dê um nome ao grupo (mín. 2 caracteres)." }, 400);

  const pixKey = String(body.pixKey || "").trim().slice(0, 140);

  // Valor da viagem: o que veio, senão o padrão do sistema, senão 15.
  let tripValue = Number(body.tripValue);
  if (!Number.isFinite(tripValue) || tripValue < 0 || tripValue > 100000) {
    const settings = await getDoc(env, "settings/app");
    tripValue = typeof settings?.tripValue === "number" ? settings.tripValue : DEFAULT_TRIP_VALUE;
  }
  tripValue = Math.round(tripValue * 100) / 100;

  // Teto de grupos por pessoa: sem isto, um script cria grupos sem fim.
  if (!isSuperAdmin(profile)) {
    const owned = await queryDocs(env, "groups", "ownerUid", caller.uid, "EQUAL", MAX_OWNED + 1);
    if (owned.length >= MAX_OWNED) {
      return json(env, request, { error: `Você já criou ${MAX_OWNED} grupos.` }, 409);
    }
  }

  const group = {
    id:          newGroupId(),
    name,
    ownerUid:    caller.uid,
    ownerName:   profile.name || caller.email || "",
    pixKey,
    tripValue,
    memberCount: 1,
    active:      true,
    createdAt:   new Date()
  };
  await patchDoc(env, "groups/" + group.id, group);

  const membership = withMembership(profile, group, "owner");
  await patchDoc(env, "users/" + caller.uid, {
    ...membership,
    groupId:   group.id,
    groupRole: "owner"
  }, MEMBERSHIP_MASK);

  return json(env, request, { ok: true, group });
}

// ── CONVIDAR ─────────────────────────────────────────────────
// Duas formas, o mesmo documento:
//   • com e-mail → só aquela pessoa aceita (o Worker confere o e-mail do
//     token dela na hora de entrar);
//   • sem e-mail → código aberto, para mandar por WhatsApp.
// Em ambos o código expira em 7 dias e vale UMA vez.
export async function handleCreateInvite(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const gid   = String(body.groupId || profile.groupId || "");
  const group = await loadGroup(env, gid);
  assertCanAdminGroup(group, caller, profile);

  let invitedEmail = null;
  if (body.email) {
    invitedEmail = normEmail(body.email).slice(0, 140);
    if (!EMAIL_RE.test(invitedEmail)) {
      return json(env, request, { error: "E-mail inválido." }, 400);
    }
  }

  // Convites pendentes acumulados são superfície de ataque parada: limita.
  const existing = await queryDocs(env, "invites", "groupId", gid, "EQUAL", 200);
  const now  = Date.now();
  const open = existing.filter(i => i.data.status === "pending" && toMillis(i.data.expiresAt) > now);
  if (open.length >= MAX_OPEN_INVITE) {
    return json(env, request, { error: "Há convites demais em aberto. Revogue alguns antes." }, 409);
  }

  // Colisão de código é improvável (32^8), mas conferir é barato.
  let code = null;
  for (let i = 0; i < 5; i++) {
    const candidate = randomCode(8);
    if (!(await getDoc(env, "invites/" + candidate))) { code = candidate; break; }
  }
  if (!code) return json(env, request, { error: "Não foi possível gerar o convite. Tente de novo." }, 503);

  const invite = {
    code,
    groupId:       group.id,
    groupName:     group.name,
    invitedEmail,
    createdBy:     caller.uid,
    createdByName: profile.name || "",
    status:        "pending",
    createdAt:     new Date(),
    expiresAt:     new Date(now + INVITE_TTL_MS),
    acceptedBy:    null,
    acceptedAt:    null
  };
  await patchDoc(env, "invites/" + code, invite);

  return json(env, request, { ok: true, invite });
}

// ── REVOGAR CONVITE ──────────────────────────────────────────
export async function handleRevokeInvite(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim().toUpperCase();
  if (!SAFE_CODE.test(code)) return json(env, request, { error: "Código inválido." }, 400);

  const invite = await getDoc(env, "invites/" + code);
  if (!invite) return json(env, request, { error: "Convite não encontrado." }, 404);
  if (invite.status === "accepted") {
    return json(env, request, { error: "Este convite já foi usado." }, 409);
  }

  const group = await loadGroup(env, invite.groupId);
  assertCanAdminGroup(group, caller, profile);

  await patchDoc(env, "invites/" + code, { status: "revoked" }, ["status"]);
  return json(env, request, { ok: true });
}

// ── ENTRAR NO GRUPO (aceitar convite) ────────────────────────
export async function handleJoinGroup(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const code = String(body.code || "").trim().toUpperCase();
  if (!SAFE_CODE.test(code)) return json(env, request, { error: "Código inválido." }, 400);

  const invite = await getDoc(env, "invites/" + code);
  if (!invite)                      return json(env, request, { error: "Convite não encontrado." }, 404);
  if (invite.status === "accepted") return json(env, request, { error: "Este convite já foi usado." }, 409);
  if (invite.status === "revoked")  return json(env, request, { error: "Este convite foi cancelado." }, 409);
  if (toMillis(invite.expiresAt) < Date.now()) {
    return json(env, request, { error: "Este convite expirou. Peça outro ao dono do grupo." }, 409);
  }

  // Convite endereçado: só o dono do e-mail entra. O e-mail vem do TOKEN,
  // não do corpo da requisição — não dá para dizer "sou fulano".
  if (invite.invitedEmail && invite.invitedEmail !== normEmail(caller.email)) {
    return json(env, request, { error: "Este convite é para outro e-mail." }, 403);
  }

  const group = await loadGroup(env, invite.groupId);
  if (group.active === false) return json(env, request, { error: "Este grupo está desativado." }, 409);

  const already = Array.isArray(profile.groupIds) && profile.groupIds.includes(group.id);
  const role    = group.ownerUid === caller.uid ? "owner" : "member";

  const membership = withMembership(profile, group, role);
  await patchDoc(env, "users/" + caller.uid, {
    ...membership,
    groupId:   group.id,
    groupRole: role
  }, MEMBERSHIP_MASK);

  // Já era membro (voltou por um convite novo): não conta de novo nem
  // queima o convite — só troca o grupo ativo.
  if (!already) {
    await patchDoc(env, "groups/" + group.id,
      { memberCount: (Number(group.memberCount) || 0) + 1 }, ["memberCount"]);
    await patchDoc(env, "invites/" + code, {
      status:     "accepted",
      acceptedBy: caller.uid,
      acceptedAt: new Date()
    }, ["status", "acceptedBy", "acceptedAt"]);
  }

  return json(env, request, { ok: true, group, already });
}

// ── SAIR DO GRUPO ────────────────────────────────────────────
export async function handleLeaveGroup(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const gid  = String(body.groupId || profile.groupId || "");
  if (!SAFE_GID.test(gid)) return json(env, request, { error: "Grupo inválido." }, 400);

  const ids = Array.isArray(profile.groupIds) ? profile.groupIds : [];
  if (!ids.includes(gid)) return json(env, request, { error: "Você não participa deste grupo." }, 400);

  const group = await getDoc(env, "groups/" + gid);
  // O dono não abandona o grupo: ou transfere a posse, ou apaga. Sair
  // deixaria um grupo com membros e sem ninguém que possa administrá-lo.
  if (group && group.ownerUid === caller.uid) {
    return json(env, request,
      { error: "Você é o dono. Transfira a posse ou apague o grupo." }, 409);
  }

  await patchDoc(env, "users/" + caller.uid, withoutMembership(profile, gid), MEMBERSHIP_MASK);

  if (group) {
    await patchDoc(env, "groups/" + gid,
      { memberCount: Math.max(0, (Number(group.memberCount) || 1) - 1) }, ["memberCount"]);
  }

  return json(env, request, { ok: true });
}

// ── REMOVER MEMBRO (dono do grupo) ───────────────────────────
export async function handleRemoveMember(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const uid  = String(body.uid || "");
  if (!SAFE_UID.test(uid)) return json(env, request, { error: "Usuário inválido." }, 400);

  const gid   = String(body.groupId || profile.groupId || "");
  const group = await loadGroup(env, gid);
  assertCanAdminGroup(group, caller, profile);

  if (uid === group.ownerUid) {
    return json(env, request, { error: "O dono não pode ser removido do próprio grupo." }, 400);
  }

  const target = await getDoc(env, "users/" + uid);
  if (!target) return json(env, request, { error: "Usuário não encontrado." }, 404);

  const ids = Array.isArray(target.groupIds) ? target.groupIds : [];
  if (!ids.includes(gid)) return json(env, request, { error: "Esse usuário não está no grupo." }, 400);

  await patchDoc(env, "users/" + uid, withoutMembership(target, gid), MEMBERSHIP_MASK);
  await patchDoc(env, "groups/" + gid,
    { memberCount: Math.max(0, (Number(group.memberCount) || 1) - 1) }, ["memberCount"]);

  // As viagens e os pagamentos dele FICAM: são o histórico financeiro do
  // grupo, e apagá-los sumiria com dívida de verdade.
  return json(env, request, { ok: true, name: target.name || null });
}

// ── TRANSFERIR A POSSE ───────────────────────────────────────
export async function handleTransferGroup(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body = await request.json().catch(() => ({}));
  const uid  = String(body.uid || "");
  if (!SAFE_UID.test(uid)) return json(env, request, { error: "Usuário inválido." }, 400);

  const gid   = String(body.groupId || profile.groupId || "");
  const group = await loadGroup(env, gid);
  assertCanAdminGroup(group, caller, profile);

  if (uid === group.ownerUid) return json(env, request, { error: "Ele já é o dono." }, 400);

  const target = await getDoc(env, "users/" + uid);
  if (!target) return json(env, request, { error: "Usuário não encontrado." }, 404);
  const ids = Array.isArray(target.groupIds) ? target.groupIds : [];
  if (!ids.includes(gid)) return json(env, request, { error: "Esse usuário não está no grupo." }, 400);

  await patchDoc(env, "groups/" + gid,
    { ownerUid: uid, ownerName: target.name || "" }, ["ownerUid", "ownerName"]);

  // O papel gravado em cada perfil é só um espelho para a interface; quem
  // manda é groups/{gid}.ownerUid, que as rules leem. Ainda assim, manter
  // os dois de acordo evita botão fantasma na tela.
  const promoted = withMembership(target, { ...group, id: gid }, "owner");
  await patchDoc(env, "users/" + uid, {
    ...promoted,
    groupId:   target.groupId === gid ? gid : (target.groupId ?? null),
    groupRole: target.groupId === gid ? "owner" : (target.groupRole ?? null)
  }, MEMBERSHIP_MASK);

  const demoted = withMembership(profile, { ...group, id: gid }, "member");
  await patchDoc(env, "users/" + caller.uid, {
    ...demoted,
    groupId:   profile.groupId ?? null,
    groupRole: profile.groupId === gid ? "member" : (profile.groupRole ?? null)
  }, MEMBERSHIP_MASK);

  return json(env, request, { ok: true, newOwner: target.name || null });
}

// ── APAGAR GRUPO ─────────────────────────────────────────────
// Desfaz o quadro de membros e some com os convites. Viagens e pagamentos
// PERMANECEM — são histórico financeiro; some só quem enxerga.
export async function handleDeleteGroup(request, env) {
  const caller  = await authCaller(request, env);
  const profile = await callerProfile(env, caller.uid);

  const body  = await request.json().catch(() => ({}));
  const gid   = String(body.groupId || profile.groupId || "");
  const group = await loadGroup(env, gid);
  assertCanAdminGroup(group, caller, profile);

  const members = await membersOf(env, gid);
  for (const m of members) {
    await patchDoc(env, "users/" + m.id, withoutMembership(m.data, gid), MEMBERSHIP_MASK);
  }

  const invites = await queryDocs(env, "invites", "groupId", gid, "EQUAL", 200);
  for (const inv of invites) await deleteDoc(env, "invites/" + inv.id);

  await deleteDoc(env, "groups/" + gid);

  return json(env, request, { ok: true, removed: members.length });
}
