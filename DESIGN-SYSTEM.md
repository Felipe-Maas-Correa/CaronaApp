# Design system do CaronaApp

Regras para **componentes, tipografia, ícones, cores e camadas**. Valem para
todo código de interface. O catálogo visual, com cada componente funcionando e
o código pronto para copiar, é o **guia de estilo**:

```bash
py -m http.server 5173
```

e abra `http://localhost:5173/guia/` (só existe no desenvolvimento; não vai
para o Firebase Hosting). Antes de commitar, rode:

```bash
node tools/audit-ui.js
```

Ele reprova (código de saída 1) qualquer coisa fora do padrão abaixo.

---

## Onde mora cada coisa

| O quê | Arquivo |
|---|---|
| Cores, raios, sombras, fontes (`--font-*`) | `css/base.css` (`:root`) |
| Escala tipográfica, tamanhos de ícone, camadas, cor-sobre-cor | `css/design-system.css` |
| Desenhos dos ícones | `js/icons.js` |
| **Componentes** (botão, selo, campo, card, número, avatar, lista…) | `css/components.css` |
| Montadores de componente no JS (`avatar()`, `emptyState()`, `badge()`) | `js/ui.js` |
| Catálogo visual dos componentes | `guia/index.html` |
| Classes aposentadas (antes → agora) | `guia/aposentadas.json` |
| Layout de uma tela e peças só dela | o CSS da pasta dela (`admin/admin.css`, …) |
| Layout de computador (≥ 1024px) | `css/desktop.css` |

`design-system.css` é carregado depois dos CSS de tela e `desktop.css` por
último no `index.html`. Não crie `<style>` embutido no HTML.

---

## Componentes — puxe do guia

Botão, selo, campo, card, número, avatar, lista e afins **só existem em
`css/components.css`**. Tela nova monta a interface com essas classes; o CSS
da pasta dela cuida só de **layout** (posição, `margin`, `grid`) e das peças
que só existem nela (o dia do calendário, o gráfico do Admin).

| Componente | Classe base | Variantes principais |
|---|---|---|
| Card | `.card` | `--accent` `--debt` `--elevated` `--dashed` `--interactive` `--flush`, `.card__title` |
| Botão | `.btn` | tom `--primary` `--secondary` `--ghost` `--soft` `--danger` `--link` · tamanho `--xs` `--sm` `--lg` · `--full` `--pill` · `.is-active` |
| Botão-ícone | `.btn-icon` | `--sm` `--lg` `--round` `--accent` `--danger` `--danger-solid` |
| Linha de botões | `.btn-row` | botões dividem a largura (no lugar de `style="flex:1"`) |
| Segmentado | `.seg` › `.seg__btn` | `.seg__btn--active`, `.seg--soft` |
| Título de seção | `.section-title` | `.section-head` (com ação), `.section-hint`, `.section-count` |
| Selo | `.badge` | `--muted` `--accent` `--outline` `--solid` `--debt` `--debt-outline` `--lg` |
| Formulário | `.form-group` › `.form-label` + `.form-input` | `.form-select`, `.form-input--code`, `.input-wrap` + `.input-eye`, `.input-group` (`__affix`, `__input`, `--lg`) |
| Número (KPI) | `.stat` › `.stat__value` + `.stat__label` | `--paid` `--debt` `--accent` `--highlight` `--sm` `--center` `--elevated`; grade `.stat-grid` (`--3`) |
| Avatar | `.avatar` | `--xs` `--sm` `--lg` `--square` `--accent` `--ring` `--photo` |
| Lista | `.list` › `.list-item` | `.list--elevated` |
| Estado vazio | `.empty-state` | `--compact` |
| Toast / carregando | `showToast()` / `.loading-spinner` | `success` `error` `info` |

**Compor, não copiar.** Quem tem layout próprio soma a classe do guia:
`class="card payment-card"` — o `.card` dá fundo, borda e raio; a
`.payment-card` só o espaçamento e o conteúdo.

**No JS**, use os montadores em vez de escrever o markup na mão:

