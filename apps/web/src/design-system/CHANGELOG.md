# Changelog — Nexus Design System

Newest first. Each shipped phase is an entry. Token-value changes that
intentionally restyle the app, and breaking changes to token names or primitive
props, are called out explicitly with a migration note.

## [P8] — 2026-06-22 — Studies hub (Phase 8 complete)

- The research hub is established: framework (`studies/README` + `_TEMPLATE`) +
  the foundational studies (`00-ads-inventory`, `01-color-drift`,
  `02-contrast-audit`) + the **exemplar feature dossier `03-ads-campaigns`** —
  which maps the ads cockpit onto the DS (that mapping *is* the Phase-9 migration
  checklist for `/marketing/ads`) and sketches cross-platform parity + the
  automation roadmap. Copy `_TEMPLATE.md` for each next feature.
- Additive docs; committed locally. Next: **Phase 9 — migration** (the gated
  `ads.css`→token rewrite + `.h10-*`→neutral rename + rollout) — needs the
  unblocked tree + healthy dev server + the screenshot harness.

## [P7] — 2026-06-22 — Governance hardening + guardrails (Phase 7 complete)

- `tools/token-guard.mjs` — drift guard: fails on raw hex in shipped DS code
  (primitives/components/patterns/styles; `tokens.css` excepted). **Passes today**
  — the whole system is tokenized. `tools/README.md` documents it + the
  visual-regression process (`catalog/verify.mjs` + baseline diff).
- `docs/GOVERNANCE.md` gains a **Guardrails** section (token-guard, visual
  regression, the contrast rule). CODEOWNERS deferred for a solo operator.
- Additive (scripts + docs); committed locally — push still queued behind the
  concurrent `SpSuperWizard.tsx` error. Next: Phase 8 (studies hub), 9 (migration).

## [P6] — 2026-06-22 — A11y · i18n · content & data standards (Phase 6 complete)

- **A11y:** `styles/a11y.css` (prefers-reduced-motion neutralizes DS animations +
  transitions; focus-visible baseline). Esc-to-close added to `MultiSelect` +
  `Combobox`. `docs/ACCESSIBILITY.md` documents focus / keyboard / ARIA / motion /
  contrast (ARIA roles + states were already applied across components).
- **Contrast:** `studies/02-contrast-audit.md` — WCAG AA ratios for the key token
  pairs; `--h10-text-3` (~3.2:1) flagged secondary/large-only (body uses
  `--h10-text-2`, 5.9:1); primary passes AA (~4.8:1). H10 values kept; usage rule
  documented for the Phase 7 lint.
- **Content/data:** canonical formatters in `lib/format.ts` (cents-based money,
  fraction `pct`, fixed `en-IE`/`en-GB` locales → no hydration drift),
  consolidating the duplicated ads `format.ts`. `docs/CONTENT.md` (English-UI /
  Italian-content stance, iconography, voice).
- `tsc` clean. Next: Phase 7 (governance lint + visual-regression CI).

## [P5.3] — 2026-06-22 — Builder framework + ColumnCustomizer (Phase 5 complete)

- `Builder` (full-screen wizard: top bar close + title + primary action, scroll-spy
  left nav, scrolling sections; portal + Esc) — the spine for rule/goal/campaign
  builders. `ColumnCustomizer` (column visibility + up/down reorder inside a
  Modal; locked columns; draft-then-Apply).
- **Phase 5 COMPLETE — 8 patterns:** AppShell, PageHeader, DetailHeader,
  FilterPanel, BulkActionBar, EditModeBar, Builder, ColumnCustomizer. All
  self-verified @2x. The live-WIP ads builders (`_rank`, budget) fold in during
  the migration once committed. Next: Phase 6 (a11y / i18n).

## [P5.2] — 2026-06-22 — Patterns wave 2: FilterPanel · BulkActionBar · EditModeBar

