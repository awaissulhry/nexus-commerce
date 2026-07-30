# APS — Advertisable Product Selection

**Status: PROPOSAL AWAITING GATE — 2026-07-30**
Nothing in here is built. Each phase is separately gated.

---

## 1. What exists today, and how it is wired

### 1.1 The component

`apps/web/src/app/marketing/ads/campaign-builder/sp-super-wizard/ProductSelection.tsx` (231 lines).

Two panels. **Left**: `Search for Products` / `Enter Products` tabs over a product list
with expandable variation families. **Right**: the running `N Products Added` tray.
Exports `SpwProduct` — `{ id, name, sku, asin, imageUrl, parentId, childCount }`.

### 1.2 Every surface that consumes it

| Surface | File | Purpose |
|---|---|---|
| SP Super Wizard | `sp-super-wizard/SpSuperWizard.tsx:247` | the full guided SP launch |
| Wizard setup step | `sp-super-wizard/CampaignSetup.tsx:227` | per-campaign product override |
| Targeting modal | `sp-super-wizard/TargetingModal.tsx:168` | ASIN **targets** (competitor products) |
| Quick builder | `quick/QuickBuilder.tsx:251` | one-campaign fast path |
| Guided builder | `guided/GuidedBuilder.tsx:310` | multi-type launch |
| Single builder | `single/SingleCampaignBuilder.tsx:345` | products to advertise |
| Single builder (2nd) | `single/SingleCampaignBuilder.tsx:384` | product **targets** |
| Replicate builder | `replicate/ReplicateBuilder.tsx:417` | **the page you were on** |
| AI goal builder | `ai-advertising/new-goal/AiGoalBuilder.tsx:366` | goal product scope |

A tenth surface, `ads/campaigns/[id]/ad-groups/[agId]/tabs/AddProductsModal.tsx`, hits the
same endpoint with its own copy of the logic. An eleventh, the eBay
`ebay/campaigns/new/_wizard/steps/ListingsStep.tsx`, reuses the same `.h10-spw-ps`
**CSS anatomy** but has its own component and its own (correctly eBay-scoped) data source.

### 1.3 The data path

```
ProductSelection.tsx:70
  GET /api/products/search?q=<term>&limit=100
       ↓
apps/api/src/routes/products-search.routes.ts:112
       ↓
apps/api/src/services/product-search.service.ts
  parseFilters()        — reads the querystring
  buildCacheWhere()     — Prisma where over ProductReadCache
  mapRow()              — the item payload
       ↓
ProductReadCache  (a denormalized mirror of Product, no joins on read)
```

Typesense fronts this when `SEARCH_ENGINE_ENABLED=1`; it is **dormant by choice**, so the
ProductReadCache path is what actually runs.

Styling is 67 hand-rolled `.h10-spw-ps*` rules in `apps/web/src/app/marketing/ads/ads.css:2402+`.
None of it comes from the design system.

---

## 2. Root cause — four defects, each proven against production data

Probed live via `apps/api/scripts/_ps-leak-probe.mts` and `_ps-leak-probe2.mts` (read-only).

### D1 — The picker has no channel filter at all

`ProductSelection` never sends `channels`. The endpoint *supports* it
(`product-search.service.ts:112`, `where.channelKeys = { hasSome: … }`) — the component
simply never asks. It was built as "search the catalog", never as "search what I can
advertise".

**Measured on prod:**

```
top-level rows the picker draws from:  37
  on Amazon (any marketplace):         13
  eBay-only (NOT on Amazon):           23   ← leaking
  no channel listing at all:            1   ← leaking ("Untitled product", NEW-20260729-L5C8)
  ------------------------------------------
  NOT advertisable on Amazon:          24 of 37  (65%)
```

That is your bug, exactly: **65% of what that picker offers cannot be advertised on Amazon.**

### D2 — Search is silently dead

