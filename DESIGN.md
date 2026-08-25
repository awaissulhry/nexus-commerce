# Design tokens

The token vocabulary for `apps/web`. Read this before writing any colour, size, spacing or
radius — in a stylesheet or an inline style.

**Source of truth:** `apps/web/src/design-system/tokens/*.ts`.
**Emitted to CSS by:** `npm run tokens:gen` → `styles/tokens.css` + `styles/tokens-global.css`.
Both are **generated — never hand-edit them.** `npm run tokens:check` runs in `.githooks/pre-push`
and fails the push if they are stale.

---

## 🔴 Read this first: the same names mean two different things

`--text-*`, `--surface-*` and `--border-*` are defined **twice** in this codebase:

| where | form | how to use it |
|---|---|---|
| `app/globals.css`, `app/marketing/ads/ads.css` | RGB **channels** — `15 23 42` | `rgb(var(--text-primary))` — Tailwind composes these with `<alpha-value>` |
| `design-system/styles/tokens.css` | whole **colours** — `#1c2530` | `var(--text-primary)` |

Used the wrong way round, the declaration is **invalid and silently dropped** — no error, no
warning. A border becomes `0px`, a background becomes transparent, a colour inherits.

**This is not a load-order problem.** Custom properties resolve from the nearest defining
**ancestor**, not by source order. `.h10-shell` is a descendant of `:root`, so inside the ads
console its channel definitions shadow the DS's. Reordering imports cannot fix it. 285 design-system
declarations were dead this way for months.

**The rule that avoids all of it: in design-system code, use `--nds-*` and nothing else.**
`--nds-*` is DS-owned, no other stylesheet redefines it, it is a real colour in every scope, and
`.dark` already overrides it. `token-guard` check D enforces this. Full account:
`design-system/docs/PHASE-9-0B-TOKEN-FORM.md`.

## Which stylesheet you get depends on the route

| route | token sheet | aliases available? |
|---|---|---|
| everything (root layout) | `tokens-global.css` | **no** — deliberately withheld |
| `/marketing/ads` | `tokens.css` | yes |

The root layout loads the whole DS (`tokens-global.css` + `primitives` + `components` + `patterns`
+ `a11y`), so DS components render styled on every route without a page importing anything.

---

## Colour

Three tiers. **Components consume tier 2. Only tier 2 may reference tier 1.**

**Tier 1 — primitive ramps** (122 tokens): `--nds-white`, `--nds-grey-{25…900}`,
`--nds-blue-{50…900}`, `--nds-green-*`, `--nds-red-*`, `--nds-amber-*`, `--nds-purple-*`,
`--nds-cyan-*`. Numbered ramps are **banned in component CSS** (`token-guard` check B) — go
through a tier-2 role.

**Tier 2 — semantic roles.** These are what you write:

| role | tokens |
|---|---|
| text | `--nds-text` `--nds-text-2` `--nds-text-muted` `--nds-text-3` `--nds-text-strong` `--nds-text-disabled` `--nds-text-inverse` `--nds-text-link` |

**🔴 The text ramp is not uniformly AA.** Measured on white, 2026-08-25:

| token | value | on white | use for |
|---|---|---:|---|
| `--nds-text` | `#1c2530` | 15.48 ✓ | anything |
| `--nds-text-2` | `#5b6573` | 5.91 ✓ | anything |
| `--nds-text-muted` | `#667080` | **5.01 ✓** | the smallest text you still expect people to read |
| `--nds-text-3` | `#8a93a1` | **3.10 ✗** | **icons and ≥24px only** — it FAILS AA below 18.66px |

`--nds-text-3` was being used at 9–12.5px by 18 design-system components, so every consumer shipped
sub-AA secondary text. Those now use `--nds-text-muted`. The uses that remain are icons, where
WCAG 1.4.11 asks 3:1 for graphical objects and 3.10 clears it.

