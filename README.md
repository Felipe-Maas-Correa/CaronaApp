<div align="center">

# CaronaApp

**Controle de caronas e pagamentos — dark, elegante e minimalista.**

Aplicação web para registrar viagens de carona, controlar quem pagou e quem está devendo,
com painel administrativo completo, avaliação de viagens e pagamento via PIX.

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=flat&logo=firebase&logoColor=black)

</div>

---

## Sobre o projeto

O **CaronaApp** nasceu de uma necessidade real: organizar a cobrança de caronas diárias
(um valor fixo por viagem) entre várias pessoas. Cada passageiro registra as caronas que
fez, acompanha o quanto deve e paga via PIX. O motorista tem uma visão completa de
todos, com relatórios por período.

Hoje o app é **multi-grupo**: qualquer pessoa cria a própria conta, monta o seu
**grupo de carona** e convida quem quiser. Cada grupo tem o seu valor por viagem,
a sua chave PIX e o seu administrador.

Foi construído com **JavaScript puro (ES Modules), sem frameworks nem build step** — o foco
foi arquitetura limpa, componentização por módulos e uma identidade visual **premium dark gold**
consistente. Todo o backend roda no plano **gratuito** do Firebase.

## Grupos de carona

O app gira em torno do **grupo**. Um grupo é uma turma que anda junto: tem um
**dono** (quem o criou, normalmente o motorista), um valor por viagem, uma chave
PIX e os seus passageiros.

- Qualquer pessoa **cria a própria conta** direto na tela de login.
- A conta nasce **sem grupo** — e sem grupo ela não lê nem escreve nada. O acesso
  vem de **criar um grupo** ou **aceitar um convite**.
- Convites são um **código de 8 caracteres** válido por 7 dias, que pode ser preso
  a um e-mail (só aquela pessoa entra) ou aberto (link compartilhável).
- Dá para participar de **vários grupos**, mas só um fica **ativo** por vez: é ele
  que define as viagens, os pagamentos e os passageiros que o app mostra. A troca
  fica no perfil e na tela **Meus grupos**.

### Dois níveis de administração

| | **ADM supremo** | **Dono do grupo** |
|---|---|---|
| Quem é | dono do software (`role: admin`) | quem criou o grupo (ou recebeu a posse) |
| Alcance | todos os grupos e todas as contas | **só o grupo dele** |
| Pode | promover outro admin supremo, ativar/desativar e excluir contas, ver todos os grupos | convidar e remover passageiros, marcar quem viajou, definir valor e PIX, aprovar comprovantes, passar a posse ou apagar o grupo |

## Funcionalidades

### Para o passageiro
- **Cadastro aberto** e **login** com e-mail (ou nome) e senha — Firebase Auth
- **Grupos** — criar, entrar por convite e alternar entre os seus
- **Calendário** para marcar as próprias caronas
- **Pagamentos via PIX** — chave do grupo, copiável com um toque
- **Comprovante** anexável (PDF) — comprimido e salvo em Base64
- **Avaliação da viagem** — nota de 0 a 5 estrelas + nível de velocidade
- **Perfil personalizável** — nome, foto, troca de senha, seleção de grupo e
  estatísticas pessoais (dias na plataforma, maior pagamento, recorde de dias sem pagar)

### Para o dono do grupo
- **Dashboard** do grupo por semana, mês, semestre, ano ou todo o histórico
- **Médias** por usuário, mensal e semanal + taxa de adimplência
- **Ranking por passageiro** e detalhe individual por período
- **Marcação de passageiros** — escolhe quem estava em cada viagem
- **Valor da viagem e chave PIX** configuráveis por grupo
- **Convites** — gerar, compartilhar e revogar
- **Aprovação de comprovantes** — a dívida só é quitada depois da conferência
- **Exportação de relatório** em CSV
- **Passar a posse** do grupo ou **apagá-lo**

### Para o ADM supremo
- Visão de **todos os grupos** com valores pagos e em aberto
- **Todas as contas**: promover/rebaixar admin do sistema, ativar/desativar, excluir
- **Adoção de dados antigos** — traz para um grupo o que existia antes dos grupos

## Segurança

O controle de acesso **não depende do cliente**: está nas
[**Security Rules do Firestore**](firestore.rules) e no
[**Worker**](worker/README.md), validados no servidor. Entre outras regras:

- Uma conta **sem grupo** não alcança viagem, pagamento nem perfil de terceiro —
  é isso que torna o cadastro aberto seguro
- Ninguém se auto-promove a admin do sistema, nem se reativa
- Trocar de grupo ativo só vale para grupo que já conste em `groupIds`, escrito
  apenas pelo Worker ao aceitar o convite; e o papel (dono/passageiro) é
  recalculado a partir de `groups/{id}.ownerUid` — dizer "sou dono" não adianta
