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
  getUserUnpaidTrips, getGroupUsers, tripAmount
} from "../js/db.js";
import {
  showToast, escapeHtml, formatDateTime, formatCurrency, icon, copyToClipboard, safeImageSrc, todayISO
} from "../js/utils.js";

// Paleta de cores do grupo. A primeira é o dourado da marca (default).
const GROUP_COLORS = ["#d4af37", "#e05c5c", "#4f9dde", "#5fbf7f", "#a678de", "#e08a3c"];

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

// ── TELA DE GRUPOS (HUB) ──────────────────────────────────────

let screenBound = false;
let selectedColor = GROUP_COLORS[0];  // cor escolhida no sheet de criação
let groupDocs = new Map();            // id -> doc do grupo (enriquece os cards)
let groupMembers = new Map();         // id -> [membros] (fotos nos cards)
let searchTerm = "";
let sortMode = "recent";              // "recent" | "name"

export function initGroupScreen() {
  if (screenBound) return;
  screenBound = true;

  document.getElementById("form-create-group")?.addEventListener("submit", handleCreateGroup);
  document.getElementById("form-join-group")?.addEventListener("submit", handleJoinGroup);
  document.getElementById("btn-group-back")?.addEventListener("click", () => onGroupChanged());
  document.getElementById("btn-group-logout")?.addEventListener("click", () => logoutUser());
  document.getElementById("btn-group-profile")?.addEventListener("click", goToProfile);
  document.getElementById("btn-leave-group")?.addEventListener("click", handleLeaveGroup);

  // Herói: entrar no grupo ativo / favoritar.
  document.getElementById("btn-hero-enter")?.addEventListener("click", () => onGroupChanged());
  document.getElementById("hero-fav")?.addEventListener("click", () => {
    if (currentProfile?.groupId) { toggleFav(currentProfile.groupId); renderGroupScreen(); }
  });

  // Tiles abrem os sheets; qualquer [data-close-sheet] fecha o seu.
  document.getElementById("tile-create")?.addEventListener("click", () => openSheet("sheet-create"));
  document.getElementById("tile-join")?.addEventListener("click",   () => openSheet("sheet-join"));
  document.querySelectorAll("[data-close-sheet]").forEach(el => {
    el.addEventListener("click", () => closeSheet(el.dataset.closeSheet));
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") document.querySelectorAll(".hub-sheet:not([hidden])").forEach(s => closeSheet(s.id));
  });

  // Busca e ordenação da lista de grupos.
  const search = document.getElementById("group-search");
  search?.addEventListener("input", () => { searchTerm = search.value.trim().toLowerCase(); renderMyGroups(); });
  document.getElementById("group-sort")?.addEventListener("click", () => {
    sortMode = sortMode === "recent" ? "name" : "recent";
    const lbl = document.getElementById("group-sort-label");
    if (lbl) lbl.textContent = sortMode === "recent" ? "Recentes" : "Nome";
    renderMyGroups();
  });

  buildColorSwatches();

  // Link de convite compartilhado: ...?convite=ABCD1234 abre o sheet já cheio.
  const fromLink = new URLSearchParams(location.search).get("convite");
  const codeInput = document.getElementById("join-code");
  if (fromLink && codeInput) {
    codeInput.value = fromLink.trim().toUpperCase().slice(0, 12);
    openSheet("sheet-join");
  }
  // O campo de código é sempre maiúsculo — o alfabeto do convite é.
  codeInput?.addEventListener("input", () => {
    codeInput.value = codeInput.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
  });
}

// ── FAVORITOS ─────────────────────────────────────────────────
// Guardados por dispositivo (localStorage), presos ao uid para não vazarem
// entre contas no mesmo navegador. É a marcação pessoal do usuário; quando a
// fase de personalização chegar, migra para um campo na própria membership.
function favKey() { return `caronaFavs:${currentProfile?.uid || "anon"}`; }
function getFavs() {
  try { return new Set(JSON.parse(localStorage.getItem(favKey()) || "[]")); }
  catch { return new Set(); }
}
function isFav(id) { return getFavs().has(id); }
function toggleFav(id) {
  const favs = getFavs();
  favs.has(id) ? favs.delete(id) : favs.add(id);
  try { localStorage.setItem(favKey(), JSON.stringify([...favs])); } catch {}
}

// ── SHEETS (bottom-sheet) ─────────────────────────────────────
function openSheet(id) {
  const s = document.getElementById(id);
  if (!s) return;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("hub-sheet--open"));
  s.querySelector("input")?.focus();
}
function closeSheet(id) {
  const s = document.getElementById(id);
  if (!s) return;
  s.classList.remove("hub-sheet--open");
  setTimeout(() => { s.hidden = true; }, 220); // espera a transição
}

