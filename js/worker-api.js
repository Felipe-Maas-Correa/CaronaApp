// ============================================================
// MÓDULO: worker-api.js
// Chamadas ao Worker administrativo (Cloudflare).
//
// O Worker existe para operações que o SDK web não pode fazer com
// segurança do lado do cliente:
//   - apagar a conta de login de outro usuário;
//   - criar/apagar pagamento recalculando o total no servidor (F-01/F-02).
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

// ── USUÁRIOS ──────────────────────────────────────────────────

/** Apaga a conta de login + o perfil de um usuário (admin, senha recente). */
export function deleteUserAccount(uid) {
  return callWorker("/users/delete", { uid });
}
