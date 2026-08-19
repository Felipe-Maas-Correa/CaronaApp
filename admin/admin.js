// ============================================================
// MÓDULO: admin.js
// Painel de administração — dashboard + gerenciamento de usuários
// ============================================================

import {
  doc, updateDoc, deleteDoc
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db } from "../js/firebase-config.js";
import { getAllTrips, getAllPayments, getAllUsers, getTripValue, setTripValueSetting, clearTripsAndPayments } from "../js/db.js";
import { registerUser, currentProfile } from "../auth/auth.js";
import { showToast, formatDateTime, formatCurrency, icon, escapeHtml, todayISO } from "../js/utils.js";

// Valor de cada viagem (respeita preços diferentes ao longo do tempo)
const amt = t => (typeof t.amount === "number" ? t.amount : 15);

// Conteúdo de um avatar: foto (se houver) ou a inicial do nome.
function avatarInner(name, photo) {
  if (photo) return `<img src="${photo}" alt="" class="avatar-img">`;
  return escapeHtml((name || "?").charAt(0).toUpperCase());
}

// Estado
let currentPeriod = "month";
let cache = { trips: [], payments: [], users: [] };

// ── INIT ─────────────────────────────────────────────────────

export async function initAdmin() {
  // Só admin carrega o painel (as regras negam leitura global para os demais).
  if (currentProfile?.role !== "admin") return;
  bindAdminEvents();
  await loadUsersList();
}

function bindAdminEvents() {
  // Modal: novo usuário
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

  // Exportar CSV
  document.getElementById("btn-export-csv")?.addEventListener("click", exportCSV);

  // Limpar dados de teste (viagens + pagamentos)
  document.getElementById("btn-clear-data")?.addEventListener("click", confirmClearData);

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
}