// ── SWATCHES DE COR (sheet de criação) ────────────────────────
function buildColorSwatches() {
  const box = document.getElementById("create-group-swatches");
  if (!box) return;
  box.innerHTML = GROUP_COLORS.map((c, i) => `
    <button type="button" class="hub-swatch ${i === 0 ? "hub-swatch--on" : ""}"
            data-color="${c}" style="--sw:${c}" aria-label="Cor ${i + 1}"></button>
  `).join("");
  box.querySelectorAll(".hub-swatch").forEach(sw => {
    sw.addEventListener("click", () => {
      selectedColor = sw.dataset.color;
      box.querySelectorAll(".hub-swatch").forEach(x => x.classList.toggle("hub-swatch--on", x === sw));
    });
  });
}

function goToProfile() {
  // O perfil vive no app; se ainda não há grupo ativo, não há app para abrir,
  // então caímos no fluxo de entrada normal.
  if (currentProfile?.groupId) onGroupChanged().then(() => document.getElementById("btn-profile")?.click());
  else showToast("Entre em um grupo para acessar seu perfil.", "info");
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
  const groups   = currentProfile?.groups || [];
  const activeId = currentProfile?.groupId || null;
  const hasGroups = groups.length > 0;

  // Identity bar: avatar (inicial), nome e e-mail. O e-mail é o "sou eu"
  // inequívoco; o nome é o rótulo humano.
  const name = currentProfile?.name || "";
  const mail = currentUser?.email || "";
  const nameEl = document.getElementById("group-account-name");
  const mailEl = document.getElementById("group-account-who");
  const avEl   = document.getElementById("group-account-avatar");
  if (nameEl) nameEl.textContent = name || mail || "—";
  if (mailEl) mailEl.textContent = mail || "—";
  if (avEl) {
    // A foto de perfil é o padrão sempre que existir; a inicial é só o
    // fallback de quem ainda não colocou uma.
    const photo = safeImageSrc(currentProfile?.photo);
    if (photo) {
      avEl.classList.add("hub-identity__avatar--photo");
      avEl.innerHTML = `<img src="${photo}" alt="">`;
    } else {
      avEl.classList.remove("hub-identity__avatar--photo");
      avEl.textContent = (name || mail || "?").charAt(0).toUpperCase();
    }
  }

  const sub = document.getElementById("group-screen-sub");
  if (sub) sub.textContent = hasGroups
    ? "Escolha um grupo ou crie um novo"
    : "Crie um grupo ou use um convite para começar";

  document.getElementById("btn-group-back")?.classList.toggle("hidden", !activeId);
  document.getElementById("btn-leave-group")
    ?.classList.toggle("hidden", !activeId || currentProfile.groupRole === "owner");

  const valueInput = document.getElementById("create-group-value");
  if (valueInput && !valueInput.value) valueInput.value = getDefaultTripValue();

  // Enriquece os cards com o documento de cada grupo (membros, valor, cor) —
  // a membership no perfil só guarda id/nome/cargo.
  const docs = await Promise.all(groups.map(g => getGroup(g.id).catch(() => null)));
  groupDocs = new Map();
  groups.forEach((g, i) => { if (docs[i]) groupDocs.set(g.id, docs[i]); });

  // Fotos dos membros para o cantinho dos cards. Só o dono consegue listar
  // os outros (as rules); em grupo onde a pessoa é passageira, volta vazio e
  // o card cai no contador de membros — sem erro na tela.
  const memberLists = await Promise.all(groups.map(g => getGroupUsers(g.id).catch(() => [])));
  groupMembers = new Map();
  groups.forEach((g, i) => groupMembers.set(g.id, memberLists[i] || []));

  await renderHero(activeId);
  renderMyGroups();
  await renderMyInvites();
}

