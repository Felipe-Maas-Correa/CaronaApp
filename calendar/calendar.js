// ============================================================
// MÓDULO: calendar.js
// Calendário mensal.
//  • Usuário comum: marca/remove as PRÓPRIAS viagens.
//  • Admin: marca QUAIS passageiros estavam em cada dia e vê a
//    contagem por dia (visão de todos os usuários).
// ============================================================

import { setTrip, deleteTrip, getUserTrips, getAllTrips, getAllUsers, getTripValue, rateTrip } from "../js/db.js";
import { showToast, formatCurrency, formatDate, icon, todayISO, escapeHtml } from "../js/utils.js";
import { refreshSummary } from "../summary/summary.js";
import { currentProfile, isAdmin } from "../auth/auth.js";

// Opções de velocidade (avaliação)
const SPEEDS = [
  { key: "slow", emoji: "🐢", label: "Devagar" },
  { key: "mid",  emoji: "🚗", label: "Mais ou menos" },
  // U+1F3CE sem o seletor FE0F: o mesmo carro de corrida, mas em
  // apresentação de texto — assim a fonte Noto Emoji o renderiza
  // monocromático (com FE0F o sistema forçava a versão colorida).
  { key: "fast", emoji: "\u{1F3CE}", label: "Rápida" },
];

let currentYear  = new Date().getFullYear();
let currentMonth = new Date().getMonth() + 1; // 1-12

let tripsMap  = {};   // usuário: { "YYYY-MM-DD": trip }
let dayTrips  = {};   // admin:   { "YYYY-MM-DD": [trip, ...] }
let allUsers  = [];   // admin: lista de usuários (passageiros)

const WEEKDAYS = ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"];
const MONTHS   = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

// ── INIT ─────────────────────────────────────────────────────

export async function initCalendar() {
  bindNavigation();
  await loadAndRender();
}

function bindNavigation() {
  document.getElementById("btn-prev-month").addEventListener("click", async () => {
    currentMonth--;
    if (currentMonth < 1) { currentMonth = 12; currentYear--; }
    await loadAndRender();
  });
  document.getElementById("btn-next-month").addEventListener("click", async () => {
    currentMonth++;
    if (currentMonth > 12) { currentMonth = 1; currentYear++; }
    await loadAndRender();
  });
  document.getElementById("btn-today").addEventListener("click", async () => {
    currentYear  = new Date().getFullYear();
    currentMonth = new Date().getMonth() + 1;
    await loadAndRender();
  });
}

// ── LOAD & RENDER ────────────────────────────────────────────

export async function loadAndRender() {
  showCalendarLoading(true);
  try {
    const prefix = `${currentYear}-${String(currentMonth).padStart(2, "0")}-`;

    if (isAdmin()) {
      const [all, users] = await Promise.all([getAllTrips(), getAllUsers()]);
      allUsers = users;
      dayTrips = {};
      all.forEach(t => {
        if (!t.date?.startsWith(prefix)) return;
        (dayTrips[t.date] = dayTrips[t.date] || []).push(t);
      });
    } else {
      const all = await getUserTrips(currentProfile.uid);
      tripsMap = {};
      all.forEach(t => { if (t.date.startsWith(prefix)) tripsMap[t.date] = t; });
    }

    renderCalendar();
    renderMonthStats();
  } catch (e) {
    console.error(e);
    showToast("Erro ao carregar calendário", "error");
  } finally {
    showCalendarLoading(false);
  }
}

function showCalendarLoading(show) {
  document.getElementById("calendar-loading").style.display = show ? "flex" : "none";
  document.getElementById("calendar-grid").style.opacity   = show ? "0.3" : "1";
}

// Info do dia conforme o modo
function dayInfo(dateStr) {
  if (isAdmin()) {
    const trips = dayTrips[dateStr] || [];
    const paid  = trips.filter(t => t.paid).length;
    return { has: trips.length > 0, count: trips.length, paid, unpaid: trips.length - paid, allPaid: trips.length > 0 && paid === trips.length };
  }
  const t = tripsMap[dateStr];
  return { has: !!t, count: t ? 1 : 0, paid: t?.paid ? 1 : 0, unpaid: t && !t.paid ? 1 : 0, allPaid: !!t?.paid, trip: t };
}

