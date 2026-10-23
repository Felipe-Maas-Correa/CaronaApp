// ============================================================
// guia/guia.js — Página viva do guia de estilo
//
// O código mostrado embaixo de cada exemplo é gerado do PRÓPRIO exemplo
// (antes de os ícones virarem <svg>), então o guia nunca fica
// desatualizado em relação ao que ele mostra.
// ============================================================

import { ICONS, hydrateIcons } from "../js/icons.js";
import { avatar, emptyState, badge } from "../js/ui.js";
import { initMotion } from "../js/motion.js";
import { formatCurrency } from "../js/utils.js";

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function copy(text, el) {
  try {
    await navigator.clipboard.writeText(text);
    el.classList.add("is-copied");
    setTimeout(() => el.classList.remove("is-copied"), 1200);
  } catch { /* sem permissão de clipboard: o código continua visível */ }
}

// Tira a indentação comum das linhas (o HTML vem indentado do arquivo).
function dedent(src) {
  const lines = src.replace(/^\n+|\s+$/g, "").split("\n");
  const pad = Math.min(...lines.filter(l => l.trim()).map(l => l.match(/^ */)[0].length));
  return lines.map(l => l.slice(pad)).join("\n");
}

// ── Demos montados pelos helpers de js/ui.js ──────────────────
// Cada item: [código exibido, chamada real]. O bloco de código mostra a
// chamada JS, não o HTML que ela gera.
const JS_DEMOS = {
  avatar: [
    ['avatar({ name: "Chico" })',                          () => avatar({ name: "Chico" })],
    ['avatar({ name: "Felipe Corrêa", size: "lg" })',      () => avatar({ name: "Felipe Corrêa", size: "lg" })],
    ['avatar({ name: "Lipo", size: "sm", tint: false })',  () => avatar({ name: "Lipo", size: "sm", tint: false })],
  ],
  badge: [
    ['badge("Ativo", "outline")',                 () => badge("Ativo", "outline")],
    ['badge("Em análise", "accent", "clock")',    () => badge("Em análise", "accent", "clock")],
    ['badge("Rejeitado", "debt", "alert")',       () => badge("Rejeitado", "debt", "alert")],
  ],
  empty: [
    ['emptyState("wallet", "Nenhum pagamento registrado ainda.")',          () => emptyState("wallet", "Nenhum pagamento registrado ainda.")],
    ['emptyState("", "Nenhum convite em aberto.", { compact: true })',      () => emptyState("", "Nenhum convite em aberto.", { compact: true })],
  ],
};

function renderJsDemos() {
  document.querySelectorAll("[data-gs-js]").forEach(box => {
    const demos = JS_DEMOS[box.dataset.gsJs] || [];
    box.innerHTML = demos.map(([, run]) => run()).join("");
    box.dataset.gsCode = demos.map(([code]) => code).join("\n");
  });
}

// ── Bloco de código embaixo de cada exemplo ───────────────────
function renderCodeBlocks() {
  document.querySelectorAll(".gs-example").forEach(ex => {
    const demo = ex.querySelector(".gs-demo");
    if (!demo) return;
    const code = demo.dataset.gsCode || dedent(demo.innerHTML);
    const pre = document.createElement("pre");
    pre.className = "gs-code";
    pre.innerHTML = `<button class="btn btn--ghost btn--xs gs-code__copy" type="button">Copiar</button><code>${esc(code)}</code>`;
    pre.querySelector("button").addEventListener("click", (e) => copy(code, e.currentTarget));
    ex.appendChild(pre);
  });
}

// ── Fundamentos gerados dos tokens ────────────────────────────
function renderSwatches() {
  const css = getComputedStyle(document.documentElement);
  document.querySelectorAll("[data-gs-swatches]").forEach(box => {
    box.innerHTML = box.dataset.gsSwatches.split(" ").map(t => `
      <div class="gs-swatch">
        <span class="gs-swatch__chip" data-token="${t}"></span>
        <code>${t}</code>
        <span class="gs-swatch__val">${esc(css.getPropertyValue(t).trim())}</span>
      </div>`).join("");
    box.querySelectorAll("[data-token]").forEach(chip => {
      chip.style.background = `var(${chip.dataset.token})`;
    });
  });
}