- `FilterPanel` (`.h10-am-fpanel`: collapsible, presets row, responsive 6→3→2
  col field grid via `FilterField`, reset/apply footer; DS controls fill their
  cells; orphan-margin balanced when collapsed). `BulkActionBar` (sticky
  "N selected" + actions + Clear; renders nothing at 0). `EditModeBar` (sticky
  discard/apply for unsaved edits). Shared `.h10-ds-actionbar`.
- Catalog Filters section dog-foods them (FilterPanel with MultiSelect / Combobox
  / Select / €-% inputs). `tsc` clean; self-verified @2x (fields fill cells; sticky bars).

## [P5.1] — 2026-06-22 — Patterns wave 1: AppShell · PageHeader · DetailHeader

- First organisms in `patterns/` (+ `styles/patterns.css`): `AppShell` (H10 rail
  — 66px icon rail hover-expands to 248px; brand, nav items with active state +
  count badge, footer; fills its parent so the app layout supplies the height),
  `PageHeader` (eyebrow + title + subtitle + actions), `DetailHeader` (back link
  + badge + title + actions). The shell composes the headers + primitives.
- Catalog Patterns section: headers inline + AppShell in a contained 360px
  preview. Self-verified @2x. `tsc` clean.
- Remaining Phase 5: FilterPanel, BulkActionBar, EditModeBar, ColumnCustomizer,
  the Builder framework (full-screen wizard + scroll-spy).

## [P4.6] — 2026-06-22 — DataGrid + Phase 4 complete

- `DataGrid<T>` (`.h10-am-grid`): generic columns (render / align / sortable /
  sortValue / sticky / width / total), click-to-sort headers with arrows, row
  selection + select-all (indeterminate), sticky header, pinned left columns
  (accumulated offsets), a sticky totals row, and an empty state. Catalog
  dog-foods it (Badge/Pill cells, sortable metrics, totals, selection).
- **Phase 4 COMPLETE — 17 composites + `useClickAway`.** `tsc` clean;
  self-verified @2x. Next: Phase 5 (patterns — AppShell / PageHeader / Builder).

## [P4.5] — 2026-06-22 — Components wave 5: charts (PerformanceGraph · Heatmap)

- `PerformanceGraph` (Recharts `ComposedChart` — dual independent left/right
  axes, two line series, tokenized grid/axes via the TS token values, custom
  tooltip + legend). `Heatmap` (7×24 intensity grid, cell opacity scales with
  value/max; column labels).
- Catalog Charts section uses **deterministic** sample data (Math.sin, no random)
  so SSR matches the client; harness captures `[data-cat="charts"]`.
- Self-verified @2x: dual-axis lines + scaling, heatmap evening-peak gradient.
  `tsc` clean. Only the `DataGrid` remains in Phase 4.

## [P4.4] — 2026-06-22 — Components wave 4 (DateRangePicker · MetricStrip · HoverCard)

- `DateRangePicker` (`.h10-dp` — dual-month calendar + preset rail; two-click
  range select, future-disabled, today ring, en-GB format). `MetricStrip` (KPI
  tiles, auto-fit grid, up/down delta). `HoverCard` (rich hover panel on a light
  surface). All reuse `useClickAway` / token styles.
- Catalog dog-foods them; harness opens the date popover + hovers the card.
- `tsc` clean; self-verified @2x — calendar range highlight + today ring,
  MetricStrip deltas, HoverCard. Date popover opens left-aligned so a mid-content
  trigger doesn't clip (a top-right header can add right-align later).

## [P4.3] — 2026-06-22 — Components wave 3 (Toast · MultiSelect · Combobox)

- `Toast` system: `ToastProvider` + `useToast()` + a portaled bottom-center
  viewport (info/success/error, auto-dismiss). `MultiSelect` (`.h10-ms` checkbox
  dropdown — All / N-selected + Select-all with indeterminate). `Combobox`
  (`.h10-combo` typeahead — filter + pick). Shared `useClickAway` hook (promoted
  out of FilterDropdown).
