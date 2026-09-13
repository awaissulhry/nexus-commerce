# The Matrix page (MX) — assessment, design and build plan

**Status:** 🟢 **APPROVED 2026-09-13 as REVISED below (frontend build; backend later).** Originally FOR APPROVAL. Written by session `[d4423145]` from the Owner's handwritten plan
(photo `~/Downloads/IMG_7998.HEIC`, transcribed verbatim in §0), the code as it stands on the working tree this
morning (§1 — every reading taken today, three read-only code maps + SELECT-only queries on the local Docker
database `nexus_development`, GALE `Product.version` 59), and the programmes this composes with: the Variants
page (`docs/2026-09-11-variants-page-spec.md`, **BUILT** by VP.1–VP.5 + VP.F, 09-12), the Variation theme column
(`docs/2026-09-13-variation-theme-column-design.md`, VT.1/VT.2 **in flight today**), the variation projection
design (`docs/2026-09-12-variation-projection-design.md`, VX, for approval), Sync Control (SC, **shipped July
2026**, `docs/SYNC-CONTROL.md`), the Follow Master tool (shipped July), and the market-features placement
design (`docs/2026-09-05-market-features-placement-design.md`, reports 18 · 19 · 25 · 28, for approval).
**Nothing is built by this document. Nothing is committed.** Canvas (six artboards): https://claude.ai/code/artifact/3d5563a7-5779-4f78-96ad-9c3a4356876e

**What this document is:** (a) the Owner's plan, item by item, with a verdict on each; (b) the design that
results — ONE Matrix page in the Product Edit Studio, rows = the family's variants, columns = every channel ×
market × alias the family is listed on, cells = the offer and inventory controls the operator actually
turns; (c) the contracts, the order of work, and the decisions only the Owner can make, each with the default a
lane proceeds on.


---

## Revision — 2026-09-13 (the Owner's decision, in the terminal)

**Ruled:** "keep what's already on the Variants page aside, and build a NEW Matrix page with what's actually left …
design the complete frontend; the backend later in another session … everything aligns with our design system,
AAA quality." This revision binds; where §3 says the Variants page *becomes* the Matrix (D-MX1), read the following instead.

| item | now |
|---|---|
| **The Variants page** | UNTOUCHED. Axes, coverage, generate, add variant, per-coordinate inclusion, mapping band and dock stay there. The Matrix does not repeat them |
| **The Matrix page** | NEW tab `matrix`, label `Matrix`, directly under Information (`STUDIO_TABS`: `sheet · matrix · variants · …`). ONE state: every coordinate at once. The scope bar's channel chips FILTER the coordinate groups on this page (Shared product = all); the market listbox narrows further. No page band — chrome is top bar · subheader · scope bar · toolbar · strip · header |
| **What is on it (§3.3 minus the Variants parts)** | PRODUCT (identity, pinned) · SHARED (`Base price` · `Stock` — the routed pool — · `Status`) · one GROUP per coordinate with `Listing` (read-only state word; inclusion stays on Variants) · `Fulfilment` · `Mode` · `Qty` · `Buffer` · `Sync` · `Price` · `Sale`; the Amazon EU region rule (§3.5); aliases as coordinates (§3.10); `Not listed` singles |
| **Frontend first, backend later** | The page reads `GET …/studio/matrix`; while that route does not exist it renders PREVIEW cells on the REAL rows (`contract.ts` → `fixtures.ts`), says so in a DS `Banner` on every load (`MATRIX_COPY.previewBanner`), and applies writes and verbs to an in-memory store with the same versions/CAS/revert semantics the service will have (`store.ts`, `preview.ts`). `MatrixRead.source` is the ONE discriminator; nothing in preview mode reaches a channel. When the service lands, `source.ts` switches on the probe — no redesign |
| **The contract** | `apps/web/src/app/products/[id]/edit/_studio/matrix/contract.ts` is the wire authority (types + endpoints + copy); `preview.ts` is the verbs' specification; the backend session implements both. `docs/mx1-contracts.md` is superseded by these files |
| **Lanes** | Frontend only: MX.C (this session — contract, fixtures, preview engine, store, tests: DONE), MX.G (GDS cells + writer branch + registry + gate rows), MX.P (the page + frame + toolbar + views + verbs UI), MX.F (final pass). Prompts in `docs/mx-prompts.md` |
| **Decisions** | D-MX1 is REPLACED by the above. D-MX2, D-MX3, D-MX7 (no theme/axes here), D-MX8, D-MX9, D-MX11, D-MX12 stand. D-MX4/5/6/10 are backend-session items and stay open |

---

## 0. The Owner's plan (2026-09-13, transcribed from the photo)

> **The Matrix page:** Our current live system had a quantity control system across channels and marketplaces.
> It basically worked like an SKU deriving its inventory from a shared pool of a certain location if the SKU was
> set to *follow* in the column. We could have also written *pinned* in the column and it would stop following
> the pool, just for that specific scope/market. We also had a *Buffer* thing to stop overselling when set to
> follow. We could *Pause* sending inventories and then *resume* again which started pushing inventories again.
> This also helped resolve a lot of issues, e.g. once I converted a product from FBA to FBM but the inventory
> went back to 0. Instead of publishing it all again I simply paused and resumed the inventory and the
> quantities were immediately pushed.
>
> - I am planning on managing it all on the Matrix page.
> - I should be able to manage the prices on the Matrix page.
> - Should we transfer what we planned to do on our Variants page, because I plan on removing the Variants
>   page. Is it really of value?
> - Should we have the FBM/FBA toggle on the Matrix page for Amazon scopes and different markets?
> - Amazon doesn't support different quantity for the same SKU & ASIN across different markets.
> - Should we include business pricing here as well?
> - Should we include management of variation theme and axes on the Matrix page or no? In my opinion not
>   really, or maybe we should. What do you recommend?
> - It must support multiple aliases.
> - Should the Matrix page be built using the shared product sheet?
> - Should we add the status column? And give ability to add/manage variants?
> - At last propose the layout, get approval and build it all. EVERYTHING HAS TO BE AAA QUALITY.

---

## 1. What is true in the code today (measured 2026-09-13; check, do not trust)

