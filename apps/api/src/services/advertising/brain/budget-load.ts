/**
 * ONE BRAIN AB-7 — the facts of the money plan, read in batches for one market (a fixed number of queries whatever the
 * number of campaigns or products; no N+1). Read only: nothing here writes, in Nexus or at Amazon.
 *
 *   market    every Sponsored Products campaign of the market (archived left out) with its owner (brain/ownership.ts),
 *             its daily spend, sales and orders from the daily report (CAMPAIGN rows, the Marketing Stream's daily
 *             duplicates left out), the Owner's monthly budgets (the ads strategy's market, category and product caps, the
 *             Budget Manager's plan, the enrolled playbook rows) → each product's envelope (budget-envelope.ts).
 *   products  for the products to plan in full: the brain's resolved settings (product and campaign overrides), the
 *             Marketing Stream hours (the hour curve over 4 weeks; the hours after the newest reported day), Amazon's
 *             budget usage today (ads-budget-usage.service.ts), the spend guard (bid-brain/spend-guard.ts), the bid brain's
 *             newest goal bids on their keywords, the strategy's ACoS goal (bid-brain/load.ts + goal.ts), the portfolios
 *             (Campaign.portfolioId → AmazonAdsPortfolio, as synced) and today's earlier plan (the ladder's rung).
 *   days      spend counts every complete day the daily report covers (cost does not wait for attribution); ACoS reads
 *             the settled window (ads-settled-window.ts), where sales have stopped arriving.
 */
import { Prisma } from '@prisma/client'
import { marketLimitsOf } from '@nexus/shared/ads-market-limits'
import prisma from '../../../db.js'
import { EXCLUDE_AMS_DAILY } from '../../ads-core/ams-daily.js'
import { strategyMarket } from '../ads-strategy/bids.js'
import { openStrategy, strategySourceWords } from '../ads-strategy/effective.js'
import { readCurrentBudgetUsage } from '../ads-budget-usage.service.js'
import { MARKET_TIME_ZONE } from '../ads-market-time.js'
import { settledBounds } from '../ads-settled-window.js'
import { goalWords, isGoal, resolveGoal, BRAIN_PHASES, type BrainPhase } from '../bid-brain/goal.js'
import { loadStrategy } from '../bid-brain/load.js'
import { loadSpendGuard } from '../bid-brain/spend-guard.js'
import { resolveCampaignOwnership } from './ownership.js'
import { resolveBrainSettings, type OverrideRow } from './settings.js'
import { SHARE_WINDOW_DAYS, splitEnvelopes, type EnvelopeProduct, type MarketSplit } from './budget-envelope.js'
import { averageDaily, dayWeights, HOUR_CURVE_DAYS, hourCurve, moneyClock, monthStart, RUN_RATE_DAYS, type MoneyClock } from './budget-pace.js'
import { SPEND_WINDOW_DAYS, type BandFacts, type CampaignMoneyFacts } from './budget-campaigns.js'
import type { PortfolioFacts } from './budget-portfolio.js'
import type { ProductMoneyFacts, ProductMoneyPlan } from './budget-plan.js'

const DAY_MS = 86_400_000
const SETTLED_DAYS = 14
/** The bid brain's decisions read for the goal-bid ratio: these layers are its goal; a stop or a pin is not. */
const GOAL_LAYERS: ReadonlySet<string> = new Set(['goal', 'band', 'limit', 'restore', 'no_goal'])
const dayKey = (d: Date) => d.toISOString().slice(0, 10)
const cents = (micros: bigint | number | null | undefined) => Math.round(Number(micros ?? 0) / 10_000)
const decimalCents = (d: unknown) => (d == null ? null : Math.round(Number(d) * 100))

interface CampaignRow { id: string; name: string; status: string; marketplace: string | null; dailyBudget: unknown; minBudgetCents: number | null; maxBudgetCents: number | null; portfolioId: string | null; adProduct: string | null }
interface Day { cost: number; sales: number; orders: number }

export interface MarketMoney {
  market: string
  currency: string
  clock: MoneyClock
  split: MarketSplit
  /** The newest day the market's daily report covers (YYYY-MM-DD; null: none in the window). */
  dataThrough: string | null
  products: Map<string, { name: string | null; sku: string | null }>
  /** The facts of each product asked for in full (`plan`); a product with no family here is left out. */
  facts: Map<string, ProductMoneyFacts>
}

