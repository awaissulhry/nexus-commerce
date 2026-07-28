# Paste-ready Claude Code prompt — EA-series kickoff

Copy everything below the line into your terminal session at the repo root.

---

We are building the eBay Ads cockpit at `/marketing/ads/ebay`. This is the **EA-series**, 12 phases.

Two research documents are in the Obsidian vault and are the authoritative brief. Read both **in full** before writing any code:

- `obsidian-vault/28 - eBay Ads Strategy Research.md` — mechanics, 2025–26 platform changes, API limits and quotas, competitive gaps, and a tagged catalogue of ~60 tactics including grey-area ones
- `obsidian-vault/29 - eBay Ads Cockpit Spec (EA-series).md` — data model, routes, jobs, UI surfaces, phase plan

Also read for context: `12 - eBay Integration`, `20 - Advertising`, `24 - Bulk Operations & Automation`, `27 - Bidding Engine Microservice`, `05 - Database Schema`, `09 - Design System`, `10 - Pages & Routes`.

## What makes this different from the Amazon cockpit

**Every ad decision is made at the level of a shared-inventory pool, not a listing.** We have multiple `ProductFamily` rows containing the same SKU drawing from one `StockLevel` pool, surfaced as N eBay listings across five marketplaces. If we model ads per listing we get four specific failures: we bid against ourselves in eBay's second-price auction and inflate our own clearing price; ACOS becomes unattributable because spend is per-listing and margin is per-SKU; each listing carries its own independent 30-day attribution window so the pool is armed continuously; and stock drains while every listing keeps bidding.

`EbayAdPool` + `EbayAdPoolMember` and invariants I1–I7 in §1 of the spec exist to solve exactly this. **Build them first, in EA.2, before any campaign management.** They are not a later refactor.

## Non-negotiable technical constraints

- **Create `apps/api/src/routes/ebay-ads.routes.ts` as a new file.** Do not extend `advertising.routes.ts` — it is 395 KB, Amazon-shaped, and a duplicate Fastify route registration is a boot crash, not a 4xx. Both files contain `€`, so use `grep -a`.
- **Resolve campaigns by `externalCampaignId` alone, never by name.** This is the AF.1d lesson (338 → 169 duplicate merge) and it applies identically to eBay.
- `/products/ebay-flat-file` and `ebay-flat-file.routes.ts` are **untouchable**. Sync via shared store only.
- Ads routes need a **local `ToastProvider`** — the app shell does not provide one.
- **Marketplace is a partition key in the schema, not an attribute.** eBay campaigns are marketplace-scoped and immutable; IT/DE/FR/ES/UK are peers, not variants of one thing.
- Reuse the existing substrate rather than rebuilding: `AdsDataGrid` (`groupBy` / `onRowClick` / `keyboardNav`), the `Tag` DS primitive, `useColumnResize`, `ImportJob`/`ImportJobRow`/`BulkActionJob`, `BulkProgressBanner`, SSE, BullMQ, and the `services/bidding-engine` sidekick.
- Explicit save with dirty indicator, never silent auto-save (DSP-series). Use `useDirtyRegistry`, `useNavigationGuard`, `useEditorShortcuts` on editor surfaces.

## eBay API realities that will bite if ignored

