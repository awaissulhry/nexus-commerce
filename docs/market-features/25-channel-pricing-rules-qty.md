# 25 — Channel pricing rules + listed quantity

## 1. What it is (operator terms)

A pricing operator decides, per **channel × market × SKU**, what the marketplace charges and how many
units it advertises. Three things are in scope: (a) the *rule* that decides the price —
`FIXED` (use what I typed) / `PERCENT_OF_MASTER` (master ± n%) / `MATCH_AMAZON` (sit under the
competition); (b) the *values* — a per-market price override, a sale price, a listed quantity; (c) the
*bulk tools* used when a family has 20 children × 5 markets: set a price, set a qty, adjust the
selection by ±%, copy one market's prices onto another. This is a daily job for whoever runs margins
(a €0.50 error × 100 SKUs × 5 markets is the whole week's profit), and an hourly job during
promotions. Quantity is the same operator's job but a different risk: too high oversells, and on
Amazon EU the number is not per-market at all.

## 2. Old UI — inventory

Three surfaces, three write paths, no shared state.

**(a) `PricingPanel` — the rule editor.** `tabs/ChannelListingTab.tsx:571-737`, rendered at `:485`.
A collapsed `Card` whose header shows `€ 99.00 (PERCENT_OF_MASTER)` (`:626-651`). Open reveals a DS
`Listbox` with the three rules (`:665-679`), then *conditionally*: a `Price` number input for
FIXED/MATCH_AMAZON (`:681-700`), an `Adjustment %` input for PERCENT_OF_MASTER (`:702-717`). Save →
`POST /api/products/:id/listings/:channel/:marketplace/pricing` (`:609`), body assembled at
`:598-607` — `pricingRule` always, `priceOverride` only for FIXED/MATCH_AMAZON, `priceAdjustmentPercent`
only for PERCENT_OF_MASTER. Local `useState` only; no draft bus, no invalidation emit. Round-trips
to the server on Save; nothing is browser-local.

**(b) `ChannelPricingSection` — the market grid + bulk modes.** `tabs/ChannelPricingSection.tsx:146`.
Fetches `GET /api/products/:id/channel-pricing?channel=` (`:158-170`), re-fetches on the
`channel-pricing.updated` invalidation channel (`:176`). Inline `PriceCell` (`:78-137`) is a
hand-rolled button→`<input type=number>` with blur-commits; saves one cell via
`PATCH /api/products/:id/channel-pricing` (`:172-183`) and re-fetches the whole payload after every
keystroke-commit. Bulk toolbar (`:298-321`) offers three modes — `€ Set price`, `Adjust %`,
`Copy market` — whose panel is at `:324-355` and whose maths is **client-side** at `:190-252`:
`pct` computes `Math.round(price * (1 + pct/100) * 100)/100` per row in the browser (`:212-221`) and
`copy` reads the source market's price out of the already-fetched payload (`:223-232`). No preview,
no confirm, no per-row refusal list: the browser computes N new prices and PATCHes them.

**(c) `MatrixTab` — the variant × market matrix.** `tabs/MatrixTab.tsx`, 2,076 lines. Inline channel
price/qty via `patchChannel` (`:491-540`) → the same `PATCH /channel-pricing` (`:521`), with an
optimistic write, an 800 ms flash, a 50-deep undo stack (`:529-534`) and *revert-by-refetch* on
failure (`:538`). Master base price/stock is a different endpoint, `PATCH /api/products/:childId`
(`:461-488`). Four bulk modes — `price`, `qty`, `pct`, `copy` — in a toolbar row (`:1180-1190`) and
mirrored in a selection bar (`:1244-1254`); `applyBulk` (`:975-1014`) again computes the arithmetic
in the browser (`:989-1001`). Non-parent products fall through to embedding (b) and
`ChannelInventorySection` (`:1074-1075`) — the only callers of those two files.

**(d) `ChannelInventorySection`** — `tabs/ChannelInventorySection.tsx:76`, `GET
/api/products/:id/channel-inventory` (`:89`). **Read-only**: listed qty is printed (`:194-196`,
`:221-223`) beside physical stock and buffer; there is no editor here at all. Listens on the same
`channel-pricing.updated` channel (`:102`) — a pricing event driving an inventory re-read.

**Nothing here is dead** — every file has a live importer (verified by grep). What *is* dead is the
rule's effect; see §5.

## 3. Backend that exists

**Routes.**
- `POST /api/products/:id/listings/:channel/:marketplace/pricing` —
  `apps/api/src/routes/marketplaces.routes.ts:748-799`. Upserts a `ChannelListing`, mapping
  `priceOverride → data.price` (`:777`), `pricingRule`, `priceAdjustmentPercent`, `followMasterPrice`.
- `GET`/`PATCH /api/products/:id/channel-pricing` —
  `apps/api/src/routes/product-channel-data.routes.ts:46-127` / `:138-210`. The PATCH upserts by the
  full compound unique (`:174-185`, incl. `channelConnectionId` + `aliasKey: ''`), clears
  `followMasterPrice`/`followMasterQuantity` on a value write (`:169`, `:171`), and mirrors into the
  legacy `VariantChannelListing` (`:191-194`).
- `GET /api/products/:id/channel-inventory` — same file, `:219+`; `PATCH
  /api/products/:id/channel-follows` — `:713-754` (MS.7: the only way to hand a field *back* to the
  master; `FOLLOWABLE_FIELDS` at `services/pim/channel-follows.service.ts:25` includes `price` and
  `quantity`, columns mapped at `:34-38`).
- `GET /api/pricing/explain?sku&channel&marketplace&fulfillmentMethod` —
  `routes/pricing.routes.ts:139-162`. Returns the engine's **whole resolution chain**: price,
  currency, `source`, `breakdown`, `constraints{floor,ceiling,isClamped,clampedFrom}`, `warnings`,
  `reasoning[]`. This already exists and nothing in the studio calls it.
- `POST /api/pricing/bulk-override` — `routes/pricing.routes.ts:1186-1327`. Modes
  `SET_FIXED | SET_PERCENT_DISCOUNT | CLEAR` on `priceOverride`, with a `ChannelListingOverride`
  audit row and a `PriceChangeEvent` timeline row in one transaction (`:1276-1311`), then a snapshot
  refresh.
- `POST /api/listings/:id/bulk-action` with `set-pricing-rule` —
  `routes/listings-syndication.routes.ts:3310`, `:3342-3344`, `:3436-3441`; validated rule writes at
  `:1205-1239`.

**Services (four independent price resolvers — see §5).**
- `services/pricing-engine.service.ts:142` `resolvePrice()` — the 7-layer chain
  (`SCHEDULED_SALE → OFFER_OVERRIDE → CHANNEL_OVERRIDE → CHANNEL_RULE → PRICING_RULE →
  MASTER_INHERIT → FALLBACK`, doc at `:8-17`), then a floor/ceiling clamp (`:300-308`).
  `CHANNEL_OVERRIDE` at `:353-367`, `CHANNEL_RULE` at `:369-399`.
- `services/repricer.service.ts:38-89` `calculateTargetPrice()` — the *other* rule evaluator.
- `services/pim/attribute-resolver.ts:132-138` — the SSOT table: `price` resolves
  `followMasterPrice ? masterPrice : (priceOverride ?? price)`; same for `quantity`. So `$price` and
  `$basePrice` are both real keys in the resolver's flat map (`SYNTHESIS_MAP:156`).
- `services/available-to-publish.service.ts` (FCF.2) — the honest publishable-qty ceiling
  (pool − pendingReserved − `stockBuffer`, FBA vs FBM pools kept physically separate);
  `services/inventory-oversell-watchdog.service.ts` — the `max(commitment) − pool` alarm.

**Prisma** (`packages/database/prisma/schema.prisma`): `enum PricingRuleType` at `:77-81`;
`model ChannelListing` at `:1427` — `price` `:1477`, `salePrice` `:1478`, `pricingRule` `:1481`,
`priceAdjustmentPercent` `:1482`, `quantity` `:1486`, `stockBuffer` `:1436`, `followMasterPrice`
`:1556`, `followMasterQuantity` `:1557`, `priceOverride` `:1582`, `quantityOverride` `:1583`,
`lowestCompetitorPrice` `:1610`, `version` (CAS) `:1646`. Plus `PricingRule` /
`PricingRuleVariation`, `RepricingRule`, `PricingSnapshot`, `ChannelListingOverride`,
`PriceChangeEvent`, `Offer`.

**Channel calls + gates.** Amazon: `outbound-sync.service.ts:304-305` builds
`purchasable_offer.our_price.schedule[].value_with_tax`; `amazon-cockpit-publish.routes.ts:160-182`
builds the flat-file row. eBay: `outbound-sync.service.ts:1473-1496` PUTs the offer's
`pricingSummary`; `ebay-variation-push.service.ts:1773-1787` refuses a push with no market price.
Publish mode is server-stated (`getAmazonPublishMode` / `getEbayPublishMode`); the eBay dry-run
branch is `outbound-sync.service.ts:1259`.

**Jobs/crons.** `workers/bullmq-sync.worker.ts:217-285` recomputes and **writes**
`ChannelListing.price` before every sync when `followMasterPrice` is true (`:242-267`);
`jobs/repricing-evaluator.job.ts`; `services/pricing-snapshot.service.ts:125`;
`services/promotion-scheduler.service.ts:90`.

**Permissions** (`lib/auth/permissions-manifest.ts`): both pricing endpoints fall to
`RW(productsView, productsEdit, pfx('/api/products'))` at `:412`. `/api/pricing*` is
`RW(pricingView, pricingEdit)` at `:266`.

## 4. Studio today

- **Master scope** has `basePrice` and `totalStock` as ordinary cells in the Essentials view
  (`_studio/sheet/views.ts:169`, reason at `:151`, `:192`), writing through the one SheetWriter
  (`PATCH /api/products/bulk`, `Product.version` CAS). Parity row **6.2 ✅**
  (`docs/pes-parity-audit.md:363`).
- **Channel scope has no price and no quantity column.** `_studio/sheet/channel/ChannelSheet.tsx:916-925`
  refuses to *synthesise* a qty column on purpose (PES.5 §3.2, quantity is per alias and never
  summed) and expects qty to arrive "as the channel's own qty COLUMN in `data.columns`". It does not:
  - `services/pim/studio-sheet.service.ts:462-473` `CHANNEL_WRITABLE` maps only
    `title / description / variationTheme / bulletPoints`;
  - `services/pim/channel-field-map.ts:22-36` `CHANNEL_FIELD_MAP` has the same six prefixed names
    and **no `price` / `quantity` entry**;
  - so a price column would route to `overrideData` (`studio-sheet.service.ts:525`) or be refused,
    and `formulaWritable` (`:1482-1483`, ruling #756/#775) would follow whatever that routing said.
  `SheetListing` *does* carry `price` and `quantity` on the wire
  (`_studio/sheet/channel/types.ts:349-350`) — read-only facts for the alias band.
- **Drawer** already has read-only `Price` and `Quantity (this channel)` facts —
  `_studio/drawer/panes/ListingsPane.tsx:136-144`, with the correct "never summed" comment at `:141`.
- **Verbs today**: `offer-toggle`, `broadcast-to-listings`, `open-record`
  (`_studio/sheet/channel/channelActions.ts:162,308,380`). No pricing verb.
- **Formulas** are built: `CellFormula` (`schema.prisma:17454`), `services/pim/mapping/cell-formula.service.ts`,
  `design-system/grid/editors/FormulaCellEditor` + `formulaEditing.ts:237-262`.
- **Parity audit**: row **3.8 🕳** (`docs/pes-parity-audit.md:126`) — "pricing RULES … are not in the
  sheet. Price is a plain cell; the rule engine behind it is unreachable", and the row cites hub
  ruling **#88** correcting the two-endpoint conflation (ledger text at `docs/pes-claims.md:21002-21004`).
  Row **6.3 ⛔ N/A (PES.3)** (`:364`). Row **6.7 🔁 partial + 🗳** (`:368`) — "±% adjust and copy
  market→market have no equivalent and are not arithmetic the sheet can express". Row **6.22 ⛔**
  (`:383`).
- **Binding rulings**: Owner **A.3a, 2026-09-05** (`docs/2026-09-04-channel-attribute-model-design.md:160-168`)
  — *no exclusions*: `purchasable_offer` and `list_price` become columns, and "the column reads and
  writes **the same store that surface uses**" (Pricing). **D16.1–D16.8 + §1.6**
  (`docs/2026-09-02-wave4-design.md:60-190`) — one formula language, `=` prefix, value at rest with a
  `ƒ` mark, server-side evaluation, `CellFormula` store. **§1.4** (`:150-156`) — cross-entity
  references are explicitly *not in v1*, and "+5% on every child" is routed to the bulk arithmetic
  verb. **D14.4** (`:549-556`) — bulk verbs run `commit=false` first with before→after pairs and a
  revert. **Owner queue item 8** (`docs/pes-claims.md:12383`) — the bulk arithmetic verb is still an
  open yes/no. Ruling **#13** — AI dark. Registry order COLLECT→PREFLIGHT→CONFIRM→RUN, confirm level
  from `ActionImpact` (`design-system/grid/actions/registry.ts:84-127`, rulings #110/#113/#114/#118).

## 5. Defects and slowness

1. **`MATCH_AMAZON` means two different things, and the live path is a silent no-op.** CODE-READ.
   `pricing-engine.service.ts:385-395` implements it as `lowestCompetitorPrice − 0.01`.
   `repricer.service.ts:59-66` implements it as `input.amazonPrice`, falling back to master price when
   absent — and its only caller, `bullmq-sync.worker.ts:243-249`, **never passes `amazonPrice`**. So on
   the path that actually writes `ChannelListing.price` before a sync, `MATCH_AMAZON` is
   indistinguishable from `FIXED`, and the operator gets a `reason` string saying so in a log nobody
   reads.
2. **The rule panel writes the wrong column.** CODE-READ. `marketplaces.routes.ts:777` maps
   `priceOverride → data.price`; the engine's `CHANNEL_OVERRIDE` layer requires
   `followMasterPrice === false && priceOverride != null` (`pricing-engine.service.ts:353-358`), and the
   panel never sends `followMasterPrice`. The panel's own comment at `ChannelListingTab.tsx:567-570`
   asserts "All three map directly to ChannelListing columns" — a comment claiming a property the code
   lacks. The display survives only because `currentDisplay` (`:626-630`) falls back to `listing.price`.
3. **`/api/pricing/bulk-override` writes an override the engine then ignores.** CODE-READ.
   `pricing.routes.ts:1276-1284` sets `priceOverride` and `lastOverrideAt` but **not**
   `followMasterPrice = false`; default is `true` (`schema.prisma:1556`). The immediately following
   `refreshSnapshotsForSkus` (`:1318`) re-runs `resolvePrice`, which skips layer 3 — so the audit row,
   the timeline row and `updated: N` all report a change the resolved price does not reflect.
4. **Four resolution chains, no shared leaf.** CODE-READ. (i) `resolvePrice` 7 layers; (ii)
   `calculateTargetPrice` 3 rules + margin guard; (iii) `amazon-cockpit-publish.routes.ts:160`
   `priceOverride ?? price ?? basePrice` — rule and adjustment ignored entirely, qty at `:185` is
   `quantityOverride ?? quantity` with no buffer and no follow check; (iv) `payload.price` from
   whatever producer built the `OutboundSyncQueue` row (`outbound-sync.service.ts:304`, `:1473`), plus
   the eBay flat-file's own `<mp>_price` column (`ebay-variation-push.service.ts:1773`). **`resolvePrice`
   is not in any publish path** — its consumers are `/api/pricing/*`, snapshots and the promotion
   scheduler only (grep: 4 call sites).
5. **`SET_PERCENT_DISCOUNT` cannot raise a price.** CODE-READ. `pricing.routes.ts:1202-1207` refuses
   anything outside 0–99.99, so the old UI's `±%` (which happily takes `+10`) has no server equivalent —
   the arithmetic lives in the browser (`ChannelPricingSection.tsx:212-221`, `MatrixTab.tsx:989-1001`)
   in **two copies that agree by coincidence**.
6. **N+1 inside a loop, with a transaction each.** CODE-READ. `pricing.routes.ts:1243-1311`: one
   `findFirst` per snapshot (`:1248`) plus one 3-statement `$transaction` per row.
7. **Refetch-per-keystroke.** CODE-READ. `ChannelPricingSection.tsx:181` re-fetches the whole
   variant × market payload after every single-cell commit; `MatrixTab.tsx:538` reverts a failed write
   by refetching everything.
8. **`priceOverride`/`quantityOverride` vs `price`/`quantity` is genuinely ambiguous.** CODE-READ.
   Two column pairs, one resolver (`attribute-resolver.ts:135-136`) that reads
   `priceOverride ?? price` only when the follow flag is false, one route that writes `price`
   (`product-channel-data.routes.ts:169`), one that writes `price` while calling it `priceOverride`
   (`marketplaces.routes.ts:777`), and one that writes `priceOverride` (`pricing.routes.ts:1280`).
9. **`resolvePrice` is alias-blind.** CODE-READ. `pricing-engine.service.ts:238-251` pins
   `aliasKey: ''`, so a second alias on one coordinate resolves the primary's chain. Same class as
   ruling #322's analytics finding.
10. **`products.price.edit` gates nothing.** CODE-READ. `permissions-manifest.ts:382` matches
    `startsWith('/api/products') && includes('/price')`; neither `/channel-pricing` nor
    `/listings/.../pricing` contains the substring `/price`, and grep finds no route that does. A
    financial-field permission that cannot fire.
11. **A pricing event drives an inventory refetch.** CODE-READ.
    `ChannelInventorySection.tsx:102` subscribes to `channel-pricing.updated`.
12. **No tests** on either pricing route or on `calculateTargetPrice`'s MATCH_AMAZON branch
    (grep: no `*.test.ts` beside `repricer.service.ts`, none for `product-channel-data.routes.ts`).

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H1 — price, sale price and listed qty as real CELLS on the channel scope**, per market,
one cell per alias × row, written through the one SheetWriter. This is forced, not chosen: Owner
ruling A.3a already says `purchasable_offer` / `list_price` / `fulfillment_availability` become
columns that "read and write the same store that surface uses", and `ChannelSheet.tsx:916-925` is
already written to expect qty to arrive as a contract column. Anything else re-creates the panel the
rebuild is retiring.

**H1 + formula for the rules — partly yes, and the split matters.**
- `FIXED` is not a rule at all; it is a **literal in the cell** (the sheet's existing `pinned` state).
  Drop the enum member.
- `PERCENT_OF_MASTER` **collapses cleanly into the formula cell**: `= $basePrice * 1.05` on the channel
  price cell, rendered as the evaluated value with the `ƒ` mark (D16.3), stored in `CellFormula` with
  the value materialised where values live (§1.6(A)/(E)). `$basePrice` is already a real key in the
  resolver's flat map (`attribute-resolver.ts:156`) and `expr.ts` already has `*`, `round`, `margin`,
  `markup`, `discount`, `vat`. Nothing new is invented; `priceAdjustmentPercent` becomes derived data
  and stops being a second store.
- `MATCH_AMAZON` **does not collapse into a formula, and the cross-channel reference the brief
  proposes is the wrong shape.** Read at `pricing-engine.service.ts:385-395`, MATCH_AMAZON means
  "sit €0.01 under `lowestCompetitorPrice`" — a *channel observation* refreshed by a job
  (`competitorFetchedAt`, `schema.prisma:1611`), not another coordinate's own price. So
  `=amazon.IT.price` would be a faithful implementation of a misreading. And a formula is evaluated
  **on write** (D16.4) while a competitor price changes hourly — a materialised formula would go stale
  by construction. Recommendation: MATCH_AMAZON stays a **repricing strategy**, assigned per listing
  as an H1 **select cell** ("Pricing strategy": `Manual · Match competitor · Cost-plus · <named rule>`)
  whose maths and cadence belong to the repricer at H11, with the resolved outcome shown in the H2
  column and the H7 pane. If the Owner wants it inside the cell language instead, the honest form is a
  **nullary function evaluated at the cell's own coordinate** — `= competitor() - 0.01` — plus a
  re-evaluation trigger on the competitor-refresh job; that is one function and one hook, not a
  reference syntax (§9, Q1).

**Mirror H4 — two SELECTION verbs, the bulk tools done properly.** `Adjust selected prices by %…`
and `Copy prices from market…` (plus `Set price…` / `Set listed qty…`) as `SELECTION`-scoped
`GridAction`s in `channelActions.ts`, following COLLECT → PREFLIGHT → CONFIRM → RUN
(`registry.ts:203-208`). The preflight is the whole point and it is what both old copies lack: it
returns `ActionImpact.findings` as one row per cell with `old → new`, the refusals with reasons
(no listing on the coordinate, price would fall below the margin floor, FBA row for qty, market has
no source price to copy), and `payload` carrying the exact computed set so `run` applies the snapshot
the operator approved (`registry.ts:107-121`). Confirm level comes from the preflight: a 6-cell
+2% is a plain confirm, a 400-cell −30% is type-to-confirm. This is D14.4 verbatim, and it settles
parity row 6.7's 🗳 by making the arithmetic **server-side and previewed** rather than
browser-side and silent.

**Mirror H7 — a "Pricing" section in the drawer's Listings pane** showing the resolved chain
verbatim from `GET /api/pricing/explain`: `source` → the rule/formula that fired → the override →
floor/ceiling clamp (`isClamped`, `clampedFrom`) → the price the next publish will send, with
`reasoning[]` rendered as the steps and `warnings[]` as a DS `Banner`. `ListingsPane.tsx:136-144`
already has the slot; today it prints `listing.price`, which is one layer of seven.

**Mirror H2 — a read-only `Price source` column** (`Sale · Offer · Override · Rule · Master ·
Fallback`) with a `⚠ clamped` mark, filterable via a view chip. A price without its source cannot be
audited, and the sheet is where 100 rows are audited at once.

**Mirror H9 — Errors & Sync** collects the queue-shaped facts: rows clamped to a floor, rows with no
master price, FX-stale rows (`/api/pricing/alerts` already computes all four), and oversell risk.

**Mirror H11 — the strategy library stays at `/pricing`**: `PricingRule` / `RepricingRule` CRUD,
floors, MAP, min-margin, competitor cadence. The studio holds only the per-listing *assignment*.

**Not H12 anywhere**: nothing here is superseded, and `pricingRule` is live data on 977 listings.

### 6.2 What the sheet shows at rest

| scope | at rest |
|---|---|
| **master** | `basePrice` cell (today's ✅), `totalStock` cell. No channel price. A `ƒ` mark if a master formula is set. |
| **channel × market** | `Price` cell — the resolved value, right-aligned, market currency; `ƒ` when a cell formula drives it, `✎` when pinned, `🔗` when inherited from master (`followMasterPrice`). `Sale price` cell. `Listed qty` cell — value plus a muted `/ 12 available` when the FCF.2 ceiling is known, and `⚠` when the typed value exceeds it. `Price source` (H2, read-only). `Pricing strategy` (select, read-mostly). |
| **alias band** | the alias's own price + qty as band facts, never a family total (PES.5 §3.2; `rows.ts:9-12`). |
| **tooltips** | price cell: the chain in one line (`Master 90.00 × 1.05 = 94.50 · floor 88.20 · not clamped`). Qty cell on an **Amazon** coordinate: *"One quantity for every EU marketplace — changing it here changes IT, DE, FR and ES."* — the same standing honesty `cellHoverNote` (`rows.ts:337-369`) already gives `affectsAllChannels`. Qty on an FBA row: *"FBA quantity is Amazon-managed"* + not editable. |

### 6.3 The interaction, step by step

**H1 cell.** Double-click (or type) opens the number editor; typing `=` switches to
`FormulaCellEditor` with `$` autocomplete and the live preview line (D16.3). Enter commits →
SheetWriter → `PATCH /api/products/bulk` with `target: 'channel'` +
`marketplaceContexts` + the listing's own `expectedVersion` (`types.ts:334-344` — the *listing's*
version, never the product's). Repaint: the written cell, its `Price source` cell, the row's
readiness mark, the alias band's price fact. Autosave indicator per the frame. Keyboard: DS grid
defaults; the fill handle must not swallow the double-click (the `check-editor-open.mjs` gate covers
this).

**H4 verb.** Select rows (or cells) → selection bar shows `Adjust prices by %…` →
**COLLECT** a DS `Modal` with a `NumberStepper` for the percentage, a rounding choice
(`.99` / `.00` / none) and a target-market `Listbox` (default: the current market) →
**PREFLIGHT** `POST /api/products/:id/channel-pricing/preview` (new; §7) returns `findings` →
**CONFIRM** `ActionConfirm` renders "412 cells will change", the first 20 `old → new` pairs, the
refusals grouped by cause, and the type-to-confirm phrase when the impact says so →
**RUN** one batched PATCH, `invalidates: { kind: 'page' }`, a DS `Toast` with "Revert this change"
(D14.4). `Copy prices from market…` is the same flow with a source-market `Listbox` in COLLECT.
Verbs are declared once and rendered on the row menu, the `⋯` column, the selection bar and the
drawer (`registry.ts` adapters) — never drawer-only.

**With the drawer open** the sheet stays live (layout-v2 §5); a bulk apply repaints both, and the
drawer's Pricing section re-reads `/pricing/explain` for the open record only.

### 6.4 Per-scope rules

- **Master**: `basePrice` is the input to every `PERCENT_OF_MASTER` formula; editing it must
  re-evaluate the dependent channel cells synchronously (§1.6 facts — v1 walks the product's own
  formula graph, no job). The cell must warn that it affects every channel.
- **Channel × market (Amazon)**: price is per-market and real. **Quantity is NOT** — proved
  2026-07-26 that zeroing DE zeroed IT. The qty cell on an Amazon coordinate is one shared number
  shown per market; the write must be stated as EU-wide, and the studio must never offer per-market
  qty suppression (close the offer instead — `offerClosedAt`, `schema.prisma:1507`).
- **Channel × market (eBay)**: price *and* quantity are genuinely per-item; no EU sharing.
- **Single-store channels (Shopify/Woo/Etsy)**: `marketplace = 'GLOBAL'`; one price, one qty. Note
  `resolveWriteRouting` currently has **no channel write route at all** for them
  (`studio-sheet.service.ts:520-524` — the write endpoint types `channel` as `'AMAZON' | 'EBAY'`), so
  their price cells must render read-only *with the reason*, not silently uneditable.
- **Alias band**: each alias prices independently; a `CONTEXT(alias-group)` variant of the ±% verb is
  the natural H5 addition once aliases go live.

### 6.5 Provenance / autosave / readiness / publish

- Provenance marks reuse §9.6's vocabulary with its existing precedence `ai > formula >
  mappedShared > mapped > chain`; `🔗 inherited` maps to `followMasterPrice = true`, `✎ pinned` to a
  literal with the flag cleared. **A write must clear the follow flag** — `product-channel-data.routes.ts:169`
  already does; `marketplaces.routes.ts` and `pricing.routes.ts:1280` do not (§5.2, §5.3).
- Autosave is the SheetWriter's, with the *listing's* `expectedVersion`; a 409 raises the existing
  conflict banner. The nav guard must cover in-flight price writes (ruling #87's 8.19).
- Readiness: "no price on this coordinate" is a real publish blocker on eBay
  (`ebay-variation-push.service.ts:1781`) and should be one `ChannelReadinessIssue` from the ONE
  server definition (`services/pim/readiness.service.ts`) — it currently has no price rule at all
  (grep: 0 hits).
- Publish: the H7 pane's "price the next publish will send" must come from the SAME leaf the publish
  path uses. Today it would not (§5.4). Unifying that leaf is the piece of work that makes the pane
  honest rather than decorative.

### 6.6 ASCII mockup

```
 SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]        Market [IT ▾]  Locale [it ▾]
 21 rows · 4 selected  [View ▾][Clamped (3)][Missing price (2)]  Find…  [Customise]
┌──────────────────────┬─────────┬────────┬───────┬──────────┬──────────────────┐
│ SKU                  │ Price   │ Sale   │ Qty   │ Source   │ Strategy         │
├──────────────────────┼─────────┼────────┼───────┼──────────┼──────────────────┤
│ ▸ ① eBay·IT · 1234…  │         │        │       │          │                  │
│   GALE-NERO-L        │ ƒ 94.50 │   —    │ 12    │ Rule     │ Manual           │
│   GALE-NERO-M        │ ✎ 89.99 │ 79.99  │ ⚠ 50  │ Sale     │ Manual           │
│   GALE-NERO-S        │ 🔗 90.00│   —    │ 8/8   │ Master   │ Match competitor │
│   GALE-ROSSO-L       │ ⚠ 84.00 │   —    │ 0     │ clamped  │ Cost-plus        │
└──────────────────────┴─────────┴────────┴───────┴──────────┴──────────────────┘
 ▸ hover ƒ 94.50 → "= $basePrice * 1.05  ·  master 90.00 → 94.50  ·  floor 88.20"
 ▸ hover ⚠ 50    → "12 available (pool 14 − buffer 2). One qty for all Amazon EU."
┌ 4 selected ─────────────────────────────────────────────────────────────────┐
│ Adjust prices by %…  Copy prices from market…  Set price…  Set listed qty…   │
│ Pause offer   Publish preview                                        Clear   │
└─────────────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused as-is:** `GET /api/pricing/explain` (H7 pane) · `PATCH /api/products/:id/channel-follows`
(the 🔗/✎ toggle) · `PATCH /api/products/bulk` (the cell write) · `POST /api/products/sheet/publish-preview`
· `ChannelListingOverride` + `PriceChangeEvent` (the drawer's History pane already has a timeline to
hang these on).

**Server changes, all additive:**
1. **PES.5** — add `price`, `salePrice`, `quantity` to `CHANNEL_FIELD_MAP`
   (`channel-field-map.ts:22`) and `CHANNEL_WRITABLE` (`studio-sheet.service.ts:462`), with the
   follow-flag entries in `FOLLOW_FLAG_FOR_COLUMN` (`:44`) so a write clears
   `followMasterPrice`/`followMasterQuantity`. This is what turns A.3a's "the column writes the same
   store the Pricing surface uses" from a sentence into code, and it is what makes `formulaWritable`
   true for the price cell.
2. **PES.5** — `POST /api/products/:id/channel-pricing/preview` (`commit=false`): body is the verb's
   collected parameters + the target coordinates; response is `{ findings[], refusals[], totals }`
   with `old → new` per cell, computed by the **server**, and the floor from `resolvePrice`'s
   `constraints`.
3. **PES.5** — one shared leaf `resolveOutboundPrice(listing, product, coordinate)` that every
   publish path calls, replacing the three ad-hoc chains (§5.4). Highest-value change in this
   feature and the only one that makes the H7 pane true.
4. **PES.5** — `aliasKey` parameter on `resolvePrice` / `/pricing/explain` (§5.9).
5. **PES.5** — a `price` readiness rule in `readiness.service.ts` so "no price" is a chip, not a
   publish-time surprise.
6. **PES.5** — fix `permissions-manifest.ts:382` so `products.price.edit` matches the pricing routes
   (or delete it and say so).
7. **PES.6** — `competitor()` in `expr.ts` **only if** the Owner picks that route in Q1.
8. **PES.2** — a numeric/currency cell editor + renderer with the `/ available` sub-value and the
   clamp mark; the `⚠ ƒ` error state already exists.
9. **PES.3** — the two `SELECTION` verbs, the collect modals, the Price-source column, the view chips.
10. **PES.4** — the drawer's Pricing section.
11. **No schema change is required.** `priceAdjustmentPercent` and `pricingRule` can be left in place
    and read-only-migrated to formulas/strategies later; the migration is a backfill, not a DDL.

## 8. Risks and traps

- **Local dev writes the production database and every eBay listing in the GALE family is LIVE.** A
  ±% verb built without a `commit=false` path is a loaded gun; build the preview first.
- **Amazon EU shared quantity** (proved, 2026-07-26): never scope an Amazon qty write per market, and
  never read a cross-market qty difference as independence — it is a stale read.
- **Oversell is per-channel, never summed**: `max(commitment) − pool`, FBA excluded, Amazon EU
  collapsed to one commitment. A sum-based alarm fires on every healthy product.
- **FBA quantity logic is untouchable** — the qty cell must be read-only on an FBA row, using the
  cascade's own `resolveCascadePushMethod` rather than a re-derivation.
- **Flat-file editors are untouchable**, and they read `ChannelListing.price` for the round-trip
  (`product-channel-data.routes.ts:76-79`). Adding a write route must not change what
  `getExistingRows` sees.
- **A blur commits to production.** The cell editor's own blur is a write path; enumerate every path
  to a write before any browser verification.
- **`priceOverride` vs `price`**: pick ONE as the studio's write target and state it in the contract.
  Writing the other is the §5.2 defect repeated.
- **Publish gates**: eBay is preview-only; mode comes from the server, never from an env read.
- **AI stays dark** — no suggested prices, no AI repricing (ruling #13).
- **Two aliases on one coordinate** currently resolve to the primary's price chain.

## 9. Open questions for the Owner (3)

1. **Does `MATCH_AMAZON` live in the formula language or stay a strategy?** The rule as implemented
   reads a *competitor observation* that changes hourly, and formulas materialise on write.
   **Recommendation: keep it a strategy** — an H1 select cell assigning a named repricing rule, the
   maths and cadence at `/pricing`, the outcome in the H2 column and the H7 pane. If you want it in
   the cell, the honest form is one new nullary function `competitor()` evaluated at the cell's own
   coordinate plus a re-evaluation hook on the competitor-refresh job — **not** a cross-channel
   reference syntax, which would encode a misreading of the rule.
2. **Do the ±% adjust and copy market→market verbs get built?** Parity row 6.7 left them 🗳 and
   Owner queue item 8 is still open. **Recommendation: yes, as the two SELECTION verbs above** —
   they are the tools the old page's three separate copies of this arithmetic prove operators use,
   and the studio version is strictly safer (server maths, a preview, a revert) than what exists.
3. **Which column is the studio's channel price?** `price` (what the flat file and the sync worker
   read) or `priceOverride` (what the engine's override layer and `/pricing/bulk-override` read)?
   **Recommendation: `priceOverride` + `followMasterPrice = false`**, because that is the pair the
   resolver and the engine already agree on (`attribute-resolver.ts:135`), and fix the three writers
   that disagree — rather than teaching a fourth reader about `price`.

## 10. Effort and dependencies

| piece | size | depends on |
|---|---|---|
| Price/salePrice/qty columns with a real channel write route (PES.5) | **M** | A.3a channel attribute model; blocks everything else here |
| One shared `resolveOutboundPrice` leaf + retiring the three ad-hoc chains (PES.5) | **L** | nothing; highest value, highest blast radius — needs its own rehearsal |
| Numeric/currency cell editor + `/available` sub-value + clamp mark (PES.2) | **S** | grid substrate |
| `PERCENT_OF_MASTER` as a formula (PES.6) | **S** | `formulaWritable` on the price column (piece 1) |
| Preview endpoint + the two SELECTION verbs + collect modals (PES.5 + PES.3) | **M** | piece 1; D14.4 approval; Owner Q2 |
| `Price source` column + view chips (PES.3) | **S** | `/pricing/explain` or the shared leaf |
| Drawer Pricing section (PES.4) | **S** | `/pricing/explain` + `aliasKey` param |
| Qty oversell / shared-EU warnings on the cell (PES.5 + PES.3) | **M** | `available-to-publish` + the oversell watchdog, both exist |
| `price` readiness rule (PES.5) | **S** | readiness service |
| Strategy assignment cell + `/pricing` library link-out (PES.3 + H11) | **M** | Owner Q1 |
| Permission-manifest fix (PES.5) | **S** | nothing |

Cross-feature dependencies: the **alias** work (an alias-scoped price is a second row on one
coordinate), the **formula** lane (piece 4 is its consumer), the **Errors & Sync console** (clamped /
no-price / oversell queues), and the **publish** lane (the H7 pane's last line is only true once
piece 2 lands).