function renderCalendar() {
  document.getElementById("calendar-month-label").textContent =
    `${MONTHS[currentMonth - 1]} ${currentYear}`;

  const grid = document.getElementById("calendar-grid");
  grid.innerHTML = "";

  WEEKDAYS.forEach(day => {
    const el = document.createElement("div");
    el.className = "cal-weekday";
    el.textContent = day;
    grid.appendChild(el);
  });

  const firstDay  = new Date(currentYear, currentMonth - 1, 1).getDay();
  const totalDays = new Date(currentYear, currentMonth, 0).getDate();
  const today     = todayISO();

  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement("div");
    el.className = "cal-day cal-day--empty";
    grid.appendChild(el);
  }

  const admin = isAdmin();

  for (let d = 1; d <= totalDays; d++) {
    const dateStr = `${currentYear}-${String(currentMonth).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const info    = dayInfo(dateStr);
    const isToday = dateStr === today;
    const dow     = new Date(currentYear, currentMonth - 1, d).getDay();
    const isWeekend = dow === 0 || dow === 6;

    const el = document.createElement("div");
    el.className = "cal-day";
    if (isToday)   el.classList.add("cal-day--today");
    if (isWeekend) el.classList.add("cal-day--weekend");
    if (info.has)  el.classList.add(info.allPaid ? "cal-day--paid" : "cal-day--unpaid");

    let badge = "";
    if (info.has) {
      if (admin) badge = `<span class="cal-day__badge">${info.count}</span>`;
      else       badge = `<span class="cal-day__badge">${info.allPaid ? "✓" : "R$"}</span>`;
    }

    el.innerHTML = `<span class="cal-day__number">${d}</span>${badge}`;
    el.addEventListener("click", () => openDayModal(dateStr, isWeekend));
    grid.appendChild(el);
  }
}

function renderMonthStats() {
  let total = 0, paid = 0;

  if (isAdmin()) {
    Object.values(dayTrips).forEach(list => {
      total += list.length;
      paid  += list.filter(t => t.paid).length;
    });
  } else {
    const trips = Object.values(tripsMap);
    total = trips.length;
    paid  = trips.filter(t => t.paid).length;
  }

  const unpaid = total - paid;

  // Dívida = soma dos valores das viagens em aberto (respeita preços variados)
  let debt = 0;
  const lists = isAdmin() ? Object.values(dayTrips) : [Object.values(tripsMap)];
  lists.forEach(list => list.forEach(t => { if (!t.paid) debt += (t.amount ?? 15); }));

  document.getElementById("month-total-trips").textContent  = total;
  document.getElementById("month-paid-trips").textContent   = paid;
  document.getElementById("month-unpaid-trips").textContent = unpaid;
  document.getElementById("month-debt").textContent         = formatCurrency(debt);
}

// ── MODAL DO DIA ──────────────────────────────────────────────

function openDayModal(dateStr, isWeekend) {
  if (isAdmin()) return openDayModalAdmin(dateStr, isWeekend);
  return openDayModalUser(dateStr, isWeekend);
}

// ---- Usuário comum: própria viagem ----
function openDayModalUser(dateStr, isWeekend) {
  const modal   = document.getElementById("modal-day");
  const title   = document.getElementById("modal-day-title");
  const content = document.getElementById("modal-day-content");
  const trip    = tripsMap[dateStr];

  title.textContent = formatDate(dateStr);

  if (!trip) {
    // Dia sem viagem: pode adicionar (usuário NÃO pode excluir depois)
    content.innerHTML = `
      <p class="modal-info">Nenhuma viagem registrada neste dia.</p>
      <button class="btn btn--primary btn--full" id="btn-add-trip" data-date="${dateStr}">
        ${icon("car")} Registrar Viagem (${formatCurrency(getTripValue())})
      </button>
      ${isWeekend ? `<p class="modal-hint">${icon("alert")} Fim de semana — tem certeza?</p>` : ""}
    `;
    modal.classList.add("modal--open");
    document.getElementById("btn-add-trip")?.addEventListener("click", async (e) => {
      closeModal("modal-day");
      await addOwnTrip(e.target.closest("button").dataset.date);
    });
    return;
  }

  // Dia com viagem: mostra status + AVALIAÇÃO (estrelas + velocidade)
  const statusHtml = trip.paid
    ? `<div class="info-row"><span>Status</span><strong class="text-paid">Pago</strong></div>`
    : `<div class="info-row"><span>Status</span><strong class="text-debt">Em aberto</strong></div>`;

  content.innerHTML = `
    <div class="modal-trip-info">
      <div class="info-row"><span>Valor</span><strong>${formatCurrency(trip.amount)}</strong></div>
      ${statusHtml}
    </div>

    <div class="rate-block">
      <div class="rate-label">Sua nota</div>
      <div class="rate-stars" id="rate-stars">
        ${[1,2,3,4,5].map(n => `<button class="rate-star" data-star="${n}" aria-label="${n} estrelas">${starSvg()}</button>`).join("")}
      </div>

      <div class="rate-label">Como foi a velocidade?</div>
      <div class="rate-speeds" id="rate-speeds">
        ${SPEEDS.map(s => `<button class="rate-speed" data-speed="${s.key}" title="${s.label}"><span class="rate-speed__emoji">${s.emoji}</span><span class="rate-speed__label">${s.label}</span></button>`).join("")}
      </div>
    </div>

    <button class="btn btn--primary btn--full mt-sm" id="btn-save-rating" data-date="${dateStr}">
      ${icon("check")} Salvar avaliação
    </button>
    ${trip.paid ? `<p class="modal-hint">Pagamento já registrado.</p>` : ""}
  `;
  modal.classList.add("modal--open");

  // Estado local da avaliação
  let selStars = trip.stars || 0;
  let selSpeed = trip.speed || null;
  paintStars(selStars);
  paintSpeed(selSpeed);

  content.querySelectorAll(".rate-star").forEach(btn => {
    btn.addEventListener("click", () => { selStars = Number(btn.dataset.star); paintStars(selStars); });
  });
  content.querySelectorAll(".rate-speed").forEach(btn => {
    btn.addEventListener("click", () => { selSpeed = btn.dataset.speed; paintSpeed(selSpeed); });
  });

  document.getElementById("btn-save-rating").addEventListener("click", async (e) => {
    const btn = e.target.closest("button");
    btn.disabled = true;
    try {
      await rateTrip(currentProfile.uid, dateStr, selStars, selSpeed);
      if (tripsMap[dateStr]) { tripsMap[dateStr].stars = selStars; tripsMap[dateStr].speed = selSpeed; }
      closeModal("modal-day");
      showToast("Avaliação salva!", "success");
    } catch (err) {
      console.error(err);
      showToast("Erro ao salvar avaliação", "error");
    } finally {
      btn.disabled = false;
    }
  });
}

// Helpers de pintura da avaliação
function starSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="lucide"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>`;
}
function paintStars(n) {
  document.querySelectorAll("#rate-stars .rate-star").forEach(b => {
    b.classList.toggle("is-on", Number(b.dataset.star) <= n);
  });
}
function paintSpeed(key) {
  document.querySelectorAll("#rate-speeds .rate-speed").forEach(b => {
    b.classList.toggle("is-on", b.dataset.speed === key);
  });
}

