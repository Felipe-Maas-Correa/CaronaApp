// ============================================================
// MÓDULO: auth.js
// Autenticação Firebase + gerenciamento de perfis e papéis
// ============================================================

import { initializeApp, deleteApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import {
  getAuth,
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
  updatePassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, updateDoc, deleteDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, firebaseConfig } from "../js/firebase-config.js";
import { showToast } from "../js/utils.js";

export const auth = getAuth();

// ── ESTADO GLOBAL ─────────────────────────────────────────────
export let currentUser    = null; // Firebase User
export let currentProfile = null; // { uid, name, email, role, createdAt }

// ── CALLBACKS ─────────────────────────────────────────────────
let onAuthReady   = null; // chamado 1x quando auth estado é resolvido
let onUserChanged = null; // chamado toda vez que user muda

export function setAuthCallbacks({ onReady, onChanged }) {
  onAuthReady   = onReady;
  onUserChanged = onChanged;
}

// ── LISTENER PRINCIPAL ────────────────────────────────────────
// FIX: antes onAuthReady e onUserChanged eram ambos chamados em todo ciclo
// do listener. Agora onAuthReady é chamado apenas na primeira resolução,
// e onUserChanged apenas nas mudanças subsequentes — evitando dupla execução
// do fluxo de inicialização do app.
let authReadyFired = false;

export function startAuthListener() {
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      currentUser    = firebaseUser;
      currentProfile = await fetchProfile(firebaseUser.uid);

      // Se não tem perfil ainda (primeiro login OAuth), cria como "user"
      if (!currentProfile) {
        currentProfile = await createProfile(firebaseUser, "user");
      }

      // Garante o registro na tabela de nomes (backfill para contas antigas).
      if (currentProfile?.name && currentProfile?.email) {
        saveUsername(firebaseUser.uid, currentProfile.name, currentProfile.email);
      }
    } else {
      currentUser    = null;
      currentProfile = null;
    }

    if (!authReadyFired) {
      authReadyFired = true;
      onAuthReady?.();
    } else {
      onUserChanged?.(currentUser, currentProfile);
    }
  });
}

// ── TABELA DE NOMES (login por nome) ──────────────────────────
// Coleção pública `usernames/{slug}` que liga um nome ao e-mail, para
// permitir login por nome (o Firebase Auth só autentica por e-mail).
// Contém apenas { email, uid, name }.

export function slugifyName(name = "") {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentos
    .trim().toLowerCase()
    .replace(/\s+/g, " ");
}

// Cria/atualiza o registro de nome do usuário (idempotente).
export async function saveUsername(uid, name, email) {
  const slug = slugifyName(name);
  if (!slug) return;
  try {
    await setDoc(doc(db, "usernames", slug), { uid, name, email }, { merge: true });
  } catch (e) { /* não bloqueia o fluxo se falhar */ }
}

// Resolve um nome para o e-mail correspondente (leitura pública, pré-login).
export async function emailFromName(name) {
  const slug = slugifyName(name);
  if (!slug) return null;
  const snap = await getDoc(doc(db, "usernames", slug));
  return snap.exists() ? (snap.data().email || null) : null;
}

// ── PERFIL NO FIRESTORE ───────────────────────────────────────

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

export async function createProfile(firebaseUser, role = "user") {
  const profile = {
    uid:       firebaseUser.uid,
    name:      firebaseUser.displayName || firebaseUser.email.split("@")[0],
    email:     firebaseUser.email,
    role,                         // "admin" | "user"
    active:    true,
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "users", firebaseUser.uid), profile);
  return profile;
}

// ── REGISTRAR ─────────────────────────────────────────────────