The component sends `?q=`. `parseFilters` reads `q.search` (`product-search.service.ts:76`).
`q` is not in the parsed set, so it is dropped on the floor. Typing re-fetches the identical
unfiltered 100 rows, and there is no client-side fallback filter over `all`.

Other callers in the repo already use the correct name — `fulfillment/stock/import/ImportClient.tsx:969`
sends `search=`, and even documents the contract in a comment. The ads picker is the odd one out.

### D3 — `asin` is never returned by the API

`mapRow` does not emit it and `itemSchema` does not declare it, so fast-json-stringify would
strip it regardless. **`SpwProduct.asin` is `''` at all nine call sites.** Consequences:

- The row renders `<AmazonBadge />` next to what is actually a **SKU** and presents it as the ASIN.
- `Enter Products` can never match a pasted ASIN (`ProductSelection.tsx:114`).
- `SingleCampaignBuilder.tsx:160` sends `sponsoredVideoAsins: p.asin || p.sku` — **a SKU where Amazon requires an ASIN**.
- Product targeting sends `asin: undefined` everywhere.
- `ads-create.service.ts:562` throws `at least one ASIN required` on an empty SB ad.

The data exists: **`Product.amazonAsin` is populated on 246 of 339 products (72.6%)**, and
`ChannelListing.externalListingId` holds real child ASINs (799 Amazon rows,
e.g. `B0BVQNHWVW`). `ProductReadCache` just never mirrored it.

### D4 — The advertisable unit is wrong, and a naive fix makes it worse

Amazon cannot advertise a variation parent — `VARIATION_PARENT` is one of its own
ineligibility codes. Two concrete traps:

**(a) "Add all" over-adds.** It adds every child regardless of Amazon presence:

```
GALE-JACKET      children= 40   onAmazon= 20
IT-MOSS-JACKET   children= 30   onAmazon= 21
REGAL-JACKET     children= 40   onAmazon= 24
VENTRA-JACKET    children= 40   onAmazon= 24
```

**(b) A naive channel filter under-shows.** `channelKeys` is built from the parent's *own*
listings only (`product-read-cache.service.ts:134`, `where: { productId }`) — there is no
child rollup. So:

```
normal-knee-slider   children=8   onAmazon=8   rootKeys=[EBAY_IT]
```

Filtering roots on `channels=AMAZON_IT` would **wrongly hide a family with 8 advertisable
Amazon children**. The fix needs a rollup, not just a filter.

### Two more, smaller

- **`limit=100` + client-side paging.** Fine at 37 roots; silently truncates past 100.
- **No marketplace scoping.** `ReplicateBuilder` holds `market` (IT/DE/FR/ES) at line 424 and
  passes nothing to the picker. Live counts: `AMAZON_IT` 137 live listings, `DE` 99, `ES` 19,
  **`FR` 0**. A FR campaign should offer nothing; today it offers everything.

---

## 3. What the best in the industry do

### Amazon's own Ads API — the capability we are missing entirely

