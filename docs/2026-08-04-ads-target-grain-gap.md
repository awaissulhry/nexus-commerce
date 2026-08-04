# The AD_TARGET grain is never ingested — and it silently disables a class of rules

**Date:** 2026-08-04 · **Status:** ✅ FIXED — one cron registration. The original diagnosis below was wrong about the cause; the correction is at the end.
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

It also bounds what the wasted-spend number (N6) can say: waste is computable **per search term** but **not per keyword**. Search term is arguably the better grain anyway — it is the thing you negate. *(The EUR 1,958 figure originally cited here was wrong; see the alignment note at the end.)*

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


---

## CORRECTION — the cause was not a missing report type

Everything above about the *symptom* is accurate: 0 AD_TARGET rows, `AdTarget.spendCents`
0 across 5,204 targets, and every target-grain rule dead while every campaign- and
search-term-grain rule matches. That part stands.

The diagnosed *cause* was wrong. I concluded `spTargeting` was never requested because a
grep of `ads-reports.service.ts` did not surface it. It is there, and so is everything
around it:

- `TARGETING_REPORT_TYPE_ID = 'spTargeting'` and `TARGETING_COLUMNS` — line 166
- the ingest dispatch branch — line 512
- `ingestTargetRows()`, fully implemented with target resolution and caching — line 769
- `runTargetingReportCycle()`, fully implemented — line 1105

**`runTargetingReportCycle` was never called.** The search-term and advertised-product
cycles are wired into `ads-sync.job.ts` with crons; the targeting one was not. One
missing registration, and a whole grain of data — plus five rules — went dark.

**Fix:** `ads-report-create-tg`, 02:00 UTC daily, mirroring `ads-report-create-st`.
Schedule overridable via `NEXUS_ADS_REPORT_CREATE_TG_SCHEDULE`.

The plan in the section above — write the spec, write the ingest, write the backfill —
would have rebuilt four things that already existed. Reading the dispatch before writing
the fix is what caught it, and it is the seventh time in this programme that something
fully built turned out simply not to be connected.

**Still true:** `AdTarget.spendCents` remains 0 and will stay 0 — the daily table is
populated by this cron, but the stored aggregates on `AdTarget` are a separate write
that nothing performs. Rules reading those columns rather than the daily table will
still see nothing. That is a genuine remaining gap, smaller than the one diagnosed here.


---

## ALIGNMENT — the wasted-spend figure, reconciled

The reporting session shipped this number in RPT.11 (`ads-business-context.service.ts`)
while I was computing my own. Theirs is right and mine was wrong; this records the
difference so one number survives.

| | Wasted | Terms | Method |
|---|---|---|---|
| **Mine (N6, naive)** | EUR 1,054 | 1,565 | zero-order search-term spend over 30d |
| **Theirs (RPT.11)** | **EUR 243** | **44** | matured window (−7d) + minimum 5 clicks |

Mine was inflated roughly fourfold by three separate errors:

- **EUR 784 across 1,514 terms had fewer than 5 clicks.** A term with one or two clicks
  and no sale is *sampling*, not waste. Theirs requires sustained clicks before calling
  spend wasted.
- **EUR 270 was unmatured.** Amazon attributes sales over 7 days, so clicks in the last
  week have not had time to convert. Theirs excludes them.
- My first pass also filtered per *row* rather than per *term*, so a term that converted
  on one day but not another counted its quiet days as waste. That is where the even
  larger EUR 1,958 I quoted earlier came from.

**Adopt RPT.11 as the single definition.** EUR 243 across 44 terms, and every one of
those 44 is genuinely actionable.

They also reached independently, and documented, the COGS finding: *0 of 362 products
carry a cost price and every ProductProfitDaily row has cogsCents = 0.* The research
claim I repeated several times — that Nexus can beat BidX's wasted-spend figure by
computing from real margin — is false in practice today. Waste here is strictly spend
that produced no attributed sales, and it should say so until costs are loaded.

### The finding that matters more than the number

None of the 44 wasted terms is brand-protected, so the whitelist blocks none of them.
But they are, overwhelmingly, the **generic head terms this entire engagement started
with**: `giubbotto moto uomo` (EUR 22.89 / 49 clicks), `veste moto homme`,
`giacca moto estiva`, `chaqueta moto hombre con protecciones`, `giacca da moto`.

These are the shared keywords across GALE, MOSS and AIREON — the ones the SERP-coverage
question was about. So "wasted spend" here is not obviously a negation list. Spending on
a competitive head term without converting can mean the term is wrong, or it can mean
the listing is not winning a click it legitimately competed for. Negating them would
negate exactly the terms the coverage strategy exists to own.

**Do not auto-negate from this list.** It is a diagnosis surface, not an action queue,
until the coverage work says which of those terms are ones we intend to win.
