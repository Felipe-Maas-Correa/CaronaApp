// ============================================================
// MÓDULO: payments.js
// Registro e listagem de pagamentos com comprovantes
// ============================================================

import { registerPayment, deletePayment, getUserPayments, getUserUnpaidTrips, getTripValue } from "../js/db.js";
import { showToast, formatCurrency, formatDate, formatDateTime, icon, todayISO, escapeHtml, copyToClipboard, readFileAsDataURL, compressImageToDataURL } from "../js/utils.js";
import { loadAndRender } from "../calendar/calendar.js";
import { refreshSummary } from "../summary/summary.js";
import { currentProfile } from "../auth/auth.js";
import { PIX_KEY } from "../js/config.js";

let unpaidTrips   = [];
let unpaidDatesSet = new Set(); // datas com viagem em aberto
let selectedDates  = new Set();
let loadedPayments = [];        // cache dos pagamentos carregados (para abrir comprovante)
let amountByDate   = {};        // valor de cada viagem em aberto (respeita preços variados)

// Limite do comprovante em Base64. Documento do Firestore tem teto de 1 MB;
// deixamos folga para os demais campos.
const RECEIPT_MAX_CHARS = 700 * 1024; // ~700 KB

// Estado do calendário de pagamento
let payCalYear  = new Date().getFullYear();
let payCalMonth = new Date().getMonth() + 1;

// Estado do drag
let isDragging    = false;
let dragAction    = null; // "select" | "deselect"

const WEEKDAYS = ["Dom","Seg","Ter","Qua","Qui","Sex","Sáb"];
const MONTHS   = [
  "Janeiro","Fevereiro","Março","Abril","Maio","Junho",
  "Julho","Agosto","Setembro","Outubro","Novembro","Dezembro"
];

// ── INIT ─────────────────────────────────────────────────────

export async function initPayments() {
  await loadPaymentsList();
  bindNewPaymentModal();
}

// ── LISTA DE PAGAMENTOS ───────────────────────────────────────

