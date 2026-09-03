// ============================================================
// CaronaApp — Worker administrativo (Cloudflare)
//
// Faz o que o SDK web não pode fazer com segurança no navegador:
//   • apagar a conta de LOGIN de outro usuário (só o Admin SDK faz);
//   • criar/aprovar/rejeitar pagamento recalculando o total no servidor;
//   • o ciclo de vida dos GRUPOS DE CARONA (ver groups.js), que mexe em
//     vários documentos que precisam mudar juntos.
//
// Tudo mais continua no cliente, validado pelas security rules.
// ============================================================

import { getDoc, patchDoc, deleteDoc, deleteAuthUser, assertSecrets } from "./firebase.js";
import { corsHeaders, json, clientIp, rateLimit, authCaller } from "./http.js";
import {
  handleCreateGroup, handleCreateInvite, handleRevokeInvite, handleJoinGroup,
  handleLeaveGroup, handleRemoveMember, handleTransferGroup, handleDeleteGroup
} from "./groups.js";

// Mesma janela do `recentlyAuthed()` das security rules. Apagar é
// destrutivo, então exige a senha redigitada, igual à ativação.
const REAUTH_WINDOW_MS = 3 * 60 * 1000;

// UIDs do Firebase são alfanuméricos. Sanitiza antes de virar path.
const SAFE_UID  = /^[A-Za-z0-9_-]{1,128}$/;
const SAFE_DATE = /^\d{4}-\d{2}-\d{2}$/;
// Comprovante: só data URL de PDF ou imagem. Espelha safeReceiptSrc do app.
const RECEIPT_RE = /^data:(image\/(png|jpe?g|webp|gif)|application\/pdf);base64,[A-Za-z0-9+/=]+$/;
const RECEIPT_MAX = 750000;

// ── APAGAR USUÁRIO ───────────────────────────────────────────

