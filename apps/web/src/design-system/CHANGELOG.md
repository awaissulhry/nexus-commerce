# Changelog — Nexus Design System

Newest first. Each shipped phase is an entry. Token-value changes that
intentionally restyle the app, and breaking changes to token names or primitive
props, are called out explicitly with a migration note.

## [9.3-css] — 2026-08-24 — The design system is loaded once, for the whole app

Until now the DS stylesheets arrived only where an individual file imported them:
`primitives.css` reached 46 files and **`a11y.css` reached one**. A DS component rendered
unstyled on any route where nothing happened to pull its sheet in — `.h10-ds-btn` did not
resolve on `/design` at all. That is styling by coincidence of import graph, and it blocked
every remaining 9.3 tranche (`Button` alone is 205 files needing `primitives.css`).

- **`app/layout.tsx` now imports** `tokens-global.css` → `primitives.css` → `components.css`
  → `patterns.css` → `a11y.css`. **Order is the cascade** in this system — `a11y.css` last so
  its focus and reduced-motion rules win. Do not reorder.
- **`tokens.css` is now generated in two variants** from the one source (`tokens/css-vars.ts`):
  the full file, unchanged, for the 202 pages that opt in; and `tokens-global.css`, which is
  the same **minus the 11 contested platform aliases**, for the root layout.
- **Why withhold them:** publishing `--text-primary` app-wide as a colour would make Tailwind's
  `rgb(var(--text-primary) / <alpha-value>)` resolve to `rgb(#1c2530)` — invalid — and kill the
  utilities behind 636 files. **Phase 9.0b is what made this possible**, by removing the DS's
  own dependence on those names.
- `token-guard`'s `HEX_ALLOW` now covers both generated token files; `tokens:check` validates
  both.

**Verified** on `/sync-logs` and `/dashboard`, routes that import nothing themselves:
`.h10-ds-btn` resolves (`padding: 7px 13px`, `radius: 8px`), and the DS `focus-visible` +
reduced-motion rules are present for the first time.

### 🔴 Found while verifying (pre-existing, not caused here)

The app's semantic Tailwind utilities are **dead wherever DS `tokens.css` is loaded**. Measured
on real elements on `/dashboard/overview`: `.text-secondary` computes `rgb(0,0,0)` instead of
slate-600, `.border-default` computes black, `.bg-card` is transparent. Same mechanism as 9.0b
in mirror image — the app reading the DS's colour tokens rather than the DS reading the app's
channel tokens. `tailwind.config.ts` records that these utilities replaced 6,485 raw
`text-slate-400` and 6,547 invisible borders; that migration is inert on those routes.
Confirmed pre-existing by re-measuring with the new layout imports removed. Full account and
proposed fix in `docs/PHASE-9-3-DUPLICATE-CONCEPTS.md` §3b.

## [9.3-t2] — 2026-08-24 — Card, EmptyState, Spinner, ProgressBar collapse onto the DS

Four more of the twelve duplicate concepts retired. `components/ui/{Card,EmptyState,Spinner,
ProgressBar}` are now adapters over the DS components, legacy APIs kept verbatim so no call
site changed.

### Lifted into the DS (capabilities, not shims)

- **`Card.description`** — a sub-line under the header title. 105 call sites wanted one, and
  the duplicate `components/ui/Card` was the only way to get it. Renders as a stacked
  title/description block; the 23 existing headed cards keep byte-identical markup because the
  stack only applies when `description` is passed.
- **`Card.padded` now reaches the BODY of a headed card.** It previously applied only to
  headerless cards, so a headed card always got 16px — which is why 17 charts and tables kept
  the legacy component. `padded={false}` → `.h10-ds-card-body.flush`. No existing DS caller
  passes both props, so nothing shifts.

### Kept OUT of the DS (deliberately)