- Catalog dog-foods them (MultiSelect + Combobox + a self-contained Toast demo);
  harness opens + captures each popover and the toast.
- `tsc` clean; self-verified @2x (MultiSelect indeterminate / Combobox / Toast).
  Fixed a `Toast` SSR hydration mismatch — the always-present viewport is now
  mounted-guarded so the first client render matches the server.

## [P4.2] — 2026-06-22 — Components wave 2: overlays (Modal · Drawer · Menu)

- Portal-based overlays tokenized to H10: `Modal` (`.h10-modal` — title/subtitle/X,
  bordered scroll body, right-aligned footer; sizes sm/md/lg; Esc + backdrop
  close), `Drawer` (right slide-over; Esc + backdrop close), `Menu` (`.h10-menu`
  anchored dropdown; outside-click close; disabled items).
- Catalog dog-foods them (interactive open buttons + a Menu); the harness opens
  each and screenshots the portaled element.
- Self-verified @2x: Modal, Drawer, Menu all match the H10 look. `tsc` clean.

## [P4.1] — 2026-06-22 — Components wave 1 (Card · EmptyState · Tabs · Pagination · ProgressBar)

- First composite components in `components/` + `styles/components.css`
  (`.h10-ds-*`): `Card` (panel + optional header/action slot), `EmptyState`
  (icon + title + description + CTA), `Tabs` (underline indicator, controlled),
  `Pagination` (windowed page list with ellipses + prev/next), `ProgressBar`
  (determinate + indeterminate).
- Catalog gains a Components section that dog-foods them (interactive Tabs +
  Pagination); harness captures `[data-cat="components"]`.
- `tsc` clean. Self-verified @2x (Card / EmptyState / Tabs / Pagination / Progress).

## [P3.3] — 2026-06-22 — Primitives wave 3 + Phase 3 complete

- Final primitives, tokenized to the H10 spec: `Radio` (accent native),
  `RadioCard` (`.h10-radio-card`; selected = primary border + wash), `Tooltip`
  (CSS hover, `.h10-tip` dark bubble + arrow), `Spinner` (`h10spin` ring),
  `Skeleton` (`.skb` shimmer), `Kbd`, `Divider`. Appended to `primitives.css`;
  `primitives/icons/README` documents the Lucide convention.
- **Phase 3 complete: 14 primitives** — Button · Pill · Badge · Input · Select ·
  Checkbox · Toggle · Radio · RadioCard · Tooltip · Spinner · Skeleton · Kbd ·
  Divider. All self-verified @2x vs the H10 look in the catalog.
- Deferred to Phase 4 (composite): searchable/portal MultiSelect + Combobox, the
  adaptive InfoTip; custom builder-icons lift to the migration.

## [P3.2] — 2026-06-22 — Primitives wave 2 (Input · Select · Checkbox · Toggle)

- Form controls tokenized to the H10 spec: `Input` (plain / leading-icon /
  `€`-prefix / `%`-suffix via the `.h10-am-search` + `.mmin` field pattern),
  `Select` (styled native + chevron, `.h10-fsel`), `Checkbox` (accent-tinted
  native), `Toggle` (`role="switch"`, `.h10-toggle` 30×17 with sliding knob).
- Appended `.h10-ds-field/select/check/toggle` to `styles/primitives.css`;
  catalog dog-foods them in a second Primitives card.
- `tsc` clean; identical pattern to the visually-verified wave 1. The @2x visual
  capture + push were deferred at commit time — a concurrent session was actively
  re-breaking the shared tree (dev 500 / non-buildable); both run on a clean window.
- Note: the searchable/portal MultiSelect + Combobox move to Phase 4 (composite).

## [P3.1] — 2026-06-22 — Primitives wave 1 (Button · Pill · Badge)

- First primitives in `primitives/`, tokenized to the H10 spec: `Button`
  (primary/secondary/ghost × md/sm + disabled, matches `.h10-am-btn`), `Pill`
  (ok/warn/arch, matches `.h10-pill`), `Badge` (SP/SD/SB program + A/M targeting).
