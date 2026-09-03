// ============================================================
// MÓDULO: app.js
// Ponto de entrada — auth flow + grupo ativo + navegação entre abas
// ============================================================


import { startAuthListener, setAuthCallbacks, loginUser, signUpUser, logoutUser,
         isAdmin, isSuperAdmin, isGroupOwner, currentProfile, isLoggedIn } from "../auth/auth.js";
import { initCalendar, loadAndRender }  from "../calendar/calendar.js";
import { initPayments, loadPaymentsList }  from "../payments/payments.js";
import { initSummary, refreshSummary }   from "../summary/summary.js";
import { initProfile, updateHeaderAvatar } from "../profile/profile.js";
import {
  initGroupScreen, renderGroupScreen, loadGroupContext, setGroupChangeHandler,
  initInviteModal, groupName
} from "../groups/groups.js";
import { loadTripValue, getTripValue } from "./db.js";
import { showToast, icon, formatCurrency } from "./utils.js";

// FIX: initAdmin e loadUsersList são importados condicionalmente para evitar
// quebra silenciosa do Promise.all caso admin.js não exista ou tenha erros.
let initAdmin    = async () => {};
let loadUsersList = () => {};

try {
  const adminModule = await import("../admin/admin.js");
  initAdmin     = adminModule.initAdmin     ?? initAdmin;
  loadUsersList = adminModule.loadUsersList ?? loadUsersList;
} catch (e) {
  console.warn("admin.js não encontrado ou com erro — painel admin desabilitado.", e);
}

// ── TELAS
// CORREÇÃO: screens era um objeto definido uma única vez no carregamento do
// módulo. Se algum elemento ainda não estivesse no DOM nesse momento (ex:
// app-shell.html ainda sendo injetado via fetch), o querySelector retornava
// null e showScreen nunca conseguia manipular os elementos corretos.
// Solução: resolver os elementos em tempo de execução, dentro de showScreen.
function getScreens() {
  return {
    loading: document.getElementById("loading-screen"),
    auth:    document.getElementById("auth-screen"),
    group:   document.getElementById("group-screen"),
    app:     document.querySelector(".app")
  };
}

// ── NAVEGAÇÃO DAS ABAS
function initNavigation() {
  const navBtns = document.querySelectorAll(".nav-btn");
  const panels  = document.querySelectorAll(".tab-panel");

  navBtns.forEach(btn => {
    btn.addEventListener("click", () => {
      const target = btn.dataset.tab;
      navBtns.forEach(b => b.classList.remove("nav-btn--active"));
      panels.forEach(p  => p.classList.remove("tab-panel--active"));
      btn.classList.add("nav-btn--active");
      document.getElementById(target)?.classList.add("tab-panel--active");
      if (target === "tab-admin") loadUsersList();
    });
  });
}

// ── ALTERNAR ENTRAR / CRIAR CONTA
function initAuthTabs() {
  const tabLogin  = document.getElementById("tab-login");
  const tabSignup = document.getElementById("tab-signup");
  const formLogin  = document.getElementById("form-login");
  const formSignup = document.getElementById("form-signup");
  const footer     = document.getElementById("auth-footer-note");

  const show = (signup) => {
    tabLogin?.classList.toggle("auth-tab--active", !signup);
    tabSignup?.classList.toggle("auth-tab--active", signup);
    formLogin?.classList.toggle("hidden", signup);
    formSignup?.classList.toggle("hidden", !signup);
    if (footer) {
      footer.textContent = signup
        ? "Depois de criar a conta você escolhe: montar o seu grupo ou entrar com um convite."
        : "Crie sua conta e depois monte o seu grupo de carona — ou entre com o convite que recebeu.";
    }
    document.getElementById("login-error").textContent  = "";
    document.getElementById("signup-error").textContent = "";
  };

  tabLogin?.addEventListener("click",  () => show(false));
  tabSignup?.addEventListener("click", () => show(true));

  // Quem chegou por um link de convite quase sempre ainda não tem conta.
  if (new URLSearchParams(location.search).get("convite")) show(true);
}

