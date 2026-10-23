// ============================================================
// js/ui.js — GUIA DE ESTILO: COMPONENTES EM JS
//
// Montadores de HTML dos componentes de css/components.css que se
// repetem nos templates. Template novo usa estes em vez de escrever o
// markup na mão (e de copiar avatarInner/avatarColor de outra tela).
// Catálogo visual: guia/index.html. Regras: DESIGN-SYSTEM.md.
// ============================================================

import { icon } from "./icons.js";
import { escapeHtml, safeImageSrc } from "./utils.js";

// Cores de fundo do avatar sem foto: a primeira letra do nome escolhe
// uma; o "33" no fim é a transparência (20%), para a inicial aparecer.
const AVATAR_TINTS = ["#00e676", "#ff6b6b", "#ffd60a", "#74b9ff", "#a29bfe", "#fd79a8", "#00cec9"]; // ui-audit: allow

/** Cor de fundo do avatar a partir do nome (sempre a mesma por pessoa). */
export function avatarColor(name = "") {
  const code = (name || "?").charCodeAt(0);
  return AVATAR_TINTS[code % AVATAR_TINTS.length] + "33";
}

/** Conteúdo do avatar: <img> da foto (validada contra XSS) ou a inicial. */
export function avatarInner(name, photo) {
  const safe = safeImageSrc(photo);
  if (safe) return `<img src="${safe}" alt="" class="avatar-img">`;
  return escapeHtml((name || "?").charAt(0).toUpperCase());
}

/**
 * Avatar completo.
 *   avatar({ name, photo })                    → 40px, fundo pela cor do nome
 *   avatar({ name, photo, size: "sm" })        → xs | sm | lg
 *   avatar({ name, tint: false })              → fundo neutro
 *   avatar({ name, cls: "gcard__pax" })        → classe extra de layout
 */
export function avatar({ name = "", photo = "", size = "", tint = true, cls = "" } = {}) {
  const classes = ["avatar", size && `avatar--${size}`, cls].filter(Boolean).join(" ");
  const style = tint && !safeImageSrc(photo) ? ` style="background:${avatarColor(name)}"` : "";
  return `<span class="${classes}"${style}>${avatarInner(name, photo)}</span>`;
}

/**
 * Troca o conteúdo de um bloco SÓ se o HTML mudou. Redesenhar o mesmo HTML
 * faz a tela piscar: fotos são decodificadas de novo, barras e cascatas
 * reanimam. Devolve true quando trocou — quem liga cliques nos elementos
 * novos faz isso só nesse caso (senão os antigos ganham clique duplicado):
 *
 *   if (!setHTML(box, html)) return;
 *   box.querySelectorAll("[data-x]").forEach(b => b.addEventListener(...));
 *
 * Toda escrita num bloco que usa setHTML deve passar por ele (inclusive a
 * mensagem de erro), para a comparação valer.
 */
export function setHTML(el, html) {
  if (!el || el._uiHTML === html) return false;
  el._uiHTML = html;
  el.innerHTML = html;
  return true;
}

/** Estado vazio de lista: ícone grande + texto. compact = sem ícone. */
export function emptyState(ic, text, { compact = false } = {}) {
  if (compact) return `<p class="empty-state empty-state--compact">${escapeHtml(text)}</p>`;
  return `<div class="empty-state"><div class="empty-state__icon">${icon(ic)}</div><p>${escapeHtml(text)}</p></div>`;
}

/**
 * Selo. tone: muted | accent | outline | solid | debt | debt-outline.
 * O texto é escapado; o ícone (opcional) é um nome de js/icons.js.
 */
export function badge(text, tone = "muted", ic = "") {
  return `<span class="badge badge--${tone}">${ic ? icon(ic) : ""}${escapeHtml(text)}</span>`;
}
