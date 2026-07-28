# eBay Ads Cockpit Spec (EA-series)

→ [[00 - Nexus Commerce MOC]] | [[28 - eBay Ads Strategy Research]] | [[10 - Pages & Routes]]

Route: `/marketing/ads/ebay`. 12 phases. Autonomy model: **suggest → human approves** (mirrors the S-series pattern at `/marketing/ads/suggestions`).

---

## 0. The thesis in one paragraph

eBay opened Priority/CPC to all API developers in Q1 2026 and simultaneously made General/CPS structurally worse (any-buyer attribution, locked out of slot #1). Every incumbent tool's eBay support predates that. Nobody ships profit-aware bidding, incrementality measurement, dayparting, negative-keyword automation, or bulk ops above eBay's 200-listing UI cap. Seller Hub itself has no change history, no rollback, no cross-campaign portfolio view, and returns different numbers on every page reload. We already have the substrate — bulk jobs, BullMQ workers, SSE, AdsDataGrid, the bidding engine, per-marketplace inventory. **The build is small; the moat is that we compute margin-true economics over a stock pool rather than revenue-ROAS over a listing.**

---

## 1. The shared-inventory-pool problem — solve this first

This is the constraint that makes our situation different from every generic eBay ad tool, and it must be modelled before anything else is built.

### 1.1 The situation

Multiple `ProductFamily` rows can contain products with the **same SKU**, drawing stock from a **shared pool** (`StockLevel` per variation per warehouse). Each becomes one or more eBay listings, potentially across five marketplaces. So one unit of physical stock is represented by *N* independently promotable ad objects.

```
StockLevel (one physical pool)
    │
    ├── ProductFamily A → Product → Variation → ChannelListing (eBay IT) → ebay listing 1
    ├── ProductFamily A → Product → Variation → ChannelListing (eBay DE) → ebay listing 2
    ├── ProductFamily B → Product → Variation → ChannelListing (eBay IT) → ebay listing 3   ← same SKU
    └── ProductFamily B → Product → Variation → ChannelListing (eBay UK) → ebay listing 4
```

### 1.2 Four failure modes if we ignore it

| # | Failure | Detail |
|---|---|---|
| **F1** | **Self-inflated clearing price** | eBay's CPC auction is second-price. If listings 1 and 3 bid on the same keyword on eBay.it and are the top two bidders, **your own second bid sets your price**. You pay more for the same slot. |
| **F2** | **Unattributable ACOS** | Ad spend is reported per listing. Margin lives at SKU/pool level. Computing ACOS per listing against a shared cost basis produces garbage. |
| **F3** | **Multiplied attribution tails** | Each listing gets its own independent 30-day armed window. Four listings on one pool = four overlapping windows. The pool is armed effectively continuously, so α→1.0 across the whole pool even at modest click volume. |
| **F4** | **Stockout overspend** | The pool drains but all N listings keep bidding until each is individually throttled. Classic overspend-into-stockout. |

### 1.3 The abstraction: `EbayAdPool`

**Every ad decision is made at pool level and distributed to listings. No listing-level decision exists in the domain model.**

```
EbayAdPool                      keyed on canonical SKU (or explicit stock-pool id)
  ├─ economics                  COGS, contribution margin, r_max, κ estimate
  ├─ stock                      ATP across the shared pool, days-of-cover
  ├─ policy                     target ACOS, max ad rate, max CPC, autonomy tier
  └─ EbayAdPoolMember[]         one per (listing × marketplace)
       ├─ role                  PRIMARY | SECONDARY | SUPPRESSED
       ├─ strategy              GENERAL | PRIORITY | NONE
       ├─ armedUntil            attribution-tail tracking
       └─ realised spend/sales  from Transaction + Listing Performance reports
```

### 1.4 Pool invariants — enforce in the service layer, not the UI

| # | Invariant | Rationale |
|---|---|---|
| **I1** | **One PRIMARY per (pool, marketplace, strategy).** Everything else is SECONDARY at the floor rate or SUPPRESSED. | Kills F1. Only the primary carries the aggressive rate/bid. |
| **I2** | **Keyword sets across pool members on the same marketplace must be disjoint.** Auto-generate cross-member negatives to enforce. | Kills F1 for Priority. |
| **I3** | **No pool member is in both General and Priority simultaneously.** | eBay: *"charged for Attributed Sales from general clicks even if your ad received a subsequent priority click."* You pay both fees. |
| **I4** | **Budget and ACOS targets are set on the pool, then distributed** by expected-contribution weight across members. | Kills F2. |
| **I5** | **Pool-level `armedUntil` = max of member `armedUntil`.** Rate-drop and de-promotion actions apply to the whole pool. | Kills F3 — de-promoting one member while another is armed saves nothing. |
| **I6** | **Inventory-elasticity throttling is pool-scoped.** When pool days-of-cover drops below threshold, throttle **all** members atomically. | Kills F4. Reuses the existing bidding-engine formula. |
| **I7** | **Ad fees, sales and margin roll up to the pool** for every reported metric. Listing-level numbers are diagnostic only, never a decision input. | Kills F2. |

### 1.5 Pool-level decisions the engine makes

- **Which member is PRIMARY per marketplace** — highest listing quality × conversion rate × margin.
- **Split vs consolidate** — model expected incremental impressions from variation split-out against the concentrated ranking signal and the attribution blast radius lost (research §4.5, R3/R4).
- **Which marketplace deserves budget** — measured CPC and conversion divergence across EU sites is large (+313% on .com vs +135% on .de under identical optimisation). Arbitrage is real and pool-scoped.
- **Strategy assignment** — Priority for heroes (removed from General), General at floor for the tail. ASP gate ~€30–40.

---

## 2. Data model

New Prisma models in `@nexus/database`. Prefix `Ebay` to avoid collision with the channel-agnostic `Campaign` from the UM-series.

```prisma
// ── Structure ────────────────────────────────────────────────
model EbayAdCampaign {
  id                  String   @id @default(cuid())
  externalCampaignId  String              // eBay campaignId — RESOLVE BY THIS ALONE, never by name
  marketplaceId       String              // EBAY_IT | EBAY_DE | EBAY_FR | EBAY_ES | EBAY_GB
  fundingModel        EbayFundingModel    // COST_PER_SALE | COST_PER_CLICK
  channels            String[]            // ON_SITE | OFF_SITE
  targetingType       EbayTargetingType?  // MANUAL | SMART — IMMUTABLE after launch
  status              EbayCampaignStatus  // DRAFT SCHEDULED RUNNING PAUSED ENDED DELETED SYSTEM_PAUSED
  name                String              // ≤80 chars, encodes the naming schema
  namingSchema        Json                // parsed components
  bidPercentage       Decimal?            // CPS, 0.1pp precision, 2.0–100.0
  adRateStrategy      EbayAdRateStrategy? // FIXED | DYNAMIC
  dynamicAdRatePrefs  Json?               // adRateAdjustmentPercent, adRateCapPercent
  biddingStrategy     String?             // CPC manual: FIXED | DYNAMIC
  maxCpcCents         Int?                // CPC smart
  dailyBudgetCents    Int?
  campaignCriterion   Json?               // selectionRules[≤10], autoSelectFutureInventory, exclusions
  startDate           DateTime
  endDate             DateTime?
  version             Int      @default(1) // clone-and-swap migration chain
  supersedesId        String?
  @@unique([externalCampaignId, marketplaceId])
  @@index([marketplaceId, status, fundingModel])
}

model EbayAdGroup {
  id            String @id @default(cuid())
  campaignId    String
  externalAdGroupId String
  name          String
  defaultBidCents Int
  status        String   // ACTIVE PAUSED ARCHIVED (terminal)
  themeKey      String?  // brand | model | generic | longtail | competitor | skag
}

model EbayAd {
  id             String @id @default(cuid())
  campaignId     String
  adGroupId      String?
  externalAdId   String
  listingId      String            // eBay listing ID
  channelListingId String?         // FK → our ChannelListing
  poolId         String            // FK → EbayAdPool  ← the important one
  bidPercentage  Decimal?          // CPS: lives on the AD, not the campaign
  intendedBidPct Decimal?          // our ledger, for drift detection (D3)
  status         String
  armedUntil     DateTime?         // attribution tail
  @@index([poolId, campaignId])
  @@index([listingId])
}

model EbayAdKeyword {
  id          String @id @default(cuid())
  adGroupId   String
  externalKeywordId String?
  text        String   // ≤80 chars, ≤10 words, charset-validated
  matchType   String   // EXACT PHRASE BROAD
  bidCents    Int?
  status      String
  source      String   // MANUAL | SUGGESTED | SQP_HARVEST | GENERATED | CONQUEST
  riskTag     String?  // SAFE GREY UNKNOWN — surfaced in UI
}

model EbayAdNegativeKeyword {
  id          String @id @default(cuid())
  campaignId  String?
  adGroupId   String?
  text        String
  matchType   String   // EXACT | PHRASE
  source      String   // MANUAL | SQP_WASTE | CROSS_MEMBER_SHIELD | LADDER_CASCADE
}

// ── The pool ─────────────────────────────────────────────────
model EbayAdPool {
  id                String   @id @default(cuid())
  canonicalSku      String   @unique
  targetAcosBps     Int?
  maxAdRateBps      Int?
  maxCpcCents       Int?
  autonomyTier      EbayAutonomyTier @default(SUGGEST_ONLY)
  kappaEstimate     Decimal?          // cannibalisation, from holdout tests
  rMaxBps           Int?              // computed break-even ceiling
  armedUntil        DateTime?         // max across members
  members           EbayAdPoolMember[]
}

model EbayAdPoolMember {
  id            String @id @default(cuid())
  poolId        String
  channelListingId String
  marketplaceId String
  role          EbayPoolRole  // PRIMARY | SECONDARY | SUPPRESSED
  strategy      String        // GENERAL | PRIORITY | NONE
  @@unique([poolId, channelListingId])
}

// ── Performance ──────────────────────────────────────────────
model EbayAdDailyPerformance {          // from CAMPAIGN/LISTING_PERFORMANCE_REPORT
  date DateTime; campaignId String; adId String?; poolId String?
  impressions Int; clicks Int; ctrBps Int
  adFeesCents Int; salesCount Int; saleAmountCents Int
  cpcSpendCents Int?; cpcClicks Int?
  reconciledAt DateTime?                // 72h flag — never decide on unreconciled rows
  @@index([poolId, date])
}

model EbayAdSearchQuery {               // SEARCH_QUERY_PERFORMANCE_REPORT — CPC only
  date DateTime; campaignId String; adGroupId String
  searchQuery String; keywordId String?; matchType String?
  impressions Int; clicks Int; spendCents Int; salesCount Int; saleAmountCents Int
  triageState String  // NEW | HARVESTED | NEGATED | IGNORED
}

model EbayAdTransaction {               // TRANSACTION_REPORT — the billing truth
  transactionId String @id
  orderId String?; listingId String; campaignId String
  saleType String        // PLG vs PLP split
  adFeeCents Int; saleAmountCents Int; saleDate DateTime
  reconciledFeeCents Int?     // from Finances API — D7 ledger
  discrepancyFlag String?
}

// ── Control plane ────────────────────────────────────────────
model EbayAdSuggestion {
  id String @id @default(cuid())
  poolId String; type String     // RATE_CHANGE BID_CHANGE KEYWORD_ADD NEGATIVE_ADD
                                 // BUDGET_CHANGE STRATEGY_SWITCH SUPPRESS PRIMARY_SWAP
                                 // SPLIT_VARIATION MARKDOWN_INSTEAD OVERLAP_FIX DRIFT_REVERT
  impactScoreCents Int           // sort key — projected 30-day contribution delta
  riskTag String                 // SAFE GREY UNKNOWN
  rationale Json                 // evidence chain, shown in UI
  currentState Json; proposedState Json
  state String                   // PENDING ACCEPTED REJECTED DISMISSED EXPIRED APPLIED FAILED
  dismissedUntil DateTime?       // TTL resurfacing
  batchId String?
}

model EbayAdChangeLog {                 // audit + rollback
  id String @id @default(cuid())
  actorType String    // USER | RULE | SCHEDULER | EBAY_EXTERNAL   ← eBay is a first-class actor
  actorId String?
  entityType String; entityId String
  before Json; after Json
  suggestionId String?; jobId String?
  revertedByLogId String?
  createdAt DateTime @default(now())
}

model EbayAdRule {
  id String @id @default(cuid())
  name String; enabled Boolean
  scopeFilterId String?          // a saved view IS the rule scope
  trigger Json                   // schedule | metric threshold | event
  conditions Json
  actions Json
  guardrails Json                // maxBlastRadius, maxSpendDelta, cooldownHours, requiresApproval
  dryRunOnly Boolean @default(true)
  lastRunAt DateTime?
}

model EbayAdExperiment {               // incrementality — the moat
  id String @id @default(cuid())
  name String; hypothesis String
  stratification Json               // category × price band × trailing velocity
  treatmentCampaignId String?       // autoSelectFutureInventory:false — API-only
  holdoutPoolIds String[]
  startedAt DateTime; minDurationDays Int @default(60)  // 2 attribution windows
  kappaResult Decimal?; confidence Decimal?; state String
}

model EbayAdSavedView {
  id String @id @default(cuid())
  name String; ownerId String?; shared Boolean
  predicate Json                    // filters, NOT an ID list
  columns Json; sort Json
}
```

Enums: `EbayFundingModel`, `EbayTargetingType`, `EbayCampaignStatus`, `EbayAdRateStrategy`, `EbayPoolRole`, `EbayAutonomyTier { SUGGEST_ONLY, AUTO_WITHIN_GUARDRAILS, TIERED }`.

**Migration note:** ~51k rows were wiped in an earlier phase. These tables are additive; no destructive migration. Backfill `poolId` on `EbayAd` from `ChannelListing → ProductVariation → canonical SKU`.

---

## 3. API layer

**Create `apps/api/src/routes/ebay-ads.routes.ts` as a NEW file.** Do not extend `advertising.routes.ts` (395 KB, Amazon-shaped, and a duplicate Fastify route registration is a **boot crash, not a 4xx**). Note the same `grep -a` trap applies — these files contain `€`.

```
GET    /api/ebay-ads/pools                       pool grid, filtered, paginated
GET    /api/ebay-ads/pools/:id                   pool detail + members + economics
PATCH  /api/ebay-ads/pools/:id/policy             target ACOS, caps, autonomy tier
POST   /api/ebay-ads/pools/:id/primary            swap PRIMARY member (I1)

GET    /api/ebay-ads/campaigns                    ?marketplaceId&fundingModel&status
POST   /api/ebay-ads/campaigns                    create (validates immutable fields)
POST   /api/ebay-ads/campaigns/:id/migrate        clone-and-swap for immutable changes (S9)
POST   /api/ebay-ads/campaigns/:id/pause|resume   never `end` from the UI without confirm
PATCH  /api/ebay-ads/campaigns/:id/budget          ratchet-aware, ±0.50 min delta, ≤12/day

GET    /api/ebay-ads/ads                          ?poolId&campaignId&marketplaceId
POST   /api/ebay-ads/ads/bulk                     preview | apply, batches of 500
POST   /api/ebay-ads/ads/bulk/preview             diff, never a row dump

GET    /api/ebay-ads/keywords                     ?adGroupId
POST   /api/ebay-ads/keywords/bulk
POST   /api/ebay-ads/keywords/generate            ladder | skag | longtail | conquest | misspell
GET    /api/ebay-ads/negatives
POST   /api/ebay-ads/negatives/reconcile          K2 cascade + cross-member shield (I2)

GET    /api/ebay-ads/search-queries               SQP triage queue
POST   /api/ebay-ads/search-queries/triage        bulk harvest | negate | ignore

GET    /api/ebay-ads/suggestions                  ?type&riskTag&minImpact — sorted by impactScoreCents
POST   /api/ebay-ads/suggestions/bulk-action      accept | reject | dismiss(ttl)

GET    /api/ebay-ads/rules
POST   /api/ebay-ads/rules/:id/dry-run            mandatory before enable

GET    /api/ebay-ads/experiments
POST   /api/ebay-ads/experiments                  builds holdout + frozen cohort

GET    /api/ebay-ads/reconciliation               D7 fee ledger + D8 three-way
GET    /api/ebay-ads/drift                        D3/D6 settings + rate drift

GET    /api/ebay-ads/events                       SSE — job progress, drift alerts, budget breach
```

**Local `ToastProvider` required** — the app shell does not provide one on ads routes (same gotcha as the S-series).

---

## 4. Jobs & workers

New files in `apps/api/src/jobs/`, registered with BullMQ. All eBay Marketing API calls route through a **quota governor** (§5).

| Job | Cadence | Purpose |
|---|---|---|
| `ebay-ads-sync.job.ts` | 4h | Campaign/adGroup/ad/keyword reconcile. **Report-driven, not `getAds`-enumeration** — reads exhaust the quota. |
| `ebay-ads-report-pull.job.ts` | daily | `createReportTask` → poll → gunzip TSV → upsert. Shard by campaign and by ≤7-day window for CPC-with-`day`. Guard the 1M-record cap. |
| `ebay-ads-transaction-reconcile.job.ts` | daily | Transaction Report × Finances API → `EbayAdTransaction.discrepancyFlag` (D7) |
| `ebay-ads-drift-monitor.job.ts` | hourly | `bidPercentage` vs `intendedBidPct`; campaign settings snapshot diff (D3, D6). Catches Easy Boost, Boost button, Dynamic takeover. |
| `ebay-ads-armed-window.job.ts` | hourly | Maintain `armedUntil` per ad, roll up to pool. Drives A1/A2/A3 scheduling. |
| `ebay-ads-rate-scheduler.job.ts` | 15 min | Executes approved burst-and-drop / rate-drop schedules (A1, A2). |
| `ebay-ads-dayparting.job.ts` | 15 min | Recipe A/C bid and budget stepping (P4). Quota-aware. |
| `ebay-ads-budget-guard.job.ts` | 15 min | Ratchet-aware envelope tracking; `pauseCampaign` on true cumulative cap (P1, P6). |
| `ebay-ads-sqp-harvest.job.ts` | weekly | K1 loop on T-4 data → suggestions, never direct writes. |
| `ebay-ads-negative-reconcile.job.ts` | daily | K2 cascade + I2 cross-member shielding. |
| `ebay-ads-pool-elasticity.job.ts` | hourly | Pool days-of-cover → throttle all members atomically (I6). Calls the bidding engine. |
| `ebay-ads-overlap-guard.job.ts` | daily | I3 General ∩ Priority; I1 multiple PRIMARY. |
| `ebay-ads-suggestion-engine.job.ts` | 6h | Recompute `r_max`, impact scores, generate/expire suggestions. |
| `ebay-ads-enrolment-drift.job.ts` | daily | D5 rules-based under-enrolment repair. |
| `ebay-ads-experiment-runner.job.ts` | daily | Cohort integrity, κ computation at maturity. |

**Bidding engine extension** (`services/bidding-engine`, sidekick pattern, no DB access): add `POST /ebay/optimize` accepting `{ poolId, strategy, currentRateBps|currentBidCents, poolAtp, safetyStock, targetAcosBps, contributionMarginCents, kappa }` → `{ recommendedRateBps|recommendedBidCents, reason }`. Add a **second token bucket keyed to eBay's 10,000/day Ads quota** alongside the existing Amazon bucket. Keep `X-Dry-Run` support — it is how every rule preview is computed.

---

## 5. Quota governor — non-negotiable

A single Redis-backed governor in front of every Marketing API call.

```
Buckets:  ads_write   10,000/day   (campaign, ad, ad_group, keyword, negative)
          reports        200/hour  per seller
          promotions 100,000/day
          analytics      100/day   (traffic_report)
```

Rules:
- Poll `GET /developer/analytics/v1_beta/user_rate_limit` before any large batch to read the *real* ceiling (it may have been raised).
- **Apply for eBay's Application Growth Check before launch.** Defaults are explicitly sized for individuals.
- Reserve a daily floor for interactive user actions so a runaway sync cannot lock the UI out.
- Batch size 500, config-driven, back off on error 35071.
- **Dedupe client-side** — error 35018 is duplicate IDs in one request.
- **Treat 35036 ("ad already exists") and 35018 as success-equivalent.** There is no idempotency key anywhere in the API; the write path must tolerate replays.
- Bulk ops are synchronous **207 Multi-Status** — iterate `responses[]` per item; an envelope 200 does not mean every item succeeded.
- Retry on **35061** (campaign syncing); refuse writes on **35063** (campaign ending).
- Classify eligibility errors post-hoc — there is no listing-level pre-check endpoint. Map 35048/35058/35052/35054/35057/35077/35078 to human-readable causes.

---

## 6. UI surfaces

`apps/web/src/app/marketing/ads/ebay/`. Reuse `AdsDataGrid` (`groupBy`, `onRowClick`, `keyboardNav`), the `Tag` DS primitive, `useColumnResize`, and the S-series review layout.

### 6.1 `/marketing/ads/ebay` — Pool Grid (the home surface)

**Rows are pools, not campaigns and not listings.** This is the central design decision and the thing no competitor does.

Columns: SKU · pool ATP / days-of-cover · members (chips per marketplace, PRIMARY highlighted) · strategy mix · blended ad spend · attributed sales · **contribution after ad fee** · **effective rate (`nominal × α`)** · `r_max` · headroom · armed-window bar · risk flags.

- Marketplace filter chips (IT/DE/FR/ES/UK) with per-site divergence visible side by side.
- Saved views are **named, addressable, shareable objects** whose predicate is directly reusable as a rule scope.
- Select-all-across-pages is a **filter reference, not an ID list** — the confirm dialog shows the predicate and the count ("all 12,431 matching", not "40 on this page"). Exclusions model as `filter + excludeIds[]`.
- Sticky freeze, density-aware rows, Preferences modal — same as the PG-series.

### 6.2 `/marketing/ads/ebay/pools/[sku]` — Pool Detail

Sections: economics (the break-even calculator with κ slider and live `r_max`) · members table with role assignment · per-marketplace performance · armed-window timeline · split-vs-consolidate simulator · change history filtered to this pool.

### 6.3 `/marketing/ads/ebay/campaigns` and `/campaigns/[id]`

Standard campaign management, but every mutation is diffed and every immutable field is visibly locked with a "migrate" affordance instead of a disabled input.

### 6.4 `/marketing/ads/ebay/suggestions` — Review Cockpit

Extends the S-series pattern. **This is where the autonomy model lives.**

- Suggestions **bundled into cards** by pool, sorted by `impactScoreCents` (projected 30-day contribution delta, not revenue).
- Three-verb triage: **Accept · Reject · Dismiss(TTL)**. A card clears only when fully resolved.
- **Keyboard-driven triage with auto-advance** — `j/k` navigate, `a/r/d` act, `u` undo. Absent from every ad console studied; the single cheapest differentiator.
- Every card shows: rationale evidence chain, `riskTag` badge (`SAFE` / `GREY` / `UNKNOWN`), current → proposed diff, and the blast radius.
- **`GREY` and `UNKNOWN` suggestions render with a distinct badge and a one-line explanation of why**, then behave exactly like any other suggestion. We surface the risk; the operator decides.
- Bulk accept across a filtered set, with the same predicate-based selection semantics as the grid.

### 6.5 `/marketing/ads/ebay/keywords` — Keyword Workbench

SQP triage queue (harvest / negate / ignore, keyboard-driven) · match-type ladder builder · negative reconciliation preview · generators (SKAG, long-tail permutation, misspelling, MPN/conquest) each labelled with its risk tag · keyword validator enforcing 80 chars / 10 words / charset.

### 6.6 `/marketing/ads/ebay/bulk` — Bulk Sheet Round-Trip

Download current state as a sheet → edit → re-upload → **validate and preview as a diff** → apply as a durable async job with per-row errors and a re-submittable failure file.

Polymorphic rows keyed on an `Entity` discriminator plus an `Operation` verb column that is a no-op when blank (the Amazon/Google bulk-sheet convention). Reuses the existing `ImportJob`/`ImportJobRow`/`BulkActionJob` substrate and `BulkProgressBanner` over SSE.

### 6.7 `/marketing/ads/ebay/rules` — Rule Engine

Plain-language conditions. **Dry-run is mandatory before enable** — a rule cannot be switched on until its preview has been viewed. Guardrails live inside the action definition: max blast radius, max spend delta, cooldown hours, requires-approval flag. Plus a **global kill switch** and post-execution anomaly auto-revert.

Rule-run-level undo, not per-change undo.

### 6.8 `/marketing/ads/ebay/experiments` — Incrementality

Holdout builder (stratify by category × price band × trailing velocity, 20% holdout) · frozen-cohort campaign creation via `autoSelectFutureInventory: false` · 60-day minimum with a visible countdown · κ result feeding straight back into every pool's `r_max`.

Switch-back design as the cheaper alternative for sellers who can't spare holdout inventory.

### 6.9 `/marketing/ads/ebay/health` — Reconciliation & Drift

D3/D6/D7/D8 in one surface. Fee ledger discrepancies, settings drift, three-way attribution reconciliation, `SYSTEM_PAUSED` alerts, enrolment drift, Easy Boost detection.

**This is the surface customers will screenshot.** eBay gives them no way to verify their own invoices.

---

## 7. Phase plan (EA-series)

| Phase | Scope | Gate |
|---|---|---|
| **EA.1** | Provider + OAuth scopes (`sell.marketing`, `sell.account`), quota governor, sandbox harness, `getAdvertisingEligibility` per marketplace | Sandbox round-trip on all 5 EU sites |
| **EA.2** | Schema + migrations + `poolId` backfill; `EbayAdPool` / `EbayAdPoolMember` construction from existing `ChannelListing` data | Pools resolve correctly for every multi-family shared-SKU case |
| **EA.3** | Read path: `ebay-ads-sync`, `ebay-ads-report-pull`, report sharding, 72h reconciliation flags | Full catalogue synced inside quota, twice daily |
| **EA.4** | Pool Grid + saved views + predicate selection + per-marketplace chips | Pool-level ACOS and contribution reconcile against eBay's own numbers ±2% |
| **EA.5** | Economics engine: `r_max`, effective-rate α, break-even calculator, don't-promote list | Numbers survive a manual audit on 20 real SKUs |
| **EA.6** | Bulk layer: preview-diff, durable jobs, per-row errors, sheet round-trip, 500-batching, 207 handling | 10,000-ad rate change applies with a full audit trail and zero silent failures |
| **EA.7** | Suggestion engine + review cockpit + keyboard triage + risk tags | Suggestions are accepted at >50% and rejected suggestions carry a reason |
| **EA.8** | Priority/CPC: ad groups, keyword ladder, SQP harvest, negative reconciliation, cross-member shielding | Self-competition eliminated on a measured pool |
| **EA.9** | Rules engine + dry-run + guardrails + kill switch + rule-run undo | A rule executes 1,000 changes and is reverted in one click |
| **EA.10** | Scheduling: rate scheduler (A1/A2), dayparting (P4), budget guard (P1/P6), armed-window tracking | Burst-and-drop measurably lowers blended effective rate on a test cohort |
| **EA.11** | Health surface: fee reconciliation, drift monitors, three-way attribution, Easy Boost detection | A real billing discrepancy is caught and evidenced |
| **EA.12** | Experiments: holdout builder, κ measurement, feed back to `r_max`; promotions arbitration (markdown vs rate) | First κ result lands with confidence intervals |

**Ship order rationale:** EA.1–EA.6 make us better than Seller Hub at basic operation. EA.7–EA.10 make us better than every competitor. EA.11–EA.12 make us defensible.

---

## 8. Design constraints inherited from the codebase

- **Untouchable:** `/products/ebay-flat-file` page and `ebay-flat-file.routes.ts`. Sync via shared store only.
- **New route file** — never add routes to `advertising.routes.ts`. Duplicate Fastify route = boot crash.
- `grep -a` when searching these files (they contain `€`).
- **Resolve campaigns by `externalCampaignId` alone, never by name.** This is the AF.1d lesson (338 → 169 duplicate merge) and it applies identically here.
- Ads routes need a **local `ToastProvider`**.
- Reuse `useDirtyRegistry`, `useNavigationGuard`, `useEditorShortcuts` for any editor surface; explicit save with dirty indicator, never silent auto-save (DSP-series).
- SSE via the existing real-time substrate; `BulkProgressBanner` for job progress.
- Per-marketplace is a **first-class partition key in the schema**, not an attribute — eBay campaigns are marketplace-scoped and immutable.

## 9. Cross-cutting rules

1. **Never decide on data younger than T-4.** T-35 for CPS ROAS.
2. **Never reconcile ad fees against the Seller Hub Traffic report** — it is documented-unreliable.
3. **Force `adRateStrategy: FIXED`** as a precondition for any bid automation (DYNAMIC blocks programmatic writes, errors 35010/35113).
4. **Every campaign gets an end date** — some of eBay's own automated controls require one.
5. **Pause, never end** — `ENDED` is terminal.
6. **Log every silent cap.** If we truncate, sample, or skip, it appears in the job record. Silent truncation reads as "covered everything" when it didn't — which is exactly the 50,000-ad bug eBay itself ships.
7. **eBay is a first-class actor in the audit log.** When a rate changes and it wasn't us, that is a logged event with `actorType: EBAY_EXTERNAL`, not a mystery.

---

## Related Notes

- [[28 - eBay Ads Strategy Research]] — evidence base, tactic catalogue, open questions
- [[20 - Advertising]] · [[27 - Bidding Engine Microservice]] · [[24 - Bulk Operations & Automation]] · [[12 - eBay Integration]] · [[05 - Database Schema]] · [[09 - Design System]]
