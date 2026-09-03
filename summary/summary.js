// ============================================================
// MÓDULO: summary.js
// Painel de resumo geral (dashboard)
// ============================================================

import { getUserTrips, getUserPayments } from "../js/db.js";
import { formatCurrency, formatDate, formatDateTime, icon, todayISO } from "../js/utils.js";
import { currentProfile, myGroupId } from "../auth/auth.js";

// Filtro de período ativo: "week" | "semester" | "total"
let currentPeriod = "total";
// Cache dos dados para re-renderizar ao trocar de filtro sem consultar o banco.
let cache = { trips: [], payments: [] };

// ── INIT ─────────────────────────────────────────────────────

export async function initSummary() {
  bindPeriodFilter();
  await refreshSummary();
}

// Liga os botões de período (Semana / Semestre / Total).
function bindPeriodFilter() {
  const seg = document.getElementById("sum-period");
  if (!seg || seg.dataset.bound) return;
  seg.dataset.bound = "1";
  seg.querySelectorAll(".adm-seg__btn").forEach(btn => {
    btn.addEventListener("click", () => {
      currentPeriod = btn.dataset.period;
      seg.querySelectorAll(".adm-seg__btn")
        .forEach(b => b.classList.toggle("adm-seg__btn--active", b === btn));
      renderSummaryCards(cache.trips, cache.payments);
    });
  });
}

export async function refreshSummary() {
  try {
    const [allTrips, allPayments] = await Promise.all([
      getUserTrips(currentProfile.uid),
      getUserPayments(currentProfile.uid)
    ]);

    // O resumo é do GRUPO ATIVO. Somar as dívidas de todos os grupos daria
    // um número que não corresponde a nenhuma cobrança real — cada grupo
    // tem o seu dono e a sua chave PIX.
    // Documento sem groupId é de antes dos grupos: entra, para não sumir
    // com histórico de quem já usava o app.
    const gid   = myGroupId();
    const mine  = (d) => !gid || !d.groupId || d.groupId === gid;
    const trips    = allTrips.filter(mine);
    const payments = allPayments.filter(mine);

    cache = { trips, payments };
    renderSummaryCards(trips, payments);
    renderRecentActivity(trips, payments);
  } catch (e) {
    console.error("Erro no summary:", e);
  }
}

// ── PERÍODOS ──────────────────────────────────────────────────

