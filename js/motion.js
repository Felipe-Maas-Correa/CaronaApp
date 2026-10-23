// ============================================================
// js/motion.js — EVENTOS DE MOVIMENTO
//
// A parte do movimento que o CSS sozinho não faz. Tudo por delegação e
// observação do DOM: as telas não precisam chamar nada — basta usar os
// componentes do guia e, nos containers de lista, o atributo
// data-stagger. As animações em si estão em css/motion.css.
//
//   ripple ............ onda no ponto do toque em botões, linhas, abas
//   direção da aba .... a aba nova entra do lado para onde se navegou
//   data-stagger ...... itens de uma lista entram em cascata
//   segmentado ........ indicador desliza até a opção escolhida
//   número contando ... .stat__value e afins contam até o valor novo
//   erro .............. o formulário balança quando aparece um erro
//   vibração .......... toque curto no celular nas ações principais
//
// Com "reduzir movimento" ligado no sistema, nada disso roda.
// ============================================================

import { formatCurrency } from "./utils.js";

const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
const still = () => reduceMotion.matches;

const RIPPLE = ".btn, .btn-icon, .list-item, .nav-btn, .seg__btn, .hub-tile, .gcard";
const HAPTIC = ".btn--primary, .nav-btn, .seg__btn, .cal-day, .btn--danger";
const COUNTED = ".stat__value, .summary-hero__amount, .received-card__value, .stat-rate__num";
const ERRORS = ".auth-error, .error-msg";

// ── Onda do toque ─────────────────────────────────────────────
function initRipple() {
  document.addEventListener("pointerdown", (e) => {
    if (still() || e.button !== 0) return;
    const el = e.target.closest(RIPPLE);
    if (!el || el.disabled) return;
    const r = el.getBoundingClientRect();
    const size = Math.max(r.width, r.height) * 2;
    const dot = document.createElement("span");
    dot.className = "m-ripple";
    dot.style.width = dot.style.height = `${size}px`;
    dot.style.left = `${e.clientX - r.left - size / 2}px`;
    dot.style.top = `${e.clientY - r.top - size / 2}px`;
    dot.addEventListener("animationend", () => dot.remove(), { once: true });
    el.appendChild(dot);
  }, { passive: true });
}

// ── Vibração curta (celular) ──────────────────────────────────
function initHaptics() {
  if (!("vibrate" in navigator)) return;
  document.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch" || still()) return;
    const el = e.target.closest(HAPTIC);
    if (el && !el.disabled) navigator.vibrate(8);
  }, { passive: true });
}

// ── Direção da troca de aba ───────────────────────────────────
// Roda na fase de captura, ANTES do clique do app.js trocar a aba: aí
// ainda dá para saber qual era a aba ativa.
function initTabDirection() {
  document.addEventListener("click", (e) => {
    const btn = e.target.closest(".nav-btn");
    if (!btn) return;
    const btns = [...document.querySelectorAll(".nav-btn:not(.hidden)")];
    const from = btns.findIndex(b => b.classList.contains("nav-btn--active"));
    const to = btns.indexOf(btn);
    const panel = document.getElementById(btn.dataset.tab);
    if (!panel || from === to) return;
    panel.dataset.dir = to > from ? "next" : "prev";
  }, { capture: true });
}

// ── Lista em cascata (data-stagger) ───────────────────────────
//   data-stagger              → os filhos diretos entram em cascata
//   data-stagger=".list"      → os filhos do primeiro ".list" lá dentro
//   data-stagger-grid         → versão rápida para grades (calendário)
//   data-stagger-key="#id"    → só anima quando o texto de #id mudou
//                               (ex.: o mês do calendário), não a cada
//                               redesenho do mesmo mês
//
// A cascata só roda quando faz sentido, senão a tela "pisca":
//   • o conteúdo mudou de verdade (a tela redesenha o mesmo HTML a cada
//     vez que a aba abre — o Admin redesenha 4 blocos de uma vez);
//   • o container está visível (aba escondida não anima; a entrada da
//     própria aba já dá o movimento quando ela aparecer);
//   • e a marca .m-stagger sai ao terminar, para a cascata não voltar a
//     rodar sozinha quando a aba é escondida e mostrada de novo.
const MAX_STAGGER = 12;
const MAX_STAGGER_GRID = 42;
const STAGGER_MS = 45;       // = --stagger
const STAGGER_GRID_MS = 8;   // = atraso da grade em motion.css
const ENTER_MS = 380;        // = --dur-slow