- Self-contained `styles/primitives.css` under the `.h10-ds-*` sub-namespace
  (collision-proof vs ads.css's route-scoped `.h10-*`; documented in NAMING).
  Added `--h10-text-strong` + `--h10-surface-hover` semantic tokens.
- Catalog now **dog-foods** the components (Primitives section); the verify
  harness gained a per-section `[data-cat]` capture.
- Verified @2x: light, dark, and a focused primitives shot — all match the H10
  look. Committed locally; push deferred behind a concurrent session's
  non-buildable tree.
- Remaining primitive waves: Input/Select/MultiSelect, Checkbox/Radio/Toggle,
  Tooltip/Spinner/Skeleton/Kbd/Divider, icons.

## [P2] — 2026-06-22 — Living catalog + verify harness

- New route `/design-system` (`app/design-system/page.tsx`) renders the full
  token set — primitive ramps, semantic roles, status pills, program chips,
  typography, spacing, radius, elevation, motion/z-index/breakpoints — driven by
  `@/design-system/tokens` so the catalog can never drift from the source. Light
  + a dark toggle that exercises the `.dark` CSS layer.
- `catalog/TokenCatalog.tsx` (the portable component) + `catalog/verify.mjs`, a
  Playwright @2x screenshot harness (light + dark, full page → `.analysis/dsshot`)
  reusing the established H10 capture pattern. This is the baseline that the
  component phases + the `ads.css` migration screenshot-diff against — i.e. it
  **unblocks** the deferred `ads.css` → token rewrite.
- Verified: `tsc` clean; isolated additive route (no existing file touched).
  Live visual review on the deploy (local dev server was in a concurrent-session
  500 state at build time, unrelated to this route).

## [P1] — 2026-06-22 — Token foundation

- Canonical token system shipped as new files (zero changes to existing code):
  `tokens/` (colors, typography, spacing, radius, shadow, motion, zindex,
  breakpoints + `index` barrel) and `styles/tokens.css` (the `--h10-*` CSS vars,
  three tiers: primitive ramps → semantic roles → component chips).
- Distilled the canon from **251 hex literals → ~70 tokens**; documented the
  drift (near-duplicate greens/reds/blues/greys, dual shadow tints) and the
  collapse worklist in `studies/01-color-drift.md`.
- Tokens are **dark-ready** (provisional `.dark` inversions of the semantic
  layer) though H10 ships light-first; no surface opts in yet.
- **Sequencing decision:** the `ads.css` rewrite onto tokens is deferred to
  *after* the Phase 2 screenshot-diff harness — canonicalizing drift changes
  pixels, so it must be verified, not done blind. Phase 1 stays pure-additive.
- Namespaced `--h10-*` to avoid colliding with `globals.css`; convergence onto
  the platform's semantic names is a deliberate migration step.

## [P0] — 2026-06-22 — Scaffold + governance + inventory

- Created `apps/web/src/design-system/` with the full folder structure
  (`tokens` · `styles` · `primitives` · `components` · `patterns` · `catalog` ·
  `studies` · `docs`), each self-documented.
- Founding governance docs: `README`, `GOVERNANCE`, `CONTRIBUTING`, `NAMING`,
  `TOKENS`, `TOKEN-RECONCILIATION`.
- Studies framework: `studies/README` + `_TEMPLATE` + the authoritative
  `00-ads-inventory.md` mapping every `/marketing/ads` UI element to its DS home.
- **Decision:** the H10 look becomes the canonical platform design language; the
  existing Tailwind semantic-token system converges onto it (one system, not a
  fork). Supersedes the unapproved `docs/UI_REBUILD_STRATEGY.md`.
- **Decision:** keep the `.h10-*` class prefix until a Phase 9 rename.
- Non-destructive: no existing page or stylesheet changed.
