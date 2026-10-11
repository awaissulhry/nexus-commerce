/**
 * Negative Targeting page (2026-10-11) — the contexts a STOP-WASTE rule (a rule whose first action carries `stopWaste`,
 * saved by the waste rules' save or Claude's save-ad-rule) is evaluated on, in place of its trigger's default contexts.
 *
 * ONE test for the page and the rules (review S2): every number comes from the page's own pure test —
 *   window      waste/pure.ts wasteWindow: `windowDays` click-days ending today − 3; orders and sales through today (a
 *               late order can only save a row);
 *   numbers     windowNumbers: clicks, impressions and spend with the out-of-stock days left out; orders every day;
 *   stock       outOfStockDays: a day half or more of the ad group's advertised SKUs had an open StockoutEvent (the
 *               place's market or none);
 *   facts       waste/test.ts productFactsOf: conversion and order value pooled product → market from the search terms of
 *               the page's default window (bid-brain/estimator.ts, the list price as the order value's prior), × the target
 *               ACoS (the ads strategy for the product, else the account's default — targetFrom);
 *   bar         barFor with the rule's own numbers (RuleTune: clicks floor, CPA multiple, fixed bar, window); for a search
 *               term the ads strategy's "Negate a search term when" group wins whole where it is set, as on the page;
 *   verdict     wasteTest (a keyword also needs no search under it that sold).
 * Only rows whose verdict is met are emitted (a rule condition can tighten it, never loosen it). Each context carries the
 * evidence as `stopWaste` (pure.ts StopWasteEvidence), stored with its run.
 *
 * Shapes: TARGET_PERFORMANCE's (campaign, adGroup, adTarget) for PAUSE_KEYWORD; SEARCH_TERM_WASTING's (searchTerm, with
 * Amazon's campaign and ad-group ids) for NEGATE_TERM — so every handler, scope matcher and condition reads them as before.
 * Only enabled, positive keywords in enabled ad groups and campaigns are offered; search terms only from enabled ad groups,
 * never a term that is our own exact keyword's words in its ad group (that traffic is the keyword's row). The floors are
 * pushed into SQL (HAVING) so only candidates come back. Reads only.
 */
import prisma from '../../../db.js'
import { microsToCents } from '../../ads-core/metrics-math.js'
import { stopWasteParamsOf, type StopWasteParams } from '../ads-graduation-stopwaste.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { dayIndex, isoDay, outOfStockDays, termKeyOf, wasteWindow, windowNumbers, WASTE_WINDOW_DAYS, type DayEvidence } from '../waste/pure.js'
import { barFor, productFactsOf, targetFrom, wasteTest, xCpaOf, type OwnerBar, type PoolEvidence, type ProductFacts, type RuleTune } from '../waste/test.js'
import type { StopWasteEvidence } from './pure.js'

/** The most contexts one test emits, biggest spend first (SEARCH_TERM_WASTING's own per-tick bound). */
export const STOP_WASTE_TOP = 300
/** The search-term report keeps 90 days: a window and its 3-day lag fit inside it. */
const MAX_WINDOW_DAYS = 87

export const isStopWasteRule = (actions: unknown): boolean => stopWasteParamsOf(actions) != null

/** The trigger a stop-waste kind rides. */
export const TRIGGER_OF = { PAUSE_KEYWORD: 'TARGET_PERFORMANCE', NEGATE_TERM: 'SEARCH_TERM_WASTING' } as const

const paramsKey = (p: StopWasteParams) => `${p.kind}|${p.windowDays}|${p.minClicks}|${p.cpaMultiple}|${p.spendFloorCents}`

type Ctx = { marketplace: string | null } & Record<string, unknown>
type Pass = [string, Ctx[], (r: { id: string; actions: unknown }) => boolean]

/**
 * The tick's stop-waste passes: one per distinct test among the enabled stop-waste rules that are DUE (their stored
 * schedule — daily by default — through the evaluator's own gate), each admitting only its own rules. Nothing is built
 * when none is due.
 */
