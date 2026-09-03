// ============================================================
// MÓDULO: worker-api.js
// Chamadas ao Worker administrativo (Cloudflare).
//
// O Worker existe para operações que o SDK web não pode fazer com
// segurança do lado do cliente:
//   - apagar a conta de login de outro usuário;
//   - criar/aprovar/rejeitar/apagar pagamento no servidor (F-01): o total é
//     recalculado a partir das viagens reais, e o pagamento só quita a dívida
//     depois que um admin aprova o comprovante.
//
// Toda chamada leva o ID token; o Worker verifica a assinatura antes
// de agir. O total NUNCA é enviado pelo cliente — o Worker o recalcula
// a partir das viagens reais.
// ============================================================

import { auth } from "../auth/auth.js";
import { WORKER_URL } from "./config.js";

async function callWorker(path, body) {
  if (!WORKER_URL || /SEU-SUBDOMINIO/i.test(WORKER_URL)) {
    throw new Error("Worker não configurado. Preencha WORKER_URL em js/config.js.");
  }
  if (!auth.currentUser) throw new Error("Não autenticado.");

  const idToken = await auth.currentUser.getIdToken();

  let res;
  try {
    res = await fetch(WORKER_URL + path, {
      method:  "POST",
      headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json" },
      body:    JSON.stringify(body || {})
    });
  } catch {
    throw new Error("Não foi possível falar com o servidor. Ele está publicado?");
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Falha na operação.");
  return data;
}

// ── PAGAMENTOS ────────────────────────────────────────────────

/**
 * Cria um pagamento. O Worker lê as viagens dessas datas, soma o valor
 * REAL e grava — o total não vem daqui.
 * @param {string[]} dates  datas "YYYY-MM-DD" das viagens em aberto
 * @param {string} receiptData  data URL do comprovante (PDF)
 * @returns {Promise<{paymentId:string, total:number}>}
 */
export function createPayment(dates, receiptData) {
  return callWorker("/payments/create", { dates, receiptData });
}

/** Apaga um pagamento e reabre as viagens cobertas por ele. */
export function deletePayment(paymentId) {
  return callWorker("/payments/delete", { paymentId });
}

/**
 * Aprova um pagamento PENDENTE (admin): confere o comprovante e marca as
 * viagens como pagas. Fecha o F-01 — a prova de pagamento passa por uma
 * conferência humana no servidor, não só pela trava do navegador.
 */
export function approvePayment(paymentId) {
  return callWorker("/payments/approve", { paymentId });
}

/** Rejeita um pagamento pendente (admin): reabre as viagens em análise. */
export function rejectPayment(paymentId) {
  return callWorker("/payments/reject", { paymentId });
}

// ── USUÁRIOS ──────────────────────────────────────────────────

/** Apaga a conta de login + o perfil de um usuário (ADM SUPREMO, senha recente). */
export function deleteUserAccount(uid) {
  return callWorker("/users/delete", { uid });
}

// ── GRUPOS DE CARONA ──────────────────────────────────────────
//
// Todas passam pelo Worker porque cada uma mexe em vários documentos que
// precisam mudar juntos (grupo + perfil + convite). As security rules
// avaliam um documento por vez e não conseguem garantir esse conjunto —
// por isso elas simplesmente NEGAM escrita do cliente em `groups` e
// `invites`, e o Worker é a única porta.

/** Cria um grupo e deixa quem criou como DONO. */
export function createGroup({ name, pixKey, tripValue }) {
  return callWorker("/groups/create", { name, pixKey, tripValue });
}

/**
 * Gera um convite para o meu grupo.
 * @param {string} [email] endereça o convite (só esse e-mail entra);
 *                         sem e-mail, vira um código aberto para compartilhar.
 */
export function createInvite(email) {
  return callWorker("/groups/invite", email ? { email } : {});
}

/** Cancela um convite ainda não usado. */
export function revokeInvite(code) {
  return callWorker("/groups/revoke-invite", { code });
}

/** Entra num grupo usando o código do convite. */
export function joinGroup(code) {
  return callWorker("/groups/join", { code });
}

/** Sai de um grupo (o dono precisa transferir ou apagar antes). */
export function leaveGroup(groupId) {
  return callWorker("/groups/leave", { groupId });
}

/** Tira um membro do grupo — o histórico de viagens dele fica. */
export function removeMember(uid, groupId) {
  return callWorker("/groups/remove-member", { uid, groupId });
}

/** Passa a posse do grupo para outro membro. */
export function transferGroup(uid, groupId) {
  return callWorker("/groups/transfer", { uid, groupId });
}

/** Apaga o grupo e desfaz o quadro de membros. */
export function deleteGroup(groupId) {
  return callWorker("/groups/delete", { groupId });
}