function playStagger(box) {
  if (still()) return;
  if (box.dataset.staggerKey) {
    const key = document.querySelector(box.dataset.staggerKey)?.textContent || "";
    if (key === box._mKey) return;
    box._mKey = key;
  }
  const sig = box.innerHTML;
  if (sig === box._mSig) return;
  box._mSig = sig;
  if (!box.offsetParent && getComputedStyle(box).position !== "fixed") return;

  const host = box.dataset.stagger ? (box.querySelector(box.dataset.stagger) || box) : box;
  const grid = box.hasAttribute("data-stagger-grid");
  const max = grid ? MAX_STAGGER_GRID : MAX_STAGGER;
  const items = [...host.children].filter(c => !c.classList.contains("loading-spinner"));
  if (!items.length) return;
  if (grid) host.setAttribute("data-stagger-grid", "");
  clearTimeout(host._mDone);
  host.classList.remove("m-stagger");
  void host.offsetWidth; // reinicia a animação
  items.forEach((c, i) => c.style.setProperty("--i", Math.min(i, max)));
  host.classList.add("m-stagger");
  const total = Math.min(items.length, max) * (grid ? STAGGER_GRID_MS : STAGGER_MS) + ENTER_MS + 80;
  host._mDone = setTimeout(() => host.classList.remove("m-stagger"), total);
}

function initStagger() {
  const obs = new MutationObserver((records) => {
    const boxes = new Set(records.map(r => r.target.closest("[data-stagger]")).filter(Boolean));
    boxes.forEach(playStagger);
  });
  document.querySelectorAll("[data-stagger]").forEach(box => obs.observe(box, { childList: true }));
}

// ── Segmentado: indicador deslizante ──────────────────────────
// Só escreve no DOM o que mudou: classList.add() regrava o atributo mesmo
// quando a classe já existe, e o observador do segmentado (que escuta
// "class") entraria em laço infinito.
function placeIndicator(seg, instant = false) {
  const ind = seg.querySelector(":scope > .seg__ind");
  const active = seg.querySelector(".seg__btn--active");
  if (!ind || !active || !active.offsetWidth) return;
  const pos = `${active.offsetLeft}:${active.offsetWidth}`;
  if (ind._mPos === pos) return;
  ind._mPos = pos;
  if (ind.classList.contains("is-instant") !== instant) ind.classList.toggle("is-instant", instant);
  ind.style.width = `${active.offsetWidth}px`;
  ind.style.translate = `${active.offsetLeft}px 0`;
  if (!seg.classList.contains("has-ind")) seg.classList.add("has-ind");
}

function initSegments(root = document) {
  root.querySelectorAll(".seg").forEach(seg => {
    if (seg.querySelector(":scope > .seg__ind")) return;
    const ind = document.createElement("span");
    ind.className = "seg__ind";
    ind.setAttribute("aria-hidden", "true");
    seg.prepend(ind);
    // Troca de opção: desliza. Tamanho mudou (abriu a aba, girou a tela):
    // reposiciona sem animar.
    new MutationObserver(() => placeIndicator(seg, still()))
      .observe(seg, { subtree: true, attributes: true, attributeFilter: ["class"] });
    new ResizeObserver(() => placeIndicator(seg, true)).observe(seg);
    placeIndicator(seg, true);
  });
}

