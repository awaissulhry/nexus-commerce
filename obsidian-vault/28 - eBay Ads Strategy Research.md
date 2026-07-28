# eBay Ads Strategy Research

→ [[00 - Nexus Commerce MOC]] | [[20 - Advertising]] | [[12 - eBay Integration]] | [[29 - eBay Ads Cockpit Spec (EA-series)]]

Research date: 2026-07-27. Scope: EU-wide (IT/DE/FR/ES/UK treated as peers). Everything here feeds the EA-series spec.

> **Evidence tags** — `OFFICIAL` eBay-published · `MEASURED` someone published numbers · `ANECDOTE` practitioner claim · `INFERRED` derived from mechanics
> **Risk tags** — `SAFE` · `GREY` (permitted mechanically, against the spirit) · `VIOLATING` · `UNKNOWN` (no policy text exists either way)

---

## 1. The 2025–26 rewrite — every pre-2025 playbook is void

Three structural changes landed in the last 18 months. Any strategy, blog post, or vendor feature that predates them is wrong.

### 1.1 "Any-buyer" attribution on General/CPS — `OFFICIAL`

The fee now fires when **any** buyer purchases the promoted item within 30 days of a click by **any** buyer. The clicker and the buyer need not be the same person. Halo (click A, buy B) is abolished for General; it survives only on Priority.

| Marketplace | Live since |
|---|---|
| eBay.de | 26 Feb 2025 |
| eBay.co.uk, .fr, .it, .es | **24 Jun 2025** |
| eBay.com, .ca | 13 Jan 2026 |

**All five EU sites we care about have been on this model for over a year.**

Two clauses that matter more than the headline:

- **The item must be promoted at click time AND at sale time.** Not promoted at sale → no fee, regardless of banked clicks.
- **The rate charged is the rate in effect at the time of the SALE**, not at the click. This inverts the old rule and is the single largest exploitable mechanic in the whole system (§4.1).

A "click" includes **add-to-watchlist, add-to-cart, and quick-view** — not just an ad click. `OFFICIAL`

**Measured impact:** attribution share jumped from ~30–50% to **80–100%** of sales with no increase in volume. German sellers reported 86% within days; several UK sellers reported literally zero organic sales post-change. `MEASURED`

**The arithmetic consequence, and this is the thing most sellers get wrong by ~2.5×:**

```
effective_ad_cost = nominal_rate × attribution_share
pre-2025:  10% × 0.35 = 3.5% of GMV
post-2025: 10% × 0.95 = 9.5% of GMV
```

A rate that was survivable in 2024 is now roughly a straight surcharge on 100% of that SKU's GMV — functionally a second final value fee.

### 1.2 Priority owns slot #1 exclusively — `OFFICIAL`

Since 24 Jun 2025 on IT/UK/FR/ES (26 Feb 2025 on DE), only **Priority (CPC)** ads are eligible for the top ad slot. General campaigns are permanently locked out at any rate.

Consequence: pay-per-sale is now structurally capped below pay-per-click on the most valuable placement. If you want position one, CPC is mandatory. This is why the correct 2026 structure is **Priority on hero SKUs, General at a low rate on the tail** — and *not* both on the same SKU (§4.3).

### 1.3 Priority went GA on the API — 31 Mar / 27 Apr 2026 — `OFFICIAL`

Marketing API v1.23.1: *"Promoted Listings with priority campaign strategy is now open to the public and is no longer restricted to approved users only."*

**This is the commercial opening.** Every incumbent tool's eBay ad support predates it — Rithum's PLA support is a 2021 beta with 2019-era docs; Pacvue's eBay page still lists the retired Promoted Listings Express; 3Dsellers claims CPC in marketing copy while its help centre documents Standard only. Adspert is the only architecturally correct vendor and it has no bulk ops, no negative keywords, no campaign management, and 9 Capterra reviews.

Also new in 2026 and largely unexploited:
- **Rule-based exclusion lists** (May 2026) — up to 10,000 listings excluded per campaign. Enables "promote everything except the losers".
- **Priority Video Ads** (Apr 2026, US/UK/DE/CA; IT/FR/ES `UNVERIFIED`) — API support landed v1.24.0, 21 Jul 2026. Same CPC, bigger unit, free CTR lift.
- **Promoted Stores custom landing pages** (Jan 2026, clarified Jun 2026).

---

## 2. Mechanics reference — the numbers that constrain design

### 2.1 The four ad products

| | General (CPS) | Priority (CPC) | Promoted Stores | Promoted Offsite |
|---|---|---|---|---|
| API `fundingModel` | `COST_PER_SALE` | `COST_PER_CLICK` + `ON_SITE` | not in Marketing API | `COST_PER_CLICK` + `OFF_SITE` |
| Charge | % of total sale amount, on attributed sale | per valid click, always | per click | dynamic CPC, eBay-set |
| Rate/bid | **2.0–100.0%**, 0.1pp precision | bid, second-price auction | bid | none — eBay sets daily |
| Budget | none | €3 min / €1,000,000 max daily | daily | daily |
| Keywords | eBay-automatic | full control + negatives | store categories + keywords | none |
| Slot #1 | **ineligible** | **exclusive** | separate banner slot | off-platform |
| Auctions | eligible | **not** eligible | n/a | not eligible |
| Rules-based selection | **yes** (CPS only) | no | no | no — account-level |
| Per-listing control | via ad-level `bidPercentage` | via keyword bids | 10 featured of 1,000 | **none** |
| EU availability | IT/DE/FR/ES/UK all ✅ | all ✅ (ES doc stale, test 35051) | UK/DE/IT/ES ✅, FR likely | all ✅ |

