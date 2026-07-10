# UFX — Unified Flat-File Excellence

**Date:** 2026-07-10 · **Status:** APPROVED (user: "Proceed however you recommend") · **Approach:** Option B extract-then-swap, phase-by-phase, verify each unit, commit+push after each verified unit.

## Goals (user's words)
1. Amazon flat file absolutely perfect — multiple categories in one file, all columns shown and greyed (like eBay) when irrelevant **but still editable**.
2. Infinite Excel-like grid (blank canvas rows) — both Amazon and eBay.
3. One **shared grid component** for both flat files, improved.
4. Find + fix every schema error; research + adopt what Amazon's official format has that we missed.
5. Identify and fix all other UI/UX issues — best in class.

## Research base (6 read-only agents, 2026-07-10)
Key findings each phase builds on:

### Multi-category (Amazon) — current truth
- Reload silently drops union sheets (MT.4b unfixed): `sheetTypes` init single (`AmazonFlatFileClient.tsx:719`), draft restore reads single-type key (`:1159`), composite `A+B` draft orphaned.
- Greyed not-applicable cells are **inert** (`:7079,:7244,:7260,:7411`) — must become editable-with-shading (eBay semantics). Feed already prunes not-applicable attrs server-side (`flat-file.service.ts:2231`) so this is safe.
- Broken: copy-to-market single-type keyed (`:4019-4078`, collapses union sheets); per-row enum validation missing client+server; required-⚠ union-over-marks (`requiredForProductTypes` declared `:149`, never read); variation themes flattened (`flat-file.service.ts:994-998`); no remove-category cleanup; add-category double round-trip reflow.
- Works: union merge (`:957-1009`), filter chips, type-aware server submit (`routes:334-359,479`).

### eBay pattern (the model Amazon adopts)
- `getCellGuidance(col,row)` → `'not-applicable'|'optional'` (`EbayFlatFileClient.tsx:2080-2115`), overlay only when not active/selected (`FlatFileGrid.tsx:442-446`), tooltip, **fully editable**.
- Ghost columns ` ⚠` from data-not-in-schema (`ebay-columns.ts:821-840`).
- Defect: aspect_* edit intercept (`EbayFlatFileClient.tsx:2071`) routes ghost columns to the panel which can't edit them — typing dead, only paste works (Delete/paste bypass the intercept: `FlatFileGrid.tsx:1353,1430`).

### Grid internals / "infinite grid"
- Amazon private grid has the right model: `_ghost` trailing canvas rows, `GHOST_BUFFER=8`, auto-topup (`:1729-1737`), inert until materialized (`:3365`), excluded from counts/save/export.
- Shared grid instead pads to `minRows=15` where eBay's `makeBlankRow` wrongly flags pads `_isNew/_dirty` (`EbayFlatFileClient.tsx:129`); paste-beyond-end refuses to grow (`FlatFileGrid.tsx:1431-1436`); "No products yet" empty state unreachable (`:2584-2596`).
- Both grids: CSS content-visibility, no windowing, no horizontal virtualization. "Infinite" = auto-growing ghost canvas (bufferable, e.g. 25–50), NOT unbounded DOM.