// ── Número contando ───────────────────────────────────────────
// Quando o JS da tela escreve um número novo num .stat__value (ou no
// valor do resumo), ele conta do valor anterior até o novo. O texto
// final é exatamente o que a tela escreveu.
function parseNumber(text) {
  const t = (text || "").trim();
  if (!/\d/.test(t)) return null;
  const money = t.includes("R$");
  const pct = t.endsWith("%");
  const n = Number(t.replace(/[^\d,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? { n, money, pct } : null;
}

function formatLike(n, { money, pct }) {
  if (money) return formatCurrency(n);
  return `${Math.round(n)}${pct ? "%" : ""}`;
}

function countTo(el, fromN, finalText) {
  const target = parseNumber(finalText);
  if (!target || fromN === target.n) return;
  cancelAnimationFrame(el._mRaf);
  const dur = 650;
  const start = performance.now();
  const ease = (x) => 1 - Math.pow(1 - x, 3);
  const write = (text) => { el._mWrite = text; el.textContent = text; };
  const step = (now) => {
    const p = Math.min(1, (now - start) / dur);
    write(p < 1 ? formatLike(fromN + (target.n - fromN) * ease(p), target) : finalText);
    if (p < 1) el._mRaf = requestAnimationFrame(step);
  };
  // O observador roda antes da pintura: voltar já ao valor de partida
  // evita um quadro mostrando o número final antes de contar.
  write(formatLike(fromN, target));
  el._mRaf = requestAnimationFrame(step);
  // Garantia: se o navegador pausar os quadros (aba em segundo plano),
  // o valor certo aparece mesmo assim. Número errado na tela, nunca.
  clearTimeout(el._mSafe);
  el._mSafe = setTimeout(() => {
    if (el.textContent !== finalText && el._mWrite !== finalText) {
      cancelAnimationFrame(el._mRaf);
      write(finalText);
    }
  }, dur + 250);
}

function initCountUp() {
  const last = new WeakMap();
  document.querySelectorAll(COUNTED).forEach(el => {
    const v = parseNumber(el.textContent);
    if (v) last.set(el, v.n);
  });
  new MutationObserver((records) => {
    const touched = new Set();
    for (const r of records) {
      const node = r.target.nodeType === 3 ? r.target.parentElement : r.target;
      const el = node?.closest?.(COUNTED);
      if (el) touched.add(el);
    }
    touched.forEach(el => {
      const text = el.textContent;
      if (text === el._mWrite) return; // fomos nós escrevendo um quadro
      const now = parseNumber(text);
      const before = last.get(el);
      if (now) last.set(el, now.n);
      if (!now || still()) return;
      countTo(el, before ?? 0, text);
    });
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}

// ── Erro: o formulário balança ────────────────────────────────
function shake(el) {
  if (!el || still()) return;
  el.classList.remove("m-shake");
  void el.offsetWidth;
  el.classList.add("m-shake");
  el.addEventListener("animationend", () => el.classList.remove("m-shake"), { once: true });
  if ("vibrate" in navigator) navigator.vibrate?.([12, 40, 12]);
}

function initErrorShake() {
  new MutationObserver((records) => {
    const seen = new Set();
    for (const r of records) {
      const node = r.target.nodeType === 3 ? r.target.parentElement : r.target;
      const err = node?.closest?.(ERRORS);
      if (!err || seen.has(err) || !err.textContent.trim()) continue;
      seen.add(err);
      shake(err.closest("form, .auth-form, .hub-sheet__panel, .modal-sheet") || err);
    }
  }).observe(document.body, { subtree: true, childList: true, characterData: true });
}

/** Liga todo o movimento do app. Chamado uma vez no boot. */
export function initMotion() {
  initRipple();
  initHaptics();
  initTabDirection();
  initStagger();
  initSegments();
  initCountUp();
  initErrorShake();
}

export { initSegments, playStagger, shake };
