/**
 * AIAD.4 — evidence for the AI Goal builder. Three reads, all from data this account
 * actually earned, replacing the builder's fabricated numbers (product-name tokens as
 * "suggested keywords", an LQS-derived budget range):
 *
 *   keywords — the selected ASINs' ad groups → previewHarvest graduations (real converting
 *              search terms with clicks/orders/sales), falling back to account n-gram winners
 *              when the ASINs have no ad history — labelled as the fallback it is;
 *   bids     — suggestBids (median observed CPC over similar keywords, 5¢ floor), used by the
 *              builder chips AND by planGoalScaffold at preview/launch so they cannot drift;
 *   budgets  — the ASINs' own trailing daily ad spend (30d, PRODUCT_AD grain): p50–p90 as the
 *              suggested range, with an honest "no ad history" branch at Amazon's €1 floor.
 */
import prisma from '../../db.js'
import { logger } from '../../utils/logger.js'

export interface SuggestedKeyword {
  text: string
  source: 'search-terms' | 'ngrams'
  impressions: number; clicks: number; orders: number
  spendCents: number; salesCents: number
  acosPct: number | null
  suggestedBidCents: number | null
  bidBasis: string | null
}
export interface SuggestedBudget {
  asin: string
  hasHistory: boolean
  daysWithSpend: number
  windowDays: number
  lowCents: number   // €1 floor when no history
  highCents: number
}
export interface GoalSuggestions {
  keywords: SuggestedKeyword[]
  keywordSource: 'search-terms' | 'ngrams' | 'none'
  budgets: SuggestedBudget[]
  autoBaseCents: number
  bidCentsByKeyword: Record<string, number>
}

const pct = (spend: number, sales: number) => (sales > 0 ? Math.round((spend / sales) * 10_000) / 100 : null)
const quantile = (sorted: number[], q: number) => {
  if (!sorted.length) return 0
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))
  return sorted[i]
}