```js
import { avatar, emptyState, badge } from "../js/ui.js";

avatar({ name: u.name, photo: u.photo })            // foto validada ou inicial, cor pelo nome
avatar({ name, photo, size: "sm", tint: false })
emptyState("wallet", "Nenhum pagamento registrado ainda.")
emptyState("", "Nenhum convite em aberto.", { compact: true })
badge("Em análise", "accent", "clock")
```

**Falta um componente?** Crie em `css/components.css` (com o comentário de
variantes), mostre em `guia/index.html` e só então use na tela. Não crie
variação local na pasta da tela.

O linter reprova:

- classe de `guia/aposentadas.json` em qualquer CSS, HTML ou JS;
- componente do guia redefinido na raiz fora de `components.css` (ex.:
  `.btn--meu { … }` em `admin.css`). Por contexto pode: `.hub-hero .btn { position: relative; }`.

---

## Tipografia

### Famílias — sempre pelo token

| Token | Fonte | Uso |
|---|---|---|
| `--font-serif` | Playfair Display | títulos, valores em dinheiro, números de destaque |
| `--font-display` | DM Sans | corpo, botões, nomes |
| `--font-mono` | DM Mono | labels em caixa-alta, chaves, códigos, datas |

### Tamanhos — só degraus da escala

| Token | Valor | Uso típico |
|---|---|---|
| `--fs-3xs` | .5rem | selo dentro do dia do calendário (exceção de espaço) |
| `--fs-2xs` | .6rem | labels em caixa-alta (DM Mono), badges |
| `--fs-xs` | .68rem | legendas, metadados |
| `--fs-sm` | .75rem | texto secundário |
| `--fs-md` | .85rem | **corpo padrão** |
| `--fs-base` | .92rem | títulos de card, nomes |
| `--fs-lg` | 1.05rem | destaques, inputs grandes |
| `--fs-xl` | 1.2rem | título de sheet/modal |
| `--fs-2xl` | 1.45rem | título de tela, valor de KPI |
| `--fs-3xl` | 1.7rem | título de página |
| `--fs-4xl` | 2.25rem | números de destaque |
| `--fs-5xl` | 3rem | número-herói |

Precisa de um tamanho que não existe? Use o degrau mais próximo. Se nenhum
serve, discuta antes de criar um degrau novo — 12 já é bastante.

### Papéis prontos (prefira estes a montar fonte na mão)

| Classe | Combinação |
|---|---|
| `.t-display` | Playfair · 3xl · bold — título de página |
| `.t-title` | Playfair · 2xl · bold — título de tela |
| `.t-value` | Playfair · 2xl · bold — dinheiro / número de KPI |
| `.t-heading` | DM Sans · base · semibold — título de card |
| `.t-body` | DM Sans · md — texto corrido |
| `.t-small` | DM Sans · sm · cor apagada — texto secundário |
| `.t-label` | DM Mono · 2xs · CAIXA-ALTA · espaçado · apagado — rótulo |
| `.t-mono` | DM Mono · sm — chave PIX, código de convite |

```html
<div class="t-label">Recebido</div>
<div class="t-value">R$ 345,00</div>
```

Pesos: `--fw-regular` 400 · `--fw-medium` 500 · `--fw-semibold` 600 · `--fw-bold` 700.

---

## Ícones

