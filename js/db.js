// ============================================================
// MÓDULO: db.js
// Todas as operações com Firestore
// Modelo POR USUÁRIO: cada viagem/pagamento guarda o uid do dono.
// ID da viagem = `${uid}_${date}` (permite o mesmo dia para usuários
// diferentes). Comprovantes ficam em Base64 no próprio documento.
// ============================================================

import { db } from "./firebase-config.js";
import {
  collection, doc, setDoc, getDoc, getDocs,
  updateDoc, deleteDoc, query, orderBy, where, Timestamp, writeBatch
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// Helper: id determinístico da viagem
function tripId(uid, date) {
  return `${uid}_${date}`;
}

// ── VALOR DA VIAGEM (configurável pelo admin) ────────────────
// Guardado em settings/app.tripValue. Mantemos um cache em memória
// para o app usar sem consultar o banco a cada marcação.
let currentTripValue = 15;

export function getTripValue() {
  return currentTripValue;
}

export async function loadTripValue() {
  try {
    const snap = await getDoc(doc(db, "settings", "app"));
    if (snap.exists() && typeof snap.data().tripValue === "number") {
      currentTripValue = snap.data().tripValue;
    }
  } catch (e) { /* mantém o padrão */ }
  return currentTripValue;
}

export async function setTripValueSetting(value) {
  await setDoc(doc(db, "settings", "app"), { tripValue: value }, { merge: true });
  currentTripValue = value;
}

// ── VIAGENS (por usuário) ────────────────────────────────────

/**
 * Registra/atualiza uma viagem de um usuário numa data.
 */
export async function setTrip(uid, userName, date, data = {}) {
  await setDoc(
    doc(db, "trips", tripId(uid, date)),
    { uid, userName, date, amount: currentTripValue, paid: false, paymentId: null, ...data },
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
 * Viagens em aberto de um usuário (filtradas no JS).
 */
export async function getUserUnpaidTrips(uid) {
  const trips = await getUserTrips(uid);
  return trips.filter(t => !t.paid).sort((a, b) => a.date.localeCompare(b.date));
}

// ── PAGAMENTOS (por usuário) ─────────────────────────────────

/**
 * Registra um pagamento de um usuário e marca as viagens dele como pagas.
 * @param {string} uid
 * @param {string} userName
 * @param {string[]} tripDates
 * @param {number} totalAmount - soma dos valores das viagens cobertas
 * @param {string|null} receiptData - comprovante em Base64 (data URL) ou null
 */
export async function registerPayment(uid, userName, tripDates, totalAmount, receiptData = null) {
  const paymentId = `pay_${Date.now()}`;

  // Operação atômica: tudo ou nada.
  const batch = writeBatch(db);

  batch.set(doc(db, "payments", paymentId), {
    id: paymentId,
    uid,
    userName,
    tripDates,
    totalAmount,
    receiptData,          // Base64 (data URL) ou null
    createdAt: Timestamp.now()
  });

  for (const date of tripDates) {
    batch.update(doc(db, "trips", tripId(uid, date)), { paid: true, paymentId });
  }

  await batch.commit();
  return paymentId;
}

/**
 * Pagamentos de um usuário (ordenados por data desc no JS).
 */
export async function getUserPayments(uid) {
  const q = query(collection(db, "payments"), where("uid", "==", uid));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data()).sort((a, b) => toMillis(b.createdAt) - toMillis(a.createdAt));
}

/**
 * Deleta um pagamento e desmarca as viagens associadas.
 */
export async function deletePayment(paymentId) {
  const paySnap = await getDoc(doc(db, "payments", paymentId));
  if (!paySnap.exists()) return;

  const payment = paySnap.data();

  // Desmarca as viagens do dono do pagamento
  for (const date of payment.tripDates) {
    try {
      await updateDoc(doc(db, "trips", tripId(payment.uid, date)), { paid: false, paymentId: null });
    } catch (e) { /* ignora viagens deletadas */ }
  }

  await deleteDoc(doc(db, "payments", paymentId));
}

// ── ADMIN (todos os usuários) ────────────────────────────────

/**
 * Todas as viagens de todos os usuários (painel admin).
 */
export async function getAllTrips() {
  const snap = await getDocs(collection(db, "trips"));
  return snap.docs.map(d => d.data());
}

/**
 * Todos os pagamentos de todos os usuários (painel admin).
 */
export async function getAllPayments() {
  const snap = await getDocs(collection(db, "payments"));
  return snap.docs.map(d => d.data());
}

/**
 * Todos os usuários cadastrados.
 */
export async function getAllUsers() {
  const q = query(collection(db, "users"), orderBy("createdAt", "desc"));
  const snap = await getDocs(q);
  return snap.docs.map(d => d.data());
}

/**
 * Apaga TODAS as viagens e pagamentos (limpeza de dados de teste).
 * Mantém usuários e configurações. Ação irreversível.
 * Deleta em lotes de 400 para respeitar o limite de 500 do writeBatch.
 * @returns {Promise<{trips:number, payments:number}>} quantidades apagadas
 */
export async function clearTripsAndPayments() {
  const counts = { trips: 0, payments: 0 };

  for (const coll of ["trips", "payments"]) {
    const snap = await getDocs(collection(db, coll));
    const docs = snap.docs;
    counts[coll] = docs.length;

    for (let i = 0; i < docs.length; i += 400) {
      const batch = writeBatch(db);
      for (const d of docs.slice(i, i + 400)) batch.delete(d.ref);
      await batch.commit();
    }
  }

  return counts;
}

// ── HELPERS ──────────────────────────────────────────────────

// Converte Firestore Timestamp | Date | número em milissegundos
export function toMillis(ts) {
  if (!ts) return 0;
  if (ts.toDate) return ts.toDate().getTime();
  const t = new Date(ts).getTime();
  return isNaN(t) ? 0 : t;
}
