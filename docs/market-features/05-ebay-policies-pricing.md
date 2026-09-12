# 05 — eBay BUSINESS POLICIES + offer pricing

## 1. What it is (operator terms)

An eBay listing carries a block of *offer-level* terms that are not product content: which of the
seller's three **business policies** (payment / return / shipping-fulfilment) apply, which
**inventory location** ships it, the **listing format** and **duration**, whether **Best Offer** is
on and its auto-accept / auto-decline thresholds, the **handling time**, and the **price rule**
(fixed / match Amazon / percent-of-master). The policies themselves are authored once in eBay Seller
Hub and pulled as *profiles*; per listing the operator only **assigns** one of each. Who uses it:
whoever is getting a family live on a market — a wrong-market policy id is the classic persistent
eBay 25007, and a missing shipping/return policy hard-fails the whole family's publish
(`ebay-variation-push.service.ts:1744-1749`). Also the pricing operator, who sets the eBay price or
the rule that derives it. It is per LISTING (per alias × market), not per variant SKU.

## 2. Old UI — inventory

**Entry point:** eBay cockpit tab → `PricingPoliciesCard` (EC.8), mounted
`tabs/ebay-cockpit/EbayCockpit.tsx:614-647`; the price half also appears in
`ListingEssentialsCard` (EC.2), mounted `EbayCockpit.tsx:513`.

`tabs/ebay-cockpit/cards/PricingPoliciesCard.tsx` (478 lines) — one card, three sections:

| section | control | round-trip |
|---|---|---|
| Pricing & Rule | `FieldSourceRow` (manual/master/default) + DS `Listbox` for the rule + a percent input (`:244-308`) | `POST /api/products/:id/listings/EBAY/:mp/pricing` (`:185-192`) |
| Best Offer | native checkbox + two number inputs (`:316-354`) | `PATCH /api/ebay/cockpit/offer-policies` (`:199-213`) |
| Policies | 3–4 × `PolicySelect` → DS `Listbox`, options = `{id → name}` (`:380-412`, `:450-478`) | same PATCH |

- **Options load:** one `fetch` on mount and on marketplace change, `GET /api/ebay/policies?marketplaceId=EBAY_<MP>` (`:107-135`). No connection id, no refresh control, no retry; on failure it shows the error plus a link to `ebay.com/seller-policy` (`:369-379`).
- **Save is MANUAL and dual-endpoint:** one button (`:427-435`) fires pricing first, then offer-policies, then `router.refresh()`. Dirtiness is a `JSON.stringify` comparison (`:138-160`). No autosave, no `expectedVersion`, no optimistic concurrency. A pricing failure aborts before the policy write — a half-applied save is reachable.
- **The price value is held in a `useRef` buffer** written from inside a render callback (`:168-170`, `:262-266`), read only at save.
- **Browser-local state:** `ListingEssentialsCard`'s title/description/price sources live in `localStorage` (`field-source/FieldSourceProvider.tsx:51,63`); the card's own footer says it "does NOT yet drive the actual ChannelListing payload" (`ListingEssentialsCard.tsx:11-15, 208-213`). So EC.2's price is decorative; EC.8's is the real one.
- **DEAD control (no importer needed — a wire mismatch):** the Inventory-location `PolicySelect` (`:403-411`) is gated on `snapshot.inventoryLocations.length > 0` and seeded from `json.inventoryLocations` (`:125`). `GET /api/ebay/policies` spreads a snapshot whose key is **`locations`**, never `inventoryLocations` (`ebay-account.service.ts:42-47`, `ebay.routes.ts:645-651`). The array is therefore always `[]` and the merchantLocationKey picker **never renders**. CODE-READ.
- Not in this card at all, though the store carries them: `listingFormat`, `listingDuration`, `handlingTime`, `quantityLimitPerBuyer`.
- The same capability, done differently, in the (untouchable) eBay flat-file editor — the best existing SPEC: base columns are plain text (`ebay-columns.ts:514-516`) and the client **rewrites them to `kind:'enum'` with `options`=ids / `optionLabels`=names, only when the fetched list is non-empty** (`EbayFlatFileClient.tsx:1264-1271`), fetching `GET /api/ebay/flat-file/policies` (`:1167`); import canonicalises a typed policy **name** back to its id (`importCoerce.pure.ts:15`, test `importCoerce.vitest.test.ts:68-73`) and groups them as "Business policies" (`importPlan.pure.ts:33`).

## 3. Backend that exists

