// ============================================================
// MÓDULO: groups.js
// Grupos de carona — tela de criar/entrar, convites e troca de grupo.
//
// Um usuário participa de VÁRIOS grupos ao longo do tempo, mas só um fica
// ATIVO por vez: é ele que define quais viagens, pagamentos e passageiros
// o app mostra. Trocar de grupo é trocar de contexto inteiro.
//
// Quem cria um grupo vira DONO dele — o segundo nível de administração,
// ao lado do ADM SUPREMO (dono do software).
// ============================================================

import {
  currentProfile, currentUser, refreshProfile, setActiveGroup, logoutUser
} from "../auth/auth.js";
import {
  getGroup, getGroupInvites, getInvitesForEmail,
  setTripValueCache, getDefaultTripValue, toMillis
} from "../js/db.js";
import {
  createGroup, createInvite, revokeInvite, joinGroup, leaveGroup
} from "../js/worker-api.js";
import {
  showToast, escapeHtml, formatDateTime, icon, copyToClipboard
} from "../js/utils.js";

// ── ESTADO ────────────────────────────────────────────────────

// Documento do grupo ATIVO. Guarda nome, chave PIX e valor da viagem — é
// daqui que as abas tiram o preço e o PIX, não mais do config global.
export let currentGroup = null;

// Quem recarrega o app depois de uma troca de grupo. Definido pelo app.js;
// mantido como callback para groups.js não precisar importar app.js (o que
// fecharia um ciclo, já que o app.js importa este módulo).
let onGroupChanged = async () => {};

export function setGroupChangeHandler(fn) {
  onGroupChanged = fn || (async () => {});
}

// ── CARREGAR O CONTEXTO DO GRUPO ──────────────────────────────

/**
 * Lê o documento do grupo ativo e publica o valor da viagem na sessão.
 * Chamado na entrada do app e a cada troca de grupo.
 */
export async function loadGroupContext() {
  const gid = currentProfile?.groupId || null;
  currentGroup = gid ? await getGroup(gid) : null;

  setTripValueCache(
    typeof currentGroup?.tripValue === "number" ? currentGroup.tripValue : getDefaultTripValue()
  );
  return currentGroup;
}

/** Chave PIX do grupo ativo (vazia se o dono ainda não cadastrou). */
export function groupPixKey() {
  return currentGroup?.pixKey || "";
}

export function groupName() {
  return currentGroup?.name || "";
}

// ── TELA DE GRUPOS ────────────────────────────────────────────

let screenBound = false;

export function initGroupScreen() {
  if (screenBound) return;
  screenBound = true;

  document.getElementById("form-create-group")?.addEventListener("submit", handleCreateGroup);
  document.getElementById("form-join-group")?.addEventListener("submit", handleJoinGroup);
  document.getElementById("btn-group-back")?.addEventListener("click", () => onGroupChanged());
  document.getElementById("btn-group-logout")?.addEventListener("click", () => logoutUser());
  document.getElementById("btn-leave-group")?.addEventListener("click", handleLeaveGroup);

  document.getElementById("tab-join-group")?.addEventListener("click",   () => showGroupTab(false));
  document.getElementById("tab-create-group")?.addEventListener("click", () => showGroupTab(true));

  // Link de convite compartilhado: ...?convite=ABCD1234 já chega preenchido.
  const fromLink = new URLSearchParams(location.search).get("convite");
  const codeInput = document.getElementById("join-code");
  if (fromLink && codeInput) codeInput.value = fromLink.trim().toUpperCase().slice(0, 12);

  // O campo de código é sempre maiúsculo — o alfabeto do convite é.
  codeInput?.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
}

/**
 * Alterna entre "Entrar em um grupo" e "Criar um grupo" — mesmo padrão das
 * abas Entrar/Criar conta do login: uma aba ativa, um formulário à mostra.
 * @param {boolean} create true = mostrar o formulário de criação
 */
function showGroupTab(create) {
  document.getElementById("tab-join-group")?.classList.toggle("auth-tab--active", !create);
  document.getElementById("tab-create-group")?.classList.toggle("auth-tab--active", create);
  document.getElementById("form-join-group")?.classList.toggle("hidden", create);
  document.getElementById("form-create-group")?.classList.toggle("hidden", !create);

  const note = document.getElementById("group-footer-note");
  if (note) {
    note.textContent = create
      ? "Quem cria o grupo vira o administrador dele: define o valor da viagem, a chave PIX e quem entra."
      : "Recebeu um convite? Use o código que te mandaram.";
  }

  const joinError   = document.getElementById("join-error");
  const createError = document.getElementById("create-group-error");
  if (joinError)   joinError.textContent = "";
  if (createError) createError.textContent = "";
}

