/**
 * MCP full control A1 (docs/mcp-full-control/sections/01-ads.md §4) — the Amazon campaign list, moved out of
 * `GET /advertising/campaigns` (advertising.routes.ts) WITHOUT a behaviour change, so the route and a Claude read tool
 * share one code path. The route answers exactly what this returns, with its own Cache-Control header.
 *
 * With no date params it reads the stored campaign columns (the fast path other callers use); with preset /
 * startDate / endDate / windowDays the metrics are derived for that window from AmazonAdsDailyPerformance (CBN.2g).
 * The comments below travelled with the code; the reasoning in them is unchanged.
 */
import prisma from '../../db.js'
import { Prisma } from '@prisma/client'
import { AMS_DAILY_MARKER } from '../ads-core/ams-daily.js'
import { ntbIsPublishedFor } from '../ads-core/metrics-math.js'
// ADM-P6/DC — THE definition of ad-attributed sales (see ads-core/ad-sales.ts).
import { adSalesCents } from '../ads-core/ad-sales.js'

/** The query `GET /advertising/campaigns` accepts. All strings, as Fastify parses a query. */
export interface AmazonCampaignListQuery {
  marketplace?: string
  status?: string
  search?: string
  limit?: string
  preset?: string
  startDate?: string
  endDate?: string
  windowDays?: string
}

