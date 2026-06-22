# Nexus Design System (H10)

The single source of truth for the Nexus operator console's visual language —
tokens, primitives, components, patterns, and the research ("studies") behind
each feature. Seeded from the `/marketing/ads` surface (the "H10" look,
pixel-matched to a best-in-class ads console) and on a path to become the
canonical design language for the **entire** platform.

> **Status:** Phase 0 — scaffolding + governance + inventory. No runtime code
> yet; this phase establishes the structure, the rules, and the authoritative
> map of what we're extracting. See `CHANGELOG.md` and the phase plan below.

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

| Folder | What lives here | Built in |
|---|---|---|
| `tokens/` | Primitive → semantic → component tokens (TS) + Tailwind wiring | Phase 1 |
| `styles/` | `tokens.css` + base CSS; `ads.css` migrates onto vars here | Phase 1 |
| `primitives/` | Atoms: Button, Input, Select, Checkbox, Badge, Chip, Tooltip… | Phase 3 |
| `components/` | Molecules: DataGrid, Modal, Drawer, Tabs, Charts, DateRange… | Phase 4 |
| `patterns/` | Organisms: AppShell, PageHeader, Builder framework, FilterPanel… | Phase 5 |
| `catalog/` | Living style guide — every token + component, native res | Phase 2 |
| `studies/` | Per-feature dossiers + cross-platform (Amazon/eBay/Shopify) research | Phase 8 |
| `docs/` | Governance, contribution, naming, tokens, reconciliation specs | Phase 0 |

## Using it (once populated)

```ts
import { Button, Badge } from '@/design-system/primitives'
import { DataGrid, Modal } from '@/design-system/components'
import { tokens } from '@/design-system/tokens'
```

CSS lives behind tokens — components reference `var(--token)`, never raw hex.

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

- `docs/GOVERNANCE.md` — versioning, deprecation, Definition of Done, review gates
- `docs/CONTRIBUTING.md` — how to add a token / primitive / component / study
- `docs/NAMING.md` — class prefix policy, token + component naming
- `docs/TOKENS.md` — the token model (values land in Phase 1)
- `docs/TOKEN-RECONCILIATION.md` — how H10 values map onto the semantic structure
- `studies/00-ads-inventory.md` — the authoritative `/marketing/ads` inventory