export async function suggestForGoal(opts: { asins: string[]; marketplace?: string | null; limit?: number }): Promise<GoalSuggestions> {
  const asins = Array.from(new Set((opts.asins ?? []).map((a) => a.trim()).filter(Boolean)))
  const marketplace = (opts.marketplace ?? '').trim() || null
  const limit = Math.min(60, Math.max(5, opts.limit ?? 30))

  // ── ASIN → external ad-group bridge (marketplace-scoped) ──
  const ads = asins.length
    ? await prisma.adProductAd.findMany({
        where: { asin: { in: asins } },
        select: { asin: true, id: true, adGroup: { select: { externalAdGroupId: true, campaign: { select: { marketplace: true } } } } },
      })
    : []
  const adGroupExternalIds = Array.from(new Set(ads
    .filter((a) => !marketplace || a.adGroup?.campaign?.marketplace === marketplace)
    .map((a) => a.adGroup?.externalAdGroupId)
    .filter((x): x is string => !!x)))

  // ── keywords: real converting terms for THESE ASINs; n-gram winners as labelled fallback ──
  let keywords: SuggestedKeyword[] = []
  let keywordSource: GoalSuggestions['keywordSource'] = 'none'
  if (adGroupExternalIds.length) {
    try {
      const { previewHarvest } = await import('./ads-harvest.service.js')
      const preview = await previewHarvest({ windowDays: 90, minOrders: 1, minSpendCents: 0, adGroupExternalIds })
      keywords = preview.graduations.slice(0, limit).map((g) => ({
        text: g.query, source: 'search-terms' as const,
        impressions: g.impressions, clicks: g.clicks, orders: g.orders,
        spendCents: g.costCents, salesCents: g.salesCents,
        acosPct: pct(g.costCents, g.salesCents),
        suggestedBidCents: null, bidBasis: null,
      }))
      if (keywords.length) keywordSource = 'search-terms'
    } catch (e) { logger.warn('[AIAD] suggest harvest failed', { error: (e as Error).message }) }
  }
  if (!keywords.length) {
    try {
      const { analyzeNgrams } = await import('./ads-ngram.service.js')
      const ng = await analyzeNgrams({ windowDays: 90, marketplace: marketplace ?? undefined })
      keywords = ng.winning.slice(0, limit).map((w) => ({
        text: w.gram, source: 'ngrams' as const,
        impressions: w.impressions, clicks: w.clicks, orders: w.orders,
        spendCents: w.costCents, salesCents: w.salesCents,
        acosPct: pct(w.costCents, w.salesCents),
        suggestedBidCents: null, bidBasis: null,
      }))
      if (keywords.length) keywordSource = 'ngrams'
    } catch (e) { logger.warn('[AIAD] suggest ngrams failed', { error: (e as Error).message }) }
  }

  // ── bids: evidence-based starting bid per suggested keyword + the auto-group base ──
  let autoBaseCents = 75
  const bidCentsByKeyword: Record<string, number> = {}
  try {
    const { suggestBids } = await import('./ads-bid-suggest.service.js')
    const res = await suggestBids({ keywords: keywords.map((k) => k.text), matchType: 'EXACT', marketplace: marketplace ?? undefined })
    const byKw = new Map(res.suggestions.map((s) => [s.keyword, s]))
    for (const k of keywords) {
      const s = byKw.get(k.text)
      if (s) { k.suggestedBidCents = s.suggestedBidCents; k.bidBasis = s.basis; bidCentsByKeyword[k.text.toLowerCase()] = s.suggestedBidCents }
    }
    if (res.accountMedianCpcCents != null && res.accountMedianCpcCents >= 20) {
      autoBaseCents = Math.min(150, Math.max(30, res.accountMedianCpcCents))
    }
  } catch (e) { logger.warn('[AIAD] suggest bids failed', { error: (e as Error).message }) }

  // ── budgets: the ASINs' own trailing daily ad spend (30d) ──
  const WINDOW = 30
  const budgets: SuggestedBudget[] = []
  if (ads.length) {
    const idsByAsin = new Map<string, string[]>()
    for (const a of ads) {
      if (marketplace && a.adGroup?.campaign?.marketplace !== marketplace) continue
      const list = idsByAsin.get(a.asin ?? '') ?? []
      list.push(a.id)
      idsByAsin.set(a.asin ?? '', list)
    }
    const allIds = Array.from(new Set(Array.from(idsByAsin.values()).flat()))
    const since = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z')
    since.setUTCDate(since.getUTCDate() - WINDOW)
    const rows = allIds.length
      ? await prisma.amazonAdsDailyPerformance.groupBy({
          by: ['localEntityId', 'date'],
          where: { entityType: 'PRODUCT_AD', localEntityId: { in: allIds }, date: { gte: since } },
          _sum: { costMicros: true },
        })
      : []
    const asinOfAd = new Map<string, string>()
    for (const [asin, list] of idsByAsin) for (const id of list) asinOfAd.set(id, asin)
    const dailyByAsin = new Map<string, Map<string, number>>()
    for (const r of rows) {
      const asin = r.localEntityId ? asinOfAd.get(r.localEntityId) : undefined
      if (!asin) continue
      const day = r.date.toISOString().slice(0, 10)
      const m = dailyByAsin.get(asin) ?? dailyByAsin.set(asin, new Map()).get(asin)!
      m.set(day, (m.get(day) ?? 0) + Math.round(Number(r._sum.costMicros ?? 0n) / 10_000))
    }
    for (const asin of asins) {
      const days = Array.from((dailyByAsin.get(asin) ?? new Map<string, number>()).values()).filter((v) => v > 0).sort((a, b) => a - b)
      if (!days.length) { budgets.push({ asin, hasHistory: false, daysWithSpend: 0, windowDays: WINDOW, lowCents: 100, highCents: 300 }); continue }
      const p50 = quantile(days, 0.5), p90 = quantile(days, 0.9)
      budgets.push({
        asin, hasHistory: true, daysWithSpend: days.length, windowDays: WINDOW,
        lowCents: Math.max(100, p50),
        highCents: Math.max(200, Math.round(p90 * 1.2)),
      })
    }
  } else {
    for (const asin of asins) budgets.push({ asin, hasHistory: false, daysWithSpend: 0, windowDays: WINDOW, lowCents: 100, highCents: 300 })
  }

  return { keywords, keywordSource, budgets, autoBaseCents, bidCentsByKeyword }
}

/**
 * The bid evidence planGoalScaffold consumes at BOTH preview and launch — one resolver, so the
 * preview's bids are the launch's bids. Keyed by lowercased keyword text.
 */
export async function resolveGoalBids(seedKeywords: string[], marketplace?: string | null): Promise<{ bidCentsByKeyword: Record<string, number>; autoBaseCents: number }> {
  const out: { bidCentsByKeyword: Record<string, number>; autoBaseCents: number } = { bidCentsByKeyword: {}, autoBaseCents: 75 }
  const seeds = (seedKeywords ?? []).filter(Boolean)
  try {
    const { suggestBids } = await import('./ads-bid-suggest.service.js')
    const res = await suggestBids({ keywords: seeds, matchType: 'EXACT', marketplace: marketplace ?? undefined })
    for (const s of res.suggestions) out.bidCentsByKeyword[s.keyword.toLowerCase()] = s.suggestedBidCents
    if (res.accountMedianCpcCents != null && res.accountMedianCpcCents >= 20) {
      out.autoBaseCents = Math.min(150, Math.max(30, res.accountMedianCpcCents))
    }
  } catch (e) { logger.warn('[AIAD] resolveGoalBids failed', { error: (e as Error).message }) }
  return out
}
