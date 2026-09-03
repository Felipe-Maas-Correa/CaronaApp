# Worker administrativo — CaronaApp

Existe por **um** motivo: o SDK web do Firebase não permite que um usuário
apague a conta de login de outro. `deleteUser()` só apaga a própria. Apagar
a conta alheia exige o Admin SDK, que precisa de uma service account — logo,
servidor.

Sem isto, "excluir usuário" no painel só removia o perfil do Firestore. A
conta de login sobrevivia: o e-mail continuava ocupado e a pessoa ainda
conseguia autenticar.

Com o tempo o Worker virou o ponto único das operações que **as security
rules não conseguem cobrir sozinhas**:

- somar o valor real das viagens e marcar viagem paga só junto de um
  pagamento aprovado;
- resolver nome→e-mail no login;
- o ciclo de vida dos **grupos de carona** — cada operação mexe em vários
  documentos que precisam mudar juntos (grupo + perfil + convite), e as
  rules avaliam um documento por vez.

Rotas atuais (todas `POST`, todas verificam a assinatura do ID token):

| Rota | Quem | O quê |
|---|---|---|
| `/users/delete` | ADM SUPREMO + senha recente | apaga conta de login + perfil |
| `/payments/create` | dono (conta ativa) | cria pagamento **pendente** (não quita ainda) |
| `/payments/approve` | dono do grupo / ADM SUPREMO | confere o comprovante e marca as viagens pagas (F-01) |
| `/payments/reject` | dono do grupo / ADM SUPREMO | reabre as viagens em análise |
| `/payments/delete` | dono do pagamento, dono do grupo ou ADM SUPREMO | apaga o pagamento e reabre as viagens |
| `/auth/resolve-name` | anônima (pré-login) | nome → e-mail, com rate-limit (F-02) |
| `/auth/register-name` | dono (conta ativa) | registra o slug do próprio nome (F-03) |
| `/groups/create` | qualquer conta ativa | cria o grupo e deixa quem criou como **dono** (máx. 5 por pessoa) |
| `/groups/invite` | dono do grupo | gera convite (código de 8 caracteres, 7 dias, opcionalmente preso a um e-mail) |
| `/groups/revoke-invite` | dono do grupo | cancela um convite não usado |
| `/groups/join` | qualquer conta ativa | aceita o convite e entra no grupo |
| `/groups/leave` | membro (não o dono) | sai do grupo |
| `/groups/remove-member` | dono do grupo | tira alguém do grupo (o histórico fica) |
| `/groups/transfer` | dono do grupo | passa a posse para outro membro |
| `/groups/delete` | dono do grupo / ADM SUPREMO | apaga o grupo e desfaz o quadro de membros |
| `/admin/adopt-legacy` | ADM SUPREMO | adota num grupo os dados de antes dos grupos |

### Os dois níveis de administração

O Worker faz a distinção no servidor, lendo do Firestore — nunca do que o
cliente diz:

- **ADM SUPREMO** — `users/{uid}.role == 'admin'`. Dono do software: mexe em
  qualquer grupo e em qualquer conta.
- **DONO DO GRUPO** — `groups/{gid}.ownerUid == uid`. Manda **só** no grupo
  dele: convites, membros, aprovação de comprovante, valor e chave PIX.

`ownerUid` só muda por `/groups/transfer`, e `users.groupIds` (a prova de que
alguém participa de um grupo) só é escrito por estas rotas. As rules negam
escrita do cliente em `groups` e `invites`, então não há um segundo caminho.

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

### Checagem pós-deploy (F-04)

O Worker valida os segredos **no início de cada requisição** (`assertSecrets`).
Se algum faltar, ele responde **503 `{ "error": "Serviço mal configurado." }`**
de cara, em vez de estourar um erro opaco no meio da operação. Depois de
publicar, confirme que os segredos foram gravados:

```bash
npx wrangler secret list      # deve listar FIREBASE_CLIENT_EMAIL e FIREBASE_PRIVATE_KEY
```

Um `POST` a qualquer rota que volte 503 indica segredo faltando — rode os
`wrangler secret put` da seção 3 de novo.

## 5. Publicar as regras

Cole `../firestore.rules` no Console (**Firestore → Regras**). Elas têm
`allow delete: if false` em `users` e `allow write: if false` em `groups` e
`invites` — essas operações só existem pelo Worker.

## 6. Migrar uma instalação que já rodava

Antes dos grupos, viagens e pagamentos não tinham `groupId`. Com as regras
novas eles ficariam visíveis só para o ADM SUPREMO. Depois de publicar:

1. entre como ADM SUPREMO e **crie um grupo** (ou aceite um convite);
2. no painel, seção **Administração do sistema**, use
   **"Adotar dados antigos neste grupo"**.

A rota `/admin/adopt-legacy` varre `trips`, `payments` e `users` e adota nesse
grupo tudo que ainda não tem grupo. Contas criadas depois da atualização
**não** são varridas: elas gravam `groupIds: []` explicitamente, e é esse o
critério que separa "conta nova esperando convite" de "cadastro antigo".

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