### Unification (Option B rationale)
- The grids are forks of one lineage; toolbar/panels/find-replace/groups/AI already shared. Divergence = table body + interaction controller (~2,600 lines in Amazon, ~90% mirrored in FlatFileGrid).
- Contract gaps to close additively: ghost-row lifecycle, `getCellReadOnly` predicate (FBA lock — `getCellGuidance` can't block edits by design), first-class `applicableProductTypes`, inline image/ASIN bridge, entry-anchor keyboard (Amazon-only Sheets nicety; eBay Enter-after-Tab currently wrong).
- Invariants (verbatim preservation in Phase 3): FBA qty read-only + `—`; `normalizeSyntheticCell` at all Amazon bulk-write points (paste `:2026,:2031`, fillDown `:2059`, executeFill `:2096`, fillToBottom `:2132`, AI `:1264`, delete); `_needsPublish` tri-state (`:188,:2483,:3448`); `ri=displayRows` index invariant; autosave flush on market switch (`:2933`); FBA/FBM auto-sections.

### Schema pipeline (16 findings; full report in session)
- **P0-1** Conditional/nested requireds never derived — only top-level `def.required` (`flat-file.service.ts:1183`); `items.required`, if/then, dependentRequired ignored → "grid says filled, Amazon 90220".
- **P0-2** Sub-prop numeric coercion by `Number()` sniffing not schema type (`:2243-2244`, TSV twin `:2861`) → `"38"`/leading-zero codes corrupted.
- **P1** Validation split-brain: client required = union OR (`Client:1510`), server preflight has NO enum check (`listing-preflight.service.ts:110-174`), client enum warn-only (`:1522`); parent-required (variation_theme) not in grid errors; stale `channel-schema.service.ts` validatePackage (hardcoded char caps).
- **P2** Object/array sub-props dropped (`:784-788`); `wrappedSubPropFields` only single-sub-key (`:465`); multi-instance capped at 5 vs maxUniqueItems 20 (`:697`); Pattern-C localized sub-props miss language_tag (`:2288`).
- **P3** Stacked 24h caches (server `schema-sync:251` + client `ff-manifest-*` TTL `:360`) — no bust on refresh; union `defaultProductType` scalar (`routes:480`) can stamp wrong type.
- **P4** enumNames positional zip unguarded (`:289`); multi-instance emission skips numeric/boolean typing (`:2276`); `$ref` unresolved (low risk).

### Amazon official-format gaps (web research, sources in session report)
- **P0** `hidden` attribute flag not filtered; `editable` flag not honored (locked fields editable on live listings).
- **P1** GPSR/EU compliance attrs no first-class handling (mandatory Amazon IT since Dec 2024 — Responsible Person, manufacturer, safety docs).
- **P1/P2** Full UPDATE where PATCH/PARTIAL_UPDATE safer; `requirementsEnforced` ignored; `selectors` array-uniqueness; `$lifecycle`/`enumDeprecated` migration.
- **P3** Mirror official template UX: red/blue/optional requirement color legend, Data Definitions side panel (type + limit + example per column).

## Phases (tasks #1–#8)
1. **Server schema correctness P0/P1** — conditional/nested requireds; typed sub-prop coercion; preflight enum check (per-row type); enumNames guard; multi-instance typing; localized sub-prop language_tag. Independent of grid work.
2. **Shared-grid convergence (additive, eBay = oracle)** — entry-anchor keyboard; `getCellReadOnly`; first-class `applicableProductTypes` greying; ghost canvas rows (opt-in) + paste-auto-grow + eBay adopts (kills dirty-pad bug, unreachable empty state); image/ASIN bridge.
3. **Port Amazon page onto shared grid** — delete forked grid; rewire page state onto slots; invariants verbatim; golden-master dry-run payloads before/after.
4. **Multi-category perfection** — greyed-but-editable; MT.4b reload restore; union-aware copy-to-market; per-row required/completeness/enum; per-type variation themes; remove-category cleanup; add-category single round-trip.
5. **eBay parity** — ghost-aspect inline-editor fall-through; semantics alignment; audit items.
6. **Format adoption** — hidden/editable; GPSR; PATCH/PARTIAL_UPDATE + requirementsEnforced; maxUniqueItems/selectors/multi-sub wrapped/object sub-props; cache busting; deprecated-enum hints; requirement legend + Data Definitions panel.
7. **UI/UX best-in-class** — from the dedicated glitch audit (report lands separately; scope appended below when in).
8. **Verification sweep** — full suites, regression scripts, prod verify, browser screenshots, memory/docs.

## Standing rules honored
Approval granted for engagement; FBA quantity guard never weakened; additive migrations only (none expected); commit+push per verified unit; verify on prod; design-system components + tokens for new UI; UI self-verify with screenshots before showing; no live eBay/Amazon pushes without operator.

## Phase 7 scope (UX audit findings, 2026-07-10)
Root cause of most inconsistencies = the grid fork — Phase 3 unification dissolves several automatically. Remaining explicit fixes:

**P1 daily friction**
1. Right-click context menu in shared grid (backlog #15) — Amazon has full ContextMenu (`AmazonFlatFileClient.tsx:5488-5509,9742-9789`), shared grid has none. Port it during Phase 2/3 (it comes along with the Amazon controller) so eBay gains it.
2. Enum dropdowns not portaled (#71) — clip inside `overflow-auto` on bottom rows (both grids; only Amazon's context menu clamps `:9769`). Portal + flip.
3. eBay market Alt+1..N dead on macOS — `parseInt(e.key)` gets `¡` (`FlatFileMarketStrip.tsx:49`); Amazon correctly uses `e.code` Digit match (`Amazon:3046`). One-line fix + align guard sets (SELECT/isEditing/Shift).
4. No unsaved-changes nav-away guard anywhere (no beforeunload/route guard; `ChannelStrip.go()` pushes straight through). Add channel-switch + tab-close confirm when dirty (draft autosave mitigates but doesn't replace).

**P2 significant**
5. Market strips diverged: Amazon has latency badge + hover prefetch, no has-data dot; eBay has dot + spinner, no prefetch/latency. Unify one strip with all features.
6. Frozen-column translucent stateful backgrounds bleed during horizontal scroll (residual #48): selected/error/warn/fill/guidance all `/60-/80` alpha over sticky cells (`FlatFileGrid.tsx:443-469` vs opaque header `:2350`). Force opaque compositing on sticky cells.
7. Paste has no CSV-quote handling — multi-line quoted cells from Excel explode into rows (both: `FlatFileGrid.tsx:1380-1414`, `Amazon:1995-2041`). RFC-4180-aware tokenizer (deferred audit item #29 — now in scope).
8. Resize-handle double-click resets width instead of auto-fit-to-content (#50) (both: `FlatFileGrid.tsx:2370`, `Amazon:5676`).
9. No per-column hide/reorder or filter row (#51) — only group-level today. Add per-column hide + reorder (persisted), header menu.
10. Two divergent FindReplaceBar copies (`app/_shared/bulk-edit/...` vs `app/bulk-operations/...`) — unify onto one file.
11. Save affordance wording/shape differs (inherent Amazon-feed vs eBay-publish divergence — align visual language post-Phase 3).

**P3 polish**
12. Amazon loading skeleton strip h-9 vs real h-8 (`amazon-flat-file/loading.tsx:20` vs `ChannelStrip.tsx:73`) — 1px layout shift.
13. IME/dead-key composition unhandled (#76) — first composed keystroke can be swallowed in type-to-edit cells.
14. No compact/comfortable density toggle; no true full-screen mode.
15. Amazon lacks empty-state onboarding CTA (eBay wires `renderEmptyAction`).

Verified-consistent (don't re-litigate): undo depth 50, status-bar aggregates (it-IT aware), inputMode=decimal number cells, validation jump-to-cell, `?` shortcut cheat-sheet, skeleton loading.
