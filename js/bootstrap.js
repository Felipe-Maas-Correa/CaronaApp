// ============================================================
// MÓDULO: bootstrap.js
// Ponto de entrada carregado pelo index.html.
//
// A2: este arquivo existe para tirar o <script> inline do HTML.
// Sem script inline (e sem onclick=), a CSP pode remover
// 'unsafe-inline' de script-src — fechando a rede de proteção
// contra XSS que o 'unsafe-inline' anulava.
// ============================================================

// Fecha modais pelo X: delegação por [data-close-modal], no lugar dos
// antigos onclick inline dos botões de fechar.
document.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-close-modal]");
  if (!btn) return;
  document.getElementById(btn.dataset.closeModal)?.classList.remove("modal--open");
});

async function bootstrap() {
  // Abas e modais estão embutidos no index.html; ícones são SVG inline
  // (utils.js). Nenhuma biblioteca externa é necessária no boot.
  const appModule = await import("./app.js");
  if (typeof appModule.default === "function") appModule.default();
}

bootstrap().catch(err => console.error("[CaronaApp] Erro fatal:", err));