export async function stopWastePasses(now = new Date()): Promise<Pass[]> {
  const rules = await prisma.automationRule.findMany({
    where: { domain: 'advertising', trigger: { in: Object.values(TRIGGER_OF) }, enabled: true },
    select: { trigger: true, actions: true, lastEvaluatedAt: true },
  })
  const { ruleStoredSchedule, scheduleIsDue } = await import('../ads-rule-schedule.js')
  const due = new Map<string, StopWasteParams>()
  for (const r of rules) {
    const p = stopWasteParamsOf(r.actions)
    if (!p || TRIGGER_OF[p.kind] !== r.trigger) continue
    if (!scheduleIsDue(ruleStoredSchedule(r.actions), r.lastEvaluatedAt, now)) continue
    due.set(paramsKey(p), p)
  }
  return Promise.all([...due].map(async ([key, p]): Promise<Pass> => [
    TRIGGER_OF[p.kind],
    await buildStopWasteContexts(p, { now }),
    (r) => { const own = stopWasteParamsOf(r.actions); return !!own && paramsKey(own) === key },
  ]))
}

/** The contexts of one stop-waste test (see the file's note), biggest spend first. */
export async function buildStopWasteContexts(p: StopWasteParams, opts: { now?: Date } = {}): Promise<Ctx[]> {
  const now = opts.now ?? new Date()
  const tune: RuleTune = { by: { id: 'rule', name: 'Stop waste' }, windowDays: Math.min(MAX_WINDOW_DAYS, p.windowDays), minClicks: p.minClicks, cpaMultiple: p.cpaMultiple, fixedSpendCents: p.spendFloorCents }
  return p.kind === 'PAUSE_KEYWORD' ? keywordContexts(tune, now) : termContexts(tune, now)
}

// ── the product's facts: one definition with the page (waste/test.ts productFactsOf) ────────────────────────────────

const ZERO: PoolEvidence = { clicks: 0, orders: 0, salesCents: 0, costCents: 0 }
const add = (a: PoolEvidence | undefined, b: PoolEvidence): PoolEvidence => ({ clicks: (a?.clicks ?? 0) + b.clicks, orders: (a?.orders ?? 0) + b.orders, salesCents: (a?.salesCents ?? 0) + b.salesCents, costCents: (a?.costCents ?? 0) + b.costCents })

interface PlaceFacts { facts: ProductFacts; negateBar: OwnerBar | null; root: string | null; market: string }

/**
 * The facts every place of these campaigns reads: the pooled evidence over the page's default window (search terms of every
 * campaign of the markets, clicks to today − 3, orders to today), each campaign's owner (brain/ownership.ts), the ads
 * strategy per product and market, the account's default target.
 */
