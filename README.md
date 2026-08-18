<div align="center">

# 🚗 CaronaApp

**Controle de caronas e pagamentos — dark, elegante e minimalista.**

Aplicação web para registrar viagens de carona, controlar quem pagou e quem está devendo,
com painel administrativo completo, avaliação de viagens e pagamento via PIX.

![HTML5](https://img.shields.io/badge/HTML5-E34F26?style=flat&logo=html5&logoColor=white)
![CSS3](https://img.shields.io/badge/CSS3-1572B6?style=flat&logo=css3&logoColor=white)
![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat&logo=javascript&logoColor=black)
![Firebase](https://img.shields.io/badge/Firebase-FFCA28?style=flat&logo=firebase&logoColor=black)

</div>

---

## ✨ Sobre o projeto

O **CaronaApp** nasceu de uma necessidade real: organizar a cobrança de caronas diárias
(um valor fixo por viagem) entre várias pessoas. Cada passageiro registra as caronas que
fez, acompanha o quanto deve e paga via PIX. O administrador (motorista) tem uma visão
completa de todos, com relatórios por período.

Foi construído com **JavaScript puro (ES Modules), sem frameworks nem build step** — o foco
foi arquitetura limpa, componentização por módulos e uma identidade visual **premium dark gold**
consistente. Todo o backend roda no plano **gratuito** do Firebase.

## 🎯 Funcionalidades

### Para o usuário
- 🔐 **Login** com e-mail e senha (Firebase Auth)
- 📅 **Calendário** para marcar as próprias caronas
- 💳 **Pagamentos via PIX** — chave copiável com um toque
- 🧾 **Comprovante** anexável (imagem/PDF) — comprimido e salvo em Base64
- ⭐ **Avaliação da viagem** — nota de 0 a 5 estrelas + nível de velocidade (🐢 / 🚗 / 🏎)
- 👤 **Perfil personalizável** — nome, foto, troca de senha e estatísticas pessoais
  (dias na plataforma, maior pagamento, recorde de dias sem pagar)

### Para o administrador
- 📊 **Dashboard** com totais por **semana, mês, semestre, ano** ou todo o histórico
- 📈 **Médias** por usuário, mensal e semanal + taxa de adimplência
- 🏆 **Ranking por usuário** e **detalhe individual** por período
- 🧑‍🤝‍🧑 **Marcação de passageiros** — o motorista escolhe quem estava em cada viagem
- 💰 **Valor da viagem configurável** — vale para as próximas marcações
- 📤 **Exportação de relatório** em CSV
- 🛠️ **Gestão de usuários** — promover/rebaixar, ativar/desativar, excluir

## 🔒 Segurança

O controle de acesso **não depende do cliente**: está nas
[**Security Rules do Firestore**](firestore.rules), validadas no servidor. Entre outras regras:

- Um usuário comum **não** pode se auto-promover a admin nem se reativar
- Cada um lê/escreve apenas as **próprias** viagens e pagamentos; o admin vê tudo
- Contas desativadas são bloqueadas de fato (não só na interface)
- Só o admin exclui viagens e gerencia usuários

## 🧰 Tecnologias

| Camada        | Ferramentas                                                        |
|---------------|--------------------------------------------------------------------|
| Front-end     | HTML5, CSS3 (custom properties), JavaScript (ES Modules)           |
| Backend       | Firebase **Authentication** + **Cloud Firestore**                  |
| Ícones/Fontes | Lucide, Google Fonts (DM Sans, DM Mono, Playfair Display, Noto Emoji) |

> **100% no plano gratuito:** os comprovantes e fotos de perfil são comprimidos e
> guardados em **Base64** no próprio documento do Firestore, dispensando o Firebase Storage.

## 📂 Estrutura

```
caronaapp/
├── index.html            # Shell do app + modais (tudo embutido)
├── firestore.rules       # Regras de segurança do Firestore
├── storage.rules         # Regras do Storage (bloqueado; não usamos)
├── css/                  # base, layout, components (variáveis do tema)
├── js/
│   ├── app.js            # Entry point: auth flow + navegação
│   ├── firebase-config.js
│   ├── config.example.js # Modelo de credenciais (copie para config.js)
│   ├── db.js             # Operações no Firestore
│   └── utils.js          # Formatação, ícones, imagem, clipboard
├── auth/                 # Autenticação e tela de login
├── summary/              # Aba Resumo (dashboard do usuário)
├── calendar/             # Aba Calendário + avaliação
├── payments/             # Aba Pagamentos + PIX + comprovante
├── admin/                # Painel administrativo
└── profile/              # Tela "Meu Perfil"
```

## 🚀 Como rodar

### Pré-requisitos
- Um projeto no [Firebase](https://console.firebase.google.com/) com **Authentication**
  (e-mail/senha) e **Cloud Firestore** habilitados.
- [VS Code](https://code.visualstudio.com/) com a extensão **Live Server** (ou qualquer
  servidor estático).

### Passos
1. **Clone** o repositório:
   ```bash
   git clone https://github.com/<seu-usuario>/caronaapp.git
   cd caronaapp
   ```
2. **Configure as credenciais** — copie o modelo e preencha com os seus dados:
   ```bash
   cp js/config.example.js js/config.js
   ```
   Edite `js/config.js` com a config do seu Firebase e a sua chave PIX.
3. **Publique as regras de segurança** no Console do Firebase:
   - Firestore → Regras → cole o conteúdo de [`firestore.rules`](firestore.rules)
   - Storage → Regras → cole o conteúdo de [`storage.rules`](storage.rules)
4. **Rode** com o Live Server (botão *Go Live*) e acesse `index.html`.
5. Crie o **primeiro admin**: no Firestore → Dados → coleção `users`, defina o campo
   `role` do seu usuário como `admin`.

## 📝 Notas de arquitetura

- **Sem build:** módulos ES nativos importados direto no navegador — simples de servir e ler.
- **Componentização por pasta:** cada aba tem seu `.js`, `.css` e (quando aplicável) template.
- **Tema centralizado:** todas as cores/tipografia em CSS custom properties (`css/base.css`).
- **Defesa contra dev-server:** o loader remove scripts de auto-reload injetados em fragmentos.

---

<div align="center">
Feito com ☕ e atenção aos detalhes.
</div>
