# The AD_TARGET grain is never ingested — and it silently disables a class of rules

**Date:** 2026-08-04 · **Status:** diagnosed, precisely located, **not fixed**
**Found while:** computing the wasted-spend figure for ADX N6.

---

## The finding

Nexus requests four Amazon report types. **`spTargeting` is not one of them.**

| Requested | Constant | Grain ingested |
|---|---|---|
| `spCampaigns` | `CAMPAIGN_REPORT_TYPE_ID` | CAMPAIGN |
| `spSearchTerm` | `SEARCH_TERM_REPORT_TYPE_ID` | search terms |
| `spCampaigns` + `groupBy=campaignPlacement` | `PLACEMENT_REPORT_TYPE_ID` | placements |
| `spAdvertisedProduct` | `ADVERTISED_PRODUCT_REPORT_TYPE_ID` | PRODUCT_AD |
| — | **missing** | **AD_TARGET (keyword / product / auto targets)** |

Measured on prod, last 30 days:

```
AmazonAdsDailyPerformance by entityType
  PRODUCT_AD   5,726 rows   2,632 clicks   EUR 1,542
  CAMPAIGN       946 rows   3,984 clicks   EUR 2,264
  AD_TARGET        0 rows

AdTarget.spendCents > 0 : 0 of 5,204 targets
```

## Why it matters more than it looks

A whole class of automation rules triggers on target grain, and **none of them has ever matched once** — not because their conditions are wrong, but because there is no data for them to evaluate.

| Never matched | Matches fine |
|---|---|
| `KEYWORD_LOW_CTR`, `KEYWORD_ZERO_IMPRESSIONS`, `KEYWORD_WASTED_SPEND`, `KEYWORD_HIGH_ACOS`, `AD_TARGET_UNDERPERFORMING` | `SCHEDULE` (5,869 matches), `SEARCH_TERM_CONVERTING` (4,131), `CAC_SPIKE` (2,529), `CAMPAIGN_PERFORMANCE_BUDGET` (1,532) |

**Every dead trigger is target-grain. Every live trigger is campaign or search-term grain.** That is not a coincidence, and it corrects an earlier conclusion in this programme that those rules were simply badly conditioned and might be deletion candidates. They are blocked on an ingest gap.

It also bounds what the wasted-spend number (N6) can say: waste is computable **per search term** (EUR 1,958 over 30 days, 2,498 terms) but **not per keyword**. Search term is arguably the better grain anyway — it is the thing you negate — but the distinction should be stated rather than blurred.

## Where the fix goes

Everything needed already has a working sibling to copy; nothing here is novel.

1. **`ads-reports.service.ts`** — add `TARGETING_REPORT_TYPE_ID = 'spTargeting'` plus its column list, mirroring `ADVERTISED_PRODUCT_REPORT_TYPE_ID` / `ADVERTISED_PRODUCT_COLUMNS` (~line 144). Amazon v3 `spTargeting` supports `date, campaignId, adGroupId, keywordId, keyword, keywordType, matchType, targeting, impressions, clicks, cost, sales7d, purchases7d, unitsSoldClicks7d`.
2. **The ingest writer** — `ads-reports.service.ts:554` and `:778` are the two `amazonAdsDailyPerformance.upsert` sites. A targeting branch writes `entityType='AD_TARGET'`, resolving `keywordId` → `AdTarget.externalTargetId` for `localEntityId`.
3. **A create cron** — mirror `ads-report-create-st` (search terms). Poll and ingest already dispatch generically off `AmazonAdsReportJob`.
4. **Backfill** `AdTarget.spendCents` / `salesCents` from the new rows, since several rule conditions read the stored aggregates rather than the daily table.

## Why this is not fixed in the same session that found it

It is a new report type end to end — spec, creation, polling, ingest mapping, entity resolution and a backfill — in a subsystem I was still discovering while diagnosing it. It deserves a focused start rather than the tail of a long session in which I had already corrupted a file with a bad index slice, nearly registered a duplicate route that would have crashed the boot, and shipped a regression my own test caught.

The finding is precise and the fix is well-signposted. That is the useful deliverable here; the build should be its own piece of work.

## Related open items

- Six enabled rules stay permanently dead until this lands.
- The N6 wasted-spend surface is still unbuilt; the number exists (EUR 1,958 / 30d) but should be sanity-checked against campaign spend (EUR 2,264 / 30d) before being published as a headline — the two come from different reports with different attribution windows.
