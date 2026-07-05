# Token reconciliation — H10 ⇄ platform semantic tokens

The bridge that lets the two design languages become **one**. The H10 *look*
wins on **values**; the platform's existing semantic *names* win on **structure**.
Phase 1 implements this; this doc is the spec.

## The two systems

| | H10 (`/marketing/ads`) | Platform (`globals.css` + Tailwind) |
|---|---|---|
| Form | hardcoded hex in `.h10-*` CSS | CSS vars as space-separated RGB (alpha-ready) |
| Dark mode | none | `.dark` class flips vars |
| Coverage | the ads surface | ~290 pages, `components/ui`, `grid-lens` |

**Plan:** keep the platform's semantic var **names** (and the RGB-triplet format
so `/ <alpha>` keeps working), but **reset their values** to the H10 palette.
H10's `.h10-*` CSS then references `var(--name)` instead of hex. Both systems now
resolve to the same tokens.

> Format note: `globals.css` stores colors as `R G B` (e.g. `15 23 42`) so
> Tailwind can do `rgb(var(--x) / <alpha>)`. Every H10 hex below converts to that
> triplet in Phase 1.

## Color — text

| Semantic name | Current value | → H10 value | Role |
|---|---|---|---|
| `--text-primary` | `#0f172a` | **`#1c2530`** | body, labels |
| `--text-secondary` | `#475569` | **`#5b6573`** | secondary text |
| `--text-tertiary` | `#647492` | **`#8a93a1`** | muted, icons |
| `--text-disabled` | `#94a3b8` | **`#aeb6c2`** | disabled |
| `--text-link` | `#2563eb` | **`#1f6fde`** | links / primary |

## Color — surface & border

| Semantic name | Current | → H10 | Role |
|---|---|---|---|
| `--surface-canvas` | `#f8fafc` | **`#f4f6f9`** | page background |
| `--surface-card` | `#ffffff` | `#ffffff` | cards, modals (unchanged) |
| `--surface-sunken` | `#f1f5f9` | **`#f1f4f8`** | hover/inset wells |
| `--border-subtle` | `#e2e8f0` | **`#e6e9ee`** | nested dividers |
| `--border-default` | `#cbd5e1` | **`#d8dde4`** | grid lines |
| `--border-strong` | `#94a3b8` | **`#c2c9d3`** | section dividers |

## Color — brand / primary

| New/aliased name | H10 value | Role |
|---|---|---|
| `--color-primary` | **`#1f6fde`** | primary buttons, active nav, focus ring |
| `--color-primary-soft` | `#e7f0fd` / `#eef5ff` | selected/hover wash |
| focus ring | `0 0 0 2px rgb(31 111 222 / .12)` | input/control focus |

## Color — status (soft / line / strong triples)

| Status | soft (bg) | strong (text) | H10 source |
|---|---|---|---|
| success | `#dcfce7` / light green | **`#1a7f37`** / `#15a34a` | live dot, success pills |
| warning | `#fdf3d3` / `#fff3e6` | **`#c2410c`** / `#9a6700` | paused pills |
| danger | `#fde8e8` | **`#c0392b`** / `#e5484d` | alerts, nav badge |
| info | `#e7f0fd` | **`#1f6fde`** | suggestions, dry-run |

## Program / targeting badges (component tokens)

These are H10-specific and have no platform equivalent — they become **component
tokens** under `tokens/badges`:

| Badge | text | bg |
|---|---|---|
| Sponsored Products (SP) | `#6d28d9` | `#f3e8ff` |
| Sponsored Display (SD) | `#0e7490` | `#e0f2fe` |
| Sponsored Brands (SB) | `#b45309` | `#fef3c7` |
| Auto targeting (A) | `#134da3` | wash |
| Manual targeting (M) | `#7400bc` | wash |

## Non-color tokens

- **Type:** keep the platform's weight tokens (body 450 / label 550 / heading
  650) and `--font-sans`; **adopt H10's pixel sizes** (10–27px) into the scale.
  Note H10 uses `-webkit-font-smoothing: auto` (heavier) vs the app's
  `antialiased` — captured as a `--font-smoothing` token, decided in Phase 1.
- **Spacing:** adopt the H10 px scale (2/4/8/10/12/14/16/18/20/22/26/30).
- **Radius:** H10 6/7/8/10/12/14 mapped onto `sm/md/lg/xl`.
- **Shadow:** H10 box-shadows become `--shadow-card/menu/modal/rail`.
- **Motion / z-index / breakpoints:** reuse `lib/theme/index.ts` + Tailwind;
  add H10's 760/1320 breakpoints.

## Convergence rules

1. **Names are stable, values move.** Never invent a parallel name for an
   existing role — reset the existing one.
2. **H10 wins ties.** Where the two disagree on a value, the H10 look is canon.
3. **No raw hex post-Phase-1.** `ads.css` and every component reference `var()`.
4. **Dark-ready.** Each reset value gets a dark counterpart even if light ships
   first.
5. **Prove non-destructive.** After the swap, `/marketing/ads` must render
   pixel-identical (screenshot-diff gate).
