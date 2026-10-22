# Design system do CaronaApp

Regras para **tipografia, ícones, cores e camadas**. Valem para todo componente
novo. Antes de commitar, rode:

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
| Estilo de um componente | o CSS da pasta dele (`admin/admin.css`, …) |

`design-system.css` é carregado **por último** no `index.html`. Não crie
`<style>` embutido no HTML.

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