// Intervalo [start, end] em ISO (yyyy-mm-dd) do período atual.
// "total" devolve intervalo aberto (sem limites).
function getPeriodRange(period) {
  const now = new Date();
  const y = now.getFullYear();
  const m = now.getMonth(); // 0-11
  const iso = dt => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, "0")}-${String(dt.getDate()).padStart(2, "0")}`;

  if (period === "week") {
    const start = new Date(now); start.setDate(now.getDate() - now.getDay()); // domingo
    const end   = new Date(start); end.setDate(start.getDate() + 6);
    return { start: iso(start), end: iso(end) };
  }
  if (period === "semester") {
    const firstHalf = m <= 5;
    const start = new Date(y, firstHalf ? 0 : 6, 1);
    const end   = new Date(y, firstHalf ? 5 : 11, firstHalf ? 30 : 31);
    return { start: iso(start), end: iso(end) };
  }
  return { start: null, end: null }; // total
}

function inRange(dateStr, range) {
  if (!range.start) return true;
  return dateStr >= range.start && dateStr <= range.end;
}

// ── CARDS ─────────────────────────────────────────────────────

function renderSummaryCards(trips, payments) {
  // Uma viagem só entra na contabilidade quando a data já chegou (<= hoje).
  // As já pagas contam sempre (dinheiro liquidado); as futuras em aberto ficam
  // "agendadas" e não entram como em aberto até o dia chegar.
  const today = todayISO();
  const range = getPeriodRange(currentPeriod);

  // Aplica o filtro de período (Semana / Semestre / Total) pela data da viagem.
  const relevant = trips.filter(t => (t.paid || t.date <= today) && inRange(t.date, range));

  const totalTrips  = relevant.length;
  const paidTrips   = relevant.filter(t => t.paid).length;
  const unpaidTrips = relevant.filter(t => !t.paid).length;
  const totalDebt   = relevant.filter(t => !t.paid).reduce((s, t) => s + (t.amount ?? 15), 0);
  // Valor já pago no período = soma das viagens pagas cujo dia cai no período.
  const totalPaid   = relevant.filter(t => t.paid).reduce((s, t) => s + (t.amount ?? 15), 0);
  // Pagamentos que cobrem ao menos uma viagem do período.
  const payCount    = payments.filter(p => (p.tripDates || []).some(d => inRange(d, range))).length;

  document.getElementById("sum-total-trips").textContent    = totalTrips;
  document.getElementById("sum-paid-trips").textContent     = paidTrips;
  document.getElementById("sum-unpaid-trips").textContent   = unpaidTrips;
  document.getElementById("sum-total-debt").textContent     = formatCurrency(totalDebt);
  document.getElementById("sum-total-received").textContent = formatCurrency(totalPaid);
  document.getElementById("sum-total-payments").textContent = payCount;

  const percent = totalTrips > 0 ? Math.round((paidTrips / totalTrips) * 100) : 0;
  document.getElementById("sum-progress-bar").style.width   = percent + "%";
  document.getElementById("sum-progress-label").textContent = `${percent}% das viagens pagas`;
}

// ── ATIVIDADE RECENTE ─────────────────────────────────────────

function renderRecentActivity(trips, payments) {
  const container = document.getElementById("sum-recent-activity");

  // Converte pagamentos para atividades com timestamp real para ordenação
  const paymentActivities = payments.map(p => {
    // createdAt pode ser Firestore Timestamp ou objeto JS
    let sortKey;
    try {
      sortKey = p.createdAt?.toDate
        ? p.createdAt.toDate().getTime()
        : new Date(p.createdAt).getTime();
    } catch {
      sortKey = 0;
    }

    const dateLabel = p.createdAt?.toDate
      ? formatDateTime(p.createdAt)
      : "—";

    return {
      type: "payment",
      sortKey,
      label: `Pagamento de ${p.tripDates.length} viagem(ns)`,
      sub: dateLabel,
      amount: p.totalAmount
    };
  });

  // Converte viagens para atividades — usa a data da viagem como sortKey
  const tripActivities = trips.map(t => ({
    type: t.paid ? "trip-paid" : "trip-unpaid",
    sortKey: new Date(t.date + "T12:00:00").getTime(),
    label: t.paid
      ? `Viagem de ${formatDate(t.date, "short")} — paga`
      : `Viagem de ${formatDate(t.date, "short")} — em aberto`,
    sub: null,
    amount: t.amount
  }));

  // Junta tudo, ordena do mais recente para o mais antigo e pega os 10 primeiros
  const activities = [...paymentActivities, ...tripActivities]
    .sort((a, b) => b.sortKey - a.sortKey)
    .slice(0, 10);

  if (activities.length === 0) {
    container.innerHTML = `<p class="empty-msg">Nenhuma atividade ainda.</p>`;
    return;
  }

  container.innerHTML = activities.map(a => `
    <div class="activity-item activity-item--${a.type}">
      <div class="activity-item__icon">
        ${a.type === "payment" ? icon("banknote") : a.type === "trip-paid" ? icon("check") : icon("clock")}
      </div>
      <div class="activity-item__info">
        <span class="activity-item__label">${a.label}</span>
        ${a.sub ? `<span class="activity-item__sub">${a.sub}</span>` : ""}
      </div>
      <span class="activity-item__amount ${a.type === "trip-unpaid" ? "text-debt" : "text-paid"}">
        ${formatCurrency(a.amount)}
      </span>
    </div>
  `).join("");
}