async function loadFacts(campaignIds: readonly string[], now: Date): Promise<(campaignId: string) => PlaceFacts> {
  const w = wasteWindow(now, WASTE_WINDOW_DAYS)
  const [clicks, orders, owners] = await Promise.all([
    prisma.amazonAdsSearchTerm.groupBy({ by: ['campaignId'], where: { date: { gte: w.since, lte: w.clicksThrough } }, _sum: { clicks: true, costMicros: true } }),
    prisma.amazonAdsSearchTerm.groupBy({ by: ['campaignId'], where: { date: { gte: w.since, lte: w.ordersThrough } }, _sum: { orders7d: true, sales7dCents: true } }),
    import('../ads-target-acos-resolver.js').then((m) => m.readOwnerTargets([])),
  ])
  const exts = [...new Set([...clicks, ...orders].map((r) => r.campaignId))]
  const campaigns = await prisma.campaign.findMany({
    where: { OR: [{ id: { in: [...campaignIds] } }, ...(exts.length ? [{ externalCampaignId: { in: exts } }] : [])] },
    select: { id: true, externalCampaignId: true, marketplace: true },
  })
  const byExt = new Map(campaigns.filter((c) => c.externalCampaignId).map((c) => [c.externalCampaignId as string, c]))
  const { resolveCampaignOwnership } = await import('../brain/ownership.js')
  const ownership = await resolveCampaignOwnership(campaigns.map((c) => c.id))
  const marketOf = new Map(campaigns.map((c) => [c.id, strategyMarket(c.marketplace) ?? String(c.marketplace ?? '')]))
  const rootOf = (id: string) => { const o = ownership.get(id)?.owner; return o?.kind === 'product' ? o.productId : null }

  const productNode = new Map<string, PoolEvidence>()
  const marketNode = new Map<string, PoolEvidence>()
  const pool = (ext: string, e: PoolEvidence) => {
    const c = byExt.get(ext)
    if (!c) return
    const m = marketOf.get(c.id)!
    marketNode.set(m, add(marketNode.get(m), e))
    const root = rootOf(c.id)
    if (root) productNode.set(`${m}|${root}`, add(productNode.get(`${m}|${root}`), e))
  }
  for (const r of clicks) pool(r.campaignId, { clicks: r._sum.clicks ?? 0, orders: 0, salesCents: 0, costCents: microsToCents(r._sum.costMicros) })
  for (const r of orders) pool(r.campaignId, { clicks: 0, orders: r._sum.orders7d ?? 0, salesCents: r._sum.sales7dCents ?? 0, costCents: 0 })

  const accountPct = typeof owners.accountDefaultPct === 'number' && owners.accountDefaultPct > 0 ? owners.accountDefaultPct : null
  const roots = [...new Set(campaigns.map((c) => rootOf(c.id)).filter((x): x is string => !!x))]
  const prices = roots.length ? await prisma.product.findMany({ where: { id: { in: roots } }, select: { id: true, basePrice: true } }) : []
  const listPrice = new Map(prices.map((p) => [p.id, Math.round(Number(p.basePrice ?? 0) * 100)]))
  const { openStrategy } = await import('../ads-strategy/effective.js')
  const { sourceLabel } = await import('../ads-strategy/terms.js')
  type Effective = Awaited<ReturnType<Awaited<ReturnType<typeof openStrategy>>['forProducts']>>
  const words = (e: Effective | null | undefined, key: string) => {
    const s = e?.resolved.fields.get(key as never)?.source
    return s ? `the ads strategy: ${sourceLabel(s)}` : 'the ads strategy'
  }
  const negateOf = (e: Effective | null | undefined): OwnerBar | null => (e?.values.negate ? { source: 'strategy', by: { id: 'strategy', name: words(e, 'negate') }, ...e.values.negate } : null)
  const out = new Map<string, PlaceFacts>()
  for (const m of new Set(marketOf.values())) {
    let view: Awaited<ReturnType<typeof openStrategy>> | null = null
    let byProduct = new Map<string, Effective>()
    const mine = roots.filter((r) => campaigns.some((c) => marketOf.get(c.id) === m && rootOf(c.id) === r))
    try {
      view = m ? await openStrategy(m) : null
      if (view && !view.empty && mine.length) byProduct = await view.forEachProduct(mine)
    } catch { view = null }
    const atMarket = view && !view.empty ? view.forMarket() : null
    const facts = (root: string | null): PlaceFacts => {
      const e = root ? byProduct.get(root) : atMarket
      return {
        facts: productFactsOf({
          product: root ? productNode.get(`${m}|${root}`) ?? ZERO : null, market: marketNode.get(m) ?? ZERO,
          listPriceCents: root ? listPrice.get(root) ?? null : null,
          target: targetFrom(e?.values.targetAcosPct ?? null, words(e, 'targetAcosPct'), accountPct),
        }),
        negateBar: (root ? negateOf(byProduct.get(root)) : null) ?? negateOf(atMarket),
        root, market: m,
      }
    }
    out.set(`${m}|`, facts(null))
    for (const r of mine) out.set(`${m}|${r}`, facts(r))
  }
  return (campaignId: string) => {
    const m = marketOf.get(campaignId) ?? ''
    const root = rootOf(campaignId)
    return out.get(`${m}|${root ?? ''}`) ?? out.get(`${m}|`) ?? { facts: { cr: null, targetCpaCents: null, targetSource: null }, negateBar: null, root, market: m }
  }
}

/** Per ad group: the days in [from, to] it had nothing to sell (half or more of its SKUs out — waste/pure.ts outOfStockDays). */
async function stockOf(groups: ReadonlyMap<string, string>, from: Date, to: Date): Promise<Map<string, Set<number>>> {
  const ads = groups.size ? await prisma.adProductAd.findMany({
    where: { adGroupId: { in: [...groups.keys()] }, status: { not: 'ARCHIVED' }, productId: { not: null } },
    select: { adGroupId: true, productId: true },
  }) : []
  const productsOf = new Map<string, string[]>()
  for (const a of ads) productsOf.set(a.adGroupId, [...(productsOf.get(a.adGroupId) ?? []), a.productId as string])
  const ids = [...new Set(ads.map((a) => a.productId as string))]
  const events = ids.length ? await prisma.stockoutEvent.findMany({
    where: { productId: { in: ids }, startedAt: { lte: new Date(to.getTime() + 86_399_999) }, OR: [{ endedAt: null }, { endedAt: { gte: from } }] },
    select: { productId: true, marketplace: true, startedAt: true, endedAt: true },
  }) : []
  const out = new Map<string, Set<number>>()
  for (const [groupId, products] of productsOf) {
    const market = groups.get(groupId) ?? ''
    const mine = events.filter((e) => !e.marketplace || !market || strategyMarket(e.marketplace) === market)
    const days = outOfStockDays(products, mine, dayIndex(from), dayIndex(to))
    if (days.size) out.set(groupId, days)
  }
  return out
}