- O dono de um grupo **não enxerga** os dados de outro grupo
- Contas desativadas são bloqueadas de fato (não só na interface)
- Criar grupo, convidar, entrar, remover membro e transferir posse passam pelo
  Worker: são operações que tocam vários documentos ao mesmo tempo

## Tecnologias

| Camada        | Ferramentas                                                        |
|---------------|--------------------------------------------------------------------|
| Front-end     | HTML5, CSS3 (custom properties), JavaScript (ES Modules)           |
| Backend       | Firebase **Authentication** + **Cloud Firestore**                  |
| Ícones/Fontes | Lucide, Google Fonts (DM Sans, DM Mono, Playfair Display, Noto Emoji) |

> **100% no plano gratuito:** os comprovantes e fotos de perfil são comprimidos e
> guardados em **Base64** no próprio documento do Firestore, dispensando o Firebase Storage.

## Estrutura

```
caronaapp/
├── index.html            # Shell do app + modais (tudo embutido)
├── firestore.rules       # Regras de segurança do Firestore
├── storage.rules         # Regras do Storage (bloqueado; não usamos)
├── css/                  # base, layout, components (variáveis do tema)
├── js/
│   ├── app.js            # Entry point: auth flow + grupo ativo + navegação
│   ├── firebase-config.js
│   ├── config.example.js # Modelo de credenciais (copie para config.js)
│   ├── db.js             # Operações no Firestore (escopadas por grupo)
│   ├── worker-api.js     # Chamadas ao Worker (pagamentos, grupos, contas)
│   └── utils.js          # Formatação, ícones, imagem, clipboard
├── auth/                 # Autenticação, login e cadastro
├── groups/               # Tela de grupos, convites e troca de grupo ativo
├── summary/              # Aba Resumo (dashboard do usuário)
├── calendar/             # Aba Calendário + avaliação
├── payments/             # Aba Pagamentos + PIX + comprovante
├── admin/                # Painel do grupo + administração do sistema
├── profile/              # Tela "Meu Perfil"
└── worker/               # Cloudflare Worker (service account)
    └── src/
        ├── index.js      # Rotas de conta e pagamento
        ├── groups.js     # Rotas de grupo e convite
        ├── http.js       # CORS, JSON, rate limit, verificação do token
        └── firebase.js   # Firestore/Auth REST com service account
```

## Como rodar

### Pré-requisitos
- Um projeto no [Firebase](https://console.firebase.google.com/) com **Authentication**
  (e-mail/senha) e **Cloud Firestore** habilitados.
- [VS Code](https://code.visualstudio.com/) com a extensão **Live Server** (ou qualquer
  servidor estático).

### Passos
1. **Clone** o repositório:
   ```bash
   git clone https://github.com/Felipe-Maas-Correa/CaronaApp.git
   cd CaronaApp
   ```
2. **Configure as credenciais** — copie o modelo e preencha com os seus dados:
   ```bash
   cp js/config.example.js js/config.js
   ```
   Edite `js/config.js` com a config do seu Firebase e a sua chave PIX.
3. **Publique as regras de segurança** no Console do Firebase:
   - Firestore → Regras → cole o conteúdo de [`firestore.rules`](firestore.rules)
   - Storage → Regras → cole o conteúdo de [`storage.rules`](storage.rules)
4. **Publique o Worker** — ele é obrigatório para pagamentos e grupos.
   Passo a passo em [`worker/README.md`](worker/README.md).
5. **Rode** com o Live Server (botão *Go Live*) e acesse `index.html`.
6. **Crie sua conta** na própria tela de login (aba *Criar conta*) e, em seguida,
   **crie o seu grupo de carona** — você já entra nele como dono.
7. Crie o **ADM supremo** (opcional, só se você quiser a visão de todos os grupos):
   no Firestore → Dados → coleção `users`, defina o campo `role` do seu usuário
   como `admin`.

> **Atualizando de uma versão sem grupos?** Depois de publicar as regras e o
> Worker, entre como ADM supremo, crie um grupo e use
> **Painel → Administração do sistema → "Adotar dados antigos neste grupo"**.
> Sem isso, as viagens e os pagamentos antigos (que não têm `groupId`) somem da
> visão de todo mundo menos a sua.

## Notas de arquitetura

- **Sem build:** módulos ES nativos importados direto no navegador — simples de servir e ler.
- **Componentização por pasta:** cada aba tem seu `.js`, `.css` e (quando aplicável) template.
- **Tema centralizado:** todas as cores/tipografia em CSS custom properties (`css/base.css`).
- **Defesa contra dev-server:** o loader remove scripts de auto-reload injetados em fragmentos.

---

<div align="center">
Feito com atenção aos detalhes.
</div>
