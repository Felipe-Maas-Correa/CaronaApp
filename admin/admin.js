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
  getTripValue, tripAmount, setTripValueSetting, updateGroupSettings, clearGroupTrips
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
import { showToast, formatCurrency, icon, escapeHtml, safeImageSrc, todayISO, copyToClipboard } from "../js/utils.js";

// Valor de cada viagem (respeita preços diferentes ao longo do tempo)
const amt = t => tripAmount(t);

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
  // Convites (dono do grupo) — botão principal e o card de configurações.
  document.getElementById("btn-invite")?.addEventListener("click", openInviteModal);
  document.getElementById("btn-invite-2")?.addEventListener("click", openInviteModal);

  // Engrenagem do header abre a lista de configurações do grupo. Cada item
  // abre seu próprio editor (bottom-sheet), em vez de mostrar tudo de uma vez.
  document.getElementById("btn-adm-settings")?.addEventListener("click", openAdmSettings);
  document.querySelectorAll("[data-close-adm-sheet]").forEach(el =>
    el.addEventListener("click", closeAdmSettings));

  document.getElementById("set-value")?.addEventListener("click", () =>
    openEditSheet("sheet-edit-value", () => {
      document.getElementById("adm-price-input").value = getTripValue();
    }));
  document.getElementById("set-pix")?.addEventListener("click", () =>
    openEditSheet("sheet-edit-pix", () => {
      document.getElementById("adm-pix-input").value = currentGroup?.pixKey || "";
    }));
  document.getElementById("set-name")?.addEventListener("click", () =>
    openEditSheet("sheet-edit-name", () => {
      const el = document.getElementById("adm-name-input");
      el.value = currentGroup?.name || "";
      document.getElementById("adm-name-error").textContent = "";
    }));
  document.getElementById("set-members")?.addEventListener("click", () => {
    // "Membros" leva à lista de passageiros do painel (onde se gerencia).
    closeAdmSettings();
    document.querySelector('.adm2-sectitle .adm2-add')?.closest(".adm2-sectitle")
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  });
  document.getElementById("btn-save-name")?.addEventListener("click", handleSaveName);
  document.querySelectorAll("[data-close-edit]").forEach(el =>
    el.addEventListener("click", () => closeEditSheet(el.dataset.closeEdit)));

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    const openEdit = document.querySelector('[id^="sheet-edit-"]:not([hidden])');
    if (openEdit) closeEditSheet(openEdit.id);
    else if (!document.getElementById("sheet-adm-settings")?.hidden) closeAdmSettings();
  });

  // Copiar a chave PIX do grupo.
  document.getElementById("btn-copy-pix-adm")?.addEventListener("click", async () => {
    const key = document.getElementById("adm-pix-input")?.value.trim();
    if (!key) { showToast("Nenhuma chave PIX cadastrada.", "info"); return; }
    const ok = await copyToClipboard(key);
    showToast(ok ? "Chave PIX copiada!" : "Não foi possível copiar.", ok ? "success" : "error");
  });

  // "Ver todos" os passageiros: alterna os que passam do preview.
  document.getElementById("btn-pax-all")?.addEventListener("click", () => {
    const btn = document.getElementById("btn-pax-all");
    const expand = btn.dataset.expanded !== "1";
    document.querySelectorAll("#users-list .pax2--extra")
      .forEach(el => el.classList.toggle("hidden", !expand));
    btn.dataset.expanded = expand ? "1" : "0";
    const total = document.querySelectorAll("#users-list .pax2").length;
    btn.textContent = expand ? "Ver menos" : `Ver todos (${total})`;
  });

  // Fechar o drawer do passageiro (backdrop, X ou Esc).
  document.querySelectorAll("[data-close-drawer]").forEach(el =>
    el.addEventListener("click", closeUserDrawer));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !document.getElementById("drawer-user")?.hidden) closeUserDrawer();
  });

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

// ── CONFIGURAÇÕES DO GRUPO (sheet da engrenagem) ─────────────

function openAdmSettings() {
  if (!(isGroupOwner() || isSuperAdmin())) {
    showToast("Só o dono do grupo edita as configurações.", "info");
    return;
  }
  renderSettingsList();
  const s = document.getElementById("sheet-adm-settings");
  if (!s) return;
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("hub-sheet--open"));
}

function closeAdmSettings() {
  const s = document.getElementById("sheet-adm-settings");
  if (!s) return;
  s.classList.remove("hub-sheet--open");
  setTimeout(() => { s.hidden = true; }, 220);
}