- **10,000 Marketing "Ads" calls/day.** Reads exhaust this, not writes — `getAds` caps at `limit=500`, so enumerating 100k ads costs 200 calls per campaign per pass. Drive reconciliation off reports, never off `getAds` enumeration. Build the Redis-backed quota governor in EA.1, before anything calls eBay.
- **200 report calls/hour/seller.** Reports are async: `createReportTask` → 202 → poll → gunzip TSV. 30-day retention. **1,000,000-record hard cap — the report FAILS, it does not truncate or page.** Shard by campaign; CPC reports with a `day` dimension are limited to a 7-day range.
- **No idempotency keys anywhere.** Error 35036 ("ad already exists") and 35018 (duplicate IDs in request) are the only dedupe primitives. Treat both as success-equivalent; design the write path for at-least-once delivery.
- **Bulk ops are synchronous 207 Multi-Status.** Iterate `responses[]` per item — an envelope 200 does not mean every item succeeded. Batch size 500, config-driven, back off on 35071.
- **No listing-level eligibility pre-check exists.** Classify errors post-hoc: 35048 ended, 35058 not fixed-price, 35052/35075 category, 35054 marketplace mismatch, 35077 needs Top Rated, 35078 not in good standing.
- **Immutable after launch:** funding model, `campaignTargetingType`, listing selection strategy. `ENDED` is terminal. Every campaign needs a versioned clone-and-swap migration path, not an edit path. Pre-stage the replacement as `SCHEDULED` so there is no dark gap.
- **`adRateStrategy: DYNAMIC` blocks programmatic bid writes entirely** (errors 35010, 35113). Force `FIXED` as a precondition for any bid automation.
- **CPS `bidPercentage` lives on the Ad, not the Campaign** — that is the correct per-listing lever.
- **CPS has no search-term data at all.** Keyword features are inherently Priority/CPC-only.
- Metrics reconcile at **72h**. Never make a decision on data younger than T-4; T-35 for CPS ROAS. Never reconcile fees against the Seller Hub Traffic report — it is documented-unreliable.

## The economics the product is built on

The whole differentiator is that we compute margin-true economics, not revenue ROAS. eBay's own suggested rate optimises eBay's ranking-win probability and takes competitor ad rates as its primary input — it is margin-blind by construction and is a documented bid-escalation ratchet.

```
A     = item price + buyer-paid shipping + tax          (the fee base — includes shipping)
m     = P + S − COGS − ship_cost − (FVF + intl + regulatory)·A − per_order_fee
r_BE  = m / (A · (1 + VAT_on_fees))
r_max = r_BE · (1 − κ)                                   κ = cannibalisation ratio
```

κ is the whole ballgame and nobody in the market measures it. Since the mid-2025 "any-buyer" attribution change, effective cost is `nominal_rate × attribution_share` with attribution share now ~0.85–1.0 rather than ~0.35, so most sellers' mental arithmetic is wrong by about 2.5×. At κ=0.9 the maximum survivable rate on a healthy 40%-margin SKU is 3.3% — barely above the 2% floor.

Implement the calculator in EA.5 and audit it manually against 20 real SKUs before letting anything consume it.

## Autonomy model

**Suggest → human approves.** Nothing writes to eBay without an explicit accept. The engine computes, scores by projected 30-day contribution delta (not revenue), and queues into a review cockpit modelled on the existing S-series at `/marketing/ads/suggestions`.

Every suggestion carries a **risk tag** — `SAFE`, `GREY`, or `UNKNOWN` — with a one-line explanation. Grey-area tactics (rate-drop arbitrage inside the attribution window, burst-and-drop, variation split-out, MPN conquesting, budget-ratchet exploitation) are surfaced with their tag and their rationale, and behave exactly like any other suggestion. We present the mechanism and the risk; the operator decides. The only things we never build are the four in research §4.9 — linked-account spread, click-draining, self-clicking, and fake engagement signals — because they are unambiguously ToS-violating.

Add **keyboard-driven triage with auto-advance** (`j/k` navigate, `a/r/d` act, `u` undo). No ad console in the market has it and it is the cheapest differentiator we can ship.

## How to proceed

1. Read the two vault documents and the related notes.
2. **Do not start coding.** Produce a written implementation plan for **EA.1 and EA.2 only** covering: exact files to create or modify with paths, the Prisma migration, how `poolId` is backfilled from `ChannelListing → ProductVariation → canonical SKU`, the quota governor design, and how you will verify pools resolve correctly for our multi-family shared-SKU cases.
3. Flag anything in the spec that conflicts with what you find in the actual codebase. The spec was written from the vault notes, not from reading the source — treat the source as authoritative where they disagree.
4. Wait for my approval before implementing.

Ten open questions are listed in research §6 that need empirical answers from eBay's sandbox or production — including whether end-and-relist resets the attribution click bank, whether the 5% Dynamic floor is real, and whether eBay dedups ads by listing within a single SERP. Flag which of these block EA.1/EA.2 and which can wait.
