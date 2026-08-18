// ============================================================
// MÓDULO: summary.js
// Painel de resumo geral (dashboard)
// ============================================================

import { getUserTrips, getUserPayments } from "../js/db.js";
import { formatCurrency, formatDate, formatDateTime, icon } from "../js/utils.js";
import { currentProfile } from "../auth/auth.js";

// ── INIT ─────────────────────────────────────────────────────

export async function initSummary() {
  await refreshSummary();
}

export async function refreshSummary() {
  try {
    const [trips, payments] = await Promise.all([
      getUserTrips(currentProfile.uid),
      getUserPayments(currentProfile.uid)
    ]);
    renderSummaryCards(trips, payments);
    renderRecentActivity(trips, payments);
  } catch (e) {
    console.error("Erro no summary:", e);
  }
}

// ── CARDS ─────────────────────────────────────────────────────

function renderSummaryCards(trips, payments) {
  const totalTrips  = trips.length;
  const paidTrips   = trips.filter(t => t.paid).length;
  const unpaidTrips = totalTrips - paidTrips;
  const totalDebt   = trips.filter(t => !t.paid).reduce((s, t) => s + (t.amount ?? 15), 0);
  const totalPaid   = payments.reduce((s, p) => s + p.totalAmount, 0);

  document.getElementById("sum-total-trips").textContent    = totalTrips;
  document.getElementById("sum-paid-trips").textContent     = paidTrips;
  document.getElementById("sum-unpaid-trips").textContent   = unpaidTrips;
  document.getElementById("sum-total-debt").textContent     = formatCurrency(totalDebt);
  document.getElementById("sum-total-received").textContent = formatCurrency(totalPaid);
  document.getElementById("sum-total-payments").textContent = payments.length;

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