export async function loadPaymentsList() {
  const container = document.getElementById("payments-list");
  container.innerHTML = `<div class="loading-spinner"></div>`;

  try {
    const payments = await getUserPayments(currentProfile.uid);
    loadedPayments = payments; // cache p/ abrir o comprovante sem recarregar

    if (payments.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">${icon("wallet")}</div>
          <p>Nenhum pagamento registrado ainda.</p>
        </div>`;
      return;
    }

    container.innerHTML = payments.map(p => renderPaymentCard(p)).join("");

    container.querySelectorAll("[data-view-receipt-id]").forEach(btn => {
      btn.addEventListener("click", () => openReceiptModalById(btn.dataset.viewReceiptId));
    });
    container.querySelectorAll("[data-delete-payment]").forEach(btn => {
      btn.addEventListener("click", () => confirmDeletePayment(btn.dataset.deletePayment));
    });

  } catch (e) {
    container.innerHTML = `<p class="error-msg">Erro ao carregar pagamentos.</p>`;
  }
}

function renderPaymentCard(payment) {
  const datesList = payment.tripDates
    .slice(0, 4)
    .map(d => `<span class="date-chip">${formatDate(d, "short")}</span>`)
    .join("");
  const moreCount = payment.tripDates.length - 4;

  return `
    <div class="payment-card" data-id="${payment.id}">
      <div class="payment-card__header">
        <div>
          <div class="payment-card__amount">${formatCurrency(payment.totalAmount)}</div>
          <div class="payment-card__meta">${payment.tripDates.length} viagem(ns) • ${formatDateTime(payment.createdAt)}</div>
        </div>
        <div class="payment-card__actions">
          ${(payment.receiptData || payment.receiptUrl)
            ? `<button class="btn-icon btn-icon--receipt" data-view-receipt-id="${payment.id}" title="Ver comprovante">${icon("fileText")}</button>`
            : `<span class="no-receipt" title="Sem comprovante">${icon("file")}</span>`
          }
          <button class="btn-icon btn-icon--delete" data-delete-payment="${payment.id}" title="Excluir pagamento">${icon("trash")}</button>
        </div>
      </div>
      <div class="payment-card__dates">
        ${datesList}
        ${moreCount > 0 ? `<span class="date-chip date-chip--more">+${moreCount}</span>` : ""}
      </div>
    </div>
  `;
}

// ── BIND MODAL ────────────────────────────────────────────────

function bindNewPaymentModal() {
  document.getElementById("btn-new-payment").addEventListener("click", openNewPaymentModal);

  document.getElementById("btn-close-payment-modal").addEventListener("click", () => {
    document.getElementById("modal-payment").classList.remove("modal--open");
  });

  document.getElementById("btn-confirm-payment").addEventListener("click", handleConfirmPayment);
  document.getElementById("receipt-input").addEventListener("change", handleReceiptPreview);

  // Preenche a chave PIX (vem do config, fora do versionamento)
  const pixKeyEl = document.getElementById("pix-key");
  if (pixKeyEl) pixKeyEl.textContent = PIX_KEY;

  // Copiar chave PIX
  document.getElementById("btn-copy-pix")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-copy-pix");
    const ok  = await copyToClipboard(PIX_KEY);
    if (ok) {
      const original = btn.textContent;
      btn.textContent = "Copiado!";
      btn.classList.add("pix-copy-btn--done");
      showToast("Chave PIX copiada!", "success");
      setTimeout(() => {
        btn.textContent = original;
        btn.classList.remove("pix-copy-btn--done");
      }, 2000);
    } else {
      showToast("Não foi possível copiar. Copie manualmente.", "error");
    }
  });

  // Navegação do calendário de pagamento
  document.getElementById("pay-cal-prev").addEventListener("click", () => {
    payCalMonth--;
    if (payCalMonth < 1) { payCalMonth = 12; payCalYear--; }
    renderPaymentCalendar();
  });
  document.getElementById("pay-cal-next").addEventListener("click", () => {
    payCalMonth++;
    if (payCalMonth > 12) { payCalMonth = 1; payCalYear++; }
    renderPaymentCalendar();
  });

  // Selecionar todas do mês visível
  document.getElementById("btn-select-all-trips").addEventListener("click", () => {
    const allVisible = [...unpaidDatesSet].filter(d => {
      const [y, m] = d.split("-").map(Number);
      return y === payCalYear && m === payCalMonth;
    });
    const allSelected = allVisible.every(d => selectedDates.has(d));
    allVisible.forEach(d => {
      if (allSelected) selectedDates.delete(d);
      else selectedDates.add(d);
    });
    renderPaymentCalendar();
    updatePaymentTotal();
  });
}

// ── ABRIR MODAL ───────────────────────────────────────────────

async function openNewPaymentModal() {
  unpaidTrips    = await getUserUnpaidTrips(currentProfile.uid);
  selectedDates  = new Set();
  unpaidDatesSet = new Set(unpaidTrips.map(t => t.date));
  amountByDate   = {};
  unpaidTrips.forEach(t => { amountByDate[t.date] = t.amount ?? getTripValue(); });

  // Navega para o mês mais antigo com viagem em aberto
  if (unpaidTrips.length > 0) {
    const [y, m] = unpaidTrips[0].date.split("-").map(Number);
    payCalYear  = y;
    payCalMonth = m;
  } else {
    payCalYear  = new Date().getFullYear();
    payCalMonth = new Date().getMonth() + 1;
  }

  renderPaymentCalendar();
  updatePaymentTotal();
  clearReceiptPreview();
  document.getElementById("modal-payment").classList.add("modal--open");
}

// ── CALENDÁRIO DE PAGAMENTO ───────────────────────────────────

function renderPaymentCalendar() {
  const label = document.getElementById("pay-cal-label");
  const grid  = document.getElementById("pay-cal-grid");

  label.textContent = `${MONTHS[payCalMonth - 1]} ${payCalYear}`;
  grid.innerHTML = "";

  // Cabeçalho dias da semana
  WEEKDAYS.forEach(d => {
    const el = document.createElement("div");
    el.className = "pcal-weekday";
    el.textContent = d;
    grid.appendChild(el);
  });

  const firstDay  = new Date(payCalYear, payCalMonth - 1, 1).getDay();
  const totalDays = new Date(payCalYear, payCalMonth, 0).getDate();
  const today     = todayISO();

  // Células vazias
  for (let i = 0; i < firstDay; i++) {
    const el = document.createElement("div");
    el.className = "pcal-day pcal-day--empty";
    grid.appendChild(el);
  }

  // Dias
  for (let d = 1; d <= totalDays; d++) {
    const dateStr   = `${payCalYear}-${String(payCalMonth).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
    const hasTrip   = unpaidDatesSet.has(dateStr);
    const isSelected = selectedDates.has(dateStr);
    const isToday   = dateStr === today;
    const dow       = new Date(payCalYear, payCalMonth - 1, d).getDay();
    const isWeekend = dow === 0 || dow === 6;

    const el = document.createElement("div");
    el.className = "pcal-day";
    el.dataset.date = dateStr;

    if (isToday)    el.classList.add("pcal-day--today");
    if (isWeekend)  el.classList.add("pcal-day--weekend");
    if (!hasTrip)   el.classList.add("pcal-day--disabled");
    if (hasTrip && isSelected)  el.classList.add("pcal-day--selected");
    if (hasTrip && !isSelected) el.classList.add("pcal-day--unpaid");

    el.innerHTML = `
      <span class="pcal-day__num">${d}</span>
      ${hasTrip ? `<span class="pcal-day__dot"></span>` : ""}
    `;

    if (hasTrip) {
      // Touch events para drag
      el.addEventListener("pointerdown", (e) => {
        e.preventDefault();
        isDragging = true;
        dragAction = selectedDates.has(dateStr) ? "deselect" : "select";
        toggleDate(dateStr);
        el.setPointerCapture(e.pointerId);
      });

      el.addEventListener("pointermove", (e) => {
        if (!isDragging) return;
        // FIX: elementFromPoint pode retornar filho (.pcal-day__num, .pcal-day__dot)
        // em vez do .pcal-day em si — usamos closest para subir até o container correto.
        // Também precisamos soltar o pointer capture temporariamente para detectar
        // outros elementos sob o dedo.
        el.releasePointerCapture(e.pointerId);
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        el.setPointerCapture(e.pointerId);

        const dayEl = hit?.closest(".pcal-day[data-date]");
        if (!dayEl) return;

        const d2 = dayEl.dataset.date;
        if (!unpaidDatesSet.has(d2)) return;

        if (dragAction === "select" && !selectedDates.has(d2)) {
          selectedDates.add(d2);
          dayEl.classList.add("pcal-day--selected");
          dayEl.classList.remove("pcal-day--unpaid");
          updatePaymentTotal();
        } else if (dragAction === "deselect" && selectedDates.has(d2)) {
          selectedDates.delete(d2);
          dayEl.classList.remove("pcal-day--selected");
          dayEl.classList.add("pcal-day--unpaid");
          updatePaymentTotal();
        }
      });

      el.addEventListener("pointerup", () => {
        isDragging = false;
        dragAction = null;
      });

      el.addEventListener("pointercancel", () => {
        isDragging = false;
        dragAction = null;
      });
    }

    grid.appendChild(el);
  }

  // Atualiza label do botão "Todas"
  const allVisible = [...unpaidDatesSet].filter(d => {
    const [y, m] = d.split("-").map(Number);
    return y === payCalYear && m === payCalMonth;
  });
  const btnAll = document.getElementById("btn-select-all-trips");
  const allSelected = allVisible.length > 0 && allVisible.every(d => selectedDates.has(d));
  btnAll.textContent = allSelected ? "Limpar" : "Todas";
  btnAll.disabled = allVisible.length === 0;
}

function toggleDate(dateStr) {
  if (selectedDates.has(dateStr)) {
    selectedDates.delete(dateStr);
  } else {
    selectedDates.add(dateStr);
  }
  // FIX: garante que ambas as classes sejam aplicadas/removidas corretamente
  // sem depender do estado anterior do elemento.
  const el = document.querySelector(`.pcal-day[data-date="${dateStr}"]`);
  if (el) {
    const isNowSelected = selectedDates.has(dateStr);
    el.classList.remove("pcal-day--selected", "pcal-day--unpaid");
    el.classList.add(isNowSelected ? "pcal-day--selected" : "pcal-day--unpaid");
  }
  updatePaymentTotal();
}

// ── TOTAL ─────────────────────────────────────────────────────

function sumSelected() {
  return [...selectedDates].reduce((s, d) => s + (amountByDate[d] ?? getTripValue()), 0);
}

function updatePaymentTotal() {
  document.getElementById("payment-selected-total").textContent =
    `${selectedDates.size} viagem(ns) • ${formatCurrency(sumSelected())}`;
  document.getElementById("btn-confirm-payment").disabled = selectedDates.size === 0;
}

// ── COMPROVANTE ───────────────────────────────────────────────

function handleReceiptPreview(e) {
  const file    = e.target.files[0];
  const preview = document.getElementById("receipt-preview");
  if (!file) { clearReceiptPreview(); return; }
  if (file.type.startsWith("image/")) {
    const url = URL.createObjectURL(file);
    preview.innerHTML = `<img src="${url}" alt="Comprovante" class="receipt-thumb">`;
  } else {
    preview.innerHTML = `<div class="receipt-file-icon">${icon("fileText")} ${escapeHtml(file.name)}</div>`;
  }
}

function clearReceiptPreview() {
  document.getElementById("receipt-preview").innerHTML = "";
  document.getElementById("receipt-input").value = "";
}

// ── CONVERSÃO PARA BASE64 (sem Firebase Storage) ──────────────

/**
 * Prepara o comprovante para salvar: imagens são comprimidas; PDFs (ou
 * outros) vão direto. Lança erro amigável se passar do limite.
 * @returns {Promise<string|null>} data URL (Base64) ou null
 */
async function prepareReceipt(file) {
  if (!file) return null;

  if (file.type.startsWith("image/")) {
    const data = await compressImageToDataURL(file, 1200, RECEIPT_MAX_CHARS);
    if (data.length > RECEIPT_MAX_CHARS) {
      throw new Error("A imagem ficou grande demais mesmo após compressão. Tente uma foto menor.");
    }
    return data;
  }

  // PDF ou outro tipo: não dá para comprimir aqui
  const data = await readFileAsDataURL(file);
  if (data.length > RECEIPT_MAX_CHARS) {
    throw new Error("Arquivo muito grande (máx. ~700 KB). Envie uma imagem ou um PDF menor.");
  }
  return data;
}

// ── CONFIRMAR ─────────────────────────────────────────────────

async function handleConfirmPayment() {
  if (selectedDates.size === 0) return;

  const btn  = document.getElementById("btn-confirm-payment");
  const file = document.getElementById("receipt-input").files[0] || null;

  btn.disabled    = true;
  btn.textContent = "Salvando...";

  try {
    const receiptData = await prepareReceipt(file);
    const total = sumSelected();
    await registerPayment(currentProfile.uid, currentProfile.name, [...selectedDates], total, receiptData);
    document.getElementById("modal-payment").classList.remove("modal--open");
    showToast(`Pagamento de ${formatCurrency(total)} registrado!`, "success");
    await loadPaymentsList();
    await loadAndRender();
    await refreshSummary();
  } catch (e) {
    showToast("Erro ao registrar pagamento: " + e.message, "error");
    console.error(e);
  } finally {
    btn.disabled    = false;
    btn.textContent = "Confirmar Pagamento";
  }
}

// ── VER COMPROVANTE ───────────────────────────────────────────

function openReceiptModalById(paymentId) {
  const payment = loadedPayments.find(p => p.id === paymentId);
  if (!payment) return;

  // receiptData = Base64 (novo). receiptUrl = pagamentos antigos do Storage.
  const src = payment.receiptData || payment.receiptUrl;
  if (!src) return;

  // Detecta se é imagem: por data URL (data:image/...) ou por extensão.
  const isImage = src.startsWith("data:image/") || /\.(jpg|jpeg|png|gif|webp)/i.test(src);

  const modal   = document.getElementById("modal-receipt");
  const content = document.getElementById("receipt-modal-content");
  content.innerHTML = isImage
    ? `<img src="${src}" alt="Comprovante" class="receipt-full-img">`
    : `<iframe src="${src}" class="receipt-iframe" title="Comprovante"></iframe>`;

  modal.classList.add("modal--open");

  // "Abrir em nova aba": navegadores bloqueiam abrir data: URL no topo,
  // então convertemos Base64 para um blob URL temporário.
  const openBtn = document.getElementById("btn-open-receipt");
  const openHref = src.startsWith("data:") ? dataURLToBlobURL(src) : src;
  openBtn.href = openHref;

  document.getElementById("btn-close-receipt-modal").onclick = () => {
    modal.classList.remove("modal--open");
    if (openHref.startsWith("blob:")) URL.revokeObjectURL(openHref);
  };
}

// Converte uma data URL (Base64) em um blob URL temporário
function dataURLToBlobURL(dataUrl) {
  const [meta, b64] = dataUrl.split(",");
  const mime = (meta.match(/data:(.*?);base64/) || [])[1] || "application/octet-stream";
  const bin  = atob(b64);
  const arr  = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([arr], { type: mime }));
}

// ── EXCLUIR ───────────────────────────────────────────────────

function confirmDeletePayment(paymentId) {
  const modal  = document.getElementById("modal-confirm");
  const msg    = document.getElementById("confirm-message");
  const btnYes = document.getElementById("btn-confirm-yes");
  const btnNo  = document.getElementById("btn-confirm-no");

  msg.textContent = "Excluir este pagamento irá desmarcar as viagens associadas. Deseja continuar?";
  modal.classList.add("modal--open");

  btnYes.onclick =  async () => {
    modal.classList.remove("modal--open");
    try {
      await deletePayment(paymentId);
      showToast("Pagamento excluído", "info");
      await loadPaymentsList();
      await loadAndRender();
      await refreshSummary();
    } catch (e) {
      showToast("Erro ao excluir pagamento", "error");
    }
  };
  btnNo.onclick = () => modal.classList.remove("modal--open");
}