// ============================================================
// MÓDULO: payments.js
// Registro e listagem de pagamentos com comprovantes
// ============================================================

import { getUserPayments, getGroupPayments, getGroupUsers, getUserUnpaidTrips, getTripValue, toMillis } from "../js/db.js";
import { createPayment, deletePayment, approvePayment, rejectPayment } from "../js/worker-api.js";
import { showToast, formatCurrency, formatDate, formatDateTime, icon, todayISO, escapeHtml, safeImageSrc, safeReceiptSrc, copyToClipboard, readFileAsDataURL } from "../js/utils.js";
import { readPdfReceipt, valuesMatch } from "../js/receipt-parser.js";
import { loadAndRender } from "../calendar/calendar.js";
import { refreshSummary } from "../summary/summary.js";
import { currentProfile, isAdmin, myGroupId } from "../auth/auth.js";
import { groupPixKey } from "../groups/groups.js";
import { PIX_KEY } from "../js/config.js";

let unpaidTrips   = [];
let unpaidDatesSet = new Set(); // datas com viagem em aberto
let selectedDates  = new Set();
let loadedPayments = [];        // cache dos pagamentos carregados (para abrir comprovante)
let amountByDate   = {};        // valor de cada viagem em aberto (respeita preços variados)

// Estado da validação do comprovante (PDF) do pagamento em andamento
let receiptState = {
  file:   null,   // File selecionado
  data:   null,   // Base64 (data URL) já preparado para salvar
  value:  null,   // valor detectado no PDF (número) ou null
  status: "empty" // "empty" | "reading" | "ok" | "error"
};

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

  // Quem administra o grupo vê os pagamentos de TODO o grupo (é ele que
  // confere os comprovantes); o passageiro vê só os dele, no grupo ativo.
  const admin = isAdmin();
  const gid   = myGroupId();

  try {
    let usersByUid = {};
    let payments;
    if (admin) {
      const [pays, users] = await Promise.all([getGroupPayments(gid), getGroupUsers(gid)]);
      payments = pays.sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
      users.forEach(u => { usersByUid[u.uid] = u; });
    } else {
      payments = (await getUserPayments(currentProfile.uid))
        .filter(p => !gid || !p.groupId || p.groupId === gid);
    }
    loadedPayments = payments; // cache p/ abrir o comprovante sem recarregar

    if (payments.length === 0) {
      container.innerHTML = `
        <div class="empty-state">
          <div class="empty-state__icon">${icon("wallet")}</div>
          <p>Nenhum pagamento registrado ainda.</p>
        </div>`;
      return;
    }

    container.innerHTML = payments.map(p => renderPaymentCard(p, admin, usersByUid[p.uid])).join("");

    container.querySelectorAll("[data-view-receipt-id]").forEach(btn => {
      btn.addEventListener("click", () => openReceiptModalById(btn.dataset.viewReceiptId));
    });
    container.querySelectorAll("[data-delete-payment]").forEach(btn => {
      btn.addEventListener("click", () => confirmDeletePayment(btn.dataset.deletePayment));
    });
    container.querySelectorAll("[data-approve-payment]").forEach(btn => {
      btn.addEventListener("click", () => reviewPayment(btn.dataset.approvePayment, "approve"));
    });
    container.querySelectorAll("[data-reject-payment]").forEach(btn => {
      btn.addEventListener("click", () => reviewPayment(btn.dataset.rejectPayment, "reject"));
    });

  } catch (e) {
    container.innerHTML = `<p class="error-msg">Erro ao carregar pagamentos.</p>`;
  }
}

// Metadados de cada status. `status` ausente = pagamento antigo (legado),
// já quitado antes do fluxo de aprovação — tratado como "aprovado".
const STATUS_META = {
  pending:  { label: "Em análise", cls: "payment-card__status--pending", ic: "clock" },
  approved: { label: "Aprovado",   cls: "payment-card__status--approved", ic: "check" },
  rejected: { label: "Rejeitado",  cls: "payment-card__status--rejected", ic: "alert" },
};

