// ============================================================
// MODELO DE CONFIG — versionado (sem segredos reais)
// ------------------------------------------------------------
// Copie este arquivo para `config.js` (na mesma pasta) e
// preencha com as suas credenciais. O `config.js` está no
// .gitignore e não é enviado ao repositório.
// ============================================================

// Credenciais do Firebase (Web) — pegue no Console do Firebase:
// Configurações do projeto > Seus apps > SDK do Firebase (Config).
export const firebaseConfig = {
  apiKey:            "SUA_API_KEY",
  authDomain:        "SEU_PROJETO.firebaseapp.com",
  projectId:         "SEU_PROJETO",
  storageBucket:     "SEU_PROJETO.appspot.com",
  messagingSenderId: "000000000000",
  appId:             "1:000000000000:web:0000000000000000000000"
};

// Sua chave PIX (aleatória, e-mail, telefone, CPF/CNPJ...).
export const PIX_KEY = "SUA-CHAVE-PIX";

// URL do Worker administrativo. Nao e segredo: e um endpoint publico
// que valida o ID token do Firebase antes de fazer qualquer coisa.
// Usado apenas para apagar contas (o SDK web nao consegue fazer isso).
export const WORKER_URL = "https://caronaapp-admin.SEU-SUBDOMINIO.workers.dev";
