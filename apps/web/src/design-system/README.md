# Nexus Design System (H10)

The single source of truth for the Nexus operator console's visual language —
tokens, primitives, components, patterns, and the research ("studies") behind
each feature. Seeded from the `/marketing/ads` surface (the "H10" look,
pixel-matched to a best-in-class ads console) and on a path to become the
canonical design language for the **entire** platform.

> **Status:** Live. **19 primitives + 21 components + 8 patterns** shipped (47+
> runtime `.tsx`), each rendered in the living catalog. The token layer is
> **generated from TypeScript** — `styles/tokens.css` is emitted by
> `tools/generate-tokens-css.ts` from `tokens/css-vars.ts` (`npm run tokens:gen`;
> `npm run tokens:check` is the CI staleness guard), so CSS can't drift from the
> source. The **platform-semantic alias layer is live**: components consume
> `--text-*` / `--surface-*` / `--border-*` / `--status-*` / `--color-primary`,
> with `--h10-*` as the raw ramp + DS-only component-token tier underneath. The
> public API runs on **one `Tone` vocabulary** (`neutral · info · success ·
> warning · danger`). See `CHANGELOG.md`, `docs/AUDIT.md` (the full map), and the
> phase plan below. Still pending: the `.h10-*`→`.nx-*` rename + the ~290-page
> migration (Phase 9).

---

## Why this exists

The platform grew two parallel visual languages:

1. **H10 / `/marketing/ads`** — a bespoke, hand-tuned `.h10-*` CSS system
   (`ads.css`, ~1.8k lines) with its own components. Dense, crisp, premium.
   **This is the look we're standardizing on.**
2. **Tailwind semantic tokens** — `tailwind.config.ts` + `globals.css` +
   `components/ui/` (26 primitives) + `_shared/grid-lens/`. Mature, documented,
   used by ~290 pages.

Rather than fork, we **converge**: the H10 *look* becomes canonical, expressed
through the existing *semantic token structure* (`text-primary`, `surface-*`,
`status-{success,warning,danger,info}-{soft,line,strong}`…). One system. The
~290 existing pages migrate onto the same tokens over time instead of being
rewritten.

## Principles

- **Dense *and* legible.** Airtable/Salesforce information density with a
  Stripe/Linear finish. Not minimalism — visibility.
- **Solid surfaces + elevation** for hierarchy. Translucent tints are banned
  for highlights.
- **High contrast everywhere.** WCAG AA minimum (4.5:1 body, 3:1 UI/large).
- **Tokens, not hardcodes.** Every color/size/shadow resolves to a token. Raw
  hex in components is a defect.
- **One system.** A visual concept is defined once and reused, never
  re-implemented per feature.
- **Self-verify before showing.** Every change is screenshot-diffed against the
  H10 reference at native resolution and measured numerically before review.
- **Ship live, not dark.** Real code from day one, guarded by tokens + tests —
  not hidden behind flags.

## Folder map

| Folder | What lives here | Status |
|---|---|---|
| `tokens/` | Primitive → semantic → component tokens (TS); `css-vars.ts` is the one source that generates `tokens.css` | Shipped |
| `styles/` | `tokens.css` (GENERATED) + base/primitive/component/pattern CSS + `a11y.css` | Shipped |
| `primitives/` | Atoms: Button, Input, Select, Checkbox, Badge, Pill, Tag, Tooltip… (19) | Shipped |
| `components/` | Molecules: DataGrid, Modal, Drawer, Tabs, Charts, DateRange… (21) | Shipped |
| `patterns/` | Organisms: AppShell, PageHeader, Builder framework, FilterPanel… (8) | Shipped |
| `catalog/` | Living style guide — every token + component, native res | Shipped |
| `studies/` | Per-feature dossiers + cross-platform (Amazon/eBay/Shopify) research | Shipped |
| `docs/` | Governance, contribution, naming, tokens, reconciliation + `AUDIT.md` (the map) | Shipped |

## Using it

```ts
import { Button, Badge } from '@/design-system/primitives'
import { DataGrid, Modal } from '@/design-system/components'
import { tokens } from '@/design-system/tokens'
```

CSS lives behind tokens — components render via `.h10-ds-*` classes that resolve
through the **semantic** aliases (`--text-*` / `--surface-*` / `--border-*` /
`--status-*` / `--color-primary`), never raw hex and never a raw `--h10-*-NNN`
ramp.

## Phase plan

0 — Scaffold + governance + inventory *(this phase, non-destructive)*
1 — Token foundation *(keystone — everything waits on it)*
2 — Living catalog / style guide + verify harness
3 — Primitives (atoms) · 4 — Components (molecules) · 5 — Patterns (organisms)
6 — A11y / i18n / content + data standards
7 — Governance hardening + lint + visual-regression CI
8 — Studies framework (research hub)
9 — Migration kit + section-by-section rollout

Each phase: **build → tsc/build + contrast lint + native-res screenshot-diff →
visual review → commit & push.**

## Portability

This folder is intentionally **self-contained**: every subfolder documents
itself, references are relative, and this README reads standalone — so it can be
copied out (e.g. to a Desktop reference) and still make sense. The only external
coupling is the app's import alias (`@/design-system/*`) and the shared font
variables, both noted where used.

## Read next

- `docs/AUDIT.md` — the exhaustive map: every token (tier + semantic alias) and
  every primitive/component/pattern (props, tone/size, catalog + a11y coverage)
- `docs/GOVERNANCE.md` — versioning, deprecation, Definition of Done, review gates
- `docs/CONTRIBUTING.md` — how to add a token / primitive / component / study
- `docs/NAMING.md` — class prefix policy, token + component naming
- `docs/TOKENS.md` — the token model (values land in Phase 1)
- `docs/TOKEN-RECONCILIATION.md` — how H10 values map onto the semantic structure
- `docs/ACCESSIBILITY.md` — focus, keyboard, ARIA, motion, contrast standards
- `docs/CONTENT.md` — language (English UI), formatters, iconography, voice
- `docs/MIGRATION.md` — Phase 9 plan: rolling the system onto the app (proposal)
- `studies/00-ads-inventory.md` — the authoritative `/marketing/ads` inventory
