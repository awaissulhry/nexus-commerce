# Tokens

> **Phase 1 shipped the values.** The canonical palette lives in `../tokens/*.ts`
> (TS, for JS consumers) and `../styles/tokens.css` (the `--h10-*` CSS vars). This
> document defines the *model*; the values are in those files, and the 251→~70
> canonicalization is documented in `../studies/01-color-drift.md`. See
> `TOKEN-RECONCILIATION.md` for how H10's values map onto the platform's names.

## The three tiers

```
primitive  →  semantic  →  component
(raw scale)   (role)        (knob)
#1f6fde       --color-primary   --rail-active-bg
```

- **Primitive** — the raw palette/scale. Named by hue + step
  (`--h10-blue-600`). Not consumed directly by components.
- **Semantic** — what a thing *means*. Reuses the platform's existing names so
  H10 and the Tailwind app speak one language. **Components consume this tier.**
- **Component** — a last-resort knob for a value the semantic tier can't express.

## Categories

| Category | Examples (semantic) | Source |
|---|---|---|
| **Color — text** | `--text-primary/secondary/tertiary/disabled/inverse/link` | exists in `globals.css`; values reset to H10 |
| **Color — surface** | `--surface-canvas/card/raised/sunken/overlay` | exists; H10: canvas `#f4f6f9`, card `#fff` |
| **Color — border** | `--border-subtle/default/strong` | exists; H10: `#e6e9ee / #d8dde4 / #c2c9d3` |
| **Color — status** | `--status-{success,warning,danger,info}-{soft,line,strong}` | exists; H10 greens/ambers/reds/blues |
| **Color — brand/accent** | `--color-primary` (`#1f6fde`), targeting/program badges | H10 `ads.css` |
| **Typography** | family (`--font-sans`), size scale, weight (450/550/650), tracking | next/font + H10 sizes (10–27px) |
| **Spacing** | 2/4/8/10/12/14/16/18/20/22/26/30 px scale | H10 pixel values |
| **Radius** | sm 4 · md 6/7 · lg 8/10 · xl 12/14 (cards/modals) | H10 |
| **Shadow/elevation** | card / menu / modal / rail-hover | H10 box-shadows |
| **Motion** | duration fast 150 / base 200 / slow 300; ease-out | exists + H10 .12–.18s |
| **Z-index** | dropdown/sticky/drawer/modal/toast/popover | `lib/theme/index.ts` |
| **Breakpoints** | 760 / 1320 px (filter grid reflow) | H10 media queries |

## Reuse the existing semantic names

`globals.css` already defines `--text-*`, `--surface-*`, `--border-*`,
`--status-*` (as space-separated RGB for alpha). Phase 1 **resets their values**
to the H10 look rather than inventing parallel names — that's the convergence.
JS-side constants stay in `apps/web/src/lib/theme/index.ts`.

## Dark mode

H10 is light-only today; the rest of the app has dark mode (`.dark` class). The
token architecture is built **dark-ready**: the semantic tier can flip values
under `.dark` even though we ship light-first. Dark values are defined but only
enabled when a surface opts in — so we never paint into a corner.
