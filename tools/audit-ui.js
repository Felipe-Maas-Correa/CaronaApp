#!/usr/bin/env node
// ============================================================
// tools/audit-ui.js — LINTER DO DESIGN SYSTEM
//
// Verifica se o código segue DESIGN-SYSTEM.md. Rode antes de commitar um
// componente novo:
//
//     node tools/audit-ui.js
//
// ERRO  (sai com código 1): quebra o padrão ou é bug provável.
// AVISO (não falha):        dívida conhecida — não aumente.
//
// Exceções pontuais: comentário `ui-audit: allow` na mesma linha.
// ============================================================

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const rel = (f) => path.relative(ROOT, f).replace(/\\/g, "/");
const read = (f) => fs.readFileSync(path.join(ROOT, f), "utf8");
const lines = (src) => src.split(/\r?\n/);

let files;
try {
  // inclui arquivos novos ainda não adicionados (o caso típico: componente
  // recém-criado), respeitando o .gitignore
  files = execSync("git ls-files --cached --others --exclude-standard", { cwd: ROOT }).toString().trim().split(/\r?\n/);
} catch {
  console.error("Rode dentro do repositório (usa git ls-files).");
  process.exit(2);
}
const front = (f) => !f.startsWith("worker/") && !f.startsWith("tools/") && !f.startsWith("vendor/") && !f.startsWith("docs/");
const CSS  = files.filter(f => f.endsWith(".css") && front(f));
const JS   = files.filter(f => f.endsWith(".js") && front(f) && !/config(\.example)?\.js$/.test(f));
const HTML = files.filter(f => f.endsWith(".html") && front(f));

const errors = [];
const warns = [];
const err  = (where, msg) => errors.push(`${where}  ${msg}`);
const warn = (where, msg) => warns.push(`${where}  ${msg}`);
const allowed = (line) => /ui-audit:\s*allow/.test(line);

// ── Registro de ícones ────────────────────────────────────────
const iconsSrc = read("js/icons.js");
const ICON_NAMES = new Set([...iconsSrc.matchAll(/^\s*"([a-z0-9-]+)"\s*:/gm)].map(m => m[1]));

// ── 1. CSS: tipografia, cor e camadas só por token ────────────
// Inclui <style> e style="" do HTML e estilos em template strings do JS.
function checkDeclarations(where, text, isTokenFile) {
  lines(text).forEach((line, i) => {
    const at = `${where}:${i + 1}`;
    if (allowed(line)) return;
    const isCustomProp = /^\s*--[\w-]+\s*:/.test(line);

    // Valor vai até ";" ou "}" (aceita nomes entre aspas); aspas/crase que
    // fecham um style="..." ou template string são removidas.
    const valueOf = (m) => m[1].trim().replace(/["'`]+$/, "").trim();
    for (const m of line.matchAll(/font-size\s*:\s*([^;}]+)/g)) {
      const v = valueOf(m);
      if (!/^var\(--fs-[a-z0-9]+\)/.test(v) && v !== "inherit") err(at, `font-size "${v}" — use um token --fs-* (DESIGN-SYSTEM.md › Tipografia)`);
    }
    for (const m of line.matchAll(/font-family\s*:\s*([^;}]+)/g)) {
      const v = valueOf(m);
      if (!/^var\(--font-[a-z]+\)/.test(v) && v !== "inherit") err(at, `font-family "${v}" — use --font-display / --font-serif / --font-mono`);
    }
    for (const m of line.matchAll(/z-index\s*:\s*([^;}]+)/g)) {
      const v = valueOf(m);
      if (!/^var\(--z-[a-z]+\)/.test(v) && !/^-?1$|^0$|^auto$/.test(v)) err(at, `z-index "${v}" — use um token --z-* (DESIGN-SYSTEM.md › Camadas)`);
    }
    if (!isCustomProp && !isTokenFile && !/^\s*(\/\/|\/?\*)/.test(line)) {
      for (const m of line.matchAll(/(?<![\w&-])#[0-9a-fA-F]{3,8}\b/g)) {
        // #id em seletor não conta: só é cor se estiver depois de ":" e
        // depois do último "{" da linha (ou seja, dentro de um valor).
        const before = line.slice(0, m.index);
        if (before.lastIndexOf(":") > before.lastIndexOf("{")) {
          err(at, `cor ${m[0]} solta — use um token de base.css / design-system.css`);
        }
      }
    }
  });
}
for (const f of CSS) checkDeclarations(f, read(f), f === "css/design-system.css" || f === "css/base.css");
for (const f of HTML) {
  const src = read(f);
  for (const m of src.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/g)) {
    const line = src.slice(0, m.index).split("\n").length;
    err(`${f}:${line}`, "<style> embutido — coloque o CSS no arquivo do componente");
    checkDeclarations(f, m[1], false);
  }
  checkDeclarations(f, [...src.matchAll(/style="([^"]*)"/g)].map(m => m[1]).join("\n"), false);
}
for (const f of JS) checkDeclarations(f, read(f), false);