function renderScale() {
  const css = getComputedStyle(document.documentElement);
  document.querySelectorAll("[data-gs-scale]").forEach(box => {
    box.innerHTML = box.dataset.gsScale.split(" ").map(t => `
      <div class="gs-scale__row">
        <code>${t}</code>
        <span class="gs-scale__val">${css.getPropertyValue(t).trim()}</span>
        <span class="gs-scale__sample" data-size="${t}">CaronaApp</span>
      </div>`).join("");
    box.querySelectorAll("[data-size]").forEach(s => {
      s.style.fontSize = `var(${s.dataset.size})`;
    });
  });
}

function renderIcons() {
  const grid = document.getElementById("gs-icon-grid");
  grid.innerHTML = Object.keys(ICONS).sort().map(name => `
    <button class="gs-icon" type="button" data-name="${name}" title="Copiar &lt;i data-icon=&quot;${name}&quot;&gt;">
      <i data-icon="${name}" class="ic-lg"></i>
      <span>${name}</span>
    </button>`).join("");
  grid.querySelectorAll(".gs-icon").forEach(b =>
    b.addEventListener("click", () => copy(`<i data-icon="${b.dataset.name}"></i>`, b)));
}

async function renderRetired() {
  const table = document.getElementById("gs-retired");
  try {
    const { classes } = await (await fetch("aposentadas.json")).json();
    table.innerHTML = `<thead><tr><th>Antes</th><th>Agora</th></tr></thead><tbody>${
      Object.entries(classes).map(([from, to]) => `<tr><td><code>.${esc(from)}</code></td><td><code>${esc(to)}</code></td></tr>`).join("")
    }</tbody>`;
  } catch {
    table.innerHTML = `<tbody><tr><td>Abra pelo servidor de desenvolvimento para ver a lista (guia/aposentadas.json).</td></tr></tbody>`;
  }
}

// ── Demos de movimento ─────────────────────────────────────────
// Só disparam o que o app faria; o efeito vem de js/motion.js.
function wireMotionDemos() {
  let paid = 600, trips = 68;
  const actions = {
    stagger: () => {
      const list = document.getElementById("gs-stagger-demo");
      list.innerHTML = list.innerHTML; // troca os filhos, como um render do app
    },
    count: () => {
      paid += 150; trips += 10;
      document.getElementById("gs-count-demo").textContent = formatCurrency(paid);
      document.getElementById("gs-count-demo-2").textContent = String(trips);
    },
    shake: () => {
      const err = document.getElementById("gs-shake-error");
      err.textContent = "";
      requestAnimationFrame(() => { err.textContent = "Senha incorreta."; });
    },
    pop: () => {
      const b = document.querySelector(".gs-pop-demo");
      b.classList.remove("m-pop");
      void b.offsetWidth;
      b.classList.add("m-pop");
    },
  };
  document.querySelectorAll("[data-gs-motion]").forEach(btn =>
    btn.addEventListener("click", () => actions[btn.dataset.gsMotion]?.()));
}

// ── Segmentado de exemplo: alterna como no app ────────────────
function wireSegs() {
  document.querySelectorAll("[data-gs-seg]").forEach(seg => {
    seg.addEventListener("click", (e) => {
      const btn = e.target.closest(".seg__btn");
      if (!btn) return;
      seg.querySelectorAll(".seg__btn").forEach(b => b.classList.toggle("seg__btn--active", b === btn));
    });
  });
}

renderJsDemos();
// Ordem importa: o código é lido ANTES de hydrateIcons trocar os ícones.
renderCodeBlocks();
renderSwatches();
renderScale();
renderIcons();
hydrateIcons(document);
wireSegs();
wireMotionDemos();
initMotion();
renderRetired();