// ── FORMULÁRIO DE LOGIN
function initLoginForm() {
  const form    = document.getElementById("form-login");
  const errorEl = document.getElementById("login-error");

  document.getElementById("btn-toggle-password")?.addEventListener("click", () => {
    const input = document.getElementById("login-password");
    input.type  = input.type === "password" ? "text" : "password";
    document.getElementById("btn-toggle-password").innerHTML =
      input.type === "password" ? icon("eye") : icon("eyeOff");
  });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const btn      = document.getElementById("btn-login");
    const identifier = document.getElementById("login-email").value.trim();
    const password   = document.getElementById("login-password").value;

    btn.disabled    = true;
    btn.textContent = "Entrando...";

    try {
      await loginUser(identifier, password);
    } catch (err) {
      errorEl.textContent = translateLoginError(err.code);
      btn.disabled    = false;
      btn.textContent = "Entrar";
    }
  });
}

// ── FORMULÁRIO DE CADASTRO
//
// O cadastro é aberto de propósito: a conta nasce sem grupo, e conta sem
// grupo não lê nem escreve nada (as rules garantem). O acesso de verdade
// vem de criar um grupo ou aceitar um convite.
function initSignupForm() {
  const form    = document.getElementById("form-signup");
  const errorEl = document.getElementById("signup-error");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";

    const btn   = document.getElementById("btn-signup");
    const name  = document.getElementById("signup-name").value.trim();
    const email = document.getElementById("signup-email").value.trim();
    const pass  = document.getElementById("signup-password").value;
    const pass2 = document.getElementById("signup-password2").value;

    if (name.length < 2)  { errorEl.textContent = "Informe seu nome."; return; }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      errorEl.textContent = "E-mail inválido. Confira o @ e o domínio."; return;
    }
    if (pass.length < 6)  { errorEl.textContent = "A senha precisa de ao menos 6 caracteres."; return; }
    if (pass !== pass2)   { errorEl.textContent = "As senhas não conferem."; return; }

    btn.disabled    = true;
    btn.textContent = "Criando...";
    try {
      await signUpUser(name, email, pass);
      showToast("Conta criada! Agora escolha o seu grupo.", "success");
      // O listener de auth assume daqui e leva para a tela de grupos.
    } catch (err) {
      errorEl.textContent = translateSignupError(err.code);
      btn.disabled    = false;
      btn.textContent = "Criar minha conta";
    }
  });
}

function translateLoginError(code) {
  const map = {
    "auth/user-not-found":     "Usuário não encontrado.",
    "auth/wrong-password":     "Senha incorreta.",
    "auth/invalid-email":      "E-mail inválido.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/too-many-requests":  "Muitas tentativas. Tente mais tarde.",
    "auth/user-disabled":      "Esta conta foi desativada.",
    "app/name-not-found":      "Nome não encontrado. Tente o e-mail.",
  };
  return map[code] || "Erro ao entrar. Verifique seus dados.";
}

function translateSignupError(code) {
  const map = {
    "auth/email-already-in-use":  "Este e-mail já tem conta. Tente entrar.",
    "auth/invalid-email":         "E-mail inválido.",
    "auth/weak-password":         "Senha muito fraca (mínimo 6 caracteres).",
    "auth/operation-not-allowed": "O cadastro por e-mail está desligado no Firebase.",
    "auth/too-many-requests":     "Muitas tentativas. Tente mais tarde.",
  };
  return map[code] || "Não foi possível criar a conta. Tente novamente.";
}

// ── CONTROLA VISIBILIDADE
function showScreen(name) {
  const screens = getScreens();
  Object.values(screens).forEach(el => el?.classList.remove("screen--visible"));
  screens[name]?.classList.add("screen--visible");
}

// ── MONTA INTERFACE CONFORME PAPEL
//
// Dois níveis de administração, dois rótulos diferentes:
//   • ADM SUPREMO  — dono do software, vê todos os grupos;
//   • DONO DO GRUPO — manda só no grupo dele.
// Os dois abrem a aba Admin; o que muda é o que ela carrega.
function buildAppForProfile(profile) {
  const adminTab   = document.getElementById("nav-admin");
  const adminPanel = document.getElementById("tab-admin");
  const canAdmin   = isAdmin();

  adminTab?.classList.toggle("hidden", !canAdmin);
  adminPanel?.classList.toggle("hidden", !canAdmin);

  // Se o usuário perdeu o acesso admin (trocou para um grupo onde é só
  // passageiro) e estava na aba Admin, volta para o Resumo.
  if (!canAdmin && adminPanel?.classList.contains("tab-panel--active")) {
    document.querySelector('.nav-btn[data-tab="tab-summary"]')?.click();
  }

  const headerName = document.getElementById("header-user-name");
  const headerRole = document.getElementById("header-user-role");
  if (headerName) headerName.textContent = profile?.name || "—";
  updateHeaderAvatar(profile);

  if (headerRole) {
    const label = isSuperAdmin() ? `${icon("crown")} Admin do sistema`
                : isGroupOwner() ? `${icon("crown")} Dono do grupo`
                : `${icon("user")} Passageiro`;
    headerRole.innerHTML = label;
    headerRole.className = `header-role ${canAdmin ? "header-role--admin" : ""}`;
  }

  updateHeaderPrice();
}