/**
 * Abre a tela de grupos por fora do fluxo de entrada (botão do perfil).
 * Mexe nas classes de tela aqui mesmo em vez de chamar o app.js — importar
 * o app.js daqui fecharia um ciclo, já que é ele que importa este módulo.
 */
export async function openGroupScreen() {
  document.querySelectorAll(".modal--open").forEach(m => m.classList.remove("modal--open"));
  document.querySelectorAll(".screen").forEach(s => s.classList.remove("screen--visible"));
  document.getElementById("group-screen")?.classList.add("screen--visible");
  initGroupScreen();
  await renderGroupScreen();
}

/** Mostra a tela e (re)desenha tudo. */
export async function renderGroupScreen() {
  // Quem está logado. O e-mail vem primeiro por ser o identificador que a
  // pessoa reconhece como "sou eu" — dois nomes iguais são comuns, dois
  // e-mails iguais não existem.
  const who = document.getElementById("group-account-who");
  if (who) who.textContent = currentUser?.email || currentProfile?.name || "—";

  const back = document.getElementById("btn-group-back");
  back?.classList.toggle("hidden", !currentProfile?.groupId);

  const sub = document.getElementById("group-screen-sub");
  if (sub) {
    sub.textContent = currentProfile?.groupId
      ? "Troque de grupo ou crie um novo"
      : "Crie um grupo ou use um convite para começar";
  }

  // Sair só aparece para quem NÃO é o dono: o dono transfere a posse ou
  // apaga o grupo (o Worker recusa a saída dele de qualquer forma, para não
  // deixar um grupo com passageiros e sem administrador).
  document.getElementById("btn-leave-group")
    ?.classList.toggle("hidden", !currentProfile?.groupId || currentProfile.groupRole === "owner");

  // Sugere o valor padrão do sistema no formulário de criação.
  const valueInput = document.getElementById("create-group-value");
  if (valueInput && !valueInput.value) valueInput.value = getDefaultTripValue();

  renderMyGroups();
  const pendingInvites = await renderMyInvites();

  // Abre na aba que resolve o caso da pessoa: quem chegou com um código na
  // mão (link de convite ou convite pendente) cai em "Entrar"; quem não tem
  // nada disso está aqui para montar o próprio grupo.
  const hasCode = !!document.getElementById("join-code")?.value;
  showGroupTab(!hasCode && pendingInvites === 0);
}

function renderMyGroups() {
  const box  = document.getElementById("group-list");
  const card = document.getElementById("group-list-card");
  if (!box) return;

  const groups  = currentProfile?.groups || [];
  const activeId = currentProfile?.groupId || null;

  // Sem grupo nenhum, o cartão inteiro sai da tela em vez de exibir um "você
  // não participa de nenhum" — o que resta é logo + abas + formulário, igual
  // ao login.
  card?.classList.toggle("hidden", groups.length === 0);
  if (groups.length === 0) { box.innerHTML = ""; return; }

  box.innerHTML = groups.map(g => `
    <button class="group-item ${g.id === activeId ? "group-item--active" : ""}"
            data-select-group="${escapeHtml(g.id)}">
      <span class="group-item__mark">${g.id === activeId ? icon("check") : ""}</span>
      <span class="group-item__body">
        <span class="group-item__name">${escapeHtml(g.name || "Grupo")}</span>
        <span class="group-item__role">${g.role === "owner" ? "você é o dono" : "passageiro"}</span>
      </span>
      ${g.id === activeId ? `<span class="badge badge--active">ativo</span>` : ""}
    </button>
  `).join("");

  box.querySelectorAll("[data-select-group]").forEach(btn => {
    btn.addEventListener("click", () => switchGroup(btn.dataset.selectGroup));
  });
}

