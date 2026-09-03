// ============================================================
// MÓDULO: http.js  (Cloudflare Worker)
// CORS, resposta JSON, rate limit e identificação do chamador.
//
// Vive à parte porque agora HÁ DOIS arquivos de rotas (index.js e
// groups.js) e ambos precisam das mesmas primitivas. Sem isto, um
// importaria o outro e o import viraria circular.
// ============================================================

import { verifyIdToken } from "./firebase.js";

// ── CORS / RESPOSTA ──────────────────────────────────────────

export function corsHeaders(env, request) {
  const allowed = String(env.ALLOWED_ORIGIN || "").split(",").map(s => s.trim()).filter(Boolean);
  const origin  = request.headers.get("Origin") || "";

  const headers = {
    "Access-Control-Allow-Methods": "POST,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type,Authorization",
    "Access-Control-Max-Age":       "86400",
    "Vary":                         "Origin"
  };
  // A6: só devolve Allow-Origin quando a origem está na lista. Para origens
  // não listadas, o cabeçalho é OMITIDO — o navegador então bloqueia. Antes
  // devolvia a 1ª origem permitida, o que confundia (dava a impressão de
  // liberar). A fronteira real de autorização é o token, não o CORS.
  if (allowed.includes(origin)) {
    headers["Access-Control-Allow-Origin"] = origin;
  }
  return headers;
}

export function json(env, request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request)
    }
  });
}

// ── RATE LIMIT (F-02) ────────────────────────────────────────
//
// Melhor esforço, EM MEMÓRIA do isolate. O Workers roda vários isolates por
// data center, então isto NÃO é um teto global rígido — para um limite duro
// use o Cloudflare Rate Limiting (painel/regra WAF) ou um binding KV/Durable
// Object. Ainda assim, corta a enumeração trivial a partir de um mesmo IP
// dentro de um isolate, elevando bastante o custo do abuso automatizado —
// que é o objetivo aqui.
const _hits = new Map(); // chave -> { count, resetAt }

export function clientIp(request) {
  return request.headers.get("CF-Connecting-IP")
      || (request.headers.get("X-Forwarded-For") || "").split(",")[0].trim()
      || "desconhecido";
}

// Retorna true se a chamada PODE prosseguir; false se estourou a cota.
export function rateLimit(key, max, windowMs) {
  const now = Date.now();

  // Poda oportunista: impede o Map de crescer sem limite em isolates longevos.
  if (_hits.size > 5000) {
    for (const [k, v] of _hits) if (now > v.resetAt) _hits.delete(k);
  }

  const rec = _hits.get(key);
  if (!rec || now > rec.resetAt) {
    _hits.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (rec.count >= max) return false;
  rec.count++;
  return true;
}

// ── AUTENTICAÇÃO COMUM ───────────────────────────────────────
// Verifica o token e devolve o chamador. Lança em caso de token inválido.
export async function authCaller(request, env) {
  const header  = request.headers.get("Authorization") || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!idToken) { const e = new Error("Não autorizado."); e.status = 401; throw e; }
  try {
    return await verifyIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch {
    // Token malformado/expirado/assinatura inválida → 401, não 500.
    const e = new Error("Não autorizado."); e.status = 401; throw e;
  }
}

// ── ERROS COM STATUS ─────────────────────────────────────────
// Açúcar para `throw httpError(403, "...")` — o roteador traduz o status.
export function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}
