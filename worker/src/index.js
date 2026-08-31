// ============================================================
// CaronaApp — Worker administrativo (Cloudflare)
//
// Existe por UM motivo: o SDK web do Firebase não permite que um
// usuário apague a conta de login de outro. Só o Admin SDK faz
// isso, e ele precisa de uma service account — logo, servidor.
//
// Uma rota só: DELETE de usuário (conta de login + perfil).
// Tudo mais continua no cliente, validado pelas security rules.
// ============================================================

import { verifyIdToken, getDoc, patchDoc, deleteDoc, deleteAuthUser } from "./firebase.js";

// Mesma janela do `recentlyAuthed()` das security rules. Apagar é
// destrutivo, então exige a senha redigitada, igual à ativação.
const REAUTH_WINDOW_MS = 3 * 60 * 1000;

// UIDs do Firebase são alfanuméricos. Sanitiza antes de virar path.
const SAFE_UID  = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Comprovante: só data URL de PDF ou imagem. Espelha safeReceiptSrc do app.
const RECEIPT_RE = /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
const RECEIPT_MAX = 750000;

// ── HTTP ─────────────────────────────────────────────────────

function corsHeaders(env, request) {
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

function json(env, request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type":  "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...corsHeaders(env, request)
    }
  });
}

// ── APAGAR USUÁRIO ───────────────────────────────────────────

async function handleDeleteUser(request, env) {
  // 1. Quem está pedindo? Assinatura do token verificada contra as
  //    chaves públicas do Google.
  const header  = request.headers.get("Authorization") || "";
  const idToken = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!idToken) return json(env, request, { error: "Não autorizado." }, 401);

  let caller;
  try {
    caller = await verifyIdToken(idToken, env.FIREBASE_PROJECT_ID);
  } catch {
    return json(env, request, { error: "Não autorizado." }, 401);
  }

  // 2. Senha redigitada há pouco. O cliente não consegue forjar
  //    auth_time: só uma reautenticação real o atualiza.
  if (Date.now() - caller.authTime * 1000 > REAUTH_WINDOW_MS) {
    return json(env, request,
      { error: "Confirmação expirada. Digite a senha novamente." }, 401);
  }

  // 3. É admin ativo? Lido do Firestore, não confiando no cliente.
  const callerProfile = await getDoc(env, "users/" + caller.uid);
  if (!callerProfile || callerProfile.role !== "admin" || callerProfile.active === false) {
    return json(env, request, { error: "Requer administrador." }, 403);
  }

  // 4. Alvo válido?
  const body = await request.json().catch(() => ({}));
  const uid  = String(body.uid || "");

  if (!SAFE_UID.test(uid)) {
    return json(env, request, { error: "UID inválido." }, 400);
  }
  if (uid === caller.uid) {
    return json(env, request, { error: "Você não pode apagar a própria conta." }, 400);
  }

  // 5. Apaga. Ordem importa: a conta de login PRIMEIRO.
  //
  //    Se o perfil sumisse antes e o delete da conta falhasse, sobraria
  //    uma conta capaz de logar e recriar o próprio perfil. Fazendo o
  //    login morrer primeiro, uma falha no meio deixa no máximo um
  //    perfil órfão — visível no painel e sem ninguém por trás dele.
  const target = await getDoc(env, "users/" + uid);
  const existedInAuth = await deleteAuthUser(env, uid);

  await deleteDoc(env, "users/" + uid);

  // Remove também o apelido do login-por-nome, senão o nome fica
  // reservado apontando para um uid que não existe mais.
  if (target && target.name) {
    const slug = String(target.name)
      .normalize("NFD").replace(/[̀-ͯ]/g, "")
      .trim().toLowerCase().replace(/\s+/g, " ");
    if (slug) await deleteDoc(env, "usernames/" + encodeURIComponent(slug));
  }

  return json(env, request, {
    ok:     true,
    name:   target?.name || null,
    // false = a conta de login já não existia (só o perfil foi limpo)
    authDeleted: existedInAuth
  });
}