const ratios = (x: { spendCents: number; salesCents: number; orders: number; clicks: number; impressions: number }) => ({
  // Absent, never null, when not measurable: the engine's comparator reads null as 0 (KT-P/C1).
  ...(x.salesCents > 0 ? { acos: x.spendCents / x.salesCents } : {}),
  ...(x.spendCents > 0 ? { roas: x.salesCents / x.spendCents } : {}),
  ...(x.impressions > 0 ? { ctr: x.clicks / x.impressions } : {}),
  ...(x.clicks > 0 ? { cvr: x.orders / x.clicks, cpcCents: Math.round(x.spendCents / x.clicks) } : {}),
})

function evidenceOf(kind: StopWasteParams['kind'], bar: ReturnType<typeof barFor>, w: ReturnType<typeof wasteWindow>, win: ReturnType<typeof windowNumbers>, facts: ProductFacts, sentence: string): StopWasteEvidence {
  return {
    kind, windowDays: bar.windowDays, from: isoDay(w.since), clicksThrough: isoDay(w.clicksThrough), ordersThrough: isoDay(w.ordersThrough),
    stockOutDays: win.stockOutDays, clicks: win.n.clicks, orders: win.n.orders, spendCents: win.n.spendCents,
    clicksNeeded: bar.clicksNeeded, spendBarCents: bar.spendBarCents, xCpaBar: bar.xCpaBar, targetCpaCents: facts.targetCpaCents,
    xCpa: xCpaOf(win.n.spendCents, facts.targetCpaCents), cr: facts.cr, source: bar.source, sentence,
  }
}

// ── our keywords (PAUSE_KEYWORD) ────────────────────────────────────────────────────────────────────────────────────

