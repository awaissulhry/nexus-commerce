# 19 — Amazon PRICING card: regular + sale price, save-%, currency, quantity, buy-box, repricing readout

## 1. What it is (operator terms)

The offer half of an Amazon listing. A merchandiser opens a product on Amazon·IT and needs four things
at once: **what we charge** (regular price, and a sale price with the discount it implies), **how much
we say we have** (the published quantity), **what the market is doing** (does our offer hold the Buy
Box; if not, at what price is it being won, and how stale is that reading), and **what the machine
decided** (the repricer's latest decision, whether it was applied, and why). Today that is one dense
card inside the Amazon cockpit tab. Whoever changes a price uses it — a pricing/merchandising operator
several times a day around promotions, and a reactively, whenever a suppression or an ads report says
we have lost the box. It is the highest-consequence surface in the studio: every value on it is money,
two of the four (quantity, price) can be moved by crons behind the operator's back, and one of the
writes (`purchasable_offer`) is the same slot the repricer overwrites.

## 2. Old UI — inventory

**Entry point:** Amazon cockpit tab → `AmazonCockpit.tsx:732` mounts `PricingCard`, with
`currency={composed.currency}` (ultimately `Marketplace.currency` — see `AmazonCockpit.tsx:516,665`),
`price`/`quantity` from the composed listing (draft-bus reactive, AC.5), `salePrice`/`lastSyncedAt`/
`listingId` straight off the `ChannelListing` row.

**`tabs/amazon-cockpit/pricing/PricingCard.tsx` — 970 lines, four sections:**

| # | Section | file:line | Round-trips |
|---|---|---|---|
| 1 | Price block: big price, struck-through regular, `Save N%` pill, Qty, "Synced Xm ago", "No price set" | `:374` render, `savePct` at `:269-274` | inline editor → `PATCH /api/listings/:id` with `{priceOverride, salePrice}` (`:185-243`) |
| 2 | Buy Box: WON/LOST pill, 4 KPI tiles (Buy Box price · Lowest comp · Our margin · Winner FBA/FBM), 10-dot won/lost sparkline with `title=` tooltips | `:435-521` (`KpiBox` `:660`), dots `:503-520` | `GET /api/products/:id/buybox?marketplace=` on mount + on `tick` (`:252`) |
| 3 | Repricing rule + last 5 decisions: strategy label, `by N%`/`by €X`, floor/ceiling, `old → new`, applied/skipped | `:524-628`, `STRATEGY_LABEL` `:159-164` | same `/buybox` call (the route folds rule + decisions in) |
| 4 | Offer add-ons: Subscribe & Save + Business pricing inline editor; coupons a deep-link | `AddOnsEditor` `:696+` | `PATCH /api/listings/:id` `{platformAttributes}` shallow-merge |

- **Refresh (`:299`)** is a **local `setTick`** — it re-reads the DB, it does **not** ask Amazon.
  The empty state at `:467-469` tells the operator "the sp-api-pricing cron populates BuyBoxHistory
  every few hours", which is **false**: the ingest is 02:30 UTC **daily** (`pricing-refresh.job.ts:10`).
- Everything is server-backed. **No localStorage.** No polling.
- **Dead:** `RepricingDecisionRow.decidedPrice` (`:73`) is a phantom — `RepricingDecision` has no such
  column (`schema.prisma:1204-1224`), so `d.newPrice ?? d.decidedPrice` at `:613` has a dead right arm.
  "Manage" (`:548`) and the empty-state link (`:560`) leave the page for `/pricing/rules?productId=` —
  the rule is not editable here at all.
- **Neighbours:** `tabs/AnalyticsTab.tsx:305-330` "Repricing (latest decision)" — same
  `RepricingDecision`, from `GET /api/products/:id/analytics`, and it **hardcodes `€`** at `:316`.
  `tabs/ChannelPricingSection.tsx` (482 lines, only caller was `MatrixTab.tsx:1074`) is a
  variant × market price/salePrice grid on `GET/PATCH /api/products/:id/channel-pricing`
  (`:168,:185`). `tabs/PricingTab.tsx` (1078 lines) owns tier prices + scheduled changes — a
  *different* feature; it embeds `ChannelPricingSection`.

## 3. Backend that exists

**Routes** (all `apps/api/src/routes/`, prefix `/api`, registered `index.ts:708`):

| Method + path | file:line | Notes |
|---|---|---|
| `GET /products/:id/buybox?marketplace=` | `pricing.routes.ts:1639-1699` | latest `BuyBoxHistory` + last 10 + the matching `RepricingRule` + its last 5 decisions. Channel hard-coded `AMAZON` (`:1690`). Default marketplace `'IT'` (`:1644`). Four sequential-ish queries, one route. |
| `PATCH /listings/:id` | `listings-syndication.routes.ts:1168-1300+` | accepts `priceOverride`, `salePrice` (`:1229-1252`), `expectedVersion` CAS + `version` increment (`:1281-1291`). |
| `GET/PATCH /products/:id/channel-pricing` | `product-channel-data.routes.ts:47`, `:150` | PATCH accepts `price`/`salePrice`/`quantity` per (variantId, channel, marketplace); pins `followMasterPrice=false` (`:170`), upserts with **`aliasKey: ''`** (`:177`). |
| `GET /pricing/buybox-stats` | `pricing.routes.ts:779` | catalog-wide win-rate aggregate. |
| `GET /pricing/repricing-decisions` | `:1346` | feed, filterable by `ruleId`/`applied`. |
| `GET /pricing/price-history?productId=…` | `:1389` | `PriceChangeEvent` timeline **+ per-coordinate sparkline series**, already built for the /pricing drawer. |
| `POST /pricing/refresh-competitive` | `:1330` | **live SP-API call, no permission gate of its own, no dry-run.** |
| `POST /pricing/push` | `:1158` | pushes the snapshot price via `pushPriceUpdate`. |
| `POST /pricing/bulk-override` | `:1186` | sets/clears `priceOverride` and writes `PriceChangeEvent` (`:1296`). |

**Services**
- `sp-api-pricing.service.ts` — `refreshCompetitivePricing` (`:230-360`) calls `getItemOffersBatch`
  (20 ASINs/call), writes `ChannelListing.lowestCompetitorPrice` + `Product.buyBoxPrice` + appends a
  `BuyBoxHistory` row (`:329`). `isOurOffer` compares `AMAZON_SELLER_ID`/`AMAZON_MERCHANT_ID` (`:288`).
- `repricing-engine.service.ts` — six strategies: `manual`, `match_buy_box`, `beat_lowest_by_pct`,
  `beat_lowest_by_amount`, `fixed_to_buy_box_minus`, `maximize_margin_win_box` (`:173-250`), every one
  clamped to the rule's floor/ceiling.
- `pricing-outbound.service.ts` — `pushPriceUpdate` (`:49`) → `pushAmazonPrice` (`:99`): needs a
  seller id, a seeded `marketplaceId`, and `platformAttributes.productType`; writes a
  `ChannelListingOverride` **only when the result is not `dryRun`** (`:180-190`, PD.3).
- `promotion-scheduler.service.ts` — materialises `ChannelListing.salePrice` on a
  `RetailEventPriceAction` window (`:109-115`) and clears it on exit (`:179-185`), writing
  `PriceChangeEvent` both times.
- `price-history.service.ts:87` — the one helper that writes `PriceChangeEvent`.
- `flat-file.service.ts:2873-2892` — the only place that assembles the **full** `purchasable_offer`
  (currency + our_price + condition_type + sale_price with `start_at`/`end_at`).

**Prisma**
- `BuyBoxHistory` (`schema.prisma:5996-6024`): `productId, channel, marketplace, observedAt,
  buyBoxPrice, lowestCompetitorPrice, isOurOffer, winnerSellerId, fulfillmentMethod,
  marginAtObservation`.
- `RepricingRule` (`:1140-1202`): `enabled, minPrice, maxPrice, strategy, beatPct, beatAmount`,
  schedule, `lastEvaluatedAt/lastDecisionPrice/lastDecisionReason`. One row per (product, channel, marketplace).
- `RepricingDecision` (`:1204-1224`): `oldPrice, newPrice, reason, buyBoxPrice, lowestCompPrice,
  competitorCount, applied, capped`.
- `PriceChangeEvent` (`:5943-5970`) + `PriceChangeSource` enum (`:5972-5981`) — **carries its own
  `currency` per row.**
- `ChannelListing` price surface: `price` (`:1477`), `salePrice` (`:1478`), `priceOverride` (`:1582`),
  `masterPrice` (`:1574`), `quantity` (`:1486`), `quantityOverride` (`:1583`), `pricingRule`,
  `priceAdjustmentPercent`, `followMasterPrice` (`:~1533`), `lowestCompetitorPrice`,
  `competitorFetchedAt`, `estimatedFbaFee`, `referralFeePercent`, `version` (`:1645`), `aliasKey`
  (`:1699`). **No `currency`. No sale-window columns.**
- `RetailEventPriceAction` (`:6049-6077`): `setSalePriceFrom` / `setSalePriceUntil` — the only real
  sale-window store, at **event × (channel, marketplace, productType)** scope, not per listing.

**Crons** (`index.ts`, `pricing-refresh.job.ts`, `repricing-evaluator.job.ts`)
- `NEXUS_ENABLE_PRICING_CRON=1` gates the whole pricing block (`index.ts:1098`): FX 00:30, snapshots
  hourly, promotions hourly, **fees 02:00 Sun, competitive/buy-box 02:30 daily**.
- `startRepricingEvaluatorCron()` — **default-ON** (`index.ts:1057`), every 5 min, cap 500 rules.
  `NEXUS_REPRICER_LIVE=1` flips `applyToProduct` to true and enqueues `PRICE_UPDATE`
  (`repricing-evaluator.job.ts:93,192-200`) — the file header still says "applyToProduct=false at this
  stage", which the CE.3 block below it contradicts.
- Freshness window `RECENT_OBSERVATION_HOURS = 6` (`:57`).

**Permissions** (`permissions-manifest.ts`)
- `RW(F.pricingView, F.pricingEdit, pfx('/api/pricing'))` (`:266`) → the `/pricing/*` family.
- `RW(F.repricingView, F.repricingRulesManage, pfx('/api/repricing'))` (`:264`).
- `GET /api/products/:id/buybox` is **not** under `/api/pricing` — it falls to
  `RW(F.productsView, F.productsEdit, pfx('/api/products'))` (`:412`). So buy-box + repricing data is
  readable by anyone with `products.view`.
- `P(F.productsPriceEdit, … has('/price'))` (`:382`) — the price-edit permission only fires on a path
  containing `/price`. `PATCH /api/listings/:id` is gated by **`F.listingsEdit`** (`:163`), and
  `PATCH /api/products/:id/channel-pricing` by `F.productsEdit`. **Neither requires
  `productsPriceEdit`.**
- `financialFilterHook` is a global `preSerialization` hook (`index.ts:640`), active only when
  `NEXUS_RBAC_MODE === 'enforce'` (`field-filter.ts:63`). **`marginAtObservation` and
  `estimatedFbaFee` are in `RESTRICTED_FIELDS`** (`financial-fields.ts:48`, `:14`) — so under enforce
  the `/buybox` payload's margin is *absent*, not null.

## 4. Studio today

- **Channel sheet rows already carry the money.** `sheet-rows.service.ts:436-437` emits
  `price: priceOverride ?? price` and `quantity: quantityOverride ?? quantity` per listing, plus the
  listing's own `version` (`:67`) and `aliasId` (`types.ts:298`). **No `salePrice`, no currency.**
- **There is no price COLUMN.** `sheet-columns.service.ts` builds columns from the channel specs;
  `channel-specs/amazon.ts:45-50` links only four Amazon attributes to master (`item_name`,
  `product_description`, `bullet_point`, `generic_keyword`). Nothing links `purchasable_offer`.
- **There is no price WRITE path.** `channel-field-map.ts:23-35` (`CHANNEL_FIELD_MAP`) has six entries
  — title, description, variationTheme ×2 channels, plus `amazon_bulletPoints`. No price, salePrice or
  quantity. `isChannelWritable` (`:60`) therefore refuses a price field, and an `attr_price` would land
  in `overrideData.price` — a store no reader consults. `studio-sheet.service.ts:462-470`
  (`CHANNEL_WRITABLE`) is the same four concepts keyed by sheet column.
- **A listing-only spec field is read-only by construction:** `sheet-columns.service.ts:483-485`
  sets `editable: !listingOnly`, with the comment "its write route lands with AM.1 phase 2".
- **`ChannelSheet.tsx:917` deliberately synthesises NO quantity column** ("Quantity is per alias,
  never summed").
- **The drawer shows one price:** `drawer/panes/ListingsPane.tsx:137-138` `Price` via `money()` at
  `:30` — `Intl.NumberFormat(undefined, { style: 'currency', currency: 'EUR' })`, **hardcoded EUR**.
  Quantity beside it at `:141-145` with the correct "never summed" note.
- **The buy-box readout already exists on the Analytics tab.** `ancillary/AnalyticsAdsTab.tsx:85-91`
  is a Prices table with a `buyBox` column that renders **`'No observation'`** and `nds-muted` when
  unknown; joined by `joinPriceRows` (`analytics/readAnalytics.ts:187-220`) on the **coordinate** with
  fan-out. Neither `price` nor `buyBox` carries a currency there.
- **Parity audit:** row **3.24** = "🕳 — no buy-box data; sale-price save-% math absent. Price and qty
  exist as cells." (`docs/pes-parity-audit.md:146`); **6.1** SUPERSEDED, **6.2** PARITY,
  **6.3** "⛔ N/A (PES.3) — channel price / listed qty is the channel scope" (`:362-364`);
  **6.29** "🕳 … Nothing of 6.29 is built" (`:398`) — **stale**: `AnalyticsAdsTab` has since shipped
  the prices/buy-box table (ruling #334).

**Hub rulings that bind**
- **#324** — 🔴 **`BuyBoxHistory` has ZERO ROWS in prod.** "Every buy-box price this service returns is
  `null` for every product on every channel today, regardless of any join or filter." Filed as an
  observation, routed to the Owner as a collection gap outside PES.
- **#334** — APPROVED: buy-box absence must read **"No observation"**, never "Not set", never a dash
  or `0.00`. "An unset PRICE is a configuration the seller hasn't made; an absent BUY BOX is a reading
  WE have never taken."
- **#322** — a buy-box price is a property of the **COORDINATE** (ASIN × marketplace), not of an alias;
  join on `channel:marketplace` with fan-out. Whether per-alias prices are wanted at all is an
  **open Owner question**.
- **#321** — parallel-array joins on price/buy-box are a fixture property, not a guarantee.
- **#58** (BINDING, quoted at `ChannelSheet.tsx:519-528`) — 399 of 441 eBay·IT cells route to MASTER;
  a master-routed edit needs the `affectsAllChannels` acknowledgement, asked once per coordinate.
- Layout doc `docs/2026-09-01-product-edit-studio-layout.md:110` — "Channel price/qty → existing
  channel-pricing route."
- AM.1 **§A.3a** (APPROVED 2026-09-05) — no exclusions: `purchasable_offer` becomes columns, and
  "the column reads and writes **the same store that surface uses**, so the two can never disagree —
  the cell's tooltip names the other surface, it never hides the column."

## 5. Defects and slowness

1. **`BuyBoxHistory` is empty in production.** MEASURED-IN-DOC (ruling #324). Every buy-box number in
   this feature is `null` today. The competitive ingest is gated behind `NEXUS_ENABLE_PRICING_CRON=1`
   (`index.ts:1098`) and I cannot read Railway env from here — HYPOTHESIS: the gate is off. Either way
   the feature must ship honest-and-empty, and the collection gap is an Owner item, not a PES one.
2. **A 6-hour freshness window fed by a daily ingest.** `repricing-evaluator.job.ts:57`
   `RECENT_OBSERVATION_HOURS = 6` vs `pricing-refresh.job.ts:10` competitive refresh at 02:30 daily.
   For ~18 of 24 hours `obs` is null, `skippedStaleObservation` increments and the engine runs on no
   market data. CODE-READ.
3. **The card lies about the cadence.** `PricingCard.tsx:467-469` says "every few hours". CODE-READ.
4. **"Refresh" refreshes nothing external.** `PricingCard.tsx:299` bumps local state; the only real
   refresh is `POST /api/pricing/refresh-competitive`, which the card never calls. CODE-READ.
5. **`PATCH /channel-pricing` reports success unconditionally.**
   `product-channel-data.routes.ts:207-209`: `await Promise.allSettled(ops)` then
   `reply.send({ ok: true, updated: updates.length })`. Every write can reject and the route still
   returns `ok: true`. It also has **no `expectedVersion`, no `version` bump**, writes
   **`lastSyncedAt: new Date()`** on a purely local write (a claim that a channel sync happened),
   hardcodes **`aliasKey: ''`** (`:177`), writes no `PriceChangeEvent`, and cannot clear a price
   (`u.price !== null` guard at `:170`) though it can clear a salePrice. CODE-READ — the single most
   important item in this report.
6. **Four independent currency derivations, three of them wrong for seeded markets.**
   `Marketplace.currency` is authoritative and seeds SE→SEK, PL→PLN, US→USD
   (`marketplaces.routes.ts:19-21`). Against that: `CURRENCY_MAP` covers only IT/DE/FR/ES/UK and
   defaults EUR (`flat-file.service.ts:49`); `currencyForMarketplace` returns EUR for SE/PL
   (`listing-wizard.routes.ts:5506-5515`); `outbound-sync.service.ts:289`
   `code === "UK" || "GB" ? "GBP" : "EUR"` — EUR for US, SE and PL. Plus `ListingsPane.tsx:30`
   hardcodes EUR and `AnalyticsTab.tsx:316` hardcodes `€`. CODE-READ.
7. **Three readers of "our price", two answers.** `sheet-rows.service.ts:436` and
   `amazon-cockpit-publish.routes.ts:160` use `priceOverride ?? price`;
   `flat-file.service.ts:2303` uses `listing?.price` alone. With a `priceOverride` set, the flat-file
   grid and the studio sheet show different prices for the same listing. CODE-READ.
8. **`sale_price` has exactly one publish path, and it is not the studio's.** `buildRow`
   (`amazon-cockpit-publish.routes.ts:173-181`) is the only emitter besides the flat-file assembler.
   `outbound-sync.service.ts:305` — the `PRICE_UPDATE` queue consumer — emits `purchasable_offer` with
   `our_price` **only**; `channel-batch/amazon-batch-feed.service.ts` emits no sale price at all.
   Writing `salePrice` from the studio today persists a value that never reaches Amazon. CODE-READ.
9. **🔴 A price push DESTROYS the sale price on Amazon.**
   `amazon-sp-api.client.ts:735-748`: `op: 'replace'`, `path: '/attributes/purchasable_offer'`, value
   `[{ marketplace_id, currency, our_price }]`. Comment: "The whole purchasable_offer slot is
   overwritten". So any `/pricing/push` or live repricer decision silently wipes `sale_price`,
   `condition_type` and any other offer sub-property. CODE-READ. This is the trap that decides whether
   sale price may be edited from the sheet at all.
10. **The sale WINDOW has no per-listing store.** `RetailEventPriceAction.setSalePriceFrom/Until`
    (`schema.prisma:6069-6070`) is event-scoped; its own comment claims the scheduler "stamps [them]
    onto affected ChannelListings as salePrice activation / expiry windows" — those columns do not
    exist. The only per-listing window is
    `flatFileSnapshot['purchasable_offer__sale_from_date' | '__sale_end_date']`, which the studio
    never reads (`sheet-rows.service.ts:374-376` does not select it; `/all-listings` explicitly omits
    it, `marketplaces.routes.ts:229`). CODE-READ.
11. **The promotion scheduler can clear an operator's sale price.**
    `promotion-scheduler.service.ts:103-104` matches on `|salePrice − promoPrice| < 0.005` to decide
    ownership; a hand-set sale price equal to the promo price is cleared on exit. CODE-READ, low
    likelihood, high surprise.
12. **A phantom field in the wire type.** `PricingCard.tsx:73` `decidedPrice` does not exist on
    `RepricingDecision`; a mirrored type that drifted. CODE-READ.
13. **Margin has a third absence state nobody renders.** Under `NEXUS_RBAC_MODE=enforce`,
    `marginAtObservation` is *stripped* from the payload (`financial-fields.ts:48`), so "hidden by
    permission" is indistinguishable from "no observation" in the card's `formatPrice(null)` → `—`.
    CODE-READ.
14. **`POST /pricing/refresh-competitive` has no gate and no dry-run** (`pricing.routes.ts:1330-1342`)
    — a real SP-API call reachable by anyone with `pricing.edit`. Read-only against Amazon, so the
    risk is throttle/cost, not a write. CODE-READ.
15. **N+1 in the ingest.** `sp-api-pricing.service.ts:310-340` does three sequential writes
    (`channelListing.update`, `product.update`, `buyBoxHistory.create`) per ASIN inside the batch loop.
    CODE-READ.
16. **`Product.buyBoxPrice` is a per-product scalar** written from whichever marketplace ran last
    (`sp-api-pricing.service.ts:317-320`) while the buy box is per coordinate (#322). CODE-READ.
17. **No tests** on `PricingCard`, on `/products/:id/buybox`, or on `PATCH /channel-pricing`
    (`repricing-engine.service.test.ts` covers the strategies only). CODE-READ.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**Primary: H1 — four cells in one "Offer" column group on the Amazon channel scope.**
`Price` · `Sale price` · `Sale window` · `Qty`. Price and quantity are per-row, per-market values an
operator edits all day, and AM.1 §A.3a has already ruled that `purchasable_offer`'s leaves are columns
reading the same store Pricing uses. Putting them anywhere else re-creates the cockpit card the
programme is replacing. `Sale window` is **one compound cell** (start + end in one popup), because a
start without an end is not a sale and two independent date cells make the invalid state easy to reach.

**Mirror: H2 — a `Save %` derived column plus four buy-box status columns.**
`Save %` is arithmetic on two cells in the same row and must never be typeable (`savePct` at
`PricingCard.tsx:270`). The buy-box facts are *reported by the channel*, never authored: `Buy box`
(won / lost / **No observation**, per ruling #334), `BB price`, `Δ vs ours` (signed, our price minus
buy-box price), `BB checked` (age of `observedAt`). Status columns give the operator what the card
never could: **filter and sort the family by who is losing the box.**

**Mirror: H2 + H7 — `Repricer` status column and a drawer "Pricing" section.**
The column is one cell: strategy short-name + enabled/paused + last decision arrow
(`89.99 → 87.49 · applied`), muted with a reason when no rule exists. Depth — floor/ceiling, the last
N decisions with their reasons, and the price-over-time chart — goes in the drawer's **Pricing**
section, because that is 40+ lines of structured detail for one row and the drawer is where per-listing
status detail belongs (H7). The **rule itself is not editable here**: it is account/config-shaped and
already has a manager at `/pricing/rules` → **H11**, with the studio holding only the readout and a
link-out. That matches what the old card already did (`PricingCard.tsx:548`).

**Mirror: H3 + H6 — `Refresh buy-box`.** A ROW verb (`refresh-buybox`) on the row menu / ⋯ / drawer,
mirrored as an H6 SheetToolbar `trailing` button for the whole coordinate. It must call
`POST /api/pricing/refresh-competitive` (marketplace-scoped) — the *real* SP-API read — not a local
refetch. It is a coordinate-level operation (one `getItemOffersBatch` covers up to 20 ASINs), so the
scope-level form is the honest one and the row form is a convenience that narrows the report, not the
call. H4 (selection) is **not** offered: N rows on one coordinate collapse to the same API call, and a
selection verb would imply otherwise.

**H12 — drop from the studio:** Subscribe & Save and Business pricing (`AddOnsEditor`,
`PricingCard.tsx:696+`). The file's own comment says the publish-side mapping was never written; they
are two more offer sub-properties that `patchListingPrice`'s `replace` would destroy. Needs the
Owner's sign-off at swap.

### 6.2 What the sheet shows at rest, per scope

**Master scope:** `Base price` and `Cost`/`Min margin` as they are today (rows 6.1/6.2 — parity).
**No sale price, no buy box, no repricer column.** There is no market coordinate on master to price
against (row 6.3, ⛔ N/A) and a buy box is per ASIN × marketplace (#322). A master row shows nothing
of this feature — deliberately, and the Essentials preset says so by omission.

**Amazon channel scope (× market):** one `Offer` column group, pinned right after identity in the
Essentials preset:

| Column | Kind | At rest |
|---|---|---|
| Price | H1 money cell | `€ 199,00`, market currency, `✎` when pinned / `🔗` when following master |
| Sale price | H1 money cell | `€ 179,00`, or blank (an empty sale price is a *decision*, not a gap → no ⚠) |
| Sale window | H1 compound cell | `1 Nov → 30 Nov`, or blank; **amber** when the window has expired while a sale price is still set |
| Save % | H2 derived | `−10%` pill; **blank** when either input is missing; **⚠ tooltip** when sale ≥ regular |
| Qty | H1 number cell | per alias, never summed (`ChannelSheet.tsx:917`); **read-only with a lock tooltip on FBA rows** |
| Buy box | H2 status | `● won` / `○ lost` / muted **`No observation`** (#334) |
| BB price | H2 status | money, or muted `No observation` |
| Δ vs ours | H2 status | `+€4.00` / `−€2.50`; blank when either side is unknown |
| BB checked | H2 status | `4h ago`; **amber past 24h**, muted `never` |
| Repricer | H2 status | `Beat lowest −2% · 89,99 → 87,49 applied`, or muted `no rule` |

**Alias band row** carries the coordinate-level facts once — `Buy box`, `BB price`, `BB checked` —
because they belong to the coordinate, not to any one alias (#322). Variant rows under the band leave
those three **blank**, not repeated: repeating a coordinate value down N rows is exactly the
mis-attribution #321 warned about, one visual step from a per-row claim we cannot make.

**eBay / Shopify scopes:** `Price`, `Qty` and eBay's own offer fields. The five buy-box columns and
the `Repricer` column **do not exist** — `/products/:id/buybox` hard-codes `channel: 'AMAZON'`
(`pricing.routes.ts:1690`) and the schema comment says AMAZON is "the only channel with a Buy Box
concept today" (`schema.prisma:6000`). A greyed column on eBay would be a claim we could measure and
lose.

### 6.3 The interaction, step by step

**Editing a price (the common case).**
1. Double-click, or type over, the `Price` cell → the engine's numeric editor (DS `Input`, monospace,
   right-aligned), pre-filled with the raw number, with the market currency as a static prefix
   **outside** the editable text — currency is never keyable.
2. On commit, the SheetWriter routes the write to the channel (`writeVerb: 'channel'`,
   `writeTarget: 'channelListing'`) and autosaves. **No `affectsAllChannels` modal** — unlike the 399
   master-routed cells (#58), a price cell is genuinely channel-scoped.
3. Repaints: the cell (`✎ pinned` provenance, because the write sets `followMasterPrice=false`),
   `Save %`, `Δ vs ours`, the row's readiness dot, the alias band's readiness, and the footer's
   autosave chip. Nothing else.
4. A 409 repaints the cell from the server's value and shows the DS `Banner` the writer already uses.

**Editing sale price + window.**
1. `Sale price` commits like `Price`, with one client rule: **sale ≥ regular is a warning, not a
   block** — the cell keeps the value, `Save %` shows `⚠`, and readiness raises a warning row. Amazon
   itself rejects it; blocking locally would make the sheet disagree with the channel.
2. `Sale window` opens a **compound popup** (AM.1's compound shape): two DS date inputs, `Clear`, and
   one line of copy naming what the window means. Committing writes both leaves in one change.
3. Setting a sale price with no window shows an **inline hint in the cell tooltip**, not a modal:
   Amazon treats an open-ended sale differently and the operator should know, once.

**Refresh buy-box (the verb).**
- **COLLECT** — none.
- **PREFLIGHT** — `available()` returns `disabled` with a reason when the scope is not Amazon or the
  market has no seeded `marketplaceId`. The preflight states plainly: *"Asks Amazon for current offers
  on all 7 ASINs of this coordinate. Reads only — no listing is changed. Last reading: never."* and
  returns `ActionImpact.level: 'confirm'` — a live SP-API call against a throttled quota earns one
  click, and `ActionImpact` (never a fixed flag) is what says so.
- **CONFIRM** — DS `ActionConfirm` via `useActionPress`.
- **RUN** — `POST /api/pricing/refresh-competitive { marketplace }`, then refetch the coordinate.
- **REPAINT** — the five buy-box columns and the alias band. Result toast names the count and the
  errors; a 403 from a paywalled SP-API account is reported as *"Amazon did not return offers for this
  account"*, never as a zero.

**The drawer's `Pricing` section** (H7, inside the existing `Listings` pane rather than a fifth tab —
it is the same listing's offer): DS `KeyValue` for price / sale price / window / qty / currency /
floor–ceiling / strategy; DS `MetricStrip` for buy-box price, lowest competitor, Δ, win-rate over the
last 10; a **price-over-time chart** from `GET /api/pricing/price-history` (which already returns a
sparkline series per coordinate); a DS `DataGrid` of the last 10 `RepricingDecision` rows with
`reason` and `capped`. Sheet stays live behind it; editing a price cell while the drawer is open
repaints both, since both read the same row.

**Keyboard:** nothing new. Type-or-Enter edits, Tab/arrows move, ⌘Z undoes, `Enter` on the identity
cell opens the drawer. The `Sale window` popup owns Enter/Tab/Esc while open (an AG popup editor
always does), so its own `Clear`/`Apply` buttons are reachable by Tab inside the popup only.

**Charting note:** DS `PerformanceGraph` requires **both** `left` and `right` series
(`PerformanceGraph.d.ts:8-15`) and puts them on independent axes — wrong for two prices in the same
currency, which must share a scale or the crossings lie. `BurnDownChart` is single-axis but
cumulative. **Recommend ONE new DS component** — `PriceTrendChart` (n same-axis series, one
`format`, an optional threshold rule for floor/ceiling) — or, cheaper, an additive `right?:
ChartSeries` + `series?: ChartSeries[]` on `PerformanceGraph`. DS.1's call.

### 6.4 Per-scope rules

- **Master:** none of this feature. Base price only.
- **Amazon × market:** the full set. Currency comes from that market's `Marketplace.currency` — so
  the same product on UK shows `£` and on SE shows `kr`, from the *same* column definition.
- **Alias band:** coordinate facts once (buy box, BB price, BB checked); price/sale/qty stay on the
  rows, because they are per listing. The band's `CONTEXT(alias-group)` menu carries no price verb —
  `apply-to-siblings` for a price is a bulk repricing operation and belongs to `/pricing`, not here.
- **eBay × market:** price + qty + eBay's offer fields; **no buy-box, no repricer columns.**
- **Shopify (single store, `marketplace = 'GLOBAL'`/`'DEFAULT'`):** price + qty only. Currency comes
  from the store's `Marketplace.currency`, exactly as for a market channel — the single-store case is
  one row of the same table, not a special case.
- **FBA rows:** `Qty` is **read-only with a reason**. Amazon owns FBA stock, and pushing a merchant
  quantity is precisely what flips an FBA offer to FBM (`outbound-sync.service.ts:308-317`,
  `flat-file.service.ts:2905-2919`). This is inside the FBA-quantity untouchable: the studio *reads*
  and *explains*, and changes no FBA logic.
- **Amazon EU shared quantity:** where the account is Pan-EU, one quantity backs several markets. The
  `Qty` cell's tooltip must say so on those markets. The sheet must never present per-market
  quantities as independent.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance.** `🔗 inherited` when `followMasterPrice = true`; `✎ pinned` after any price write
  (the write sets the flag — `product-channel-data.routes.ts:170`); `⚠` on sale ≥ regular or an
  expired window; **`✦ AI draft` never** — no AI touches money.
- **A repricer-moved price is a fourth provenance, and it is new.** When `PriceChangeEvent.source =
  REPRICER` is more recent than the operator's own write, the cell needs a distinct mark (a small `↻`)
  with a tooltip naming the rule and time. Without it the operator sees a number they did not type and
  has no way to learn why. Recommend adding it to the engine's provenance set rather than inventing a
  local badge.
- **Autosave.** Every price/qty/sale cell goes through the ONE SheetWriter with `expectedVersion`
  (the *listing's* version — `sheet-rows.service.ts:67`, not `Product.version`). Money edits are
  exactly where an in-flight autosave undoing a revert hurts most, so the nav guard and the delayed
  re-read both apply.
- **Readiness.** One server definition (`readiness.service.ts`) already feeds chips, bands and rows —
  and it currently says **nothing about price** (`grep price` → 0 hits). Additive: a listing with no
  resolvable price is not publishable, so `missing-price` belongs in the readiness verdict as a
  required-field miss, surfacing in the existing `Missing required (N)` chip. **Buy-box loss is NOT a
  readiness failure** — it is a market outcome, and putting it in readiness would make the chip
  un-actionable.
- **Publish.** Price changes ride the existing per-channel publish (preflight-first, dry-run default,
  mode from `getAmazonPublishMode()`). Two things the preflight **must** say, because §5 items 8 and 9
  make them true: (a) sale price and window are **not carried** by the current push path, and (b) a
  price-only push **replaces the whole `purchasable_offer` slot** and will clear an existing sale price
  on Amazon. Until PES.5 widens the payload, the sale-price cells ship **read-only with that reason in
  the tooltip** — visible, honest, and not a write we cannot deliver.

### 6.6 ASCII mockup

```
 SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]    Market [IT ▾] Locale [it ▾]
 7 rows · 1 selected  [View ▾][Missing required (2)]  Find…   [Refresh buy-box] [Export ▾]
┌──────────────────────┬─────────┬──────────┬──────────────┬──────┬─────┬─────────┬──────────┬─────────┬──────────┬──────────────────────────┐
│ PRODUCT              │ Price   │ Sale     │ Sale window  │ Save │ Qty │ Buy box │ BB price │ Δ ours  │ BB check │ Repricer                 │
├──────────────────────┼─────────┼──────────┼──────────────┼──────┼─────┼─────────┼──────────┼─────────┼──────────┼──────────────────────────┤
│ ▾ ① ASIN B0C7… ACTIVE│         │          │              │      │     │ ○ lost  │ € 194,00 │         │ 4h ago   │                          │
│   ▪ GALE-KAN-PRO-M   │€ 199,00✎│ € 179,00 │ 1 Nov→30 Nov │ −10% │  12 │         │          │ +€ 5,00 │          │ Beat lowest −2% ·        │
│                      │         │          │              │      │     │         │          │         │          │  199,00→194,90 applied   │
│   ▪ GALE-KAN-PRO-L   │€ 199,00🔗│         │              │      │   4 │         │          │ +€ 5,00 │          │ no rule                  │
│   ▪ GALE-KAN-PRO-XL  │€ 209,00✎│ € 219,00⚠│ 1 Nov→30 Nov │  ⚠   │  0⚠ │         │          │ +€15,00 │          │ Beat lowest −2% · paused │
│ ▾ ② ASIN B0D1… DRAFT │         │          │              │      │     │ No obs. │ No obs.  │         │ never    │                          │
│   ▪ GALE-KAN-PRO-S   │  —      │          │              │      │  🔒 │         │          │         │          │ no rule                  │
└──────────────────────┴─────────┴──────────┴──────────────┴──────┴─────┴─────────┴──────────┴─────────┴──────────┴──────────────────────────┘
 7 rows · autosave ✓ · Type or Enter to edit · 🔒 Qty is Amazon-managed (FBA)
```

## 7. Contracts and data

**Reused unchanged**
- `GET /api/pricing/price-history?productId=&channel=&marketplace=` — already returns the timeline
  **and** a per-coordinate sparkline series. The drawer chart needs no new endpoint. *(PES.4)*
- `POST /api/pricing/refresh-competitive { marketplace }` — the `Refresh buy-box` verb. *(PES.3)*
- `GET /api/marketplaces/grouped` — already returns whole `Marketplace` rows including `currency`,
  `vatRate`, `taxInclusive` (`marketplaces.routes.ts:195-208`). **No server change for currency.**

**Client-only, additive**
- Widen `MarketplaceLite` (`_studio/types.ts:69-75`) with `currency: string` and keep it through
  `flattenGrouped` (`studio-data.ts:98`) into `useStudioScope`. Then **delete** the hardcoded EUR in
  `drawer/panes/ListingsPane.tsx:30` and format every money cell from the scope's currency. *(PES.1
  owns `types.ts`; PES.4 owns the pane.)* **S.**

**Server changes needed** *(PES.5)*
1. **Extend `GET /products/:id/sheet/channel` rows with `salePrice`, `saleFrom`, `saleTo`, `currency`
   and `followMasterPrice`.** `sheet-rows.service.ts:374-376` selects neither salePrice nor the
   snapshot; the sale window has to come from
   `flatFileSnapshot['purchasable_offer__sale_from_date' | '__sale_end_date']` until a real column
   exists. **M.**
2. **Add the offer fields to the write layer.** `CHANNEL_FIELD_MAP` (`channel-field-map.ts:23`) gains
   `amazon_price → price`, `amazon_salePrice → salePrice`, `amazon_quantity → quantity` (+ `ebay_*`),
   `FOLLOW_FLAG_FOR_COLUMN` gains `price → followMasterPrice` and `quantity →
   followMasterQuantity`, and `CHANNEL_WRITABLE` (`studio-sheet.service.ts:462`) mirrors it. This is
   the single change that turns 10 read-only cells into a working offer editor. Per the
   producer-and-consumer rule it lands **with** the columns. **M.**
3. **Repair `PATCH /channel-pricing`, or route the studio's price writes through
   `PATCH /api/products/bulk` instead.** *Recommend the latter* — one writer, `expectedVersion`, the
   version bump and the audit trail all already exist there, and #6.3's autosave story assumes it. Then
   `/channel-pricing` keeps serving the old Matrix tab and stops being a second money write path. If it
   must stay, its `Promise.allSettled` + unconditional `ok:true`
   (`product-channel-data.routes.ts:207-209`) is a defect on its own and should be fixed regardless.
   **M.**
4. **Write a `PriceChangeEvent` on every manual price write** (`recordPriceChange`,
   `price-history.service.ts:87`, `source: MANUAL_OVERRIDE`, `currency` from `Marketplace.currency`).
   Today only the repricer, the promo scheduler and bulk-override do — the operator's own edits are
   missing from the very history the drawer will show. **S.**
5. **Carry `aliasKey` on any per-listing price write** — every current writer hardcodes `''`. **S.**
6. **Move `GET /products/:id/buybox` under a pricing/repricing permission**, or add a manifest entry
   for it: it is money data currently readable with `products.view` alone. Also **drop the phantom
   `decidedPrice`** from the client type. **S.**
7. **Emit `sale_price` (with `start_at`/`end_at`) in `outbound-sync.service.ts:305`** and in the
   batch feed, and make `patchListingPrice` **read-modify-write** the offer instead of replacing it
   (`amazon-sp-api.client.ts:735-748`). Until this lands, sale-price cells stay read-only. **L**, and
   the gating dependency for the whole sale-price half.

**Additive schema (only if the Owner wants a per-listing sale window)**
`ChannelListing.saleFrom DateTime?` + `saleTo DateTime?` — nullable, additive, pre-approved class. It
removes the flatFileSnapshot dependency in change 1 and gives the window a store that is not a JSON
blob the flat-file editor owns. **S.**

**Lane split:** PES.3 columns + verb + cells · PES.2 the money/compound cell shapes and the derived
column in the engine · PES.4 the drawer Pricing section + the pane's currency fix · PES.5 all seven
server items · PES.1 `MarketplaceLite` · DS.1 the chart component. PES.6 (mapping), PES.7 (images),
PES.8 (AI) not involved.

## 8. Risks and traps

1. **A price is a live listing.** Local dev writes the PRODUCTION database and the fixture family's
   Amazon offers are real. No price write may be exercised from a local dev session, and the sheet's
   own blur commits — endpoint safety is not interaction safety. Any verification of these cells is a
   *read* plus a mutation test on the pure column/routing function, never a typed value.
2. **The `patchListingPrice` `replace` (§5.9).** The most dangerous coupling in this feature: a
   price-only push clears the sale price on Amazon. Ship sale price read-only until change 7 lands.
3. **The publish mode must come from the server** (`getAmazonPublishMode()`), never re-derived from
   env, and an *unrecognised* mode must not read as open (P4-2).
4. **FBA quantity is untouchable.** Read and explain; change nothing.
5. **Amazon EU shared quantity.** Per-market quantity cells must not imply independence on a Pan-EU
   account.
6. **Oversell is per-channel.** Never sum a quantity across channels or aliases
   (`ChannelSheet.tsx:917`, `ListingsPane.tsx:141`).
7. **The buy box belongs to the coordinate.** Repeating a coordinate value down variant rows, or
   joining by array index, is #321/#322's exact defect.
8. **Every buy-box number is null today** (#324). The columns must be honest at 0 rows — and
   "No observation" ≠ "Not set" ≠ "hidden by permission" (three absences, §5.13). A vacuous PASS on an
   empty table is the dangerous green here.
9. **Flat-file editors are untouchable.** `purchasable_offer__*` keys are their vocabulary; the studio
   reads them, never rewrites their assembler. Note `purchasable_offer__our_price` and `__sale_price`
   are LIVE-OVERLAY keys, refused from the snapshot
   (`flat-file/listing-content-write.service.ts:38`) — writing them there throws by design.
10. **Currency is a selector, not a value.** `ALWAYS_SELECTORS` in `channel-specs/amazon.ts:38` is
    `{marketplace_id, language_tag}` — **`currency` is not in it**, though the type's own comment
    (`channel-specs/types.ts:101`) says selectors are "(marketplace_id, language_tag, currency)". So
    under §A.3a's no-exclusions rule `purchasable_offer.currency` **would become an authored,
    editable column**. It must be added to `ALWAYS_SELECTORS`, or the sheet will offer an operator a
    typeable currency cell — and a currency typed per row is an unbookable order.
11. **No AI anywhere near money.** Not a placeholder, not a dark control.

## 9. Open questions for the Owner (3)

1. **Does sale price ship read-only, or not at all, until the push path carries it?**
   *Recommend read-only with the reason in the tooltip.* AM.1 §A.3a is explicit that a column "reads
   and writes the same store that surface uses… it never hides the column", and
   `sheet-columns.service.ts:483` already has the honest-read-only pattern with a stated reason.
   Hiding it would make the studio quieter and less true than the flat-file grid beside it.
2. **Per-listing sale window as two new nullable `ChannelListing` columns, or keep reading the
   flat-file snapshot?** *Recommend the two columns* (additive, pre-approved class). The snapshot is a
   verbatim blob another editor owns; a window read from it is a value the studio cannot write without
   reaching into that editor's store.
3. **Should the price cell show a distinct provenance mark when the repricer moved it?**
   *Recommend yes* — a fourth mark `↻` in the engine's provenance set, tooltip naming rule and time.
   An operator seeing a number they did not type, with no explanation, is the honest-UI failure this
   whole surface exists to avoid. This also answers #322's open question in the narrow case: per-alias
   prices are not needed, but per-alias *attribution of a change* is.

## 10. Effort and dependencies

| Piece | Lane | Effort |
|---|---|---|
| Money + compound-window cell shapes, derived `Save %` column, status-column renderer | PES.2 | **M** |
| Ten columns on the Amazon scope + eBay/Shopify narrowing + alias-band placement | PES.3 | **M** |
| `refresh-buybox` verb (row + toolbar) with preflight/confirm | PES.3 | **S** |
| Drawer `Pricing` section (KeyValue + MetricStrip + decisions grid) | PES.4 | **M** |
| Price-trend chart | DS.1 | **S** (additive prop) / **M** (new component) |
| `MarketplaceLite.currency` + kill the hardcoded EURs | PES.1 / PES.4 | **S** |
| Sheet-channel payload: salePrice, window, currency, followMasterPrice | PES.5 | **M** |
| `CHANNEL_FIELD_MAP` + follow-flag + `CHANNEL_WRITABLE` offer entries | PES.5 | **M** |
| Route price writes through `PATCH /products/bulk`; `PriceChangeEvent` on manual writes; `aliasKey` | PES.5 | **M** |
| `outbound-sync` sale_price + read-modify-write `patchListingPrice` | PES.5 | **L** |
| `currency` → `ALWAYS_SELECTORS`; buybox permission; drop `decidedPrice` | PES.5 | **S** |
| `missing-price` in the readiness verdict | PES.5 | **S** |

**Dependencies.** The columns cannot be editable before the write-layer entries exist (producer and
consumer land together). The sale-price half is gated on the outbound change. The drawer chart is
gated on DS.1. Buy-box columns are shippable **now** and correct at zero rows — but the collection gap
(#324) is an **Owner item outside PES**: without it, five honest columns will read "No observation"
forever. Shares the `Refresh buy-box` verb pattern with the channel-pull features, the money-cell
shape with feature "eBay volume pricing / best offer", and the readiness hook with the
missing-required chip.