function renderPaymentCard(payment, showUser = false, profile = null) {
  const datesList = payment.tripDates
    .slice(0, 4)
    .map(d => `<span class="date-chip">${formatDate(d, "short")}</span>`)
    .join("");
  const moreCount = payment.tripDates.length - 4;

  const name  = profile?.name || payment.userName || "—";
  const photo = profile?.photo;

  // payment.id vai para atributos HTML — escapa (é gerado no cliente, mas
  // manter o escape evita que um id manipulado quebre o atributo).
  const pid = escapeHtml(payment.id);

  const status = payment.status || "approved";
  const meta   = STATUS_META[status] || STATUS_META.approved;
  // Quem confere o comprovante é quem recebe o PIX: o dono do grupo (o ADM
  // SUPREMO também, como suporte). E só enquanto está pendente.
  const canReview = isAdmin();

  const adminActions = (canReview && status === "pending") ? `
    <div class="payment-card__review">
      <button class="btn-review btn-review--approve" data-approve-payment="${pid}">Aprovar</button>
      <button class="btn-review btn-review--reject"  data-reject-payment="${pid}">Rejeitar</button>
    </div>` : "";

  return `
    <div class="payment-card payment-card--${status}" data-id="${pid}">
      <div class="payment-card__header">
        <div>
          ${showUser ? `
            <div class="payment-card__user">
              <span class="payment-card__avatar" style="background:${avatarColor(name)}">${avatarInner(name, photo)}</span>
              <span>${escapeHtml(name)}</span>
            </div>` : ""}
          <div class="payment-card__amount">${formatCurrency(payment.totalAmount)}</div>
          <div class="payment-card__meta">${payment.tripDates.length} viagem(ns) • ${formatDateTime(payment.createdAt)}</div>
          <span class="payment-card__status ${meta.cls}">${icon(meta.ic)} ${meta.label}</span>
        </div>
        <div class="payment-card__actions">
          ${(payment.receiptData || payment.receiptUrl)
            ? `<button class="btn-icon btn-icon--receipt" data-view-receipt-id="${pid}" title="Ver comprovante">${icon("fileText")}</button>`
            : `<span class="no-receipt" title="Sem comprovante">${icon("file")}</span>`
          }
          <button class="btn-icon btn-icon--delete" data-delete-payment="${pid}" title="Excluir pagamento">${icon("trash")}</button>
        </div>
      </div>
      <div class="payment-card__dates">
        ${datesList}
        ${moreCount > 0 ? `<span class="date-chip date-chip--more">+${moreCount}</span>` : ""}
      </div>
      ${adminActions}
    </div>
  `;
}

// ── AVATAR (foto do usuário ou inicial) ───────────────────────

function avatarInner(name, photo) {
  const safe = safeImageSrc(photo);
  if (safe) return `<img src="${safe}" alt="" class="avatar-img">`;
  return escapeHtml((name || "?").charAt(0).toUpperCase());
}

function avatarColor(name = "") {
  const colors = ["#00e676","#ff6b6b","#ffd60a","#74b9ff","#a29bfe","#fd79a8","#00cec9"];
  const code = name && name.length ? name.charCodeAt(0) : "?".charCodeAt(0);
  return colors[code % colors.length] + "33";
}

// ── CHAVE PIX ─────────────────────────────────────────────────
//
// A chave é de QUEM RECEBE — ou seja, do dono do grupo, e por isso mora no
// documento do grupo. A do config.js fica como reserva para instalações que
// vinham de antes dos grupos e ainda não cadastraram a do grupo.
function activePixKey() {
  return groupPixKey() || PIX_KEY || "";
}

// ── BIND MODAL ────────────────────────────────────────────────