async function keywordContexts(tune: RuleTune, now: Date): Promise<Ctx[]> {
  const w = wasteWindow(now, tune.windowDays)
  const [clickAgg, soldAgg] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', localEntityId: { not: null }, date: { gte: w.since, lte: w.clicksThrough } },
      _sum: { clicks: true },
      having: { clicks: { _sum: { gte: tune.minClicks } } },
    }),
    prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId'],
      where: { entityType: 'AD_TARGET', localEntityId: { not: null }, date: { gte: w.since, lte: w.ordersThrough } },
      _sum: { orders7d: true },
      having: { orders7d: { _sum: { gt: 0 } } },
    }),
  ])
  const sold = new Set(soldAgg.map((s) => s.localEntityId as string))
  const ids = clickAgg.map((c) => c.localEntityId as string).filter((id) => !sold.has(id))
  if (!ids.length) return []
  const targets = await prisma.adTarget.findMany({
    where: { id: { in: ids }, status: 'ENABLED', isNegative: false, adGroup: { status: 'ENABLED', campaign: { status: 'ENABLED' } } },
    select: {
      id: true, kind: true, expressionType: true, expressionValue: true, bidCents: true, externalTargetId: true,
      adGroup: { select: { id: true, name: true, externalAdGroupId: true, campaign: { select: { id: true, name: true, marketplace: true } } } },
    },
  })
  if (!targets.length) return []
  const live = targets.filter((t) => t.adGroup.campaign)
  const [perf, factsFor, terms] = await Promise.all([
    prisma.amazonAdsDailyPerformance.findMany({
      where: { entityType: 'AD_TARGET', localEntityId: { in: live.map((t) => t.id) }, date: { gte: w.since, lte: w.ordersThrough } },
      select: { localEntityId: true, date: true, clicks: true, impressions: true, costMicros: true, orders7d: true, sales7dCents: true },
    }),
    loadFacts(live.map((t) => t.adGroup.campaign!.id), now),
    // No search under it sold (the page's rule): the searches it bought in its ad group, with an order, to today.
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['adGroupId', 'query', 'matchedKeywordId', 'matchedTargetId'],
      where: {
        date: { gte: w.since, lte: w.ordersThrough },
        OR: [
          { matchedKeywordId: { in: live.map((t) => t.externalTargetId).filter((x): x is string => !!x) } },
          { matchedTargetId: { in: live.map((t) => t.externalTargetId).filter((x): x is string => !!x) } },
        ],
      },
      _sum: { orders7d: true },
      having: { orders7d: { _sum: { gt: 0 } } },
    }),
  ])
  const days = new Map<string, DayEvidence[]>()
  for (const d of perf) {
    const list = days.get(d.localEntityId as string) ?? []
    list.push({ day: dayIndex(d.date), impressions: d.impressions ?? 0, clicks: d.clicks ?? 0, spendCents: microsToCents(d.costMicros), orders: d.orders7d ?? 0, salesCents: d.sales7dCents ?? 0 })
    days.set(d.localEntityId as string, list)
  }
  const stock = await stockOf(new Map(live.map((t) => [t.adGroup.id, strategyMarket(t.adGroup.campaign!.marketplace) ?? ''])), w.since, w.clicksThrough)
  const out: Ctx[] = []
  for (const t of live) {
    const camp = t.adGroup.campaign!
    const x = factsFor(camp.id)
    const bar = barFor('KEYWORD', x.facts, tune.windowDays, null, tune)
    const win = windowNumbers(days.get(t.id) ?? [], w, stock.get(t.adGroup.id) ?? new Set())
    const termsSold = t.externalTargetId
      ? new Set(terms.filter((r) => r.adGroupId === t.adGroup.externalAdGroupId && (r.matchedKeywordId === t.externalTargetId || r.matchedTargetId === t.externalTargetId)).map((r) => termKeyOf(r.query))).size
      : 0
    const test = wasteTest('KEYWORD', (days.get(t.id) ?? []).length ? win.n : null, bar, { termsSold, stockOutDays: win.stockOutDays })
    if (!test.met) continue
    const n = win.n
    out.push({
      trigger: 'TARGET_PERFORMANCE',
      marketplace: camp.marketplace,
      campaign: { id: camp.id, name: camp.name },
      adGroup: { id: t.adGroup.id, name: t.adGroup.name },
      adTarget: {
        id: t.id, kind: t.kind, expressionType: t.expressionType, expressionValue: t.expressionValue, bidCents: t.bidCents,
        spendCents: n.spendCents, salesCents: n.salesCents, orders: n.orders, clicks: n.clicks, impressions: n.impressions, ...ratios(n),
      },
      stopWaste: evidenceOf('PAUSE_KEYWORD', bar, w, win, x.facts, test.sentence),
    })
  }
  return out.sort((a, b) => ((b.adTarget as { spendCents: number }).spendCents - (a.adTarget as { spendCents: number }).spendCents)).slice(0, STOP_WASTE_TOP)
}

// ── shoppers' search terms (NEGATE_TERM) ────────────────────────────────────────────────────────────────────────────