async function handleDeleteUser(request, env) {
  // 1. Quem está pedindo? Assinatura do token verificada contra as
  //    chaves públicas do Google (authCaller lança 401 se não bater).
  const caller = await authCaller(request, env);

  // 2. Senha redigitada há pouco. O cliente não consegue forjar
  //    auth_time: só uma reautenticação real o atualiza.
  if (Date.now() - caller.authTime * 1000 > REAUTH_WINDOW_MS) {
    return json(env, request,
      { error: "Confirmação expirada. Digite a senha novamente." }, 401);
  }

  // 3. É ADM SUPREMO ativo? Lido do Firestore, não confiando no cliente.
  //    Apagar a conta de login é ação de dono do software: o dono de um
  //    grupo remove alguém do GRUPO dele (/groups/remove-member), não
  //    apaga a pessoa do sistema inteiro.
  const callerProfile = await getDoc(env, "users/" + caller.uid);
  if (!callerProfile || callerProfile.role !== "admin" || callerProfile.active === false) {
    return json(env, request, { error: "Requer administrador do sistema." }, 403);
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

// ── CRIAR PAGAMENTO (F-01) ───────────────────────────────────
//
// A criação de pagamento saiu do cliente porque as regras não conseguem
// (a) somar o valor real das viagens nem (b) garantir que "pago" só é
// marcado junto de um pagamento verdadeiro. Aqui, com service account:
//   - lê cada viagem REAL e soma o amount do próprio banco;
//   - IGNORA qualquer total que o cliente mande (antes ele forjava R$0,01);
//   - valida o FORMATO do comprovante.
//
// F-01 (2ª rodada): o Worker NÃO consegue provar que o PDF realmente cobre a
// dívida (ler o valor do PDF no Worker é inviável/frágil). Então o pagamento
// nasce PENDENTE e as viagens NÃO são marcadas como pagas na hora — ficam
// "em análise" (pendingPaymentId) até um admin conferir o comprovante e
// aprovar (/payments/approve). Antes, qualquer PDF de formato válido zerava
// a dívida direto pela API, sem PIX nenhum. Agora, sem aprovação, a dívida
// continua de pé.
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

  // Lê cada viagem do próprio dono, confirma que existe, está EM ABERTO e
  // não tem OUTRO comprovante já em análise, e soma o valor autoritativo.
  // Datas duplicadas são deduplicadas.
  //
  // O grupo do pagamento vem das VIAGENS, não do cliente — e todas têm de
  // ser do mesmo grupo. Um pagamento que misturasse grupos cairia na caixa
  // de dois donos diferentes, e cada um veria metade da conta.
  const unique = [...new Set(dates)];
  let total = 0;
  let groupId = null;
  for (const date of unique) {
    const trip = await getDoc(env, "trips/" + caller.uid + "_" + date);
    if (!trip)                   return json(env, request, { error: "Viagem inexistente: " + date }, 400);
    if (trip.uid !== caller.uid) return json(env, request, { error: "Viagem de outro usuário." }, 403);
    if (trip.paid === true)      return json(env, request, { error: "Viagem já paga: " + date }, 409);
    if (trip.pendingPaymentId)   return json(env, request, { error: "Já há um comprovante em análise para " + date + "." }, 409);

    const tripGroup = trip.groupId || null;
    if (groupId === null) groupId = tripGroup;
    else if (groupId !== tripGroup) {
      return json(env, request, { error: "Pague as viagens de um grupo por vez." }, 400);
    }

    total += typeof trip.amount === "number" ? trip.amount : 0;
  }
  if (total <= 0) {
    return json(env, request, { error: "Total inválido." }, 400);
  }

  // Grava o pagamento PENDENTE com o total RECALCULADO e o carimbo do servidor.
  const paymentId = "pay_" + Date.now();
  await patchDoc(env, "payments/" + paymentId, {
    id:          paymentId,
    uid:         caller.uid,
    userName:    profile.name || caller.email || "",
    groupId,
    tripDates:   unique,
    totalAmount: total,
    receiptData: receiptData,
    status:      "pending",
    createdAt:   new Date()
  });

  // Marca as viagens como "em análise" (NÃO pagas). Só a aprovação do admin
  // vira paid:true. Isto também trava a reenvio duplicado das mesmas datas.
  for (const date of unique) {
    await patchDoc(env, "trips/" + caller.uid + "_" + date,
      { pendingPaymentId: paymentId }, ["pendingPaymentId"]);
  }

  return json(env, request, { ok: true, paymentId, total, status: "pending" });
}

// ── APROVAR / REJEITAR PAGAMENTO (F-01) ──────────────────────
// Quem confere o comprovante é o DONO DO GRUPO — é ele que recebe o PIX.
// O ADM SUPREMO também pode, como suporte. Aprovar marca as viagens do
// pagamento como pagas; rejeitar reabre as viagens (tira o "em análise").
// É aqui que a conferência humana do comprovante × valor fecha o F-01.

// Autentica PRIMEIRO, depois lê o pagamento, depois autoriza.
//
// A ordem importa: o id do pagamento é `pay_<timestamp>`, ou seja,
// adivinhável. Se o documento fosse lido antes do token, a diferença entre
// 404 e 403 diria a um anônimo quais ids existem. Autenticando antes, quem
// não tem token nem chega a fazer a pergunta.
//
// A autorização só pode vir depois da leitura porque ela depende do GRUPO do
// pagamento — não dá para saber quem manda sem saber de qual pagamento se
// trata.
async function loadPaymentAsCaller(request, env, body) {
  const caller = await authCaller(request, env);

  const paymentId = String(body.paymentId || "");
  if (!/^pay_[0-9]{1,20}$/.test(paymentId)) {
    const e = new Error("Pagamento inválido."); e.status = 400; throw e;
  }
  const payment = await getDoc(env, "payments/" + paymentId);
  if (!payment) { const e = new Error("Pagamento não encontrado."); e.status = 404; throw e; }

  return { caller, paymentId, payment };
}

// Quem pode revisar ESTE pagamento: o dono do grupo dele (é quem recebe o
// PIX) ou o administrador do sistema. A conta é feita aqui, com dados lidos
// do Firestore — nunca com o que o cliente afirma ser.
async function assertReviewer(env, caller, payment) {
  const profile = await getDoc(env, "users/" + caller.uid);
  if (!profile || profile.active === false) {
    const e = new Error("Conta inativa."); e.status = 403; throw e;
  }
  if (profile.role === "admin") return;

  const group = payment.groupId ? await getDoc(env, "groups/" + payment.groupId) : null;
  if (group && group.ownerUid === caller.uid) return;

  const e = new Error("Só o dono do grupo confere os comprovantes."); e.status = 403; throw e;
}

async function handleApprovePayment(request, env) {
  const body = await request.json().catch(() => ({}));
  const { caller, paymentId, payment } = await loadPaymentAsCaller(request, env, body);
  await assertReviewer(env, caller, payment);

  if (payment.status === "approved") return json(env, request, { ok: true, already: true });

  // Marca as viagens cobertas como pagas de fato. Só toca em viagens que
  // AINDA existem e apontam para este pagamento como pendente — evita
  // (a) recriar via PATCH uma viagem que o admin apagou e (b) requitar uma
  // viagem que já foi coberta/reaberta por outro fluxo.
  for (const date of (payment.tripDates || [])) {
    if (!SAFE_DATE.test(date)) continue;
    const trip = await getDoc(env, "trips/" + payment.uid + "_" + date);
    if (!trip || trip.pendingPaymentId !== paymentId) continue;
    await patchDoc(env, "trips/" + payment.uid + "_" + date,
      { paid: true, paymentId, pendingPaymentId: null },
      ["paid", "paymentId", "pendingPaymentId"]);
  }

  await patchDoc(env, "payments/" + paymentId,
    { status: "approved", reviewedBy: caller.uid, reviewedAt: new Date() },
    ["status", "reviewedBy", "reviewedAt"]);

  return json(env, request, { ok: true });
}

async function handleRejectPayment(request, env) {
  const body = await request.json().catch(() => ({}));
  const { caller, paymentId, payment } = await loadPaymentAsCaller(request, env, body);
  await assertReviewer(env, caller, payment);

  // Reabre as viagens: só as que AINDA apontam para este pagamento como
  // pendente — nunca desmarca uma viagem já paga por outro comprovante.
  for (const date of (payment.tripDates || [])) {
    if (!SAFE_DATE.test(date)) continue;
    const trip = await getDoc(env, "trips/" + payment.uid + "_" + date);
    if (trip && trip.pendingPaymentId === paymentId) {
      await patchDoc(env, "trips/" + payment.uid + "_" + date,
        { pendingPaymentId: null }, ["pendingPaymentId"]);
    }
  }

  await patchDoc(env, "payments/" + paymentId,
    { status: "rejected", reviewedBy: caller.uid, reviewedAt: new Date() },
    ["status", "reviewedBy", "reviewedAt"]);

  return json(env, request, { ok: true });
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

  // Quem pagou, o dono do grupo, ou o ADM SUPREMO.
  const profile    = await getDoc(env, "users/" + caller.uid);
  const superAdmin = profile && profile.role === "admin" && profile.active !== false;
  const group      = payment.groupId ? await getDoc(env, "groups/" + payment.groupId) : null;
  const groupOwner = group && group.ownerUid === caller.uid;
  if (payment.uid !== caller.uid && !superAdmin && !groupOwner) {
    return json(env, request, { error: "Sem permissão." }, 403);
  }

  // Reabre as viagens cobertas por este pagamento — seja um pagamento já
  // aprovado (paid:true) ou ainda em análise (pendingPaymentId). Só mexe nas
  // viagens que AINDA apontam para este pagamento, para não desmarcar uma
  // viagem que outro comprovante já cobriu.
  for (const date of (payment.tripDates || [])) {
    if (!SAFE_DATE.test(date)) continue;
    try {
      const trip = await getDoc(env, "trips/" + payment.uid + "_" + date);
      if (!trip) continue;
      if (trip.paymentId === paymentId || trip.pendingPaymentId === paymentId) {
        await patchDoc(env, "trips/" + payment.uid + "_" + date,
          { paid: false, paymentId: null, pendingPaymentId: null },
          ["paid", "paymentId", "pendingPaymentId"]);
      }
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
  // F-02: throttle por IP. O endpoint é anônimo e devolve e-mail por nome —
  // sem trava, dá para varrer nomes e colher e-mails (phishing/stuffing). O
  // limite eleva muito o custo de enumerar. Para um teto global e durável,
  // some a isto uma regra de Rate Limiting no painel Cloudflare.
  if (!rateLimit("resolve:" + clientIp(request), 12, 60000)) {
    return json(env, request, { error: "Muitas tentativas. Aguarde um instante e tente de novo." }, 429);
  }

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

  // F-03: exige conta ATIVA, igual à criação de pagamento. Uma conta
  // recém-criada nasce inativa e sem acesso ao app; sem esta checagem ela
  // ainda conseguia reservar um slug de nome (squatting) antes de ser
  // liberada. `active` ausente = conta antiga, tratada como ativa.
  const profile = await getDoc(env, "users/" + caller.uid);
  if (!profile || profile.active === false) {
    return json(env, request, { error: "Conta inativa." }, 403);
  }

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

    // F-04: falha CEDO e claro se o Worker estiver sem segredos, em vez de
    // estourar no meio de uma operação. O preflight (acima) não depende disso.
    try {
      assertSecrets(env);
    } catch (err) {
      console.error("[worker] config", err && err.message);
      return json(env, request, { error: "Serviço mal configurado." }, 503);
    }

    const routes = {
      "/users/delete":       handleDeleteUser,      // ADM SUPREMO
      "/payments/create":    handleCreatePayment,
      "/payments/approve":   handleApprovePayment,  // dono do grupo / ADM SUPREMO
      "/payments/reject":    handleRejectPayment,   // dono do grupo / ADM SUPREMO
      "/payments/delete":    handleDeletePayment,
      "/auth/resolve-name":  handleResolveName,     // anônima (pré-login)
      "/auth/register-name": handleRegisterName,    // autenticada (self)

      // Grupos de carona — ver groups.js
      "/groups/create":        handleCreateGroup,
      "/groups/invite":        handleCreateInvite,  // dono do grupo
      "/groups/revoke-invite": handleRevokeInvite,  // dono do grupo
      "/groups/join":          handleJoinGroup,
      "/groups/leave":         handleLeaveGroup,
      "/groups/remove-member": handleRemoveMember,  // dono do grupo
      "/groups/transfer":      handleTransferGroup, // dono do grupo
      "/groups/delete":        handleDeleteGroup    // dono do grupo / ADM SUPREMO
    };

    const handler = routes[url.pathname];
    if (request.method === "POST" && handler) {
      // F-02: teto largo por IP em TODAS as rotas, defesa contra abuso/
      // enumeração geral. O /auth/resolve-name tem um limite mais apertado
      // dentro do próprio handler.
      if (!rateLimit("all:" + clientIp(request), 120, 60000)) {
        return json(env, request, { error: "Muitas requisições. Aguarde um instante." }, 429);
      }
      try {
        return await handler(request, env);
      } catch (err) {
        const status = err && err.status ? err.status : 500;
        console.error("[worker]", url.pathname, err && err.message);
        // Erros 4xx são de VALIDAÇÃO: a mensagem é escrita por nós e serve
        // para o usuário entender o que fazer ("convite expirou"). O 500 é
        // opaco de propósito — não vaza detalhe interno.
        const msg = status === 401 ? "Não autorizado."
                  : (status >= 400 && status < 500) ? (err.message || "Requisição inválida.")
                  : "Erro interno.";
        return json(env, request, { error: msg }, status);
      }
    }

    return json(env, request, { error: "Rota não encontrada." }, 404);
  }
};