// ── CARD-HERÓI (grupo ativo) ──────────────────────────────────
async function renderHero(activeId) {
  const hero = document.getElementById("group-hero");
  if (!hero) return;
  if (!activeId) { hero.classList.add("hidden"); return; }
  hero.classList.remove("hidden");

  const doc  = groupDocs.get(activeId) || currentGroup || {};
  const role = currentProfile?.groupRole === "owner" ? "owner" : "member";
  const color = doc.color || "";
  hero.style.setProperty("--hero-color", color || "var(--accent)");

  document.getElementById("hero-name").textContent = doc.name || groupName() || "Grupo";
  const roleEl = document.getElementById("hero-role");
  roleEl.innerHTML = role === "owner"
    ? `${icon("crown")} Você é o dono`
    : `${icon("user")} Passageiro`;
  roleEl.classList.toggle("hub-hero__badge--owner", role === "owner");

  const members = Number(doc.memberCount) || 0;
  document.getElementById("hero-members").textContent =
    `${members} ${members === 1 ? "membro" : "membros"}`;
  const value = typeof doc.tripValue === "number" ? doc.tripValue : 0;
  document.getElementById("hero-value").textContent = `${formatCurrency(value)}/viagem`;

  const fav = document.getElementById("hero-fav");
  if (fav) { fav.hidden = false; fav.classList.toggle("hub-hero__fav--on", isFav(activeId)); }

  // Situação do usuário: viagens vencidas e não pagas no grupo ativo.
  const pill = document.getElementById("hero-status-pill");
  pill.className = "hub-status-pill";
  pill.textContent = "…";
  try {
    const unpaid = await getUserUnpaidTrips(currentProfile.uid, activeId);
    const due = unpaid.filter(t => t.date <= todayISO());
    if (due.length === 0) {
      pill.classList.add("hub-status-pill--ok");
      pill.textContent = "✓ Você está em dia";
    } else {
      const total = due.reduce((s, t) => s + tripAmount(t), 0);
      pill.classList.add("hub-status-pill--debt");
      pill.textContent = `${due.length} viagem(ns) · ${formatCurrency(total)} em aberto`;
    }
  } catch {
    pill.classList.add("hub-status-pill--muted");
    pill.textContent = "toque para entrar";
  }
}


/**
 * Pilha de avatares dos membros no cantinho do card. Mostra até 3 fotos (ou
 * iniciais) sobrepostas e um "+N". Se não deu para listar (a pessoa é só
 * passageira do grupo e as rules não deixam ver os outros), cai no contador.
 */
function memberStack(gid, memberCount) {
  const members = groupMembers.get(gid) || [];
  if (members.length === 0) {
    return `<span class="gcard__paxcount">${memberCount || "—"} pax</span>`;
  }
  const shown = members.slice(0, 3);
  const rest  = Math.max(0, (memberCount || members.length) - shown.length);
  const dots = shown.map(m => {
    const src = safeImageSrc(m.photo);
    const inner = src
      ? `<img src="${src}" alt="">`
      : escapeHtml((m.name || "?").charAt(0).toUpperCase());
    return `<span class="gcard__pax" style="background:${src ? "transparent" : "var(--bg-hover)"}">${inner}</span>`;
  }).join("");
  return `<span class="gcard__pax-stack">${dots}${rest > 0 ? `<span class="gcard__pax gcard__pax--more">+${rest}</span>` : ""}</span>`;
}

function renderMyGroups() {
  const box  = document.getElementById("group-list");
  const card = document.getElementById("group-list-card");
  if (!box) return;

  const groups   = currentProfile?.groups || [];
  const activeId = currentProfile?.groupId || null;

  card?.classList.toggle("hidden", groups.length === 0);
  document.getElementById("group-search-wrap")?.classList.toggle("hidden", groups.length < 4);
  if (groups.length === 0) { box.innerHTML = ""; return; }

  // Ordena: favoritos sempre no topo; depois pelo modo escolhido. "recent"
  // usa a ordem da membership (a mais nova é a última que a pessoa entrou).
  let list = groups.slice();
  if (sortMode === "name") list.sort((a, b) => (a.name || "").localeCompare(b.name || ""));
  else list.reverse();
  list.sort((a, b) => (isFav(b.id) ? 1 : 0) - (isFav(a.id) ? 1 : 0));

  if (searchTerm) list = list.filter(g => (g.name || "").toLowerCase().includes(searchTerm));

  if (list.length === 0) {
    box.innerHTML = `<p class="hub-empty">Nenhum grupo encontrado.</p>`;
    return;
  }

  box.innerHTML = list.map(g => {
    const doc = groupDocs.get(g.id) || {};
    const active = g.id === activeId;
    const members = Number(doc.memberCount) || 0;
    const value = typeof doc.tripValue === "number" ? doc.tripValue : null;
    const color = doc.color || "var(--accent)";
    const owner = g.role === "owner";
    return `
      <button class="gcard ${active ? "gcard--active" : ""}" data-select-group="${escapeHtml(g.id)}"
              style="--gc:${escapeHtml(color)}">
        <span class="gcard__accent"></span>
        <span class="gcard__top">
          <span class="gcard__avatar">${escapeHtml((g.name || "G").charAt(0).toUpperCase())}</span>
          <span class="gcard__fav ${isFav(g.id) ? "gcard__fav--on" : ""}" data-fav-group="${escapeHtml(g.id)}" role="button" aria-label="Favoritar">★</span>
        </span>
        <span class="gcard__name">${escapeHtml(g.name || "Grupo")}</span>
        <span class="gcard__role">${owner ? icon("crown") + " Dono" : icon("user") + " Passageiro"}</span>
        <span class="gcard__meta">
          ${memberStack(g.id, members)}
          <span class="hub-dot">•</span>
          <span>${value != null ? formatCurrency(value) : "—"}</span>
        </span>
        ${active ? `<span class="gcard__badge">● ativo</span>` : ""}
      </button>
    `;
  }).join("");

  box.querySelectorAll("[data-select-group]").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Clique na estrela favorita não troca de grupo.
      const star = e.target.closest("[data-fav-group]");
      if (star) { e.stopPropagation(); toggleFav(star.dataset.favGroup); renderGroupScreen(); return; }
      switchGroup(btn.dataset.selectGroup);
    });
  });
}