async function termContexts(tune: RuleTune, now: Date): Promise<Ctx[]> {
  // Every live ad group's campaign reads its facts (and the ads strategy's negate group, which may set its own window,
  // clicks and orders): the floors pushed into SQL are the loosest of them, each place is judged by its own bar after.
  const liveCampaigns = await prisma.campaign.findMany({ where: { status: 'ENABLED' }, select: { id: true } })
  const factsFor = await loadFacts(liveCampaigns.map((c) => c.id), now)
  const bars = liveCampaigns.map((c) => factsFor(c.id).negateBar).filter((b): b is OwnerBar => !!b)
  const windowDays = Math.min(MAX_WINDOW_DAYS, Math.max(tune.windowDays, ...bars.map((b) => b.windowDays)))
  const floor = Math.max(1, Math.min(tune.minClicks, ...bars.map((b) => b.minClicks)))
  const ordersCap = Math.max(0, ...bars.map((b) => b.maxOrders))
  const wide = wasteWindow(now, windowDays)
  const [clickAgg, soldAgg] = await Promise.all([
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
      where: { date: { gte: wide.since, lte: wide.clicksThrough } },
      _sum: { clicks: true },
      having: { clicks: { _sum: { gte: floor } } },
    }),
    prisma.amazonAdsSearchTerm.groupBy({
      by: ['query', 'campaignId', 'adGroupId', 'marketplace'],
      where: { date: { gte: wide.since, lte: wide.ordersThrough } },
      _sum: { orders7d: true },
      having: { orders7d: { _sum: { gt: ordersCap } } },
    }),
  ])
  const placeKey = (r: { adGroupId: string; query: string }) => `${r.adGroupId}|${termKeyOf(r.query)}`
  const sold = new Set(soldAgg.map(placeKey))
  const candidates = new Map<string, { query: string; campaignId: string; adGroupId: string; marketplace: string; clicks: number }>()
  for (const c of clickAgg) {
    const k = placeKey(c)
    if (sold.has(k)) continue
    const cur = candidates.get(k)
    const clicks = (cur?.clicks ?? 0) + (c._sum.clicks ?? 0)
    // The spelling with the most clicks names the place.
    candidates.set(k, !cur || (c._sum.clicks ?? 0) > cur.clicks ? { query: c.query, campaignId: c.campaignId, adGroupId: c.adGroupId, marketplace: c.marketplace, clicks } : { ...cur, clicks })
  }
  if (!candidates.size) return []
  const groups = await prisma.adGroup.findMany({
    where: { externalAdGroupId: { in: [...new Set([...candidates.values()].map((c) => c.adGroupId))] }, status: 'ENABLED', campaign: { status: 'ENABLED' } },
    select: { id: true, externalAdGroupId: true, campaignId: true, campaign: { select: { marketplace: true } }, targets: { where: { isNegative: false, status: { not: 'ARCHIVED' }, expressionType: { in: ['EXACT', 'exact'] } }, select: { expressionValue: true } } },
  })
  const localOf = new Map(groups.map((g) => [g.externalAdGroupId as string, g]))
  // Our own exact keyword's words in its ad group: that traffic is the keyword's row (pause it, never negate over it).
  const places = [...candidates.entries()].filter(([, c]) => {
    const g = localOf.get(c.adGroupId)
    return !!g && !g.targets.some((t) => termKeyOf(t.expressionValue) === termKeyOf(c.query))
  })
  if (!places.length) return []
  const rows = await prisma.amazonAdsSearchTerm.findMany({
    where: { adGroupId: { in: [...new Set(places.map(([, c]) => c.adGroupId))] }, date: { gte: wide.since, lte: wide.ordersThrough } },
    select: { query: true, adGroupId: true, date: true, clicks: true, impressions: true, costMicros: true, orders7d: true, sales7dCents: true },
  })
  const wanted = new Set(places.map(([k]) => k))
  const days = new Map<string, DayEvidence[]>()
  for (const d of rows) {
    const k = placeKey(d)
    if (!wanted.has(k)) continue
    const list = days.get(k) ?? []
    list.push({ day: dayIndex(d.date), impressions: d.impressions ?? 0, clicks: d.clicks ?? 0, spendCents: microsToCents(d.costMicros), orders: d.orders7d ?? 0, salesCents: d.sales7dCents ?? 0 })
    days.set(k, list)
  }
  const stock = await stockOf(new Map(places.map(([, c]) => { const g = localOf.get(c.adGroupId)!; return [g.id, strategyMarket(g.campaign?.marketplace) ?? ''] as const })), wide.since, wide.clicksThrough)
  const out: Ctx[] = []
  for (const [k, c] of places) {
    const g = localOf.get(c.adGroupId)!
    const x = factsFor(g.campaignId)
    const bar = barFor('TERM', x.facts, x.negateBar?.windowDays ?? tune.windowDays, x.negateBar, tune)
    const w = wasteWindow(now, bar.windowDays)
    const win = windowNumbers(days.get(k) ?? [], w, stock.get(g.id) ?? new Set())
    const test = wasteTest('TERM', win.n, bar, { stockOutDays: win.stockOutDays })
    if (!test.met) continue
    const n = win.n
    out.push({
      trigger: 'SEARCH_TERM_WASTING',
      marketplace: c.marketplace,
      searchTerm: {
        query: c.query, externalCampaignId: c.campaignId, externalAdGroupId: c.adGroupId,
        orders: n.orders, clicks: n.clicks, impressions: n.impressions, spendCents: n.spendCents, salesCents: n.salesCents, ...ratios(n),
      },
      stopWaste: evidenceOf('NEGATE_TERM', bar, w, win, x.facts, test.sentence),
    })
  }
  return out.sort((a, b) => ((b.searchTerm as { spendCents: number }).spendCents - (a.searchTerm as { spendCents: number }).spendCents)).slice(0, STOP_WASTE_TOP)
}