// ---- Admin: escolher passageiros ----
function openDayModalAdmin(dateStr, isWeekend) {
  const modal   = document.getElementById("modal-day");
  const title   = document.getElementById("modal-day-title");
  const content = document.getElementById("modal-day-content");

  title.textContent = formatDate(dateStr);

  const dayList = dayTrips[dateStr] || [];
  const tripByUid = new Map(dayList.map(t => [t.uid, t]));

  // Passageiros selecionáveis: usuários ativos + quem já tiver viagem no dia
  const selectable = allUsers.filter(u => u.active !== false || tripByUid.has(u.uid));

  const itemsHtml = selectable.map(u => {
    const trip   = tripByUid.get(u.uid);
    const paid   = !!trip?.paid;
    const checked = !!trip;
    // Só admin, e só quando o passageiro JÁ tem viagem no dia, mostra a lixeira.
    const removeBtn = checked
      ? `<button type="button" class="pax-item__remove" title="Remover viagem"
           data-remove-uid="${u.uid}" data-remove-name="${escapeHtml(u.name || "")}" data-remove-paid="${paid}">
           ${icon("trash")}
         </button>`
      : "";
    return `
      <label class="pax-item ${paid ? "pax-item--locked" : ""}">
        <input type="checkbox" class="pax-check" data-uid="${u.uid}" data-name="${escapeHtml(u.name || "")}"
          ${checked ? "checked" : ""} ${paid ? "disabled" : ""}>
        <span class="pax-item__avatar">${escapeHtml((u.name || "?").charAt(0).toUpperCase())}</span>
        <span class="pax-item__name">${escapeHtml(u.name || "—")}</span>
        <span class="pax-item__tag">${paid ? "pago" : (checked ? "em aberto" : "")}</span>
        ${removeBtn}
      </label>
    `;
  }).join("");

  content.innerHTML = `
    <p class="modal-info">Quem estava nesta viagem? (${formatCurrency(getTripValue())} por passageiro)</p>
    ${isWeekend ? `<p class="modal-hint">${icon("alert")} Fim de semana</p>` : ""}
    <div class="pax-list">${itemsHtml || "<p class='modal-hint'>Nenhum usuário cadastrado.</p>"}</div>
    <button class="btn btn--primary btn--full mt-sm" id="btn-save-pax" data-date="${dateStr}">
      ${icon("check")} Salvar viagem do dia
    </button>
  `;
  modal.classList.add("modal--open");

  document.getElementById("btn-save-pax")?.addEventListener("click", async (e) => {
    const date = e.target.closest("button").dataset.date;
    await savePassengers(date);
  });

  // Remover viagem individual (admin) — inclusive se já estiver paga.
  content.querySelectorAll(".pax-item__remove").forEach(btn => {
    btn.addEventListener("click", (e) => {
      // Não deixa o clique marcar/desmarcar o checkbox do label.
      e.preventDefault();
      e.stopPropagation();
      const uid  = btn.dataset.removeUid;
      const name = btn.dataset.removeName || "este passageiro";
      const paid = btn.dataset.removePaid === "true";
      const msg  = paid
        ? `Remover a viagem PAGA de ${name} em ${formatDate(dateStr, "short")}? O pagamento já registrado NÃO será alterado.`
        : `Remover a viagem de ${name} em ${formatDate(dateStr, "short")}?`;
      askConfirm(msg, () => removeTrip(uid, dateStr));
    });
  });
}