/** @returns {Promise<number>} quantos convites válidos foram desenhados */
async function renderMyInvites() {
  const box  = document.getElementById("group-invites");
  const card = document.getElementById("group-invites-card");
  if (!box) return 0;

  let invites = [];
  try {
    invites = await getInvitesForEmail(currentUser?.email || "");
  } catch (e) {
    // Sem convite nenhum a consulta é negada documento a documento e volta
    // vazia — não é erro que mereça alarme na tela.
    invites = [];
  }

  const valid = invites.filter(i => toMillis(i.expiresAt) > Date.now());
  card?.classList.toggle("hidden", valid.length === 0);
  if (valid.length === 0) { box.innerHTML = ""; return 0; }

  box.innerHTML = valid.map(i => `
    <div class="group-invite">
      <div class="group-invite__info">
        <div class="group-invite__group">${escapeHtml(i.groupName || "Grupo")}</div>
        <div class="group-invite__by">convite de ${escapeHtml(i.createdByName || "—")}</div>
      </div>
      <button class="btn btn--sm btn--primary" data-accept-invite="${escapeHtml(i.code)}">Aceitar</button>
    </div>
  `).join("");

  box.querySelectorAll("[data-accept-invite]").forEach(btn => {
    btn.addEventListener("click", () => acceptInvite(btn.dataset.acceptInvite, btn));
  });

  return valid.length;
}

// ── AÇÕES DA TELA ─────────────────────────────────────────────

async function handleCreateGroup(e) {
  e.preventDefault();
  const btn     = document.getElementById("btn-create-group");
  const errorEl = document.getElementById("create-group-error");
  const name    = document.getElementById("create-group-name").value.trim();
  const pixKey  = document.getElementById("create-group-pix").value.trim();
  const raw     = document.getElementById("create-group-value").value;
  const tripValue = parseFloat(String(raw).replace(",", "."));

  errorEl.textContent = "";
  if (name.length < 2)  { errorEl.textContent = "Dê um nome ao grupo."; return; }
  if (isNaN(tripValue) || tripValue < 0) {
    errorEl.textContent = "Informe um valor válido por viagem."; return;
  }

  btn.disabled = true;
  btn.textContent = "Criando...";
  try {
    const { group } = await createGroup({ name, pixKey, tripValue });
    await refreshProfile();
    await loadGroupContext();
    showToast(`Grupo "${group.name}" criado. Você é o dono!`, "success");
    document.getElementById("form-create-group").reset();
    await onGroupChanged();
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || "Não foi possível criar o grupo.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Criar grupo";
  }
}

async function handleJoinGroup(e) {
  e.preventDefault();
  const btn     = document.getElementById("btn-join-group");
  const errorEl = document.getElementById("join-error");
  const code    = document.getElementById("join-code").value.trim().toUpperCase();

  errorEl.textContent = "";
  if (code.length < 6) { errorEl.textContent = "Digite o código do convite."; return; }

  btn.disabled = true;
  btn.textContent = "Entrando...";
  try {
    const { group } = await joinGroup(code);
    await refreshProfile();
    await loadGroupContext();
    showToast(`Você entrou em "${group.name}".`, "success");
    document.getElementById("join-code").value = "";
    await onGroupChanged();
  } catch (err) {
    errorEl.textContent = err.message || "Convite inválido.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Entrar no grupo";
  }
}

async function acceptInvite(code, btn) {
  btn.disabled = true;
  btn.textContent = "...";
  try {
    const { group } = await joinGroup(code);
    await refreshProfile();
    await loadGroupContext();
    showToast(`Você entrou em "${group.name}".`, "success");
    await onGroupChanged();
  } catch (err) {
    showToast(err.message || "Não foi possível aceitar o convite.", "error");
    btn.disabled = false;
    btn.textContent = "Aceitar";
  }
}

/** Troca o grupo ativo e recarrega o app inteiro no novo contexto. */
export async function switchGroup(groupId) {
  if (!groupId || groupId === currentProfile?.groupId) return;
  try {
    await setActiveGroup(groupId);
    await loadGroupContext();
    showToast(`Agora você está em "${groupName()}".`, "info");
    await onGroupChanged();
  } catch (e) {
    console.error(e);
    showToast("Não foi possível trocar de grupo.", "error");
  }
}