// ── the ad-group grain (AutomationRule.scopeAdGroupId) ──────────────────────────────────────────────────────────────

/** Amazon's ad-group ids (search terms) and keywords (target contexts without an ad group) → Nexus's ad group, read once a pass. */
export interface AdGroupIdentity { external: Map<string, string>; ofTarget: Map<string, string> }

/** The identity maps for these contexts: one read for the search terms' ad groups, one for keywords that name no ad group. */
export async function adGroupIdentity(contexts: readonly unknown[]): Promise<AdGroupIdentity> {
  const exts = new Set<string>()
  const targets = new Set<string>()
  for (const ctx of contexts) {
    const c = ctx as { adGroup?: { id?: string | null }; adTarget?: { id?: string | null }; searchTerm?: { externalAdGroupId?: string | null } }
    if (c.adGroup?.id) continue
    if (c.searchTerm?.externalAdGroupId) exts.add(c.searchTerm.externalAdGroupId)
    else if (c.adTarget?.id) targets.add(c.adTarget.id)
  }
  const [groups, keywords] = await Promise.all([
    exts.size ? prisma.adGroup.findMany({ where: { externalAdGroupId: { in: [...exts] } }, select: { id: true, externalAdGroupId: true } }) : Promise.resolve([]),
    targets.size ? prisma.adTarget.findMany({ where: { id: { in: [...targets] } }, select: { id: true, adGroupId: true } }) : Promise.resolve([]),
  ])
  return {
    external: new Map(groups.map((g) => [g.externalAdGroupId as string, g.id])),
    ofTarget: new Map(keywords.map((t) => [t.id, t.adGroupId])),
  }
}

/** The Nexus ad group a context belongs to: its own, its search term's, or its keyword's; null when it names none. Pure. */
export function adGroupOfContext(ctx: unknown, ids: AdGroupIdentity): string | null {
  const c = ctx as { adGroup?: { id?: string | null }; adTarget?: { id?: string | null }; searchTerm?: { externalAdGroupId?: string | null } }
  if (c?.adGroup?.id) return c.adGroup.id
  if (c?.searchTerm?.externalAdGroupId) return ids.external.get(c.searchTerm.externalAdGroupId) ?? null
  if (c?.adTarget?.id) return ids.ofTarget.get(c.adTarget.id) ?? null
  return null
}

/**
 * An ad-group scope as a rule stores it: the ad group exists in this business and its campaign is the scope's campaign
 * (set from it; a different campaign named beside it is refused). The scope unchanged when it names no ad group.
 */
export async function adGroupScope<S extends { adGroupId?: string | null; campaignId?: string | null }>(scope: S): Promise<{ ok: true; scope: S } | { ok: false; error: string }> {
  if (!scope.adGroupId) return { ok: true, scope }
  const group = await prisma.adGroup.findUnique({ where: { id: scope.adGroupId }, select: { campaignId: true } })
  if (!group) return { ok: false, error: `scope.adGroupId ${scope.adGroupId}: not found in this business` }
  if (scope.campaignId && scope.campaignId !== group.campaignId) return { ok: false, error: `scope.adGroupId ${scope.adGroupId} belongs to campaign ${group.campaignId}, not ${scope.campaignId}` }
  return { ok: true, scope: { ...scope, campaignId: group.campaignId } }
}

/**
 * Review N4 — the one market a narrow scope reaches (a portfolio, a campaign, an ad group or a product all in one market),
 * stored as the rule's market at save so every reader agrees (the Rules view, the tab counts, the evaluator). Null for a
 * market already named, a whole-account scope, a scope across several markets, or a campaign with no market.
 */
export async function marketOfScope(scope: { marketplace?: string | null; portfolioId?: string | null; campaignId?: string | null; adGroupId?: string | null; productId?: string | null }): Promise<string | null> {
  if (scope.marketplace || !(scope.portfolioId || scope.campaignId || scope.adGroupId || scope.productId)) return null
  const { ruleReachedMarkets } = await import('../ads-rule-reach.service.js')
  const reached = await ruleReachedMarkets({ id: 'scope', scopeMarketplace: null, scopePortfolioId: scope.portfolioId ?? null, scopeCampaignId: scope.campaignId ?? null, scopeProductId: scope.productId ?? null })
  return reached.markets.length === 1 && reached.withoutMarket === 0 ? reached.markets[0] : null
}