async function handleSavePrice() {
  const input = document.getElementById("adm-price-input");
  const value = parseFloat(String(input.value).replace(",", "."));
  if (isNaN(value) || value < 0) { showToast("Informe um valor válido.", "error"); return; }

  const btn = document.getElementById("btn-save-price");
  btn.disabled = true;
  btn.textContent = "...";
  try {
    await setTripValueSetting(value);
    // Atualiza o subtítulo do cabeçalho
    const priceEl = document.getElementById("header-price");
    if (priceEl) priceEl.textContent = `${formatCurrency(value)} por viagem`;
    showToast(`Valor da viagem agora é ${formatCurrency(value)}.`, "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao salvar o valor.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar";
  }
}

// ── CARREGAR DADOS (exportada; chamada ao abrir a aba) ────────

export async function loadUsersList() {
  try {
    const [trips, payments, users] = await Promise.all([
      getAllTrips(), getAllPayments(), getAllUsers()
    ]);
    cache = { trips, payments, users };
    renderAll();
  } catch (e) {
    console.error("Erro ao carregar painel admin:", e);
    const c = document.getElementById("users-list");
    if (c) c.innerHTML = `<p class="error-msg">Erro ao carregar dados.</p>`;
  }
}

function renderAll() {
  renderPeriodStats();
  renderAverages();
  renderPerUser();
  renderManageUsers();
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

  const received = trips.filter(t => t.paid).reduce((s, t) => s + amt(t), 0);
  const open     = trips.filter(t => !t.paid).reduce((s, t) => s + amt(t), 0);

  setText("adm-received", formatCurrency(received));
  setText("adm-open",     formatCurrency(open));
  setText("adm-trips",    total);
  setText("adm-rate",     `${rate}%`);
}

// ── MÉDIAS (histórico completo) ──────────────────────────────

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

  // Agrupa por uid (paid/open em VALOR)
  const byUser = new Map();
  for (const t of trips) {
    if (!byUser.has(t.uid)) byUser.set(t.uid, { uid: t.uid, name: t.userName, count: 0, paid: 0, open: 0 });
    const u = byUser.get(t.uid);
    u.count++;
    if (t.paid) u.paid += amt(t); else u.open += amt(t);
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

  const stat = (period) => {
    const r = getPeriodRange(period);
    const t = trips.filter(x => inPeriod(x.date, r));
    const paid = t.filter(x => x.paid).reduce((s, x) => s + amt(x), 0);
    const open = t.filter(x => !x.paid).reduce((s, x) => s + amt(x), 0);
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

// ── GERENCIAR USUÁRIOS ───────────────────────────────────────

function renderManageUsers() {
  const container = document.getElementById("users-list");
  if (!container) return;

  if (cache.users.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-state__icon">${icon("users")}</div><p>Nenhum usuário cadastrado.</p></div>`;
    return;
  }

  container.innerHTML = cache.users.map(u => renderUserCard(u)).join("");

  container.querySelectorAll("[data-toggle-role]").forEach(btn => {
    btn.addEventListener("click", () => toggleUserRole(btn.dataset.toggleRole, btn.dataset.currentRole));
  });
  container.querySelectorAll("[data-toggle-active]").forEach(btn => {
    btn.addEventListener("click", () => toggleUserActive(btn.dataset.toggleActive, btn.dataset.currentActive === "true"));
  });
  container.querySelectorAll("[data-delete-user]").forEach(btn => {
    btn.addEventListener("click", () => confirmDeleteUser(btn.dataset.deleteUser));
  });
}

function renderUserCard(user) {
  const isCurrentUser = user.uid === currentProfile?.uid;
  const isAdmin       = user.role === "admin";
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
          <span class="badge ${isAdmin ? "badge--admin" : "badge--user"}">
            ${isAdmin ? icon("crown") + " Admin" : icon("user") + " Usuário"}
          </span>
          <span class="badge ${isActive ? "badge--active" : "badge--inactive"}">
            ${isActive ? "Ativo" : "Inativo"}
          </span>
        </div>
      </div>
      ${!isCurrentUser ? `
        <div class="user-card__actions">
          <button class="btn-icon" title="${isAdmin ? "Rebaixar para usuário" : "Promover a admin"}"
            data-toggle-role="${user.uid}" data-current-role="${user.role}">
            ${isAdmin ? icon("arrowDown") : icon("arrowUp")}
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

function avatarColor(name = "") {
  const colors = ["#00e676","#ff6b6b","#ffd60a","#74b9ff","#a29bfe","#fd79a8","#00cec9"];
  const code = name && name.length ? name.charCodeAt(0) : "?".charCodeAt(0);
  return colors[code % colors.length] + "33";
}

// ── AÇÕES ─────────────────────────────────────────────────────

async function toggleUserRole(uid, currentRole) {
  const newRole = currentRole === "admin" ? "user" : "admin";
  try {
    await updateDoc(doc(db, "users", uid), { role: newRole });
    showToast(`Papel alterado para ${newRole === "admin" ? "Admin" : "Usuário"}`, "success");
    await loadUsersList();
  } catch (e) {
    showToast("Erro ao alterar papel", "error");
  }
}

async function toggleUserActive(uid, currentActive) {
  try {
    await updateDoc(doc(db, "users", uid), { active: !currentActive });
    showToast(!currentActive ? "Usuário ativado" : "Usuário desativado", "info");
    await loadUsersList();
  } catch (e) {
    showToast("Erro ao alterar status", "error");
  }
}

function confirmDeleteUser(uid) {
  const modal  = document.getElementById("modal-confirm");
  const msg    = document.getElementById("confirm-message");
  const btnYes = document.getElementById("btn-confirm-yes");
  const btnNo  = document.getElementById("btn-confirm-no");

  msg.textContent = "Excluir este usuário do banco de dados? Esta ação não pode ser desfeita.";
  modal.classList.add("modal--open");

  btnYes.onclick = async () => {
    modal.classList.remove("modal--open");
    try {
      await deleteDoc(doc(db, "users", uid));
      showToast("Usuário excluído", "info");
      await loadUsersList();
    } catch (e) {
      showToast("Erro ao excluir usuário", "error");
    }
  };
  btnNo.onclick = () => modal.classList.remove("modal--open");
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

  // 1ª confirmação
  askConfirm(
    `Apagar ${nTrips} viagem(ns) e ${nPays} pagamento(s)? Os usuários e o valor da viagem serão mantidos.`,
    () => {
      // 2ª confirmação (ação irreversível)
      askConfirm("Tem certeza? Esta ação NÃO pode ser desfeita.", doClearData);
    }
  );
}

async function doClearData() {
  const btn = document.getElementById("btn-clear-data");
  if (btn) { btn.disabled = true; btn.style.opacity = ".6"; }
  try {
    const { trips, payments } = await clearTripsAndPayments();
    showToast(`Limpo: ${trips} viagem(ns) e ${payments} pagamento(s).`, "success");
    await loadUsersList();
  } catch (e) {
    console.error(e);
    showToast("Erro ao limpar os dados.", "error");
  } finally {
    if (btn) { btn.disabled = false; btn.style.opacity = "1"; }
  }
}

// ── CRIAR USUÁRIO ─────────────────────────────────────────────

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
  btn.disabled        = true;
  btn.textContent     = "Criando...";

  try {
    await registerUser(name, email, password, role);
    document.getElementById("modal-new-user").classList.remove("modal--open");
    showToast(`${name} cadastrado como ${role === "admin" ? "Admin" : "Usuário"}!`, "success");
    await loadUsersList();
  } catch (e) {
    errorEl.textContent = translateAuthError(e.code);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Criar Usuário";
  }
}

// ── EXPORTAR CSV ─────────────────────────────────────────────

function exportCSV() {
  // Consolida por usuário (histórico completo)
  const byUser = new Map();
  for (const t of cache.trips) {
    if (!byUser.has(t.uid)) byUser.set(t.uid, { name: t.userName, count: 0, paid: 0, open: 0 });
    const u = byUser.get(t.uid);
    u.count++;
    if (t.paid) u.paid += amt(t); else u.open += amt(t);
  }
  for (const prof of cache.users) {
    if (!byUser.has(prof.uid)) byUser.set(prof.uid, { name: prof.name, count: 0, paid: 0, open: 0 });
    const u = byUser.get(prof.uid);
    u.email = prof.email;
    u.role  = prof.role;
    if (prof.name) u.name = prof.name;
  }

  const header = ["Nome", "E-mail", "Papel", "Viagens", "Pago (R$)", "Em aberto (R$)", "Total (R$)"];
  const lines  = [...byUser.values()].map(u => [
    u.name || "",
    u.email || "",
    u.role || "",
    u.count,
    u.paid.toFixed(2).replace(".", ","),
    u.open.toFixed(2).replace(".", ","),
    (u.paid + u.open).toFixed(2).replace(".", ",")
  ]);

  const csv = [header, ...lines]
    .map(row => row.map(cell => `"${String(cell).replace(/"/g, '""')}"`).join(";"))
    .join("\r\n");

  // BOM para o Excel reconhecer acentos
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url;
  a.download = `caronaapp_relatorio_${todayISO()}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast("Relatório exportado!", "success");
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