/** Sai do grupo ativo. O dono não passa por aqui — o Worker recusa. */
async function handleLeaveGroup() {
  const btn = document.getElementById("btn-leave-group");
  const name = groupName();
  btn.disabled = true;
  btn.textContent = "Saindo...";
  try {
    await leaveGroup(currentProfile?.groupId);
    await refreshProfile();
    await loadGroupContext();
    showToast(`Você saiu de "${name}".`, "info");
    await renderGroupScreen();
  } catch (e) {
    showToast(e.message || "Não foi possível sair do grupo.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Sair do grupo atual";
  }
}

// ── CONVITES (dono do grupo) ──────────────────────────────────

let inviteBound = false;

export function initInviteModal() {
  if (inviteBound) return;
  inviteBound = true;

  document.getElementById("form-invite")?.addEventListener("submit", handleGenerateInvite);
  document.getElementById("btn-copy-invite")?.addEventListener("click", copyInviteLink);
}

export async function openInviteModal() {
  if (!currentProfile?.groupId) {
    showToast("Entre em um grupo antes de convidar alguém.", "info");
    return;
  }
  document.getElementById("invite-email").value = "";
  document.getElementById("invite-error").textContent = "";
  document.getElementById("invite-result").classList.add("hidden");
  document.getElementById("modal-invite").classList.add("modal--open");
  await renderGroupInvites();
}

async function handleGenerateInvite(e) {
  e.preventDefault();
  const btn     = document.getElementById("btn-generate-invite");
  const errorEl = document.getElementById("invite-error");
  const email   = document.getElementById("invite-email").value.trim();

  errorEl.textContent = "";
  btn.disabled = true;
  btn.textContent = "Gerando...";
  try {
    const { invite } = await createInvite(email || undefined);
    showInviteResult(invite);
    document.getElementById("invite-email").value = "";
    await renderGroupInvites();
  } catch (err) {
    errorEl.textContent = err.message || "Não foi possível gerar o convite.";
  } finally {
    btn.disabled = false;
    btn.textContent = "Gerar convite";
  }
}

function inviteLink(code) {
  return `${location.origin}${location.pathname}?convite=${encodeURIComponent(code)}`;
}

function showInviteResult(invite) {
  const box = document.getElementById("invite-result");
  document.getElementById("invite-code").textContent = invite.code;
  document.getElementById("invite-target").textContent = invite.invitedEmail
    ? `Só ${invite.invitedEmail} pode usar este código.`
    : "Qualquer pessoa com este código entra no grupo.";
  box.dataset.code = invite.code;
  box.classList.remove("hidden");
}

async function copyInviteLink() {
  const code = document.getElementById("invite-result").dataset.code;
  if (!code) return;
  const ok = await copyToClipboard(inviteLink(code));
  showToast(ok ? "Link do convite copiado!" : "Não foi possível copiar.", ok ? "success" : "error");
}

async function renderGroupInvites() {
  const box = document.getElementById("invite-list");
  if (!box) return;
  box.innerHTML = `<div class="loading-spinner"></div>`;

  try {
    const invites = await getGroupInvites(currentProfile.groupId);
    const now = Date.now();
    const open = invites.filter(i => i.status === "pending" && toMillis(i.expiresAt) > now);

    if (open.length === 0) {
      box.innerHTML = `<p class="empty-msg">Nenhum convite em aberto.</p>`;
      return;
    }

    box.innerHTML = open.map(i => `
      <div class="invite-row">
        <div class="invite-row__info">
          <code class="invite-row__code">${escapeHtml(i.code)}</code>
          <span class="invite-row__to">${i.invitedEmail ? escapeHtml(i.invitedEmail) : "código aberto"}</span>
          <span class="invite-row__exp">expira ${formatDateTime(i.expiresAt)}</span>
        </div>
        <button class="btn-icon btn-icon--delete" title="Cancelar convite"
                data-revoke-invite="${escapeHtml(i.code)}">${icon("trash")}</button>
      </div>
    `).join("");

    box.querySelectorAll("[data-revoke-invite]").forEach(btn => {
      btn.addEventListener("click", async () => {
        btn.disabled = true;
        try {
          await revokeInvite(btn.dataset.revokeInvite);
          showToast("Convite cancelado.", "info");
          await renderGroupInvites();
        } catch (e) {
          showToast(e.message || "Erro ao cancelar.", "error");
          btn.disabled = false;
        }
      });
    });
  } catch (e) {
    box.innerHTML = `<p class="error-msg">Erro ao carregar os convites.</p>`;
  }
}