Localised names — never key off UI labels: IT *strategia generale / prioritaria*, DE *Basis- / Premium-Kampagne*, FR *stratégie générale / prioritaire*, ES *estrategia general / prioritaria*.

### 2.2 Fee base

```
A = item price + buyer-paid shipping + taxes + other applicable fees
CPS fee = ad_rate × A × (1 + VAT_on_fees)
```

The base widened from item-price-only on 1 Jun 2022. It includes shipping — which is why heavy/low-ASP items are disproportionately punished, and why the naive `max_rate = margin% − fee%` formula overstates the affordable rate.

A markdown **lowers the fee base proportionally** (`INFERRED` from eBay's definition of "total sale amount" — validate against a real invoice before shipping the calculator).

### 2.3 Hard limits

| Limit | Value |
|---|---|
| Active campaigns per seller | 10,000 |
| Ads (listings) per campaign | **50,000** — overflow silently truncated to "first 50,000 by recency", no error |
| Ad groups per campaign (CPC manual) | 500 |
| Ads per ad group | 1,000 |
| Keywords / negative keywords per ad group | 1,000 each |
| Listings per **smart**-targeting Priority campaign | 3,000 |
| Selection rules per rules-based campaign | 10 via API / **1 via UI** |
| Rule exclusion list | 10,000 per campaign, campaign-scoped |
| Bulk ad ops batch | **500 IDs per call** |
| Keyword | ≤80 chars, ≤10 words; banned chars `! = ? @ % ^ * ; ~ \` , ( ) { } < > \|` |
| Campaign / ad-group name | 80 chars |
| Budget change | min ±0.50 delta; **15/day per campaign** (`UNVERIFIED` — probe) |
| Report records | **1,000,000 — report FAILS if exceeded**, no truncation, no paging |
| CPC report with `day` dimension | **7-day max range** |

### 2.4 API quotas — the real bottleneck

| Bucket | Limit |
|---|---|
| **Sell Marketing "Ads"** (campaign/ad/ad_group/keyword/negative) | **10,000 calls/day** |
| Sell Marketing "Promotion" (discounts) | 100,000 calls/day |
| `createReportTask` / `getReportTask` / `getReport` | **200 calls/hour per seller** |
| Sell Analytics `traffic_report` | 100 calls/day |
| Recommendation API | 5,000 calls/day |

The arithmetic that breaks platforms: at 500 IDs per bulk call, touching 100k ads once costs 200 calls — cheap. The killer is **reads**: `getAds` caps at `limit=500`, so enumerating 100k ads costs 200 calls *per campaign per pass*, multiplied by marketplaces. **Reads exhaust the quota, not writes.** Drive reconciliation off reports, not `getAds` enumeration, and apply for eBay's Application Growth Check before launch.

### 2.5 Reporting

Async only: `POST /ad_report_task` → 202 → poll → download `.tsv.gz`. Retention 30 days. All metrics **reconciled at 72h**; treat anything younger as noise.

| Report | Funding | Key dimensions |
|---|---|---|
| `CAMPAIGN_PERFORMANCE_REPORT` | both | campaign, listing, ad_group, day |
| `LISTING_PERFORMANCE_REPORT` | both | as above |
| `TRANSACTION_REPORT` | both | transaction_id, listing, day, **sale_type** |
| `KEYWORD_PERFORMANCE_REPORT` | **CPC only** | seller_keyword_id, match_type, day |
| `SEARCH_QUERY_PERFORMANCE_REPORT` | **CPC only** | **`search_query`**, ad_group, match_type |
| `INVENTORY_PERFORMANCE_REPORT` | — | **not currently available** |

**There is no search-term data for CPS at all.** This is the single strongest argument for pushing hero SKUs into Priority — it is the only route to knowing what buyers actually typed.

### 2.6 API-vs-UI asymmetries — our structural advantage

`OFFICIAL`, from eBay's own [API vs UI comparison](https://developer.ebay.com/api-docs/sell/static/marketing/pl-api-vs-ui-feature-comparison.html):

| | UI | API |
|---|---|---|
| Selection rules per campaign | 1 | **10** |
| `autoSelectFutureInventory` | forced `true` | **settable `false`** ← the only way to freeze an A/B cohort |
| Bulk promote | 200 listings max | 500 per call, unbounded batches |
| Competition metric / Active Seller count | ✗ | **✓** |
| Enhanced Transaction Report (PLG vs PLP split) | ✗ | **✓** |
| Bulk report requests | ✗ | ✓ |

Everything a customer cannot do in Seller Hub, we can. That list is the product.

### 2.7 Things with no API at all

- **Promoted Offsite** — 10 methods only, one campaign per seller, no listing selection, no impressions in reporting.
- **Offsite opt-out on General** — manual request form, ~7 days, and pre-opt-out clicks keep billing for 30 days after. Total tail: **37 days**.
- **Promotions/Discounts Manager has NO bulk endpoints.** One HTTP call = one promotion. Bulk-ness lives inside `inventoryCriterion`. Our bulk layer must fan out client-side and will partially fail routinely.
- **Idempotency: none.** No idempotency key anywhere. Error 35036 ("ad already exists") and 35018 (duplicate IDs in request) are the only dedupe primitives — treat both as success-equivalent.
- **No bulk job status.** Bulk ops are synchronous 207 Multi-Status; iterate `responses[]` per item.
- **`cloneCampaign`** works only on ENDED, rules-based, CPS campaigns, and clones only the criterion — not ads, ad groups, or keywords.
- **Immutable after launch:** funding model, `campaignTargetingType` (SMART↔MANUAL), listing selection strategy. Fix = end + recreate. `ENDED` is terminal. Every campaign needs a versioned recreate-and-migrate path, not an edit path.

---

## 3. The competitive landscape — and why it is wide open

Only **four** platforms verifiably touch eBay ads at scale: Pacvue, Skai, Rithum, Adspert. Only two SMB-priced: 3Dsellers, SixBit. Verified **absent** from eBay ads entirely: Teikametrics, Perpetua, Helium 10 Adtomic, CommerceIQ, Sellozo, Intentwise, Quartile, Jungle Scout Cobalt, AdBrew, Ad Badger, BidX, SellerApp, Optmyzr, Channable, Threecolts, Sellerboard, ZIK, Sellbrite, Feedonomics, GoDataFeed, Codisto, Linnworks. InkFrog shut down 1 Jun 2026. Algopix is defunct.

Sellerboard — which proved profit-aware ad management on Amazon — has **deliberately not built eBay**; its eBay nav link is a dead `javascript:void(0)`.

### The gaps, ranked

1. **Nobody has shipped for the post-March-2026 Priority API GA.** Datable, and every incumbent's eBay product predates it.
2. **No profit-aware eBay ad management exists anywhere.** Post-2026 total fee load runs 25–35% of sale price, which makes revenue-ROAS optimisation actively harmful — a 6% ROAS-positive ad can be margin-negative.
3. **No incrementality measurement.** The attribution change made ad-attributed sales meaningless as a signal, and eBay removed the Direct-vs-Halo breakdown in 2024 and never restored it. Sellers are explicitly asking for holdout testing and getting nothing. Highest emotional salience of any unmet need.
4. **Dayparting — universal absence.** eBay has no native dayparting for any product. It must be simulated via scheduled bulk bid/budget calls. Table stakes on Amazon, nonexistent here.
5. **Bulk operations at scale.** Seller Hub caps bulk-promote at **200 listings**, and eBay staff confirmed on the forums that ad rates cannot be set via Seller Hub file uploads at all. Sellers describe it as "very repetitive and cumbersome". Reported failure rate on eBay's own bulk rate editor is ~50%.
6. **Negative keyword management** — a near-universal blind spot. 1,000 negatives per ad group available; Pacvue doesn't mention them for eBay, Adspert doesn't document them.
7. **Cross-strategy portfolio optimisation** (General vs Priority per SKU). Adspert refuses General entirely; Rithum only does General. Nobody models the trade-off.
8. **Data reliability layer.** eBay's own Ads module returns *different numbers on every page reload*; the Traffic report misclassifies promoted sales as organic, contradicting the Ads dashboard on the same day. eBay billed sellers months late in Jun 2025 for a "system error" and gave them no way to verify. A reconciliation ledger has a genuine moat because the source of truth is untrustworthy.
9. **Promoted Offsite and Promoted Stores are entirely unserved** by any vendor.
10. **Mid-market pricing hole** — €15–75/mo tools that can't do CPC, or €26k/yr enterprise. Nothing sized for 5,000 SKUs.

### Seller Hub native weaknesses (the real baseline)

No dayparting · no cross-campaign portfolio view · no profit data (ROAS shown without COGS/FVF/shipping, so it's decision-useless) · no change history or audit log · no rollback · no multi-account · no forecasting or simulation · automation limited to extending end dates and raising budgets on ROAS thresholds — and those require a campaign end date · bulk ad-rate editing buried five clicks deep, outside the main Bulk Edit section · **ROAS-triggered controls judge on only the last 14 days**, systematically understating a product with a 30-day attribution window.

---

## 4. Tactic catalogue

Everything found, tagged, not filtered. Policy acceptability is the operator's call at runtime — the platform surfaces the risk tag and lets the user decide.

### 4.1 Attribution & rate-timing — the highest-value cluster

| # | Tactic | Mechanism | Risk | Ev. |
|---|---|---|---|---|
| **A1** | **Rate-drop arbitrage** | Fee = rate at *sale*, not at click. Run 12% to buy clicks, drop to 2% before conversions land. Banked clicks bill at 2%. On a €60 order that is €6.00/unit saved. **The single largest lever in the system, and nobody has productised it.** | `GREY` | `OFFICIAL` mechanic |
| **A2** | **Burst-and-drop** | Formalised A1: suggested+X for 24–72h to harvest impressions, then park at 2.0% for the remaining 27 days. Blended effective rate with a 3-day burst ≈ **3.0%** for burst-level click acquisition. | `GREY` | `INFERRED` |
| **A3** | **Sale-time de-promotion** | Fee requires promotion at *both* click and sale. Remove the listing from the campaign before the sale closes → banked clicks never bill. | `GREY` | `OFFICIAL` |
| **A3-trap** | **Attribution survives restart** | Re-adding a listing inside the 30-day window **re-arms every previously banked click**. Naive cycling is worse than doing nothing. Dark periods must exceed the SKU's 90th-percentile click→sale lag. | — | `OFFICIAL` |
| **A4** | **Multi-quantity blast radius** | One click arms **every unit** of a deep-stock listing for 30 days. α→1.0. Mitigations: split quantity across listings (`GREY`, duplicate-policy exposure), rotate which clone is promoted, or keep deep-stock SKUs out of General entirely and use CPC (no per-unit tail). | `GREY` | `OFFICIAL` |
| **A5** | **External-traffic fencing** | Traffic you send yourself (own site, email, social) to a promoted listing **is billed** if any buyer clicked the ad in the prior 30 days. You pay eBay a fee on traffic you bought and delivered. Fix: remove externally-promoted SKUs from General entirely. | `SAFE` | `OFFICIAL` |
| **A6** | **Best Offer as fee reducer** | Fee base is actual sale amount. Accepting at 90% of list cuts the ad fee 10% *and* the FVF. Combined marketplace-fee elasticity to price ≈ 22–25%. | `SAFE` | `OFFICIAL` |
| **A7** | **Watcher/offer collision** | Watchlist-add counts as a click. Offers-to-Buyers targets exactly those watchers → near-guaranteed attributed sale. Play: de-promote, send offers, stay dark until the offer window expires. | `GREY` | `INFERRED` from two `OFFICIAL` halves |
| **A8** | **End-and-relist window reset** | Does a fresh listing ID shed the click bank? eBay says relist *carries* promotion status but says nothing about the click bank. **Highest-value open question.** Test with matched cohorts. | `GREY` | `UNKNOWN` |
| **A9** | **Auction auto-relist silent billing** | Auto-relisted auctions keep being promoted unless manually turned off during the relist flow. Nightly sweep required. | defensive | `OFFICIAL` |

### 4.2 Rate & bid economics

**The correct break-even formula.** The naive `margin% − fee%` overstates the affordable rate because the fee base includes shipping.

```
A  = P + S + T                          (item + buyer-paid shipping + tax)
m  = P + S − COGS − ship_cost − (FVF + intl + regulatory)·A − per_order_fee
r_BE  = m / (A · (1 + VAT_on_fees))     naive break-even
r_max = r_BE · (1 − κ)                  κ = cannibalisation ratio
```

Worked (UK, Feb-2026 schedule, P=50 S=4 A=54, FVF 12.5%, per-order £0.40, COGS 22, ship 3.20):
`m = 21.65` → `m/A = 40.1%`

| κ (cannibalisation) | max survivable rate |
|---|---|
| 0.00 (fully incremental) | **33.4%** |
| 0.50 | 16.7% |
| 0.75 | 8.4% |
| **0.90** | **3.3%** — barely above the floor |

**κ is the whole ballgame, and nobody measures it.** That is finding #3 above and the core of the product.

**Rate doctrines found in the wild** — all `ANECDOTE` unless marked, use as cold-start priors only:

| Formula | Notes |
|---|---|
| Start at 2–3%, ignore eBay's suggestion | Near-universal. Suggested rates of 12–20% observed against 13.25% FVF; 18.8% suggested on Motors items with 8% MAP-capped margin |
| Suggested × 1.5 (× 1.75 for slow movers, 0% for strong-organic brands) | |
| Suggested − 0.3 to 0.5pp | 437-listing / 6-month test, "saved hundreds", negligible placement loss — the auction is not a hard cliff. `MEASURED` |
| Flat 5%, 7.5% for multi-quantity | |
| Ratchet: start 2%, +1pp/week on data | Most-repeated across agency blogs |
| Margin-share: `max_rate = pre-ad net margin × acceptable profit share` (1/5 to 1/4 of profit) | The only formula that isn't margin-blind |

Cautionary: one seller laddered **6.3% → 13% → 25%** because eBay's suggestion kept insisting the items weren't visible. eBay's suggested-rate model optimises `(price − FVF − ad fee) × P(ranking win)` — it maximises eBay's ranking-win probability, **not seller margin**, and it takes *competitor ad rates* as its #1 input. It is a documented bid-escalation ratchet: everyone chasing the suggestion pushes the suggestion up.

**Dynamic vs Fixed — mechanical, immediately actionable:**
- Fixed floor **2%**; Dynamic floor **5%** (`UNVERIFIED` officially, consistently reported — test empirically).
- `adRateStrategy: DYNAMIC` **blocks programmatic bid setting entirely** (errors 35010, 35113). Forcing FIXED is a hard precondition for any bid automation we build.
- Arbitrage: Dynamic with `adRateAdjustmentPercent: −20%` and a tight `adRateCapPercent` free-rides eBay's competitive signal while structurally underbidding it.
- Dynamic converts a known liability into an unknown one: you're billed at whatever the algorithm decided this morning, for clicks bought weeks ago. It forfeits A1 entirely.

**The best-designed test in the whole corpus** (blurryrobot, books, genuine alphabetical randomisation, 15%/5%/2%): on **reducing** the rate 15%→5% and 5%→2%, **both arms showed a large impression spike**. Independently corroborated. Implication (a): any rate edit appears to trigger re-indexing, which **confounds every naive A/B rate test ever published**. Implication (b): a "churn the rate ±0.5% periodically" exploit to farm the re-index boost. Novel, testable, unexploited.

### 4.3 Campaign structure

| # | Tactic | Detail | Risk |
|---|---|---|---|
| **S1** | **Never run General + Priority on the same SKU** | *"You will be charged for Attributed Sales from general clicks even if your ad received a subsequent priority click."* You pay the CPC **and** the CPS. Correct structure post-Jan-2026: Priority on heroes (removed from General entirely), General at low rate on the tail. | `SAFE` |
| **S2** | **Broad-rule + exclusion inversion** | Maximally broad rule, then exclude up to 10,000 losers per campaign. "Promote everything except the losers" is far more robust than "promote the winners" because new SKUs default to promoted. Combine with `autoSelectFutureInventory: true` and an auto-maintained exclusion list driven by live margin — the closest thing eBay offers to a target-ROAS bidder. | `SAFE` |
| **S3** | **Price-band sharding** | Shard campaigns by disjoint `minPrice`/`maxPrice` so each stays under 50,000 ads. Price bands double as the margin ladder — one lever, two jobs. | `SAFE` |
| **S4** | **50k silent-truncation steering** | Overflow keeps "the first 50,000 by recency". **Touching a listing makes it more recent**, so bulk-revising steers which SKUs occupy the slots. Crude, undocumented, effective. | `GREY` |
| **S5** | **Store-category as ad-control tag** | `SelectionRule.categoryScope` accepts `STORE` — seller-defined, arbitrary categories. Build ad rules around your own taxonomy ("Margin Tier A", "Clearance", "Q4 Push") and re-tag SKUs to move them between rules **without touching the listing's real category**. Near-perfect automation target, badly under-used. | `SAFE` |
| **S6** | **Frozen cohorts for A/B** | `autoSelectFutureInventory: false` is **API-only** — the sole way to build a stable experiment cohort. Impossible in Seller Hub. | `SAFE` |
| **S7** | **Naming schema as a data layer** | 80 chars. `EA\|{marketplace}\|{strategy}\|{poolTier}\|{priceBand}\|{cohort}\|{expId}\|v{n}`. eBay's reports are campaign-keyed and otherwise unjoinable to experiment design. | `SAFE` |
| **S8** | **Ad-group fan-out** | 500 ad groups × 1,000 keywords = 500k keyword slots for one product. Campaigns are the *budget* unit; ad groups are the *bidding* unit. | `SAFE` |
| **S9** | **Clone-and-swap migration** | No `updateCampaignCriterion` exists and rules are immutable. Pre-stage the replacement as `SCHEDULED` so there is no dark gap. | `SAFE` |

### 4.4 Keyword aggression (Priority only)

| # | Tactic | Detail | Risk |
|---|---|---|---|
| **K1** | **SQP harvest loop** | Search Query Performance Report → queries with sales not yet EXACT keywords → promote to high-bid EXACT ad group → add as negative in the BROAD group that found them → queries with spend and zero sales → negative everywhere. Weekly, on T-4 data. The canonical PPC flywheel; on eBay it's the only route to real search-term data. | `SAFE` |
| **K2** | **Negative reconciliation** | Every EXACT term becomes an exact negative in PHRASE and BROAD groups; every PHRASE term becomes a phrase negative in BROAD. Without it, the same query enters your own second-price auction three times and **you set your own clearing price**. Impractical by hand at 500 ad groups × 1,000 negatives. | `SAFE` |
| **K3** | **Match-type ladder** | BROAD (discovery, floor bid) → PHRASE (mid) → EXACT (high, proven converters), with K2 cascading downward. | `SAFE` |
| **K4** | **SKAG** | One keyword per ad group. ~5M SKAGs supportable per account. Perfect bid control and attribution. Only feasible with software. | `SAFE` |
| **K5** | **Competitor brand conquesting** | Bid on rival brand names. **No eBay policy text exists either permitting or prohibiting it** — a genuine vacuum, checked across the PL ToS, Marketing Terms, API restrictions and all seller-centre pages. Note the asymmetry: the *keyword* is invisible to buyers, but the ad creative **is the listing title**, and a competitor's trademark in your title is separately and clearly enforced (keyword spam / VeRO). | `UNKNOWN` |
| **K6** | **Model-number / MPN conquesting** | Bid on rival part numbers, OEM codes, cross-reference numbers. Highest-intent, lowest-competition keyword class on eBay — parts buyers search by number. Numbers are far less protectable than marks. Generate from parts-compatibility tables. | `GREY` |
| **K7** | **Misspelling harvest** | Edit-distance-1/2 and keyboard-adjacency variants, filtered against SQP-observed queries. Cheap clicks at the bid floor. Safe as *keywords*; `VIOLATING` if stuffed into titles. | `SAFE` |
| **K8** | **Reactive brand defence** | Since slot #1 is Priority-only, your organic listing **cannot** occupy it — so if you don't bid on your own brand, a conquester gets a free slot above you. Detect conquesting by parsing own-brand SERPs; switch defensive bids on only when a threat is present, rather than paying permanently. | `SAFE` |
| **K9** | **Long-tail land grab** | Fill to the 1,000-keyword ceiling with attribute × attribute × intent permutations at the bid floor. Most get zero impressions and cost nothing; survivors get promoted to SKAGs. | `SAFE` |
| **K10** | **Bid-to-position laddering** | Second-price means raising your bid doesn't raise your price unless you displace someone. Ladder upward in small steps until impression share stops improving, then hold. Truthful bidding is dominant — spend the optimisation effort on *which* keywords, not on shading. | `SAFE` |

Observed CPC anchors: floors **€0.10 manual / €0.20 smart** (raised 10× from €0.02 in Nov 2024 without announcement), ceiling €100. **No published data exists on what CPC wins slot #1** — eBay actively removed bid-range references from its own pages, and suggested-bid fields have been intermittently broken since Mar 2026.

### 4.5 SERP real-estate

| # | Tactic | Detail | Risk |
|---|---|---|---|
| **R1** | **Search dedup ceiling** | *"only one of your listings, either promoted or non-promoted, will appear in a given set of search results."* **You cannot appear twice on one SERP with one listing.** Extra inline slots require extra *listings*. | — |
| **R2** | **Legitimate multi-slot stack** | Promoted Stores banner (separate slot, above PL inventory) + Priority slot #1 + General inline on a *different* listing of the same family + carousel presence. The maximum verified footprint for one seller on one query. | `GREY` |
| **R3** | **Variation split-out** | V variations → V independently promotable ad objects, each targeting a different long-tail query. The single highest-leverage real-estate move. **But** it's `GREY` — genuinely different attributes are defensible; identical splits are a duplicate-listing violation, penalty is demotion of *all* your listings including across linked accounts. | `GREY` |
| **R4** | **Split-vs-consolidate trade-off** | Consolidated multi-variation = fewer ad slots but concentrated sales history and better organic rank — **and the worst possible attribution case** (one click arms every unit of every variation for 30 days). The threshold is a function of stock depth × variation count × click frequency. Computable. | — |
| **R5** | **Quantity/bundle/kit tiers** | Single, 2-pack, 5-pack, kit-with-accessory as distinct listings. The canonical *allowed* exception to duplicate policy. Higher AOV amortises CPC better. | `SAFE` |
| **R6** | **Condition-tier splitting** | New / Open box / Refurbished / Used tiers hit condition-filtered SERPs, which are **separate dedup universes**. `listingConditionIds` is a first-class rule filter. | `SAFE` if genuine |
| **R7** | **Cross-site spread** | Campaigns are strictly per-marketplace and immutable. 5 EU sites = 5 SERPs, 5 auctions, 5 sets of slots, with materially different competitive density. Measured: same brand, **+313% conversions on .com vs +135% on .de** under identical optimisation. Real arbitrage exists. | `SAFE` |
| **R8** | **Sort-type awareness** | PL inline ads appear only under **Best Match and Top Picks** — zero inline ads under Time/Price/Distance sorts. In commodity categories where buyers sort by price, ad spend is largely wasted and price is the real lever. Inverse in Best-Match-dominated categories. | `SAFE` |
| **R9** | **Video attach** | 5–60s (target 15s, `45s` is the safer cap given conflicting sources), autoplay, static-image fallback, **no CPC premium**. Larger motion-bearing unit for the same clearing price — free real-estate expansion inside a won slot. | `SAFE` |
| **R10** | **Second-account spread** | `VIOLATING` in effect — duplicate penalties extend *"across linked accounts"*. **Do not build.** Build the inverse: cross-account duplicate detection that warns before demotion. | `VIOLATING` |

### 4.6 Budget & pacing (Priority)

- **Monthly cap = 30.4 × target daily budget.** Any single day may spend **up to 2× the highest daily target set that day**, then ads stop until reset. Sellers report literal 2× charges ("$100/day and eBay has been taking $200").
- **P1 — the ratchet.** Raising the budget mid-month recalculates the cap as `already_spent + new_daily × days_remaining`. Spent £150 by the 15th, raise £10→£15 → cap becomes **£405**, versus £304 if you'd run £10 all month. **Path-dependent and only ever ratchets upward** — eBay never claws back. Model the envelope as the ratchet formula, never as `30.4 × current_daily`. `GREY`
- **P2 — start on the 1st.** Mid-month start pro-rates: `daily × remaining days including start day`. For seasonal pushes, start on the 1st at a low budget and raise, rather than starting late.
- **P3 — the €0.50 quantum.** On a €3 minimum budget, €0.50 is a **16.7% step**. Sub-€0.50 pacing corrections are impossible. To get ≤5% granularity you need a daily budget ≥ €10.
- **P4 — simulated dayparting.** No native dayparting exists.
  - *Recipe A (hard window):* floor the budget outside target hours, raise at window open. 2 changes/day.
  - *Recipe B (starve-and-burst):* keep the daily budget deliberately low so eBay's own pacing allocates it to its best-predicted hours. **Dayparting by proxy, zero API calls.** The cleanest form of "cap budget low to force eBay onto the best hours".
  - *Recipe C (day-of-week):* step up Thu–Sun. Pair with a low early-month base to offset the ratchet.
  - *Recipe D (end-of-month dump):* unused allowance does **not** roll over. Detect underspend around day 24 and raise the daily so the ratchet recaptures the envelope.
- **P5 — pause, never end.** Pausing does not forfeit the monthly envelope and resuming is fine. `ENDED` is irreversible.
- **P6 — hard budget cap.** eBay provides none. `pauseCampaign` on a true cumulative threshold is trivially buildable and immediately marketable.

### 4.7 Cross-lever substitution — ads vs promotions

**eBay's own position, verbatim and unambiguous:** *"Creating and promoting discounts on eBay will not directly give you an advantage in your listings' search results rank."*

The causal chain is discount → conversion rate → Best Match, second-order and lagged. **Any spec that treats "run a sale" as a visibility action is contradicted by eBay's own documentation.**

| | Markdown / discount | Ad-rate increase |
|---|---|---|
| Mechanism | changes **conversion** on impressions you already have | **buys impressions** you don't have |
| Ranking effect | zero direct; indirect and lagged | direct, immediate, purchased |
| Cost | margin give-up on **every** unit | fee on attributed sales (CPS) or clicks (CPC) |
| Visibility | red strikethrough treatment only, **not position** | position |

**Decision rule:** promotion when the listing has impressions but poor conversion; ad-rate when it converts but has no impressions.

**The arithmetic still favours markdowns per unit.** A 5% markdown costs `0.05 × P`. A +5pp ad rate costs `0.05 × A`, and `A ≥ P` because A includes shipping and tax. On a €60 order (P=50, S=10): markdown = €2.50 and saves ~€0.31 FVF → net **€2.19**; +5pp ad rate = **€3.00** (€3.60 with VAT). Markdown is 35–65% cheaper per unit — but it cannot buy placement you don't have.

Discounts are **free to create and free to sell through**. Stacking: coupon + markdown ✅, coupon + order discount ❌, coupon + volume ❌, markdown + shipping discount ✅. Multiple offers resolve **best-wins, not additive**. Best Offer takes priority over coupons. Promotions and Promoted Listings are orthogonal with no mutual exclusion — and a markdown **lowers the CPS fee base** (`INFERRED`, validate against a real invoice).

EU markdown constraints: max duration **14 days** on AT/CH/DE/ES/FR/IE/IT/UK (45 elsewhere); price-stability prerequisite of **up to 30 days on FR/DE/IT/ES**; restore after a sale ends "may take several hours" — a real hazard for back-to-back events. Requires a Store subscription and business seller status.

**Volume pricing against the multi-quantity problem (A4):** ad fees are charged **per transaction**. Consolidating 3 units into 1 order converts 3 ad fees into 1. Three €20 orders at 10% = €6.00 in fees; one 3-unit €54 order = €5.40, plus two fewer per-order fees. Wins only where the discount drives genuinely larger baskets.

### 4.8 Defensive monitors — cheap to build, high perceived value

| # | Watch for | Why |
|---|---|---|
| **D1** | **Easy Boost activation** | 2026 mobile feature sets one rate across **all current and future listings** and **overrides existing General campaign settings** account-wide. Will flatten any tiered structure we build. Sellers report unintentional activation. |
| **D2** | **In-SERP "Boost" button** | Seller-only view, pre-filled suggested rates, one click, out-of-band. |
| **D3** | **Rate drift** | Daily diff of every ad's `bidPercentage` vs our intended ledger. Catches D1, D2, Dynamic takeover, and a reported UI bug where 10% typed saves as 12%. |
| **D4** | **`SYSTEM_PAUSED`** | Campaigns auto-pause when seller status drops below Above Standard and auto-resume on recovery. A defect-rate blip silently kills all promotion. (Second-order: while paused, banked clicks don't bill — an involuntary A3.) |
| **D5** | **Enrolment drift** | Documented Jan-2026 bug: rules-based campaigns fail to add all matching listings *and* block manual promotion with "This listing has been added to a campaign using rule-based listing selection". |
| **D6** | **Settings drift** | eBay's terms reserve the right to change *"default settings, pricing and targeting methodologies"* with notice given only via the dashboards, not publicly. They have raised floors silently at least twice. Daily snapshot + diff → same-day detection instead of invoice-day discovery. |
| **D7** | **Fee reconciliation ledger** | eBay charged sellers months late in Jun 2025 for a "missed ads attribution" system error and provided **no verification mechanism**. Reconcile Finances API fee lines against our own transaction ledger by order ID; flag ad-fee lines whose order date is >35 days before invoice date, and duplicate order-ID lines. |
| **D8** | **Three-way attribution reconciliation** | Transaction Report vs Ads dashboard vs Payments. The Traffic report is documented-unreliable (misclassifies promoted as organic). Never reconcile ad fees against the Traffic tab. |
| **D9** | **Overlap guard** | General ∩ Priority membership per listing (S1). |

### 4.9 Do not build

`R10` linked-account spread · competitor click-draining (ToS: *"will not use any means to generate fraudulent or invalid clicks, impressions, queries or other interactions"*) · self-clicking own ads · fake watchers/views/sales · GTIN hijacking · false item aspects · deliberate miscategorisation · EPN self-referral (assume prohibited).

Build the **defences** instead: click-fraud anomaly detection to evidence a refund claim, cross-account duplicate detection.

---

## 5. What to steer by

| Metric | Value | Ev. |
|---|---|---|
| Total promotion fees as % of monthly revenue | cap at **3–4%** | `ANECDOTE` |
| Margin gate for any promotion | ≥30% gross margin | `ANECDOTE` |
| Margin gate for Priority/CPC | ≥40% (unbounded per-sale risk) | `ANECDOTE` |
| ASP gate for campaign type | General below ~€30–40 ASP, Priority above. At €0.20 min bid × 2–5% CVR, expected click cost per sale is €4–10 = 15–30% of a €30 item | `INFERRED` |
| Price-floor gate | don't promote sub-€30 items | `ANECDOTE` |
| CTR benchmark | 0.5–2% | `ANECDOTE` |
| CVR benchmark | healthy 2–8%, underperforming <1.5% | `ANECDOTE`, 2 sources agree |
| Review cadence | **weekly, not daily** — daily fluctuation is noise; use 30-day windows | `ANECDOTE` + `VENDOR` |
| Decision data age | **T-4 minimum** (72h reconciliation); **T-35 for CPS ROAS** (30-day window + reconciliation) | `OFFICIAL` |

**The don't-promote list** — strongest cross-source consensus in the entire corpus:

1. Items already ranking page-one organically on their primary keyword — you pay a fee on impressions you already own. Amplified enormously by 2026 attribution.
2. Items with 20+ organic views/day (the quantified version of 1).
3. Thin-margin products.
4. Promoted 60+ days with no sale → pricing/demand problem, not a visibility problem.
5. Promoted 90+ days with no conversion → kill.
6. Best-sellers that will sell anyway.
7. **Multi-quantity / high-velocity listings** (A4).
8. Auction listings.

**Cold start — two opposed camps.** Camp 1 waits 14–30 days and only promotes if getting <20 views/day, to avoid paying for demand you already have. Camp 2 promotes from day one to buy velocity. The measured evidence favours Camp 2 (437 new items @5% → 35 sales/$2,300 vs 1,323 aged @4% → 6 sales; ~8% sell-through vs ~0.5%), but the test is uncontrolled and n=1. Reconciliation: Camp 1 fits replenishable inventory with existing SKU-level rank; Camp 2 fits one-of-one inventory with no rank to inherit. **Segment on whether the SKU has duplicate/near-duplicate sales history.**

Both camps agree on the prerequisite: **optimise the listing before spending.** A well-photographed item at 4% got 3× the clicks of a poorly-lit one at 8% — photo quality beat a 2× ad rate. This is also mechanically self-reinforcing, since photo variety/quality and description clarity are **official inputs to eBay's suggested-rate model** — improving them lowers your suggested rate.

---

## 6. Open questions to settle empirically before shipping

1. **Does end-and-relist reset the click bank?** (A8) Highest value. Matched-cohort test.
2. **The 5% Dynamic floor** — no documentary support. Poll `bidPercentage` daily on a DYNAMIC campaign with `adRateAdjustmentPercent: −50%` across ≥200 SKUs in ≥10 categories; a real floor shows as a hard clamp at 5.0.
3. **The 15-budget-changes/day cap** — no documentary support. Self-impose ≤12/day and treat rejections as the discovered limit.
4. **Does eBay dedup ads by listing within one SERP?** Pivotal for R2/R3. Settle by SERP observation.
5. **Multi-quantity rate timing** — eBay's US page contradicts itself (click-time vs sale-time). Determines whether A1/A2 work on multi-quantity SKUs.
6. **Bulk maxima for keyword/negative/inventory-reference ops** — docs emit `{placeholder}` tokens. Only the 500-per-call figure for listing-ID ad ops is verbatim.
7. **Negative PHRASE via API** — method reference says EXACT+PHRASE, playbook says EXACT only.
8. **50,000-ads-per-campaign vs 500 ad groups × 1,000 ads = 500,000** — internally contradictory. Treat 50,000 as binding.
9. **ES Priority support** — developer doc says unsupported, eBay.es help page fully documents it and ES was in the Jun-2025 slot rollout. Doc is almost certainly stale; handle error 35051 defensively.
10. **Does the CPS fee base use the post-markdown price?** Inference, not eBay's words. Validate against a real invoice.

---

## Research coverage caveats

Reddit is hard-blocked at the egress proxy (403) and filtered from the search index — substituted with Scavenger Life forums and eBay Community boards, which serve the same practitioner function. YouTube transcripts unreachable. eBay `/help/*` pages are robots-disallowed to fetchers, so some official text is reconstructed from Seller Centre, developer docs, and reported staff statements. eBay developer forums block direct fetch, so no API bug war-stories were captured.

**No verified 10k+ SKU eBay Promoted Listings case study exists anywhere.** The largest verified accounts in the corpus are ~3,000 listings / ~£125k/yr. Zero published ACOS or TACOS figures exist in the entire corpus — every vendor reports conversion-count or sales-% lift without cost data. **Treat all vendor lift claims as upper bounds.** Every category ad-rate table is unsourced and two directly contradict each other.

---

## Related Notes

- [[29 - eBay Ads Cockpit Spec (EA-series)]] — the build
- [[20 - Advertising]] — Amazon ads cockpit; patterns to port
- [[12 - eBay Integration]] — provider, OAuth, existing cron jobs
- [[24 - Bulk Operations & Automation]] — bulk substrate to reuse
- [[27 - Bidding Engine Microservice]] — inventory-elasticity, token bucket
- [[23 - Analytics & Insights]] — `/insights/ads`
