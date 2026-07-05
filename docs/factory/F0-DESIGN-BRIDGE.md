# Factory OS design bridge (F0)

F0 deliverable 5 of 6 — exactly which design-system files, classes and idioms Factory OS consumes and HOW, the sidebar adoption plan, the font/token parity checklist, and the no-touch guarantee for every existing Nexus app. Repo facts read from HEAD on 2026-07-05 (paths verified; the design system self-describes as portable — README §Portability). Canonical for FP-cycle UI specs once the gate passes.

**The rule this document exists to honor:** never modify the ads console or any existing Nexus app code. Factory OS **copies** patterns into its own tree and consumes them there. F0 itself touched nothing outside `docs/factory/`.

## What is being copied (source of truth: `apps/web/src/design-system/`)

The Nexus "H10" design system — 19 primitives + 24 components + 11 pattern exports on `.h10-ds-*` classes (the README's status line lags at "19+21+8"; `ds-parity-check.mjs` re-measures counts at copy time), a generated token layer, and governance docs — pixel-matched to the ads console the Owner loves. Copy mechanism per FD12: **verbatim copy** into `apps/factory/src/design-system/` + a read-only parity script.

| Copied (verbatim) | Contents | Note |
|---|---|---|
| `styles/tokens.css` | `--h10-*` primitive ramps + semantic roles + platform aliases (`--text-*`, `--surface-*`, `--border-*`, `--status-*`, `--color-primary`), `:root` + `.dark` | **Copy the generated file as the value source, not just `tokens/css-vars.ts`** — 11 `--h10-rail-*` vars exist only in tokens.css/ads.css (drift from commit `99746dbe`), and css-vars.ts alone would lose the rail palette |
| `styles/primitives.css` · `styles/components.css` · `styles/patterns.css` · `styles/a11y.css` | All `.h10-ds-*` component CSS (605 / 1,245 / 782 / 26 lines) | In Nexus these load per-route (alias collision with `globals.css`); **factory is greenfield and loads all five globally** — one import in the root layout |
| `tokens/` (all TS files) + `tools/generate-tokens-css.ts` + `token-guard.mjs` / `api-guard.mjs` | Typed token source (fontSize base 13px workhorse, spacing px-scale, durations, z-index…), the tokens.css generator, and the guards | Factory wires its own `tokens:gen` / `tokens:check` scripts; TS tokens feed chart/JS consumers |
| `primitives/` (19) | `Button`, `Pill` (Tone), `Tag`, `Input` (prefix `€` / suffix `%` adornments), `Textarea`, `Select`, `Listbox`-era `Checkbox/Toggle/Radio/RadioCard`, `Tooltip`, `Spinner`, `Skeleton`, `Kbd`, `Divider`, `TagInput`, `SegmentedControl`, `ToolbarButton`… + `tone.ts` (`neutral·info·success·warning·danger`) | `Badge` (ad-program sp/sd/sb chips) is copied but unused — ads semantics, IGNORE |
| `components/` (24) | `DataGrid`, `Modal` (440/560/660/920), `Drawer`, `Menu`, `ToastProvider`, `Tabs`, `Card`, `EmptyState`, `Pagination`, `ProgressBar`, `Stepper`, `Banner`, `FileDropzone`, `ImageUpload`, `MultiSelect`, `Combobox`, `Listbox`, `DateField`, `DateRangePicker`, `MetricStrip`, `HoverCard`, `PerformanceGraph`, `Heatmap`, `ColumnGroupModal` | The hard rule travels with it: **always `<Modal>`, never hand-roll dialogs** (documented collision incident) |
| `patterns/` | **`AppShell`** (the rail — see below), `PageHeader`, `DetailHeader`, `FilterPanel`, `FilterBar`, `GridToolbar`, `PreferencesModal`, `BulkActionBar`, `EditModeBar`, `Builder`, `ColumnCustomizer` | The factory shell mounts `AppShell` directly |
| `lib/format.ts` | `eur`, `eur0`, `num`, `pct`, `formatDate` — cents-based, fixed locale so SSR = client | Every monetary value in Factory OS renders through these |
| `docs/` + `README` + `CHANGELOG` (trimmed) | NAMING (`.h10-*` transitional policy), TOKENS, ACCESSIBILITY, CONTENT | Provenance: each copied file gets a one-line header naming the source path + copy date |

**Not copied:** `catalog/` + `studies/` (Nexus-internal governance; factory gets a thin `/design-system` catalog route of its own later), app-wide rail wiring (`_shared/AppNavRail.tsx`, `AppRail.tsx`, `components/layout/AppShell.tsx`) — Nexus-specific chrome with an acknowledged CSS-extraction TODO, and factory starts clean from the DS `AppShell`.

## The sidebar (the part the Owner loves)

Adopt the **DS `patterns/AppShell.tsx` rail** — the tokenized twin of `AdsSidebar.tsx` — with the ads rail's measured spec as the acceptance bar (values verified in `ads.css` and tokens):

| Spec | Value (verbatim from the codebase) |
|---|---|
| Geometry | 66px collapsed → **344px hover-expand** (pure CSS, overlays content — the page never shifts; shell reserves 66px), `.pinned` docks at 344px |
| Rows | 46px height, radius 10, 15px/600 labels; 50px icon zone with 20px lucide glyphs (glyph centres 33px = collapsed-rail centre) |
| Active state | **Blue fill (`--h10-primary` #1f6fde) + white text/icon only — same size/weight as siblings** (H10 does not embolden the selection) |
| Hover | `--h10-rail-item-hover` #e6eaf0; label fades in .14s |
| Brand area | 66px row: 28×28 radius-7 primary block + wordmark ("**Nexus** Factory" pattern: mark in rail-text-strong, accent word in primary/800) |
| Badges | Count badge absolute left:29px/top:6px, danger fill, 2px rail-bg ring; 7×7 status dots with the one-`margin-left:auto` rule |
| Balance rule (design law) | Trailing chevron mirrors the leading icon zone: glyph centre 25px from left edge, chevron centre 25px from right edge (8px margin + 17px) |
| Surface | `--h10-rail-surface` #f1f3f5, border `--h10-rail-line` #e3e7ec, `--h10-shadow-rail` on expand; rail pins light (`color-scheme: light`) like `.h10-shell` |
| Sub-nav | Indented 60px, 12.5px items; active = blue text/600, no fill; third level with tree-line border |

Factory nav registry mirrors `_shell/nav.ts` (`NavItem {label, route, Icon, children?}`): the 11 F0-IA pages, lucide icons, active test `pathname === href || startsWith(href + '/')`, groups auto-open on active route.

## The visual vocabulary above the DS (ads.css — reference, not dependency)

`marketing/ads/ads.css` (2,472 lines, ~226 KB, largely raw hex predating the token layer) is **not imported and not bulk-copied**. Where a factory surface wants an ads-console look that already has a `.h10-ds-*` equivalent, use the DS component. The handful of ads-only idioms worth carrying are re-expressed on tokens in factory CSS, citing the source family:

| Ads idiom | Factory treatment |
|---|---|
| `.h10-am-grid` (sticky `#f7f9fb` thead, 11.5px/700 headers, 13px cells, row hover `#f7faff`, selected `#eef5ff`) | DS `DataGrid` already encodes this — use it |
| `.h10-am-btn` action button (12.5px/600, border `#d8dde4`, r8; `.primary` blue) | DS `Button` — use it |
| `.h10-am-latest` freshness line ("**Latest Report:** … not real-time") | Re-express on tokens as the factory freshness line ("mail synced Xs ago · tracking polled Xm ago") |
| `.h10-cb-panel` content panel (white, border `#e6e9ee`, r12, padding 26/28/30) | DS `Card` covers it; keep the 26/28/30 rhythm |
| `.h10-pill` ok/warn/arch | DS `Pill` with the Tone vocabulary |
| Stub pages (`.h10-stub`: 22px/800 h1, crumb eyebrow, bordered panel) | The F1 "designed empty state" pattern for not-yet-built pages — purpose line + "coming in its page cycle" |

## Fonts + rendering parity

Loaded exactly as Nexus does (verified in `apps/web/src/app/layout.tsx:2-31`), which satisfies local-first: `next/font/google` self-hosts at build time — zero runtime requests.

- `Inter` (variable) → `--font-sans` · `Space_Grotesk` 400–700 → `--font-display` · `JetBrains_Mono` 400–700 → `--font-mono`; variables on `<html className>`.
- Body stack: `var(--font-sans), ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif`.
- **The smoothing split is deliberate and must be preserved:** app body `antialiased`, but the shell (`.h10-shell` idiom) sets `-webkit-font-smoothing: auto` so console text renders heavier — "design choice, not a bug" (tokens/typography.ts). Factory adopts the heavier shell rendering globally.
- Tailwind config carries `fontWeight.body: '450'` and the display/mono fallback chains — copy those config lines.

## Idiom reuse table (beyond the DS — the vendored spine)

From the F0 idioms recon; each lands in `apps/factory/src/vendor/` with a provenance header. Verdicts: ADOPT = copy near-verbatim; ADAPT = pattern kept, internals reworked for factory entities.

| Idiom | Source (verified path) | Verdict |
|---|---|---|
| CSV import with dry-run diff (parse-pure → per-row from/to/note/error diff → apply-valid-rows; one endpoint, `dryRun` flag) | `marketing/ads/ebay/_modals/ImportCsvModal.tsx` + `apps/api/src/services/marketing/ebay-ads-csv.service.ts` | ADOPT shape; reimplement against factory entities |
| Grid chrome: `BulkActionShell`, `GridFooter`, `PreferencesModal`, `AutoRefreshSelect`, `GridToolbar`, `VirtualizedGrid`, `SavedViewsButton`, `DensityToggle`… | `apps/web/src/app/_shared/grid-lens/` (20 components at HEAD) | ADOPT (already generic; skip Nexus-entity cells like `ProductIdentityCell`) |
| Spreadsheet substrate: `EditableCell`, undo/redo (50-step), find/replace, conditional format, drag-fill, `PastePreviewModal`, `PreviewChangesModal` | `apps/web/src/app/_shared/bulk-edit/` | ADOPT |
| Two-step bulk modal (select changes → review) | `marketing/ads/campaigns/CampaignsGrid.tsx` `BulkActionsModal` | ADAPT (DS components, factory actions) |
| Freshness: `FreshnessIndicator` ("Updated Xs ago", amber past stale) + multi-source line | `apps/web/src/components/filters/FreshnessIndicator.tsx`; `marketing/ads/ebay/_lib/banners.tsx` | ADOPT / ADAPT (one relative-time helper — Nexus has four copies) |
| SSE stack: bus + `?since=` ring replay + debounced hooks + `BroadcastChannel` invalidation | `apps/api/src/services/order-events.service.ts`, `apps/web/src/hooks/use-order-events-refresh.ts`, `apps/web/src/lib/sync/invalidation-channel.ts` | ADOPT (rename event vocabulary) |
| Comments + @mentions | `PoComment` schema + `CommentsPane` (PO detail) | **BEAT** — Nexus has two entity-scoped pockets and no notification delivery; factory builds ONE `Comment` table + mention fan-out + real autocomplete (F1 primitive) |
| Notification aggregator + browser notifications | `apps/web/src/app/inbox/InboxClient.tsx` (`InboxItem` shape); `lib/notifications/browser-notifications.ts` | ADAPT (SSE-pushed, read/unread added) |
| Command palette (⌘K, chords, live entity search, Recent) | `apps/web/src/components/CommandPalette.tsx` + `CustomEvent` opener contract | ADOPT (swap registry + search endpoints) |
| `TtlCache` + hover-warm prefetch | `apps/api/src/utils/ttl-cache.ts`; `products/[id]/edit/useHeaderPrefetch.ts` | ADOPT verbatim |
| Toasts | `apps/web/src/components/ui/Toast.tsx` (also DS `ToastProvider`) | ADOPT (prefer the DS one; keep the lesson: silent failures are banned) |
| Confirm-with-consequences + escalation ladder (confirm → diff-then-apply) | `components/ui/ConfirmDialog.tsx` + `ConfirmProvider.tsx` | ADOPT; the ladder becomes a design rule |
| Skeletons (variants, staggered lines, layout-preserving) | `components/ui/Skeleton.tsx` (also DS `Skeleton`) | ADOPT + the composition rule: skeletons approximate the real layout |
| Vault (AES-256-GCM secret storage) | `packages/shared` (`Vault`, `ENCRYPTION_KEY` 64-hex) | ADAPT pattern with `FACTORY_ENCRYPTION_KEY` (import of `@nexus/shared` itself is allowed — it's a published workspace package, not app code) |
| RBAC pattern (registry/gate/resolver/guards/`<Can>`) | `packages/shared/permissions.ts` + `apps/api/src/lib/auth/*` + `apps/web/src/lib/auth/*` | ADAPT per F0-ARCHITECTURE §RBAC |

## Parity checklist (verified at F1 gate and re-checked by `ds-parity-check.mjs`)

- [ ] Primary `#1f6fde` (`--h10-blue-600`); 14-step cool-slate grey ramp `#f7f9fb…#1c2530` (grey-25 → grey-900); canvas `#f4f6f9`
- [ ] Radius scale 4/6/7/8/10/12/14/999; navy-tinted shadows (base `20 28 38`); focus ring `0 0 0 2px rgb(31 111 222 / .12)`
- [ ] Type scale with **13px base**, 15px nav/modal titles, weights 500/600/700/800; Inter + Space Grotesk + JetBrains Mono via `next/font`
- [ ] Shell smoothing `auto` (heavier), body `450` weight rule
- [ ] Rail: 66/344px, 46px rows, 50px icon zone, 20px glyphs, blue-fill active, badge at 29/6, 25px balance rule, light-pinned
- [ ] Tone vocabulary everywhere (`neutral·info·success·warning·danger`); Modal widths 440/560/660/920
- [ ] `tokens:gen`/`tokens:check` wired in factory; parity script reports drift vs `apps/web` canonical (including the pending upstream `.h10-*` → `.nx-*` rename — treated as an upstream event to re-sync on, never to pre-empt)
- [ ] All five DS stylesheets loaded globally in the factory root layout; zero native `<select>`/`<input type=date>` (the DS-conformance ratchet rule, adopted from day one)
- [ ] Money always via `lib/format.ts` (cents in, locale-stable out); every integration panel renders a freshness line; skeletons never spinners; no layout shift

## No-touch guarantee (and how it's enforced)

1. **Scope fence:** all Factory OS code lives under `apps/factory/` (+ `docs/factory/`); F-series commits touch nothing else. F0 itself wrote only `docs/factory/*`.
2. **`no-touch-check.mjs`** (F1): fails if any `apps/factory` file imports from `apps/web`/`apps/api` paths (workspace packages `@nexus/shared`/`@nexus/database` are legitimate imports; `@nexus/database` is unused by design — factory has its own DB).
3. **Read-only parity:** `ds-parity-check.mjs` diffs but never writes to `apps/web`.
4. **Convention continuity:** every factory file opens with the repo's JSDoc header convention, F-series coded (verbatim Nexus examples: `ER1 —`, `ER3.1 —`, `CBN.2d —`; factory files use `F1 —`, `FP3.2 —`).
5. **Concurrent-session hygiene:** commits use `git commit --only` on factory paths; the copied DS/idiom files are taken from committed HEAD at F1 time (grid-lens/bulk-edit churned mid-recon and were committed by parallel sessions — expect drift, measure it with the parity script, re-sync deliberately).
