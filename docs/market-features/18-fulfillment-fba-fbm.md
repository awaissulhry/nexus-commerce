# 18 — FULFILLMENT method (FBA / FBM / MCF) resolution and setting, per market and per variant

## 1. What it is (one paragraph, in operator terms)

For every (product-or-variant × channel × market) coordinate the operator decides **who ships it**:
Amazon out of FBA stock, or us out of our own warehouse (FBM); on eBay the same switch means
"warehouse" vs "Amazon ships it for me" (MCF). The choice is not cosmetic — it **re-points the stock
pool that backs the published quantity** (`docs/FULFILLMENT-PER-CHANNEL.md`: FBM → warehouse
`StockLevel.available`; FBA → `FbaInventoryDetail` SELLABLE for that sku+market), it decides whether
we may push a quantity to Amazon at all (the fail-closed FBA guard), and it decides whether an eBay
order auto-submits an Amazon fulfilment order. Who uses it: the listing/inventory operator, at two
moments — onboarding a family onto a market ("these 24 variants go FBA on IT, FBM on DE"), and
converting a live family the other way after FBA stock runs out. Today they do it one variant at a
time on the Matrix tab, or once per market on the two cockpit cards.

## 2. Old UI — inventory

**A. Amazon cockpit — `FulfillmentCard`** (`apps/web/src/app/products/[id]/edit/tabs/amazon-cockpit/fulfillment/FulfillmentCard.tsx`)
- Deliberately **READ-ONLY** (its own header comment: "changing fulfilment re-routes inventory, so
  edits happen in the classic field editor (jump button) / Stock app, not inline").
- One `GET ${backend}/api/products/:id/channel-inventory?channel=AMAZON` on mount (`:88`), re-run on
  a manual retry key. Shows: method badge (FBA "managed by Amazon" / FBM "merchant" / not set),
  condition (passed in from the cockpit), a stock line (FBA → "managed by Amazon" + listed; FBM →
  on-hand / listed / buffer), and a **mixed-fulfilment warning** with an `n FBA · m FBM` breakdown
  when children on this market disagree (`:118-127`).
- Resolution precedence in the browser (`:107-108`): `fulfillmentMethod` (operator-set) →
  `fulfillmentChannel` (ingested) → `seedFulfillment` (composed listing) → `normalizeMethod(productFulfillment)`.
  **A fourth, browser-local copy of a rule the server already owns** — see §5.
- Round-trips: the one GET. Nothing browser-local, no localStorage. `onJumpToClassic` is a callback.

**B. Matrix tab — the only WRITE surface for per-variant × per-market** (`tabs/MatrixTab.tsx`, 2,076 lines)
- `FulfillmentCell` (`:205-245`): a compact `FBA|FBM` segmented pair per child row for the selected
  market. Active segment = resolved method; **italic = `source: 'derived'`** (not yet persisted),
  with a tooltip saying "click to set explicitly". Header at `:1332` carries the whole rule as a
  `title` attribute.
- `getFulfillment(variantId, market)` (`:440-448`) recomputes ATP client-side from the raw pools the
  endpoint ships (`warehouseAvailable` / `fbaSellable` less `buffer`) so the toggle repaints without
  a refetch. **A fifth copy of `computeAvailableToPublish`** — see §5.
- `patchFulfillment` (`:546-580`): optimistic set, then
  `PATCH /api/products/:id/fulfillment` with `{updates:[{variantId, marketplace, channel:'AMAZON', fulfillmentMethod}]}`;
  rolls back method **and** source on failure.
- **Bulk set on a selection** — `bulkSetFulfilment(method)` (`:1018-1028`), buttons at `:1257`/`:1259`.
  It is `Promise.all(targets.map(patchFulfillment))` — **N separate HTTP requests**, one per variant,
  although the endpoint takes a batch (`updates[]`). Not a queue, no preflight, no confirm.
- Adjacent "Avail." column (`:905-915`) flags oversell locally: `listed > f.atp`.

**C. eBay cockpit — `FulfillmentMethodCard`** (`tabs/ebay-cockpit/cards/FulfillmentMethodCard.tsx`, 216 lines)
- Two big radio-ish cards, **FBM ↔ MCF**, product-level for the active market. `GET …/channel-inventory?channel=EBAY`
  (`:47`), `PATCH …/fulfillment` with `fulfillmentMethod: next === 'MCF' ? 'FBA' : 'FBM'` (`:76-84`) —
  i.e. **MCF is stored as `FBA` on a merchant channel**. Reloads after save to true up ATP for the
  new pool. Shows `availableToPublish` + which pool, and an **oversell banner** when
  `listedQty > available` (`:196`).
- Falls back to `markets[0]` when the active marketplace has no row (`:52`) — a silent
  wrong-coordinate read, not an empty state.

**D. `ChannelInventorySection`** (`tabs/ChannelInventorySection.tsx`, 243 lines) — a variant × market
table (listed qty · physical · buffer · status · synced), collapsible per variant, sortable, `channel`
prop defaulting to AMAZON. Refetches on the `channel-pricing.updated` invalidation channel (`:98`).
**Its local `MarketInventory` type (`:15-22`) has DRIFTED**: it declares 6 fields, the endpoint sends
16 — `fulfillmentMethod`, `fulfillmentSource`, `availableToPublish`, `pool`, `isMcf`, `drift`,
`oversold`, `warehouseAvailable`, `fbaSellable`, `pendingReserved` are all invisible to it. So the
one table that would naturally show fulfilment shows none of it.

**Nothing here is DEAD** — all four surfaces have live importers and a live endpoint.

## 3. Backend that exists

**Routes**
| Method | Path | file:line |
|---|---|---|
| GET | `/api/products/:id/fulfillment` (FCF.1 — per channel×market method, source, pool, ATP, `isMcf`, `drift`) | `apps/api/src/routes/products.routes.ts:556` |
| GET | `/api/products/:id/channel-inventory?channel=` (FCF.4b — the same, batched per variant × market, + raw pools) | `apps/api/src/routes/product-channel-data.routes.ts:220` |
| PATCH | `/api/products/:id/fulfillment` (set/clear `ChannelListing.fulfillmentMethod`) | `apps/api/src/routes/product-channel-data.routes.ts:385` |
| GET | `/api/stock/pool-drift` (portfolio oversell triage, worst first) | doc §Endpoints |

**Resolution, server-side** (`product-channel-data.routes.ts:289-303`, mirrored at `products.routes.ts:609-618`):
persisted `ChannelListing.fulfillmentMethod` ⇒ `source:'listing'`; else `source:'derived'` and
merchant channels (`MERCHANT_CHANNELS`, `:33` — EBAY/SHOPIFY/WOOCOMMERCE/ETSY) → `FBM`, Amazon →
`normalizeFulfillment(platformAttributes)` (`:23-29`, flat `pa.fulfillmentChannel`, AFN/MFN) →
`Product.fulfillmentMethod` → `FBM`.

**Services**
- `services/available-to-publish.service.ts` — `computeAvailableToPublish` is **pure**:
  `available = max(0, poolQuantity − pendingReserved − max(0, stockBuffer))`, returns
  `{available, pool, poolQuantity, reservedApplied, bufferApplied}`. Also `planFollowingQtyClamp` /
  `clampFollowingQtyRowsForFeed` (feed-path pool clamp for Following FBM rows).
- `services/amazon-mcf.service.ts` (`getPendingMcfReservedByProduct`, `createMCFShipment`,
  `resolveMcfAdapter`), `services/ebay-auto-mcf.service.ts` (`autoSubmitMcfForEbayOrder`).
- `services/outbound-sync.service.ts:338-353` — **`isFbaListing()`, the fail-closed FBA guard**. Any
  FBA signal (listing method, `fulfillment_availability[0].fulfillment_channel_code` starting
  `AMAZON`, `Product.fulfillmentMethod`, FBA stock on hand, active FBA offer) ⇒ FBA ⇒
  `buildAmazonListingPatch` strips the quantity. **Untouchable** (memory `feedback_fba_quantity_untouchable`).
- `services/fba-restore.service.ts:117` — PATCH `/attributes/fulfillment_availability` back to FBA.

**Prisma** — `ChannelListing.fulfillmentMethod FulfillmentMethod?` (`schema.prisma:1445`, with the
FCF.1 comment at `:1438-1444`), `ChannelListing.stockBuffer` (`:1436`), `.quantity` (`:1486`),
`.platformAttributes` (`:1493`), `.overrideData` (`:1520`). `Offer.fulfillmentMethod` (`:2168`,
unique per `(channelListingId, fulfillmentMethod)`). `StockLevel.available`, `FbaInventoryDetail`.
🔴 **`Product` carries the concept TWICE**: `fulfillmentMethod` (`:119`) and `fulfillmentChannel`
(`:257`), both `FulfillmentMethod?` — see §5.

**Jobs/crons** — `jobs/fba-flip-guard.job.ts` (every 10 min; raw SQL detector for a SUCCESSful
merchant `QUANTITY_UPDATE` against any FBA signal; detection-only; opt out
`NEXUS_ENABLE_FBA_FLIP_GUARD=0`), `jobs/fba-drift-detector.job.ts`, `jobs/amazon-qty-readback.job.ts`
(skips rows whose `fulfillmentChannel` matches `/^amazon/i`), `jobs/amazon-mcf-status.job` (15 min).

**External-call safety gates** — none of the three fulfilment endpoints calls a channel. Real-API
gates live downstream: `AMAZON_MCF_LIVE=1`, `AMAZON_MCF_SANDBOX=1`, `NEXUS_EBAY_AUTO_MCF=1`,
`NEXUS_ENABLE_MCF_STATUS_CRON`, plus `NEXUS_OVERSELL_CLAMP` / `NEXUS_SYNC_ORDERING_V2` on the
outbound quantity path (`outbound-sync.service.ts:930-956`).

**Permissions** — no fulfilment-specific rule. All three paths fall through to
`RW(F.productsView, F.productsEdit, pfx('/api/products'))` (`lib/auth/permissions-manifest.ts:412`).
So **`productsEdit` alone re-routes inventory**; the inventory permissions
(`F.inventoryView` / `F.inventoryAdjust`, `:297`/`:303`) gate only `/api/fulfillment/**`.

## 4. Studio today

**Zero coverage.** `grep -i 'fulfillment|FBA|FBM' _studio/**` returns **nothing** — no cell, no
column, no verb, no drawer section.

- The channel sheet's own column set has no fulfilment field: neither adapter declares one.
  `channel-specs/amazon.ts` — `fulfillment_availability` yields exactly four leaves
  (`__quantity`, `__restock_date`, `__is_inventory_available`, `__lead_time_to_ship_max_days`),
  asserted at `channel-specs/__tests__/channel-specs.test.ts:151-162`. `channel-specs/ebay.ts:110`
  has `fulfillmentPolicyId` (a shipping *policy*, not the method) and nothing else.
- The reason is in Amazon's own schema, and it is measurable:
  `fulfillment_availability` declares **`selectors: ['fulfillment_channel_code']`**
  (fixture `__tests__/fixtures/amazon-it-outerwear.trimmed.json`), so the walker strips the code as a
  facet key at `amazon.ts:153`, and the keyed-set fallback at `:157` does not fire because four other
  leaves remain. `fulfillment_channel_code` is `editable: true` with `enum: ['AMAZON_EU','DEFAULT']`
  — an authorable value the adapter cannot reach.
- Master scope DOES have a "Fulfillment" select column — but the wrong field. `field-registry.service.ts:96`
  declares `{id:'fulfillmentChannel', label:'Fulfillment', type:'select', options:['FBA','FBM'], category:'inventory'}`,
  and hub ruling **#202** measured it on the live contract ("`fulfillmentChannel` (FBA·FBM)" among the
  six `mode:'open'` columns AG.1 treats as strict). It lands in group **Inventory**
  (`sheet-columns.service.ts:239-253`).