// Confirmação reutilizando o modal padrão do app.
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

async function removeTrip(uid, dateStr) {
  if (!isAdmin()) return; // trava extra no cliente (as regras garantem no servidor)
  try {
    await deleteTrip(uid, dateStr);
    closeModal("modal-day");
    await loadAndRender();
    await refreshSummary();
    showToast("Viagem removida.", "info");
  } catch (e) {
    console.error(e);
    showToast("Erro ao remover a viagem", "error");
  }
}

async function savePassengers(dateStr) {
  const btn = document.getElementById("btn-save-pax");
  btn.disabled = true;
  btn.textContent = "Salvando...";

  const dayList = dayTrips[dateStr] || [];
  const tripByUid = new Map(dayList.map(t => [t.uid, t]));

  const checks = [...document.querySelectorAll(".pax-check")];
  const ops = [];

  for (const chk of checks) {
    const uid   = chk.dataset.uid;
    const name  = chk.dataset.name;
    const had   = tripByUid.has(uid);
    const paid  = !!tripByUid.get(uid)?.paid;
    const now   = chk.checked;

    if (now && !had)            ops.push(setTrip(uid, name, dateStr));
    else if (!now && had && !paid) ops.push(deleteTrip(uid, dateStr));
    // pago permanece
  }

  try {
    await Promise.all(ops);
    closeModal("modal-day");
    await loadAndRender();
    await refreshSummary();
    showToast(`Viagem de ${formatDate(dateStr, "short")} salva!`, "success");
  } catch (e) {
    console.error(e);
    showToast("Erro ao salvar a viagem", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar viagem do dia";
  }
}

// ── AÇÕES DO USUÁRIO COMUM ───────────────────────────────────

async function addOwnTrip(dateStr) {
  try {
    await setTrip(currentProfile.uid, currentProfile.name, dateStr);
    tripsMap[dateStr] = { uid: currentProfile.uid, userName: currentProfile.name, date: dateStr, amount: getTripValue(), paid: false, paymentId: null };
    renderCalendar();
    renderMonthStats();
    await refreshSummary();
    showToast("Viagem registrada!", "success");
  } catch (e) {
    showToast("Erro ao registrar viagem", "error");
  }
}

// ── EXPORTS ──────────────────────────────────────────────────

export function closeModal(id) {
  document.getElementById(id)?.classList.remove("modal--open");
}
export function getCurrentPeriod() { return { year: currentYear, month: currentMonth }; }