`POST https://advertising-api.amazon.com/eligibility/product/list`
([docs](https://advertising.amazon.com/API/docs/en-us/eligibility-prod-3p)) —
headers `amazon-advertising-api-clientid` + `amazon-advertising-api-scope` (profile).

- Request: `productDetailsList[] { asin, sku? }`, `adType` ∈ `sp|sb|sd|dsp`, `locale`
- Response: `productResponseList[]` → `overallStatus` ∈ `ELIGIBLE | ELIGIBLE_WITH_WARNING | INELIGIBLE`,
  plus `eligibilityStatusList[] { name, severity, message, helpUrl }`
- Reason codes: `NOT_IN_BUYBOX`, `OUT_OF_STOCK`, `VARIATION_PARENT`, `LISTING_SUPRESSED`,
  `MISSING_IMAGE`, `MISSING_TITLE`, `ADULT_PRODUCT`, `CLOSED_CATEGORY`, `RESTRICTED_CATEGORY`,
  `INELIGIBLE_CONDITION`, `INELIGIBLE_OFFER`, `INELIGIBLE_PRODUCT_COST`

**We have no eligibility service anywhere in `apps/api/src/services/advertising/`.** Amazon
considers this important enough that it
[added ASIN eligibility to bulksheets](https://advertising.amazon.com/resources/whats-new/asin-eligibility-status-bulk-operations)
for parity with the API.

### The tools

| Tool | Relevant capability |
|---|---|
| **Helium 10 Ads** ([kb](https://kb.helium10.com/hc/en-us/articles/360046281853-Creating-Amazon-Ads-Campaigns-within-Adtomic)) | Connected-catalog picker — no manual ASIN lookup. Quick vs Guided builders (we already mirror this split). |
| **Perpetua** ([Prism](https://help.perpetua.io/en/articles/7052820-the-market-intelligence-feature)) | Child ASIN data **aggregated under the parent**. *Segments* — rule-based dynamic product sets re-evaluated weekly, so membership tracks the catalog. |
| **Teikametrics** ([PAT](https://help.teikametrics.com/en/articles/9217870-sponsored-products-pat-campaign-creation)) | "Enter List" paste tab (we have the shell of this), plus ASIN target recommendations from performance data. |
| **Amazon Campaign Manager 2026** ([what's new](https://stape.io/blog/amazon-advertising)) | Smart search with expression filtering (`SP, Impressions > 1000, Purchases > 0`), multi-account switching. |
| **Perpetua / Adspert red-dot handling** ([Perpetua](https://help.perpetua.io/en/articles/3151158-red-dot-errors-and-ads-not-serving), [Adspert](https://www.adspert.net/amazon-product-status-ineligible/)) | Surface *why* an ASIN will not serve at selection time, not after launch. |

**The pattern across all of them:** the picker is scoped to *advertisable inventory for the
selected account and marketplace*, annotated with eligibility, and never shows the operator
something that cannot become an ad.

---

## 4. Goal

> **One channel-aware, marketplace-aware, eligibility-aware Product Selection component that
> is the single way any surface in Nexus picks advertisable products — correct by
> construction, built on the design system.**

Non-goals: no change to the eBay picker's data source (it is already correct), no change to
FBA quantity, no change to flat-file editors, no write path to Amazon added.

### Design-system position

Current picker is 100% bespoke CSS. Available and unused: `Combobox`, `MultiSelect`,
`DataGrid`, `Pagination`, `Badge`, `Pill`, `Tag`, `EmptyState`, `Skeleton`, `Drawer`,
`FilterBar`, `GridToolbar`. The two-panel anatomy stays — it matches Helium 10 and the eBay
sibling — but is rebuilt from primitives. Eligibility becomes a `Badge`/`Pill` tone; ineligible
rows disable with a reason tooltip.

**Constraint:** the eBay `ListingsStep` shares the `.h10-spw-ps` CSS. Those rules cannot be
deleted until eBay is migrated too, or that wizard breaks.

---

## 5. Phases — each independently gated, shippable, and verifiable

Nothing starts without your explicit go on that specific phase.

### APS.1 — Server contract (additive, no UI change)
- `parseFilters` accepts `q` as an alias for `search` → **fixes D2 for every caller with zero client changes**
- Additive migration: `ProductReadCache.asin` + `ProductReadCache.rollupChannelKeys`
  (a **new** field — `channelKeys` semantics stay untouched so the `/products` grid is unaffected)
- `product-read-cache.service.ts` populates both; backfill script
- `mapRow` + `itemSchema` emit `asin`
- New filter `advertisableOn=AMAZON_IT` matching the rollup
- Keep `product-search-indexer.service.ts` in sync for the dormant Typesense path
- **Verify:** prod probe re-run; `/products` grid unchanged

### APS.2 — Scope the picker (client)
- `ProductSelection` takes a **required** `channel` + `marketplace` prop; all nine call sites pass it
- `ReplicateBuilder` passes its existing `market`
- Server-side search (debounced) and server-side paging — removes the 100-row ceiling
- Row identity: real ASIN when present, otherwise SKU **labelled as a SKU**
- Family rows show `onAmazon / total`; "Add all" adds only the advertisable children
- **Verify:** the picker on `/marketing/ads/campaign-builder/replicate` shows 13, not 37

### APS.3 — Eligibility (the industry-standard piece)
- `ads-eligibility.service.ts` + `POST /eligibility/product/list` in `ads-api-client.ts`, per-marketplace profile scope, TTL-cached
- `GET /api/advertising/eligibility?marketplace=&asins=`
- Per-row status pill + reason; ineligible not addable (with an explicit operator override if you want one)
- Read-only Amazon call — no write gate implications
- **Verify:** live call against IT profile; reasons render

### APS.4 — Design-system rebuild
- Rebuild from `apps/web/src/design-system` primitives
- Migrate the eBay `ListingsStep` onto the same anatomy **first**, then retire the 67 `.h10-spw-ps*` rules
- Balanced symmetric spacing, verified numerically + screenshot-diff before you see it

### APS.5 — Power features
- Bulk paste resolved **server-side** (today it only matches the loaded page)
- Saved product sets / rule-based segments (Perpetua model)
- Filters: fulfillment (FBA/FBM), stock, buy-box, has-image, portfolio membership
- Sort by ad-relevant signals

### APS.6 — Consolidation
- One `<ProductSelection channel=…>` serving Amazon and eBay
- Fold in `AddProductsModal.tsx`, which duplicates the same fetch

### Suggested order
**APS.1 → APS.2** together kill the reported bug. **APS.3** is the differentiator.
**APS.4** pays the design debt. **APS.5/6** are upside.

---

## 6. Decisions — RESOLVED 2026-07-30

**Q1. Ineligible products → SHOW GREYED, WITH THE REASON.**
Row stays visible, not addable, Amazon's reason on hover (`NOT_IN_BUYBOX`, `OUT_OF_STOCK`,
`VARIATION_PARENT`, …). No silent omission — the operator must be able to tell "not in the
catalog" apart from "Amazon is blocking this". Consistent with visibility-over-minimalism.
No override path in scope; if Amazon says ineligible, the picker respects it.

**Q2. Marketplace → CONSOLE-LEVEL CONTEXT.**
One marketplace switcher in the ads shell (`_shell/`); every builder and the picker inherit
it. This retires the hardcoded `marketplace: 'IT'` at `SpSuperWizard.tsx:129` and the
per-builder drift in one move. `ReplicateBuilder` keeps its own source/destination markets —
replication is inherently cross-market — but its **destination** feeds the picker.

*Plan impact:* this becomes **APS.2a**, landing before APS.2b (the picker props), because the
picker's `marketplace` prop needs a source to read from.

**Q3. Eligibility → ALL FOUR AD TYPES (`sp`, `sb`, `sd`, `dsp`).**
`adType` is a single request parameter, so breadth is nearly free once the service exists.
SB matters most: it is where the missing-ASIN defect (D3) actually breaks launches —
`ads-create.service.ts:562` throws `at least one ASIN required`.

*Note:* [`reference_amazon_stack_entitlements`] records DSP as blocked at Amazon. The `dsp`
adType will be wired but will return whatever Amazon returns for our profile; it is not a
reason to build DSP surfaces.

### Phase list — status as of 2026-07-30 end of session

| Phase | Scope | Status |
|---|---|---|
| **APS.1** | Server contract — `q` alias, additive `asin` + `rollupChannelKeys`, `advertisableOn=` | ✅ `bb4ca215a` prod-verified |
| **APS.2a** | Console marketplace context; retire hardcoded `'IT'` | ✅ `402c2d427` prod-verified |
| **APS.2b** | Picker scoped by `channel`+`marketplace`; server-side search/paging | ✅ `70edeb777` prod-verified |
| **APS.3** | Eligibility service + per-row verdicts | ✅ `e30c45fea`…`91371b878` prod-verified |
| — | SKU on top-level rows (operator request) | ✅ `5aa31f8a8` prod-verified |
| **APS.4** | Design-system rebuild | **re-scoped, see below** |
| **APS.5** | Saved segments, ad-relevant filters + sort | not started |
| **APS.6** | One component for Amazon + eBay; fold in `AddProductsModal` | not started |

**Measured effect:** the Amazon picker went from 37 rows (24 unadvertisable) to
14 on IT / 12 on DE, with per-row Amazon verdicts. Search went from dead to
37→1 on "GALE".

---

## 7. What remains

### APS.4 — design-system rebuild (RE-SCOPED 2026-07-30)

Originally justified by "the DS rule says so", then nearly dropped when
`scripts/ds-conformance-guard.mjs` turned out to allowlist `marketing/ads/` as
*"the deliberate H10 pixel-match world"*.

**Operator decision: the Helium 10 pixel-match is no longer the goal — that
target has been passed. Consistency is the goal.** So the exemption is now a
fossil, and it is the thing producing the inconsistency.

Two distinct jobs hide behind this, and they should not be conflated:

- **APS.4 (picker):** rebuild `ProductSelection` on design-system primitives.
  `ListingsStep` and `KeywordTargetingPanel` must migrate first — all three
  share the `.h10-spw-ps` anatomy (75 lines in `ads.css`), and
  `marketing/ads/ebay/` IS ratchet-enforced.
- **Console-wide (separate proposal):** retiring the `marketing/ads/`
  allowlist entry altogether. `ads.css` is 2,804 lines; this is its own
  programme, not an APS phase. Doing the picker first yields a concrete
  reference for what a DS-consistent ads console looks like.

### APS.5 — power features
Reduced: server-side bulk paste was pulled forward into APS.2b (it had to be —
server-side paging made the old client-side matcher worse). What remains is
saved product sets / rule-based segments (the Perpetua model), ad-relevant
filters (FBA/FBM, stock, buy-box, portfolio membership) and sort.

### APS.6 — consolidation
One `<ProductSelection channel=…>` for Amazon and eBay; fold in
`AddProductsModal.tsx`, which duplicates the same fetch.

---

## 8. Debt found along the way (not in the original plan)

1. **`DestinationPanel.tsx:15` hardcodes `MARKETS = ['IT','DE','FR','ES']`.**
   Matches today's launchable set by coincidence; will drift. Replicate is
   genuinely cross-market, so its DESTINATION list should come from the context
   while source stays independent.
2. **Product-TARGET pickers are scoped to our own catalogue.** `TargetingModal`
   and `SingleCampaignBuilder`'s second picker. Amazon allows targeting
   *competitor* ASINs; a real competitor-entry flow does not exist.
3. **Analytics pages share `MarketSelect` but not its state** (Health,
   Portfolios, Rules, AI Advertising), so the console switcher and a page filter
   can disagree. Defensible — "all markets" suits analysis and not launching —
   but it is a visible inconsistency.
4. **`.h10-spw-ps` is shared by three components**, so a change to one can break
   the other two. This is the real hazard in that CSS, independent of APS.4.
5. **93 of 339 products have no `amazonAsin`**, so their rows read "Not
   checked". Correct behaviour, but it is a data gap worth closing.

## 9. Operational findings — for the merchandising side, not the code

- **REGAL jacket listings are SUPPRESSED on FR (3 children) and ES (2)** —
  `LISTING_SUPRESSED`. They are listed, so scoping accepts them; Amazon will
  not serve ads for them. Found by APS.3.
- **AMAZON_FR has 0 live+active listings** while 8 families are in scope.