/** The Amazon campaign list (cached 300 s per business and query, as the route always was). */
export async function listAmazonCampaigns(q: AmazonCampaignListQuery) {
  const where: Record<string, unknown> = {}
  if (q.marketplace) where.marketplace = q.marketplace
  if (q.status) where.status = q.status
  if (q.search) where.name = { contains: q.search, mode: 'insensitive' }
  const limit = Math.min(Number(q.limit) || 200, 500)

  // CBN.2g — date-windowed metrics. When the Ad Manager passes a range
  // (preset/startDate/endDate/windowDays) the spend/sales/etc. are derived LIVE
  // from AmazonAdsDailyPerformance for that window (the same authoritative source
  // the detail page + trends use). With no date params we keep the fast stored
  // columns, so other callers are unchanged.
  const qd = q as { preset?: string; startDate?: string; endDate?: string; windowDays?: string }
  const hasDateParams = !!(qd.preset || qd.startDate || qd.endDate || qd.windowDays)
  const { resolveRange } = await import('../ads-core/date-range.js')
  const range = hasDateParams ? resolveRange(qd) : null

  const { cached } = await import('./ads-cache.js')
  const rangeKey = range ? `${range.sinceStr}:${range.untilStr}` : 'stored'
  const cacheKey = `campaigns:${q.marketplace ?? ''}:${q.status ?? ''}:${q.search ?? ''}:${limit}:${rangeKey}`
  const result = await cached(cacheKey, 300, async () => {
    const campaigns = await prisma.campaign.findMany({
      where,
      orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
      take: limit,
      select: {
        id: true,
        name: true,
        type: true,
        adProduct: true,
        status: true,
        marketplace: true,
        externalCampaignId: true,
        dailyBudget: true,
        biddingStrategy: true,
        impressions: true,
        clicks: true,
        spend: true,
        sales: true,
        acos: true,
        roas: true,
        trueProfitCents: true,
        trueProfitMarginPct: true,
        lastSyncedAt: true,
        lastSyncStatus: true,
        // H.2: v1 export populates these — surface in the table for
        // operators to see *why* a campaign isn't serving.
        deliveryStatus: true,
        deliveryReasons: true,
        // Ads-console table columns (image #6 defaults).
        startDate: true,
        endDate: true,
        portfolioId: true,
        // P2 (Trading Desk Ad Manager): placement multipliers live here.
        dynamicBidding: true,
        // ADX G2 — the absolute bid bounds the write gate enforces, so the grid can
        // show at a glance which campaigns are unbounded.
        minBidCents: true,
        maxBidCents: true,
        // ADM-H P1, RESTORED 2026-08-26 — the BUDGET twin of the pair above, enforced by the
        // same `ads-write-gate.ts` on every budget write. The Ad Manager's Min/Max Budget cell
        // read `c.minMaxBudget`, a key this response has never sent, so it printed "None" on
        // 220 of 220 rows while its pencil wrote React state that died on reload. The cell and
        // the `PATCH /advertising/campaigns/:id/guardrails` writer both speak these cents; only
        // the SELECT was missing, and it was lost with the rest of P1 in the 2026-08-22 rebase.
        // Currently unset on 220 of 220 campaigns — so "None" stays the honest reading, but it
        // is now a reading rather than a hard-coded absence, and the editor round-trips.
        minBudgetCents: true,
        maxBudgetCents: true,
      },
    })
    // P2 — derive inline placement multipliers (ToS/PDP/RoS) from
    // Campaign.dynamicBidding.placementBidding so the Ad Manager grid can
    // show them as columns without an extra per-campaign fetch. The heavy
    // dynamicBidding JSON is stripped from the response.
    const base = campaigns.map((c) => {
      const { dynamicBidding, ...rest } = c
      const db = (dynamicBidding ?? {}) as { placementBidding?: Array<{ placement: string; percentage: number }>; targetAcos?: number; bidAutomation?: boolean; bidAlgorithm?: string }
      const pb = db.placementBidding ?? []
      const find = (kw: string) => {
        const m = pb.find((p) => p.placement?.toLowerCase().includes(kw))
        return m ? m.percentage : null
      }
      // CBN.2h.6 — surface the Bulk-Actions-managed settings inline (stored in
      // dynamicBidding alongside placementBidding). targetAcos is a fraction
      // (0.3 = 30%) — the same shape the bid-optimizer reads.
      // C1 (2026-08-20) — `bidAlgorithm` joins them. Amazon exposes no per-campaign
      // bid-algorithm field, so this is OUR store for the Adtomic-cluster picker. It was
      // React state in the Ad Manager grid and nothing else: the choice died on reload, and
      // Apply Rules could never show what the Ad Manager had been told. Null means nobody has
      // chosen; the cell names its own fallback rather than the payload asserting one.
      return { ...rest, placements: { tos: find('top'), pdp: find('product'), ros: find('rest') }, targetAcos: db.targetAcos ?? null, bidAutomation: db.bidAutomation ?? false, bidAlgorithm: db.bidAlgorithm ?? null }
    })

    if (!range) return { items: base, count: base.length, range: null }

    // CBN.2g — override the stored columns with window-aggregated metrics from the
    // daily-performance table, batched across the whole list (2 groupBys). The
    // localEntityId match + entityId fallback (rows that never linked locally)
    // mirrors the detail endpoint's OR-match without double-counting.
    //
    // AX2.3 — the "without double-counting" claim held only while
    // localEntityId:null meant "campaign we could not link". Amazon Marketing
    // Stream broke that: its daily upsert never set localEntityId, so 659
    // rows for campaigns that ARE linked fell into the fallback bucket and
    // were ADDED to the report figures — inflating spend, sales, impressions,
    // clicks and orders (and therefore ACoS/ROAS) for every IT campaign with
    // AMS coverage. Reports own the daily grain; AMS owns hourly. Excluding
    // the stream's marker here fixes the arithmetic without deleting data.
    const ids = campaigns.map((c) => c.id)
    const extIds = campaigns.map((c) => c.externalCampaignId).filter(Boolean) as string[]
    const n = (v: bigint | number | null | undefined) => Number(v ?? 0)
    const m2c = (v: bigint | number | null | undefined) => Math.round(Number(v ?? 0) / 10000)
    const dateFilter = { gte: range.since, lte: range.until }
    /**
     * ADM-H P3, RESTORED 2026-08-26 — the seven columns that rendered "unknown" forever.
     *
     * `Sale Units`, `SameSKU Sales/Sale Units/Orders`, `Other Sales`, `Other Sales %` and `ASP`
     * all have their cells built and deployed in CampaignsGrid; the SELECT that feeds them was
     * lost to a rebase on 2026-08-22 and never re-landed, so the payload simply never carried
     * the keys. Measured on prod 2026-08-26: 100 of 100 rendered rows read "unknown" while
     * `units7d` had data on 302 of 302 report rows and the SameSKU trio on 183 of 302.
     *
     * 🔴 The SameSKU window must match the SALES window or the halo subtraction below is
     * nonsense — `adSalesCents` reads `sales7dCents`, so these read the `*SameSku7d*` twins.
     * Mixing 7d sales with 14d same-SKU would produce negative halo on real campaigns.
     *
     * `_count` rides beside `_sum`: these columns are nullable and Amazon leaves them unset for
     * campaigns it has not attributed. Prisma sums null as 0, so without the count an
     * unreported figure becomes a confident "0 units sold" — the exact class of lie
     * `feedback_100_percent_honest_ui` forbids. Zero counted rows ⇒ null ⇒ the cell says
     * "unknown".
     */
    const _sum = {
      impressions: true, clicks: true, costMicros: true, sales7dCents: true, sales14dCents: true, orders7d: true,
      units7d: true, salesSameSku7dCents: true, ordersSameSku7d: true, unitsSameSku7d: true,
      // ADM-A3 — new-to-brand and KENP. Requested from Amazon for the first time on 2026-08-26:
      // SB/SD publish newToBrand*, SP publishes the two kindle columns, and CAMPAIGN_COLUMNS had
      // asked for none of them, which is why all four legacy fields were 0 on 6,045 rows.
      ntbOrders14d: true, ntbSalesCents14d: true, ntbUnits14d: true,
      kenpRead14d: true, kenpRoyaltiesCents14d: true,
    } as const
    const _count = {
      units7d: true, salesSameSku7dCents: true, ordersSameSku7d: true, unitsSameSku7d: true,
      ntbOrders14d: true, ntbSalesCents14d: true, ntbUnits14d: true,
      kenpRead14d: true, kenpRoyaltiesCents14d: true,
    } as const
    // 🔴 ntbOrdersRate14d is a RATE, so it goes through _avg, never _sum — adding a rate across
    // days produces a number with no meaning (7 days at 20% would read 140%). Same reasoning as
    // weightedIS above; this one Amazon publishes per day, so a mean over the reported days is
    // the faithful reading.
    const _avg = { ntbOrdersRate14d: true } as const
    const [byLocal, byExt] = await Promise.all([
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: dateFilter }, _sum, _count, _avg }),
      prisma.amazonAdsDailyPerformance.groupBy({ by: ['entityId'], where: { entityType: 'CAMPAIGN', entityId: { in: extIds }, localEntityId: null, reportRunId: { not: AMS_DAILY_MARKER }, date: dateFilter }, _sum, _count, _avg }),
    ])
    const mapL = new Map(byLocal.map((r) => [r.localEntityId, r._sum]))
    const mapE = new Map(byExt.map((r) => [r.entityId, r._sum]))
    const cntL = new Map(byLocal.map((r) => [r.localEntityId, r._count]))
    const cntE = new Map(byExt.map((r) => [r.entityId, r._count]))
    const avgL = new Map(byLocal.map((r) => [r.localEntityId, r._avg]))
    const avgE = new Map(byExt.map((r) => [r.entityId, r._avg]))
    /**
     * ADM-H P2, RESTORED — Average Budget Utilization.
     *
     * 🔴 The arithmetic is the whole point. Total spend ÷ average budget is WRONG and the Budget
     * Manager already paid for that lesson: after a cut, an averaged denominator makes a EUR1.00
     * campaign read 392% utilised. So this takes **each day's spend ÷ THAT day's budget, then
     * averages the ratios** — `campaignBudgetCents` is what Amazon reported the budget to be on
     * that date, so a mid-window budget change is handled by construction.
     *
     * `days` rides beside it because the window the operator picked and the days Amazon has
     * actually reported are different numbers, and a cell saying "7-day average" over 4 days of
     * data would be inventing three days.
     *
     * NULL, never 0, when nothing is measurable: a campaign with no report row was not served,
     * which is not the same as spending none of its budget.
     *
     * Deliberately RAW rather than a Prisma groupBy: `campaignBudgetCents` is not in the
     * committed schema (it belongs to SPC.1's uncommitted block), and raw SQL reads the column
     * that is really there. That also keeps this free of a dependency on another session's
     * unlanded work — which is how the original of this query came to be lost.
     */
    const avgUtilRows = ids.length
      ? await prisma.$queryRaw<Array<{ cid: string; util: number | null; days: bigint }>>`
          WITH d AS (
            SELECT "localEntityId" AS cid, "date",
                   SUM("costMicros") / 10000.0     AS spend_cents,
                   MAX("campaignBudgetCents")::int AS budget_cents
            FROM "AmazonAdsDailyPerformance"
            WHERE "entityType" = 'CAMPAIGN'
              AND "localEntityId" IN (${Prisma.join(ids)})
              AND "date" >= ${range.since} AND "date" <= ${range.until}
            GROUP BY 1, 2
          )
          SELECT cid,
                 AVG(spend_cents / NULLIF(budget_cents, 0))::float8 AS util,
                 COUNT(*) FILTER (WHERE budget_cents > 0)           AS days
          FROM d GROUP BY cid
        `
      : []
    const avgUtilById = new Map(avgUtilRows.map((r) => [r.cid, r]))

    /**
     * ADM-A2 — Top of Search impression share. The column read "unknown" on every row.
     *
     * 🔴 It is NOT an honest absence, and the obvious check says it is. `topOfSearchIS` exists on
     * BOTH `AmazonAdsDailyPerformance` and `AmazonAdsPlacementReport`; the daily-performance copy
     * is abandoned and stopped being written on 2026-08-19, so sampling that table over a recent
     * window returns 0 of 302 and reads exactly like "Amazon reports nothing". The live source is
     * the PLACEMENT report — 1,460 non-null rows, current to 2026-08-24, refreshed nightly by
     * `tos-is-ingest` (213 rows updated 2026-08-26). Nothing read it into this payload.
     *
     * Only TOP rows ever carry the column, so `topOfSearchIS: { not: null }` is the whole filter —
     * matching on a placement label would couple this to Amazon's wording for that bucket.
     *
     * `weightedIS` is IMPORTED, not reimplemented: an impression share is a ratio, so days are
     * weighted by impressions and never averaged flat. A second copy of that rule is how two
     * surfaces start quoting different shares for the same campaign.
     *
     * `days` rides beside the value for the same reason it does on avgBudgetUtil — the window the
     * operator picked and the days Amazon actually reported are different numbers.
     */
    const { weightedIS } = await import('./placement-grid.service.js')
    const tosRows = extIds.length
      ? await prisma.amazonAdsPlacementReport.findMany({
          where: { campaignId: { in: extIds }, date: dateFilter, topOfSearchIS: { not: null } },
          select: { campaignId: true, impressions: true, topOfSearchIS: true },
        })
      : []
    const tosByExt = new Map<string, Array<{ value: number; weight: number }>>()
    for (const r of tosRows) {
      if (r.topOfSearchIS == null) continue
      const pts = tosByExt.get(r.campaignId) ?? []
      pts.push({ value: Number(r.topOfSearchIS), weight: r.impressions ?? 0 })
      tosByExt.set(r.campaignId, pts)
    }

    /**
     * ADM-P6 — Current Budget Utilization, and the two hour columns beside it.
     *
     * The Ad Manager rendered `not measured` on 220 of 220 rows for all three, and the sentence
     * behind that was true when it was written: no source held today's spend-so-far, and the
     * Marketing Stream's budget-usage percentage is received, counted, logged and never stored.
     *
     * There was a third source. `POST /sp/campaigns/budget/usage` answers synchronously for
     * every Sponsored Products campaign — 200 of 200, measured 2026-08-22 — with Amazon's OWN
     * percentage, Amazon's OWN budget as the denominator, and `usageUpdatedTimestamp`, the age
     * of the reading itself. `budget-usage-sample` records it every five minutes; this reads
     * what was recorded.
     *
     * Read from OUR samples, never called inline: this response is cached for 300s, and an
     * outbound Amazon call inside a cached read would be both slow and a lie about its own
     * freshness — what is fresh is the reading's timestamp, not the fetch.
     *
     * Two queries, both on indexed columns, and only on the windowed path the Ad Manager uses.
     * Callers that pass no date params keep the fast stored-column path exactly as it was.
     */
    const { readCurrentBudgetUsage, readBudgetUsageHours, budgetUsageSamplingSince } =
      await import('./ads-budget-usage.service.js')
    const usageInput = base.map((c) => ({ id: c.id, adProduct: c.adProduct, dailyBudget: c.dailyBudget }))
    const [curUsage, usageHours, usageSince] = await Promise.all([
      readCurrentBudgetUsage(usageInput),
      readBudgetUsageHours(usageInput),
      budgetUsageSamplingSince(),
    ])
    const usageSinceIso = usageSince ? usageSince.toISOString() : null

    const items = base.map((it) => {
      const a = mapL.get(it.id)
      const b = it.externalCampaignId ? mapE.get(it.externalCampaignId) : undefined
      const au = avgUtilById.get(it.id)
      const cu = curUsage.get(it.id) ?? { state: 'unknown' as const, fraction: null, budgetCents: null, asOf: null }
      const uh = usageHours.get(it.id) ?? { observed: 0, outOfBudget: 0, actBid: 0, supported: false }
      const spendCents = m2c(a?.costMicros) + m2c(b?.costMicros)
      const salesCents = adSalesCents(a) + adSalesCents(b)
      // ADM-H P3 — a nullable metric Amazon never reported is `unknown`, not 0. The count of
      // rows that actually carried a value decides; the sum alone cannot tell "reported zero"
      // from "never reported", and Prisma renders both as 0.
      const ca = cntL.get(it.id)
      const cb = it.externalCampaignId ? cntE.get(it.externalCampaignId) : undefined
      const tosPts = (it.externalCampaignId ? tosByExt.get(it.externalCampaignId) : undefined) ?? []
      const reported = (f: keyof typeof _count) => n(ca?.[f]) + n(cb?.[f]) > 0
      const summed = (f: keyof typeof _count) => (reported(f) ? n(a?.[f]) + n(b?.[f]) : null)
      const saleUnits = summed('units7d')
      const sameSkuCents = summed('salesSameSku7dCents')
      const ppcOrders = n(a?.orders7d) + n(b?.orders7d)
      // 🔴 ADM-A5 — gate NTB on the AD PRODUCT, not just on whether a row exists.
      //
      // `ntbOrders14d` and `ntbSalesCents14d` are the two legacy columns carrying `DEFAULT 0`, so
      // every one of the 6,019 Sponsored Products rows already holds a 0 that nobody measured —
      // we never requested a newToBrand column for any ad product until today, and Amazon does
      // not publish one for SP at all (52 allowed columns, none of them newToBrand, verified
      // 2026-08-26). `_count` cannot save us here: a defaulted 0 counts as present.
      //
      // Without this gate the grid printed "0" for new-to-brand orders on Sponsored Products
      // campaigns — a confident measurement of something Amazon has never reported and never
      // will. Caught on prod immediately after the ADM-A3 deploy, on the same page it fixed.
      const ntbPublished = ntbIsPublishedFor(it.adProduct)
      const ntbOrders = ntbPublished ? summed('ntbOrders14d') : null
      const ntbSalesCents = ntbPublished ? summed('ntbSalesCents14d') : null
      const ntbUnits = ntbPublished ? summed('ntbUnits14d') : null
      // Amazon's own rate: take whichever bucket reported it rather than averaging the two —
      // combining two means is the mean-of-means error this file already avoids for topOfSearchIS
      // and budget utilization. In practice a campaign's rows sit in one bucket or the other.
      const avgRate = avgL.get(it.id)?.ntbOrdersRate14d
        ?? (it.externalCampaignId ? avgE.get(it.externalCampaignId)?.ntbOrdersRate14d : null)
        ?? null
      // Halo: Amazon publishes no other-SKU column at campaign grain, so it is (total − sameSKU).
      // Null when the same-SKU half is unknown — a subtraction with an unknown operand is not 0,
      // and clamped at 0 because attribution windows can make the parts exceed the whole.
      const otherCents = sameSkuCents == null ? null : Math.max(0, salesCents - sameSkuCents)
      return {
        ...it,
        impressions: n(a?.impressions) + n(b?.impressions),
        clicks: n(a?.clicks) + n(b?.clicks),
        spend: spendCents / 100,
        sales: salesCents / 100,
        acos: salesCents > 0 ? spendCents / salesCents : null,
        roas: spendCents > 0 ? salesCents / spendCents : null,
        ppcOrders,
        // ADM-H P3 — euros for the money columns, counts for the rest, a FRACTION for the
        // percentage: the units each cell already formats for (eur / toLocaleString / sharePct).
        saleUnits,
        sameSkuSales: sameSkuCents == null ? null : sameSkuCents / 100,
        sameSkuSaleUnits: summed('unitsSameSku7d'),
        sameSkuOrders: summed('ordersSameSku7d'),
        otherSales: otherCents == null ? null : otherCents / 100,
        otherSalesPct: otherCents == null || salesCents <= 0 ? null : otherCents / salesCents,
        // Average selling price = ad sales ÷ units sold. Null when units are unknown OR zero:
        // dividing by an unsold campaign invents a price no one paid.
        asp: saleUnits == null || saleUnits <= 0 ? null : salesCents / 100 / saleUnits,
        // ADM-A2 — a FRACTION, impression-weighted across the days Amazon reported, and null
        // when it reported none. `days` is what the cell prints beside it so a one-day share is
        // never read as a week's.
        topOfSearchIS: tosPts.length ? weightedIS(tosPts) : null,
        topOfSearchISDays: tosPts.length,
        // ADM-A3 — new-to-brand. Null (never 0) when this campaign's ad product does not publish
        // it: Amazon offers no newToBrand column on the SP report at all, so an SP campaign is a
        // real "not applicable" and the cell says so, while an SB/SD campaign with no attributed
        // NTB is a real zero. `_count` is what separates the two.
        ntbOrders, ntbSales: ntbSalesCents == null ? null : ntbSalesCents / 100, ntbUnits,
        // The three percentages are DERIVED (ntb ÷ total) rather than stored: only SB publishes
        // *Percentage columns, and one rule applied everywhere beats a stored SB figure sitting
        // beside a derived SD one where the two could disagree. Null when the numerator is
        // unknown or the denominator is zero — a share of nothing is not 0%.
        ntbOrdersPct: ntbOrders == null || ppcOrders <= 0 ? null : ntbOrders / ppcOrders,
        ntbSalesPct: ntbSalesCents == null || salesCents <= 0 ? null : ntbSalesCents / salesCents,
        ntbUnitsPct: ntbUnits == null || saleUnits == null || saleUnits <= 0 ? null : ntbUnits / saleUnits,
        // Amazon's OWN rate, SB only — deliberately not back-filled from the derivation above, so
        // a reading and a calculation are never confused for one another.
        ntbOrderRate: ntbPublished && reported('ntbOrders14d') ? avgRate : null,
        // ADM-A3 — KENP. Offered on the SP report; never requested until now. The Ad Manager said
        // "this account sells no books, so Amazon has nothing to report" — a business claim
        // standing in for an ingest gap. Now the data answers it.
        kindleReads: summed('kenpRead14d'),
        kindleRoyalties: (() => { const c = summed('kenpRoyaltiesCents14d'); return c == null ? null : c / 100 })(),
        // ADM-P6 — TODAY's utilization, as a FRACTION, and null whenever the state is not a
        // reading: `silent` (Amazon has reported nothing since the 00:00 UTC reset),
        // `unsupported` (SD/SB — the SP endpoint does not cover them), `unknown` (never
        // sampled). A 0 here would answer a question nobody can answer, which is precisely the
        // defect this column was built to end.
        // ADM-H P2 — a FRACTION (0.5 = 50%), and null when nothing was measurable. Deliberately
        // not rounded here: the cell decides its own precision, and a rounded null is how a
        // "no data" becomes a confident zero one layer up.
        avgBudgetUtil: au && au.util != null && Number(au.days) > 0 ? au.util : null,
        avgBudgetUtilDays: au ? Number(au.days) : 0,
        curBudgetUtil: cu.fraction,
        curBudgetUtilState: cu.state,
        // Amazon's usageUpdatedTimestamp — the age of the READING. Not of our poll, and not of
        // this response.
        curBudgetUtilAsOf: cu.asOf,
        // The denominator that fraction actually used, in euros: Amazon's own budget for a
        // `live` reading, ours for a `derived` one. They can disagree — on 3 of 200 campaigns
        // they do — so the cell names the one it divided by.
        curBudgetUtilBudget: cu.budgetCents != null ? cu.budgetCents / 100 : null,
        // ADM-P6 — hours of the current budget day, counted from observation SPANS rather than
        // from a count of samples. Null, never 0, for a campaign this source cannot answer for.
        oobHours: uh.supported ? uh.outOfBudget : null,
        actBidHours: uh.supported ? uh.actBid : null,
        hoursObserved: uh.supported ? uh.observed : null,
        // Neither Amazon feed can be backfilled, so both hour columns are bounded by the moment
        // sampling began, and have to say so.
        usageSince: usageSinceIso,
      }
    })
    return { items, count: items.length, range: { startDate: range.sinceStr, endDate: range.untilStr, preset: range.preset } }
  })
  return result
}
