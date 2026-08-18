// ============================================================
// MÓDULO: app.js
// Ponto de entrada — auth flow + navegação entre abas
// ============================================================


import { startAuthListener, setAuthCallbacks, loginUser, logoutUser,
         isAdmin, currentProfile, isLoggedIn } from "../auth/auth.js";
import { initCalendar }  from "../calendar/calendar.js";
import { initPayments }  from "../payments/payments.js";
import { initSummary }   from "../summary/summary.js";
import { initProfile, updateHeaderAvatar } from "../profile/profile.js";
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
    const email    = document.getElementById("login-email").value.trim();
    const password = document.getElementById("login-password").value;

    btn.disabled    = true;
    btn.textContent = "Entrando...";

    try {
      await loginUser(email, password);
    } catch (err) {
      errorEl.textContent = translateLoginError(err.code);
      btn.disabled    = false;
      btn.textContent = "Entrar";
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
  };
  return map[code] || "Erro ao entrar. Verifique seus dados.";
}

// ── CONTROLA VISIBILIDADE
function showScreen(name) {
  const screens = getScreens();
  Object.values(screens).forEach(el => el?.classList.remove("screen--visible"));
  screens[name]?.classList.add("screen--visible");
}

// ── MONTA INTERFACE CONFORME PAPEL
function buildAppForProfile(profile) {
  const adminTab   = document.getElementById("nav-admin");
  const adminPanel = document.getElementById("tab-admin");

  if (profile?.role === "admin") {
    adminTab?.classList.remove("hidden");
    adminPanel?.classList.remove("hidden");
  } else {
    adminTab?.classList.add("hidden");
    adminPanel?.classList.add("hidden");
  }

  const headerName = document.getElementById("header-user-name");
  const headerRole = document.getElementById("header-user-role");
  if (headerName) headerName.textContent = profile?.name || "—";
  updateHeaderAvatar(profile);
  if (headerRole) {
    headerRole.innerHTML = profile?.role === "admin"
      ? `${icon("crown")} Admin`
      : `${icon("user")} Usuário`;
    headerRole.className  = `header-role ${profile?.role === "admin" ? "header-role--admin" : ""}`;
  }
}

// ── PREÇO NO CABEÇALHO
export function updateHeaderPrice() {
  const el = document.getElementById("header-price");
  if (el) el.textContent = `${formatCurrency(getTripValue())} por viagem`;
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
    // Carrega o valor da viagem antes de montar as telas
    await loadTripValue();
    updateHeaderPrice();
    initNavigation();
    bindLogout();
    initProfile();
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

// ── ENTRY POINT
setAuthCallbacks({
  onReady: async () => {
    if (isLoggedIn() && currentProfile) {
      if (currentProfile.active === false) {
        await logoutUser();
        showScreen("auth");
        document.getElementById("login-error").textContent =
          "Conta desativada. Fale com o administrador.";
        return;
      }
      await initApp(currentProfile);
      showScreen("app");
    } else {
      showScreen("auth");
    }
  },
  onChanged: async (user, profile) => {
    if (user && profile) {
      if (profile.active === false) {
        await logoutUser();
        showScreen("auth");
        return;
      }
      await initApp(profile);
      showScreen("app");
    } else {
      appInitialized = false;
      showScreen("auth");
      document.getElementById("btn-login").disabled    = false;
      document.getElementById("btn-login").textContent = "Entrar";
      document.getElementById("login-error").textContent = "";
    }
  }
});

initLoginForm();
startAuthListener();