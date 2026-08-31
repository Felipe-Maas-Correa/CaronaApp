// ============================================================
// MÓDULO: firebase.js  (Cloudflare Worker)
// Acesso administrativo ao Firebase via APIs REST, autenticando
// com a SERVICE ACCOUNT. Só WebCrypto — firebase-admin não roda
// em Workers.
// ============================================================

const TOKEN_URI = "https://oauth2.googleapis.com/token";
const JWK_URI   = "https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com";
const SCOPES    = "https://www.googleapis.com/auth/datastore https://www.googleapis.com/auth/identitytoolkit";

const enc = new TextEncoder();
const dec = new TextDecoder();

// ── CODIFICAÇÃO ──────────────────────────────────────────────

function b64url(bytes) {
  let bin = "";
  for (const b of new Uint8Array(bytes)) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(str) {
  const b64 = str.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64.padEnd(Math.ceil(b64.length / 4) * 4, "="));
  return Uint8Array.from(bin, c => c.charCodeAt(0));
}

// ── CHAVE PRIVADA / JWT ──────────────────────────────────────

let _privateKey = null;

async function getPrivateKey(env) {
  if (_privateKey) return _privateKey;

  const pem = String(env.FIREBASE_PRIVATE_KEY || "").replace(/\\n/g, "\n");
  const body = pem
    .replace("-----BEGIN PRIVATE KEY-----", "")
    .replace("-----END PRIVATE KEY-----", "")
    .replace(/\s/g, "");

  if (!body) throw new Error("FIREBASE_PRIVATE_KEY nao configurada.");

  _privateKey = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(body), c => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return _privateKey;
}

async function signJwt(env, payload) {
  const key  = await getPrivateKey(env);
  const data = b64url(enc.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })))
             + "." + b64url(enc.encode(JSON.stringify(payload)));
  const sig  = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", key, enc.encode(data));
  return data + "." + b64url(sig);
}

// ── ACCESS TOKEN ─────────────────────────────────────────────

let _accessToken = { value: null, expiresAt: 0 };

export async function getAccessToken(env) {
  if (_accessToken.value && Date.now() < _accessToken.expiresAt - 60000) {
    return _accessToken.value;
  }

  const now = Math.floor(Date.now() / 1000);
  // .trim(): `wrangler secret put` via pipe do PowerShell deixa um \n no
  // fim do valor. Um e-mail com \n vira um `iss` inválido → OAuth responde
  // "account not found". Tolerar espaços em branco evita depender de como o
  // segredo foi gravado.
  const assertion = await signJwt(env, {
    iss:   String(env.FIREBASE_CLIENT_EMAIL || "").trim(),
    scope: SCOPES,
    aud:   TOKEN_URI,
    iat:   now,
    exp:   now + 3600
  });

  const res = await fetch(TOKEN_URI, {
    method:  "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion
    })
  });

  if (!res.ok) throw new Error("OAuth falhou: " + res.status + " " + (await res.text()));

  const json = await res.json();
  _accessToken = { value: json.access_token, expiresAt: Date.now() + json.expires_in * 1000 };
  return _accessToken.value;
}

// ── VERIFICAR ID TOKEN DO CLIENTE ────────────────────────────

let _jwks = { keys: null, fetchedAt: 0 };

async function getJwks() {
  if (_jwks.keys && Date.now() - _jwks.fetchedAt < 3600000) return _jwks.keys;
  const res = await fetch(JWK_URI);
  if (!res.ok) throw new Error("Nao foi possivel buscar as chaves publicas do Google.");
  const json = await res.json();
  _jwks = { keys: json.keys, fetchedAt: Date.now() };
  return json.keys;
}

/**
 * Verifica ASSINATURA e claims de um ID token do Firebase.
 * Sem a assinatura do Google, o token e rejeitado — e ninguem
 * consegue simplesmente inventar um uid de admin.
 *
 * Devolve tambem `auth_time`: e ele que prova que a senha foi
 * digitada ha pouco.
 */
export async function verifyIdToken(idToken, projectId) {
  const parts = String(idToken || "").split(".");
  if (parts.length !== 3) throw new Error("Token malformado.");

  const header  = JSON.parse(dec.decode(b64urlDecode(parts[0])));
  const payload = JSON.parse(dec.decode(b64urlDecode(parts[1])));

  if (header.alg !== "RS256") throw new Error("Algoritmo inesperado.");

  const jwk = (await getJwks()).find(k => k.kid === header.kid);
  if (!jwk) throw new Error("Chave de assinatura desconhecida.");

  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]
  );

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key,
    b64urlDecode(parts[2]),
    enc.encode(parts[0] + "." + parts[1])
  );
  if (!valid) throw new Error("Assinatura invalida.");

  const now = Math.floor(Date.now() / 1000);
  if (payload.aud !== projectId) throw new Error("Audience invalida.");
  if (payload.iss !== "https://securetoken.google.com/" + projectId) throw new Error("Issuer invalido.");
  if (payload.exp <= now) throw new Error("Token expirado.");
  if (!payload.sub) throw new Error("Token sem sub.");

  return {
    uid:       payload.sub,
    email:     payload.email || null,
    authTime:  Number(payload.auth_time) || 0
  };
}

