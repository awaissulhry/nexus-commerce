# Canonical ads models

AX-IE.1 · decided 2026-07-28 · evidence in `docs/AX-IE-0-1-PLAN.md` §1

The schema carries two generations of ad entities, roughly 10,700 lines apart. They are
**not competing implementations of one thing** — they are two subsystems with disjoint
readers, and one of them is a deliberate, labelled shadow. This file says which is
authoritative so nobody has to re-derive it from line numbers.

## The verdict

| Domain | Canonical | The other one |
|---|---|---|
| Amazon ad campaign / ad group / target / product ad | **`Campaign` · `AdGroup` · `AdTarget` · `AdProductAd`** | `MarketingCampaign` + `AmazonAdsCampaignDetail` — cross-channel **shadow**, non-authoritative until the UM P8 cutover |
| Amazon ad performance | **`AmazonAdsDailyPerformance` · `AmazonAdsHourlyPerformance`** | `CampaignMetric` — shadow for Amazon, but **canonical for eBay** (it has its own writers) |
| Ad targeting | **`AdTarget`** | `CampaignTarget` — dead: 0 rows, 0 code references |
| Amazon budget pooling | **`BudgetPool*`** | `CampaignBudget*` — cross-channel successor, adopt at UM P8 |

## Why

- **Only one generation has live data.** `Campaign` 196 · `AdGroup` 265 · `AdTarget` 4,506 ·
  `AdProductAd` 4,015 · `AmazonAdsDailyPerformance` 25,192, all updating today.
- **Only one generation is read by the ads surface.** 276 advertising routes, the whole
  write path, and every ads cron read Generation A. `AmazonAdsCampaignDetail` and
  `CampaignTarget` have **zero** `prisma.*` references anywhere in `apps/api`, `apps/web`
  or `packages`.
- **The shadow says so itself.** `amazon-backfill.service.ts`: *"Mirrors Campaign /
  AmazonAdsDailyPerformance → the new MarketingCampaign tables; legacy stays authoritative
  until the P8 cutover."*

## What was actually wrong

Not the duplication — the **staleness**. `backfillAmazonShadow` had exactly one caller, a
manual endpoint, and no cron. It ran once at migration time and never again:

| | `Campaign` (Gen A) | `MarketingCampaign` AMAZON (Gen B) |
|---|---|---|
| Rows | 196 | **338** |
| Newest `updatedAt` | live | **2026-05-28** — the migration date |

338 is the **pre-dedup** count from AF.1d (338 → 169 duplicate merge), and
`MarketingCampaignLink` still holds 169. The shadow was a frozen snapshot of a state we
had already fixed.

Live surfaces reading it (`/marketing/campaigns` itself is retired and redirects, so it
is *not* the exposure):

| Route | Symptom |
|---|---|
| **`/marketing/analytics`** | Amazon spend/sales/ROAS frozen at 2026-05-28, blended into cross-channel totals that look current |
| `/marketing/calendar`, `/marketing/budgets`, `/marketing/automation-os` | stale Amazon campaign set |
| `/marketing/campaigns/[id]` | stale detail for deep links |

`/marketing/advertising/campaigns` reads Generation A directly and is correct.

AX-IE.1 fixes that by scheduling the backfill and surfacing its freshness, **not** by
migrating or dropping anything.

## Rules

1. **Anything Amazon-ads-facing reads Generation A.** Exports, reports, rules, bid logic.
2. **Never write Amazon rows into Generation B by hand.** `backfillAmazonShadow` is the
   only writer of `channel=AMAZON` marketing rows; it is delete-then-insert and idempotent.
3. **eBay is different.** `CampaignMetric` is canonical for eBay — it has real writers
   (`ebay-ads-reports.service`, `ebay-backfill.service`). Do not treat it as shadow-only.
4. **Two empty pairs are deliberately left alone.** `BudgetPool*` and `CampaignBudget*` are
   both 0 rows with live code paths. There is no data to disagree and nothing to migrate;
   picking a winner now would be risk without payoff. Revisit at UM P8.
5. **Dropping the dead tables is a separate, destructive gate.** `CampaignTarget`,
   `AmazonAdsCampaignDetail` and the empty budget triplets cost nothing to leave in place.

## Related

`docs/AX-IE-0-1-PLAN.md` · `docs/MARKETING-OS.md` · `obsidian-vault/30 - Amazon Ads Platform Audit.md`