/**
 * @param {string} name
 * @param {string} email
 * @param {string} password
 * @param {"admin"|"user"} role - apenas admin pode definir "admin"
 *
 * FIX: createUserWithEmailAndPassword faz login automático como o novo
 * usuário, o que derrubava a sessão do admin. Para evitar isso, criamos o
 * usuário numa INSTÂNCIA SECUNDÁRIA do Firebase — a sessão do admin (app
 * primário) permanece intacta. O documento no Firestore continua sendo
 * gravado com as credenciais do admin (db primário).
 */
export async function registerUser(name, email, password, role = "user") {
  const secondaryApp  = initializeApp(firebaseConfig, `secondary-${Date.now()}`);
  const secondaryAuth = getAuth(secondaryApp);

  try {
    const cred = await createUserWithEmailAndPassword(secondaryAuth, email, password);
    await updateProfile(cred.user, { displayName: name });

    const profile = {
      uid:       cred.user.uid,
      name,
      email,
      role,
      active:    true,
      createdAt: serverTimestamp()
    };
    // Gravado pelo db do app PRIMÁRIO (sessão do admin)
    await setDoc(doc(db, "users", cred.user.uid), profile);
    await saveUsername(cred.user.uid, name, email); // permite login por nome

    await signOut(secondaryAuth);
    return { user: cred.user, profile };
  } finally {
    // Remove a instância secundária independentemente de sucesso/erro
    await deleteApp(secondaryApp).catch(() => {});
  }
}

// ── LOGIN ─────────────────────────────────────────────────────

export async function loginUser(identifier, password) {
  // Aceita nome OU e-mail. Se não tiver "@", tratamos como nome e buscamos
  // o e-mail na tabela pública `usernames`.
  let email = identifier;
  if (!identifier.includes("@")) {
    const found = await emailFromName(identifier);
    if (!found) {
      const err = new Error("Nome não encontrado.");
      err.code = "app/name-not-found";
      throw err;
    }
    email = found;
  }
  const cred = await signInWithEmailAndPassword(auth, email, password);
  return cred.user;
}

// ── LOGOUT ────────────────────────────────────────────────────

export async function logoutUser() {
  // FIX: NÃO resetar authReadyFired aqui. onAuthReady deve disparar só uma
  // vez (no carregamento). Ao deslogar, o listener deve cair em onUserChanged
  // (user=null), que é quem reseta o botão de login e limpa mensagens de erro.
  await signOut(auth);
}

// ── PERFIL DO PRÓPRIO USUÁRIO ─────────────────────────────────

/**
 * Atualiza nome e/ou foto do perfil do usuário logado.
 * @param {{name?: string, photo?: string|null}} fields
 */
export async function updateMyProfile(fields = {}) {
  if (!currentUser) throw new Error("Não autenticado.");
  const data = {};
  if (fields.name !== undefined)  data.name  = fields.name;
  if (fields.photo !== undefined) data.photo = fields.photo;

  await updateDoc(doc(db, "users", currentUser.uid), data);

  if (fields.name !== undefined) {
    try { await updateProfile(currentUser, { displayName: fields.name }); } catch { /* opcional */ }

    // Atualiza a tabela de nomes: cria o novo slug e remove o antigo (se mudou).
    const oldSlug = slugifyName(currentProfile?.name || "");
    const newSlug = slugifyName(fields.name);
    await saveUsername(currentUser.uid, fields.name, currentProfile?.email);
    if (oldSlug && oldSlug !== newSlug) {
      try { await deleteDoc(doc(db, "usernames", oldSlug)); } catch { /* ignora */ }
    }
  }

  currentProfile = { ...currentProfile, ...data };
  return currentProfile;
}

/**
 * Troca a senha do usuário logado.
 * Pode lançar auth/requires-recent-login se a sessão for antiga.
 */
export async function changeMyPassword(newPassword) {
  if (!currentUser) throw new Error("Não autenticado.");
  await updatePassword(currentUser, newPassword);
}

// ── HELPERS ───────────────────────────────────────────────────

export function isAdmin() {
  return currentProfile?.role === "admin";
}

export function isLoggedIn() {
  return !!currentUser;
} 