// Preenche a lista de configurações com os valores atuais do grupo.
function renderSettingsList() {
  setText("settings-group-name", currentGroup?.name || "Configurações");
  setText("set-value-cur", formatCurrency(getTripValue()));
  setText("set-pix-cur", currentGroup?.pixKey ? currentGroup.pixKey : "Não cadastrada");
  setText("set-name-cur", currentGroup?.name || "—");
  const n = cache.users.length;
  setText("set-members-cur", `${n} ${n === 1 ? "passageiro" : "passageiros"}`);
}

// ── EDITORES (bottom-sheets sobre a lista) ───────────────────
function openEditSheet(id, fill) {
  const s = document.getElementById(id);
  if (!s) return;
  if (typeof fill === "function") fill();
  s.hidden = false;
  requestAnimationFrame(() => s.classList.add("hub-sheet--open"));
  s.querySelector("input")?.focus();
}
function closeEditSheet(id) {
  const s = document.getElementById(id);
  if (!s) return;
  s.classList.remove("hub-sheet--open");
  setTimeout(() => { s.hidden = true; }, 220);
}

async function handleSaveName() {
  const input = document.getElementById("adm-name-input");
  const err   = document.getElementById("adm-name-error");
  const name  = String(input.value || "").trim();
  if (err) err.textContent = "";
  if (name.length < 2) { if (err) err.textContent = "Dê um nome ao grupo (mín. 2 caracteres)."; return; }

  const gid = myGroupId();
  if (!gid || !currentGroup) { showToast("Entre em um grupo primeiro.", "error"); return; }

  const btn = document.getElementById("btn-save-name");
  btn.disabled = true; btn.textContent = "...";
  try {
    // Reaproveita updateGroupSettings (mesma rota do valor/PIX): muda só o
    // nome, mantendo valor e chave PIX.
    await updateGroupSettings(gid, { name, pixKey: currentGroup.pixKey || "", tripValue: currentGroup.tripValue });
    await loadGroupContext();
    renderGroupHeader();
    renderSettingsList();
    updateHeaderSubtitle();
    closeEditSheet("sheet-edit-name");
    showToast("Nome do grupo atualizado.", "success");
  } catch (e) {
    console.error(e);
    if (err) err.textContent = "Não foi possível salvar o nome.";
  } finally {
    btn.disabled = false; btn.textContent = "Salvar";
  }
}

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
    renderGroupHeader();
    renderSettingsList();
    closeEditSheet("sheet-edit-value");
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
    renderSettingsList();
    closeEditSheet("sheet-edit-pix");
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
    // A visão do sistema (todos os grupos/contas) mudou para a aba "Sistema",
    // carregada por loadSystemPanel quando o admin master abre aquela aba.
  } catch (e) {
    console.error("Erro ao carregar painel admin:", e);
    const c = document.getElementById("users-list");
    if (c) c.innerHTML = `<p class="error-msg">Erro ao carregar dados.</p>`;
  }
}

function renderAll() {
  renderGroupHeader();
  renderAttention();
  renderPeriodStats();
  renderManageUsers();
  renderActivity();
  renderStats();
}

function renderGroupHeader() {
  const nameEl = document.getElementById("adm-group-name");
  const subEl  = document.getElementById("adm-group-sub");
  if (nameEl) nameEl.textContent = currentGroup?.name || "Sem grupo";

  // Subtítulo enxuto: valor por viagem e nº de passageiros. O cargo já
  // aparece no cabeçalho geral do app — aqui não repetimos.
  if (subEl) {
    const n = cache.users.length;
    subEl.textContent =
      `${formatCurrency(getTripValue())} por viagem · ${n} ${n === 1 ? "passageiro" : "passageiros"}`;
  }

  const pax = document.getElementById("adm-pax-count");
  if (pax) pax.textContent = cache.users.length ? `· ${cache.users.length}` : "";

  // Convidar, configurar e apagar o grupo são do dono (ou do ADM SUPREMO).
  const canManage = isGroupOwner() || isSuperAdmin();
  document.getElementById("btn-invite")?.classList.toggle("hidden", !canManage);
  document.getElementById("btn-adm-settings")?.classList.toggle("hidden", !canManage);
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
  // Passageiros no lugar da adimplência (que migrou para Estatísticas). É a
  // contagem do grupo, não depende do período.
  setText("adm-pax",      cache.users.length);
  void rate; // ainda calculado acima; usado na seção de Estatísticas
}