// ── SUBTÍTULO DO CABEÇALHO (grupo + preço)
export function updateHeaderPrice() {
  const el = document.getElementById("header-price");
  if (!el) return;
  const name = groupName();
  el.textContent = name
    ? `${name} • ${formatCurrency(getTripValue())} por viagem`
    : `${formatCurrency(getTripValue())} por viagem`;
}

// ── LOGOUT
function bindLogout() {
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    await logoutUser();
  });
}

// ── INIT COMPLETO DO APP
let appInitialized = false;

async function initApp(profile) {
  if (!appInitialized) {
    initNavigation();
    bindLogout();
    initProfile();
    initInviteModal();
    await Promise.all([
      initSummary(),
      initCalendar(),
      initPayments(),
      initAdmin()
    ]);
    appInitialized = true;
  }
  buildAppForProfile(profile);
}

// ── RECARREGA TUDO NO CONTEXTO DO NOVO GRUPO
//
// Trocar de grupo troca o conjunto inteiro de dados: viagens, pagamentos,
// passageiros, valor da viagem e chave PIX. Em vez de tentar remendar cada
// aba, recarregamos todas — é o mesmo custo de uma abertura normal.
async function reloadForGroup() {
  await loadGroupContext();

  if (!currentProfile?.groupId) {
    await enterGroupScreen();
    return;
  }

  await initApp(currentProfile);
  showScreen("app");

  await Promise.all([
    refreshSummary(),
    loadAndRender(),
    loadPaymentsList(),
    isAdmin() ? loadUsersList() : Promise.resolve()
  ]);
}

async function enterGroupScreen() {
  initGroupScreen();
  showScreen("group");
  await renderGroupScreen();
}

// ── PORTÃO DE ENTRADA
//
// O login é e-mail + senha, como sempre. Depois dele vem um segundo portão:
// SEM GRUPO, o app não abre — cai na tela de grupos. Não é enfeite de
// interface: uma conta sem grupo não consegue ler nem escrever nada pelas
// security rules, então não haveria o que mostrar.
async function gateAndEnter(profile) {
  // Conta bloqueada pelo ADM SUPREMO — ou cadastrada por ele e ainda não
  // liberada (esse fluxo cria a conta já inativa, de propósito).
  if (profile.active === false) {
    await logoutUser();
    showScreen("auth");
    document.getElementById("login-error").textContent =
      "Conta desativada ou aguardando liberação do administrador.";
    return;
  }

  await loadTripValue();     // padrão do sistema (fallback)
  await loadGroupContext();  // valor e PIX do grupo ativo

  if (!profile.groupId) {
    await enterGroupScreen();
    return;
  }

  await initApp(profile);
  showScreen("app");
}

// ── ENTRY POINT
setGroupChangeHandler(reloadForGroup);

setAuthCallbacks({
  onReady: async () => {
    if (isLoggedIn() && currentProfile) {
      await gateAndEnter(currentProfile);
    } else {
      showScreen("auth");
    }
  },
  onChanged: async (user, profile) => {
    if (user && profile) {
      await gateAndEnter(profile);
    } else {
      appInitialized = false;
      showScreen("auth");
      document.getElementById("btn-login").disabled    = false;
      document.getElementById("btn-login").textContent = "Entrar";
      document.getElementById("btn-signup").disabled    = false;
      document.getElementById("btn-signup").textContent = "Criar minha conta";
      document.getElementById("login-error").textContent  = "";
      document.getElementById("signup-error").textContent = "";
    }
  }
});

initAuthTabs();
initLoginForm();
initSignupForm();
startAuthListener();