/** @returns {Promise<number>} quantos convites válidos foram desenhados */
async function renderMyInvites() {
  const box  = document.getElementById("group-invites");
  const card = document.getElementById("group-invites-card");
  const countEl = document.getElementById("group-invites-count");
  if (!box) return 0;

  let invites = [];
  try {
    invites = await getInvitesForEmail(currentUser?.email || "");
  } catch (e) {
    invites = [];
  }

  // Além de expirados, escondemos os que o usuário já recusou neste aparelho.
  const dismissed = getDismissedInvites();
  const valid = invites.filter(i => toMillis(i.expiresAt) > Date.now() && !dismissed.has(i.code));
  card?.classList.toggle("hidden", valid.length === 0);
  if (countEl) countEl.textContent = valid.length ? String(valid.length) : "";
  if (valid.length === 0) { box.innerHTML = ""; return 0; }

  box.innerHTML = valid.map(i => `
    <div class="hub-invite" data-invite="${escapeHtml(i.code)}">
      <div class="hub-invite__info">
        <div class="hub-invite__group">${escapeHtml(i.groupName || "Grupo")}</div>
        <div class="hub-invite__by">convite de ${escapeHtml(i.createdByName || "—")}</div>
      </div>
      <div class="hub-invite__actions">
        <button class="btn btn--ghost btn--sm" data-decline-invite="${escapeHtml(i.code)}">Recusar</button>
        <button class="btn btn--primary btn--sm" data-accept-invite="${escapeHtml(i.code)}">Aceitar</button>
      </div>
    </div>
  `).join("");

  box.querySelectorAll("[data-accept-invite]").forEach(btn => {
    btn.addEventListener("click", () => acceptInvite(btn.dataset.acceptInvite, btn));
  });
  box.querySelectorAll("[data-decline-invite]").forEach(btn => {
    btn.addEventListener("click", () => { dismissInvite(btn.dataset.declineInvite); renderMyInvites(); });
  });

  return valid.length;
}

// Recusar é local por enquanto: some da lista neste aparelho, sem apagar o
// convite no servidor (isso vira endpoint próprio na fase de backend).
function dismissKey() { return `caronaInvDismiss:${currentProfile?.uid || "anon"}`; }
function getDismissedInvites() {
  try { return new Set(JSON.parse(localStorage.getItem(dismissKey()) || "[]")); }
  catch { return new Set(); }
}
function dismissInvite(code) {
  const s = getDismissedInvites(); s.add(code);
  try { localStorage.setItem(dismissKey(), JSON.stringify([...s])); } catch {}
}

// ── AÇÕES DA TELA ─────────────────────────────────────────────

async function handleCreateGroup(e) {
  e.preventDefault();
  const btn     = document.getElementById("btn-create-group");
  const errorEl = document.getElementById("create-group-error");
  const name    = document.getElementById("create-group-name").value.trim();
  const pixKey  = document.getElementById("create-group-pix").value.trim();
  const description = document.getElementById("create-group-desc")?.value.trim() || "";
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
    const { group } = await createGroup({ name, pixKey, tripValue, description, color: selectedColor });
    await refreshProfile();
    await loadGroupContext();
    showToast(`Grupo "${group.name}" criado. Você é o dono!`, "success");
    document.getElementById("form-create-group").reset();
    closeSheet("sheet-create");
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
    closeSheet("sheet-join");
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