// ── FIRESTORE REST ───────────────────────────────────────────

function docUrl(env, path) {
  return "https://firestore.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID +
         "/databases/(default)/documents/" + path;
}

function fromFsValue(v) {
  if (!v) return null;
  if ("nullValue"      in v) return null;
  if ("booleanValue"   in v) return v.booleanValue;
  if ("integerValue"   in v) return Number(v.integerValue);
  if ("doubleValue"    in v) return v.doubleValue;
  if ("timestampValue" in v) return new Date(v.timestampValue);
  if ("stringValue"    in v) return v.stringValue;
  if ("arrayValue"     in v) return (v.arrayValue.values || []).map(fromFsValue);
  if ("mapValue"       in v) return fromFsFields(v.mapValue.fields || {});
  return null;
}

function fromFsFields(fields) {
  const out = {};
  for (const k of Object.keys(fields || {})) out[k] = fromFsValue(fields[k]);
  return out;
}

/** Le um documento. null se nao existir. */
export async function getDoc(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(docUrl(env, path), { headers: { Authorization: "Bearer " + token } });

  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Firestore GET " + path + ": " + res.status);

  return fromFsFields((await res.json()).fields);
}

// JS -> valor no formato do Firestore REST.
function toFsValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === "boolean")        return { booleanValue: v };
  if (typeof v === "number") {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (v instanceof Date) return { timestampValue: v.toISOString() };
  if (Array.isArray(v))  return { arrayValue: { values: v.map(toFsValue) } };
  if (typeof v === "object") {
    const fields = {};
    for (const k of Object.keys(v)) fields[k] = toFsValue(v[k]);
    return { mapValue: { fields } };
  }
  return { stringValue: String(v) };
}

function toFsFields(obj) {
  const fields = {};
  for (const k of Object.keys(obj)) fields[k] = toFsValue(obj[k]);
  return fields;
}

/**
 * Escreve/atualiza campos de um documento (merge por campo).
 * Passe `mask` para tocar SÓ nesses campos; omita para gravar todos.
 */
export async function patchDoc(env, path, data, mask = null) {
  const token = await getAccessToken(env);
  const qs = (mask || Object.keys(data))
    .map(k => "updateMask.fieldPaths=" + encodeURIComponent(k))
    .join("&");

  const res = await fetch(docUrl(env, path) + "?" + qs, {
    method:  "PATCH",
    headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
    body:    JSON.stringify({ fields: toFsFields(data) })
  });
  if (!res.ok) throw new Error("Firestore PATCH " + path + ": " + res.status + " " + (await res.text()));
  return fromFsFields((await res.json()).fields);
}

/** Apaga um documento. Nao reclama se ja nao existir. */
export async function deleteDoc(env, path) {
  const token = await getAccessToken(env);
  const res = await fetch(docUrl(env, path), {
    method: "DELETE",
    headers: { Authorization: "Bearer " + token }
  });
  if (!res.ok && res.status !== 404) {
    throw new Error("Firestore DELETE " + path + ": " + res.status);
  }
}

// ── FIREBASE AUTHENTICATION (admin) ──────────────────────────

/**
 * Apaga a CONTA DE LOGIN de um usuario qualquer.
 *
 * E isto que o cliente nao consegue fazer sozinho: nao existe API no
 * SDK web para um usuario apagar a conta de outro. So com service
 * account, pelo endpoint administrativo do Identity Toolkit.
 *
 * @returns {Promise<boolean>} false se a conta ja nao existia
 */
export async function deleteAuthUser(env, uid) {
  const token = await getAccessToken(env);

  const res = await fetch(
    "https://identitytoolkit.googleapis.com/v1/projects/" + env.FIREBASE_PROJECT_ID + "/accounts:delete",
    {
      method:  "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
      body:    JSON.stringify({ localId: uid })
    }
  );

  if (res.ok) return true;

  // Conta inexistente nao e erro: o objetivo (nao existir) ja foi atingido.
  const text = await res.text();
  if (res.status === 400 && /USER_NOT_FOUND/i.test(text)) return false;

  throw new Error("Auth delete " + uid + ": " + res.status + " " + text);
}