// ── AUTENTICAÇÃO COMUM ───────────────────────────────────────
// Verifica o token e devolve o chamador. Lança em caso de token inválido.
async function authCaller(request, env) {
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

// ── CRIAR PAGAMENTO (F-01, F-02) ─────────────────────────────
//
// A criação de pagamento saiu do cliente porque as regras não conseguem
// (a) somar o valor real das viagens nem (b) garantir que "pago" só é
// marcado junto de um pagamento verdadeiro. Aqui, com service account:
//   - lê cada viagem REAL e soma o amount do próprio banco;
//   - IGNORA qualquer total que o cliente mande (antes ele forjava R$0,01);
//   - valida o formato do comprovante;
//   - grava o pagamento e marca as viagens, tudo do lado do servidor.
async function handleCreatePayment(request, env) {
  const caller = await authCaller(request, env);

  // Precisa ser uma conta ativa (mesma exigência das regras de pagamento).
  const profile = await getDoc(env, "users/" + caller.uid);
  if (!profile || profile.active === false) {
    return json(env, request, { error: "Conta inativa." }, 403);
  }

  const body  = await request.json().catch(() => ({}));
  const dates = Array.isArray(body.dates) ? body.dates : [];
  const receiptData = String(body.receiptData || "");

  if (dates.length === 0) {
    return json(env, request, { error: "Nenhuma data selecionada." }, 400);
  }
  if (dates.length > 400) {
    return json(env, request, { error: "Muitas viagens de uma vez." }, 400);
  }
  if (!RECEIPT_RE.test(receiptData) || receiptData.length > RECEIPT_MAX) {
    return json(env, request, { error: "Comprovante inválido (envie um PDF)." }, 400);
  }
  if (!dates.every(d => SAFE_DATE.test(d))) {
    return json(env, request, { error: "Data inválida." }, 400);
  }

  // Lê cada viagem do próprio dono, confirma que existe e está EM ABERTO,
  // e soma o valor autoritativo. Datas duplicadas são deduplicadas.
  const unique = [...new Set(dates)];
  let total = 0;
  for (const date of unique) {
    const trip = await getDoc(env, "trips/" + caller.uid + "_" + date);
    if (!trip)                 return json(env, request, { error: "Viagem inexistente: " + date }, 400);
    if (trip.uid !== caller.uid) return json(env, request, { error: "Viagem de outro usuário." }, 403);
    if (trip.paid === true)    return json(env, request, { error: "Viagem já paga: " + date }, 409);
    total += typeof trip.amount === "number" ? trip.amount : 0;
  }
  if (total <= 0) {
    return json(env, request, { error: "Total inválido." }, 400);
  }

  // Grava o pagamento com o total RECALCULADO e o carimbo do servidor.
  const paymentId = "pay_" + Date.now();
  await patchDoc(env, "payments/" + paymentId, {
    id:          paymentId,
    uid:         caller.uid,
    userName:    profile.name || caller.email || "",
    tripDates:   unique,
    totalAmount: total,
    receiptData: receiptData,
    createdAt:   new Date()
  });

  // Marca as viagens como pagas (service account passa por cima das regras,
  // que agora proíbem o cliente de fazer isso).
  for (const date of unique) {
    await patchDoc(env, "trips/" + caller.uid + "_" + date,
      { paid: true, paymentId }, ["paid", "paymentId"]);
  }

  return json(env, request, { ok: true, paymentId, total });
}

// ── APAGAR PAGAMENTO ─────────────────────────────────────────
// Também sai do cliente: desmarcar as viagens exige escrever paid:false,
// que as regras não permitem mais ao dono. O Worker faz com verificação.
async function handleDeletePayment(request, env) {
  const caller = await authCaller(request, env);
  const body   = await request.json().catch(() => ({}));
  const paymentId = String(body.paymentId || "");

  if (!/^pay_[0-9]{1,20}$/.test(paymentId)) {
    return json(env, request, { error: "Pagamento inválido." }, 400);
  }

  const payment = await getDoc(env, "payments/" + paymentId);
  if (!payment) return json(env, request, { error: "Pagamento não encontrado." }, 404);

  // Dono ou admin.
  const profile = await getDoc(env, "users/" + caller.uid);
  const isAdmin = profile && profile.role === "admin" && profile.active !== false;
  if (payment.uid !== caller.uid && !isAdmin) {
    return json(env, request, { error: "Sem permissão." }, 403);
  }

  // Reabre as viagens cobertas por este pagamento.
  for (const date of (payment.tripDates || [])) {
    if (!SAFE_DATE.test(date)) continue;
    try {
      await patchDoc(env, "trips/" + payment.uid + "_" + date,
        { paid: false, paymentId: null }, ["paid", "paymentId"]);
    } catch { /* viagem pode ter sido apagada; segue */ }
  }

  await deleteDoc(env, "payments/" + paymentId);
  return json(env, request, { ok: true });
}

// ── LOGIN POR NOME (A1, A4) ──────────────────────────────────
//
// A coleção `usernames` deixou de ser pública. O e-mail não é mais
// legível por qualquer um no Firestore (A1), e a escrita é autoritativa:
// o Worker só grava o slug do PRÓPRIO chamador, com o e-mail do token —
// então ninguém ocupa o nome de outro (A4).

// Mesmo slug do cliente (auth.js slugifyName): sem acento, minúsculo,
// espaços colapsados.
function slugifyName(name) {
  return String(name || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .trim().toLowerCase().replace(/\s+/g, " ");
}

// Resolve um nome para o e-mail — chamada ANÔNIMA (o login acontece antes
// de haver sessão). Devolve só o e-mail, e só se o nome existir.
async function handleResolveName(request, env) {
  const body = await request.json().catch(() => ({}));
  const slug = slugifyName(body.name);
  if (!slug) return json(env, request, { error: "Nome inválido." }, 400);

  const rec = await getDoc(env, "usernames/" + encodeURIComponent(slug));
  if (!rec || !rec.email) return json(env, request, { error: "Nome não encontrado." }, 404);

  return json(env, request, { email: rec.email });
}

// Registra/atualiza o nome do PRÓPRIO usuário logado. O e-mail vem do
// token (não do corpo), e o slug do nome enviado — impossível gravar em
// nome de terceiro.
async function handleRegisterName(request, env) {
  const caller = await authCaller(request, env);
  const body   = await request.json().catch(() => ({}));
  const name   = String(body.name || "").slice(0, 60);
  const slug   = slugifyName(name);
  if (!slug) return json(env, request, { error: "Nome inválido." }, 400);

  // Se o slug já pertence a OUTRO uid, é um nome em conflito — recusa em vez
  // de sobrescrever (não roubamos o nome de ninguém, mas também não deixamos
  // roubar). O dono legítimo mantém o seu.
  const existing = await getDoc(env, "usernames/" + encodeURIComponent(slug));
  if (existing && existing.uid && existing.uid !== caller.uid) {
    return json(env, request, { error: "Nome já em uso." }, 409);
  }

  await patchDoc(env, "usernames/" + encodeURIComponent(slug), {
    uid:   caller.uid,
    name:  name,
    email: caller.email || ""
  });
  return json(env, request, { ok: true, slug });
}

// ── ROTEADOR ─────────────────────────────────────────────────

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders(env, request) });
    }

    const routes = {
      "/users/delete":     handleDeleteUser,
      "/payments/create":  handleCreatePayment,
      "/payments/delete":  handleDeletePayment,
      "/auth/resolve-name": handleResolveName,   // anônima (pré-login)
      "/auth/register-name": handleRegisterName  // autenticada (self)
    };

    const handler = routes[url.pathname];
    if (request.method === "POST" && handler) {
      try {
        return await handler(request, env);
      } catch (err) {
        const status = err && err.status ? err.status : 500;
        console.error("[worker]", url.pathname, err && err.message);
        return json(env, request,
          { error: status === 401 ? "Não autorizado." : "Erro interno." }, status);
      }
    }

    return json(env, request, { error: "Rota não encontrada." }, 404);
  }
};
