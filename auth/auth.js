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
  updatePassword,
  reauthenticateWithCredential,
  EmailAuthProvider
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  doc, setDoc, getDoc, updateDoc, serverTimestamp
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, firebaseConfig } from "../js/firebase-config.js";
import { showToast } from "../js/utils.js";
import { WORKER_URL } from "../js/config.js";

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

// O auto-cadastro cria a conta de login ANTES do documento de perfil, e
// createUserWithEmailAndPassword já dispara este listener no meio do
// caminho. Sem esperar, o listener leria um perfil que ainda não existe e
// mandaria o recém-cadastrado de volta para a tela de login.
let signupGate = null;

export function startAuthListener() {
  onAuthStateChanged(auth, async (firebaseUser) => {
    if (firebaseUser) {
      if (signupGate) await signupGate;

      currentUser    = firebaseUser;
      currentProfile = await fetchProfile(firebaseUser.uid);

      // Sem perfil (conta criada fora do app): cria um perfil comum,
      // ativo e sem grupo — que é o mesmo ponto de partida de quem se
      // cadastra pela tela de login.
      if (!currentProfile) {
        currentProfile = await createProfile(firebaseUser);
      }

      // Registra o próprio nome para login-por-nome (via Worker). Cada
      // usuário registra o SEU nome ao logar — é assim que a tabela se
      // popula, sem o cliente escrever direto na coleção.
      if (currentProfile?.name) {
        registerMyName(currentProfile.name);
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
// A coleção `usernames` agora é PRIVADA (A1/A4). O cliente não a lê nem
// escreve mais: a resolução nome→e-mail e o registro do nome passam pelo
// Worker, que guarda o e-mail fora do alcance público e grava só o slug
// do próprio usuário autenticado.

export function slugifyName(name = "") {
  return name
    .normalize("NFD").replace(/[̀-ͯ]/g, "") // remove acentos
    .trim().toLowerCase()
    .replace(/\s+/g, " ");
}

// Registra/atualiza o nome do PRÓPRIO usuário logado (via Worker).
// Idempotente; nunca bloqueia o fluxo se falhar.
export async function registerMyName(name) {
  if (!name || !currentUser) return;
  try {
    const idToken = await currentUser.getIdToken();
    await fetch(WORKER_URL + "/auth/register-name", {
      method:  "POST",
      headers: { Authorization: "Bearer " + idToken, "Content-Type": "application/json" },
      body:    JSON.stringify({ name })
    });
  } catch (e) { /* silencioso: login por nome é conveniência */ }
}

// Resolve um nome para o e-mail (via Worker, ANTES do login — sem token).
export async function emailFromName(name) {
  if (!name) return null;
  try {
    const res = await fetch(WORKER_URL + "/auth/resolve-name", {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ name })
    });
    if (!res.ok) return null;
    return (await res.json()).email || null;
  } catch (e) {
    return null;
  }
}

// ── PERFIL NO FIRESTORE ───────────────────────────────────────

export async function fetchProfile(uid) {
  const snap = await getDoc(doc(db, "users", uid));
  return snap.exists() ? snap.data() : null;
}

/**
 * Cria o perfil do PRÓPRIO usuário recém-autenticado.
 *
 * Nasce ATIVO e SEM GRUPO. Parece contraditório com o cuidado anterior
 * (tudo nascia inativo), mas o portão mudou de lugar: o que dá acesso a
 * dados agora é PERTENCER A UM GRUPO, não o campo `active`. Uma conta sem
 * grupo enxerga exatamente nada — as rules negam viagem, pagamento e perfil
 * de terceiro. `active:false` continua existindo como bloqueio manual do
 * ADM SUPREMO para banir alguém.
 */
export async function createProfile(firebaseUser, name = null) {
  const profile = {
    uid:       firebaseUser.uid,
    name:      name || firebaseUser.displayName || firebaseUser.email.split("@")[0],
    email:     firebaseUser.email,
    role:      "user",            // "admin" (ADM SUPREMO) | "user"
    active:    true,
    groupId:   null,              // grupo de carona ativo
    groupRole: null,              // "owner" | "member" | null
    groupIds:  [],                // todos os grupos de que participa
    groups:    [],                // [{ id, name, role }] — espelho p/ a tela
    createdAt: serverTimestamp()
  };
  await setDoc(doc(db, "users", firebaseUser.uid), profile);
  return profile;
}

// ── AUTO-CADASTRO ─────────────────────────────────────────────

/**
 * Cria conta e perfil para quem chegou sozinho na tela de login.
 *
 * Diferente de registerUser (que é o ADM SUPREMO cadastrando outra pessoa),
 * aqui o próprio usuário fica logado no fim — é ele que está no navegador.
 * Ele cai no app sem grupo e escolhe: criar o seu ou usar um convite.
 */
export async function signUpUser(name, email, password) {
  let release;
  signupGate = new Promise(resolve => { release = resolve; });

  try {
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: name });

    currentUser    = cred.user;
    currentProfile = await createProfile(cred.user, name);
    registerMyName(name);

    return currentProfile;
  } finally {
    // Libera o listener mesmo se algo falhar no meio — senão um erro
    // deixaria o app travado esperando um portão que nunca abre.
    signupGate = null;
    release();
  }
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
      // Nasce INATIVO. Ativar é um passo separado, no painel, e exige que
      // o admin redigite a senha — as rules conferem isso pelo auth_time.
      active:    false,
      groupId:   null,
      groupRole: null,
      groupIds:  [],
      groups:    [],
      createdAt: serverTimestamp()
    };
    // Gravado pelo db do app PRIMÁRIO (sessão do admin)
    await setDoc(doc(db, "users", cred.user.uid), profile);
    // O registro de nome para login-por-nome acontece quando o próprio
    // usuário faz o primeiro login (startAuthListener → registerMyName).
    // Até lá, ele entra pelo e-mail. O admin não escreve o nome de outro.

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

    // Registra o novo nome via Worker (self). Um eventual slug antigo fica
    // como órfão apontando para o próprio uid/e-mail — inofensivo, e o
    // cliente não pode mais apagá-lo (a coleção é privada).
    await registerMyName(fields.name);
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

// ── REAUTENTICAÇÃO (senha para ações sensíveis) ───────────────

/**
 * Confirma a identidade do usuário logado pedindo a senha de novo.
 *
 * O efeito importante não é o "true" devolvido aqui — é que o Firebase
 * renova o ID token com um `auth_time` novo. As security rules leem esse
 * campo para liberar a ativação de contas.
 *
 * Ou seja: a garantia é do servidor. Mesmo que alguém contorne esta
 * função no navegador, sem a senha o `auth_time` não muda e o Firestore
 * recusa a escrita.
 *
 * @param {string} password
 * @returns {Promise<boolean>}
 * @throws auth/wrong-password | auth/invalid-credential | auth/too-many-requests
 */
export async function reauthenticate(password) {
  if (!currentUser?.email) throw new Error("Não autenticado.");

  const credential = EmailAuthProvider.credential(currentUser.email, password);
  await reauthenticateWithCredential(currentUser, credential);

  // Força a emissão de um token novo já com o auth_time atualizado —
  // sem isto o cliente seguiria usando o token antigo em cache e a regra
  // recusaria a escrita mesmo com a senha correta.
  await currentUser.getIdToken(true);
  return true;
}

// ── GRUPO ATIVO ───────────────────────────────────────────────

/**
 * Recarrega o perfil do Firestore. Chamada depois de toda operação de
 * grupo — quem escreveu foi o Worker, então o objeto em memória está velho.
 */
export async function refreshProfile() {
  if (!currentUser) return null;
  currentProfile = await fetchProfile(currentUser.uid);
  return currentProfile;
}

/**
 * Troca o grupo ativo. Escrita direta do cliente, e mesmo assim segura: as
 * rules só aceitam um groupId que já esteja em `groupIds` (lista escrita
 * apenas pelo Worker, ao aceitar o convite) e recalculam o papel a partir
 * do dono do grupo. Dizer "sou owner" aqui não adianta nada.
 */
export async function setActiveGroup(groupId) {
  if (!currentUser) throw new Error("Não autenticado.");

  const entry = (currentProfile?.groups || []).find(g => g.id === groupId);
  const data  = groupId
    ? { groupId, groupRole: entry?.role || "member" }
    : { groupId: null, groupRole: null };

  await updateDoc(doc(db, "users", currentUser.uid), data);
  currentProfile = { ...currentProfile, ...data };
  return currentProfile;
}

// ── HELPERS ───────────────────────────────────────────────────

/** ADM SUPREMO: dono do software, enxerga e gerencia todos os grupos. */
export function isSuperAdmin() {
  return currentProfile?.role === "admin" && currentProfile?.active !== false;
}

/** Dono do grupo ATIVO: manda neste grupo e em mais nenhum. */
export function isGroupOwner() {
  return currentProfile?.groupRole === "owner" && !!currentProfile?.groupId;
}

/**
 * "Administra a tela que está vendo" — dono do grupo ou ADM SUPREMO.
 * É o teste que as abas usam para decidir entre a visão de passageiro e a
 * visão de quem gerencia. Os poderes de verdade continuam nas rules e no
 * Worker; aqui só se decide o que desenhar.
 */
export function isAdmin() {
  return isGroupOwner() || isSuperAdmin();
}

export function myGroupId() {
  return currentProfile?.groupId || null;
}

export function hasGroup() {
  return !!currentProfile?.groupId;
}

export function isLoggedIn() {
  return !!currentUser;
} 