`Spinner.tone` / `Spinner.label` and `ProgressBar.label` / `showCount` / `showPercent` stay in
the adapters. Each has a single caller — `app/design/page.tsx`, the legacy showcase 9.7
deletes — and the DS's own answer to "spinner with a word beside it" is composition, not a
prop. Every production call site was already using the DS `Spinner`/`ProgressBar` directly.

### 🔴 Adapters now carry their own stylesheet imports

The DS stylesheets are **not** loaded app-wide: `primitives.css` is imported by 46 files,
`a11y.css` by **one**. Measured on `/design`, `.h10-ds-card` resolves but `.h10-ds-btn` does
not. This bit the `EmptyState` adapter directly — it renders a DS `Button`, which came out as
unstyled black text on 55 of its 56 pages until caught in review. Each adapter now imports the
stylesheets its component needs, as `AccountSwitcher` already did. Next dedupes them.

The real fix is loading the DS stylesheets once, app-wide, which **9.0b is what makes possible**
— `tokens.css` can now be split into the `--h10-*` tiers (safe globally) and the platform-alias
tier (opt-in, and a `:root` race with `globals.css` if loaded). It should land before the
`Button` tranche, which is 205 files needing `primitives.css`. See
`docs/PHASE-9-3-DUPLICATE-CONCEPTS.md` §3b.

**Migration:** none. No component API changed; `Card` and `EmptyState` render the DS look on
201 files that previously rendered bespoke Tailwind.

## [9.0b] — 2026-08-24 — 285 component declarations were being discarded by the browser

The DS published `--text-*` / `--surface-*` / `--border-*` as **colours**; `globals.css` and
`ads.css` define the same names as **RGB channels** (Tailwind composes them as
`rgb(var(--x) / <alpha-value>)`). Custom properties resolve from the nearest defining
**ancestor**, not by source order, so inside `.h10-shell` those shadowed the DS's and
`background: var(--surface-card)` became `background: 255 255 255` — invalid at
computed-value time, silently dropped. **285 declarations across nearly every component were
dead on every ads page**: 138 `color`, 79 `border`, 63 `background`, 3 `box-shadow`.

- **DS stylesheets now consume the DS-owned `--h10-*` tier only** — 394 substitutions
  (`primitives` 100, `components` 226, `patterns` 68). Value-preserving at `:root`; a fix
  inside the shell, where 6 of 6 sampled tokens went from `rgba(0,0,0,0)` to a real colour.
- **`token-guard` check D** bans the whole platform-alias tier inside DS stylesheets.
  Reports every alias on a line, not just the first.
- **New token `--h10-info-strong`.** The info tone had `soft` and `line` but no `strong`, so
  `--status-info-strong` reached past the semantic tier to `--h10-blue-700` — a numbered ramp,
  which check B bans. The alias now points at the new token so the two cannot drift.
- **The alias tier is KEPT, not deleted** (the plan said delete). Only 11 of 25 names are
  contested; the other 14 are DS-only and app CSS depends on them — `reporting.css` alone has
  47 uses. Deleting would have broken ~70 app declarations to fix what check D already
  prevents. `css-vars.ts` records the reason and the rule for adding to it.
- **`/products/next` fixed:** it pinned nine aliases to real colours but used
  `--text-disabled` and `--text-link` without pinning them, so both were dropped — the
  "Manage inventory" link did not render as a link and the sort chevron was not muted.
- **`GOVERNANCE.md` corrected.** Its tier model instructed components to consume the very
  tier that was silently failing. Now four tiers, tier 4 marked app-only.

**Migration:** none for callers — no component API changed. Expect ads surfaces to gain
borders, backgrounds and a real three-ink text hierarchy where declarations previously
vanished. Full account: `docs/PHASE-9-0B-TOKEN-FORM.md`.

## [CONFORMANCE] — 2026-08-24 — The DS's own two guards go green, and get enforced

`tools/token-guard.mjs` and `tools/api-guard.mjs` both shipped with the system and
both sat **unwired** — so every push measured the app's conformance to the DS while
nothing measured the DS's conformance to itself. Wired into `.githooks/pre-push` in
this entry; they were red when wired (55 token violations, 4 barrel gaps) and are
cleared here, because a gate is only honest once the tree passes it.

