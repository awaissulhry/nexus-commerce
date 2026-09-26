# VTR research 2 — the variation theme per channel (read-only, 2026-09-26, code at 8a345981f)

Paths: **A** = `apps/api/src/services/`, **W** = `apps/web/src/`, **R** = `apps/api/src/routes/product-studio.routes.ts`. "VERIFIED" = read in code; nothing was run.

## 1. Per channel: what is stored, what publish sends, and where they differ

**Shared engine.** `resolveVariationProjection` picks the first of three sources: this coordinate's override, then the category rule,
then a theme derived from `Product.variationAxes` (A `pim/variation-rules.service.ts`). The sheet cell is built at A
`pim/studio-sheet.service.ts:1639-1700`; publish loads the same projection through A `pim/stored-variation-projection.ts:20-37`.
One save route: `PATCH /studio/projection` (R:229 → A `pim/family-projection.service.ts:1785-1839`), written to the family parent's
`ChannelListing` of that coordinate (channel × market × account × aliasKey).

**Amazon**
- Stored: `ChannelListing.variationTheme` + an ordered `variationMapping` (`family-projection.service.ts:1821`); theme list = the
  cached `CategorySchema` enum (`variation-theme-facts.ts:87-114`).
- Publish: JSON_LISTINGS_FEED; each included axis value → `values[axis.target]` (`studio-publication-amazon.ts:134-137`); the mapped
  `variation_theme` is deleted (`:147`) and re-emitted by the feed builder (`amazon/flat-file.service.ts:3009-3024`).
- Mismatch: publish treats a child with NO listing row as INCLUDED (`studio-publication-plan.ts:41`); the sheet/dock treat it as
  EXCLUDED (`family-projection.service.ts:1312`) → shown counts and collisions can differ from what is sent.

**eBay**
- Stored in `platformAttributes`: `_variationAxes`, `_axisNameLabels`, `_variationAxesMode`; value order `_axisValueOrder`
  (`family-projection.service.ts:1814`). Fallback `Product.variationTheme` — ONE string for every market and alias
  (`variation-rules.service.ts:387-399`).
- Studio publish (Trading API) sends the projection's channel NAMES (`studio-publication-ebay.ts:194`) but the MASTER stored VALUES
  (`:195-198`; `stored-variation-projection.ts:7-17`).
- Mismatches: the sheet/dock show per-channel pins and value-mapped values (`studio-sheet.service.ts:708-720`); publish overwrites
  them with master values and ignores `_axisValueLabels`. On IT, names are rewritten to canonical Italian
  (`ebay-shared-listing-push.service.ts:112-122`). The legacy Inventory push hard-codes `aliasKey:''`
  (`ebay-variation-push.service.ts:951,982`) → an alias listing publishes the main listing's axes.
- A live revise cannot change `VariationSpecificsSet`/variation content (`studio-publication-ebay-changes.ts:128-138`); validation
  (collisions, missing values, unset theme) runs only when `!itemId` (`studio-publication-ebay.ts:190-198`) — live re-publish unvalidated.

**Shopify**
- Stored: `variationMapping`; option names are free text. Publish: `productOptions`/`optionValues` via `productSet`
  (`shopify/content-publisher.ts:213-258`), master values.
- Mismatches: projection built with `axisLabels:{}` (`shopify/content-workspace.service.ts:80`) → a derived option name can differ
  from the sheet's label (likely; not run). Value order: the Variants page offers a drag whose comment says the publisher uses it
  (`family-projection.service.ts:1079-1084`), but values seem sent in first-seen order (`content-workspace.service.ts:59`) — NEEDS A RUNTIME CHECK.
- Studio publish only for NEW products (`pim/studio-publication.service.ts:77-78`); refuses a family with any excluded variant (`:74`).

**Etsy** — stored like Shopify; NOTHING publishes it ("not available yet", `studio-publication.service.ts:90`; no builder).

## 2. Channel operations today

| Operation | Where | API | Bulk? |
|---|---|---|---|
| Pick Amazon theme / map axis → attribute / rename axis / drop or reorder axes / reset | Information cell (`AxesPanelEditor.tsx`) AND Variants dock (same panel) | `PATCH /studio/projection` (R:229) | **No** — one family × one coordinate per commit; fill handle suppressed, paste refused (`shapeColumn.ts` `suppressFillHandle`, no `valueParser`); no "apply to other markets" |
| Category rule (theme, axes, resolver, split) | Channels → Mapping | `PUT /pim/channel-mapping/:ch/:code/variations[/:cat]` | Yes per category; **resolver + split stored but never executed** (only `variation-rule-store.ts`, `variation-rule-view.service.ts` read them) |
| Pin a per-channel value | Information channel sheet cells + dock | `PATCH /api/products/bulk` (`pinValue.ts`) | Sheet: yes (fill/paste); **eBay studio publish ignores the pin** |
| Value maps | Settings → Mappings (`FieldValueMap`) | — | per channel × market; not sent by eBay studio publish |
| Order values | eBay only: Variation order tab (`PresentationTab.tsx`, `/api/ebay/cockpit/presentation-order`) + dock "Order values" (`dock/sections.tsx:122`) — two writers, one store | | No |
| Include/exclude variants per listing/alias | **Variants tab only** (`useProjection.ts:98`) | `PATCH /studio/projection/children` (R:264; API takes 500) | UI sends one row per call; no collision/limit check (`family-projection.service.ts:1895+`) |
| Split into several listings | dock only, HELD ("until listing aliases are enabled", `:967`, `:1389`) | dock sends `split`; route **drops it silently** (R:234) | — |
| Theme change on a live listing | cell/dock commit opens a plan (`ThemeChangePlanModal.tsx`) | `POST /projection/theme-change` — **dry run only, no executor** (R:297-306) | No |
| Family axes (master) | Information master cell | `PATCH /studio/variation-axes` (R:169) | **No live-listing check or plan** (`family-variation-axes.ts:47-74`) |
| Pictures by axis | Media tab | images-workspace routes | — |