// ── DRAWER DE UM PASSAGEIRO ──────────────────────────────────
// Desliza da direita e mantém a lista atrás visível — assim dá para fechar
// um passageiro e abrir o próximo sem perder o contexto (padrão Linear/GitHub).

function openUserDrawer(uid) {
  const prof  = cache.users.find(x => x.uid === uid);
  const trips = cache.trips.filter(t => t.uid === uid);
  const name  = prof?.name || trips[0]?.userName || "Usuário";
  const email = prof?.email || "";
  const isCurrentUser = uid === currentProfile?.uid;
  const isOwner       = uid === currentGroup?.ownerUid;
  const canManage     = isGroupOwner() || isSuperAdmin();

  const today = todayISO();
  const stat = (period) => {
    const r = getPeriodRange(period);
    const t = trips.filter(x => inPeriod(x.date, r));
    const paid = t.filter(x => x.paid).reduce((s, x) => s + amt(x), 0);
    const open = t.filter(x => !x.paid && x.date <= today).reduce((s, x) => s + amt(x), 0);
    return { trips: t.length, paid, open };
  };

  const totalPaid = trips.filter(t => t.paid).reduce((s, t) => s + amt(t), 0);
  const totalOpen = trips.filter(t => !t.paid && t.date <= today).reduce((s, t) => s + amt(t), 0);
  const rate = trips.length ? Math.round((trips.filter(t => t.paid).length / trips.length) * 100) : 0;

  const av = document.getElementById("drawer-avatar");
  av.style.background = avatarColor(name);
  av.innerHTML = avatarInner(name, prof?.photo);
  document.getElementById("drawer-name").textContent = name;
  document.getElementById("drawer-mail").textContent = email || (isOwner ? "dono do grupo" : "");

  const periods = [["Semana", "week"], ["Mês", "month"], ["Semestre", "semester"], ["Ano", "year"], ["Total", "all"]];
  const rowsHtml = periods.map(([label, p]) => {
    const s = stat(p);
    return `
      <div class="drawer-row">
        <span class="drawer-row__period">${label}</span>
        <span class="drawer-row__trips">${s.trips} viag.</span>
        <span class="drawer-row__paid">${formatCurrency(s.paid)}</span>
        <span class="drawer-row__open ${s.open ? "" : "is-zero"}">${formatCurrency(s.open)}</span>
      </div>`;
  }).join("");

  document.getElementById("drawer-body").innerHTML = `
    <div class="drawer-kpis">
      <div class="drawer-kpi"><span>${trips.length}</span><small>viagens</small></div>
      <div class="drawer-kpi drawer-kpi--paid"><span>${formatCurrency(totalPaid)}</span><small>pago</small></div>
      <div class="drawer-kpi drawer-kpi--debt"><span>${formatCurrency(totalOpen)}</span><small>em aberto</small></div>
      <div class="drawer-kpi"><span>${rate}%</span><small>adimplência</small></div>
    </div>
    <div class="drawer-table">
      <div class="drawer-row drawer-row--head"><span></span><span>Viagens</span><span>Pago</span><span>Aberto</span></div>
      ${rowsHtml}
    </div>`;

  // Ações do dono: passar a posse e remover do grupo. Nunca sobre si mesmo
  // nem sobre o dono atual.
  const actions = document.getElementById("drawer-actions");
  if (canManage && !isCurrentUser && !isOwner) {
    actions.innerHTML = `
      <button class="drawer-act" data-drawer-transfer="${uid}">
        ${icon("crown")} Passar a posse do grupo
      </button>
      <button class="drawer-act drawer-act--danger" data-drawer-remove="${uid}">
        ${icon("trash")} Remover do grupo
      </button>`;
    actions.querySelector("[data-drawer-transfer]")
      ?.addEventListener("click", () => { closeUserDrawer(); confirmTransfer(uid); });
    actions.querySelector("[data-drawer-remove]")
      ?.addEventListener("click", () => { closeUserDrawer(); confirmRemoveMember(uid); });
  } else {
    actions.innerHTML = "";
  }

  const d = document.getElementById("drawer-user");
  d.hidden = false;
  requestAnimationFrame(() => d.classList.add("drawer--open"));
}