### Token-value changes (these restyle the app)

- **`.dark` gained the tone + link roles**: `--h10-success-strong`, `--h10-warning-strong`,
  `--h10-danger-strong`, `--h10-text-link`. The light values measured **2.94:1–3.18:1**
  on the dark canvas — below AA everywhere they were used, not just where someone had
  noticed. `components.css` had been patching this per-component with hex overrides on
  `.h10-ds-acct*`; those are deleted, so any component now inherits the AA value instead
  of the sub-AA one. **Migration:** none — strictly a contrast improvement, dark only.
- **Tooltip inks are tokens and theme-invariant**: `--h10-tooltip-light-{bg,fg,fg-2,border}`
  and `--h10-tip-{bg,fg}`. The values they replace were foreign Tailwind slate hexes
  (`#1e293b` / `#e2e8f0` / `#28313d`) hardcoded in `primitives.css`; snapped onto the
  nearest H10 ramp step, max delta 4/255 per channel. They point at raw ramps, which
  `.dark` never redefines, so a tip keeps its own contrast rather than inverting.
- **`.h10-ds-burn-tip` painted transparent, not white.** It read
  `var(--surface-raised, #fff)` — but `--surface-raised` IS defined app-wide, by
  globals.css and ads.css, as **RGB channels** (`255 255 255`). The substitution produced
  `background: 255 255 255`, invalid at computed-value time, and a `var()` fallback covers
  an *undefined* variable, never an invalid one. Now reads `var(--h10-surface-raised)` —
  DS-owned, a real colour in both themes. **Deliberately NOT fixed by aliasing
  `--surface-raised` in tokens.css**: that would have broken the reverse case,
  `rgb(var(--surface-raised))` in `reporting.css`, on the pages that load both.

### The DS no longer depends on the consuming app's Tailwind build

`ToolbarButton`, `ToolbarDivider` and `ColumnGroupModal` were styled with Tailwind
utilities. `apps/web/tailwind.config.ts` scans `./src/pages`, `./src/components` and
`./src/app` — **never `./src/design-system`** — so those utilities only reached a build
when some other file happened to use the same class. The ToolbarButton badge's arbitrary
values (`-right-0.5`, `min-w-[14px]`, `text-[9px]`) were emitted **zero times**: it was
mis-rendered wherever it shipped, and `ToolbarDivider` was an invisible dimensionless div.

Rewritten onto `.h10-ds-tbtn*` / `.h10-ds-tdivider` / `.h10-ds-cgm-*` + tokens. Every
state (hover / pressed / disabled) is now CSS keyed off `:hover`, `[aria-pressed]` and
`:disabled`, so the visual cannot drift from the a11y tree. ColumnGroupModal's eleven
Tailwind dot hues collapse onto the DS palette via `[data-color]`; an unknown key falls
through to the neutral dot. **No content-glob was added** — the DS depends on nothing
outside itself, which is the point.

### Other

- `--h10-blue-600` × 6 in `components.css` → `var(--color-primary)` (value-identical).
- `ACCOUNT_COLORS` moved to `tokens/colors.ts` as `accountIdentity`; chart inks to
  `chart`. Both keep their exact hexes — `ChannelConnection.accountColor` **persists**
  these strings, so snapping one onto a ramp step would orphan stored accounts.
- Barrels: `LegacyTagTone` (primitives), `ShellSubItem` / `ShellNavGroup` / `ShellNavEntry`
  (patterns) are now re-exported — a consumer can name what `AppShellProps` hands it.