Before this, this document annotated the tertiary tone as *"~4.7:1 (AA body)"*. That was true of
`globals.css`'s channel value `#64748b` and never of the DS token beside it — the same name meaning
two different colours, which is the trap the top of this file is about.
| surface | `--nds-bg` `--nds-surface` `--nds-surface-raised` `--nds-surface-sunken` `--nds-surface-hover` |
| border | `--nds-border` `--nds-border-subtle` `--nds-border-strong` |
| brand | `--nds-primary` `--nds-primary-hover` `--nds-primary-dark` `--nds-primary-soft` |
| status | `--nds-{success,warning,danger,info}` and `-soft` / `-strong` per tone |

**Tier 3 — component tokens**: pills, program badges, tooltips, the rail palette.

**Charts are the exception.** Recharts takes colour as a **prop**, so an SVG presentation attribute
cannot resolve `var(--nds-*)`. Import literals from `tokens/colors.ts` → `chart` (`actual`, `cap`,
`reference`, `axis`, `grid`, `cursor`).

## Spacing — 23 steps

```
--nds-space-1  2  3  4  5  6  7  8  9  10  11  12  14  16  18  20  22  24  26  30  32  40  48
```

Not a 4px grid, on purpose. This console is dense and the odd steps are load-bearing: 5px and 9px
alone carry 1,790 declarations. The scale is **descriptive** — it holds the values the product
actually uses (90.8% of every measured padding/margin/gap). Above 48px is page layout, not spacing;
leave it literal.

## Type

```
--nds-font-size-micro 10 · xs 11 · xs-plus 11.5 · sm 12 · sm-plus 12.5
                      base 13 · base-plus 13.5 · md 15 · lg 18 · xl 22 · 2xl 27
--nds-font-weight-medium 500 · semibold 600 · bold 700 · extrabold 800
```

The half-steps are deliberate density tuning and carry 1,741 declarations — do not "tidy" them
into integers. Body/table/control text is `base` (13px).

## Radius

```
--nds-radius-pill 4 · sm 6 · md 7 · lg 8 · xl 10 · 2xl 12 · 3xl 14 · round 999
```

## Elevation

`--nds-shadow-{card,menu,pop,modal,rail,tip}` · `--nds-focus-ring`

---

## Adding a token

1. Edit `tokens/*.ts` (`colors`, `spacing`, `typography`, `radius`) — **never** the `.css`.
2. If it needs a CSS variable, add it to `tokens/css-vars.ts`. Spacing and type are derived from
   their scale modules, so a new step there emits automatically.
3. `npm run tokens:gen`, commit the regenerated CSS.
4. **Before adding a name to the platform-alias tier**, run
   `grep -rn -- "--<name>:" apps/web/src/app`. If `globals.css` or `ads.css` already defines it,
   adding it is a landmine, not a fix — that is why `--surface-raised` is deliberately absent.

## Guards that will stop you

| guard | bans |
|---|---|
| `design-system/tools/token-guard.mjs` | raw hex, numbered ramps, Tailwind palette classes, and platform aliases in DS stylesheets |
| `scripts/ds-conformance-guard.mjs` | native `<select>` / `<input type="date">`, inline `fontSize`, inline hex — ratcheted per app section |
| `npm run tokens:check` | `tokens.css` stale vs `css-vars.ts` |

Both guards skip **untracked** files: in this shared working tree an untracked file is another
session's work in progress, not part of your commit.

## Where the rest lives

| | |
|---|---|
| `design-system/docs/TOKENS.md` | the full token reference |
| `design-system/docs/NAMING.md` | naming rules |
| `design-system/docs/MIGRATION.md` | Phase 9 — the plan to converge the platform on one system |
| `design-system/docs/PHASE-9-0B-TOKEN-FORM.md` | the alias collision, in full |
| `design-system/docs/TOKEN-GUARD-RATCHET.md` | why adherence is 74.8% inside the DS and 5.5% outside |
| `docs/TAILWIND-TO-DS-MIGRATION.md` | retiring the Tailwind kit — scope and blockers |
| `.design-sync/conventions.md` | what the claude.ai/design agent is told about this system |
