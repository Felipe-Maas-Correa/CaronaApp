// ============================================================
// MÓDULO: admin.js
// Painel de administração — DOIS NÍVEIS:
//
//  • DONO DO GRUPO  → o painel de cima: números, passageiros, valor da
//    viagem, chave PIX e convites DO GRUPO ATIVO. É o motorista que cobra.
//
//  • ADM SUPREMO    → tudo isso mais o bloco "Administração do sistema":
//    todos os grupos, todas as contas, promoção a admin do sistema e a
//    adoção dos dados que existiam antes dos grupos.
//
// A separação também vale no servidor: as rules e o Worker conferem dono do
// grupo × admin do sistema por conta própria. Aqui só se decide o que
// desenhar.
// ============================================================

import {
  doc, updateDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "../js/firebase-config.js";
import {
  getGroupTrips, getGroupPayments, getGroupUsers,
  getAllTrips, getAllPayments, getAllUsers, getAllGroups,
  getTripValue, setTripValueSetting, updateGroupSettings, clearGroupTrips
} from "../js/db.js";
import {
  registerUser, currentProfile, reauthenticate, refreshProfile,
  isAdmin, isSuperAdmin, isGroupOwner, myGroupId
} from "../auth/auth.js";
import {
  currentGroup, loadGroupContext, openInviteModal, groupName
} from "../groups/groups.js";
import {
  deleteUserAccount, deletePayment, removeMember, transferGroup,
  deleteGroup
} from "../js/worker-api.js";
import { showToast, formatCurrency, icon, escapeHtml, safeImageSrc, todayISO } from "../js/utils.js";

// Valor de cada viagem (respeita preços diferentes ao longo do tempo)
const amt = t => (typeof t.amount === "number" ? t.amount : 15);

// Conteúdo de um avatar: foto (se houver) ou a inicial do nome.
function avatarInner(name, photo) {
  const safe = safeImageSrc(photo);
  if (safe) return `<img src="${safe}" alt="" class="avatar-img">`;
  return escapeHtml((name || "?").charAt(0).toUpperCase());
}

// Estado
let currentPeriod = "month";
let cache  = { trips: [], payments: [], users: [] };          // grupo ativo
let system = { groups: [], users: [], trips: [], payments: [] }; // ADM SUPREMO

// ── INIT ─────────────────────────────────────────────────────

export async function initAdmin() {
  // Os eventos são ligados SEMPRE. Antes o bind acontecia só para quem já
  // era admin no primeiro carregamento — quem virasse dono de grupo depois
  // (criando um grupo, por exemplo) ficava com o painel morto até recarregar.
  bindAdminEvents();
  if (isAdmin()) await loadUsersList();
}

function bindAdminEvents() {
  // Convites (dono do grupo)
  document.getElementById("btn-invite")?.addEventListener("click", openInviteModal);

  // Modal: novo usuário (ADM SUPREMO)
  document.getElementById("btn-new-user")?.addEventListener("click", openNewUserModal);
  document.getElementById("btn-close-user-modal")?.addEventListener("click", () =>
    document.getElementById("modal-new-user").classList.remove("modal--open"));
  document.getElementById("form-new-user")?.addEventListener("submit", handleCreateUser);

  // Seletor de período
  document.getElementById("adm-period")?.querySelectorAll(".adm-seg__btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentPeriod = btn.dataset.period;
      document.querySelectorAll("#adm-period .adm-seg__btn")
        .forEach(b => b.classList.toggle("adm-seg__btn--active", b === btn));
      renderPeriodStats();
      renderPerUser();
    });
  });

  // Limpar viagens do grupo
  document.getElementById("btn-clear-data")?.addEventListener("click", confirmClearData);

  // Apagar o grupo inteiro
  document.getElementById("btn-delete-group")?.addEventListener("click", confirmDeleteGroup);

  // Valor da viagem: campo, stepper e salvar
  const priceInput = document.getElementById("adm-price-input");
  if (priceInput) priceInput.value = getTripValue();
  const stepPrice = (delta) => {
    const cur = parseFloat(String(priceInput.value).replace(",", ".")) || 0;
    priceInput.value = Math.max(0, Math.round((cur + delta) * 100) / 100);
  };
  document.getElementById("price-up")?.addEventListener("click", () => stepPrice(1));
  document.getElementById("price-down")?.addEventListener("click", () => stepPrice(-1));
  document.getElementById("btn-save-price")?.addEventListener("click", handleSavePrice);

  // Chave PIX do grupo
  document.getElementById("btn-save-pix")?.addEventListener("click", handleSavePix);
}