Todos vêm de **`js/icons.js`**, desenhos no padrão [Lucide](https://lucide.dev)
(traço, sem preenchimento). **Nada de `<svg>` colado no HTML ou no JS** e
**nada de emoji** na interface.

### Usar

```html
<!-- HTML estático: trocado por <svg> no boot (hydrateIcons, em app.js) -->
<i data-icon="settings"></i>
<i data-icon="chevron-right" class="set-item__chev"></i>
```

```js
// JS (templates)
import { icon } from "../js/utils.js";   // ou "../js/icons.js"
`<button>${icon("trash")} Remover</button>`
icon("x", "ic-lg")                        // com classe extra
```

Nome errado vira ícone vazio **e** um aviso no console (`[icons] ícone inexistente`).

### Adicionar um ícone novo

1. Procure no [lucide.dev](https://lucide.dev) e copie o SVG.
2. Em `js/icons.js`, cole **só o conteúdo interno** do `<svg>` (os `<path>`,
   `<circle>`…) usando **o mesmo nome do Lucide** (kebab-case):
   ```js
   "map-pin": '<path d="M20 10c0 6-8 12-8 12…"/><circle cx="12" cy="10" r="3"/>',
   ```
3. Não traga `width`, `height`, `stroke` nem `class` do SVG copiado: isso é do CSS.

Ícones disponíveis hoje: `alert`, `arrow-down`, `arrow-up`, `banknote`,
`bar-chart`, `calendar`, `car`, `check`, `chevron-down`, `chevron-left`,
`chevron-right`, `chevron-up`, `clock`, `copy`, `credit-card`, `crown`,
`external-link`, `eye`, `eye-off`, `file`, `file-text`, `info`, `lock`,
`log-in`, `log-out`, `logo`, `mail`, `paperclip`, `plus`, `search`,
`settings`, `sort`, `star`, `trash`, `unlock`, `user`, `users`, `wallet`, `x`.

### Tamanho e traço

O padrão de todo ícone é **16px, traço 2, cor do texto** (`currentColor`).
Para mudar, use as classes ou os tokens — nunca px solto:

| Classe | Token | Tamanho | Uso |
|---|---|---|---|
| `.ic-xs` | `--ic-xs` | 12px | dentro de badge / texto pequeno |
| `.ic-sm` | `--ic-sm` | 14px | ao lado de legenda |
| `.ic-md` | `--ic-md` | 16px | **padrão**, botões e ações |
| `.ic-lg` | `--ic-lg` | 18px | botão-ícone, cabeçalho |
| `.ic-xl` | `--ic-xl` | 22px | navegação inferior, tiles |
| `.ic-2xl` | `--ic-2xl` | 28px | upload, estrelas |
| `.ic-3xl` | `--ic-3xl` | 40px | estado vazio |
| — | `--ic-hero` | 52px | logo das telas de entrada |

Traços: `--ic-stroke-bold` 2.4 (ícone pequeno que precisa de peso: `+`,
setinhas) · `--ic-stroke` 2 (padrão) · `--ic-stroke-light` 1.75 ·
`--ic-stroke-thin` 1.5 (ícones grandes).

Se o tamanho é do componente, defina no CSS dele com o token:

```css
.meu-botao svg { width: var(--ic-lg); height: var(--ic-lg); }
```

A cor sai do `color` do elemento pai — mude a cor do botão, não a do ícone.
Em botão, ícone **antes** do texto ganha margem à direita; ícone **depois** do
texto ganha margem à esquerda automaticamente.

---

## Cores

Use só os tokens de `css/base.css` e `css/design-system.css`:

| Token | Uso |
|---|---|
| `--bg`, `--bg-card`, `--bg-elevated`, `--bg-hover`, `--bg-subtle` | fundos, do mais fundo ao mais alto |
| `--accent`, `--accent-soft`, `--accent-dim`, `--accent-border`, `--border-gold` | dourado e variações |
| `--paid` | positivo / pago (dourado) |
| `--debt`, `--debt-dim` | dívida / ação destrutiva — **só** quando é dívida ou perigo |
| `--text`, `--text-muted`, `--text-dim` | texto, do mais forte ao mais apagado |
| `--border`, `--border-light` | bordas neutras |
| `--on-accent` | texto/ícone **sobre** fundo dourado |
| `--on-debt` | texto/ícone **sobre** fundo vermelho |

Nada de hex solto (`#fff`, `#0f0f0f`…) fora desses arquivos.

---

## Movimento

Movimento **confirma o que a pessoa fez**: aperto no toque, aba que entra do
lado para onde se navegou, lista que chega em cascata, número que conta até o
valor novo, formulário que balança no erro. Nada se mexe sozinho sem motivo.

| O quê | Onde |
|---|---|
| Duração e curva: `--dur-fast` 120ms · `--dur` 220ms · `--dur-slow` 380ms · `--stagger` 45ms · `--ease-out` · `--ease-spring` · `--ease-in-out` | `css/design-system.css` |
| Todas as animações (`@keyframes` **só aqui**) e as respostas ao toque | `css/motion.css` |
| Eventos: onda do toque, direção da aba, cascata, segmentado, contagem, tremida, vibração | `js/motion.js` (ligado no boot) |

Quem usa os componentes do guia já ganha o movimento. A tela só precisa de:

- `data-stagger` no container que o JS preenche (lista em cascata).
  `data-stagger=".list"` anima os filhos de um elemento interno;
  `data-stagger-grid` é a versão rápida para grades; `data-stagger-key="#id"`
  só anima quando o texto de `#id` mudou (ex.: o mês do calendário).
- Números em `.stat__value` (ou `.summary-hero__amount`,
  `.received-card__value`, `.stat-rate__num`) contam sozinhos. O texto final é
  sempre o que a tela escreveu, mesmo com a aba em segundo plano.
- Erro escrito em `.auth-error` / `.error-msg` faz o formulário balançar.
- `.m-pop` para uma batida de confirmação pontual.

**Reduzir movimento:** com a opção do sistema ligada, tudo fica instantâneo
(só o carregando continua girando).

**Observador de DOM sem laço:** dentro de um `MutationObserver`, só escreva no
DOM o que mudou. `classList.add()` regrava o atributo mesmo quando a classe já
existe e dispara o observador de novo (foi assim que o segmentado travou a
página durante o desenvolvimento).

O linter reprova `@keyframes` fora de `css/motion.css`. Exemplos funcionando:
guia de estilo › Movimento.

---

## Camadas (z-index)

Ordem fixa — use o token, nunca um número:

| Token | Valor | O quê |
|---|---|---|
| `--z-raised` | 10 | overlay local dentro de um card |
| `--z-nav` | 100 | barra de navegação inferior |
| `--z-screen` | 190 | tela de grupos sobre o app |
| `--z-sheet` | 200 | bottom-sheets |
| `--z-auth` | 200 | tela de login |
| `--z-drawer` | 210 | drawer lateral |
| `--z-modal` | 220 | modais / confirmações — **acima** de sheet e drawer |
| `--z-toast` | 9000 | avisos |
| `--z-loading` | 9999 | tela de carregamento |

---

## Checklist de componente novo

- [ ] Botões, selos, campos, cards, números, avatares e listas do guia
      (`css/components.css`); o CSS da tela só faz layout
- [ ] Avatar e estado vazio no JS por `avatar()` / `emptyState()` de `js/ui.js`
- [ ] Componente novo também aparece em `guia/index.html`
- [ ] Lista preenchida por JS tem `data-stagger`; animação nova só em `css/motion.css`
      com os tokens `--dur-*` / `--ease-*`
- [ ] Fontes por `--font-*` e tamanhos por `--fs-*` (ou classe `.t-*`)
- [ ] Ícones por `icon()` / `data-icon`, tamanho por `.ic-*` ou `--ic-*`
- [ ] Cores e camadas por token
- [ ] Sem `style=""` novo, sem `<style>`, sem `<svg>` colado, sem emoji
- [ ] IDs únicos (um `id` repetido faz o `getElementById` pegar o elemento errado)
- [ ] Coluna única, sem rolagem horizontal no celular. Colunas/grades para o
      computador só em `css/desktop.css` (`@media (min-width: 1024px)`)
- [ ] `node tools/audit-ui.js` passando

---

## Exceções conhecidas

Marcadas com `ui-audit: allow` no código, para o linter não reclamar:

- **Avaliação de velocidade da viagem** (`calendar.js`, `calendar.css`): usa os
  glifos 🐢 🚗 🏎 em fonte **Noto Emoji** monocromática. Candidata a migrar
  para ícones (`turtle`, `car`, `gauge` do Lucide) — o que também tiraria o
  download da fonte Noto Emoji de todas as páginas.
- **Logo da tela de carregamento** (`index.html`): único `<svg>` direto no HTML,
  porque precisa aparecer antes de qualquer JavaScript rodar.
- **Símbolos tipográficos** `✓ ★ ● • ·` são permitidos (monocromáticos).

Dívida conhecida (o linter mostra como aviso; não aumente): atributos
`style=""` antigos no `index.html`.