| # | reading | value |
|---|---|---|
| M1 | **The quantity control system the Owner describes EXISTS and is LIVE.** It is Sync Control (SC.0–SC.6, July 2026) + the Follow Master tool. ONE pure resolver decides what every listing advertises | `apps/api/src/services/sync-control-core.ts:146` `resolveIntendedQuantity` — precedence **FBA_EXCLUDED → CLOSED → PAUSED (policy) → PAUSED (listing) → PINNED → FOLLOW (routed ledger − buffer) → UNCOUNTED** (empty ledger pushes NOTHING, never zero). Consumed by the cascade, dispatch re-reads, read-backs, imports and the Sync Control page. `docs/SYNC-CONTROL.md` matches the code |
| M2 | the stores behind Follow / Pinned / Buffer / Pause | `ChannelListing.followMasterQuantity` (`schema.prisma:1643`, true = Follow) · `quantity` + `quantityOverride` (`:1572`, `:1669`, the pinned value written in lockstep) · `stockBuffer` (`:1522`) · `syncPaused` (`:1651`, "wins over Follow/Pinned") · `offerClosedAt` (`:1593`, SCT.6 per-market offer close) · `SyncChannelPolicy.pushesPaused` (`:17313`, per channel × market × account, `'*'` = channel-wide) · shared eBay lane `SharedListingMembership.followPool` / `stockBuffer` (`:17277`) · audit `SyncControlAudit`. `sourceLocationCodes` is schema-dark (read, never written) |
| M3 | the pool | WAREHOUSE `StockLevel.available` rows, routed by `StockLocation.syncRoutes` (`AMAZON:IT`, `EBAY`, empty = everywhere). GALE today: `IT-MAIN` 403 available across 20 children; `AMAZON-EU-FBA` 128 across 17 children (Amazon-managed, never in the pool) |
| M4 | the write primitives (all shipped, prod-verified in July) | `POST /api/stock/sync-control/actions` `action: FOLLOW \| PIN \| PAUSE \| RESUME \| ZERO_PIN \| EXCLUDE \| INCLUDE \| BUFFER \| CLOSE_OFFER \| REOPEN_OFFER` (`sync-control.routes.ts:577`), `POST /api/listings/follow-master-quantity`, `POST /api/listings/stock-buffer` (`listings-syndication.routes.ts:3247`, `:3285`); `setFollowMasterQuantity` / `setStockBuffer` (`follow-master.service.ts:114`, `:399`; chunked 25/tx, FBA skipped fail-closed, no version bump). RESUME = `syncPaused:false` + `recascadeAfterSyncControlChange` — **that recascade is the mechanism behind the Owner's FBA→FBM story** |
| M5 | **Amazon EU quantity is ONE number per (seller, SKU)** — proved twice 2026-07-26 | `amazon-eu-quantity-guard.ts:24` `AMAZON_EU_SHARED_MARKETS = IT DE FR ES NL BE PL SE IE`; the ACTION layer answers **409 + the true scope** when a FOLLOW/PIN/ZERO_PIN covers only some EU markets and expands on `expandEuAligned: true` (`sync-control.routes.ts:698-780`); the PUSH layer refuses a quantity that fights a sibling market (`outbound-sync.service.ts:993-1057`). **Measured today: 1 SKU of 278 has EU rows with disagreeing Follow/Pinned intent** (the guard makes it unpushable; the Matrix must make it unrepresentable) |
| M6 | FBA quantity is untouchable at six layers | resolver rule 1; `buildAmazonListingPatch` emits merchant qty only `!isFba` (`outbound-sync.service.ts:329`); `isFbaListing` fail-closed (`:356-380`); `guardFbaQtyFlip` at the SP-API client (`amazon-sp-api.client.ts:438`); flat-file `findFbaQtyViolations` → 400; `fba-flip-guard` cron every 10 min. GALE: 16 of 20 children FBA on every Amazon EU market |
| M7 | **Fulfilment is per channel × market in OUR model, region-wide on Amazon's side** | `ChannelListing.fulfillmentMethod` (`:1531`, FCF.1); `PATCH /api/products/:id/fulfillment` (`product-channel-data.routes.ts:367-451`) writes the typed column + the FLAT `platformAttributes.fulfillmentChannel`, **emits nothing to Amazon** (conversion happens in Seller Central), and answers the REQUEST count, not the write count (`:431`, `:465`). The FBA guard reads the NESTED `fulfillment_availability[0].fulfillment_channel_code` — two stores, one fact (report 18 §5.2). `Product` carries the concept twice (`fulfillmentMethod` `:121`, `fulfillmentChannel` `:257`) and the master sheet edits the one nothing reads. Amazon's schema declares `fulfillment_availability` WITHOUT a `marketplace_id` selector and its FBA enum is `AMAZON_EU` (a region). **Measured today: 0 of 278 SKUs differ across EU markets** |
| M8 | price stores | `Product.basePrice` (master, EUR by convention) · `ChannelListing.price` (`:1559`, what every PUSH reads) · `priceOverride` (`:1671`, what the engine's CHANNEL_OVERRIDE layer reads, only when `followMasterPrice=false` `:1636`) · `salePrice` (`:1560`, **no window columns** — the promotion scheduler fakes a window from `lastOverrideAt`) · `pricingRule` FIXED/MATCH_AMAZON/PERCENT_OF_MASTER + `priceAdjustmentPercent`. Currency = `Marketplace.currency`. **Four resolution chains, no shared leaf; `resolvePrice` is in NO publish path** (report 25 §5.4). Today: Amazon 730 rows · 265 follow master · 0 overrides · 0 rules · 0 sale prices; eBay 274 · 274 follow |
| M9 | price write paths | `PATCH /api/products/:id/channel-pricing` writes `price` and clears `followMasterPrice` (`product-channel-data.routes.ts:169`); `POST /api/listings/:channel/:mp/pricing` writes `price` while calling it `priceOverride` (`marketplaces.routes.ts:777`); `POST /pricing/bulk-override` writes `priceOverride` WITHOUT `followMasterPrice=false` so the engine ignores it (report 25 §5.3). The bulk PATCH's channel map has `ebay_price` only (`channel-field-map.ts:27`); the channel sheet serves `price` on the eBay Offer group (`sheet-columns.service.ts:320`, `CHANNEL_WRITABLE` `studio-sheet.service.ts:528`). The Amazon push builds `purchasable_offer` with `op:'replace'` and never emits `sale_price` (report 19) |
| M10 | business pricing | **No Prisma column.** `platformAttributes.businessPricing = {quantity, price}` written by the old cockpit card only; **zero API-side mapping** (`PricingCard.tsx:695-703` says so). Amazon B2B Phase 0 (June) is BLOCKED: every cached PT schema exposes `purchasable_offer.audience` enum `["ALL"]` only, `quantity_discount_plan` absent → a B2B submit errors 90244. `ProductTierPrice` (master tiers) exists and is pushed nowhere (0 rows). eBay volume pricing = a marketplace PROMOTION (buy-2/3/4 tiers), shipped June |
| M11 | status | `ChannelListing.listingStatus` DRAFT · ACTIVE · INACTIVE · ENDED · ERROR (+ Amazon's ingested BUYABLE · DISCOVERABLE — 386 DISCOVERABLE rows today), `isPublished`, `offerActive`, `offerClosedAt`, `lastSyncStatus`, `syncStatus`; suppressions are episodes in `AmazonSuppression`, issues in `ListingIssue`. `Product.status` DRAFT · ACTIVE · INACTIVE. The projection vocabulary on the Variants page: `listed · draft · excluded · not-set-up · needs-value` (`design-system/grid/renderers/projection.ts`) |
| M12 | sync state | `OutboundSyncQueue` per listing: today QUANTITY_UPDATE 2147 SUCCESS · 464 dead · 34 cancelled; PRICE_UPDATE **1727 dead** (nothing on the studio shows this). Dispatch gates re-check `syncPaused` / `pushesPaused` / `offerClosedAt` at send time (`outbound-sync.service.ts:904-916` Amazon; `:1164-1172` eBay — inside the quantity branch only, report 28 §5.2) |
| M13 | **the Variants page is BUILT and measured** | `_studio/variants/{family,channel}/**` (5,144 lines) + `family-projection.service.ts` + DS `ProjectionCell`/`AxisChip`/`MappingChip`; VP.F final pass 2026-09-12 (79 control groups, before/after tables at 1440×900). Master state = family band (AXES chips · Add axis · coverage · Generate combinations · Add variant ▾) + grid PRODUCT · AXES · CHANNEL PROJECTIONS (one column per connected coordinate, `[☑][●] word`). Channel state = MAPPING band + Included · mapped-axis cells · Listing + the 420px mapping dock. **Its rows are the Matrix's rows and its CHANNEL PROJECTIONS group is the Matrix's column axis, one cell wide** |
| M14 | the legacy Matrix tab | `edit/tabs/MatrixTab.tsx` (2,076 lines, PE.2): variant rows × ONE selected market; columns axes · SKU · Base price · `<mp>` price · `<mp>` qty · Fulfilment (FBA\|FBM segmented) · Avail · Physical · Status; bulk modes `Set price · Set qty · Adjust % · Copy market` computed IN THE BROWSER; a 50-deep undo; N HTTP requests per bulk. Plus `ChannelPricingSection` (482), `ChannelInventorySection` (243, read-only). Specification, never source (layout doc §2.10) |
| M15 | aliases | `ProductListingAlias` + `ChannelListing.aliasId`/`aliasKey` shipped 09-01; the channel sheet renders one band per alias; `createAlias` throws `AliasCreationBlockedError` until `migrations-pending/20260901d_pes5_ii_drop_legacy_alias_keys.sql` is applied (PES.5-ii); 0 alias rows; the 22 `EBAY_LISTING_SHELL` shells still exist (adoption dry-run reviewed 09-01: 20/22 clean, `IT-GALE-JACKET` → GALE-JACKET ruled, `WATERPROOF-OVERJACKET-ALT1` left). Quantity is PER ALIAS, never summed (`rows.ts:15` `assertNoQuantitySummation`) |
| M16 | the studio's substrate | `sheet/ProductSheetSurface.tsx` (one renderer, adapters per scope, since the 09-13 consolidation) · `GridSheet` + `NexusGrid` (AG Grid Enterprise 36.1) · `SheetWriter` (the one autosave path, CAS on `version`) · `IdentityBand` · `CascadeCell` vocabulary (🔗 inherited / ✎ pinned / ƒ formula / ⚠ refused) · `SheetToolbar` (CH.1) · the ONE Customise dialog (`PreferencesModal`) + saved views · `check-editor-open.mjs` contract gate. The studio sheet is client-side `treeData` over ONE family, not SSRM |
| M17 | coordinates | Marketplaces active: Amazon IT DE FR ES NL BE PL SE IE TR UK (EU region except UK=GBP), eBay IT DE FR ES UK, Etsy, Shopify, WooCommerce. Listings today: Amazon IT 273 · DE 214 · ES 123 · FR 115; eBay IT 253 · DE 21; Etsy 2; Shopify 7. GALE: Amazon IT/DE/FR/ES (21 rows each), eBay IT (21 ACTIVE) + DE (21 DRAFT), Etsy 2, Shopify 2. No `SyncChannelPolicy` rows |
| M18 | naming collision | `/products/[id]/matrix` (legacy F6 variant matrix) and `GET /api/products/:id/matrix` (legacy Phase 9 payload) already exist. The studio's Matrix is `?tab=matrix` on `/edit/studio` and `/api/products/:id/studio/matrix` — no collision; the legacy pair dies at swap |
| M19 | what is in flight on the paths the Matrix needs | VT.1 (backend, additive in `product-studio.routes.ts`, `sheet-columns.service.ts`, `studio-sheet.service.ts`), VT.2 (`design-system/grid/editors/{sheetColumn,shapeColumn,sheetWriter}.ts` additive, `_studio/sheet/master/{columns,channelColumns}.tsx` one hunk each, `_studio/variants/channel/dock/sections.tsx` NOT taken), LX.6 (sheet adapters). VP.F closed 09-12; VX.3 waits for it |

---

## 2. Verdict on the plan — item by item

**Overall: the approach is right.** The controls exist and are proven; what is missing is the surface that shows
them per variant × coordinate inside the product, beside price and status. Building THAT surface is the Matrix.
Three things I would change, four I would add.

| plan item | verdict | what changes |
|---|---|---|
| **"manage it all [follow · pinned · buffer · pause · resume] on the Matrix page"** | ✅ correct | Nothing is re-implemented. Every cell READS `resolveIntendedQuantity` and every write goes through the July primitives. The Matrix is the resolver's screen inside the product; the Sync Control page stays the account-wide screen. **Change 1:** the Matrix shows WHICH lever holds a listing (policy vs listing pause — policy wins and today nothing in the studio says so) and adds `Push quantity now`, so the pause→resume workaround is never needed again |
| **"manage the prices on the Matrix page"** | ✅ correct | One `Price` cell per coordinate in the market's currency with the sheet's provenance marks: 🔗 follows the base price · ✎ set here · ƒ formula (`= $basePrice * 1.05` replaces PERCENT_OF_MASTER). The cell shows the number the PUSH reads (`ChannelListing.price`) — never the engine's chain, which is in no publish path (M8). **Change 2:** MX.1 first makes ONE price write shape (writes `price` AND `priceOverride`, `followMasterPrice=false`) because today three routes write three different columns (M9). `Sale` (Amazon) ships with a real window (two additive columns) and a push that carries it (D-MX4) |
| **"transfer what we planned on the Variants page — I plan on removing it — is it really of value?"** | ⚠ **don't delete; evolve** | The Variants page is BUILT, measured and verified (M13), and its shape IS the Matrix's shape: rows = variants, one column per coordinate. Deleting it and building a new page rebuilds the family read, the projection PATCH, include/exclude, generate, the axes band — all proven. **Change 3:** the Variants page BECOMES the Matrix: rename the nav item, keep the family band, widen each coordinate's single projection cell into a column GROUP (Listing · Fulfilment · Mode · Qty · Buffer · Sync · Price · Sale). Its one-coordinate state (mapping band + dock) stays as the Matrix narrowed to one coordinate. As a separate page beside a Matrix, Variants has no value; folded in, every part of it is load-bearing |
| **"FBM/FBA toggle for Amazon scopes and different markets"** | ✅ with two conditions | A `Fulfilment` select cell (Amazon FBA · FBM; eBay FBM · MCF). (1) It writes ONLY through a preflighted confirm (`Set fulfilment…`: pool each row moves to, oversell, the FBA guard's verdict, EU region-wide) — the fill handle is disabled on it; a fill has no preflight. (2) The cell shows the GUARD's verdict when it disagrees with the field (today the field can say FBM while the fail-closed guard, reading the other store, says FBA — M7); MX.1 unifies the two stores first. The cell is honest about what it does: it re-points the pool that backs the quantity and what future feeds carry; the offer itself is converted in Seller Central (M7) — the tooltip says so |
| **"Amazon doesn't support different quantity for the same SKU across markets"** | ✅ proved in this codebase (M5) | **Add 1 — the layout makes the contradiction unrepresentable:** the Amazon EU inventory lane (Fulfilment · Mode · Qty · Buffer · Sync) is ONE set of cells per region, labelled with the markets it covers; per-market cells exist only for what is per market (Listing status · Price · Sale). A pin on the region cell is the SCT.5b expansion by construction, no consent bar needed. UK (GBP, outside the shared set) gets its own full group when listed |
| **"include business pricing?"** | ❌ not in wave 1 | It cannot be pushed today: Amazon does not expose the B2B audience for this account (M10), so a column would be a switch wired to nothing. **The contract reserves it**: `business` cells are served `absent` with the reason ("Amazon has not enabled business pricing for this account — checked against the cached product-type schema"), derived from the schema per coordinate, never hardcoded; the day the audience appears the group renders. Offer: re-run the read-only Phase 0 check now (`scripts/_b2b-phase0-*.mjs`) — if Seller Central enabled it since June, MX.1 adds the two cells |
| **"variation theme and axes on the Matrix?"** | ✅ axes on the band · ❌ theme as cells | Axes ARE the row structure — the family band's AXES chips · Add axis · Generate · Add variant stay (built, VP.3). Theme is a per-coordinate PROJECTION, already designed as the `Variation theme` column on the Information sheet (VT, in flight) and the mapping dock on the narrowed Matrix state (VP.4). No theme cells on the all-coordinates state; the coordinate's strip label carries a `Mapping…` route to the dock. Matches the Owner's instinct |
| **"must support multiple aliases"** | ✅ designed; blocked on two Owner words | Each alias is a coordinate GROUP (`eBay · IT ①`, `eBay · IT ②`) with its own Listing · Mode · Qty · Buffer · Sync · Price — quantity per alias, never summed (M15). **Add 2:** alias creation is inert until PES.5-ii (the parked index-drop migration) is applied and the 21-shell adoption runs; both have been waiting since 09-01 for the Owner's own word (D-MX6). With them, GALE shows two eBay·IT groups on day one (`IT-GALE-JACKET` adopts as ②) — the first surface that can prove multi-alias on real data |
| **"built using the shared product sheet?"** | ✅ same substrate · different projection | Same engine (`GridSheet`/`NexusGrid`), same toolbar, identity band, cell vocabulary, editors, `SheetWriter`, Customise + views, gates. The ONE definition per cell lives in `design-system/grid` and is spread by the Matrix AND the Information sheet (where the same field appears — `price`, `variation_theme`), never two builders (`reference_two_column_builders_drift`). But the Matrix is not the Information sheet with another scope: the sheet is variants × attributes for ONE coordinate; the Matrix is variants × (coordinate × offer field) for ALL coordinates. So: `ProductSheetSurface` + a third adapter, or the Variants page's grid widened — MX.3 measures which is the smaller change and says so |
| **"status column? add/manage variants?"** | ✅ both | `Status` on the shared group (`Product.status`) and a `Listing` cell per coordinate — the existing `ProjectionCell` (☑ included · ● state · word) with three added words: `Suppressed` (Amazon episode), `Closed` (offer closed), `Error`. Add/manage variants = the family band's `Add variant ▾` (Add a child · Generate combinations · Attach existing) and the row ⋯ (Unlink · Move · Delete) — built |
| **"propose the layout, get approval, build it all — AAA"** | this document + the canvas | Lanes in §4, decisions in §5, prompts in `docs/mx-prompts.md` (written after approval) |

**Add 3 — every verb runs server-side, preview-first, with a revert.** The old Matrix tab computed `Adjust %` and
`Copy market` in the browser in two copies (M14) and fired N requests per bulk. Every Matrix verb (`Set price` ·
`Adjust prices by %` · `Copy prices from…` · `Pin quantity` · `Set to Follow` · `Set buffer` · `Pause` · `Resume` ·
`Push now` · `Set fulfilment` · `Include on` · `Exclude from`) runs COLLECT → PREFLIGHT (the server returns every
`old → new` and every refusal by cause) → CONFIRM → RUN as ONE `BulkOperation` that is the revert point (wave-4
D14.4, the D15 import pipeline's own store).

**Add 4 — four backend defects are fixed BEFORE the cells that would otherwise lie ship** (M7, M9, report 28 §5.2):
the fulfilment two-store + request-count response; the price three-column ambiguity; the eBay pause gate that
sits inside the quantity branch (a paused eBay listing still receives content pushes — the `Sync` cell must not
say "paused" while that is true); `products.price.edit` gating nothing (the price cells are financial fields —
`writable:false` with the reason for a viewer without the permission, using the field-security layer that
exists).

---

## 3. Design

### 3.1 Principles (each is a rule a lane can be measured against)

1. **One truth per cell.** Quantity = `resolveIntendedQuantity` (nothing else derives a number in the browser —
   five browser copies of the pool arithmetic exist today, M14; the Matrix has zero). Price = the number the push
   reads. Status = the row's `readinessMeta('row')` vocabulary. Fulfilment = the guard's verdict beside the field.
2. **One definition, spread everywhere.** Each cell kind (`listing`, `fulfilment`, `syncMode`, `syncQty`,
   `syncBuffer`, `syncState`, `price`, `salePrice`) is an engine column (`design-system/grid/editors/sheetColumn.ts`
   kinds + renderers/editors) declared ONCE; the Matrix, the Information sheet (where the field also appears) and
   the gate's parity block all read the same definition.
3. **One door for writes.** `PATCH /api/products/:id/studio/matrix` routes by cell kind to the EXISTING
   primitives (M4, price write, fulfilment logic, projection children) — it adds CAS (`expectedVersion` per
   listing, 409 → repaint + refetch like every sheet cell) and nothing else. No new engine.
4. **Unrepresentable contradictions.** Amazon EU inventory cells are per region (§3.5). FBA rows render `—` and
   accept nothing. A paused row says which lever holds it.
5. **Preview before consequence.** Every SELECTION verb and the fulfilment cell run the preflight first; the
   fill handle is disabled on `fulfilment`, `listing`, `syncState`; it works on `price`, `syncQty`, `syncBuffer`
   (those are ordinary writes and the deny-list already routes them through the writer).
6. **Honest absence.** A coordinate with no listing for the family = one `Not listed` column, not eight empty
   cells; a cell the channel has no store for (`Sale` on eBay, `Fulfilment` on Shopify) is `absent` with the
   reason in Customise; `business` is absent with the schema's reason (M10). `count: null` never renders as `0`.
7. **Nothing page-local.** Bands, chips, cells, marks, tones, editors: DS or engine. The census gate
   (`check-control-census.mjs`) and the layout gate (`check-layout-v2.mjs`) are extended to the Matrix surfaces.

### 3.2 One page, two states — the Variants page becomes the Matrix

Nav (THIS PRODUCT): `Information · Matrix · Media · Needs attention · Performance · Activity`. Tab id
`matrix` (`?tab=variants` falls back to it for one release; `contracts.tsx` reads the URL against
`STUDIO_TABS`). `_studio/variants/**` → `_studio/matrix/**` (git mv; the family/channel split stays).

| state | scope bar | band (40px) | grid |
|---|---|---|---|
| **All coordinates** (`scope=master`) | `Shared product` active; the channel chips FILTER the coordinate groups (click Amazon → Amazon groups only; click again → all); market listbox narrows to one market's groups | the FAMILY band as built (AXES chips · `+ Add axis` · coverage · `Generate combinations` · `Add variant ▾`) | PRODUCT · AXES · SHARED · one GROUP per coordinate/alias (§3.3) |
| **One coordinate** (`scope=<CHANNEL>&market=<M>&listing=<alias>`) | as today | the MAPPING band as built (VP.4) | PRODUCT · the coordinate's FULL group: Listing · mapped-axis cells (VP.4) · Fulfilment · Mode · Qty · Buffer · Sync · Price · Sale; the mapping dock on `Edit mapping` |

The `Included` column of the narrowed state folds into the `Listing` cell (the checkbox is part of
`ProjectionCell` already on the all-coordinates state) — one cell definition on both states.

### 3.3 Groups and columns (all-coordinates state; widths in px; row 36; strip 30; header 28)

```
PRODUCT (pinned)        AXES              SHARED                     AMAZON EU · INVENTORY (IT DE FR ES)        AMAZON · IT             AMAZON · DE  …   EBAY · IT ①                                              EBAY · DE   SHOPIFY   ETSY   AMAZON · UK
☐ 43 · identity 380     Colore 140 ·      Base price 100 ·           Fulfilment 96 · Mode 96 · Qty 88 ·          Listing 150 · Price 104 ·                 Listing 150 · Fulfilment 96 · Mode 96 · Qty 88 ·          (same)      (Listing · Mode · Qty · Buffer · Sync · Price · Compare-at)   Not listed 120
                        Taglia 140        Stock 96 · Status 104      Buffer 76 · Sync 96                          Sale 190                                  Buffer 76 · Sync 96 · Price 104
```

- **PRODUCT**: the DS `IdentityBand` exactly as the sheet and the Variants page use it (role chip P/C, 32px
  thumb, SKU mono 11/600, second line = axis values, `CompletenessPill`, row ⋯). Parent row first, then children
  in axis-value order (VP.3 rule).
- **AXES**: the Variants page's editable select columns (140 each); the Inventory/Pricing presets hide them.
- **SHARED** (master stores): `Base price` (`Product.basePrice`, EUR, the master writer), `Stock` (read-only: the
  routed WAREHOUSE pool `available` for this SKU — the number Follow rows derive from; parent = family total;
  tooltip lists the locations; ⚠ `Uncounted` when no routed location holds this SKU), `Status` (`Product.status`
  select).
- **One group per coordinate**, ordered Amazon (EU inventory, then markets in `Marketplace` order), eBay per
  market per alias, Shopify, Etsy, WooCommerce; unconnected/unlisted coordinates last as single `Not listed`
  columns (VP.3's honesty rule; `+ List on <coordinate>…` on the parent row opens the first-listing flow).
- **Strip label** = `AMAZON · IT` + a `Tag` roll-up (`19 listed · 1 draft`); clicking the label narrows the scope
  bar to that coordinate (the same URL as today's channel state). No controls in the strip.
- **Customise** (the ONE `PreferencesModal`) toggles coordinate groups and fields; presets `Everything` (default,
  lands full — the 09-04 rule) · `Inventory` · `Pricing` · `Listings`; saved views on
  `SavedView` surface `product-edit:views:matrix`. The Variants spec's "no views" absence is lifted (D-MX8).

### 3.4 Cells (DS `CascadeCell` vocabulary; every word in Appendix A)

| cell | kind | at rest | editing | write |
|---|---|---|---|---|
| **Listing** | `listing` (`ProjectionCell`) | `☑ ● Listed` · `☑ ○ Draft` · `☐ Excluded` (muted) · `Not set up` (disabled ☐) · `☑ ● Needs a value` · `☑ ⚠ Suppressed` · `☑ ○ Closed` · `☑ ● Error` · `Ended`; trailing mono detail on the parent row (ASIN / ItemID · `1 listing`); tooltip = listingStatus · isPublished · offerActive · last publish · suppression reason | checkbox only (include/exclude) | VP.2 `PATCH …/studio/projection/children` (local record write — no push, proven by VP.2) |
| **Fulfilment** | `fulfilment` (select) | `FBA` / `FBM` (eBay `FBM` / `MCF`) + 🔗 derived / ✎ set; `⚠` + tint when the guard's verdict differs (`guard reads FBA — quantity is not pushed`); `⇄` when Amazon's last merchant report says otherwise | select opens the **`Set fulfilment…` preflight** (one row); fill handle DISABLED | the fulfilment logic behind ONE door (§3.7), both stores written, honest counts |
| **Mode** | `syncMode` (select) | `Follow` 🔗 · `Pinned` ✎ · `—` on FBA (`Amazon-managed`) / `Closed`; ⏸ overlay + tint when paused (`Follow · ⏸ paused (listing)`) | select Follow/Pinned | FOLLOW / PIN primitives; PIN takes the current intended value (July: pin snapshots the base quantity) |
| **Qty** | `syncQty` (number) | Follow: the resolver's number 🔗 muted (`403`; tooltip `Follows the pool · 403 available at IT-MAIN − 0 buffer`); Pinned: `10` ✎; Paused: `⏸ 7` (the number the channel holds; tooltip names the lever and the pool it would push); FBA: `—` (`49 at Amazon` in the tooltip); `Uncounted` warning; `Closed`; ⚠ `oversold` mark when the channel's live number exceeds the pool | number; **typing into a Follow cell PINS it** (D-MX3; the cell shows ✎ at once, reset = `Follow` in Mode or the cell's reset) | PIN at the value |
| **Buffer** | `syncBuffer` (number) | `0` · `3`; `—` on Pinned / FBA | number (Follow rows only) | BUFFER primitive (following rows recompute + push; pinned rows store it) |
| **Sync** | `syncState` (read-only) | `✓ 2 min` · `Queued` · `Sending` · `✗ Failed` (reason in tooltip) · `Dead` · `⏸ policy` / `⏸ listing` · `—` never; QUANTITY and PRICE queues collapsed to the worst state, both in the tooltip | click = jump to Needs attention (Errors & Sync) for that listing | — (`Push quantity now` / `Retry` are verbs) |
| **Price** | `price` (money) | `€105.00` 🔗 (follows base price) · `€99.00` ✎ (set here) · `ƒ €99.75` (formula, evaluated at rest) · `⚠ clamped` when the floor/ceiling bit; market currency; tooltip = source sentence (`Set here` · `Follows the base price €105.00` · `Formula = $basePrice * 0.95` · `Sale €89.00 until 30 Sep`) | number or `=` formula (the sheet's `FormulaCellEditor`) | the ONE price write (§3.7) → PRICE_UPDATE enqueued |
| **Sale** | `salePrice` (compound) | `€89.00 · 12 Sep → 30 Sep` · `—`; Amazon and Shopify (`Compare at`, inverted meaning, labelled so); eBay `absent` (markdowns are promotions — reason in Customise) | popup: price + start + end (the DS date inputs) | the same door; Amazon push carries `sale_price` with its schedule (D-MX4) |
| **Base price / Stock / Status** (SHARED) | the sheet's own master columns | as the Information sheet | as the sheet | `PATCH /api/products/bulk` (exists) |

Row tint rules: a paused listing's Mode · Qty · Buffer · Sync cells share one muted tint; an FBA row's four
inventory cells render `—` with `Amazon-managed` on hover; the parent row's coordinate cells carry the alias
band facts (ASIN/ItemID, `n listed`, `Publish ▾` route) and no controls except `Listing`.

### 3.5 The Amazon EU rule (M5, M7)

One `AMAZON EU · INVENTORY` group per account, labelled with the markets it covers (`IT DE FR ES` — the family's
listed markets ∩ `AMAZON_EU_SHARED_MARKETS`). Its five cells (Fulfilment · Mode · Qty · Buffer · Sync) are ONE
value each; a write sends `expandEuAligned: true` and lands on every EU row of the SKU — the layout IS the
consent. Per-market groups (`AMAZON · IT` …) carry only Listing · Price · Sale. The narrowed state
(`scope=AMAZON&market=DE`) shows the same five region cells with the strip label `INVENTORY · shared with IT FR
ES`. If MX.1's phase-0 reading finds a SKU whose fulfilment genuinely differs per market on Amazon's side (0 of
278 do in our data), `Fulfilment` moves to the per-market groups and its preflight keeps the region notice —
the design does not change shape. UK (GBP, not in the shared set) is a full group of its own when listed.

### 3.6 Reads — one contract, `GET /api/products/:id/studio/matrix?accountId=&locale=`

```
{ version,                                                    // family version (CAS for master cells)
  family: { parentId, parentSku, axes[], coverage },          // = VP.2's family read (reused, not copied)
  pool: { locations: [{ code, available, routes[] }] },        // routed WAREHOUSE rows for the family
  coordinates: [{ key: 'AMAZON:IT', channel, market, region: 'EU'|'UK'|null, alias: { id, label, position } | null,
                  accountId, currency, connected, listed: n, draft: n, vocabulary: { fulfilment: ['FBA','FBM'] | ['FBM','MCF'] | null },
                  absent: [{ cell: 'salePrice', reason }] , sharedInventoryWith: ['DE','FR','ES'] | null }],
  rows: [{ id, sku, role: 'parent'|'variant', axisValues, stock: { available, uncounted: boolean }, basePrice, status,
           cells: { 'AMAZON:IT': { listingId, version, listing: { state, included, externalId, detail },
                                  fulfilment: { method, source: 'derived'|'set', guard: 'FBA'|'FBM', reported: 'AFN'|'MFN'|null },
                                  sync: { kind: 'FOLLOW'|'PINNED'|'PAUSED'|'FBA_EXCLUDED'|'UNCOUNTED'|'CLOSED', via: 'POLICY'|'LISTING'|null,
                                          intended: n|null, held: n|null, buffer: n, oversold: boolean, routedLocations: [] },
                                  queue: { state: 'sent'|'queued'|'sending'|'failed'|'dead'|'paused'|'never', at, reason },
                                  price: { value, currency, source: 'master'|'override'|'formula', formula, clamped },
                                  sale: { value, start, end } | null,
                                  writable: { [cell]: boolean }, writeBlockedReason: { [cell]: string } } } }] }
```
`sync` is `resolveIntendedQuantity`'s output verbatim (M1) — the wire carries the resolver's `kind`, never a
re-derivation. `queue` is the newest `OutboundSyncQueue` row per (listing, syncType) folded to one state.
Region cells are served once under the region key (`AMAZON:EU`) and the per-market keys carry `sharedInventoryWith`.
Bar: GALE (21 rows × 8 coordinates) in ≤ 1.5 s on the local API, measured in MX.1's ledger section.

### 3.7 Writes — one door, `PATCH /api/products/:id/studio/matrix`

```
body  { cells: [{ listingId | coordinateKey+productId, expectedVersion, cell: 'syncMode'|'syncQty'|'syncBuffer'|'fulfilment'|'price'|'salePrice'|'listing', value }] }
reply { results: [{ listingId, cell, outcome: 'applied'|'refused'|'noop', reason?, version }], recascaded: [productId], pushes: [{ listingId, syncType }] }
409   { current: { listingId: version } }  →  repaint + refetch, exactly like every sheet cell
```
Routing by cell kind, delegating to what exists: `syncMode`/`syncQty` → `setFollowMasterQuantity` (FOLLOW/PIN),
`syncBuffer` → `setStockBuffer`, pause/resume verbs → the sync-control PAUSE/RESUME branch (+ recascade),
`fulfilment` → the fulfilment logic moved into a service (`fulfillment-method.service.ts`, NEW) that writes the
typed column AND both `platformAttributes` keys and returns real per-row outcomes; `price`/`salePrice` → ONE
`channel-price-write.service.ts` (NEW) that writes `price` + `priceOverride` + `followMasterPrice=false` (+ the
sale window), records `PriceChangeEvent`, enqueues `PRICE_UPDATE`; `listing` → `PATCH …/projection/children`.
FBA rows: every inventory cell refused with `Amazon-managed` (never silently skipped — the outcome names it).
Region cells: the write is expanded to every EU row of the SKU (M5) and every row's version is checked.
The `SheetWriter` gains ONE routing branch keyed on `column.kind ∈ matrix kinds` → this endpoint (VT.2 adds its
own branch the same way; both additive).

### 3.8 Verbs (registry, declared once; SELECTION = the selected rows × the focused coordinate group or all)

| verb | scope | preflight (server, `commit:false`) | run |
|---|---|---|---|
| `Set price…` · `Adjust prices by %…` · `Copy prices from <market>…` | SELECTION | `old → new` per cell in the market currency; refusals (FBA irrelevant; frozen; no permission); −30 % on ≥ 100 cells → type-to-confirm | one `BulkOperation` = the revert point; PRICE_UPDATE enqueued |
| `Pin quantity…` · `Set to Follow` · `Set buffer…` | SELECTION | per row: `Follow 403 → Pinned 10`; FBA rows listed as skipped; EU rows listed with the region notice | the FOLLOW/PIN/BUFFER primitives (chunked, audited) |
| `Pause sync` · `Resume sync` | SELECTION + coordinate (`Pause all on <coordinate>`) | which lever is already in force (policy → "Resume here changes nothing — the policy holds it", with the link to Sync Control) | PAUSE/RESUME + recascade; the Sync cell repaints from the queue |
| `Push quantity now` | ROW + SELECTION | what would be sent (the resolver's number per row), what is held (paused/FBA/uncounted) | enqueue QUANTITY_UPDATE with a fresh row (the B1 per-cell resync primitive) |
| `Set fulfilment…` | ROW (from the cell) + SELECTION | pool each row moves to; oversell after the move; the guard's verdict; `EU region-wide` | the fulfilment service |
| `Include on <coordinate>` · `Exclude from <coordinate>` | SELECTION | count; live listings named | VP.2's children PATCH |
| `Retry` (from the Sync cell's failure) | ROW | the payload that failed and why | `POST /api/outbound-queue/:id/retry` with an explicit id (never the unscoped bulk route — report 28 §5.4) |

Family verbs (Add variant ▾ · Manage axes · Generate combinations · Attach · Unlink · Move · Delete) are VP.3's,
unchanged. `Publish ▾` stays the header's router (market-features D-F). Every verb appears on the selection bar,
the row ⋯ and the command palette from ONE declaration (`design-system/grid/actions/registry.ts`).

### 3.9 Toolbar, chips, footer

Toolbar (`SheetToolbar`, CH.1 vocabulary): count `21 rows · 1 parent · 20 variants` · Find · chips `Pinned n` ·
`Paused n` · `Oversold n` · `Sync issues n` · `Excluded somewhere n` · `Missing axis values n` · `Duplicate
combinations n` (the DS chip row's overflow handles 1440; each chip filters rows AND tints the matching cells,
like the sheet's chips) · `Customise` · `Export` · `Import` · `⋯` (family verbs · `Reload`). Export = the
Matrix as seen (D15.2 key row: `sku` + `<coordinate>.<cell>` keys); Import = the D15 diff → apply → revert
pipeline over the same keys (Mode/Qty/Buffer accept the Sync Control workbook's words `Follow · Pinned ·
Paused`, EN or IT — `parseFollowCell` exists). Footer: `21 rows · 20 variants` + the sheet's notes slot
(`3 pinned this session · Undo`, `Amazon EU: quantity is shared by 4 markets`).

### 3.10 Aliases

An alias is a coordinate (`EBAY:IT#2`) and gets its own group; the parent row of that group carries the alias's
band facts (ItemID, label, `n listed`, status pill, `Publish ▾`); its children's cells are that alias's
`ChannelListing` rows (`aliasKey`). The `+ Add listing alias` verb lives in the narrowed state's toolbar ⋯ (VP.4)
and on the coordinate strip's roll-up; held with the 409 reason until PES.5-ii (D-MX6). Nothing is summed
across aliases — the `Stock` column is the pool once, on SHARED.

### 3.11 Business pricing — reserved, honest, absent

Contract cells `businessPrice` and `businessTiers` exist in `coordinates[].absent` today with the reason derived
from the coordinate's cached PT schema (`purchasable_offer.audience` enum contains `B2B` → present). Customise
lists them greyed with the sentence. When present: `B2B price` (money, ≤ consumer price or Amazon hides it
silently — the cell warns) and `Tiers` (`3 tiers · 5+ €95 · 10+ €90 · 25+ €85`, popup editor, ≤ 5, ascending,
each strictly cheaper). eBay: the volume-pricing promotion is a link-out (`/pricing/volume-pricing`), not a cell.

### 3.12 What does NOT change

Chrome heights (56/49/40/40/40/30/28/36), 28px controls, the identity column, the family band, the mapping band
and dock, the projection words (+3), the Information sheet, the Sync Control page (account-wide; the Matrix is
per product), the flat-file editors (untouchable — their Follow/Buffer columns stay), FBA quantity, the existing
import, the outbound engine, `resolveIntendedQuantity`, `/products/next`. The legacy Matrix tab,
`ChannelPricingSection`, `ChannelInventorySection` and the cockpit `PricingCard` price block become
specification (deleted at swap, not now).

---

## 4. Order of work — lanes, ownership, gates

| lane | mandate | owns (claim in `docs/pes-claims.md` FIRST) | done when |
|---|---|---|---|
| **MX.0** measure — **DONE in this doc (§1 M1–M19)**; two live readings move to MX.1 phase 0 | (a) Amazon's real fulfilment channel per market for GALE from the merchant listings report (`/admin/amazon/fulfillment-report`), read-only; (b) the B2B Phase 0 schema check re-run (`apps/api/scripts/_b2b-phase0-*.mjs`), read-only; (c) the sale-price PATCH shape that does not wipe `purchasable_offer` — designed against the SP-API doc, proven in dry-run | — | numbers in MX.1's ledger section before any write path is coded |
| **MX.1** backend | `docs/mx1-contracts.md` FIRST (§3.6/§3.7 final shapes); `GET/PATCH /studio/matrix` (`services/pim/matrix.service.ts` NEW, `routes/product-studio.routes.ts` ADDITIVE); `fulfillment-method.service.ts` (NEW: one store rule, both keys written, real outcomes; the route delegates to it); `channel-price-write.service.ts` (NEW: the one price write shape; `bulk-override` and `channel-pricing` delegate); additive columns `ChannelListing.salePriceStart/End`; Amazon push carries `sale_price` + schedule; eBay pause gate hoisted out of the quantity branch (`outbound-sync.service.ts:1164`); `products.price.edit` wired to the matrix write (field security); the verbs endpoint `POST /studio/matrix/verbs` (preview / commit / revert over `BulkOperation`); `Push now` via the B1 resync primitive; `business` absence derived from the schema | the NEW files above; `product-studio.routes.ts` and `product-channel-data.routes.ts` ADDITIVE/delegating; `outbound-sync.service.ts` the two hunks named; one additive migration | contracts final; GALE read carries every §3.4 state that exists in the data with the predicted `kind`; ≤ 1.5 s; every write proven by a delayed read-back with `version` as the discriminator on XAVIA fixtures only |
| **MX.2** GDS | the eight cell kinds in `design-system/grid` (renderers + editors reusing `SelectCellEditor`, the number editor, `FormulaCellEditor`; `ProjectionCell` gains three words; NEW `SyncCells.tsx`, `PriceCell.tsx`, `SaleCellEditor.tsx`); `sheetColumn.ts` kinds + `shapeColumn.ts` branches (additive, after VT.2's hunk); the `SheetWriter` matrix branch; fill-handle rules per kind; registry verb declarations; `check-editor-open.mjs` contract rows for every kind × state; factory mirrors; stories | `design-system/grid/renderers/{projection.ts,ProjectionCell.tsx}` (3 words), NEW files, `editors/{sheetColumn,shapeColumn,sheetWriter}.ts` additive, `actions/registry.ts` additive, `scripts/check-editor-open.mjs`, `apps/factory` mirrors | every cell state in §3.4 rendered from fixtures in the grid lab (`/design/grid-lab`) and asserted by the gate; parity block green |
| **MX.3** surface | `git mv _studio/variants → _studio/matrix`; nav rename + `matrix` tab id with the `variants` fallback; the all-coordinates state = the family grid with coordinate GROUPS (§3.3) reading `/studio/matrix`; scope-bar filter semantics; the narrowed state = VP.4 + the group's cells, `Included` folded into `Listing`; Customise + presets + saved views; chips; footer notes; selection bar wiring; the EU region group | `_studio/matrix/**`, `_studio/{StudioTabHost,StudioSubheader,navigation,scopes,types,navigationHref,SaveIndicator}.tsx/.ts` (the rename hunks), `sheet/views.ts` (the `matrix` surface) | both states on GALE with fixtures, then live on MX.1; census + layout gates extended and green at 1280/1440/1728 |
| **MX.4** verbs | the selection bar verbs (§3.8) with the preview dialog (DS `Modal` + `SummaryTable`: old → new, refusals, notices), type-to-confirm thresholds, the revert toast; `Set fulfilment…` preflight; `Pause/Resume/Push now`; `Retry` from the Sync cell; Import/Export over the Matrix keys | `_studio/matrix/verbs/**` (NEW), `_studio/import/**` (the Matrix key family, additive) | every verb exercised on the XAVIA fixture through the UI with a captured request + delayed read-back + revert proven |
| **MX.F** final pass | before/after tables at 1440×900 on GALE (all-coordinates, Amazon narrowed, eBay narrowed, dock open, verb preview open), the functionality matrix (every cell kind × every state × every coordinate kind), all gates on one clean run, zero console errors, the multi-alias reading if D-MX6 landed | everything above | the ledger holds the numbers; nothing committed |

**Sequencing (M19):** MX.1 and MX.2 start now on NEW files. MX.2's hunks in `sheetColumn/shapeColumn/sheetWriter`
and MX.3's rename wait for VT.2's report (its dock-adoption hunk in `_studio/variants/channel/dock/sections.tsx`).
MX.3 starts when `docs/mx1-contracts.md` exists (typed fixtures until the routes answer). MX.4 after MX.3's
all-coordinates state is on screen. VX.3 (blocked on VP.F) re-targets `_studio/matrix/**`. LX's owned paths are
off-limits. PES.5-ii + the shell adoption (D-MX6) before MX.F.

**Fixtures:** GALE-JACKET `cmokmy3a40078pm0p1fvnu523` (Amazon IT/DE/FR/ES · eBay IT/DE · Shopify · Etsy; 16 FBA
+ 4 FBM children on Amazon; IT pinned 16 / DE following 21 — the disagreeing-intent case is real data); writes
only on `VX-TEST-3AX` / disposable DRAFT rows under XAVIA; GALE's eBay·IT item 257584954808 and ASIN B0F7J163XJ
are LIVE — read-only on channel coordinates. **Name the database before any write** (`:8091` → local Docker
`nexus_development`, GALE version 59 today; Neon prod 51).

**Gates (every lane, one clean run, exit codes read bare):** web tsc · api tsc · vitest for touched modules ·
`check-ag-grid-import-boundary` · `check-editor-open` (+ `--strict` parity) · `check-control-census` (signed in) ·
`check-layout-v2` · `check-raw-primitives-ratchet` · `check-dark-alias-scope` · the factory mirror ratchet ·
`sync-control-scenarios.vitest.test.ts` untouched and green (the Owner's permanent battery).

---

## 5. Decisions only the Owner can make — defaults a lane proceeds on

| # | decision | default |
|---|---|---|
| **D-MX1** | The Matrix REPLACES the Variants page in its nav slot (rename + widen), keeping the family band and the narrowed mapping state; nothing is deleted and rebuilt | **Yes** |
| **D-MX2** | Amazon EU inventory cells (Fulfilment · Mode · Qty · Buffer · Sync) are ONE set per region; per-market cells only for Listing · Price · Sale | **Yes** (Fulfilment placement confirmed by MX.1 phase-0 reading (a)) |
| **D-MX3** | Typing a number into a Follow `Qty` cell pins it (the sheet's cascade semantics: editing an inherited cell pins; one click resets). Alternative: refuse with `Set Pinned first` (the July flat-file rule) | **Typing pins** |
| **D-MX4** | Sale price ships WRITABLE: two additive window columns + the Amazon push carries `sale_price` with its schedule, proven in dry-run first. Alternative: read-only with the reason until later | **Writable** |
| **D-MX5** | Business pricing: absent-with-reason until the coordinate's schema exposes the B2B audience; re-run the read-only Phase 0 check now | **Defer; run the check** |
| **D-MX6** | Apply PES.5-ii (`migrations-pending/20260901d_pes5_ii_drop_legacy_alias_keys.sql`) and run the 21-shell adoption backfill (rulings #18/#23 encoded in `apps/api/scripts/pes5-adopt-shells.mts`) so the Matrix can show real alias groups. **Both are PRODUCTION writes — they run only on the Owner's own word** | **Yes, before MX.F** |
| **D-MX7** | Axes on the band; theme via the Information sheet's `Variation theme` column (VT) and the narrowed state's mapping dock; no theme cells on the all-coordinates state | **Yes** |
| **D-MX8** | Customise + presets (`Everything` · `Inventory` · `Pricing` · `Listings`) + saved views on the Matrix (lifting the Variants spec's "no views" rule) | **Yes** |
| **D-MX9** | Every SELECTION verb: server preview → confirm → one `BulkOperation` with revert; browser arithmetic forbidden | **Yes** |
| **D-MX10** | The four backend fixes in Add 4 ship in MX.1 before the cells that depend on them | **Yes** |
| **D-MX11** | `Push quantity now` and `Retry` verbs exist (the pause→resume workaround retires); the Sync cell names the lever | **Yes** |
| **D-MX12** | Column order: Amazon (EU inventory, markets), eBay (per market, per alias), Shopify, Etsy, WooCommerce, then `Not listed` singles | **Yes** |

---

## Appendix A — copy table (verbatim; one source for every lane)

Nav: `Matrix`. Strip: `PRODUCT` · `AXES` · `SHARED` · `AMAZON EU · INVENTORY` · `AMAZON · IT` · `EBAY · IT ①` ·
`SHOPIFY` · `ETSY` · `Not listed` · `INVENTORY · shared with <markets>`. Headers: `Base price` · `Stock` ·
`Status` · `Listing` · `Fulfilment` · `Mode` · `Qty` · `Buffer` · `Sync` · `Price` · `Sale` · `Compare at` ·
`B2B price` · `Tiers`. Listing words: `Listed` · `Draft` · `Excluded` · `Not set up` · `Needs a value` ·
`Suppressed` · `Closed` · `Error` · `Ended` · `<n> listing(s)`. Mode: `Follow` · `Pinned` · `—`. Qty: `<n>` ·
`⏸ <n>` · `—` · `Uncounted` · `Closed`. Sync: `Sent <ago>` · `Queued` · `Sending` · `Failed` · `Dead` ·
`Paused · policy` · `Paused · listing` · `Never`. Tooltips: `Follows the pool · <n> available at <locations> −
<buffer> buffer` · `Pinned at <n>` · `Paused by <lever> — would push <n> · Resume to push` · `Amazon-managed ·
<n> at Amazon` · `No routed location holds this SKU — nothing is pushed` · `Offer closed on <date> — reopen in
Sync Control` · `Guard reads FBA — the quantity is not pushed` · `Amazon reports <AFN|MFN> — differs from Nexus`
· `Follows the base price <price>` · `Set here` · `Formula <expr>` · `Clamped to <floor|ceiling>` · `Shared by
<markets> — one quantity per SKU on Amazon EU`. Chips: `Pinned` · `Paused` · `Oversold` · `Sync issues` ·
`Excluded somewhere` · `Missing axis values` · `Duplicate combinations`. Verbs: `Set price…` · `Adjust prices by
%…` · `Copy prices from…` · `Pin quantity…` · `Set to Follow` · `Set buffer…` · `Pause sync` · `Resume sync` ·
`Push quantity now` · `Set fulfilment…` · `Include on…` · `Exclude from…` · `Retry` · `Pause all on <coordinate>`
· `List on <coordinate>…` · `Add listing alias`. Preview dialog: `<n> cells change · <m> refused · <k> skipped
(Amazon-managed)` · `Amazon EU: this covers <markets>` · `Type <word> to confirm` · `Apply` · `Revert`. Absent
reasons: `eBay sale prices are promotions — Volume pricing` · `Amazon has not enabled business pricing for this
account (checked against the <PT> schema on <market>)` · `Shopify has no fulfilment method`. Footer: `<n> pinned
this session · Undo` · `Amazon EU: quantity is shared by <n> markets`.

## Appendix B — files MX must not edit

LX's owned paths; VT.1/VT.2's owned paths until they report (then additive only, claimed); the flat-file editors
and `services/amazon/flat-file*`, `flat-file/registry/*`; the FBA guards (`isFbaListing`, `guardFbaQtyFlip`,
`buildAmazonListingPatch`'s `!isFba`); `sync-control-core.ts` (the resolver is consumed, never edited);
`sync-control-scenarios.vitest.test.ts`; the existing import; `/products/next/**`; `fulfillment/stock/**`.

## Appendix C — side findings while measuring (reported, not MX's to fix unless named in §4)

- `PRICE_UPDATE`: 1,727 dead-lettered rows on the local copy, nothing in the studio surfaces them (M12).
- 386 Amazon rows carry `listingStatus = DISCOVERABLE` — a status the projection vocabulary has no word for
  (it renders as `Draft` today on the Variants page); the `Listing` cell maps it to `Listed` + a `not buyable`
  detail (Amazon's own meaning) — MX.2 names it in `projection.ts`.
- One SKU's Amazon EU rows disagree on Follow/Pinned intent (M5) — the push guard holds it; the Matrix's region
  cell will show the resolver's verdict and the first operator write realigns it.
- `sourceLocationCodes` is schema-dark (M2) — the `Stock` tooltip lists routed locations from `syncRoutes` only.
- The eBay pause gate sits inside the quantity branch (report 28 §5.2) — fixed in MX.1 (Add 4).
