// ============================================================
// MÓDULO: receipt-parser.js
// Lê comprovantes de pagamento em PDF e extrai o valor.
// Usa pdf.js (Mozilla) carregado sob demanda via CDN — sem build.
// ============================================================

// Versão fixada para estabilidade/cache. Mesmo padrão do Firebase (CDN).
const PDFJS_VERSION = "4.7.76";
const PDFJS_URL     = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.min.mjs`;
const PDFJS_WORKER  = `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/build/pdf.worker.min.mjs`;

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

/** Compara dois valores em reais até os centavos (evita erro de float). */
export function valuesMatch(a, b) {
  if (a == null || b == null) return false;
  return Math.round(a * 100) === Math.round(b * 100);
}