function closeUserDrawer() {
  const d = document.getElementById("drawer-user");
  if (!d) return;
  d.classList.remove("drawer--open");
  setTimeout(() => { d.hidden = true; }, 240);
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

  const today = todayISO();
  const statOf = (uid) => {
    const t = cache.trips.filter(x => x.uid === uid);
    const paid = t.filter(x => x.paid).reduce((s, x) => s + amt(x), 0);
    const open = t.filter(x => !x.paid && x.date <= today).reduce((s, x) => s + amt(x), 0);
    return { trips: t.length, paid, open, total: paid + open };
  };

  // Dono primeiro; depois quem tem mais em aberto (é quem o dono precisa ver).
  const rows = cache.users.slice().sort((a, b) => {
    const ao = a.uid === currentGroup?.ownerUid, bo = b.uid === currentGroup?.ownerUid;
    if (ao !== bo) return ao ? -1 : 1;
    return statOf(b.uid).open - statOf(a.uid).open;
  });

  // Card enxuto: avatar, nome, status financeiro e o valor. Tudo mais (cargo,
  // e-mail, quebra por período) mora no drawer, ao tocar.
  const rowHtml = (u, i) => {
    const s = statOf(u.uid);
    const isCurrentUser = u.uid === currentProfile?.uid;
    const inactive = u.active === false;
    const status = s.open > 0
      ? `<span class="pax2__status pax2__status--debt">${icon("alert")} ${formatCurrency(s.open)} em aberto</span>`
      : `<span class="pax2__status pax2__status--ok"><span class="pax2__dot"></span> Em dia</span>`;
    return `
      <button class="pax2 ${inactive ? "pax2--off" : ""} ${i >= PAX_PREVIEW ? "pax2--extra hidden" : ""}" data-open-pax="${u.uid}">
        <span class="pax2__avatar" style="background:${avatarColor(u.name)}">${avatarInner(u.name, u.photo)}</span>
        <span class="pax2__id">
          <span class="pax2__name">${escapeHtml(u.name || "—")}${isCurrentUser ? ' <span class="pax2__you">você</span>' : ""}</span>
          ${status}
        </span>
        <span class="pax2__value">${formatCurrency(s.total)}</span>
      </button>`;
  };

  container.innerHTML = `<div class="pax2-list">${rows.map(rowHtml).join("")}</div>`;

  // "Ver todos": só aparece quando há mais passageiros que o preview.
  const seeAll = document.getElementById("btn-pax-all");
  if (seeAll) {
    const hasExtra = rows.length > PAX_PREVIEW;
    seeAll.classList.toggle("hidden", !hasExtra);
    seeAll.textContent = `Ver todos (${rows.length})`;
    seeAll.dataset.expanded = "0";
  }

  container.querySelectorAll("[data-open-pax]").forEach(btn => {
    btn.addEventListener("click", () => openUserDrawer(btn.dataset.openPax));
  });
}

// Quantos passageiros aparecem antes do "Ver todos".
const PAX_PREVIEW = 5;

// ── PRECISA DA SUA ATENÇÃO ───────────────────────────────────
// Pendências dinâmicas: comprovantes a aprovar e o maior devedor. Dourado
// para atenção normal; vermelho só para dívida real. Sem pendência, "tudo
// em ordem". Tudo derivado dos dados já carregados — nada inventado.
function renderAttention() {
  const box = document.getElementById("adm-attention");
  if (!box) return;

  const today = todayISO();
  const items = [];

  const pending = cache.payments.filter(p => p.status === "pending").length;
  if (pending > 0) {
    items.push({
      tone: "warn", ico: icon("clock"), action: "payments",
      title: "Pagamentos pendentes",
      desc: `${pending} comprovante${pending > 1 ? "s" : ""} aguardando aprovação`
    });
  }

  let top = null, topOpen = 0;
  for (const u of cache.users) {
    const open = cache.trips
      .filter(t => t.uid === u.uid && !t.paid && t.date <= today)
      .reduce((s, t) => s + amt(t), 0);
    if (open > topOpen) { topOpen = open; top = u; }
  }
  if (top) {
    items.push({
      tone: "debt", ico: icon("alert"), action: "pax:" + top.uid,
      title: "Pendência financeira",
      desc: `${top.name || "Passageiro"} tem ${formatCurrency(topOpen)} em aberto`
    });
  }

  if (items.length === 0) {
    box.innerHTML = `
      <div class="attn attn--ok">
        <span class="attn__ico">${icon("check")}</span>
        <span class="attn__txt">
          <span class="attn__title">Tudo em ordem</span>
          <span class="attn__desc">Nenhuma ação pendente no momento.</span>
        </span>
      </div>`;
    return;
  }

  const chev = `<svg class="attn__chev" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>`;
  box.innerHTML = items.map(it => `
    <button class="attn attn--${it.tone}" data-attn="${escapeHtml(it.action)}">
      <span class="attn__ico">${it.ico}</span>
      <span class="attn__txt">
        <span class="attn__title">${escapeHtml(it.title)}</span>
        <span class="attn__desc">${escapeHtml(it.desc)}</span>
      </span>
      ${chev}
    </button>`).join("");

  box.querySelectorAll("[data-attn]").forEach(b => b.addEventListener("click", () => {
    const a = b.dataset.attn;
    if (a === "payments") document.querySelector('.nav-btn[data-tab="tab-payments"]')?.click();
    else if (a.startsWith("pax:")) openUserDrawer(a.slice(4));
  }));
}