- `token-guard` itself is now **block-comment aware**. Its old per-line heuristic only saw
  the first line of a `/* … */` block, so prose *explaining* why an idiom is banned
  (Button.tsx's note on hand-rolled `!bg-red-600` overrides) counted as a violation — the
  guard was pressuring authors to delete the explanation. Negative-tested: real hex, ramp
  and Tailwind-palette violations in code still fail it.

## [DRAWER-WIDTH] — 2026-07-10 — Drawer width + subtitle props (EFX P6)

- **`Drawer` gained `width`** (number = px, or any CSS length; default stays the
  stylesheet's 420px, `max-width: 100%` still applies) **and `subtitle`** (small
  line under the title — new `.h10-ds-drawer-ht` / `.st` in components.css,
  token-clean). Both optional; existing callers unchanged. First consumer: the
  eBay flat-file images drawer (840px).

## [ZERO-NATIVE] — 2026-07-04 — Listbox + DateField (Wave 1 conformance gap-fill)

- **`Listbox`** (`components/Listbox.tsx`) — plain single-select styled dropdown
  (button trigger in the Select box skin + the Combobox popover, no typeahead).
  The zero-native-control replacement for the `Select` primitive, which styles a
  native `<select>` and still opens the OS option list. New pages must use
  Listbox; the DS-conformance ratchet (scripts/ds-conformance-guard.mjs) bans
  new native selects in app code.
- **`DateField`** (`components/DateField.tsx`) — single-date calendar popover
  replacing native `<input type="date">` (same ban). Reuses the DateRangePicker
  month-grid vocabulary; min/max + clearable.
- No changes to existing components or tokens.

## [PREFERENCES] — 2026-06-28 — PreferencesModal pattern (two-panel "Customise") + DataGrid sticky-right

- **`PreferencesModal`** (`patterns/PreferencesModal.tsx`) — the two-panel grid
  Customise dialog ported to the DS from the live /products workspace. Left:
  optional rows-per-page · sticky first/last column · optional sort · a
  `workspaceSlot`; right: every column with a drag handle + DS `Toggle` (locked
  columns disabled). Draft-then-Save (atomic), Reset to defaults. Pure DS — built
  on `Modal` + `Button` + `Toggle`, no app i18n/utils. Optional sections collapse
  on empty option lists. Token-clean `.h10-ds-prefs*`. Title defaults to "Customise".
- **`DataGrid` gained `stickyRight`** on `Column` — pins a column to the right
  edge (offsets stack, like sticky-left), with a left edge-shadow. Lets the
  Customise "Pin last column" toggle actually pin the trailing actions column.
  Additive; existing grids unaffected.
- Recorded in the patterns barrel + catalog (Builder & ColumnCustomizer →
  PreferencesModal). First consumer: `/products/next` Customise button.

## [GRIDTOOLBAR] — 2026-06-28 — GridToolbar pattern + grid-card wrapper (Ad-Manager toolbar)

- **`GridToolbar`** (`patterns/GridToolbar.tsx`) — the Ad-Manager `.h10-am-toolbar`
  row as a reusable DS pattern: `count` (left) + left-action `children` + flexible
  spacer + `right` actions. Token-clean `.h10-ds-toolbar` (count `.cnt`, bold
  numbers, `.grow` spacer).
- **`.h10-ds-gridcard`** wrapper — seats the toolbar inside the grid card above a
  `DataGrid` (toolbar gets a bottom divider; the inner `.h10-ds-grid-wrap` drops
  its own border + radius), matching the campaigns page's one-card layout.
- Recorded in the patterns barrel + catalog (Filters & action bars → GridToolbar).
  First consumer: `/products/next` (count · Customise · Export · density · Live).

## [FILTERBAR] — 2026-06-28 — Config-driven FilterBar pattern (one bar for every grid)

The declarative filter bar the grid workspaces were missing — so feature pages
(products, listings, fulfillment, pricing…) own *configuration*, never filter-bar UI.

- **`FilterBar`** (`patterns/FilterBar.tsx`) — pass a `dimensions: FilterDimension[]`
  array; the bar renders the collapsible Ad-Manager panel (built on `FilterPanel`)
  with the right control per dimension: `multiselect` → `MultiSelect`, `select` →
  `Combobox`, `range` → a min/max field (optional €/% addon), `toggle` → `Toggle`.
  Options accept an optional facet `count`. Reproduces the campaigns-page
  `.h10-am-fpanel` through DS tokens. First consumer: `/products/next`.
- **`FilterPanel` gained `resetLabel` + `resetDisabled`** (additive) — lets the
  footer read **"Clear"** and disable when no filters are active, matching the
  Ad Manager. Existing consumers default to "Reset", unchanged.
- **New CSS** — `.h10-ds-range*` (min/max field; input border uses
  `--border-strong` = the campaigns input border exactly) + `.h10-ds-ms-count`
  (muted facet count after an option label). All semantic-token-clean; `token-guard`
  + `api-guard` green. Rendered in the catalog under Filters → FilterBar.
- **Known follow-up:** a token-reconciliation pass to lock the remaining DS↔campaigns
  drift (panel border `#d8dde4`→`#d6dbe2`, multiselect border, grid greys) is tracked
  separately — values, not structure.

## [DS-HARDEN] — 2026-06-27 — Consistency & hardening: semantic tokens + generated CSS + one API

The DS made internally consistent and self-truthful — no new colour values, a
consistency pass. Full map in `docs/AUDIT.md`; design at
`docs/superpowers/specs/2026-06-27-design-system-consistency-hardening-design.md`.

- **Platform-semantic alias layer is now LIVE.** Added the platform's semantic
  names — `--text-*`, `--surface-*`, `--border-*`,
  `--status-{success,warning,danger,info}-{soft,line,strong}`, `--color-primary`
  (+`-soft`) — as **value-preserving aliases** over the existing `--h10-*` roles,
  and repointed **every** component CSS rule onto them (the ~13 raw-ramp reaches
  in Tag/Toggle/Tooltip/Skeleton/DataGrid/AppShell are gone). `--h10-*` is now
  strictly the raw ramp + DS-only component-token tier underneath. No pixels move
  — the alias values are identical, so the catalog screenshot-diff is a no-op.
  `/marketing/ads` keeps reading `--h10-*` directly and is unaffected.
- **`tokens.css` is GENERATED from TypeScript.** `tokens/css-vars.ts` (hex
  sourced once from `tokens/colors.ts`) is the single source; new
  `tools/generate-tokens-css.ts` emits the `:root{}` + `.dark{}` blocks.
  `npm run tokens:gen` writes the stylesheet; **`npm run tokens:check`** is the CI
  guard that fails on staleness. Closes the old "TS generates CSS" claim that was
  previously hand-mirrored — drift is now structurally impossible.
- **API harmonized onto one `Tone` vocabulary.** `type Tone = 'neutral' | 'info'
  | 'success' | 'warning' | 'danger'` (+ `TONES`), applied via a `tone` prop to
  **Pill** (`status` `ok/warn/arch/err` → `tone` `success/warning/neutral/danger`),
  **Tag** (`positive` → `success`), **Toast** + **Banner** (`error` → `danger`;
  `variant` kept as a deprecated alias on Banner for the untouchable
  `EbayImportWizard`). **Button** keeps `variant` (`primary/secondary/ghost`) —
  the emphasis axis, deliberately distinct from tone.
- **Badge corrected to its real meaning.** `BadgeTone = sp|sd|sb|auto|manual`
  was never a tone — it's the **ad-program** axis. Renamed to `program: AdProgram`.
- **Types + sizing exported and standardized.** Every component now re-exports its
  public Props via the barrel (incl. previously-leaking `KbdProps`, `PillProps`,
  `TagProps`, and Toast's `ToastApi`). New shared `Size = sm|md|lg|xl`
  (`primitives/size.ts`); Spinner's numeric `size` is the documented exception.
- **Outliers conformed.** `TagInput` rebuilt onto `.h10-ds-taginput*` + semantic
  tokens (dropping the raw Tailwind palette + hand-rolled `dark:` + `@/lib/utils`),
  props unchanged so its two untouchable consumers need no edits. `ImageUpload`
  CSS repointed onto the semantic aliases.
- **Guardrails extended.** `tools/token-guard.mjs` (raw-hex ban across
  primitives/components/patterns/styles) stays green; the generator's
  `tokens:check` guards TS↔CSS sync. The consistency contract (no raw ramp in
  component CSS, no raw Tailwind palette in `.tsx`, barrel-export completeness) is
  documented in `docs/AUDIT.md` + `docs/GOVERNANCE.md` and enforced by review,
  with a `tools/api-guard.mjs` lint planned.

## [P5.1] — 2026-06-23 — Tag primitive (neutral / semantic chip)

- **`Tag`** (`primitives/Tag.tsx` + `.h10-ds-tag` in `styles/primitives.css`) — the
  generic inline label chip the console was missing. `Pill` encodes entity *status*
  (Active/Paused/Archived/Error) and `Badge` encodes the ad *program* (SP/SD/SB/Auto/
  Manual); `Tag` covers everything else you label inline. Five tones — `neutral` ·
  `info` · `positive` · `warning` · `danger` — all from existing tokens. First
  consumer: the rebuilt Suggestions page (entity type, marketplace, proposed-action
  sentiment); reused by the upcoming triage filters/metrics. Additive — no other changes.

## [P4.1] — 2026-06-23 — ImageUpload component

- **`ImageUpload`** (`components/ImageUpload.tsx` + `.h10-ds-imgup-*` in
  `styles/components.css`) — a reusable image dropzone: drag-drop + click, live
  preview with remove, a criteria panel, and client-side format / size / minimum-
  dimension validation. Platform-agnostic — the caller passes `onUpload(file) =>
  Promise<url>` (wire to any asset/DAM endpoint) plus optional `onSelectFromAssets`
  for a DAM browse. First consumer: the Guided builder's Sponsored Brand creative
  (logo + custom image, wired to `/api/assets/upload`); reusable for product
  images, A+ modules, etc. Additive — no token/primitive changes.

## [ADS-CB] — 2026-06-23 — Campaign-builder shared blocks (Guided)

- New shared ads-builder components in `marketing/ads/_shared/`, recorded in the
  ads inventory (study 00 §7):
  - **`CampaignTypeSelect`** (+ co-located `.css`) — the SP / SB / SD multi-select
    cards (ad-format mocks + Amazon copy; `disabled` keys render a "Soon" pill).
    The canonical building block for any builder spanning ad formats.
  - **`HarvestRules`** — the Keyword Harvesting / Negative Targeting matrix +
    collapsible Performance Criteria, on the shared rule model (`RulesConfig` /
    `RuleRowSel`). (SP Super Wizard's `LaunchStep` keeps an inline twin for now —
    flagged as a dedupe candidate; model + engine are already shared.)
- These power the new **Guided** builder (multi-format SP+SB+SD), which otherwise
  reuses existing shared blocks (`BidStrategy`, `KeywordTargetingPanel`,
  `ProductSelection`, the `RuleControlPanel` canvas, `PerformanceCriteria`). No DS
  primitive/token changes; additive only.

## [P5.1a] — 2026-06-22 — AppShell: collapsible nav groups

- `AppShell` gains collapsible nav **groups** (`ShellNavGroup` — icon + label +
  sub-items + chevron; auto-opens if a child is active or `defaultOpen`),
  matching the H10 `AdsSidebar`'s AMC / Reporting expandable sections. Flat items
  and groups coexist; sub-items hide when the rail is collapsed; the active
  sub-item gets the primary treatment.
- Catalog demos a "Reporting" group (Overview / Brand metrics [active] / AMC
  audiences). Self-verified @2x (rail expanded). The sidebar now fully matches
  the ads rail. (Follow-up enhancement to the Phase 5 AppShell.)

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