// ── CONFIGURAÇÕES DO GRUPO ───────────────────────────────────

async function handleSavePrice() {
  const input = document.getElementById("adm-price-input");
  const value = parseFloat(String(input.value).replace(",", "."));
  if (isNaN(value) || value < 0) { showToast("Informe um valor válido.", "error"); return; }

  const gid = myGroupId();
  if (!gid || !currentGroup) { showToast("Entre em um grupo primeiro.", "error"); return; }

  const btn = document.getElementById("btn-save-price");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    // O preço é DO GRUPO. settings/app continua guardando o padrão do
    // sistema, e o ADM SUPREMO o atualiza junto — é ele que vira sugestão
    // para os próximos grupos criados.
    await updateGroupSettings(gid, { name: currentGroup.name, pixKey: currentGroup.pixKey || "", tripValue: value });
    if (isSuperAdmin()) await setTripValueSetting(value).catch(() => {});
    await loadGroupContext();
    updateHeaderSubtitle();
    showToast(`Valor da viagem agora é ${formatCurrency(value)}.`, "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao salvar o valor.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

async function handleSavePix() {
  const input = document.getElementById("adm-pix-input");
  const pixKey = String(input.value || "").trim();
  const gid = myGroupId();
  if (!gid || !currentGroup) { showToast("Entre em um grupo primeiro.", "error"); return; }

  const btn = document.getElementById("btn-save-pix");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    await updateGroupSettings(gid, {
      name:      currentGroup.name,
      pixKey,
      tripValue: currentGroup.tripValue
    });
    await loadGroupContext();
    showToast(pixKey ? "Chave PIX salva." : "Chave PIX removida.", "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao salvar a chave PIX.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

// Mantém o subtítulo do cabeçalho de acordo com o grupo/preço atuais.
function updateHeaderSubtitle() {
  const el = document.getElementById("header-price");
  if (!el) return;
  const name = groupName();
  el.textContent = name
    ? `${name} • ${formatCurrency(getTripValue())} por viagem`
    : `${formatCurrency(getTripValue())} por viagem`;
}

// ── CARREGAR DADOS (exportada; chamada ao abrir a aba) ────────

export async function loadUsersList() {
  if (!isAdmin()) return;

  try {
    const gid = myGroupId();
    const [trips, payments, users] = await Promise.all([
      getGroupTrips(gid), getGroupPayments(gid), getGroupUsers(gid)
    ]);
    cache = { trips, payments, users };
    renderAll();

    // O bloco do sistema só existe para o ADM SUPREMO — e as consultas
    // globais abaixo seriam negadas pelas rules para qualquer outro.
    const sysBox = document.getElementById("adm-system");
    sysBox?.classList.toggle("hidden", !isSuperAdmin());
    if (isSuperAdmin()) await loadSystemPanel();
  } catch (e) {
    console.error("Erro ao carregar painel admin:", e);
    const c = document.getElementById("users-list");
    if (c) c.innerHTML = `<p class="error-msg">Erro ao carregar dados.</p>`;
  }
}

function renderAll() {
  renderGroupHeader();
  renderPeriodStats();
  renderAverages();
  renderPerUser();
  renderManageUsers();
}

function renderGroupHeader() {
  const nameEl = document.getElementById("adm-group-name");
  const subEl  = document.getElementById("adm-group-sub");
  if (nameEl) nameEl.textContent = currentGroup?.name || "Sem grupo";
  if (subEl) {
    const role = isGroupOwner() ? "você é o dono" : isSuperAdmin() ? "admin do sistema" : "passageiro";
    subEl.textContent = `${cache.users.length} passageiro(s) • ${role}`;
  }

  // Convidar e apagar o grupo são do dono (ou do ADM SUPREMO, como suporte).
  const canManage = isGroupOwner() || isSuperAdmin();
  document.getElementById("btn-invite")?.classList.toggle("hidden", !canManage);
  document.getElementById("btn-delete-group")?.classList.toggle("hidden", !canManage);

  const priceInput = document.getElementById("adm-price-input");
  if (priceInput) priceInput.value = getTripValue();
  const pixInput = document.getElementById("adm-pix-input");
  if (pixInput) pixInput.value = currentGroup?.pixKey || "";
}

// ── PERÍODOS ─────────────────────────────────────────────────

function getPeriodRange(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const iso = (dt) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

  if (period === "week") {
    const start = new Date(now); start.setDate(now.getDate() - now.getDay()); // domingo
    const end   = new Date(start); end.setDate(start.getDate() + 6);
    return { start: iso(start), end: iso(end), label: `Semana de ${start.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })} a ${end.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" })}` };
  }
  if (period === "month") {
    const start = new Date(y, m, 1), end = new Date(y, m + 1, 0);
    return { start: iso(start), end: iso(end), label: start.toLocaleDateString("pt-BR", { month: "long", year: "numeric" }) };
  }
  if (period === "semester") {
    const firstHalf = m <= 5;
    const start = new Date(y, firstHalf ? 0 : 6, 1);
    const end   = new Date(y, firstHalf ? 5 : 11, firstHalf ? 30 : 31);
    return { start: iso(start), end: iso(end), label: `${firstHalf ? "1º" : "2º"} semestre de ${y}` };
  }
  if (period === "year") {
    return { start: `${y}-01-01`, end: `${y}-12-31`, label: `Ano de ${y}` };
  }
  return { start: null, end: null, label: "Todo o histórico" };
}

function inPeriod(dateStr, range) {
  if (!range.start) return true;
  return dateStr >= range.start && dateStr <= range.end;
}

// ── CARDS DE TOTAIS DO PERÍODO ───────────────────────────────

function renderPeriodStats() {
  const range = getPeriodRange(currentPeriod);
  document.getElementById("adm-period-label").textContent = range.label;

  const trips     = cache.trips.filter(t => inPeriod(t.date, range));
  const paidCount = trips.filter(t => t.paid).length;
  const total     = trips.length;
  const rate      = total > 0 ? Math.round((paidCount / total) * 100) : 0;

  // "Em aberto" só conta dias que já chegaram (<= hoje); futuros são agendados.
  const today    = todayISO();
  const received = trips.filter(t => t.paid).reduce((s, t) => s + amt(t), 0);
  const open     = trips.filter(t => !t.paid && t.date <= today).reduce((s, t) => s + amt(t), 0);

  setText("adm-received", formatCurrency(received));
  setText("adm-open",     formatCurrency(open));
  setText("adm-trips",    total);
  setText("adm-rate",     `${rate}%`);
}

// ── MÉDIAS (histórico completo do grupo) ─────────────────────

function renderAverages() {
  const trips = cache.trips;
  const totalValue = trips.reduce((s, t) => s + amt(t), 0); // valor total consumido

  const usersWithTrips = new Set(trips.map(t => t.uid)).size;
  const months = new Set(trips.map(t => t.date.slice(0, 7))).size;
  const weeks  = new Set(trips.map(t => weekKey(t.date))).size;

  setText("adm-avg-user",  formatCurrency(usersWithTrips ? totalValue / usersWithTrips : 0));
  setText("adm-avg-month", formatCurrency(months ? totalValue / months : 0));
  setText("adm-avg-week",  formatCurrency(weeks  ? totalValue / weeks  : 0));
}

// Chave de semana (ano + número da semana ISO aproximado)
function weekKey(dateStr) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  const onejan = new Date(y, 0, 1);
  const week = Math.ceil((((dt - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${y}-W${week}`;
}

// ── RANKING POR USUÁRIO (no período) ─────────────────────────

function renderPerUser() {
  const container = document.getElementById("adm-user-stats");
  if (!container) return;

  const range = getPeriodRange(currentPeriod);
  const trips = cache.trips.filter(t => inPeriod(t.date, range));

  // Agrupa por uid (paid/open em VALOR). "open" só conta dias já chegados.
  const today = todayISO();
  const byUser = new Map();
  for (const t of trips) {
    if (!byUser.has(t.uid)) byUser.set(t.uid, { uid: t.uid, name: t.userName, count: 0, paid: 0, open: 0 });
    const u = byUser.get(t.uid);
    u.count++;
    if (t.paid) u.paid += amt(t);
    else if (t.date <= today) u.open += amt(t);
  }

  // Nome/foto mais atuais vindos do cadastro
  for (const u of byUser.values()) {
    const prof = cache.users.find(x => x.uid === u.uid);
    if (prof?.name)  u.name  = prof.name;
    if (prof?.photo) u.photo = prof.photo;
  }

  const rows = [...byUser.values()].sort((a, b) => (b.open - a.open) || (b.count - a.count));

  if (rows.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon("clock")}</div><p>Nenhuma viagem neste período.</p></div>`;
    return;
  }

  container.innerHTML = rows.map(u => `
    <button class="adm-user" data-user-detail="${u.uid}">
      <div class="adm-user__avatar" style="background:${avatarColor(u.name)}">${avatarInner(u.name, u.photo)}</div>
      <div class="adm-user__info">
        <div class="adm-user__name">${escapeHtml(u.name || "—")}</div>
        <div class="adm-user__sub">${u.count} viagem(ns)</div>
      </div>
      <div class="adm-user__values">
        <span class="adm-user__paid">${formatCurrency(u.paid)}</span>
        <span class="adm-user__open ${u.open ? "" : "is-zero"}">${formatCurrency(u.open)} aberto</span>
      </div>
    </button>
  `).join("");

  container.querySelectorAll("[data-user-detail]").forEach(btn => {
    btn.addEventListener("click", () => openUserDetail(btn.dataset.userDetail));
  });
}

// ── DETALHE DE UM USUÁRIO ────────────────────────────────────

function openUserDetail(uid) {
  const prof  = cache.users.find(x => x.uid === uid);
  const trips = cache.trips.filter(t => t.uid === uid);
  const name  = prof?.name || trips[0]?.userName || "Usuário";

  const today = todayISO();
  const stat = (period) => {
    const r = getPeriodRange(period);
    const t = trips.filter(x => inPeriod(x.date, r));
    const paid = t.filter(x => x.paid).reduce((s, x) => s + amt(x), 0);
    const open = t.filter(x => !x.paid && x.date <= today).reduce((s, x) => s + amt(x), 0);
    return { trips: t.length, paid, open };
  };

  const periods = [
    ["Semana",   stat("week")],
    ["Mês",      stat("month")],
    ["Semestre", stat("semester")],
    ["Ano",      stat("year")],
    ["Total",    stat("all")],
  ];

  const rowsHtml = periods.map(([label, s]) => `
    <div class="adm-detail__row">
      <span class="adm-detail__period">${label}</span>
      <span class="adm-detail__trips">${s.trips} viag.</span>
      <span class="adm-detail__paid">${formatCurrency(s.paid)}</span>
      <span class="adm-detail__open ${s.open ? "" : "is-zero"}">${formatCurrency(s.open)}</span>
    </div>
  `).join("");

  document.getElementById("user-detail-title").textContent = name;
  document.getElementById("user-detail-content").innerHTML = `
    <div class="adm-detail__head">
      <span></span><span>Viagens</span><span>Pago</span><span>Aberto</span>
    </div>
    ${rowsHtml}
  `;
  document.getElementById("modal-user-detail").classList.add("modal--open");
}

// ── PASSAGEIROS DO GRUPO ─────────────────────────────────────
//
// O dono do grupo NÃO promove ninguém a admin do sistema nem apaga contas:
// isso é do ADM SUPREMO. O que ele faz é o que diz respeito ao grupo dele —
// passar a posse e tirar alguém do grupo.

function renderManageUsers() {
  const container = document.getElementById("users-list");
  if (!container) return;

  if (cache.users.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon("users")}</div><p>Nenhum passageiro no grupo. Use "Convidar".</p></div>`;
    return;
  }

  const canManage = isGroupOwner() || isSuperAdmin();

  container.innerHTML = cache.users.map(u => renderMemberCard(u, canManage)).join("");

  container.querySelectorAll("[data-transfer-group]").forEach(btn => {
    btn.addEventListener("click", () => confirmTransfer(btn.dataset.transferGroup));
  });
  container.querySelectorAll("[data-remove-member]").forEach(btn => {
    btn.addEventListener("click", () => confirmRemoveMember(btn.dataset.removeMember));
  });
}

function renderMemberCard(user, canManage) {
  const isCurrentUser = user.uid === currentProfile?.uid;
  const isOwner       = user.uid === currentGroup?.ownerUid;
  const isActive      = user.active !== false;

  return `
    <div class="user-card ${!isActive ? "user-card--inactive" : ""}">
      <div class="user-card__avatar" style="background:${avatarColor(user.name)}">
        ${avatarInner(user.name, user.photo)}
      </div>
      <div class="user-card__info">
        <div class="user-card__name">
          ${escapeHtml(user.name)}
          ${isCurrentUser ? '<span class="badge badge--you">você</span>' : ""}
        </div>
        <div class="user-card__email">${escapeHtml(user.email)}</div>
        <div class="user-card__meta">
          <span class="badge ${isOwner ? "badge--admin" : "badge--user"}">
            ${isOwner ? icon("crown") + " Dono do grupo" : icon("user") + " Passageiro"}
          </span>
          ${user.role === "admin" ? `<span class="badge badge--admin">${icon("crown")} Sistema</span>` : ""}
          ${!isActive ? `<span class="badge badge--inactive">Inativo</span>` : ""}
        </div>
      </div>
      ${(canManage && !isCurrentUser && !isOwner) ? `
        <div class="user-card__actions">
          <button class="btn-icon" title="Passar a posse do grupo"
            data-transfer-group="${user.uid}">${icon("crown")}</button>
          <button class="btn-icon btn-icon--delete" title="Remover do grupo"
            data-remove-member="${user.uid}">${icon("trash")}</button>
        </div>
      ` : ""}
    </div>
  `;
}

function avatarColor(name = "") {
  const colors = ["#00e676","#ff6b6b","#ffd60a","#74b9ff","#a29bfe","#fd79a8","#00cec9"];
  const code = name && name.length ? name.charCodeAt(0) : "?".charCodeAt(0);
  return colors[code % colors.length] + "33";
}

// ── AÇÕES DO DONO DO GRUPO ───────────────────────────────────

function confirmTransfer(uid) {
  const user = cache.users.find(u => u.uid === uid);
  askConfirm(
    `Passar a posse do grupo para ${user?.name || "este passageiro"}? ` +
    `Você vira passageiro e perde o controle do grupo.`,
    async () => {
      try {
        await transferGroup(uid, myGroupId());
        await refreshProfile();
        await loadGroupContext();
        showToast(`${user?.name || "Ele"} agora é o dono do grupo.`, "success");
        await loadUsersList();
      } catch (e) {
        showToast(e.message || "Erro ao transferir.", "error");
      }
    }
  );
}

function confirmRemoveMember(uid) {
  const user = cache.users.find(u => u.uid === uid);
  askConfirm(
    `Remover ${user?.name || "este passageiro"} do grupo? ` +
    `As viagens e pagamentos dele ficam no histórico; a conta dele continua existindo.`,
    async () => {
      try {
        const r = await removeMember(uid, myGroupId());
        showToast(`${r.name || "Passageiro"} saiu do grupo.`, "info");
        await loadGroupContext();
        await loadUsersList();
      } catch (e) {
        showToast(e.message || "Erro ao remover.", "error");
      }
    }
  );
}

function confirmDeleteGroup() {
  const name = currentGroup?.name || "este grupo";
  askConfirm(
    `Apagar o grupo "${name}"? Todos os passageiros são desligados dele. ` +
    `O histórico de viagens e pagamentos é mantido, mas deixa de aparecer no app.`,
    () => askConfirm("Tem certeza? Esta ação NÃO pode ser desfeita.", async () => {
      try {
        const r = await deleteGroup(myGroupId());
        await refreshProfile();
        await loadGroupContext();
        showToast(`Grupo apagado (${r.removed} pessoa(s) desligadas).`, "info");
        location.reload();
      } catch (e) {
        showToast(e.message || "Erro ao apagar o grupo.", "error");
      }
    })
  );
}

// ── PAINEL DO SISTEMA (ADM SUPREMO) ──────────────────────────

async function loadSystemPanel() {
  try {
    const [groups, users, trips, payments] = await Promise.all([
      getAllGroups(), getAllUsers(), getAllTrips(), getAllPayments()
    ]);
    system = { groups, users, trips, payments };
    renderSystemGroups();
    renderSystemUsers();
  } catch (e) {
    console.error("Erro no painel do sistema:", e);
    const c = document.getElementById("sys-groups");
    if (c) c.innerHTML = `<p class="error-msg">Erro ao carregar os grupos.</p>`;
  }
}

function renderSystemGroups() {
  const box = document.getElementById("sys-groups");
  if (!box) return;

  const today = todayISO();

  const rows = system.groups.map(g => {
    const trips = system.trips.filter(t => t.groupId === g.id);
    const paid  = trips.filter(t => t.paid).reduce((s, t) => s + amt(t), 0);
    const open  = trips.filter(t => !t.paid && t.date <= today).reduce((s, t) => s + amt(t), 0);
    const members = system.users.filter(u => (u.groupIds || []).includes(g.id)).length;
    return `
      <div class="sys-group">
        <div class="sys-group__info">
          <div class="sys-group__name">${escapeHtml(g.name || "Grupo")}</div>
          <div class="sys-group__meta">
            ${escapeHtml(g.ownerName || "—")} • ${members} pessoa(s) • ${trips.length} viagem(ns)
            • ${formatCurrency(typeof g.tripValue === "number" ? g.tripValue : 0)}/viagem
          </div>
        </div>
        <div class="sys-group__values">
          <span class="sys-group__paid">${formatCurrency(paid)}</span>
          <span class="sys-group__open ${open ? "" : "is-zero"}">${formatCurrency(open)} aberto</span>
        </div>
      </div>`;
  });

  box.innerHTML = rows.length
    ? rows.join("")
    : `<div class="empty-state"><div class="empty-state__icon">${icon("users")}</div><p>Nenhum grupo criado ainda.</p></div>`;
}

function renderSystemUsers() {
  const box = document.getElementById("sys-users");
  if (!box) return;

  if (system.users.length === 0) {
    box.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon("users")}</div><p>Nenhum usuário cadastrado.</p></div>`;
    return;
  }

  const groupNameById = new Map(system.groups.map(g => [g.id, g.name]));

  box.innerHTML = system.users.map(u => renderSystemUserCard(u, groupNameById)).join("");

  box.querySelectorAll("[data-toggle-role]").forEach(btn => {
    btn.addEventListener("click", () => toggleUserRole(btn.dataset.toggleRole, btn.dataset.currentRole));
  });
  box.querySelectorAll("[data-toggle-active]").forEach(btn => {
    btn.addEventListener("click", () => toggleUserActive(btn.dataset.toggleActive, btn.dataset.currentActive === "true"));
  });
  box.querySelectorAll("[data-delete-user]").forEach(btn => {
    btn.addEventListener("click", () => confirmDeleteUser(btn.dataset.deleteUser));
  });
}

function renderSystemUserCard(user, groupNameById) {
  const isCurrentUser = user.uid === currentProfile?.uid;
  const isSuper       = user.role === "admin";
  const isActive      = user.active !== false;
  const groupLabel    = user.groupId
    ? (groupNameById.get(user.groupId) || "grupo removido")
    : "sem grupo";

  return `
    <div class="user-card ${!isActive ? "user-card--inactive" : ""}">
      <div class="user-card__avatar" style="background:${avatarColor(user.name)}">
        ${avatarInner(user.name, user.photo)}
      </div>
      <div class="user-card__info">
        <div class="user-card__name">
          ${escapeHtml(user.name)}
          ${isCurrentUser ? '<span class="badge badge--you">você</span>' : ""}
        </div>
        <div class="user-card__email">${escapeHtml(user.email)}</div>
        <div class="user-card__meta">
          <span class="badge ${isSuper ? "badge--admin" : "badge--user"}">
            ${isSuper ? icon("crown") + " Admin do sistema" : icon("user") + " Usuário"}
          </span>
          <span class="badge badge--user">${escapeHtml(groupLabel)}</span>
          <span class="badge ${isActive ? "badge--active" : "badge--inactive"}">
            ${isActive ? "Ativo" : "Inativo"}
          </span>
        </div>
      </div>
      ${!isCurrentUser ? `
        <div class="user-card__actions">
          <button class="btn-icon" title="${isSuper ? "Rebaixar para usuário" : "Promover a admin do sistema"}"
            data-toggle-role="${user.uid}" data-current-role="${user.role}">
            ${isSuper ? icon("arrowDown") : icon("arrowUp")}
          </button>
          <button class="btn-icon" title="${isActive ? "Desativar" : "Ativar"}"
            data-toggle-active="${user.uid}" data-current-active="${isActive}">
            ${isActive ? icon("lock") : icon("unlock")}
          </button>
          <button class="btn-icon btn-icon--delete" title="Excluir"
            data-delete-user="${user.uid}">
            ${icon("trash")}
          </button>
        </div>
      ` : ""}
    </div>
  `;
}

// ── AÇÕES DO ADM SUPREMO ─────────────────────────────────────

async function toggleUserRole(uid, currentRole) {
  const newRole = currentRole === "admin" ? "user" : "admin";
  const user    = system.users.find(u => u.uid === uid);

  // Rebaixar reduz privilégio: pode ir direto.
  if (newRole === "user") {
    try {
      await updateDoc(doc(db, "users", uid), { role: "user" });
      showToast("Rebaixado para Usuário", "info");
      await loadSystemPanel();
    } catch (e) {
      console.error(e);
      showToast("Erro ao alterar papel", "error");
    }
    return;
  }

  // PROMOVER a ADM SUPREMO concede acesso a TODOS os grupos: exige a senha.
  // As rules recusam a escrita sem um auth_time recente.
  askPassword(
    `Promover ${user?.name || "este usuário"} a admin do sistema?`,
    `Ele passará a ver e alterar os dados de TODOS os grupos. ` +
    `Confirme sua senha de administrador.`,
    async () => {
      await updateDoc(doc(db, "users", uid), { role: "admin" });
      showToast(`${user?.name || "Usuário"} agora é admin do sistema.`, "success");
      await loadSystemPanel();
    }
  );
}

async function toggleUserActive(uid, currentActive) {
  // Desativar reduz privilégio: pode ir direto.
  if (currentActive) {
    try {
      await updateDoc(doc(db, "users", uid), { active: false });
      showToast("Usuário desativado", "info");
      await loadSystemPanel();
    } catch (e) {
      console.error(e);
      showToast("Erro ao desativar", "error");
    }
    return;
  }

  // Reativar CONCEDE acesso: exige a senha do admin.
  const user = system.users.find(u => u.uid === uid);
  askPassword(
    `Reativar ${user?.name || "este usuário"}?`,
    "Confirme sua senha de administrador para liberar o acesso.",
    async () => {
      await updateDoc(doc(db, "users", uid), { active: true });
      showToast(`${user?.name || "Usuário"} reativado.`, "success");
      await loadSystemPanel();
    }
  );
}

// A exclusão real (login do Firebase Auth + perfil) passa pelo Worker —
// ver js/worker-api.js. O SDK web não apaga a conta de login de outra
// pessoa; o Worker revalida token, papel de admin e senha recente.
function confirmDeleteUser(uid) {
  const user = system.users.find(u => u.uid === uid);
  const name = user?.name || "este usuário";

  askPassword(
    `Apagar ${name}?`,
    `A conta de login e o perfil serão removidos definitivamente. ` +
    `As viagens e pagamentos já registrados são mantidos no histórico. ` +
    `Confirme sua senha de administrador.`,
    async () => {
      const r = await deleteUserAccount(uid);
      showToast(
        r.authDeleted
          ? `${r.name || name} foi apagado.`
          : `Perfil de ${r.name || name} removido (a conta de login já não existia).`,
        "info"
      );
      await loadSystemPanel();
    }
  );
}

// ── CONFIRMAÇÃO POR SENHA ─────────────────────────────────────

/**
 * Pede a senha do admin e só então executa a ação.
 *
 * A tela em si não é a proteção — as security rules é que exigem um
 * `auth_time` recente. Aqui só produzimos esse auth_time e damos um
 * retorno decente ao usuário.
 *
 * @param {string} title
 * @param {string} message
 * @param {() => Promise<void>} onConfirm executa DEPOIS da senha conferir
 */
function askPassword(title, message, onConfirm) {
  const modal   = document.getElementById("modal-password");
  const input   = document.getElementById("password-confirm-input");
  const errorEl = document.getElementById("password-confirm-error");
  const btnYes  = document.getElementById("btn-password-confirm");
  const btnNo   = document.getElementById("btn-password-cancel");

  document.getElementById("password-confirm-title").textContent   = title;
  document.getElementById("password-confirm-message").textContent = message;

  input.value         = "";
  errorEl.textContent = "";
  modal.classList.add("modal--open");
  setTimeout(() => input.focus(), 50);

  const close = () => {
    modal.classList.remove("modal--open");
    input.value = "";           // não deixa a senha no DOM
  };

  const submit = async () => {
    const password = input.value;
    if (!password) { errorEl.textContent = "Digite sua senha."; return; }

    btnYes.disabled    = true;
    btnYes.textContent = "Confirmando...";
    errorEl.textContent = "";

    try {
      // Renova o auth_time. Sem isto, a regra recusa a escrita seguinte.
      await reauthenticate(password);
      await onConfirm();
      close();
    } catch (e) {
      console.error(e);
      errorEl.textContent = translateReauthError(e);
      input.value = "";
      input.focus();
    } finally {
      btnYes.disabled    = false;
      btnYes.textContent = "Confirmar";
    }
  };

  btnYes.onclick = submit;
  btnNo.onclick  = close;
  input.onkeydown = (e) => { if (e.key === "Enter") submit(); };
}

function translateReauthError(e) {
  const map = {
    "auth/wrong-password":     "Senha incorreta.",
    "auth/invalid-credential": "Senha incorreta.",
    "auth/too-many-requests":  "Muitas tentativas. Aguarde alguns minutos.",
    "auth/user-mismatch":      "Credencial de outro usuário.",
    "auth/network-request-failed": "Falha de rede. Tente de novo.",
  };
  if (map[e?.code]) return map[e.code];
  // Escrita recusada pelas rules: quase sempre auth_time vencido.
  if (String(e?.code || "").includes("permission-denied")) {
    return "Permissão negada. A confirmação expirou — tente novamente.";
  }
  return "Não foi possível confirmar. Tente novamente.";
}

// ── LIMPAR DADOS DE TESTE ─────────────────────────────────────

// Reutiliza o modal de confirmação com uma mensagem e uma ação.
function askConfirm(message, onYes) {
  const modal  = document.getElementById("modal-confirm");
  const msg    = document.getElementById("confirm-message");
  const btnYes = document.getElementById("btn-confirm-yes");
  const btnNo  = document.getElementById("btn-confirm-no");

  msg.textContent = message;
  modal.classList.add("modal--open");

  btnYes.onclick = () => { modal.classList.remove("modal--open"); onYes(); };
  btnNo.onclick  = () => modal.classList.remove("modal--open");
}

function confirmClearData() {
  const nTrips = cache.trips.length;
  const nPays  = cache.payments.length;

  if (nTrips === 0 && nPays === 0) {
    showToast("Não há viagens nem pagamentos para apagar.", "info");
    return;
  }

  askConfirm(
    `Apagar ${nTrips} viagem(ns) e ${nPays} pagamento(s) de "${groupName()}"? ` +
    `Os passageiros e as configurações do grupo são mantidos.`,
    () => askConfirm("Tem certeza? Esta ação NÃO pode ser desfeita.", doClearData)
  );
}

async function doClearData() {
  const btn = document.getElementById("btn-clear-data");
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
  try {
    // Os pagamentos saem pelo Worker: as rules proíbem o cliente de escrever
    // em `payments` (é lá que mora a prova de quitação), então apagar daqui
    // simplesmente não passaria.
    let pays = 0;
    for (const p of cache.payments) {
      try { await deletePayment(p.id); pays++; } catch (e) { console.warn("pagamento", p.id, e); }
    }
    const trips = await clearGroupTrips(myGroupId());

    showToast(`Limpo: ${trips} viagem(ns) e ${pays} pagamento(s).`, "success");
    await loadUsersList();
  } catch (e) {
    console.error(e);
    showToast("Erro ao limpar os dados.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  }
}

// ── CRIAR USUÁRIO (ADM SUPREMO) ──────────────────────────────

function openNewUserModal() {
  document.getElementById("modal-new-user").classList.add("modal--open");
  document.getElementById("form-new-user").reset();
  document.getElementById("user-create-error").textContent = "";
}

async function handleCreateUser(e) {
  e.preventDefault();
  const btn      = document.getElementById("btn-submit-new-user");
  const errorEl  = document.getElementById("user-create-error");
  const name     = document.getElementById("new-user-name").value.trim();
  const email    = document.getElementById("new-user-email").value.trim();
  const password = document.getElementById("new-user-password").value;
  const role     = document.getElementById("new-user-role").value;

  errorEl.textContent = "";

  // Valida antes de bater no Firebase: erro local é mais claro que
  // "auth/invalid-email" vindo de um 400 da API.
  if (!name) {
    errorEl.textContent = "Informe o nome.";
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    errorEl.textContent = "E-mail inválido. Confira se não faltou o @ ou o domínio.";
    return;
  }
  if (password.length < 6) {
    errorEl.textContent = "A senha precisa ter ao menos 6 caracteres.";
    return;
  }

  // A criação em si — a conta nasce INATIVA e SEM GRUPO (ativar é passo
  // separado, e entrar no grupo depende de um convite).
  const doCreate = async () => {
    await registerUser(name, email, password, role);
    document.getElementById("modal-new-user").classList.remove("modal--open");
    showToast(`${name} cadastrado. Ative no card abaixo e convide para um grupo.`, "success");
    await loadSystemPanel();
  };

  // Criar já como ADM SUPREMO é elevação — a regra exige senha recente.
  // Peça a senha ANTES; reauthenticate atualiza o auth_time.
  if (role === "admin") {
    askPassword(
      `Criar ${name} como ADMIN DO SISTEMA?`,
      `Ele terá acesso a todos os grupos assim que for ativado. ` +
      `Confirme sua senha de administrador.`,
      doCreate   // askPassword já faz reauthenticate antes de chamar isto
    );
    return;
  }

  btn.disabled    = true;
  btn.textContent = "Criando...";
  try {
    await doCreate();
  } catch (e) {
    console.error(e);
    errorEl.textContent = translateAuthError(e.code);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Criar Usuário";
  }
}

// ── HELPERS ───────────────────────────────────────────────────

function setText(id, value) {
  const el = document.getElementById(id);
  if (el) el.textContent = value;
}

function translateAuthError(code) {
  const map = {
    "auth/email-already-in-use":  "Este e-mail já está cadastrado.",
    "auth/invalid-email":         "E-mail inválido.",
    "auth/weak-password":         "Senha muito fraca (mínimo 6 caracteres).",
    "auth/operation-not-allowed": "Operação não permitida.",
  };
  return map[code] || "Erro desconhecido. Tente novamente.";
}