**Routes**
- `GET /api/ebay/policies?marketplaceId=&connectionId=&refresh=1` — `routes/ebay.routes.ts:618-660`. Wraps the Account API snapshot; `refresh=1` bypasses the cache. Falls back to the primary EBAY connection when no `connectionId` (MAP.3, `:629-638`). Only consumer in the whole web app is the dead card — the route's own doc says "Used by Settings to let the user pick which policy to use" (`:604-606`); **no such Settings surface exists** (grep: 0 hits). A doc describing code that never shipped.
- `GET /api/ebay/flat-file/policies?marketplace=` — `routes/ebay-flat-file.routes.ts:3602-3647`. A **second, independent** implementation with a different response shape (`{fulfillment,payment,return}`), no cache, no `locations`, and no `recordApiCall` audit row. Duplicated logic.
- `PATCH /api/ebay/cockpit/offer-policies` — `routes/ebay-cockpit.routes.ts:825-891`. Merges seven whitelisted keys into `ChannelListing.platformAttributes`. `findFirst({productId, channel:'EBAY', marketplace})` — **no `aliasKey`, no `channelConnectionId`** (`:855-858`): on a multi-alias product it writes an arbitrary listing. 409 when no listing exists.
- `POST /api/products/:id/listings/:channel/:marketplace/pricing` — `routes/marketplaces.routes.ts:752-799`. Same alias-blind `findFirst` (`:772-774`), creates the row if absent, no `expectedVersion`, no audit.
- Studio read: `GET /api/products/:id/studio/sheet?scope=channel&channel=&market=` — `routes/product-studio.routes.ts:179-205`. Studio write: `PATCH /api/products/bulk` (alias-aware since #703, `products.routes.ts:2335-2423`).

**Services**
- `services/ebay-account.service.ts` — the Account API wrapper. Four parallel GETs (`/sell/account/v1/{fulfillment,payment,return}_policy`, `/sell/inventory/v1/location`), every call wrapped in `recordApiCall`, per-`(connectionId, marketplaceId)` cache, **TTL 5 min, an in-process `Map`** (`:54-57, 120-125`). `clearCache()` exists at `:127` and **has zero callers**. `EbayPolicySummary` keeps only `{id, name, marketplaceId}` (`:22-32`) — every term eBay returns (handling time, shipping services and cost, returns accepted / period / who pays) is **discarded at parse**.
- `resolvePolicyDisplayNames(connectionId, marketplaceId, {fulfillmentId,paymentId,returnId})` — `ebay-account.service.ts:266-300`. Already resolves ids → names with the same "unknown id ⇒ this market's first policy" rule the push uses. Fail-open. This is the renderer a policy cell wants.
- `services/ebay-variation-push.service.ts` — the consumer. **Policy waterfall** (`:1700-1741`, duplicated at `:2155-2192`): per-row column → `ChannelConnection.connectionMetadata.ebayPolicies` → live snapshot; then a **market guard that REPLACES** any id not in this market's list, and **FFP.12 refuses the entire push** if the snapshot cannot be fetched rather than sending an unverified id (`:1732-1741`). `missing[]` hard-fails on merchantLocation + fulfillmentPolicy + returnPolicy — **payment is not required** (`:1743-1749`). The offer body puts the three ids in `listingPolicies` and `merchantLocationKey` **top-level** (`:1802-1811`, `:2267-2285`).
- Best Offer: `buildBestOfferTerms` (`:620-641`) — `floor` = autoDECLINE, `ceiling` = autoACCEPT; contradictory pair ⇒ both dropped + warn. Omitted entirely for any SKU that is (or may be) an inventory-item-group member — eBay 25737 — with a `bestOfferEligible` safe-default probe (`:2207-2235`) and a warn-never-block sink for families (`:1758-1760`).
- Round-trip store: `platformAttributes.{fulfillment,payment,return}PolicyId`, `merchantLocationKey`, `bestOffer`, `bestOfferFloor`, `bestOfferCeiling`, `handlingTime`, `listingFormat`, `listingDuration`, `quantityLimitPerBuyer` — written `:2795-2812`, read back `:2600-2636`. Symmetric.
- `services/ebay-publish-gate.service.ts:40-46` — `getEbayPublishMode()` (`gated|dry-run|sandbox|live`, default `dry-run`, master flag `NEXUS_ENABLE_EBAY_PUBLISH`). The flat-file push route honours it (`ebay-flat-file.routes.ts:1511-1513`).
- `services/pim/channel-specs/ebay.ts` — the AM.1 adapter. Emits `paymentPolicyId` / `returnPolicyId` / `fulfillmentPolicyId` (`:108-110`), `listingFormat` / `listingDuration` (`:94-95`), `bestOffer` / `bestOfferFloor` / `bestOfferCeiling` (`:96-98`), `handlingTime` (`:99`) — all in one `LISTING_GROUP`. **Untracked and unwired: zero importers** (grep `ebaySpecFromCache` outside its own dir = 0).

**Prisma** — `packages/database/prisma/schema.prisma`: `ChannelListing.platformAttributes Json?` (`:1493`) is the only home for every field above. The one real column is `bestOfferFloor Decimal?` (`:1615`) — a *pricing-engine* floor, and the flat-file registry points `best_offer_floor` at **that column** (`flat-file/registry/channel-fields.ts:258-267`) while the push reads `platformAttributes.bestOfferFloor`. Two stores, one name. Also `price` (`:1477`), `priceOverride` (`:1582`), `pricingRule` / `priceAdjustmentPercent` (`:1481-82`), `aliasKey` (`:1685`) in both uniques.

**Permissions** (`lib/auth/permissions-manifest.ts`) — `pfx('/api/ebay')` = read `listings:view`, write `channels:sync` (`:354`); `pfx('/api/products')` = read `products:view`, write `products:edit`. So "assign a policy" needs `channels:sync` through the cockpit but `products:edit` through the sheet, and the option list needs `listings:view`. Same operator act, three permissions.

**Jobs/crons** — none touch policies. No cron refreshes the snapshot.

## 4. Studio today

- **Nothing.** The eBay channel scope's only `ebay_*` columns come from the static registry: `ebay_title`, `ebay_description`, `ebay_variationTheme`, plus `ebay_format` and `ebay_duration` which are `editable: false` with helpText "No backing column yet" (`services/pim/field-registry.service.ts:190-191`) — and their option strings (`FixedPrice`, `Days_7`) do not even match the API's (`FIXED_PRICE`, `DAYS_7`). Dead placeholders.
- **Parity audit `docs/pes-parity-audit.md`:** row **3.44** = `🕳 MISSING` — *"no business-policy selection (payment/return/shipping). Price is a cell; policies are unreachable."* Row **3.39** = `✅ PARITY` (title/description/price are columns with server-resolved provenance).
- **Hub rulings that bind:**
  - **#86** — the 22 missing channel-ops capabilities are ONE structural question; *"a sheet is the wrong shape for most of those… cramming them into cells would be worse than leaving them out"*; disposition (a) drawer panes / (b) a new console / (c) accept the loss is the Owner's.
  - **#110** (D1 DECIDED — the three-legged hybrid): policies are in **WAVE 2, queued, not dispatched**, with the shape already stated: *"policies (picked from account-level profiles, never inline — industry-uniform)"*.
  - **`docs/2026-09-01-channel-ops-research.md:72-75`** — structured sub-editors are drawer panes; *"Policies are picked from account-level profiles everywhere, not edited inline."*
  - **`docs/2026-09-04-channel-attribute-model-design.md`** (APPROVED 2026-09-05) — §1.2 names the offer fields as things the sheet shows nothing of; §3/A.1 says the eBay adapter emits them as scalars with eBay's own enums; **§A.3a: NO exclusions** — every declared field is a column, and where another surface owns the value the column *reads and writes the same store*. This **amends #86 for the scalar offer fields**: they are columns, not a pane-only capability.
- Mechanisms already built that this feature needs and must not re-invent: `SheetColumn.options` / `optionLabels` / `mode` (`sheet-columns.service.ts:111-115`) — how `conditionId` already works; `storage: 'listing'` ("appears on channel scopes only", `_studio/sheet/channel/types.ts:11-12`); `writable:false` + `writeBlockedReason` rendered verbatim (`rows.ts:30-40`, `cellHoverNote` `rows.ts:358-369`); the alias band **is** the `rowKind:'parent'` group node and *"carries the listing's own values"* (`rows.ts:170-179`); `RecordPane` groups drawer fields by `SheetColumn.group` and says so (`drawer/panes/RecordPane.tsx:4-6, 95-107`); `SelectPanelEditor` (DS `ListboxPanel` inside AG's popup); `SheetToolbar` `leading`/`trailing` + `onReload` (`SheetToolbar.tsx:92-94, 248-249`).

## 5. Defects and slowness

1. **🔴 The old card's Best Offer writes a namespace nothing reads.** It sends `bestOfferEnabled` / `bestOfferAutoAcceptPrice` / `bestOfferMinAcceptPrice` (`PricingPoliciesCard.tsx:205-207`); the push reads `bestOffer` / `bestOfferFloor` / `bestOfferCeiling` (`ebay-variation-push.service.ts:2600-2602`). The two auto-price keys have **zero readers repo-wide**. Same wrong-store shape as #692/#700. **CODE-READ.**
2. **🔴 The old card's price does not round-trip.** It reads `listing.priceOverride` (`EbayCockpit.tsx:620-625`) and its save routes `priceOverride → data.price` (`marketplaces.routes.ts:777`). The resolver treats them as different layers — `{key:'price', overrideCol:'priceOverride', directCol:'price'}` (`pim/attribute-resolver.ts:135`) — and both sync services use `priceOverride || product.basePrice`, ignoring `price` (`marketplaces/ebay-sync.service.ts:69`). So an eBay price typed in the cockpit is neither read back nor pushed. **CODE-READ** (a DB read would settle whether `followMasterPrice` masks it).
3. **🔴 The adapter's Best Offer English labels are inverted.** `bestOfferFloor` is labelled *"Best offer auto-accept"* and `bestOfferCeiling` *"Best offer auto-decline"* (`channel-specs/ebay.ts:97-98`); the writer's own comments say floor = auto-**decline**, ceiling = auto-**accept** (`ebay-variation-push.service.ts:609-610, 627-628`). Shipping these as column headers would invite an operator to auto-accept at their floor. **CODE-READ.**
4. **🔴 `handlingTime` is stored and never sent.** Round-trips through `platformAttributes` (`:2604`, `:2793`) and appears in no offer body and no Trading-API payload (`ebay-trading-api.service.ts:202` sends `ListingDuration` only). eBay derives handling time *from the fulfilment policy*, which is exactly why. An editable column would be a lie. **CODE-READ.**
5. **🔴 `listingFormat` is a flag the API ignores.** Both offer bodies hardcode `format: 'FIXED_PRICE'` (`:1795`, `:2270`); `listingDuration` reaches eBay only on the shared-SKU Trading-API path. So an `AUCTION` cell would save and change nothing. **CODE-READ** (`reference_api_accepts_a_flag_it_ignores`).
6. **🔴 The account-default tier of the waterfall has no writer.** `connectionMetadata.ebayPolicies` is read in 4 places and written **nowhere** in the repo; the adapter's own error tells the operator to *"set ChannelConnection.connectionMetadata.ebayPolicies"* (`listing-wizard/ebay-publish.adapter.ts:593`) — an instruction no UI can carry out. **CODE-READ.**
7. **🔴 Readiness is blind to policies.** `services/pim/readiness.service.ts` has no policy rule (grep: 0). A listing missing a shipping or return policy reads ready in the studio and then hard-fails the push for the whole family. **CODE-READ.**
8. **🔴 The `#675` no-op equality read is alias-blind.** `products.routes.ts:2017-2033` filters `productId/channel/marketplace` and `listingRows.find(r => r.productId === pid)` — no `aliasKey` — while the write path at `:2335-2344` is alias-aware. Offer fields are exactly the values that legitimately differ between two aliases, so a policy edit on alias-2 could be compared against alias-1 and dropped as a no-op. Latent only because 977/977 rows are primary today (`schema.prisma:1656-1662`). **CODE-READ.**
9. **Two policy endpoints, two shapes, one of them unaudited** — `ebay.routes.ts:618` vs `ebay-flat-file.routes.ts:3607`. The flat-file one skips `recordApiCall` and the 5-min cache, so the untouchable editor hits eBay on every mount. **CODE-READ.**
10. **The 5-min snapshot cache is an in-process `Map`** (`ebay-account.service.ts:57`). With two API replicas there are two caches and no invalidation path (`clearCache()` uncalled), so a "refresh policies" verb can succeed on one replica and leave the other stale for 5 minutes. **CODE-READ / HYPOTHESIS on replica count** (recent commits state a second API instance is now supported).
11. **No conformance witness on the listing-level field list.** The adapter test asserts only `listing`-group count `>= 20` (`channel-specs/__tests__/channel-specs.test.ts:248`) — a floor, not a set claim. `merchantLocationKey`, `quantityLimitPerBuyer`, `itemLocationCountry`, `price`/`pricingRule` are all absent from the adapter and **no test fails** (`reference_a_list_of_members_is_a_set_claim`, `reference_a_scanner_passing_for_the_wrong_reason`). **CODE-READ.**
12. **§A.4 names the wrong store for eBay.** The design doc says the channel store is a typed column "else `overrideData[key]`"; the adapter — measured on 247/252 IT listings — says `platformAttributes.<key>` (`channel-specs/ebay.ts:18-19`). Implementing §A.4 literally would route a policy edit into `overrideData`, which no reader touches: the exact "a write nothing reads" defect the doc set out to fix. Today the bulk PATCH knows only two channel stores, column and bag (`products.routes.ts:2083-2091`). **CODE-READ.**
13. Slowness/size: the card is a 478-line component with 11 `useState`s and a dirty check that `JSON.stringify`s on every keystroke (`:138-160`); dual sequential POSTs on save (`:185-213`); a mount fetch per marketplace switch with no dedupe (`:107-135`).

## 6. Proposed home in the studio

### 6.1 Primary home + mirrors

**PRIMARY — H1: one select cell per offer field, on the eBay channel scope, in an `Offer` column group.**
The Owner's ruling of 2026-09-05 already decided the class: every field the channel declares for the
coordinate is a column, no exclusions, reading and writing the same store the owning surface uses
(§A.3a). A policy id is the textbook H1 example in the placement table. And a policy is a *closed
list of the account's profiles* — the cheapest possible cell: a `select` with `options` = ids and
`optionLabels` = names, which is byte-identical to how `conditionId` already works. #110's "picked
from account-level profiles, never inline" is satisfied by the *options source*, not by refusing a
cell: the operator assigns, never authors. This also makes the capability filterable and
bulk-fillable, which the card never was — "set every alias on IT to Express EU" is a fill-down.

**MIRROR — H7: an `Offer` section in the record drawer, free of charge.** `RecordPane` groups by
`SheetColumn.group` and refuses a second taxonomy (`RecordPane.tsx:4-6`). Declaring
`OFFER_GROUP = {key:'offer', label:'Offer', channelLabel:'Offerta'}` in the adapter therefore
produces *both* the sheet's column group and the drawer's section in one change — matching Amazon,
whose `offer` group comes from eBay's… from Amazon's own `__propertyGroups` (`amazon.ts:363-390`).
The drawer section is where the **policy detail** lives: the resolved policy names plus their terms
(handling time, shipping services and cost, returns accepted / period / who pays), and the
`handlingTime` readout as a *derived, read-only* value taken from the chosen fulfilment policy
(defect 4) — depth that does not fit a 130px cell.

**MIRROR — H11: the profile library stays OUTSIDE.** Policies are authored in eBay Seller Hub; the
studio must never offer to create or edit one. What *is* missing outside is the **account default**
(`connectionMetadata.ebayPolicies`, defect 6) — that belongs on the channel-connection settings page
(`/channels/…`), one screen per connection × market, and the studio holds only the per-listing
assignment plus an "inherited from account default" provenance state.

**MIRROR — H6: one `trailing` toolbar verb, "Refresh policies".** The option list is *account* state
with its own 5-minute cache; the sheet's `Reload` already re-reads the scope, so the only thing
needed is a scope-level verb that passes `refresh=1` through to `ebayAccountService.getSnapshot`.
Scope-level, not per row — the list is the same for every row on the coordinate.

**H2 for the offer's own reported state, not for policies.** "Which policy did eBay actually
receive" is a channel-reported fact and belongs to the existing pull/`ListingsPane` work, not here.

**Explicitly NOT:** a modal, a card, a per-row verb, or a drawer-only home. A verb must never live
only in the drawer (channel-ops §3.2) and this is not a verb at all — it is a value.

### 6.2 What the sheet shows at rest, per scope

| scope | shows |
|---|---|
| **master** | **nothing.** These fields have no master twin and `storage:'listing'` means channel-scopes-only (`types.ts:11-12`). Master must not grow a column for a value it cannot hold. |
| **eBay × market (band row)** | the `Offer` group: `Payment policy`, `Return policy`, `Shipping policy` (each rendering the policy **NAME**, not the id — via `resolvePolicyDisplayNames`), `Inventory location`, `Best offer` (boolean), `Auto-accept ≥`, `Auto-decline <`, `Listing duration`, `Qty limit per buyer`. Provenance mark per cell exactly as today: 🔗 when the value is inherited from the account default, ✎ when pinned on this listing. |
| **eBay × market (child rows)** | the same columns, **read-only, greyed, with a tooltip** — `writable:false` + `writeBlockedReason: "eBay carries the offer terms on the listing, not on the variation — edit this on the ① band row."` `cellHoverNote` already renders that verbatim (`rows.ts:363`). Nothing new client-side. |
| **Amazon / Shopify × market** | the columns do not exist — a per-channel adapter emits only its own channel's fields. |
| chips | one `Missing required (n)` contribution once readiness knows about the two hard-required policies (defect 7). No new chip. |

`listingFormat` and `handlingTime` are the two exceptions and they are shown *honestly*: `handlingTime`
as a read-only derived readout in the drawer's Offer section (it is the fulfilment policy's, not the
listing's); `listingFormat` **not shipped as an editable cell at all** until a publish path actually
reads it — a strict select whose only other value is silently ignored is worse than its absence.
Recommend the adapter mark it `editable:false` with the reason in `helpText`, which the sheet already
renders as the refusal note.

### 6.3 The interaction, step by step

1. **At rest** the band row's `Shipping policy` cell reads `Express EU · IT` (name, from `optionLabels`), with 🔗 if it came from the account default.
2. **Open:** double-click, Enter, or type — the substrate's `openGesture`. `kind:'select'` + `mode:'strict'` routes to **`SelectPanelEditor`** (DS `ListboxPanel` in AG's popup, `cellEditorPopup: true`). ⚠ AG's fill handle is a 6×6 child of the selected cell and swallows the double-click (`reference_ag_fill_handle_swallows_dblclick`); `scripts/check-editor-open.mjs` is the existing gate and must gain one reading per new column kind.
3. **Collect:** the panel lists this market's policies, each row `name` + a second dimmer line with the summary (see §7 — this is the one DS gap). Search appears past `LISTBOX_SEARCH_THRESHOLD`. An `emptyLabel` row "Use the account default" clears the pin.
4. **Preflight/confirm:** none. This is a cell edit, not a verb — `ActionImpact` does not apply. The only warning is the standing one: the cell is `writeTarget:'channelListing'`, so `affectsAllChannels` is false and `cellHoverNote` says nothing. If the option list is empty or failed to load the cell **degrades to a plain text cell** with the raw id (the flat-file precedent, `EbayFlatFileClient.tsx:1264`) rather than presenting an unfillable dropdown.
5. **Run:** commit via `props.onValueChange` (AG 36's only contract — a ref `getValue` is never read, `reference_ag36_react_editor_onvaluechange`), then the ONE `sheetWriter` → `PATCH /api/products/bulk` with `expectedVersion` and `marketplaceContexts[].aliasKey` for the band's alias.
6. **Repaints:** the cell (name + ✎ pinned mark), the band's readiness bar and the scope chip if the write cleared a missing-required, and the drawer's Offer section if open. The drawer is non-modal and the sheet keeps the keyboard, so an open drawer changes nothing about the gesture.
7. **Keyboard:** ↑↓ move the highlight, Enter commits, Esc cancels — and Esc/click-outside are **AG's popup wrapper**, not ours; a second handler would race it (`SelectPanelEditor.tsx:32-35`). An AG popup editor owns Enter/Tab/Esc; design around it.
8. **Bulk:** fill-handle drag down a column of band rows, and a `CONTEXT(alias-group)` verb *"Apply this alias's offer terms to the other markets"* mirrored on the row menu / ⋯ / selection bar — one registry entry, four surfaces.

DS components used: `SelectPanelEditor` + `ListboxPanel` (+ `ListboxOption`), `ProvenanceMark`, `CompletenessPill` on the band, `HoverCard` for the policy summary on a resting cell, `KeyValue` + `Card` idioms in the drawer's Offer section, `Button` for the toolbar's Refresh, `Banner` for "policies could not be loaded for IT". **No new component** — one additive prop, §7.

### 6.4 Per-scope rules

- **Master:** absent, by `storage:'listing'`. Stated, not hidden — the drawer's Record pane on a master scope simply has no Offer group.
- **Channel × market:** present. Policies are **per-marketplace by eBay's own model** — an id from another market is the 25007 cause the push guards against (`ebay-variation-push.service.ts:1718-1731`), so the option list must be fetched per market and the same column on IT and DE holds different, non-interchangeable values. A cross-market fill is a defect, not a convenience: the `broadcast-to-listings` verb must exclude the Offer group or map by policy NAME.
- **Alias band vs variant:** offer terms are alias-level. The push resolves them **once for the family from `parentRow`** and stamps the identical `listingPolicies` onto every variant's offer (`:1802-1811`), so a per-child pin cannot reach eBay. Band editable, children `writable:false`. This needs a **third `scope` value, `per_listing`** — the mirror of `per_variant` (which is "locked on the parent"). It must land in the server type (`sheet-columns.service.ts:108-110`) and the client mirror (`_studio/sheet/channel/types.ts:61`) **in one write** — a local mirror of a server type drifting is a four-times-in-one-day trap here (`reference_wire_parse_boundary_rules`).
- **Best Offer is the exception inside the exception:** eBay rejects it (25737) on any SKU in an inventory item group. On a family the cell must be present but **refused with the reason** — `writeBlockedReason: "eBay does not allow Best Offer on a multi-variation listing"` — rather than saved and dropped with a console warning, which is what happens today (`:1758-1760`).
- **Single-store channels (Shopify):** no offer-policy concept; the adapter emits no such fields, so nothing to reconcile. Note the standing limit: `marketplaceContexts[].channel` is typed `'AMAZON' | 'EBAY'` on the write endpoint, so a Shopify coordinate has no channel write route at all (`studio-sheet.service.ts:493-500`).

### 6.5 Provenance / autosave / readiness / publish

- **Provenance** maps onto the waterfall exactly: 🔗 inherited = the cell is empty and the account default (or the market's first policy) supplies it; ✎ pinned = `platformAttributes.<key>` is set. The tooltip should name *which* tier supplied the effective value, because the push's guard can silently replace a pinned id that is not in this market's list — the operator's pin and the published value can differ, and that must be visible. Recommend the resolved value ride the cell as a second fact rather than being folded into the pin.
- **Autosave:** the ONE `sheetWriter` with `expectedVersion`. Never the cockpit's two endpoints. The alias-blind equality read (defect 8) must be fixed **before** a second alias exists, and note the nav-guard rule: an in-flight autosave has undone an API revert before (`reference_autosave_still_needs_a_nav_guard`).
- **Readiness:** add the two the push hard-requires — `fulfillmentPolicyId` and `returnPolicyId` (plus `merchantLocationKey`) — as `required` in the adapter, and **not** `paymentPolicyId`, which the push does not check. ONE server definition (`services/pim/readiness.service.ts`) so the chip, the band and the row cannot disagree.
- **Publish:** unchanged and preflight-first. eBay stays preview-only by the server's own words; the mode comes from `getEbayPublishMode()`, never from env read client-side. The publish PREFLIGHT is the right place to state the resolved policy ids — including the guard's replacement — so the operator sees what would actually be sent before anything is.

### 6.6 ASCII mockup

```
 SCOPE [Master 96%][Amazon ●92%][eBay ⚠71%]        Market [IT ▾]  Locale [it ▾]
 21 rows  [View ▾][Missing required (2)]  Find…   [Customise][Export ▾][Reload][↻ Policies]
┌──────────────────────┬─── OFFER ─────────────────────────────────────────────┬── ITEM SPECIFICS ──
│ ▸ ① GALE Pro · 20 var│ Payment      │ Return       │ Shipping     │ Best offer│ Brand │ Colore │
│   ● Active   ⚠ 71% ⋯ │ PayPal+Card ✎│ 30d free   🔗│ Express EU  ✎│    ✓      │ GALE  │   —    │
├──────────────────────┼──────────────┼──────────────┼──────────────┼───────────┼───────┼────────┤
│    GALE-KAN-PRO-46-N │  ░ locked ░  │  ░ locked ░  │  ░ locked ░  │ ░ locked ░│ GALE  │ Nero   │
│    GALE-KAN-PRO-48-N │  ░ locked ░  │  ░ locked ░  │  ░ locked ░  │ ░ locked ░│ GALE  │ Nero   │
└──────────────────────┴──────────────┴──────────────┴──────────────┴───────────┴───────┴────────┘
   ░ tooltip: "eBay carries the offer terms on the listing, not the variation —
              edit this on the ① band row."

   editor open on Shipping ──▶ ┌─────────────────────────────┐
                               │ ⌕ ex                        │
                               │ ─ Use the account default ─  │
                               │ ✓ Express EU                │
                               │   3-day handling · €0 · IT   │  ← the one DS gap (§7)
                               │   Standard IT               │
                               │   5-day handling · €4.90     │
                               └─────────────────────────────┘
```

## 7. Contracts and data

**Reused as-is:** `GET /api/ebay/policies` (already cached, audited, `refresh=1`-capable);
`resolvePolicyDisplayNames`; `PATCH /api/products/bulk`; `GET /api/products/:id/studio/sheet`;
`SheetColumn.options`/`optionLabels`/`mode`; `SelectPanelEditor`; `RecordPane`'s group-driven sections.

**Server changes (all additive, PES.5 unless noted):**
1. `EbayPolicySummary` widens to carry the terms the Account API already returns and we discard — handling time, shipping options + cost, `returnsAccepted`/`returnPeriod`/`returnShippingCostPayer` (`ebay-account.service.ts:22-32, 180-195`). One parse, one place. This is what makes the option summary and the drawer's Offer section possible at all.
2. The eBay adapter (`channel-specs/ebay.ts`) — **PES.5**: a second `OFFER_GROUP`; the three policy fields become `kind:'select'`, `mode:'strict'`; fix the inverted Best Offer labels (defect 3); add the four missing keys (`merchantLocationKey`, `quantityLimitPerBuyer`, `itemLocationCountry`, and `handlingTime` as `editable:false`); mark `listingFormat` `editable:false` with its reason; mark `fulfillmentPolicyId`/`returnPolicyId`/`merchantLocationKey` `requirement:'required'`. Replace the test's `>= 20` floor with an **exact set assertion** so a forgotten field fails (defect 11).
3. The adapter is keyed `(marketplace × category)`; policies are keyed `(connection × marketplace)`. So the **options cannot come from the spec** — the scope read must join them in at `columnsWithRouting` (`studio-sheet.service.ts:1470-1497`) from the account snapshot for this coordinate's connection, and pass `refresh` through. Fail-open: no snapshot ⇒ omit `options` and the column renders as text (never an empty strict list).
4. `SheetColumn.scope` gains `'per_listing'` (server + client mirror, ONE write) and the channel row builder sets `writable:false` + a `writeBlockedReason` on variant rows for those columns.
5. The write router must honour `spec.channelStore.kind === 'platformAttributes'` — a third store beside column and bag (defect 12), in the one place §A.4 names, using the same predicate the readers use.
6. Fix the alias-blind no-op read (`products.routes.ts:2017-2033`) — defect 8.
7. `readiness.service.ts` gains the two hard-required policies + the location (defect 7).
8. **New, small:** an account-default editor on the channel-connection settings page writing `connectionMetadata.ebayPolicies` (defect 6). Owns the H11 half.
9. **Retire, at swap:** `PATCH /api/ebay/cockpit/offer-policies` and the pricing POST for the studio's purposes; do **not** delete while the cockpit still mounts (nothing is deleted during this programme).

**One DS gap (an additive prop, not a new component):** `ListboxOption` has `value`/`label`/`title`/`group`/`leading` (`Listbox.tsx:11-31`) but **no visible secondary line**, so "Express EU · 3-day handling · €0" cannot render as the two-line option the summary needs. Recommend `ListboxOption.description?: string` — a second, dimmer line in the **option row only**, never on the trigger; `label` stays a `string` because search ranks on it. It must land in the shared option row so `Listbox` and `ListboxPanel` cannot diverge (`reference_ds_option_list_two_copies` — `MultiSelect`/`GridSetFilter` were two copies of exactly this). Log it in `.claude/DS-GAPS.md`, where the same shape is already recorded twice (`:81`, "a per-option `title` blurb the primitive has no slot for").

**Lanes:** PES.5 = adapter, snapshot widening, options join, readiness, `per_listing`, write router, no-op fix, settings page. PES.3 = the column group on the channel sheet, the band/child affordance, the H6 refresh verb, the `CONTEXT(alias-group)` copy verb. PES.4 = the drawer's Offer section content (the policy-terms readout; the *section* itself is free). PES.2/DS = the `ListboxOption.description` prop + the `check-editor-open.mjs` reading. PES.6 = keep the Offer group out of formula/mapping suggestions (a policy id is not a mappable content field). PES.1 = nothing.

## 8. Risks and traps

- **Every eBay listing in the fixture family is LIVE and local dev writes the PRODUCTION database.** A policy id is one of the few values that can make an entire family unpublishable (25007) or, worse, publish with the wrong shipping terms. Never exercise a policy write against a GALE row from a dev session; probe with `app.inject()` and stay inside the fixture family.
- **`GET /api/ebay/policies` is a REAL outbound call to eBay from any session**, dev included — safe (a GET) but it consumes quota and writes an `OutboundApiCall` row per call. Do not poll it.
- **A market-crossed policy is the classic persistent failure**, and the guard *silently replaces* a bad id with the market's first policy. So a cell can show what the operator pinned while the published listing carries something else. The preflight must state the resolved value.
- **Best Offer on a variation family is rejected (25737)** and today only warns. Do not let the studio present a Best Offer cell on a family as if it worked.
- **Untouchable:** `apps/web/src/app/products/ebay-flat-file/**` is SPEC only — read it, cite it, change nothing. FBA quantity logic and the existing import flows likewise.
- **AI stays dark** (#13): no "suggest a policy", no generated terms.
- **The publish mode comes from the SERVER** (`getEbayPublishMode()`), never an env read on the client; eBay is preview-only.
- **Two column builders drift** (`reference_two_column_builders_drift`): the Offer group must be produced by the engine rule both builders call, with parity asserted in the gate — a master-only or channel-only piece is a silent gap.
- **`channel-field-map.ts` and `channel-specs/ebay.ts` are being edited by another lane right now** (both changed on disk during this read; `channel-specs/` and `studio-sheet.service.ts` are untracked). Coordinate before touching either, and re-read before editing.
- Per-channel oversell, Amazon EU shared quantity and images-global-per-ASIN do not intersect this feature — offer terms are per (listing × market) and carry no quantity.

## 9. Open questions for the Owner (3)

1. **Do the offer fields ship as CELLS on the band row, or only as a drawer section?** §A.3a ("no exclusions") says cells; ruling #86 said a sheet is the wrong shape for channel-ops and #110 queued policies as Wave 2. **Recommend: cells on the band row + the drawer section as the depth mirror.** A policy is a closed-list *value*, not an operation — the thing #86 was right about is verbs and queues, and the design doc's later ruling covers exactly this class. The cell also buys fill-down and filtering, which no card ever had.
2. **Should `listingFormat` and `handlingTime` be shown at all, given no publish path reads them?** **Recommend: show both, read-only, with the reason in the tooltip** — `handlingTime` as a value derived from the chosen fulfilment policy, `listingFormat` as "eBay lists this as fixed-price on our publish path". Honest-UI beats both hiding them and offering an edit that cannot land. The alternative (wire `listingFormat` into the offer body) is a publish-behaviour change and needs its own ask.
3. **Where does the ACCOUNT DEFAULT get edited?** Today `connectionMetadata.ebayPolicies` is readable by four code paths and writable by none. **Recommend: a small section on the channel-connection settings page (H11), per connection × market, with the studio cell showing 🔗 "inherited from account default" when it is empty.** The alternative — leaving the default DB-only — keeps a documented tier of the publish waterfall permanently unreachable.

## 10. Effort and dependencies

| piece | lane | size |
|---|---|---|
| `EbayPolicySummary` widening + the terms parse | PES.5 | **S** |
| Adapter: Offer group, select kinds, label fix, 4 missing keys, exact-set test | PES.5 | **S** |
| Options join at scope read (per connection × market, `refresh` pass-through, fail-open) | PES.5 | **M** |
| `scope: 'per_listing'` (server + mirror) + band/child affordance | PES.5 + PES.3 | **M** |
| Write router honours `channelStore: platformAttributes` | PES.5 | **M** — blocks everything; without it a policy edit is a silent no-op |
| Alias-blind no-op read fix | PES.5 | **S** |
| Readiness: the two required policies + location | PES.5 | **S** |
| Sheet: Offer column group, degraded-to-text state, H6 refresh verb | PES.3 | **M** |
| `CONTEXT(alias-group)` "apply offer terms to other markets" | PES.3 | **M** |
| Drawer Offer section content (policy terms readout) | PES.4 | **S** — the section is free from `SheetColumn.group` |
| `ListboxOption.description` (shared option row) + `check-editor-open` reading | PES.2/DS | **S** |
| Account-default editor on channel-connection settings | PES.5 | **M** |

**Dependencies:** AM.1's adapter must be WIRED first (zero importers today) — this feature is one
group inside it, not a parallel build. Feature 04 (eBay category + aspects) shares the same adapter
and the same conditions cache. The `per_listing` scope is shared with any other alias-level field
(shared-SKU flag, description theme, subtitle), so build it once. The `channelStore:
platformAttributes` write route is shared with every eBay field that is not title/description — it is
the single highest-leverage item on this list.
