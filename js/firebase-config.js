// ============================================================
// MÓDULO: firebase-config.js
// Configuração e inicialização do Firebase
// ============================================================

import { initializeApp }  from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getFirestore }   from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { getAuth }        from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { firebaseConfig } from "./config.js";

// Re-exporta para quem precisa (ex.: auth.js cria uma instância secundária)
export { firebaseConfig };

const app = initializeApp(firebaseConfig);

export const db   = getFirestore(app);
export const auth = getAuth(app);