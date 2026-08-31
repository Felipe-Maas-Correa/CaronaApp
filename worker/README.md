# Worker administrativo — CaronaApp

Existe por **um** motivo: o SDK web do Firebase não permite que um usuário
apague a conta de login de outro. `deleteUser()` só apaga a própria. Apagar
a conta alheia exige o Admin SDK, que precisa de uma service account — logo,
servidor.

Sem isto, "excluir usuário" no painel só removia o perfil do Firestore. A
conta de login sobrevivia: o e-mail continuava ocupado e a pessoa ainda
conseguia autenticar.

Uma rota só: `POST /users/delete`.

---

## 1. Pré-requisitos

- Conta gratuita na [Cloudflare](https://dash.cloudflare.com/sign-up)
- Node.js

```bash
cd worker
npm install
```

## 2. Chave da service account

Console do Firebase → **Configurações do projeto → Contas de serviço →
Gerar nova chave privada**. Baixa um JSON; você usa dois campos: `client_email`
e `private_key`.

> 🔒 Esse arquivo dá acesso total ao projeto e **ignora as security rules**.
> Nunca versione, nunca mande por chat, nunca cole em site nenhum. Se vazar,
> revogue em **Contas de serviço → Gerenciar chaves**.

## 3. Configurar

```bash
npx wrangler login
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
```

| Segredo | O que é |
|---|---|
| `FIREBASE_CLIENT_EMAIL` | campo `client_email` do JSON |
| `FIREBASE_PRIVATE_KEY` | campo `private_key` **inteiro**, com `-----BEGIN PRIVATE KEY-----` e os `\n` |

Confira também `ALLOWED_ORIGIN` no `wrangler.toml` — é a allowlist de CORS.
Já vem com os domínios do app e o Live Server local.

## 4. Deploy

```bash
npx wrangler deploy
```

Anote a URL e coloque em `js/config.js`:

```js
export const WORKER_URL = "https://caronaapp-admin.SEU-SUBDOMINIO.workers.dev";
```

## 5. Publicar as regras

Cole `../firestore.rules` no Console (**Firestore → Regras**). Elas agora têm
`allow delete: if false` em `users` — a exclusão só existe pelo Worker.

---

## O que a rota verifica

`POST /users/delete`, corpo `{ "uid": "..." }`, header `Authorization: Bearer <idToken>`.

Antes de apagar qualquer coisa:

1. **Assinatura do ID token** conferida contra as chaves públicas do Google
   (`RS256`, mais `aud`, `iss` e `exp`). Ninguém inventa um uid de admin.
2. **`auth_time` recente** (3 min) — a senha precisa ter sido redigitada.
   Mesma janela do `recentlyAuthed()` das rules. Uma sessão sequestrada não
   consegue apagar contas sem a senha.
3. **Quem pediu é admin ativo** — lido do Firestore, não do que o cliente diz.
4. **Não é a própria conta** e o uid tem formato válido (não vira path traversal).

Depois, na ordem: conta de login → perfil → apelido do login-por-nome.

A ordem é deliberada. Se o perfil sumisse primeiro e o delete da conta
falhasse, sobraria uma conta capaz de logar e recriar o próprio perfil.
Matando o login antes, uma falha no meio deixa no máximo um perfil órfão —
visível no painel e sem ninguém atrás dele.

## Custo

Zero. Cloudflare Workers dá 100.000 requisições/dia no plano grátis; aqui são
algumas por mês.

## Manutenção

```bash
npx wrangler tail      # logs ao vivo
npx wrangler deploy    # publicar alterações
```
