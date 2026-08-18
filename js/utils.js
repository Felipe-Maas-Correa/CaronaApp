// ============================================================
// MÓDULO: utils.js
// Funções utilitárias compartilhadas
// ============================================================

// ── ÍCONES (SVG estilo linha — Lucide) ────────────────────────
// Substituem os emojis coloridos por um conjunto monocromático,
// limpo e consistente. Cada ícone herda a cor via `currentColor`
// e o tamanho é definido no CSS (.lucide dentro de cada contexto).
const ICONS = {
  banknote:  '<rect width="20" height="12" x="2" y="6" rx="2"/><circle cx="12" cy="12" r="2"/><path d="M6 12h.01M18 12h.01"/>',
  check:     '<path d="M21.801 10A10 10 0 1 1 17 3.335"/><path d="m9 11 3 3L22 4"/>',
  clock:     '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  wallet:    '<path d="M19 7V4a1 1 0 0 0-1-1H5a2 2 0 0 0 0 4h15a1 1 0 0 1 1 1v4h-3a2 2 0 0 0 0 4h3a1 1 0 0 0 1-1v-2a1 1 0 0 0-1-1"/><path d="M3 5v14a2 2 0 0 0 2 2h15a1 1 0 0 0 1-1v-4"/>',
  users:     '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>',
  file:      '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/>',
  fileText:  '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 9H8"/><path d="M16 13H8"/><path d="M16 17H8"/>',
  trash:     '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
  car:       '<path d="M19 17h2c.6 0 1-.4 1-1v-3c0-.9-.7-1.7-1.5-1.9C18.7 10.6 16 10 16 10s-1.3-1.4-2.2-2.3c-.5-.4-1.1-.7-1.8-.7H5c-.6 0-1.1.4-1.4.9l-1.4 2.9A3.7 3.7 0 0 0 2 12v4c0 .6.4 1 1 1h2"/><circle cx="7" cy="17" r="2"/><path d="M9 17h6"/><circle cx="17" cy="17" r="2"/>',
  alert:     '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
  crown:     '<path d="m2 4 3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>',
  user:      '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  arrowUp:   '<path d="m5 12 7-7 7 7"/><path d="M12 19V5"/>',
  arrowDown: '<path d="M12 5v14"/><path d="m19 12-7 7-7-7"/>',
  lock:      '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  unlock:    '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 9.9-1"/>',
  eye:       '<path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff:    '<path d="M9.88 9.88a3 3 0 1 0 4.24 4.24"/><path d="M10.73 5.08A10.43 10.43 0 0 1 12 5c7 0 10 7 10 7a13.16 13.16 0 0 1-1.67 2.68"/><path d="M6.61 6.61A13.526 13.526 0 0 0 2 12s3 7 10 7a9.74 9.74 0 0 0 5.39-1.61"/><line x1="2" x2="22" y1="2" y2="22"/>',
  copy:      '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
};

/**
 * Retorna o markup SVG de um ícone (estilo linha, monocromático).
 * @param {keyof ICONS} name  nome do ícone
 * @param {string} cls        classe extra opcional
 */
export function icon(name, cls = "") {
  const path = ICONS[name] || "";
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" class="lucide${cls ? " " + cls : ""}">${path}</svg>`;
}

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