## 3. Limits and inconsistencies (VERIFIED unless marked)

- The only all-channel gate: projection save (`family-projection.service.ts:1798-1801`) — axis count, unique channel name per axis,
  Shopify names ≤255, closed target list.
- Amazon: theme in enum + not deprecated (`:1774`); mapping = the theme's attributes exactly (`:1779`); studio publish refuses no
  theme/errors (`studio-publication-amazon.ts:75-76`) but does NOT re-check deprecation or per-child missing values (the wizard does:
  `listing-wizard/amazon-publish.adapter.ts:164-169`).
- eBay: NO category "variations allowed" check; targets limited to variation-enabled aspects → eBay custom-name variations impossible;
  5 axes enforced on save, silently truncated elsewhere (`ebay-theme-axes.ts:27`, `variation-rules.service.ts:727-737`); 250 variants /
  65-char values / 40-char names only WARN (`ebay-variation-preflight.ts`); studio path has no variant-count check.
- Shopify: 3 axes enforced; variant limit — UI says 100 (`family-projection-limits.ts:107`), publish enforces 250
  (`shopify/content-publisher.ts:44`, `packages/shared/shopify-content.ts:126`); Shopify's current 2048 appears nowhere; option-value
  length unchecked.
- Etsy: 2 properties / 70 variants only in the projection spec table; nothing sends them.
- Collisions: checked on save (`:1782`) and at publish (Amazon; eBay first publish; Shopify); the 3 resolvers read-only
  (`dock/sections.tsx:258`); include/exclude skips the check.
- **Bug — eBay order tab "Restore inherited ordering/axes"** deletes `_variationAxes` but leaves `_variationAxesMode='override'`
  (`ebay-presentation-order.service.ts:104,107`) → `ebayAxisSet` returns an explicit EMPTY set → every eBay axis dropped
  (`variation-rules.service.ts:396`, `:670-684`). Seen in code, not run.
- Markets: each market has its own theme; the eBay fallback is one value for all; no control copies a theme across markets.
- Master axis edits bump every listing's version but never plan for live listings (`family-variation-axes.ts:66`).
- Stale docs: `PHASE12D-VARIATION-SYNC-ENGINE.md` (dead code: worker handles `VARIATION_SYNC` at `workers/bullmq-sync.worker.ts:359`,
  nothing enqueues it); `2026-09-12-variation-projection-design.md` cites a missing `variation-preview.service.ts`.

## 4. Scenarios, and what happens today

1. Many families, same category, same theme → only the category rule; studio = one family at a time.
2. Same theme on all EU Amazon markets / all eBay sites → one coordinate at a time.
3. Amazon product type with no cached schema / no theme → "unavailable"/"no-theme", save refused; no fetch-schema action in the cell.
4. Amazon theme deprecated after choosing → save refuses, studio publish does not.
5. eBay category not variation-enabled → undetected.
6. eBay custom specific name → impossible.
7. Shopify 4+ axes / Amazon theme narrower than the family → trailing axes dropped + collision; fold not built, split held, only exclude.
8. >250 variants eBay, >100/250 Shopify → eBay warns; Shopify numbers conflict.
9. Values >65 (eBay) / >255 (Shopify) → warn / unchecked.
10. Channel value (pin/value map) ≠ master → sheet shows it, eBay studio publish sends master.
11. Alias with its own subset → sheet: rowless = excluded; Amazon/eBay publish: included; Shopify refuses any exclusion.
12. Split a family into several listings → held.
13. Theme/axis-set change on a live listing → plan only, no executor; eBay order-only saves; master axis edits bypass the plan.
14. Live eBay re-publish → variation structure refused, validation skipped.
15. Value order → eBay two editors one store; Shopify stored maybe not sent; Amazon fixed by theme; Etsy stored never sent.
16. eBay order tab restore after an override → whole eBay axis set lost (bug).
17. Master axis renamed/added on a live family → no per-channel warning.
18. Etsy → editable, never published; UI should say so or hide it.

## 5. Reuse vs rebuild

**Reuse:** the resolver, projection read + write (version check, lock, collision, limit, closed-list gates), `theme-change.service`
plans (one engine; cell and dock share it), `AxesPanelEditor` (both hosts), the `VariationThemeCell` contract (`docs/vt1-contracts.md`),
the category rule store.

**Fix/rebuild:** (a) bulk: multi-coordinate + multi-family apply ("apply to markets" plan); (b) move include/exclude, value order and
pins into Information before the Variants tab goes; (c) one value source for publish — eBay studio must send the effective channel
cell; (d) one definition of "included" for projection and publish; (e) merge the two eBay order writers + fix the reset mode;
(f) real limit + eBay category checks (variations allowed, 250 variants, value lengths, Shopify 2048); (g) build or remove split,
fold, resolver controls; stop the dock sending `split`; (h) master axis changes through the live-listing plan; (i) archive PHASE12D.

**Open question:** Values, Collisions, Split sections (now only in the Variants dock) → into the cell editor, or a docked panel on the
Information sheet?