// Tamanho e traço de ícone (regras cujo seletor cita svg/.lucide).
for (const f of CSS) {
  if (f === "css/design-system.css") continue;
  const src = read(f);
  for (const m of src.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const sel = m[1].trim().split(/\r?\n/).pop();
    if (!/svg|\.lucide/.test(sel)) continue;
    const line = src.slice(0, m.index + m[1].length).split("\n").length;
    for (const d of m[2].matchAll(/(?<![\w-])(width|height)\s*:\s*([^;]+)/g)) {
      const v = d[2].trim();
      if (!/^var\(--ic-[a-z0-9]+\)$|^100%$|^auto$/.test(v)) err(`${f}:${line}`, `${d[1]} "${v}" em ícone (${sel}) — use --ic-xs … --ic-hero ou .ic-*`);
    }
    for (const d of m[2].matchAll(/stroke-width\s*:\s*([^;]+)/g)) {
      const v = d[1].trim();
      if (!/^var\(--ic-stroke(-[a-z]+)?\)$/.test(v)) err(`${f}:${line}`, `stroke-width "${v}" em ícone (${sel}) — use --ic-stroke*`);
    }
  }
}

// ── 2. Ícones: só pelo registro ───────────────────────────────
for (const f of HTML) {
  const src = read(f);
  // único <svg> permitido: logo da tela de carregamento (aparece antes do JS)
  const loadStart = src.indexOf('id="loading-screen"');
  const loadEnd = src.indexOf("</div>", src.indexOf("loading-screen__logo"));
  for (const m of src.matchAll(/<svg/g)) {
    if (m.index > loadStart && m.index < loadEnd) continue;
    err(`${f}:${src.slice(0, m.index).split("\n").length}`, `<svg> embutido — use <i data-icon="nome"></i>`);
  }
  for (const m of src.matchAll(/data-icon="([^"]+)"/g)) {
    if (!ICON_NAMES.has(m[1])) err(`${f}:${src.slice(0, m.index).split("\n").length}`, `ícone "${m[1]}" não existe em js/icons.js`);
  }
}
for (const f of JS) {
  if (f === "js/icons.js") continue;
  lines(read(f)).forEach((line, i) => {
    if (allowed(line)) return;
    if (/<svg/.test(line) && !/^\s*(\/\/|\/?\*)/.test(line)) err(`${f}:${i + 1}`, `<svg> embutido — use icon("nome") de js/icons.js`);
    for (const m of line.matchAll(/\bicon\(\s*["']([^"']+)["']/g)) {
      if (!ICON_NAMES.has(m[1])) err(`${f}:${i + 1}`, `icon("${m[1]}") não existe em js/icons.js`);
    }
  });
}

// ── 3. Emoji colorido ─────────────────────────────────────────
// Símbolos tipográficos monocromáticos (✓ ★ ● • · ›) são permitidos.
const EMOJI = /\p{Extended_Pictographic}/u;
const SYMBOLS = /[✓★●•·›‹→←↑↓]/gu;
for (const f of [...JS, ...HTML]) {
  lines(read(f)).forEach((line, i) => {
    if (allowed(line) || /^\s*(\/\/|\*|<!--)/.test(line)) return;
    if (EMOJI.test(line.replace(SYMBOLS, ""))) err(`${f}:${i + 1}`, "emoji na interface — use um ícone de js/icons.js");
  });
}

// ── 4. HTML/JS: IDs, imports ──────────────────────────────────
const html = HTML.map(read).join("\n");
const idCount = {};
for (const m of html.matchAll(/\bid="([^"]+)"/g)) idCount[m[1]] = (idCount[m[1]] || 0) + 1;
for (const [id, n] of Object.entries(idCount)) if (n > 1) err("index.html", `id "${id}" repetido ${n}× — getElementById só enxerga o primeiro`);

const jsIds = new Set(JS.flatMap(f => [...read(f).matchAll(/\bid="([A-Za-z0-9_-]+)"/g)].map(m => m[1])));
for (const f of JS) {
  lines(read(f)).forEach((line, i) => {
    for (const m of line.matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g)) {
      if (!idCount[m[1]] && !jsIds.has(m[1])) err(`${f}:${i + 1}`, `#${m[1]} não existe no HTML`);
    }
  });
}

const exportsOf = {};
for (const f of JS) {
  const src = read(f), names = new Set();
  for (const m of src.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/export\s*\{([^}]+)\}/g)) m[1].split(",").forEach(n => names.add(n.trim().split(/\s+as\s+/).pop()));
  exportsOf[f] = names;
}
for (const f of JS) {
  for (const m of read(f).matchAll(/import\s*\{([^}]+)\}\s*from\s*["']([^"']+)["']/g)) {
    if (/^https?:/.test(m[2])) continue;
    const target = path.posix.normalize(path.posix.join(path.posix.dirname(f), m[2]));
    if (!exportsOf[target]) continue; // config.js e afins (fora do git)
    m[1].split(",").map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean).forEach(n => {
      if (!exportsOf[target].has(n)) err(f, `importa "${n}", que ${target} não exporta`);
    });
  }
}