- Listing-only columns exist as a shape but are **read-only by design today**:
  `sheet-columns.service.ts:480-483` sets `editable: !listingOnly` with the comment "its write route
  lands with AM.1 phase 2", and `:459` skips listing-only fields on the master scope.
- The engine already has everything the cell needs: `SelectCellEditor` / `SelectPanelEditor`,
  fill-handle + paste routed through the one writer (`sheet/channel/rows.ts:151` `isOperatorEdit` is a
  **deny-list** — `'fillHandle'`, `'paste'`, `'undo'` all reach the server; ruling #53), the
  `affectsAllChannels` acknowledgement bar (`ChannelSheet.tsx:518-548`, ruling #58 BINDING), a
  SELECTION scope in the action registry (`channelActions.ts:310`, `master/FamilySelectionBar.tsx`),
  and `SheetToolbar` `leading`/`trailing` slots (`SheetToolbar.tsx:92,94`).
- 🆕 A concurrent lane just added the exact extension point: `AMAZON_LISTING_STORES`
  (`channel-specs/amazon.ts:57-59`, applied at `:100-101`) maps an attribute to
  `{kind:'listingColumn', column:'variationTheme'}`.

**Parity audit** — 3.26 🕳 ("no FBA/FBM resolution view. `ChannelListing.fulfillmentMethod` is not a
sheet column today", `docs/pes-parity-audit.md:148`) · 3.45 🕳 (`:171`) · 6.4 🕳 MISSING (master) →
PES.3, "flagging rather than claiming: no studio surface owns it yet" (`:365`) · 6.8 🕳 (`:369`).
Summarised again at `:24177` of `docs/pes-claims.md`: "Fulfilment FBA/FBM (6.4, 6.8) — belongs to a
channel listing; flagged for PES.3 rather than claimed."

**Hub rulings that bind**
- **D1 (swap-scope review, `docs/pes-claims.md:20970`)** names "the unowned FBA/FBM toggles"
  explicitly as part of the channel-operations surface question. **Undecided by the Owner.** My
  report feeds it.
- **#202** — no master select column accepts free text; all 26 are strict, `fulfillmentChannel` named.
- **#58** (BINDING) — a channel-scope cell that writes master must be acknowledged once per coordinate.
- **#53** — edit-source deny-list, so a fill/paste is a real write.
- **D4** — the studio added no new mutation paths; `PATCH /api/products/bulk` routes only six field
  names to a `ChannelListing`, so any other channel write keeps its own endpoint.

## 5. Defects and slowness

1. 🔴 **`Product.fulfillmentChannel` is a decided duplicate that the studio's master sheet still
   edits — and almost nothing reads it.** `schema.prisma:119` vs `:257`. The flat-file registry
   already ruled it out: `services/flat-file/registry/master-fields.ts:8` and `:272` —
   "`fulfillmentChannel` — F15 duplicate of `fulfillmentMethod`; excluded" — with a test asserting
   its absence (`flat-file/__tests__/census-coverage.vitest.test.ts:24`). But
   `services/pim/master-field-gate.ts:42` whitelists **`fulfillmentChannel` and not
   `fulfillmentMethod`**, and `products.routes.ts:1666` validates it. So the studio's master
   "Fulfillment" cell writes a column that `isFbaListing()` does not read
   (`outbound-sync.service.ts:349` reads `product.fulfillmentMethod`) and that the channel-inventory
   derivation does not read (`product-channel-data.routes.ts:302`). Exactly one reader falls back to
   it: `stock.routes.ts:325` (`p.fulfillmentMethod ?? p.fulfillmentChannel`). **CODE-READ.**
2. 🔴 **Two platformAttributes stores for one fact.** `PATCH …/fulfillment` writes the FLAT
   `pa.fulfillmentChannel = 'AFN'|'MFN'` (`product-channel-data.routes.ts:410-411`) and the reads use
   it (`:23-29`); the FBA guard reads the NESTED
   `pa.fulfillment_availability[0].fulfillment_channel_code` (`outbound-sync.service.ts:343-345`),
   which is what the Amazon pull writes (`services/amazon/flat-file-pull-preview.service.ts:247`).
   Consequence: setting FBM through the endpoint leaves a stale nested `AMAZON_*` code, so the cell
   would read **FBM** while the push guard still (correctly, fail-closed) reads **FBA** and drops the
   quantity. A cell that shows the field rather than the guard's verdict would be dishonest. **CODE-READ.**
3. 🔴 **The doc's step-2 "ingested signal" is a self-echo.** Nothing in `apps/api/src` writes
   `platformAttributes.fulfillmentChannel` except `PATCH …/fulfillment` itself (grep: only
   `product-channel-data.routes.ts:410-411`). Amazon ingest writes `Product.fulfillmentChannel`
   (`amazon-sync.service.ts:164,180,221,…`) and the nested flat-file key. Since the endpoint also
   writes the typed `fulfillmentMethod` column, checked first, the `normalizeFulfillment` branch is
   effectively dead for real ingest. **CODE-READ.**
4. 🔴 **`PATCH …/fulfillment` reports success it did not verify.** `await Promise.allSettled(ops)` then
   `reply.send({ ok:true, updated: updates.length })` (`:431`, `:465`). A rejected upsert is
   swallowed; the response is the *request* count, not the write count. Same shape at `:208-209` for
   channel-pricing. (Memory: a write's RESPONSE is not what it wrote.) **CODE-READ.**
5. **N+1 on the only bulk path.** `bulkSetFulfilment` fires one request per variant
   (`MatrixTab.tsx:1023`), and each request then does, per update: a `findUnique`, an `upsert`, a
   `product.updateMany`-or-`findUnique`, and on the FBM branch three more parallel queries
   (`:435-460`). 24 variants ≈ 24 requests × ~5 queries. **CODE-READ.**
6. **`computeAvailableToPublish` has five call sites and two browser re-implementations.** Server:
   `products.routes.ts:618`, `product-channel-data.routes.ts:305`, `outbound-sync.service.ts:947`,
   `available-to-publish.service.ts:80`. Browser: `MatrixTab.tsx:440-448` and the
   `FulfillmentCard.tsx:107-108` precedence chain. Both browser copies omit `pendingReserved`
   handling for the FBM branch and neither knows about the FBA-guard override. **CODE-READ.**
7. **`ChannelInventorySection`'s wire mirror has drifted** (`:15-22`, 6 declared vs 16 sent) —
   the fulfilment half of its own endpoint is invisible. **CODE-READ.**
8. **eBay card silently reads the wrong coordinate** when the active market has no row:
   `?? markets[0]` (`FulfillmentMethodCard.tsx:52`). **CODE-READ.**
9. **No test asserts the resolution precedence end to end.** The unit tests cover
   `computeAvailableToPublish` and `isFbaListing` (`outbound-sync.vitest.test.ts:155-158`); grep finds
   no test for the four-step derive chain in either route, nor for the SCT.6d product-flag
   conversion at `:435-460`. **CODE-READ.**
10. **Two column builders** (`master/columns.tsx`, `channel/ChannelSheet.tsx`) — memory
    `reference_two_column_builders_drift`: a fulfilment cell written into one is silently absent from
    the other. Must land in `design-system/grid` and be spread by both, with a reading in
    `scripts/check-editor-open.mjs --strict` parity block. **MEASURED-IN-DOC.**
11. 🔴 **Amazon's fulfilment attribute is not market-scoped, and it is measurable.** In the trimmed
    IT/OUTERWEAR fixture, `fulfillment_availability` is one of only **2 of 26** properties whose
    `selectors` do not include `marketplace_id` (the other is `variation_theme`), and its FBA enum
    value is literally **`AMAZON_EU`** — a region code, not a market code. This is the schema-level
    corroboration of the proved EU shared-quantity behaviour (memory
    `reference_amazon_shared_eu_quantity`: zeroing DE zeroed IT). ⚠ Caveat per
    `reference_a_fixture_pins_a_dimension`: the fixture holds 26 of the real 109 properties, so the
    2/26 denominator is the fixture's, not the live schema's — the *presence* of the selector list on
    this attribute is exact, the ratio is not. That the METHOD (not just the quantity) is region-wide
    is a **HYPOTHESIS**, strongly schema-backed, unmeasured against live SP-API.

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY: H1 — a select cell (`Fulfilment`) on the channel scope, per variant row, in the
`Inventory` column group.** This is the Owner's own test: fulfilment is a value the operator *edits
per row*, per coordinate, from a closed two-item enum — the textbook H1. It is already shaped that
way in the old UI (a per-row segmented FBA|FBM toggle in a spreadsheet, `MatrixTab.tsx:205`), and
"one concept, one column" (AM.1 §A.3a) says the surface that owns Inventory reads and writes **the
same store** — here `ChannelListing.fulfillmentMethod`, the field `PATCH …/fulfillment` already
owns. It belongs on the **channel** scope only, because the value is per channel × market:
`sheet-columns.service.ts:459` already skips listing-only fields on master, which is the correct
behaviour for free.

**MIRROR 1: H2 — a read-only `Available` status column beside it.** The cell at rest must not
pretend the method is the whole story; the number that follows from it (`availableToPublish` + which
`pool`) is a *derived channel fact* with a mark and a tooltip, which is H2 by definition. It carries
the oversell mark (`oversold`/`drift`, already computed server-side) and is filterable, so "show me
every row publishing more than its pool can back" is a view chip rather than a new page.

**MIRROR 2: H7 — an `Inventory` section in the record drawer, per market.** One row's method for
**every** market at once, with the pool arithmetic spelled out (`poolQuantity − pendingReserved −
buffer = available`), the `isMcf` fact, the FBA-guard verdict, and the `stockBuffer` editor. The
sheet shows one coordinate; the cross-market view is depth, and depth is the drawer. This is where
`GET /api/products/:id/fulfillment` (which is already per-channel × per-market for one product) lands
unchanged.

**MIRROR 3: H4 — a `Set fulfilment…` SELECTION verb. Yes, still needed, and this is the one call in
the brief I want to argue against the obvious answer.** Fill-handle and paste already write this cell
(`rows.ts:151` deny-list; ruling #53), so *mechanically* "same value across a selection" is solved
and I would not build a verb for convenience alone. But this write is not an ordinary cell write: it
re-points a stock pool, it can weaken the fail-closed FBA guard, and on Amazon-EU it is very likely
region-wide (§5.11). The COLLECT → PREFLIGHT → CONFIRM → RUN order exists precisely so a dangerous
write gets an impact statement before it runs — and a fill handle has **no preflight seam** (it is a
6×6px drag that AG commits silently; memory `reference_ag_fill_handle_swallows_dblclick`). So the
verb is not a duplicate of fill; it is the only path that can show the preflight. Recommendation:
the verb is the advertised path, and the **fill/paste path routes through the same preflight** —
`ActionImpact` decides the confirm level, never a fixed flag.

**NOT recommended:** H9 (Errors & Sync). Its queue is `OutboundSyncQueue`-only by design
(`channel-ops/syncQueue.ts:4-8`, "the only source with data"); pool drift is computed from our own
pools and would be a second source with a different row shape. `GET /api/stock/pool-drift` already
has a page (`/fulfillment/stock/pool-drift`); keep portfolio triage there (H11) and keep the
per-row mark on the sheet.

### 6.2 What the sheet shows at rest, per scope

| scope | column | at rest |
|---|---|---|
| **master** | `Fulfilment` (the existing `fulfillmentChannel` select, ruling #202) — **retarget to `Product.fulfillmentMethod`** | the family default, `FBA`/`FBM`/`—`. Tooltip: "the catalogue default; each market's own choice is on the channel scope". Group `Inventory`. |
| **channel × market (Amazon)** | `Fulfilment` select `FBA · FBM` + `Available` (H2) | method + `Available` (e.g. `FBA · 42`). **A derived method renders in the muted/italic provenance treatment**, not as a value the listing holds — that distinction (`source: 'listing' \| 'derived'`) is the single most useful thing the old cell did (`MatrixTab.tsx:238-240`) and it maps exactly onto the existing per-cell provenance marks: 🔗 inherited ≙ derived, ✎ pinned ≙ `source:'listing'`. |
| **channel × market (eBay)** | same column, options `FBM · MCF` (stored `FBM`/`FBA`) | `MCF · 42 · FBA pool`. Derived is **always** FBM on a merchant channel (`MERCHANT_CHANNELS`, `:33`), so an italic FBA can never legitimately appear here — if one does, it is a defect, and the cell should say so rather than paint it. |
| **alias band** | nothing new | the method is per listing, so the band's own row shows the alias's value; child rows show theirs. |
| **Shopify / Woo / Etsy (single-store)** | column present, **honestly not editable** | `FBM` fixed, tooltip "merchant channels are always merchant-fulfilled". `CHANNEL_WRITE_PREFIX` (`studio-sheet.service.ts:471`) has no entry for them, so no write can be expressed at all — say that, do not offer it. |

Marks: `⚠` on `Available` when `oversold`; `⚠` on `Fulfilment` when the family is **mixed** on this
market (the old `FulfillmentCard`'s best idea, `:127` — surface it per family, not per product);
`⚠` when the FBA guard's verdict disagrees with the field (§5.2).

### 6.3 The interaction, step by step

1. **Open** — double-click (or type) on `Fulfilment` opens the DS `SelectCellEditor` via
   `SelectPanelEditor` (`design-system/grid/editors/`), two options, strict (#202). Keyboard:
   `Enter`/type opens, `↑↓` moves, `Enter` commits, `Esc` cancels. ⚠ An AG popup editor owns
   Enter/Tab/Esc (memory `reference_ag_popup_editor_owns_keys`) — design around it, and the React
   editor **must** call `props.onValueChange` (memory `reference_ag36_react_editor_onvaluechange`).
2. **Collect** — one cell, or the current selection when reached from the `Set fulfilment…` verb on
   the selection bar (DS `BulkActionBar`, as `FamilySelectionBar` already does).
3. **Preflight** — one server call returning an `ActionImpact` per target: current method + source,
   the pool each row would move to and its `available`, whether the new method would **drop below the
   published quantity** (oversell), whether `isFbaListing()` would still say FBA after the write
   (§5.2), whether the coordinate is Amazon-EU and therefore region-wide (§5.11), and how many
   sibling markets would be affected.
4. **Confirm** — DS `ActionConfirm`, level from the preflight, never a flag. Three escalations:
   *none* for a derived→explicit no-op change; *confirm* for a plain flip; *typed confirm* for
   `FBA → FBM` on a coordinate with live FBA evidence (that is the flip that can trip the
   `fba-flip-guard` cron), and for any Amazon-EU write while §5.11 is unproved.
5. **Run** — `PATCH /api/products/:id/fulfillment` with **one batched `updates[]`**, not N requests.
6. **Repaints** — the two cells (`Fulfilment`, `Available`) on the written rows, the sibling-market
   rows if the response says the write was region-wide, the readiness pill for the coordinate, the
   family's mixed-fulfilment mark, and the drawer's Inventory section if open. The sheet stays live
   throughout (non-modal drawer, layout-v2 §5); a confirm dialog is the only modal.

### 6.4 Per-scope rules

- **Master** — one default per family; `per_variant` is wrong here (a family default is
  `scope: 'global'`), but the *channel* column must be `per_variant`: the whole point of FCF.4b is
  that variant M can be FBA while variant L is FBM on the same market.
- **Channel × market** — the editable coordinate. Amazon options `FBA·FBM`; eBay `FBM·MCF`.
- **Alias band** — a `CONTEXT(alias-group)` mirror is *not* proposed: fulfilment is per listing and
  the alias band's own row is a listing, so the H1 cell on that row already covers it.
- **Single-store channels** — column visible, not editable, with the reason (§6.2).
- **Clearing** — the endpoint accepts `fulfillmentMethod: null` to fall back to derived. That is
  "reset to inherited" and must be the existing reset-to-follow gesture, not a third option in the
  dropdown.

### 6.5 Provenance / autosave / readiness / publish

- **Provenance** — `source: 'listing' | 'derived'` is a first-class provenance layer the server
  already computes; map it onto the existing marks rather than inventing a third vocabulary.
- **Autosave** — through the ONE `sheetWriter`, but **not** through `PATCH /api/products/bulk`:
  `fulfillmentMethod` is a typed `ChannelListing` COLUMN, and `resolveWriteRouting`
  (`studio-sheet.service.ts:497-537`) would classify `storage:'listing'` as `routesToOverride` and
  merge it into `overrideData.fulfillmentMethod` — **a key nothing reads** (memory
  `reference_channellisting_mapped_fields_are_columns`; the identical bug #758 documents for
  `amazon_title`). Either add a typed-column route (§7) or have the writer dispatch this one column
  to `PATCH …/fulfillment`. Whichever is chosen, the write predicate must be **the same predicate the
  readers use** (memory `reference_write_predicate_must_match_its_readers`).
- **`affectsAllChannels`** — do **not** reuse it. Today it means "shown on a channel, writes master"
  (`studio-sheet.service.ts:169-179`). The EU case is the orthogonal axis: writes ONE listing, Amazon
  applies it region-wide. Recommend a sibling field, e.g. `affectsMarkets: string[]`, with its own
  once-per-coordinate acknowledgement modelled on ruling #58's bar.
- **Readiness** — `services/pim/readiness.service.ts` is the ONE definition. `oversold` is a
  publish-blocking condition ("never publish more than the backing pool holds" is the doc's core
  rule) and should be a readiness issue there, not a second rule in the cell.
- **Publish** — the FBA guard is untouchable and stays the last word. The Amazon publish preflight
  must **read the guard**, not the field, so a row whose cell says FBM but whose guard says FBA is
  reported as a conflict rather than silently having its quantity dropped.

### 6.6 ASCII mockup

```
SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]        Market [IT ▾]
21 rows · 3 selected  [View ▾][Oversold (2)]  Find…      [Customise]
┌──────────────────────┬──────────┬──────────────┬───────────┬─────────┐
│ SKU                  │ Listed   │ Fulfilment   │ Available │ Status  │
├──────────────────────┼──────────┼──────────────┼───────────┼─────────┤
│ ▸ GALE-KAN-PRO       │        — │ ⚠ mixed      │         — │ ● Live  │
│   GALE-KAN-PRO-S     │       12 │ ✎ FBA        │  42 · FBA │ ● Live  │
│ ☑ GALE-KAN-PRO-M     │        8 │ ✎ FBA        │  17 · FBA │ ● Live  │
│ ☑ GALE-KAN-PRO-L     │       31 │ 🔗 FBM       │ ⚠ 6 · WH  │ ● Live  │
│ ☑ GALE-KAN-PRO-XL    │        0 │ 🔗 FBM ▾ ┌──────────────┐│ ○ Draft │
│                      │          │          │ ● FBA        ││         │
│                      │          │          │ ○ FBM        ││         │
│                      │          │          └──────────────┘│         │
└──────────────────────┴──────────┴──────────────┴───────────┴─────────┘
  ✎ set on this listing · 🔗 derived · ⚠ published > pool
┌────────────────────────────────────────────────────────────────────┐
│ 3 selected   [Set fulfilment…▾] [Open record] [Publish preview]    │
└────────────────────────────────────────────────────────────────────┘
```

## 7. Contracts and data

**Reused unchanged** — `GET /api/products/:id/fulfillment` (drawer Inventory section),
`GET /api/products/:id/channel-inventory?channel=` (never used by the studio today; it is already the
batched per-variant × per-market read the sheet needs), `PATCH /api/products/:id/fulfillment`
(batched — send ONE call with N `updates[]`), `GET /api/stock/pool-drift` (portfolio page, unchanged),
`computeAvailableToPublish` (pure, reuse — never re-derive in the browser).

**Server changes, all additive**
1. **PES.5 — a column for the method.** Declare `fulfillment_availability__fulfillment_channel_code`
   as a leaf despite being a selector (an `editable: true` selector with an enum is authorable), and
   give it `{kind:'listingColumn', column:'fulfillmentMethod'}`. The hook now exists:
   `AMAZON_LISTING_STORES` (`channel-specs/amazon.ts:57-59`). ⚠ **It is keyed by ATTRIBUTE name and
   applied to every produced leaf with `path.length <= 1` (`:100-101`)** — declaring
   `fulfillment_availability` there would attach the listing store to all four of its leaves,
   including `__quantity`. Key it by LEAF key, or add a second map. Coverage test at
   `channel-specs.test.ts:154-159` grows one entry, and the eBay adapter needs the same field with
   options `FBM·MCF`.
2. **PES.5 — the write route.** `fulfillmentMethod` must reach its typed column, not the bag: add it
   to `CHANNEL_FIELD_MAP` (`channel-field-map.ts:23`) + `CHANNEL_WRITABLE`
   (`studio-sheet.service.ts:463`), *or* have `sheetWriter` dispatch this one column to
   `PATCH …/fulfillment`. Prefer the first — one write path, `expectedVersion`, per-cell audit row.
3. **PES.5 — a preflight endpoint** returning the `ActionImpact` of §6.3 step 3 for N targets
   (pool move, oversell delta, `isFbaListing()` verdict, region scope). Nothing like it exists.
4. **PES.5 — fix the response honesty** at `product-channel-data.routes.ts:431-465`: count settled
   fulfilments, return `updated` = writes that actually landed, and surface rejections.
5. **PES.5 — a `affectsMarkets: string[]` field on `StudioCellValue`** (§6.5), plus `fulfillmentMethod`,
   `fulfillmentSource`, `availableToPublish`, `pool`, `isMcf`, `drift`, `oversold` on `SheetListing`
   (`sheet-rows.service.ts:50-93`) so the sheet read carries them without a second fetch.
6. **PES.5 — readiness**: `oversold` becomes an issue in `readiness.service.ts`.
7. **PES.5 — permissions**: consider gating the PATCH on `F.inventoryAdjust` in addition to
   `F.productsEdit` (`permissions-manifest.ts:412`); a family verb spanning two permissions is a known
   shape (memory `reference_family_verbs_split_permissions`).
8. **Schema — additive only, and probably none.** No new column is needed. The `Product`
   duplication (§5.1) is a *retarget*, not a migration: point `master-field-gate.ts:42` and the
   field registry at `fulfillmentMethod` and leave `fulfillmentChannel` in place, read-only, until a
   backfill is separately approved.

**Lane ownership** — PES.5 (all of the above server work) · PES.3 (the channel-sheet column, the
`Set fulfilment…` SELECTION verb, the oversell/mixed marks, the view chip) · PES.2 (the master
column's retarget; the shared select/status cell pieces must live in
`design-system/grid/editors/sheetColumn.ts` + `renderers/cells.tsx` and be spread by BOTH builders,
with a reading in `check-editor-open.mjs --strict` — §5.10) · PES.4 (the drawer Inventory section) ·
PES.1 (nothing).

## 8. Risks and traps

1. 🔴 **The FBA→FBM flip is the repo's known catastrophe.** Setting FBM re-opens the quantity push
   path that `isFbaListing()` fail-closes; the 2026-06 incident ran ~2 days and produced a standing
   cron (`fba-flip-guard.job.ts`). The FBA quantity logic is **untouchable** — this feature READS it
   and must never weaken it. The route already contains a deliberate, evidence-gated product-flag
   conversion (`:435-460`, SCT.6d: flips `Product.fulfillmentMethod` to FBM only when no other FBA
   listing, no FBA stock, no active FBA offer, and logs "HELD" otherwise). Preserve that predicate
   verbatim; the studio must not add a second one.
2. 🔴 **Amazon-EU is very likely one method for the whole region** (§5.11). Until measured, treat any
   Amazon write as region-wide in the confirm copy. Never plan per-market suppression via quantity
   (memory `reference_amazon_shared_eu_quantity`).
3. 🔴 **Local dev writes the production database** and eBay fixture listings are LIVE. A blur on a
   fulfilment cell in a local preview would set a real listing's method (memory
   `reference_endpoint_safety_is_not_interaction_safety`). Any browser verification of this cell must
   be planned as a write, not a read.
4. **`PATCH …/fulfillment` sets `syncStatus: 'PENDING'`** (`:420`, `:429`). Grep found no job that
   picks up `ChannelListing.syncStatus === 'PENDING'` and pushes (the queue consumers read
   `OutboundSyncQueue.syncStatus`), so **HYPOTHESIS: this is a status marker only, not an enqueue** —
   worth one confirmation before the verb ships, because "flipping the method silently queued a push"
   is the failure mode nobody would see.
5. **Per-channel oversell is never summed.** `available` is per (variant, channel, market, pool)
   (`ListingsPane.tsx:141` already carries the warning in words). A roll-up column across coordinates
   would be a new oversell bug, not a convenience.
6. **The FBA pool's `pendingReserved` is deliberately conservative** for multi-market FBA: the full
   pending-MCF count is subtracted from *each* market's pool (doc §Reservations). The cell shows a
   number that may be pessimistically low; say so in the tooltip rather than "fixing" it.
7. **AI stays dark** — nothing in this feature is AI-adjacent, so ruling #13 is not engaged.
8. **Untouchables** — the flat-file editors own `fulfillment_availability__*` today
   (`AmazonFlatFileClient.tsx:5034`, `gridAdapter.ts:55`, `group-model.ts:30`). The studio column
   must read/write the same `ChannelListing.fulfillmentMethod` store so the two cannot disagree
   (AM.1 §A.3a), and must not touch those files.
9. **`Available` is a StockLevel roll-up**, not a stored number (memory
   `reference_available_is_the_stock_rollup`) — never cache it in the row payload as truth without
   its `lastSyncedAt`.

## 9. Open questions for the Owner (max 3)

1. **D1 is still open, and this feature is named in it. Does the FBA/FBM control ship as a sheet
   COLUMN (my recommendation) or as a drawer-only per-listing operation?**
   *Recommended answer:* column. It is a per-row enum edited across a selection — the H1 case — and
   channel-ops research §3.2 forbids a verb living only in the drawer. The drawer gets the
   cross-market Inventory section as depth, not as the only home.
2. **Is `Product.fulfillmentChannel` retired from the studio's master sheet?** The flat-file registry
   already excluded it as an F15 duplicate, but the master field gate whitelists it *instead of*
   `fulfillmentMethod`, so the master "Fulfillment" cell today writes a field the FBA guard and the
   channel resolution never read.
   *Recommended answer:* yes — retarget the column to `Product.fulfillmentMethod`, leave the old
   column in the database untouched and read-only. Additive, no migration, and it closes a silent
   no-op. (A backfill is a separate, separately-approved question.)
3. **How dangerous is an `FBA → FBM` flip allowed to feel?** A typed confirm on a coordinate with
   live FBA evidence costs the operator seconds per variant and would make the old bulk button
   (24 variants, one click, no confirm) slower.
   *Recommended answer:* typed confirm ONLY when the preflight finds live FBA evidence or an
   Amazon-EU region scope; plain confirm otherwise; and the confirm is per RUN, not per row, so a
   24-variant selection is one dialog listing the 24.

## 10. Effort and dependencies

| piece | lane | effort |
|---|---|---|
| Adapter leaf + listing store for the method (both channels) + coverage test | PES.5 | **S** |
| Typed-column write route (`CHANNEL_FIELD_MAP` / `CHANNEL_WRITABLE`) + predicate test | PES.5 | **S** |
| `SheetListing` carries method/source/ATP/pool/oversold; response-honesty fix | PES.5 | **S** |
| Preflight endpoint (`ActionImpact`: pool move, oversell, guard verdict, region scope) | PES.5 | **M** |
| `affectsMarkets` + its once-per-coordinate acknowledgement | PES.5 + PES.3 | **M** |
| The H1 cell + H2 `Available` column, engine-owned, spread by BOTH builders + parity reading | PES.2 + PES.3 | **M** |
| `Set fulfilment…` SELECTION verb (registry entry, confirm, run) | PES.3 | **S** |
| Oversold / mixed marks + view chip | PES.3 | **S** |
| Drawer `Inventory` section, per market | PES.4 | **M** |
| Readiness: `oversold` as an issue | PES.5 | **S** |
| Master column retarget to `fulfillmentMethod` (pending Q2) | PES.2 + PES.5 | **S** |

**Dependencies** — AM.1 phase 2's listing-column write path (`sheet-columns.service.ts:480-483`
currently forces `editable: false` on every listing-only column, so the cell is read-only until that
lands); the engine's select-cell shape from the AM.1 shapes work; the action registry's preflight/
`ActionImpact` seam (exists: `grid/actions/registry.ts`, `runAction.ts`, `ActionConfirm.tsx`);
`readiness.service.ts` for the oversell rule. **Blocked on the Owner for D1 (Q1) and Q2.** Nothing
here depends on the images, mapping or AI lanes.