function bindNewPaymentModal() {
  document.getElementById("btn-new-payment").addEventListener("click", openNewPaymentModal);

  document.getElementById("btn-close-payment-modal").addEventListener("click", () => {
    document.getElementById("modal-payment").classList.remove("modal--open");
  });

  document.getElementById("btn-confirm-payment").addEventListener("click", handleConfirmPayment);
  document.getElementById("receipt-input").addEventListener("change", handleReceiptPreview);

  // Copiar chave PIX
  document.getElementById("btn-copy-pix")?.addEventListener("click", async () => {
    const btn = document.getElementById("btn-copy-pix");
    const ok  = await copyToClipboard(activePixKey());
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

  // A chave é preenchida na ABERTURA, não no bind: ela muda quando o
  // usuário troca de grupo, e o bind acontece uma vez só.
  const pixKeyEl = document.getElementById("pix-key");
  if (pixKeyEl) {
    const key = activePixKey();
    pixKeyEl.textContent = key || "o dono do grupo ainda não cadastrou a chave";
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
  // O total mudou → revalida o comprovante contra o novo valor.
  refreshReceiptCheck();
}

// Habilita o botão só quando há viagens E o comprovante confere.
function updateConfirmState() {
  const total = sumSelected();
  const matches = receiptState.status === "ok" && valuesMatch(receiptState.value, total);
  document.getElementById("btn-confirm-payment").disabled =
    selectedDates.size === 0 || !matches;
}

// ── COMPROVANTE ───────────────────────────────────────────────

// Só aceitamos PDF: é o único formato do qual conseguimos LER o valor e
// conferir automaticamente contra o total selecionado.
async function handleReceiptPreview(e) {
  const file = e.target.files[0];
  if (!file) { clearReceiptPreview(); return; }

  const isPdf = file.type === "application/pdf" || /\.pdf$/i.test(file.name);
  if (!isPdf) {
    resetReceiptState("error");
    document.getElementById("receipt-preview").innerHTML = "";
    showReceiptCheck("error", "Envie o comprovante em PDF. Fotos/imagens não podem ser conferidas automaticamente.");
    showToast("O comprovante precisa ser um PDF.", "error");
    return;
  }

  // Mostra o arquivo e o estado "lendo..."
  document.getElementById("receipt-preview").innerHTML =
    `<div class="receipt-file-icon">${icon("fileText")} ${escapeHtml(file.name)}</div>`;
  receiptState = { file, data: null, value: null, status: "reading" };
  showReceiptCheck("reading", "Lendo o comprovante…");
  updateConfirmState();

  try {
    // Prepara o Base64 (para salvar) e lê o valor em paralelo.
    const [data, parsed] = await Promise.all([
      readFileAsDataURL(file),
      readPdfReceipt(file)
    ]);

    if (data.length > RECEIPT_MAX_CHARS) {
      resetReceiptState("error");
      showReceiptCheck("error", "Arquivo muito grande (máx. ~700 KB). Envie um PDF menor.");
      return;
    }
    if (parsed.value == null) {
      resetReceiptState("error");
      showReceiptCheck("error", "Não consegui identificar o valor neste PDF. Confira se é o comprovante correto.");
      return;
    }

    receiptState = { file, data, value: parsed.value, status: "ok" };
    refreshReceiptCheck();
  } catch (err) {
    console.error("Erro ao ler o comprovante:", err);
    resetReceiptState("error");
    showReceiptCheck("error", "Não foi possível ler o PDF. Tente outro arquivo.");
  }
}

// Reavalia o comprovante contra o total atual e ajusta a UI + botão.
function refreshReceiptCheck() {
  if (receiptState.status !== "ok") { updateConfirmState(); return; }

  const total = sumSelected();
  if (valuesMatch(receiptState.value, total)) {
    showReceiptCheck("ok", `Comprovante confere: ${formatCurrency(receiptState.value)}.`);
  } else {
    showReceiptCheck("mismatch",
      `Valor do comprovante (${formatCurrency(receiptState.value)}) diferente do total selecionado (${formatCurrency(total)}). ` +
      `Ajuste as viagens ou envie o comprovante correto.`);
  }
  updateConfirmState();
}

// Renderiza a faixa de status abaixo do comprovante.
function showReceiptCheck(kind, message) {
  const el = document.getElementById("receipt-check");
  if (!el) return;
  el.hidden = false;
  el.className = `receipt-check receipt-check--${kind}`;
  const ic = kind === "ok" ? "check" : kind === "reading" ? "clock" : "alert";
  el.innerHTML = `${icon(ic)} <span>${escapeHtml(message)}</span>`;
}

function resetReceiptState(status = "empty") {
  receiptState = { file: null, data: null, value: null, status };
}

function clearReceiptPreview() {
  document.getElementById("receipt-preview").innerHTML = "";
  document.getElementById("receipt-input").value = "";
  const check = document.getElementById("receipt-check");
  if (check) { check.hidden = true; check.innerHTML = ""; }
  resetReceiptState("empty");
}

// ── CONFIRMAR ─────────────────────────────────────────────────

async function handleConfirmPayment() {
  if (selectedDates.size === 0) return;

  const total = sumSelected();

  // Trava de segurança: só finaliza se o comprovante (PDF) conferir com o total.
  if (receiptState.status !== "ok" || !valuesMatch(receiptState.value, total)) {
    showToast("Envie um comprovante em PDF cujo valor bata com o total selecionado.", "error");
    refreshReceiptCheck();
    return;
  }

  const btn = document.getElementById("btn-confirm-payment");
  btn.disabled    = true;
  btn.textContent = "Salvando...";

  try {
    // O Worker recalcula o total a partir das viagens reais — `total` daqui
    // é só para a UI. Se o cliente tentasse forjar, o servidor ignoraria.
    // O pagamento entra como PENDENTE: as viagens só são quitadas quando um
    // admin conferir o comprovante e aprovar (F-01).
    const r = await createPayment([...selectedDates], receiptState.data);
    document.getElementById("modal-payment").classList.remove("modal--open");
    showToast(`Comprovante de ${formatCurrency(r.total)} enviado para aprovação.`, "success");
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
  const raw = payment.receiptData || payment.receiptUrl;
  if (!raw) return;

  // Só aceita data URL de imagem ou PDF. Bloqueia XSS: sem isto, um
  // receiptData como  data:image/png;base64,x" onerror="..."  executava
  // script, e um receiptUrl "javascript:..." rodaria ao clicar em abrir.
  const src = safeReceiptSrc(raw);
  if (!src) {
    showToast("Comprovante em formato inválido.", "error");
    return;
  }

  const isImage = src.startsWith("data:image/");

  const modal   = document.getElementById("modal-receipt");
  const content = document.getElementById("receipt-modal-content");
  // F-05: `sandbox` (sem allow-scripts) impede que JavaScript embutido no PDF
  // rode ao abrir o comprovante. O visualizador nativo do navegador ainda
  // renderiza o PDF; só o script do documento fica neutralizado. Defesa a mais
  // além da CSP (object-src 'none', frame-src restrito) e do safeReceiptSrc.
  content.innerHTML = isImage
    ? `<img src="${src}" alt="Comprovante" class="receipt-full-img">`
    : `<iframe src="${src}" class="receipt-iframe" title="Comprovante" sandbox></iframe>`;

  modal.classList.add("modal--open");

  // "Abrir em nova aba": navegadores bloqueiam abrir data: URL no topo,
  // então convertemos Base64 para um blob URL temporário. src já é seguro.
  const openBtn = document.getElementById("btn-open-receipt");
  const openHref = dataURLToBlobURL(src);
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

// ── APROVAR / REJEITAR (admin) ────────────────────────────────
// É aqui que o F-01 se fecha: o admin confere o comprovante × valor e só
// então o pagamento quita a dívida (aprovar marca as viagens como pagas).
// Rejeitar reabre as viagens em análise.

function reviewPayment(paymentId, action) {
  const modal  = document.getElementById("modal-confirm");
  const msg    = document.getElementById("confirm-message");
  const btnYes = document.getElementById("btn-confirm-yes");
  const btnNo  = document.getElementById("btn-confirm-no");

  const isApprove = action === "approve";
  msg.textContent = isApprove
    ? "Confirme que o comprovante confere com o valor devido. As viagens serão marcadas como pagas."
    : "Rejeitar este comprovante? As viagens voltam a ficar em aberto.";
  modal.classList.add("modal--open");

  btnYes.onclick = async () => {
    modal.classList.remove("modal--open");
    btnYes.disabled = true;
    try {
      if (isApprove) {
        await approvePayment(paymentId);
        showToast("Pagamento aprovado.", "success");
      } else {
        await rejectPayment(paymentId);
        showToast("Pagamento rejeitado.", "info");
      }
      await loadPaymentsList();
      await loadAndRender();
      await refreshSummary();
    } catch (e) {
      showToast((isApprove ? "Erro ao aprovar: " : "Erro ao rejeitar: ") + e.message, "error");
      console.error(e);
    } finally {
      btnYes.disabled = false;
    }
  };
  btnNo.onclick = () => modal.classList.remove("modal--open");
}