/** Sum a campaign's days into a product's (or a portfolio's) days. */
function sumDays(maps: ReadonlyArray<ReadonlyMap<string, Day> | undefined>): Map<string, Day> {
  const out = new Map<string, Day>()
  for (const m of maps) for (const [k, d] of m ?? []) {
    const e = out.get(k) ?? { cost: 0, sales: 0, orders: 0 }
    out.set(k, { cost: e.cost + d.cost, sales: e.sales + d.sales, orders: e.orders + d.orders })
  }
  return out
}
const costOf = (m: ReadonlyMap<string, Day>) => new Map([...m].map(([k, d]) => [k, d.cost]))
const between = (m: ReadonlyMap<string, Day>, from: string, to: string) => {
  const t = { cost: 0, sales: 0, orders: 0 }
  for (const [k, d] of m) if (k >= from && k <= to) { t.cost += d.cost; t.sales += d.sales; t.orders += d.orders }
  return t
}

/**
 * The money facts of one market at `now`, and the full facts of the products in `plan` (family roots). Read only.
 * `previous`: each planned product's newest stored plan of today (its ladder rungs), when the caller read them.
 */
export async function loadMarketMoney(marketIn: string, opts: { now: Date; plan: readonly string[]; previous?: ReadonlyMap<string, Pick<ProductMoneyPlan, 'day' | 'campaigns'>> }): Promise<MarketMoney | null> {
  const market = strategyMarket(marketIn)
  if (!market || !/^[A-Z]{2}$/.test(market)) return null
  const now = opts.now
  const clock = moneyClock(now, MARKET_TIME_ZONE[market] ?? null)
  const limitsRow = marketLimitsOf(market)
  const currency = limitsRow?.currency ?? 'EUR'
  const today = clock.day
  const thisMonth = monthStart(clock.month)
  const lastMonth = monthStart(clock.month, -1)
  const settled = settledBounds(SETTLED_DAYS, 'SPONSORED_PRODUCTS', { now })
  const since = new Date(Math.min(lastMonth.getTime(), Date.parse(`${today}T00:00:00Z`) - (SHARE_WINDOW_DAYS + 1) * DAY_MS, settled.since.getTime()))

  // ── The market: campaigns, owners, daily spend ────────────────────────────────────────────────────────────────────
  const all = (await prisma.campaign.findMany({
    where: { adProduct: 'SPONSORED_PRODUCTS', status: { not: 'ARCHIVED' } },
    select: { id: true, name: true, status: true, marketplace: true, dailyBudget: true, minBudgetCents: true, maxBudgetCents: true, portfolioId: true, adProduct: true },
  })).map((c) => ({ ...c, status: String(c.status) })) as CampaignRow[]
  const campaigns = all.filter((c) => strategyMarket(c.marketplace) === market)
  const ids = campaigns.map((c) => c.id)
  const [owners, daily] = await Promise.all([
    resolveCampaignOwnership(ids),
    ids.length ? prisma.amazonAdsDailyPerformance.groupBy({
      by: ['localEntityId', 'date'],
      where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: since, lt: new Date(`${today}T00:00:00Z`) }, ...EXCLUDE_AMS_DAILY },
      _sum: { costMicros: true, sales7dCents: true, orders7d: true },
    }) : Promise.resolve([]),
  ])
  const byCampaign = new Map<string, Map<string, Day>>()
  let dataThrough: string | null = null
  let dataFrom: string | null = null
  for (const r of daily) {
    if (!r.localEntityId) continue
    const k = dayKey(new Date(r.date))
    if (!dataThrough || k > dataThrough) dataThrough = k
    if (!dataFrom || k < dataFrom) dataFrom = k
    const m = byCampaign.get(r.localEntityId) ?? new Map<string, Day>()
    const e = m.get(k) ?? { cost: 0, sales: 0, orders: 0 }
    m.set(k, { cost: e.cost + cents(r._sum.costMicros), sales: e.sales + (r._sum.sales7dCents ?? 0), orders: e.orders + (r._sum.orders7d ?? 0) })
    byCampaign.set(r.localEntityId, m)
  }
  const ownerOf = (id: string) => owners.get(id)?.owner
  const ownCampaigns = (root: string) => campaigns.filter((c) => { const o = ownerOf(c.id); return o?.kind === 'product' && o.productId === root })
  const sharedCampaigns = (root: string) => campaigns.filter((c) => { const o = ownerOf(c.id); return o?.kind === 'shared' && o.productIds.includes(root) })

  // ── The Owner's monthly budgets ────────────────────────────────────────────────────────────────────────────────
  const roots = new Set<string>(opts.plan)
  for (const c of campaigns) { const o = ownerOf(c.id); if (o?.kind === 'product') roots.add(o.productId) }
  const [view, plans, playbooks] = await Promise.all([
    openStrategy(market),
    prisma.adBudgetPlan.findMany({ where: { month: clock.month }, select: { marketplace: true, tag: true, monthlyBudgetCents: true, calendar: true } }),
    prisma.adsPlaybook.findMany({ where: { channel: 'AMAZON', market, level: 'PRODUCT', enrolled: true }, select: { scopeId: true, dailyBudgetCents: true, label: true, version: true } }),
  ])
  const productRows = await prisma.product.findMany({ where: { id: { in: [...new Set([...roots, ...playbooks.map((p) => p.scopeId)])] } }, select: { id: true, name: true, sku: true, parentId: true } })
  const productById = new Map(productRows.map((p) => [p.id, p]))
  const playbookOf = new Map<string, { cents: number; from: string }>()
  for (const p of playbooks) {
    const root = productById.get(p.scopeId)?.parentId ?? p.scopeId
    if (p.dailyBudgetCents && p.dailyBudgetCents > 0) { playbookOf.set(root, { cents: p.dailyBudgetCents, from: `playbook: ${p.label} v${p.version}` }); roots.add(root) }
  }
  const plan = plans.find((p) => !p.tag && strategyMarket(p.marketplace) === market) ?? null
  const marketCap = view.empty ? null : view.forMarket().values.monthlyCaps.find((c) => c.source.level === 'market' && c.monthlySpendCapCents > 0) ?? null
  const each = await view.forEachProduct([...roots])

  // The trailing window the share reads: SHARE_WINDOW_DAYS days through the newest reported day.
  const shareFrom = dataThrough ? dayKey(new Date(Date.parse(`${dataThrough}T00:00:00Z`) - (SHARE_WINDOW_DAYS - 1) * DAY_MS)) : today
  const trailing = (list: readonly CampaignRow[]) => (dataThrough ? list.reduce((n, c) => n + between(byCampaign.get(c.id) ?? new Map(), shareFrom, dataThrough!).cost, 0) : 0)
  const envelopeProducts: EnvelopeProduct[] = [...roots].sort().map((root) => {
    const caps = each.get(root)?.values.monthlyCaps ?? []
    const own = caps.find((c) => c.source.level === 'product' && c.source.scopeId === root && c.monthlySpendCapCents > 0)
    return {
      productId: root,
      own: own ? { cents: own.monthlySpendCapCents, from: strategySourceWords(own.source) } : null,
      playbookDaily: playbookOf.get(root) ?? null,
      categoryCaps: caps.filter((c) => c.source.level === 'category' && c.monthlySpendCapCents > 0).map((c) => ({ cents: c.monthlySpendCapCents, from: strategySourceWords(c.source) })),
      trailingSpendCents: trailing(ownCampaigns(root)),
    }
  })
  const reserveSpend = trailing(campaigns.filter((c) => ownerOf(c.id)?.kind !== 'product'))
  const split = splitEnvelopes({
    market, month: clock.month, daysInMonth: clock.daysInMonth, windowDays: SHARE_WINDOW_DAYS,
    budget: {
      strategy: marketCap ? { cents: marketCap.monthlySpendCapCents, from: strategySourceWords(marketCap.source) } : null,
      plan: plan && plan.monthlyBudgetCents > 0 ? { cents: plan.monthlyBudgetCents, from: `the Budget Manager's ${clock.month} plan` } : null,
    },
    products: envelopeProducts,
    reserveSpendCents: reserveSpend,
  }, currency)
  const products = new Map([...roots].map((r) => [r, { name: productById.get(r)?.name ?? null, sku: productById.get(r)?.sku ?? null }]))
  const facts = new Map<string, ProductMoneyFacts>()
  const planned = opts.plan.filter((r) => split.envelopes.has(r))
  if (!planned.length) return { market, currency, clock, split, dataThrough, products, facts }

  // ── The products planned in full ───────────────────────────────────────────────────────────────────────────────
  const plannedOwn = new Map(planned.map((r) => [r, ownCampaigns(r)]))
  const plannedShared = new Map(planned.map((r) => [r, sharedCampaigns(r)]))
  const touched = [...new Set([...plannedOwn.values(), ...plannedShared.values()].flat())]
  const touchedIds = touched.map((c) => c.id)
  const ownIds = [...new Set([...plannedOwn.values()].flat().map((c) => c.id))]
  const portfolioIds = [...new Set([...plannedOwn.values()].flat().map((c) => c.portfolioId).filter((p): p is string => !!p))]
  const recentFrom = dataThrough && dataThrough < today ? dayKey(new Date(Date.parse(`${dataThrough}T00:00:00Z`) + DAY_MS)) : dayKey(new Date(Date.parse(`${today}T00:00:00Z`) - 7 * DAY_MS))
  const curveFrom = new Date(Date.parse(`${today}T00:00:00Z`) - HOUR_CURVE_DAYS * DAY_MS)
  const [enrollments, overrides, profile, recent, usage, spikes, decisions, groups, portfolioRows, inPortfolios] = await Promise.all([
    prisma.adsBrainEnrollment.findMany({ where: { productId: { in: planned }, marketplace: market }, select: { productId: true } }),
    prisma.adsBrainOverride.findMany({
      where: { endedAt: null, OR: [{ scope: 'PRODUCT', productId: { in: planned }, marketplace: market }, ...(touchedIds.length ? [{ scope: 'CAMPAIGN', campaignId: { in: touchedIds } }] : [])] },
      select: { id: true, productId: true, marketplace: true, scope: true, campaignId: true, kind: true, key: true, ref: true, value: true, by: true, reason: true, createdAt: true, endedAt: true },
    }) as Promise<OverrideRow[]>,
    ids.length ? prisma.amazonAdsHourlyPerformance.groupBy({ by: ['localEntityId', 'hour'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: curveFrom, lt: new Date(`${today}T00:00:00Z`) } }, _sum: { costMicros: true } }) : Promise.resolve([]),
    ids.length ? prisma.amazonAdsHourlyPerformance.groupBy({ by: ['localEntityId', 'date'], where: { entityType: 'CAMPAIGN', localEntityId: { in: ids }, date: { gte: new Date(`${recentFrom}T00:00:00Z`), lte: new Date(`${today}T00:00:00Z`) } }, _sum: { costMicros: true } }) : Promise.resolve([]),
    readCurrentBudgetUsage(touched.map((c) => ({ id: c.id, adProduct: c.adProduct, dailyBudget: c.dailyBudget as never })), now),
    loadSpendGuard(ownIds, now),
    ownIds.length ? prisma.$queryRaw<Array<{ campaignId: string; currentCents: number; decidedCents: number; layer: string }>>(Prisma.sql`
      SELECT DISTINCT ON (d."targetId") d."campaignId", d."currentCents", d."decidedCents", d.layer
        FROM "BidBrainDecision" d
       WHERE d."campaignId" = ANY(${ownIds}::text[]) AND d."createdAt" >= ${new Date(now.getTime() - 2 * DAY_MS)}
       ORDER BY d."targetId", d."createdAt" DESC`) : Promise.resolve([]),
    ownIds.length ? prisma.adGroup.findMany({ where: { campaignId: { in: ownIds }, status: { not: 'ARCHIVED' } }, select: { id: true, campaignId: true } }) : Promise.resolve([]),
    portfolioIds.length ? prisma.amazonAdsPortfolio.findMany({ where: { externalPortfolioId: { in: portfolioIds } }, select: { externalPortfolioId: true, name: true, budgetAmount: true, budgetPolicy: true, inBudget: true } }) : Promise.resolve([]),
    portfolioIds.length ? prisma.campaign.findMany({ where: { portfolioId: { in: portfolioIds }, status: { not: 'ARCHIVED' } }, select: { id: true, portfolioId: true } }) : Promise.resolve([]),
  ])
  const strategyByGroup = groups.length ? await loadStrategy(market, groups.map((g) => g.id), now) : new Map()
  const enrolled = new Set(enrollments.map((e) => e.productId))

  // The hour curves (UTC hours, 4 complete weeks): each campaign's, summed per product and for the market.
  const hoursOf = new Map<string, number[]>()
  for (const r of profile) {
    if (!r.localEntityId) continue
    const h = hoursOf.get(r.localEntityId) ?? Array.from({ length: 24 }, () => 0)
    h[r.hour] += cents(r._sum.costMicros)
    hoursOf.set(r.localEntityId, h)
  }
  const sumHours = (list: readonly string[]) => list.reduce((acc, id) => { const h = hoursOf.get(id); if (h) h.forEach((x, i) => { acc[i] += x }); return acc }, Array.from({ length: 24 }, () => 0))
  const marketHours = sumHours(ids)
  // The stream after the newest reported day: per campaign, the days before today and today so far.
  const recentOf = new Map<string, { gap: number; today: number }>()
  let streamLive = false
  const yesterday = dayKey(new Date(Date.parse(`${today}T00:00:00Z`) - DAY_MS))
  for (const r of recent) {
    if (!r.localEntityId) continue
    const k = dayKey(new Date(r.date))
    if (k >= yesterday) streamLive = true
    const e = recentOf.get(r.localEntityId) ?? { gap: 0, today: 0 }
    if (k === today) e.today += cents(r._sum.costMicros)
    else if (!dataThrough || k > dataThrough) e.gap += cents(r._sum.costMicros)
    recentOf.set(r.localEntityId, e)
  }
  // The bid brain's goal bids against today's, per campaign (Σ decided ÷ Σ today over its keywords' newest decisions).
  const ratio = new Map<string, { decided: number; current: number }>()
  for (const d of decisions) {
    if (!GOAL_LAYERS.has(d.layer) || !(d.currentCents > 0)) continue
    const e = ratio.get(d.campaignId) ?? { decided: 0, current: 0 }
    ratio.set(d.campaignId, { decided: e.decided + Number(d.decidedCents), current: e.current + Number(d.currentCents) })
  }
  const portfolioById = new Map(portfolioRows.map((p) => [p.externalPortfolioId, p]))

  const reportedThroughDay = dataThrough && dataThrough.startsWith(clock.month) ? Number(dataThrough.slice(8, 10)) : 0
  const monthFrom = dayKey(thisMonth)
  const lastMonthFrom = dayKey(lastMonth)
  const lastMonthTo = dayKey(new Date(thisMonth.getTime() - DAY_MS))
  const spendFrom = dataThrough ? dayKey(new Date(Date.parse(`${dataThrough}T00:00:00Z`) - (SPEND_WINDOW_DAYS - 1) * DAY_MS)) : today
  const settledFrom = dayKey(settled.since)
  const settledTo = dayKey(settled.until)

  for (const root of planned) {
    const own = plannedOwn.get(root) ?? []
    const shared = plannedShared.get(root) ?? []
    const isEnrolled = enrolled.has(root)
    const settings = resolveBrainSettings({ productId: root, market, campaignId: null, enrolled: isEnrolled, overrides })
    const productDays = sumDays(own.map((c) => byCampaign.get(c.id)))
    const spent = between(productDays, monthFrom, dataThrough ?? '').cost
    const stream = streamLive ? own.reduce((acc, c) => { const r = recentOf.get(c.id); return r ? { gapCents: acc.gapCents + r.gap, todayCents: acc.todayCents + r.today } : acc }, { gapCents: 0, todayCents: 0 }) : null
    const runRate = averageDaily(costOf(productDays), dataThrough, RUN_RATE_DAYS, dataFrom)
    const curve = hourCurve(sumHours(own.map((c) => c.id)), marketHours)
    const days = dayWeights(clock.daysInMonth, plan?.calendar)

    // The ACoS goal: the strategy as the bid brain reads it (one product: every own ad group resolves to it).
    const groupIds = groups.filter((g) => own.some((c) => c.id === g.campaignId)).map((g) => g.id)
    const s = groupIds.map((g) => strategyByGroup.get(g)).find((x) => x?.target) ?? null
    const goal = s ? resolveGoal({ target: s.target, acosFallbackPct: s.acosPct, band: s.band, phase: (BRAIN_PHASES as readonly string[]).includes(s.goal ?? '') ? s.goal as BrainPhase : null, launchDay: s.launchDay ?? null }) : null
    const settledProduct = between(productDays, settledFrom, settledTo)
    const band: BandFacts = {
      goal: goal && isGoal(goal) ? { lo: goal.lo, hi: goal.hi, words: goalWords(goal) } : null,
      product: { spendCents: settledProduct.cost, salesCents: settledProduct.sales, orders: settledProduct.orders },
    }

    // Today's earlier plan: the ladder's rungs already given.
    const prev = opts.previous?.get(root)
    const rungOf = new Map((prev && prev.day === today ? prev.campaigns : []).map((c) => [c.campaignId, c.ladder?.pct ?? 0]))
    const campaignFacts: CampaignMoneyFacts[] = [...own.map((c) => ({ c, owner: 'product' as const })), ...shared.map((c) => ({ c, owner: 'shared' as const }))]
      .sort((a, b) => a.c.name.localeCompare(b.c.name) || a.c.id.localeCompare(b.c.id))
      .map(({ c, owner }) => {
        const cs = resolveBrainSettings({ productId: root, market, campaignId: c.id, enrolled: isEnrolled, overrides })
        const d = byCampaign.get(c.id) ?? new Map<string, Day>()
        const u = usage.get(c.id)
        const r = ratio.get(c.id)
        const st = between(d, settledFrom, settledTo)
        return {
          campaignId: c.id, name: c.name, status: c.status, owner,
          todayCents: decimalCents(c.dailyBudget) ?? 0, minCents: c.minBudgetCents, maxCents: c.maxBudgetCents,
          avgDailySpendCents: averageDaily(costOf(d), dataThrough, SPEND_WINDOW_DAYS, dataFrom),
          bidRatio: r && r.current > 0 ? Math.round((r.decided / r.current) * 10_000) / 10_000 : null,
          settled: { spendCents: st.cost, salesCents: st.sales, orders: st.orders },
          usage: u && (u.state === 'live' || u.state === 'derived') && u.fraction != null ? u.fraction : null,
          spikeWhy: spikes.get(c.id) ?? null,
          ladderedTodayPct: rungOf.get(c.id) ?? 0,
          excluded: cs.excluded.value,
          budgets: { effective: cs.levers.budgets.effective, lock: cs.levers.budgets.lock, why: cs.levers.budgets.why },
          budgetUsePct: cs.values.budgetUsePct,
          ladderMaxPct: cs.values.intradayLadderMaxPct,
        }
      })

    // The portfolios its own campaigns sit in.
    const byPortfolio = new Map<string | null, CampaignRow[]>()
    for (const c of own) byPortfolio.set(c.portfolioId, [...(byPortfolio.get(c.portfolioId) ?? []), c])
    const portfolios: PortfolioFacts[] = [...byPortfolio].map(([pid, list]) => {
      const row = pid ? portfolioById.get(pid) : undefined
      const days = sumDays(list.map((c) => byCampaign.get(c.id)))
      const streamIn = list.reduce((n, c) => n + (recentOf.get(c.id)?.gap ?? 0) + (recentOf.get(c.id)?.today ?? 0), 0)
      return {
        portfolioId: pid, name: row?.name ?? null, campaignIds: list.map((c) => c.id),
        otherCampaigns: pid ? inPortfolios.filter((x) => x.portfolioId === pid && !list.some((c) => c.id === x.id)).length : 0,
        lastMonthSpendCents: between(days, lastMonthFrom, lastMonthTo).cost,
        monthSpendCents: between(days, monthFrom, dataThrough ?? '').cost + (streamLive ? streamIn : 0),
        today: row ? { policy: row.budgetPolicy ?? null, amountCents: decimalCents(row.budgetAmount), inBudget: row.inBudget } : null,
      }
    })

    const warnings: string[] = []
    if (!dataThrough) warnings.push('no daily report for this market in the window: spend and run rate are unknown (0)')
    if (!streamLive) warnings.push('no Marketing Stream hours since yesterday: the run rate stands in for the days the daily report does not cover yet')
    if (!band.goal) warnings.push('no ACoS goal in the ads strategy: the band is unknown, so no campaign climbs the ladder')
    facts.set(root, {
      productId: root, name: productById.get(root)?.name ?? null, market, currency, clock, enrolled: isEnrolled,
      settings: { levers: settings.levers, values: settings.values, excluded: settings.excluded },
      envelope: split.envelopes.get(root)!,
      split: { budgetCents: split.budgetCents, budgetFrom: split.budgetFrom, fixedCents: split.fixedCents, sharedCents: split.sharedCents, reserveCents: split.reserveCents, totalCents: split.totalCents, why: split.why, warnings: split.warnings },
      pace: {
        dayWeights: days.from === 'calendar' ? days.weights : null, hourWeights: curve.weights,
        spentCents: spent, reportedThroughDay, stream, runRateCents: runRate,
        dayWeightsFrom: days.from, hourCurveFrom: curve.from, dataThrough,
      },
      portfolios, campaigns: campaignFacts, band,
      limits: limitsRow?.adProducts.SPONSORED_PRODUCTS ? { minCents: limitsRow.adProducts.SPONSORED_PRODUCTS.dailyBudget.min, maxCents: limitsRow.adProducts.SPONSORED_PRODUCTS.dailyBudget.max } : null,
      warnings,
    })
  }
  return { market, currency, clock, split, dataThrough, products, facts }
}
