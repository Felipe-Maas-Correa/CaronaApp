// ============================================================
// MÓDULO: receipt-parser.js
// Lê comprovantes de pagamento em PDF e extrai o valor.
// Usa pdf.js (Mozilla) carregado sob demanda via CDN — sem build.
// ============================================================

// A5: pdf.js hospedado no PRÓPRIO origin (vendor/pdfjs), não mais de um CDN
// de terceiros. Assim o código executado vem só de 'self' — sem depender da
// integridade do jsDelivr — e a CSP pode remover cdn.jsdelivr.net.
// Versão 4.7.76 (baixada em vendor/pdfjs/). Ao atualizar, rebaixe os 2 .mjs.
const PDFJS_URL    = "../vendor/pdfjs/pdf.min.mjs";
const PDFJS_WORKER = "../vendor/pdfjs/pdf.worker.min.mjs";

let _pdfjs = null;

// Carrega a lib só na primeira vez que um PDF for enviado (não pesa no boot).
async function loadPdfJs() {
  if (_pdfjs) return _pdfjs;
  const lib = await import(PDFJS_URL);
  lib.GlobalWorkerOptions.workerSrc = PDFJS_WORKER;
  _pdfjs = lib;
  return lib;
}

// "1.234,56" (padrão BR) -> 1234.56
function brToNumber(s) {
  return parseFloat(String(s).replace(/\./g, "").replace(",", "."));
}

/**
 * Encontra o valor do pagamento no texto do comprovante.
 * Prioriza rótulos ("Valor Final/Total/do Pagamento"); se não achar,
 * pega o maior valor "R$" do documento (a tarifa costuma ser R$ 0,00).
 * @returns {number|null}
 */
export function parseReceiptValue(text) {
  const labeled = text.match(
    /valor\s*(?:final|total|do\s*pagamento|da\s*transa[cç][aã]o)?\s*[:\-]?\s*R?\$?\s*([\d.]+,\d{2})/i
  );
  if (labeled) return brToNumber(labeled[1]);

  const all = [...text.matchAll(/R\$\s*([\d.]+,\d{2})/gi)].map(m => brToNumber(m[1]));
  return all.length ? Math.max(...all) : null;
}

/**
 * Lê um arquivo PDF (File/Blob) e devolve o texto e o valor detectado.
 * @param {File|Blob} file
 * @returns {Promise<{ text:string, value:number|null, efetivada:boolean }>}
 */
export async function readPdfReceipt(file) {
  const pdfjs = await loadPdfJs();
  const buf   = await file.arrayBuffer();
  const pdf   = await pdfjs.getDocument({ data: buf }).promise;

  let text = "";
  for (let i = 1; i <= pdf.numPages; i++) {
    const page    = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(it => it.str).join(" ") + "\n";
  }

  return {
    text,
    value: parseReceiptValue(text),
    // "EFETIVADA" (Banrisul), "concluída"/"aprovado" (outros bancos)
    efetivada: /efetivad|conclu[ií]d|aprovad|realizad/i.test(text)
  };
}

/**
 * Desenha as páginas de um comprovante PDF (data URL) como imagens dentro
 * de `container`. Substitui o <iframe sandbox>: o Chrome não abre o
 * visualizador de PDF dentro de iframe com sandbox (aparecia só o ícone de
 * documento quebrado) e o iOS mal mostra PDF em iframe. Aqui o pdf.js só
 * desenha — nenhum script do PDF roda (isEvalSupported: false).
 * @param {string} dataUrl  data:application/pdf;base64,... (já validada)
 * @param {HTMLElement} container
 * @param {number} [maxPages] comprovante costuma ter 1 página
 */
export async function renderPdfPages(dataUrl, container, maxPages = 4) {
  const pdfjs = await loadPdfJs();
  const b64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
  const bin = atob(b64);
  const data = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i);

  const pdf = await pdfjs.getDocument({ data, isEvalSupported: false }).promise;
  const width = container.clientWidth || 360;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const canvases = [];
  for (let i = 1; i <= Math.min(pdf.numPages, maxPages); i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: (width / base.width) * dpr });
    const canvas = document.createElement("canvas");
    canvas.className = "receipt-page";
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;
    canvases.push(canvas);
  }
  container.replaceChildren(...canvases);
  return pdf.numPages;
}

/** Compara dois valores em reais até os centavos (evita erro de float). */
export function valuesMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}