// ── ATIVIDADE ────────────────────────────────────────────────
// Viagens agrupadas por dia (derivado das viagens do grupo). Lista vertical
// compacta, sem tabela larga.
function renderActivity() {
  const box = document.getElementById("adm-activity");
  if (!box) return;

  const byDate = new Map();
  for (const t of cache.trips) {
    if (!byDate.has(t.date)) byDate.set(t.date, { pax: 0, value: 0 });
    const d = byDate.get(t.date);
    d.pax++; d.value += amt(t);
  }
  const dates = [...byDate.keys()].sort().reverse().slice(0, 8);
  if (dates.length === 0) {
    box.innerHTML = emptyState("clock", "Nenhuma viagem registrada ainda.");
    return;
  }

  let html = `<div class="act">`;
  let lastMonth = "";
  for (const date of dates) {
    const [y, m, dd] = date.split("-");
    const label = new Date(+y, +m - 1, 1)
      .toLocaleDateString("pt-BR", { month: "long", year: "numeric" });
    if (label !== lastMonth) { html += `<div class="act__month">${label}</div>`; lastMonth = label; }
    const d = byDate.get(date);
    html += `
      <div class="act__row">
        <span class="act__day">${dd}</span>
        <span class="act__pax">${d.pax} passageiro${d.pax > 1 ? "s" : ""}</span>
        <span class="act__val">${formatCurrency(d.value)}</span>
      </div>`;
  }
  html += `</div>`;
  box.innerHTML = html;
}

// ── ESTATÍSTICAS ─────────────────────────────────────────────
// Gráfico de barras (viagens por mês) + adimplência. Barras em CSS puro
// (sem SVG/lib), legíveis a 360px.
function renderStats() {
  const box = document.getElementById("adm-stats");
  if (!box) return;

  const months = lastMonths(6);
  const counts = months.map(mo => cache.trips.filter(t => (t.date || "").slice(0, 7) === mo.key).length);
  const max = Math.max(1, ...counts);
  const bars = months.map((mo, i) => {
    const h = Math.max(4, Math.round((counts[i] / max) * 100));
    return `
      <div class="bar">
        <span class="bar__val">${counts[i]}</span>
        <span class="bar__track"><span class="bar__fill" style="height:${h}%"></span></span>
        <span class="bar__lbl">${mo.label}</span>
      </div>`;
  }).join("");

  const total = cache.trips.length;
  const paid  = cache.trips.filter(t => t.paid).length;
  const rate  = total ? Math.round((paid / total) * 100) : 0;

  box.innerHTML = `
    <div class="stat-card">
      <div class="stat-card__head">Viagens por mês</div>
      <div class="barchart">${bars}</div>
    </div>
    <div class="stat-card">
      <div class="stat-card__head">Adimplência</div>
      <div class="stat-rate">
        <span class="stat-rate__num">${rate}%</span>
        <span class="stat-rate__track"><span class="stat-rate__fill" style="width:${rate}%"></span></span>
      </div>
    </div>`;
}

// Últimos N meses como {key:'2026-09', label:'set'}, do mais antigo ao atual.
function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push({
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`,
      label: d.toLocaleDateString("pt-BR", { month: "short" }).replace(".", "")
    });
  }
  return out;
}

function emptyState(ic, text) {
  return `<div class="empty-state"><div class="empty-state__icon">${icon(ic)}</div><p>${escapeHtml(text)}</p></div>`;
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

// Exportada: a aba "Sistema" (ADM MASTER) a chama ao abrir. Só o admin do
// sistema chega aqui — as consultas globais seriam negadas para os demais.
export async function loadSystemPanel() {
  if (!isSuperAdmin()) return;
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