// ── 5. Guia de estilo: componente só em css/components.css ────
// a) Classe aposentada (guia/aposentadas.json) não volta ao código.
const RETIRED = JSON.parse(read("guia/aposentadas.json")).classes;
const isRetired = (c) => Object.prototype.hasOwnProperty.call(RETIRED, c);
const retiredMsg = (c) => `classe aposentada ".${c}" — use "${RETIRED[c]}" (guia de estilo)`;
const stripCssComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, (c) => c.replace(/[^\n]/g, " "));
const lineAt = (src, idx) => src.slice(0, idx).split("\n").length;

for (const f of CSS) {
  const src = stripCssComments(read(f));
  for (const m of src.matchAll(/\.([a-zA-Z][\w-]*)/g)) {
    // só em seletor: ignora o que estiver depois de ":" dentro de um bloco
    const before = src.slice(0, m.index);
    if (before.lastIndexOf("{") > before.lastIndexOf("}")) continue;
    if (isRetired(m[1])) err(`${f}:${lineAt(src, m.index)}`, retiredMsg(m[1]));
  }
}
for (const f of [...HTML, ...JS]) {
  if (f.startsWith("guia/")) continue; // o guia cita as antigas de propósito
  lines(read(f)).forEach((line, i) => {
    if (allowed(line)) return;
    const found = new Set();
    // class="a b c" (inclui templates: ${...} é ignorado)
    for (const m of line.matchAll(/class(?:Name)?\s*=\s*["'`]([^"'`]*)/g)) m[1].split(/\s+/).forEach(c => found.add(c));
    // "nome" solto em string (classList.add("x"), cls: "x") e ".nome" em
    // seletor. Valor de id/for e getElementById("x") é ID, não classe.
    for (const m of line.matchAll(/["'`]\.?([a-z][\w-]*)["'`]/g)) {
      if (/(\b(id|for)\s*=\s*|getElementById\(\s*)$/.test(line.slice(0, m.index))) continue;
      found.add(m[1]);
    }
    for (const m of line.matchAll(/["'`][^"'`]*\.([a-z][\w-]*)[^"'`]*["'`]/g)) found.add(m[1]);
    for (const c of found) if (isRetired(c)) err(`${f}:${i + 1}`, retiredMsg(c));
  });
}

// b) Os blocos do guia só são DEFINIDOS em components.css. A tela pode
//    posicionar um componente por contexto (".hub-hero .btn"), mas não
//    redesenhá-lo na raiz (".btn--meu" em admin.css).
const CANON = new Set([
  "btn", "btn-icon", "btn-row", "seg", "section-head", "section-title", "section-hint", "section-count",
  "badge", "form-group", "form-label", "form-input", "form-select", "form-opt", "input-group", "input-wrap",
  "input-eye", "card", "stat", "stat-grid", "avatar", "avatar-img", "list", "list-item", "empty-state",
  "error-msg", "toast", "loading-spinner",
]);
for (const f of CSS) {
  if (f === "css/components.css") continue;
  const src = stripCssComments(read(f));
  for (const m of src.matchAll(/([^{}]+)\{/g)) {
    const prelude = m[1].trim();
    if (prelude.startsWith("@")) continue;
    for (const sel of prelude.split(",")) {
      const first = sel.trim().match(/^\.([a-zA-Z][\w-]*)/);
      if (!first) continue;
      const base = first[1].split("--")[0].split("__")[0];
      if (CANON.has(base)) {
        err(`${f}:${lineAt(src, m.index + m[1].indexOf(sel.trim()))}`,
          `".${first[1]}" redefine um componente do guia — mude em css/components.css (ou use contexto: ".minha-tela .${base}")`);
      }
    }
  }
}

// ── 6. Avisos: dívida conhecida ───────────────────────────────
const styleAttrs = (html.match(/style="/g) || []).length;
if (styleAttrs) warn("index.html", `${styleAttrs} atributos style="" — prefira classes (não aumente este número)`);

// ── Relatório ─────────────────────────────────────────────────
const out = (title, list) => {
  if (!list.length) return;
  console.log(`\n${title} (${list.length})`);
  list.forEach(l => console.log("  " + l));
};
out("✗ ERROS", errors);
out("! AVISOS", warns);
console.log(errors.length ? `\n${errors.length} erro(s). Veja DESIGN-SYSTEM.md.` : "\n✓ Design system ok.");
process.exitCode = errors.length ? 1 : 0;
