// ============================================================
// MÓDULO: db.js
// Todas as operações com Firestore
//
// Modelo POR USUÁRIO, DENTRO DE UM GRUPO: cada viagem/pagamento guarda o
// uid do dono E o groupId do grupo de carona a que pertence. O ID da viagem
// segue `${uid}_${date}` (permite o mesmo dia para usuários diferentes).
// Comprovantes ficam em Base64 no próprio documento.
//
// Escopo das consultas:
//   • getGroup*  → o que o passageiro e o DONO DO GRUPO enxergam;
//   • getAll*    → visão global, só do ADM SUPREMO (as rules negam ao resto).
// ============================================================

import { db } from "./firebase-config.js";
import { myGroupId } from "../auth/auth.js";
import {
  collection, doc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, query, orderBy, where, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Helper: id determinístico da viagem
function tripId(uid, date) {
  return `${uid}_${date}`;
}

// ── VALOR DA VIAGEM ──────────────────────────────────────────
// Cada GRUPO tem o seu (groups/{id}.tripValue). settings/app.tripValue
// continua existindo como padrão do sistema para grupos novos.
// Mantemos um cache em memória para o app não consultar o banco a cada
// marcação — quem o preenche é loadGroupContext(), na entrada do app.
let currentTripValue = 15;
let defaultTripValue = 15;

export function getTripValue() {
  return currentTripValue;
}

export function getDefaultTripValue() {
  return defaultTripValue;
}

/** Define o valor em vigor na sessão (chamado ao carregar/trocar de grupo). */
export function setTripValueCache(value) {
  if (typeof value === "number" && value >= 0) currentTripValue = value;
}

/** Lê o padrão do sistema (settings/app). */
export async function loadTripValue() {
  try {
    const snap = await getDoc(doc(db, "settings", "app"));
    if (snap.exists() && typeof snap.data().tripValue === "number") {
      defaultTripValue = snap.data().tripValue;
      currentTripValue = defaultTripValue;
    }
  } catch (e) { /* mantém o padrão */ }
  return defaultTripValue;
}

/** Grava o padrão do sistema (ADM SUPREMO). */
export async function setTripValueSetting(value) {
  await setDoc(doc(db, "settings", "app"), { tripValue: value }, { merge: true });
  defaultTripValue = value;
}

// ── GRUPOS ───────────────────────────────────────────────────

/** Um grupo pelo id. null se não existir (ou se não puder ler). */
export async function getGroup(groupId) {
  if (!groupId) return null;
  try {
    const snap = await getDoc(doc(db, "groups", groupId));
    return snap.exists() ? snap.data() : null;
  } catch (e) {
    return null;
  }
}

/** Todos os grupos do sistema — só o ADM SUPREMO consegue listar. */
export async function getAllGroups() {
  const snap = await getDocs(collection(db, "groups"));
  return snap.docs.map(d => d.data())
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

/**
 * Ajustes que o DONO do grupo pode mudar direto (as rules limitam a estes
 * três campos e validam faixa/tipo). Criar e apagar grupo passam pelo
 * Worker; isto aqui é só configuração.
 */
export async function updateGroupSettings(groupId, { name, pixKey, tripValue }) {
  const data = {};
  if (name      !== undefined) data.name      = name;
  if (pixKey    !== undefined) data.pixKey    = pixKey;
  if (tripValue !== undefined) data.tripValue = tripValue;
  await updateDoc(doc(db, "groups", groupId), data);
  if (typeof data.tripValue === "number") currentTripValue = data.tripValue;
}

/** Membros de um grupo (quem está com ele como grupo ATIVO). */
export async function getGroupUsers(groupId) {
  if (!groupId) return [];
  const q = query(collection(db, "users"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data())
    .sort((a, b) => String(a.name || "").localeCompare(String(b.name || "")));
}

// ── CONVITES ─────────────────────────────────────────────────
// Só leitura: gerar, revogar e aceitar passam pelo Worker.
// O filtro de status fica no JS de propósito — assim a consulta usa um
// índice de campo único, que o Firestore já cria sozinho.

/** Convites endereçados ao meu e-mail. */
export async function getInvitesForEmail(email) {
  if (!email) return [];
  const q = query(collection(db, "invites"), where("invitedEmail", "==", email.toLowerCase()));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data()).filter(i => i.status === "pending");
}

/** Convites emitidos por um grupo (visão do dono). */
export async function getGroupInvites(groupId) {
  if (!groupId) return [];
  const q = query(collection(db, "invites"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data())
    .sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
}

// ── VIAGENS (por usuário, dentro do grupo) ───────────────────

/**
 * Registra/atualiza uma viagem de um usuário numa data.
 * O grupo vem do grupo ativo de quem está marcando — as rules conferem
 * que ele bate com o grupo de quem marca (e com o do passageiro, quando
 * é o dono marcando por outro).
 */
export async function setTrip(uid, userName, date, data = {}) {
  const groupId = data.groupId || myGroupId();
  if (!groupId) throw new Error("Você precisa estar em um grupo de carona.");

  await setDoc(
    doc(db, "trips", tripId(uid, date)),
    {
      uid, userName, date, groupId,
      amount: currentTripValue, paid: false, paymentId: null,
      ...data
    },
    { merge: true }
  );
}

/**
 * Avalia uma viagem (estrelas 0-5 e velocidade).
 * @param {number} stars 0..5
 * @param {"slow"|"mid"|"fast"|null} speed
 */
export async function rateTrip(uid, date, stars, speed) {
  await updateDoc(doc(db, "trips", tripId(uid, date)), { stars, speed });
}

/**
 * Remove uma viagem de um usuário numa data.
 */
export async function deleteTrip(uid, date) {
  await deleteDoc(doc(db, "trips", tripId(uid, date)));
}

/**
 * Todas as viagens de um usuário (ordenadas por data desc no JS,
 * evitando índice composto).
 */
export async function getUserTrips(uid) {
  const q = query(collection(db, "trips"), where("uid", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data()).sort((a, b) => b.date.localeCompare(a.date));
}

/**
 * Viagens ABERTAS e disponíveis para pagar (filtradas no JS).
 * Exclui as pagas e também as que já têm um comprovante EM ANÁLISE
 * (pendingPaymentId) — senão o usuário reenviaria as mesmas datas e criaria
 * pagamentos pendentes duplicados. Elas voltam a aparecer se o admin rejeitar.
 *
 * Só as do grupo ATIVO: um pagamento cobre um grupo por vez (o PIX é de um
 * dono só), e o Worker recusa datas de grupos misturados.
 */
export async function getUserUnpaidTrips(uid, groupId = myGroupId()) {
  const trips = await getUserTrips(uid);
  return trips
    .filter(t => !t.paid && !t.pendingPaymentId)
    .filter(t => !groupId || t.groupId === groupId)
    .sort((a, b) => a.date.localeCompare(b.date));
}

// ── PAGAMENTOS (por usuário) ─────────────────────────────────
//
// Criar e apagar pagamento NÃO ficam aqui: são do Worker
// (js/worker-api.js), que recalcula o total a partir das viagens reais e
// marca/desmarca as viagens com service account. As regras do Firestore
// proíbem o cliente de escrever em `payments` ou de marcar viagem como
// paga — fechando F-01 e F-02. Aqui sobra só a LEITURA.

/**
 * Pagamentos de um usuário (ordenados por data desc no JS).
 */
export async function getUserPayments(uid) {
  const q = query(collection(db, "payments"), where("uid", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data()).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
}

// ── VISÃO DO GRUPO (dono do grupo) ───────────────────────────

/** Todas as viagens do grupo. */
export async function getGroupTrips(groupId) {
  if (!groupId) return [];
  const q = query(collection(db, "trips"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

/** Todos os pagamentos do grupo. */
export async function getGroupPayments(groupId) {
  if (!groupId) return [];
  const q = query(collection(db, "payments"), where("groupId", "==", groupId));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

// ── VISÃO GLOBAL (ADM SUPREMO) ───────────────────────────────
// As rules negam estas leituras a qualquer um que não seja ADM SUPREMO.

/** Todas as viagens de todos os grupos. */
export async function getAllTrips() {
  const snap = await getDocs(collection(db, "trips"));
  return snap.docs.map(d => d.data());
}

/** Todos os pagamentos de todos os grupos. */
export async function getAllPayments() {
  const snap = await getDocs(collection(db, "payments"));
  return snap.docs.map(d => d.data());
}

/** Todos os usuários cadastrados. */
export async function getAllUsers() {
  const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

/**
 * Apaga as viagens de um grupo (limpeza de dados de teste). Devolve as
 * datas dos pagamentos afetados para quem chamou tratar via Worker — o
 * cliente não escreve em `payments`, por regra.
 *
 * Deleta em lotes de 400 para respeitar o limite de 500 do writeBatch.
 * @returns {Promise<number>} quantidade de viagens apagadas
 */
export async function clearGroupTrips(groupId) {
  const docs = groupId
    ? (await getDocs(query(collection(db, "trips"), where("groupId", "==", groupId)))).docs
    : (await getDocs(collection(db, "trips"))).docs;

  for (let i = 0; i < docs.length; i += 400) {
    const batch = writeBatch(db);
    for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
    await batch.commit();
  }
  return docs.length;
}

// ── HELPERS ──────────────────────────────────────────────────

// Converte Firestore Timestamp | Date | número em milissegundos
export function toMillis(ts) {
  if (!ts) return 0;
  if (ts.toDate) return ts.toDate().getTime();
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}
