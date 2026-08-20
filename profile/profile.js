// ============================================================
// MÓDULO: profile.js
// Tela "Meu Perfil": nome, foto, senha e estatísticas pessoais
// ============================================================

import { currentProfile, updateMyProfile, changeMyPassword } from "../auth/auth.js";
import { getUserTrips, getUserPayments, toMillis } from "../js/db.js";
import {
  showToast, formatCurrency, escapeHtml, compressImageToDataURL
} from "../js/utils.js";

const PHOTO_MAX_CHARS = 200 * 1024; // foto pequena (~200 KB)
let pendingPhoto = undefined;       // undefined = sem mudança; string = nova foto

// ── INIT ─────────────────────────────────────────────────────

export function initProfile() {
  document.getElementById("btn-profile")?.addEventListener("click", openProfile);
  document.getElementById("btn-save-profile")?.addEventListener("click", handleSaveProfile);
  document.getElementById("btn-change-pass")?.addEventListener("click", handleChangePassword);
  document.getElementById("profile-photo-input")?.addEventListener("change", handlePhotoSelect);
}

/**
 * Atualiza o avatar do cabeçalho com a foto (ou inicial) do usuário.
 */
export function updateHeaderAvatar(profile) {
  const el = document.getElementById("header-avatar-content");
  if (!el) return;
  if (profile?.photo) {
    el.innerHTML = `<img src="${profile.photo}" alt="Foto">`;
  } else {
    el.textContent = (profile?.name || "?").charAt(0).toUpperCase();
  }
}

// ── ABRIR ─────────────────────────────────────────────────────

async function openProfile() {
  pendingPhoto = undefined;

  document.getElementById("profile-name").value = currentProfile?.name || "";
  renderPhoto(currentProfile?.photo || null);
  renderRegistered();

  // limpa campos de senha
  document.getElementById("profile-new-pass").value  = "";
  document.getElementById("profile-new-pass2").value = "";
  document.getElementById("profile-pass-error").textContent = "";

  document.getElementById("modal-profile").classList.add("modal--open");

  await renderStats();
}

function renderRegistered() {
  const el = document.getElementById("profile-registered");
  if (!el) return;
  const ms = toMillis(currentProfile?.createdAt);
  el.textContent = ms
    ? `Registrado em ${new Date(ms).toLocaleDateString("pt-BR", { day: "2-digit", month: "long", year: "numeric" })}`
    : "";
}

function renderPhoto(dataUrl) {
  const el = document.getElementById("profile-photo");
  if (dataUrl) {
    el.innerHTML = `<img src="${dataUrl}" alt="Foto de perfil">`;
  } else {
    el.textContent = (currentProfile?.name || "?").charAt(0).toUpperCase();
  }
}

// ── ESTATÍSTICAS ──────────────────────────────────────────────

async function renderStats() {
  const setStat = (id, v) => { const e = document.getElementById(id); if (e) e.textContent = v; };
  setStat("stat-days", "…");
  setStat("stat-max-payment", "…");
  setStat("stat-max-unpaid", "…");

  try {
    const uid = currentProfile.uid;
    const [trips, payments] = await Promise.all([getUserTrips(uid), getUserPayments(uid)]);

    // Dias na plataforma
    const createdMs = toMillis(currentProfile.createdAt);
    const days = createdMs ? Math.max(0, Math.floor((Date.now() - createdMs) / 86400000)) : null;
    setStat("stat-days", days === null ? "—" : String(days));

    // Maior pagamento de uma vez
    const maxPay = payments.reduce((m, p) => Math.max(m, p.totalAmount || 0), 0);
    setStat("stat-max-payment", formatCurrency(maxPay));

    // Recorde de dias sem pagar (maior atraso entre a viagem e o pagamento;
    // viagens ainda em aberto contam até hoje)
    const payDateById = new Map();
    payments.forEach(p => payDateById.set(p.id, toMillis(p.createdAt)));

    let maxUnpaid = 0;
    const todayMs = Date.now();
    for (const t of trips) {
      const tripMs = new Date(t.date + "T12:00:00").getTime();
      // Viagem em aberto de um dia que ainda não chegou não conta (é agendada).
      if (!t.paid && tripMs > todayMs) continue;
      const endMs = t.paid ? (payDateById.get(t.paymentId) || tripMs) : todayMs;
      const d = Math.floor((endMs - tripMs) / 86400000);
      if (d > maxUnpaid) maxUnpaid = d;
    }
    setStat("stat-max-unpaid", String(Math.max(0, maxUnpaid)));
  } catch (e) {
    console.error("Erro nas estatísticas do perfil:", e);
    setStat("stat-days", "—");
    setStat("stat-max-payment", "—");
    setStat("stat-max-unpaid", "—");
  }
}

// ── FOTO ──────────────────────────────────────────────────────

async function handlePhotoSelect(e) {
  const file = e.target.files[0];
  if (!file) return;
  if (!file.type.startsWith("image/")) {
    showToast("Selecione uma imagem.", "error");
    return;
  }
  try {
    const data = await compressImageToDataURL(file, 256, PHOTO_MAX_CHARS, true);
    pendingPhoto = data;
    renderPhoto(data);
    showToast("Foto pronta. Clique em Salvar perfil.", "info");
  } catch (err) {
    showToast("Não foi possível processar a imagem.", "error");
  }
}

// ── SALVAR NOME/FOTO ──────────────────────────────────────────

async function handleSaveProfile() {
  const btn  = document.getElementById("btn-save-profile");
  const name = document.getElementById("profile-name").value.trim();
  if (!name) { showToast("Informe um nome.", "error"); return; }

  btn.disabled = true;
  btn.textContent = "Salvando...";
  try {
    const fields = { name };
    if (pendingPhoto !== undefined) fields.photo = pendingPhoto;

    const updated = await updateMyProfile(fields);
    pendingPhoto = undefined;

    // Atualiza cabeçalho
    const nameEl = document.getElementById("header-user-name");
    if (nameEl) nameEl.textContent = updated.name || "—";
    updateHeaderAvatar(updated);

    showToast("Perfil atualizado!", "success");
    document.getElementById("modal-profile").classList.remove("modal--open");
  } catch (e) {
    console.error(e);
    showToast("Erro ao salvar o perfil.", "error");
  } finally {
    btn.disabled = false;
    btn.textContent = "Salvar perfil";
  }
}

// ── TROCAR SENHA ──────────────────────────────────────────────

async function handleChangePassword() {
  const errorEl = document.getElementById("profile-pass-error");
  const p1 = document.getElementById("profile-new-pass").value;
  const p2 = document.getElementById("profile-new-pass2").value;
  errorEl.textContent = "";

  if (p1.length < 6) { errorEl.textContent = "A senha deve ter no mínimo 6 caracteres."; return; }
  if (p1 !== p2)     { errorEl.textContent = "As senhas não conferem."; return; }

  const btn = document.getElementById("btn-change-pass");
  btn.disabled = true;
  btn.textContent = "Trocando...";
  try {
    await changeMyPassword(p1);
    document.getElementById("profile-new-pass").value  = "";
    document.getElementById("profile-new-pass2").value = "";
    showToast("Senha alterada com sucesso!", "success");
  } catch (e) {
    if (e.code === "auth/requires-recent-login") {
      errorEl.textContent = "Por segurança, saia e entre novamente antes de trocar a senha.";
    } else if (e.code === "auth/weak-password") {
      errorEl.textContent = "Senha muito fraca.";
    } else {
      errorEl.textContent = "Não foi possível trocar a senha.";
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Trocar senha";
  }
}
