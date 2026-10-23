// ============================================================
// MÓDULO: utils.js
// Funções utilitárias compartilhadas
// ============================================================

// ── ÍCONES ───────────────────────────────────────────────────
// O registro mora em icons.js (fonte única). Reexportado aqui para que os
// módulos que já importam `icon` de utils.js continuem funcionando.
export { icon, hydrateIcons } from "./icons.js";

// ── SEGURANÇA / TEXTO ─────────────────────────────────────────

/**
 * Escapa caracteres HTML para evitar injeção (XSS) ao inserir
 * texto vindo do usuário via innerHTML.
 */
export function escapeHtml(str = "") {
  return String(str).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[c]));
}

/**
 * Devolve `src` apenas se for uma data URL de IMAGEM legítima; caso
 * contrário devolve "". Fecha o XSS do campo `photo`: esse campo é editável
 * pelo próprio usuário e era interpolado cru em `<img src="...">`, então um
 * valor como  x" onerror="..."  executava script na sessão de quem abrisse
 * a lista (o admin, tipicamente).
 *
 * Aceita só o formato que o app realmente gera (compressImageToDataURL):
 * data:image/<tipo>;base64,<conteúdo>. Qualquer outra coisa vira "".
 */
export function safeImageSrc(src) {
  return /^data:image\/(png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+$/.test(src)
    ? src : "";
}

/**
 * Igual ao anterior, mas para o comprovante em PDF (data:application/pdf)
 * OU imagem — usado ao exibir comprovantes salvos.
 */
export function safeReceiptSrc(src) {
  return /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/.test(src)
    ? src : "";
}

/**
 * Copia um texto para a área de transferência.
 * Usa a Clipboard API e cai para um fallback quando indisponível
 * (contexto não seguro / navegadores antigos).
 * @returns {Promise<boolean>} true se copiou com sucesso
 */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* tenta o fallback abaixo */ }

  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity  = "0";
    document.body.appendChild(ta);
    ta.focus();
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// ── IMAGENS (Base64, sem Firebase Storage) ────────────────────

export function readFileAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result);
    reader.onerror = () => reject(new Error("Falha ao ler o arquivo."));
    reader.readAsDataURL(file);
  });
}

export function loadImageEl(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = () => reject(new Error("Imagem inválida."));
    img.src = src;
  });
}

/**
 * Redimensiona e comprime uma imagem para caber num documento do Firestore.
 * @param {File} file
 * @param {number} maxDim  maior lado em px
 * @param {number} maxChars tamanho máx. da data URL (aprox. bytes)
 * @param {boolean} square recorta em quadrado central (útil p/ foto de perfil)
 * @returns {Promise<string>} data URL JPEG
 */
export async function compressImageToDataURL(file, maxDim = 1200, maxChars = 700 * 1024, square = false) {
  const original = await readFileAsDataURL(file);
  const img = await loadImageEl(original);

  let sx = 0, sy = 0, sw = img.width, sh = img.height;
  if (square) {
    const side = Math.min(img.width, img.height);
    sx = (img.width - side) / 2;
    sy = (img.height - side) / 2;
    sw = sh = side;
  }

  let dw = sw, dh = sh;
  if (dw >= dh && dw > maxDim) { dh = Math.round(dh * maxDim / dw); dw = maxDim; }
  else if (dh > dw && dh > maxDim) { dw = Math.round(dw * maxDim / dh); dh = maxDim; }

  const canvas = document.createElement("canvas");
  canvas.width  = dw;
  canvas.height = dh;
  canvas.getContext("2d").drawImage(img, sx, sy, sw, sh, 0, 0, dw, dh);

  let quality = 0.72;
  let out = canvas.toDataURL("image/jpeg", quality);
  while (out.length > maxChars && quality > 0.3) {
    quality -= 0.1;
    out = canvas.toDataURL("image/jpeg", quality);
  }
  return out;
}

// ── FORMATAÇÃO ────────────────────────────────────────────────

/**
 * Data de hoje no formato "YYYY-MM-DD" usando o fuso LOCAL.
 * (Não usar toISOString(), que converte para UTC e erra o dia
 * perto da meia-noite no horário do Brasil.)
 */
export function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function formatCurrency(value) {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

/**
 * @param {string} dateStr - "YYYY-MM-DD"
 * @param {"full"|"short"} mode
 */
export function formatDate(dateStr, mode = "full") {
  if (!dateStr) return "—";
  const [year, month, day] = dateStr.split("-").map(Number);
  const date = new Date(year, month - 1, day);

  if (mode === "short") {
    return date.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit" });
  }
  return date.toLocaleDateString("pt-BR", {
    weekday: "long", day: "2-digit", month: "long", year: "numeric"
  });
}

export function formatDateTime(timestamp) {
  if (!timestamp) return "—";
  const date = timestamp?.toDate ? timestamp.toDate() : new Date(timestamp);
  return date.toLocaleDateString("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
    hour: "2-digit", minute: "2-digit"
  });
}

// ── TOAST ─────────────────────────────────────────────────────

let toastTimeout;

export function showToast(message, type = "info") {
  const toast = document.getElementById("toast");
  clearTimeout(toastTimeout);

  toast.textContent = message;
  toast.className   = `toast toast--${type} toast--visible`;

  toastTimeout = setTimeout(() => {
    toast.className = "toast";
  }, 3500);
}

// ── MODAL GLOBAL ──────────────────────────────────────────────

export function closeAllModals() {
  document.querySelectorAll(".modal--open").forEach(m => m.classList.remove("modal--open"));
}

// Fecha modal ao clicar no backdrop
document.addEventListener("click", (e) => {
  if (e.target.classList.contains("modal")) {
    e.target.classList.remove("modal--open");
  }
});