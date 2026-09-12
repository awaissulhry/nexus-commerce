# Variants page build — lane prompts (VP.1–VP.5), 2026-09-11

Launch each in its own terminal from the repo root, on Opus 5:

```
cd ~/nexus-commerce && claude --model claude-opus-5
```

Paste the lane's block as the FIRST message. Each block is self-contained: it begins with the lane name, then
the shared rules, then the brief. The Owner manages the sessions (ledger #794); lanes report to the Owner in
`docs/pes-claims.md` and in their own terminal. Nothing is committed until the Owner says so.

---

## SHARED RULES (already inside every prompt below — do not paste separately)

READ FIRST, in this order: (1) `docs/2026-09-11-variants-page-spec.md` — the Owner-approved build spec; §8 is
your lane's row, §9 is the verbatim copy, §7 is how you verify; (2) the canvas it names (four artboards — open
it, it is the visual contract); (3) `docs/2026-09-01-product-edit-studio-layout.md` §1b, §2.10 and §5;
(4) `docs/pes-claims.md` — rulings at the TOP (newest first; read #794, #753, #169, D9 #214), lane sections at
the bottom. RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only
your owned paths — anything else is a ledger request to its owner; build from scratch on the DS (old trees are
specification, never source; if the DS lacks a piece, it is added to the DS, never page-locally); nothing is
committed or pushed; local web on :3000 hits the PROD API unless `NEXT_PUBLIC_API_URL` points at a local one —
every write is real, so verify on the XAVIA family only (GALE-JACKET `cmokmy3a40078pm0p1fvnu523`, MISANO,
AIREON, XRI01) and announce a fixture in the ledger BEFORE writing it; typecheck etiquette: one `tsc` at a
time per app, private tsbuildinfo; a claim must match its measurement — report numbers, never adjectives; a
gate's exit code is read by running it bare. The design and the spec ARE the approval: write your phase plan
into your ledger section and proceed. STOP and ask the Owner only for: a write outside the XAVIA family, a
schema migration, a deviation from the spec, a deletion not listed in §6, or a conflict with another lane.
Say "100% done" only when every item of your §8 row is measured green, all §7 gates pass on one clean run,
the four canvas states show zero console errors, and your ledger section holds the numbers.

---

## VP.1 — frame, navigation, removal of the old page

```
You are VP.1 (frame + removal) on the Variants page build.

READ FIRST, in this order: (1) docs/2026-09-11-variants-page-spec.md — the Owner-approved build spec; §8 is your lane's row, §9 the verbatim copy, §7 how you verify; (2) the canvas it names (four artboards — the visual contract); (3) docs/2026-09-01-product-edit-studio-layout.md §1b, §2.10, §5; (4) docs/pes-claims.md — rulings at the TOP, newest first (read #794, #753, #169, D9 #214), lane sections at the bottom.
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only your owned paths — anything else is a ledger request to its owner; build from scratch on the DS (old trees are specification, never source; a missing piece is added to the DS, never page-locally); nothing is committed or pushed; local web :3000 hits the PROD API unless NEXT_PUBLIC_API_URL points at a local one — every write is real; verify on the XAVIA family only (GALE-JACKET cmokmy3a40078pm0p1fvnu523, MISANO, AIREON, XRI01) and announce a fixture in the ledger BEFORE writing it; one tsc at a time per app, private tsbuildinfo; a claim must match its measurement — numbers, never adjectives; read a gate's exit code by running it bare. The design and the spec ARE the approval: write your phase plan into your ledger section and proceed. STOP and ask the Owner only for: a write outside the XAVIA family, a schema migration, a deviation from the spec, a deletion not listed in §6, or a conflict with another lane. Say "100% done" only when every item of your §8 row is measured green, all §7 gates pass on one clean run, the four canvas states show zero console errors, and your ledger section holds the numbers.

YOUR BRIEF (spec §1, §2, §6, §8 row VP.1):
1. Navigation IA exactly as the canvas's "Product navigation" artboard: THIS PRODUCT = Information · Variants · Relationships · Media · Needs attention · Performance · Activity; channel groups = Listing information (+ eBay: Description themes; Shopify: Product family stays, §1.3). No per-channel Variants item. Icons from the existing STUDIO_TAB_ICONS set (lucide).
2. `tab=variants` mounts `_studio/variants/VariantsTab.tsx`: a switch only — master scope → VP.3's `FamilyVariants` (from `_studio/variants/family`), channel scope → VP.4's `ChannelProjection` (from `_studio/variants/channel`). Until those export, mount the studio's standard placeholder (states what it is, which lane builds it, what it needs). URL contract (`tab`, `scope`, `market`, `account`, `chip`) unchanged; `navigationHref` tests updated, not weakened.
3. `Relationships` tab: the studio placeholder with the §9 sentence. `variation-order` leaves the nav now; delete `VariationOrderTab` only after VP.4 posts its §1.4 verdict in the ledger.
4. DELETE the old page: spec §6 lists every file and line. The `workspace` prop threaded through MasterSheet.tsx / ChannelSheet.tsx / ChannelScopeTab.tsx belongs to PES.2/PES.3 — check the ledger for a live claim on those files, then claim the SURGICAL removal yourself and touch nothing else in them. Preserve `variants/coverage.ts`'s tuple logic by moving it to `_studio/variants/family/coverage.ts` (VP.3 imports it; agree the path in the ledger).
5. Measure on screen at 1440×900: the nav drawer (224px, groups, active item) and the band stack §2 with a placeholder mounted (49 · 40 · then the tab). Run `check-control-census.mjs` and `check-layout-v2.mjs`; report the numbers.
DONE = §8 row VP.1 green + §6 fully removed with `grep` proof (zero references) + tsc/vitest/gates green + ledger section with measurements.
```

## VP.2 — backend: family read, generate, projection, include/exclude

```
You are VP.2 (backend) on the Variants page build.

READ FIRST, in this order: (1) docs/2026-09-11-variants-page-spec.md — the Owner-approved build spec; §5 is your contract draft, §8 your lane's row, §7 how you verify; (2) the canvas it names (four artboards); (3) docs/2026-09-01-product-edit-studio-layout.md §1b, §2.10, §3, §5 and docs/pes5-phase0-backend.md §2–§3 (alias design, write routing); (4) docs/pes-claims.md — rulings at the TOP, newest first (read #794, #753, #169), lane sections at the bottom.
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only your owned paths — anything else is a ledger request to its owner; build from scratch on the existing services (old routes are specification; matrix.routes.ts is NOT source); nothing is committed or pushed; every API write from local is a PROD write — rehearse on the XAVIA family only (GALE-JACKET cmokmy3a40078pm0p1fvnu523, MISANO, AIREON, XRI01) and announce a fixture in the ledger BEFORE writing it; additive migrations are pre-approved, anything else needs the Owner; one tsc at a time per app; a claim must match its measurement — a write's RESPONSE is not what it wrote, read it back after a delay; read a gate's exit code by running it bare. The design and the spec ARE the approval: write your phase plan into your ledger section and proceed. STOP and ask the Owner only for: a write outside the XAVIA family, a non-additive migration, a deviation from §5, or a conflict with another lane. Say "100% done" only when every item of your §8 row is measured green, api tsc + vitest + inject probes pass on one clean run, and your ledger section holds the numbers.

YOUR BRIEF (spec §4.5, §5, §8 row VP.2):
1. FIRST PHASE, before any UI lane needs it: write `docs/vp2-contracts.md` with the FINAL shapes of §5.1–§5.4 (family read, generate with dryRun, projection read/write, include/exclude), including `limits` and `targetOptions` per channel (§4.5) and the `vocabulary.axisNoun`. Post the path in the ledger; VP.3/VP.4 code against it.
2. Storage is what exists (§5): `Product.variationAxes` via family-variation-axes.ts; child axis values in the attribute bag; mapping on the PARENT's ChannelListing.variationTheme/variationMapping per coordinate; inclusion = child ChannelListing row presence/status; split = ProductListingAlias (held: creatable=false with heldReason until PES.5-ii is confirmed live — measure it). 🔴 amazon-mapper.service.ts:112–180, listing-wizard/*, listing-snapshot.service.ts and flat-file/registry/channel-fields.ts (untouchable) READ variationMapping today: keep their shape or extend it additively and prove every reader still resolves — measured, listed in the ledger.
3. 🔴 Include/exclude must be a LOCAL-RECORD write: before shipping it, enumerate every consumer of the status/field you set (crons, feeds, publish paths, webhooks) and prove none pushes to a channel. List them in the ledger. DRAFT rows are live records.
4. Generate = dryRun plan first (Cartesian product of the given axis values minus existing tuples), then create children as full Product rows (status DRAFT, copy title/price/stock from the nearest sibling, SKU from the pattern with `{parent}`, `{axis}`, `{axis.code}` tokens; a SKU collision refuses by name). Version-checked (`expectedVersion` → 409 with `current`).
5. Probe every route with app.inject() (reference_api_route_probe_by_inject) and one real read-back on GALE-JACKET; timings in the ledger (the Amazon channel read is known slow — field-catalogue schema parse; do not regress it).
DONE = §8 row VP.2 green + vp2-contracts.md final + no-push-path proof + api tsc/vitest green + ledger numbers.
```

## VP.3 — shared-product Variants surface

```
You are VP.3 (shared-product Variants surface) on the Variants page build.

READ FIRST, in this order: (1) docs/2026-09-11-variants-page-spec.md — the Owner-approved build spec; §3 is your surface, §8 your lane's row, §9 the verbatim copy, §7 how you verify; (2) the canvas it names — artboards "Variants · shared product" and "Generate combinations" are your pixels; (3) docs/2026-09-01-product-edit-studio-layout.md §1b, §2.10, §5; (4) docs/pes-claims.md — rulings at the TOP, newest first (read #794, #753, #169, D9 #214, CH.1's two LANDED lines), lane sections at the bottom; (5) `_studio/sheet/master/` and `design-system/grid/` — the substrate you compose from (GridSheet host, NexusGrid rows="media-line", IdentityBand, CompletenessPill, SheetToolbar, useFamilyVerbs, AddVariationDialog, the master sheet's axis-column editors).
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only `_studio/variants/family/**` — anything else is a ledger request to its owner (DS pieces → VP.5, API → VP.2, frame → VP.1); build from scratch on the DS (old variants/ files are specification, never source); nothing is committed or pushed; local web :3000 hits the PROD API unless NEXT_PUBLIC_API_URL points at a local one — every cell edit is real; verify on the XAVIA family only (GALE-JACKET cmokmy3a40078pm0p1fvnu523, MISANO, AIREON, XRI01) and announce a fixture in the ledger BEFORE writing it; one tsc at a time per app, private tsbuildinfo; a claim must match its measurement — numbers, never adjectives; read a gate's exit code by running it bare. The design and the spec ARE the approval: write your phase plan into your ledger section and proceed. STOP and ask the Owner only for: a write outside the XAVIA family, a deviation from the spec, or a conflict with another lane. Say "100% done" only when every item of your §8 row is measured green, all §7 gates pass on one clean run, the two canvas states you own show zero console errors, and your ledger section holds the numbers.

YOUR BRIEF (spec §3, §8 row VP.3):
1. Export `FamilyVariants` from `_studio/variants/family/index.ts` for VP.1's switch. Family band (40px, §3.1), toolbar (§3.2, SheetToolbar with the §1.5 absent-views reason, family verbs + Reload in the one ⋯), grid (§3.3: GridSheet + NexusGrid rows="media-line", AG column groups PRODUCT · AXES · CHANNEL PROJECTIONS, IdentityBand identical to the sheet's, axis cells using the sheet's editors, VP.5's ProjectionCell for channel columns, rows ordered by axis-value order), footer.
2. Generate combinations dialog (§3.4) on the DS Modal md: dryRun → summary → create, exact copy from §9.
3. Until VP.2's `docs/vp2-contracts.md` is final, build against typed fixtures shaped by §5.1/§5.3 and switch without a redesign; until VP.5 exports AxisChip/ProjectionCell, use a local stub with the SAME props and delete it on switch. Coverage counts come from the moved `coverage.ts` (agree the path with VP.1 in the ledger).
4. Writes: axis cells through the master sheet's existing write (`masterWrite`, expectedVersion, 409 → repaint + refetch); include/exclude through VP.2's endpoint; fill-down must work and must not open an editor (`scripts/check-editor-open.mjs`).
5. Measure at 1440×900 against artboard 1: bands 40/40/30/28, rows 36, identity 380, controls 28, copy verbatim; zero console errors; census + layout gates green.
DONE = §8 row VP.3 green on live data (GALE-JACKET), gates green, ledger numbers.
```

## VP.4 — channel projection surface + mapping dock

```
You are VP.4 (channel projection surface) on the Variants page build.

READ FIRST, in this order: (1) docs/2026-09-11-variants-page-spec.md — the Owner-approved build spec; §4 is your surface, §1.4 your verdict to give, §8 your lane's row, §9 the verbatim copy, §7 how you verify; (2) the canvas it names — artboard "Variants · eBay projection + mapping" is your pixels; (3) docs/2026-09-01-product-edit-studio-layout.md §1b, §2.10, §5 and docs/pes5-phase0-backend.md §3 (write routing: `resolveWriteRouting`, `marketplaceContexts`, `writable`/`writeBlockedReason`); (4) docs/pes-claims.md — rulings at the TOP, newest first (read #794, #753, #169, CH.1's two LANDED lines, PES.3's section), lane sections at the bottom; (5) `_studio/sheet/channel/` (CascadeCell, SourceIndicator, channel write path), `_studio/drawer/StudioDock.tsx` (how a panel docks into the frame's track without covering the sheet), `design-system/grid/`.
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only `_studio/variants/channel/**` — anything else is a ledger request to its owner (DS → VP.5, API → VP.2, frame → VP.1); build from scratch on the DS; nothing is committed or pushed; local web :3000 hits the PROD API unless NEXT_PUBLIC_API_URL points at a local one — a pinned value or a toggled inclusion is a real write on a real listing; verify on the XAVIA family only (GALE-JACKET cmokmy3a40078pm0p1fvnu523 on eBay·IT account cmr4aaqb00025nz016k18rup9, MISANO, AIREON, XRI01) and announce a fixture in the ledger BEFORE writing it; one tsc at a time per app; a claim must match its measurement; read a gate's exit code bare. The design and the spec ARE the approval: write your phase plan into your ledger section and proceed. STOP and ask the Owner only for: a write outside the XAVIA family, a deviation from the spec, or a conflict with another lane. Say "100% done" only when every item of your §8 row is measured green, all §7 gates pass on one clean run, your canvas state shows zero console errors, and your ledger section holds the numbers.

YOUR BRIEF (spec §4, §1.4, §8 row VP.4):
1. Export `ChannelProjection` from `_studio/variants/channel/index.ts` for VP.1's switch. Mapping band (§4.1, VP.5's MappingChip), toolbar (§4.2, CH.1 channel verbs in the one ⋯), grid (§4.3: identity 380 · Included 90 · one column per mapped axis with the sheet's CascadeCell vocabulary — link = inherits, pin + 7% tint = pinned · Listing fill), footer.
2. Mapping dock (§4.4): docks into the frame's track exactly like StudioDock (sets `--studio-dock-w` on the track, in-flow sibling, sheet shrinks; popups inside must be `position: fixed` or they are clipped by the track). Explicit `Save mapping` with expectedVersion → 409 handling like the sheet; unsaved changes arm the studio navigation guard. Split option rendered and HELD with its reason until VP.2 reports `creatable: true`. Lock banner only when the coordinate has a live listing; locked axes disabled with the same reason.
3. Pinned values write through the EXISTING channel write path only (no new endpoint); include/exclude through VP.2's endpoint; the mapping through VP.2's PATCH. Until `docs/vp2-contracts.md` is final, build against typed fixtures shaped by §5.4.
4. §1.4 VERDICT, early: read `PresentationTab.tsx` mode="order" and its API; post in the ledger what it orders. If it orders the variations/specifics buyers pick from, fold it into the dock's drag order; otherwise say where it stays reachable. VP.1 deletes `VariationOrderTab` only on your verdict.
5. Measure at 1440×900 against artboard 2: dock 420, bands 40/40/30/28, rows 36, controls 28, copy verbatim; zero console errors; census + layout gates green.
DONE = §8 row VP.4 green on live data (eBay·IT), the §1.4 verdict posted, gates green, ledger numbers.
```

## VP.5 — design-system pieces + conformance

```
You are VP.5 (design system + conformance) on the Variants page build.

READ FIRST, in this order: (1) docs/2026-09-11-variants-page-spec.md — the Owner-approved build spec; §2 (chrome measurements), §3.1/§3.3/§4.1 (the three pieces), §7 (gates), §8 your lane's row; (2) the canvas it names — all four artboards are your acceptance reference; (3) docs/2026-09-01-product-edit-studio-layout.md §1b and §2.9 (DS shortfalls are fixed IN the DS); (4) docs/pes-claims.md — rulings at the TOP, newest first (read #794, #753, CT.1/CH.1 lines on the control vocabulary), lane sections at the bottom; (5) `apps/web/src/design-system/` (primitives FilterChip/Tag/Button/Checkbox, grid/renderers IdentityBand + cells + readiness.ts, tokens/grid.ts, styles/*.css), `scripts/check-control-census.mjs`, `scripts/check-layout-v2.mjs`, `.claude/DS-GAPS.md`.
RULES: claim your lane in the ledger before editing (session name, lane, date, files); edit only `design-system/**` (additions), the two gate scripts and DS-GAPS — anything else is a ledger request; every piece is a DS component with `.nds-*` styles in the DS stylesheets, exact tokens (28px `--nds-control-h-sm`, `--nds-radius-lg` 8 / `-sm` 6 / `-pill`, `--nds-font-size-*`), light AND dark (every alias restated in `.dark` — `scripts/check-dark-alias-scope.mjs`), contrast measured (4.5:1 text, 3:1 glyphs); nothing is committed or pushed; one tsc at a time per app; a claim must match its measurement; read a gate's exit code bare. The design and the spec ARE the approval: write your phase plan into your ledger section and proceed. STOP and ask the Owner only for a deviation from the spec or a conflict with another lane. Say "100% done" only when the three pieces ship with tests, both gates cover the variants surfaces, the end-of-wave measurement of all four states is posted with numbers, and your ledger section holds them.

YOUR BRIEF (spec §1.6, §2, §7, §8 row VP.5):
1. FIRST PHASE (VP.3/VP.4 wait on it): export from the DS — `AxisChip` (primitive: grip 13px `--nds-text-3` · label 12.5/600 · count `Tag neutral`; 28px, radius 8, border `--nds-border`; draggable handle slot; pressed/focus states like `.nds-btn`), `MappingChip` (from 12.5/500 `--nds-text-2` · arrow-right 12px · to 12.5/600; 28px), `ProjectionCell` (grid renderer: 15px checkbox · 7px status dot keyed by `readinessMeta(state,'row')` tone, hollow for neutral, none for muted · word · optional mono detail right; disabled state for "Not set up"; works with AG fill-down). Props documented in `.d.ts`, vitest for the tone mapping and the disabled state, an entry in the DS catalog page.
2. Extend `check-control-census.mjs` with the four variants surfaces (master · variants, ebay·IT · variants, dock open, generate modal open) and `check-layout-v2.mjs` with the variants band budget (§2: 49 · 40 · 40 · 40 · 30 · 28+1 · 36×n · 36; dock 420; identity 380). Each assertion returns the measured value.
3. END OF WAVE: when VP.1–VP.4 report done, measure all four canvas states on GALE-JACKET at 1440×900 against the canvas — band heights, control heights, radii, type sizes, copy verbatim (§9), light and dark — and post the table in the ledger. Route each mismatch to its owning lane as a ledger request with the number. You measure; the Owner rules.
4. File every gap you find in `.claude/DS-GAPS.md` with the measurement (append-only gate).
DONE = three pieces exported with tests + both gates extended and green + the end-of-wave table posted + ledger numbers.
```
