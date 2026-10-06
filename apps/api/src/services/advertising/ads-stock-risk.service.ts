/**
 * ADS AUTONOMY W3-3 — stock-aware bids: which advertised products are short of stock, which ad groups advertise ONLY
 * such products, and what lowering (or giving back) their bids would move (agent-results/6 §4 W3-3; Owner 2026-10-06: a
 * stock problem LOWERS bids — to the floor, or by the strategy's step — and restores them when cover returns; never a
 * pause; never an Amazon FBA quantity). Read only: the writes are lowerAdGroupBids / restoreAdGroupBids
 * (ads-bid-suppression.service.ts), asked for by Claude's lower-ad-bids-for-stock and restore-ad-bids-after-stock and
 * approved like every ad change. AdGroup is advertising's own storage, so the tools read it through here.
 *
 *   units      a product's units as the retail guard counts them (productReadinessReader): the ledger it sells from (its
 *              own warehouses, or the pool it borrows from) plus the units Amazon and the channels hold. Amazon's FBA
 *              number is shown apart and is only ever read.
 *   pace       units sold a day: the velocity of the product's latest replenishment suggestion (forecast, or the trailing
 *              30 days), with its date. None: its cover is unknown, and only "out of stock" counts.
 *   lines      no business number in code — each product's own replenishment numbers: short of stock below its lead
 *              time (a reorder cannot land before it runs out), back above its lead time + safety days (the gap keeps a
 *              restore from flipping straight back). A read may ask with its own line instead (`lowBelowDays`).
 *   ad group   out-of-stock (every product out), low-stock (every product short, at least one not out), mixed (some
 *              short, some not: never lowered as a whole — split it, or lower single bids), ok, unknown (an enabled ad
 *              Nexus cannot tie to a product), none (no enabled product ad).
 *   floor      the ads strategy's stop bid for the ad group (the safer across its products), else the 2-cent floor.
 *   step       the largest bid change per action: the lower of the ads strategy's for the ad group and the campaign's own
 *              guardrail (the step clamp's rule, ads-strategy/bids.ts). None set: a short ad group can only go to the floor.
 */
import prisma from '../../db.js'
import { productReadinessReader } from './ads-retail-readiness.service.js'
import { restoreBidsFor, stockLoweredCents, SUPPRESSION_FLOOR_CENTS } from './ads-bid-suppression.service.js'
import { openStrategy } from './ads-strategy/effective.js'
import { limitsOf, strategyMarket } from './ads-strategy/bids.js'
import type { StrategySource } from './ads-strategy/resolve.js'

/** The most ad groups one read looks at; a wider question names a market or campaigns. */
export const STOCK_READ_MAX_AD_GROUPS = 2000

// ── Pure: a product, an ad group, a bid ───────────────────────────────────────────────────────────

export type ProductStockRisk = 'out-of-stock' | 'low-stock' | 'ok'
export type AdGroupStockRisk = 'out-of-stock' | 'low-stock' | 'mixed' | 'ok' | 'unknown' | 'none'

/** Days of cover to one decimal, rounded down (never more cover than there is). */
const coverOf = (units: number, perDay: number | null): number | null => (perDay != null && perDay > 0 ? Math.floor((units / perDay) * 10) / 10 : null)

/**
 * One product's stock against its own lines. Out of stock: no unit to sell. Low: its cover is below the line. Recovered:
 * in stock, and its cover reaches the restart line — or no pace or no line is known, so nothing says it is short.
 */
export function productStockRisk(p: { units: number; unitsPerDay: number | null; lowBelowDays: number | null; restoreAtDays: number | null }): { risk: ProductStockRisk; daysOfCover: number | null; recovered: boolean } {
  if (p.units <= 0) return { risk: 'out-of-stock', daysOfCover: 0, recovered: false }
  const daysOfCover = coverOf(p.units, p.unitsPerDay)
  const low = daysOfCover != null && p.lowBelowDays != null && daysOfCover < p.lowBelowDays
  const recovered = daysOfCover == null || p.restoreAtDays == null || daysOfCover >= p.restoreAtDays
  return { risk: low ? 'low-stock' : 'ok', daysOfCover, recovered }
}

/** An ad group's verdict from its products (enabled product ads only). `unknownAds`: enabled ads Nexus cannot tie to a product. */
export function adGroupStockRisk(products: ReadonlyArray<{ risk: ProductStockRisk }>, unknownAds: number): AdGroupStockRisk {
  const short = products.filter((p) => p.risk !== 'ok').length
  if (!short) return products.length ? 'ok' : unknownAds ? 'unknown' : 'none'
  if (unknownAds) return 'unknown'
  if (short < products.length) return 'mixed'
  return products.every((p) => p.risk === 'out-of-stock') ? 'out-of-stock' : 'low-stock'
}

/** The largest bid change per action for one ad group: the lower of the strategy's and the campaign's guardrail. */
export function stockStepOf(campaignDynamicBidding: unknown, strategyPct: number | null): { pct: number | null; by: 'strategy' | 'campaign' | null } {
  const own = Number((campaignDynamicBidding as { maxBidChangePct?: unknown } | null)?.maxBidChangePct)
  const campaignPct = Number.isFinite(own) && own > 0 ? own : null
  if (campaignPct == null && strategyPct == null) return { pct: null, by: null }
  if (strategyPct != null && (campaignPct == null || strategyPct <= campaignPct)) return { pct: strategyPct, by: 'strategy' }
  return { pct: campaignPct, by: 'campaign' }
}

// ── Reading ───────────────────────────────────────────────────────────────────────────────────────

export interface StockProduct {
  productId: string
  sku: string | null
  name: string | null
  /** Units to sell, as the retail guard counts them. */
  units: number
  /** Of them: in the ledger the product sells from (own warehouses or a pool), and at Amazon FBA (Amazon's number, read only). */
  warehouseUnits: number
  amazonFbaUnits: number
  unitsPerDay: number | null
  /** The replenishment suggestion the pace and the lines come from. */
  paceAsOf: Date | null
  leadTimeDays: number | null
  safetyDays: number | null
  inboundUnits: number | null
  daysOfCover: number | null
  lowBelowDays: number | null
  restoreAtDays: number | null
  risk: ProductStockRisk
  recovered: boolean
  hasBuyBox: boolean | null
}

export interface StockFloor { at: Date; by: string | null; floorCents: number | null }

export interface StockAdGroup {
  id: string
  name: string
  status: string
  defaultBidCents: number
  /** Floored on its own (a person's stock floor, or an engine's), or null. */
  ownFloor: StockFloor | null
  campaign: {
    id: string; name: string; marketplace: string | null; status: string; type: string | null; adProduct: string | null
    currency: string; dailyBudgetCents: number; dynamicBidding: unknown
    /** The campaign stopped with low bids by anyone (the retail guard, the budget engine, a person), or null. */
    floor: { at: Date; by: string | null } | null
  }
  productIds: string[]
  unknownAds: number
  products: StockProduct[]
  risk: AdGroupStockRisk
  /** Every product is back above its restart line (a restore may give its bids back). */
  recovered: boolean
}

const GROUP_SELECT = {
  id: true, name: true, status: true, defaultBidCents: true, bidsSuppressedAt: true, bidsSuppressedBy: true, bidsSuppressedFloorCents: true,
  productAds: { where: { status: 'ENABLED' }, select: { productId: true } },
  campaign: { select: { id: true, name: true, marketplace: true, status: true, type: true, adProduct: true, dailyBudget: true, dailyBudgetCurrency: true, dynamicBidding: true, bidsSuppressedAt: true, bidsSuppressedBy: true } },
} as const

/**
 * The ad groups a question names — by id, by campaign, else the enabled ad groups of the enabled campaigns of a market
 * (or of every market) — each with its products' stock, pace, lines and verdict. In the caller's business (row-level
 * security: another business's id is simply absent). `missing`: ids named that are not here.
 */
export async function readStockAdGroups(q: { adGroupIds?: readonly string[]; campaignIds?: readonly string[]; market?: string | null; lowBelowDays?: number | null }): Promise<{ adGroups: StockAdGroup[]; missing: string[]; capped: boolean }> {
  const groupIds = [...new Set(q.adGroupIds ?? [])], campaignIds = [...new Set(q.campaignIds ?? [])]
  const named = groupIds.length || campaignIds.length
  const where = named
    ? { OR: [...(groupIds.length ? [{ id: { in: groupIds } }] : []), ...(campaignIds.length ? [{ campaignId: { in: campaignIds } }] : [])] }
    : { status: 'ENABLED' as const, campaign: { status: 'ENABLED' as const, ...(q.market ? { marketplace: q.market } : {}) } }
  const rows = await prisma.adGroup.findMany({ where, select: GROUP_SELECT, orderBy: { id: 'asc' }, take: STOCK_READ_MAX_AD_GROUPS + 1 })
  const capped = rows.length > STOCK_READ_MAX_AD_GROUPS
  const groups = rows.slice(0, STOCK_READ_MAX_AD_GROUPS)
  const found = new Set(groups.map((g) => g.id)), foundCampaigns = new Set(groups.map((g) => g.campaign.id))
  const missing = [
    ...groupIds.filter((id) => !found.has(id)).map((id) => `ad group ${id}`),
    // A campaign with no ad group is found but has nothing to judge: named, so it is said.
    ...(campaignIds.length ? (await missingCampaigns(campaignIds.filter((id) => !foundCampaigns.has(id)))).map((id) => `campaign ${id}`) : []),
  ]

  const productIds = [...new Set(groups.flatMap((g) => g.productAds.map((a) => a.productId).filter((id): id is string => !!id)))]
  const [readiness, paces] = await Promise.all([productReadinessReader(productIds), latestPaces(productIds)])
  const products = new Map<string, Omit<StockProduct, 'hasBuyBox'> & { known: boolean }>()
  for (const id of productIds) {
    const r = readiness(id, null)
    const pace = paces.get(id) ?? null
    const lowBelowDays = q.lowBelowDays ?? pace?.leadTimeDays ?? null
    const restoreAtDays = lowBelowDays == null ? null : lowBelowDays + (q.lowBelowDays != null ? 0 : pace?.safetyDays ?? 0)
    const units = r.inStock ? r.availableQty : 0
    const judged = productStockRisk({ units, unitsPerDay: pace?.unitsPerDay ?? null, lowBelowDays, restoreAtDays })
    products.set(id, {
      known: r.sku != null, productId: id, sku: r.sku, name: r.name, units, warehouseUnits: r.warehouseQty ?? 0, amazonFbaUnits: r.amazonFbaQty ?? 0,
      unitsPerDay: pace?.unitsPerDay ?? null, paceAsOf: pace?.asOf ?? null, leadTimeDays: pace?.leadTimeDays ?? null, safetyDays: pace?.safetyDays ?? null,
      inboundUnits: pace?.inboundUnits ?? null, daysOfCover: judged.daysOfCover, lowBelowDays, restoreAtDays, risk: judged.risk, recovered: judged.recovered,
    })
  }

  const adGroups = groups.map((g): StockAdGroup => {
    const ids = [...new Set(g.productAds.map((a) => a.productId).filter((id): id is string => !!id))].sort()
    // An ad of a product that is gone (deleted) is an ad Nexus cannot judge, like one tied to no product.
    const known = ids.filter((id) => products.get(id)?.known)
    const unknownAds = g.productAds.filter((a) => !a.productId).length + (ids.length - known.length)
    const own = known.map((id) => {
      const { known: _known, ...p } = products.get(id)!
      return { ...p, hasBuyBox: readiness(id, g.campaign.marketplace).hasBuyBox }
    })
    const risk = adGroupStockRisk(own, unknownAds)
    return {
      id: g.id, name: g.name, status: String(g.status), defaultBidCents: g.defaultBidCents,
      ownFloor: g.bidsSuppressedAt ? { at: g.bidsSuppressedAt, by: g.bidsSuppressedBy, floorCents: g.bidsSuppressedFloorCents } : null,
      campaign: {
        id: g.campaign.id, name: g.campaign.name, marketplace: g.campaign.marketplace, status: String(g.campaign.status),
        type: g.campaign.type == null ? null : String(g.campaign.type), adProduct: g.campaign.adProduct,
        currency: g.campaign.dailyBudgetCurrency?.trim() || 'EUR', dailyBudgetCents: Math.round(Number(g.campaign.dailyBudget) * 100), dynamicBidding: g.campaign.dynamicBidding,
        floor: g.campaign.bidsSuppressedAt ? { at: g.campaign.bidsSuppressedAt, by: g.campaign.bidsSuppressedBy } : null,
      },
      productIds: known, unknownAds, products: own, risk,
      recovered: !unknownAds && own.length > 0 && own.every((p) => p.recovered),
    }
  })
  return { adGroups, missing, capped }
}

async function missingCampaigns(ids: string[]): Promise<string[]> {
  if (!ids.length) return []
  const there = new Set((await prisma.campaign.findMany({ where: { id: { in: ids } }, select: { id: true } })).map((c) => c.id))
  return ids.filter((id) => !there.has(id))
}

/** Each product's latest replenishment suggestion: its pace (units a day), lead time, safety days, inbound units and date. */
async function latestPaces(productIds: string[]): Promise<Map<string, { unitsPerDay: number | null; leadTimeDays: number; safetyDays: number; inboundUnits: number; asOf: Date }>> {
  if (!productIds.length) return new Map()
  const rows = await prisma.replenishmentRecommendation.findMany({
    where: { productId: { in: productIds } },
    orderBy: [{ generatedAt: 'desc' }, { id: 'desc' }],
    select: { productId: true, velocity: true, leadTimeDays: true, safetyDays: true, inboundWithinLeadTime: true, generatedAt: true },
  })
  const out = new Map<string, { unitsPerDay: number | null; leadTimeDays: number; safetyDays: number; inboundUnits: number; asOf: Date }>()
  for (const r of rows) {
    if (out.has(r.productId)) continue
    const perDay = Number(r.velocity)
    out.set(r.productId, { unitsPerDay: Number.isFinite(perDay) ? perDay : null, leadTimeDays: r.leadTimeDays, safetyDays: r.safetyDays, inboundUnits: r.inboundWithinLeadTime, asOf: r.generatedAt })
  }
  return out
}

/** Each ad group's floor (the strategy's stop bid, else 2¢) and step (StockStepOf), each market's strategy opened once. */
export async function stockBidRules(groups: ReadonlyArray<Pick<StockAdGroup, 'id' | 'campaign'>>): Promise<Map<string, { floorCents: number; floorFrom: StrategySource | null; stepPct: number | null; stepBy: 'strategy' | 'campaign' | null; stepFrom: StrategySource | null }>> {
  const byMarket = new Map<string, Array<Pick<StockAdGroup, 'id' | 'campaign'>>>()
  for (const g of groups) {
    const market = strategyMarket(g.campaign.marketplace) ?? ''
    byMarket.set(market, [...(byMarket.get(market) ?? []), g])
  }
  const out = new Map<string, { floorCents: number; floorFrom: StrategySource | null; stepPct: number | null; stepBy: 'strategy' | 'campaign' | null; stepFrom: StrategySource | null }>()
  for (const [market, list] of byMarket) {
    const view = market ? await openStrategy(market) : null
    const resolved = view && !view.empty ? await view.forAdGroups(list.map((g) => g.id)) : new Map()
    for (const g of list) {
      const e = resolved.get(g.id) ?? null
      const stopFrom = e?.resolved.fields.get('stop')?.source ?? null
      const floorCents = e?.values.stop && stopFrom ? e.values.stop.bidCents : SUPPRESSION_FLOOR_CENTS
      const strategyStep = e ? limitsOf(e).maxChangePct : null
      const step = stockStepOf(g.campaign.dynamicBidding, strategyStep?.value ?? null)
      out.set(g.id, { floorCents, floorFrom: e?.values.stop && stopFrom ? stopFrom : null, stepPct: step.pct, stepBy: step.by, stepFrom: step.by === 'strategy' ? strategyStep?.source ?? null : null })
    }
  }
  return out
}

/** One bid a lowering or a give-back moves: the ad group's default bid, or a keyword's or target's bid. */
export interface StockBidMove {
  kind: 'adGroup' | 'target'
  id: string
  /** The keyword or target text; the ad group's name for its default bid. */
  text: string
  fromCents: number
  toCents: number
  /** The bid remembered before the first lowering (what a give-back puts back), or null. */
  rememberedCents: number | null
  /** A give-back held inside a bid limit instead of the remembered bid: which one. */
  heldBy?: string | null
}

/**
 * The bids lowering ONE ad group moves, decided exactly as lowerAdGroupBids decides them: its default bid and every
 * keyword and target bid above the floor (never a negative), each to stockLoweredCents (ads-bid-suppression.service.ts).
 */
export async function stockLoweringMoves(group: Pick<StockAdGroup, 'id' | 'name' | 'defaultBidCents'>, floorCents: number, stepPct: number | null): Promise<StockBidMove[]> {
  const moves: StockBidMove[] = []
  const memory = await prisma.adGroup.findUnique({ where: { id: group.id }, select: { suppressedFromBidCents: true } })
  const own = stockLoweredCents(group.defaultBidCents, floorCents, stepPct)
  if (own < group.defaultBidCents) moves.push({ kind: 'adGroup', id: group.id, text: group.name, fromCents: group.defaultBidCents, toCents: own, rememberedCents: memory?.suppressedFromBidCents ?? null })
  const targets = await prisma.adTarget.findMany({
    where: { adGroupId: group.id, isNegative: false, bidCents: { gt: floorCents } },
    select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
    orderBy: { id: 'asc' },
  })
  for (const t of targets) {
    const to = stockLoweredCents(t.bidCents, floorCents, stepPct)
    if (to < t.bidCents) moves.push({ kind: 'target', id: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: to, rememberedCents: t.suppressedFromBidCents })
  }
  return moves
}

/**
 * The bids a give-back of ONE ad group's own floor puts back, decided as restoreAdGroupBids decides them: every
 * remembered bid, held inside the campaign's own bounds, the bid policies and the ads strategy band (restoreBidsFor).
 */
export async function stockGiveBackMoves(group: Pick<StockAdGroup, 'id' | 'name' | 'campaign'>): Promise<StockBidMove[]> {
  const [own, targets] = await Promise.all([
    prisma.adGroup.findUnique({ where: { id: group.id }, select: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adTarget.findMany({
      where: { adGroupId: group.id, suppressedFromBidCents: { not: null } },
      select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
      orderBy: { id: 'asc' },
    }),
  ])
  const entries = [
    ...(own?.suppressedFromBidCents != null ? [{ id: `adGroup:${group.id}`, adGroupId: group.id, bidCents: own.defaultBidCents, suppressedFromBidCents: own.suppressedFromBidCents, text: group.name, kind: 'adGroup' as const, entityId: group.id }] : []),
    ...targets.map((t) => ({ id: t.id, adGroupId: group.id, bidCents: t.bidCents, suppressedFromBidCents: t.suppressedFromBidCents as number, text: t.expressionValue, kind: 'target' as const, entityId: t.id })),
  ]
  const back = await restoreBidsFor(group.campaign.id, entries)
  return entries.map((e) => ({
    kind: e.kind, id: e.entityId, text: e.text, fromCents: e.bidCents, toCents: back.get(e.id)?.cents ?? e.suppressedFromBidCents,
    rememberedCents: e.suppressedFromBidCents, heldBy: back.get(e.id)?.heldBy ?? null,
  }))
}

/** Each ad group's own floor now, in the shape a stock change records it (the undo guard compares it). */
export async function stockFloorsNow(adGroupIds: readonly string[]): Promise<Map<string, { floored: boolean; by: string | null }>> {
  const ids = [...new Set(adGroupIds)]
  const rows = ids.length ? await prisma.adGroup.findMany({ where: { id: { in: ids } }, select: { id: true, bidsSuppressedAt: true, bidsSuppressedBy: true } }) : []
  const byId = new Map(rows.map((r) => [r.id, r]))
  return new Map(ids.map((id) => {
    const r = byId.get(id)
    return [id, { floored: !!r?.bidsSuppressedAt, by: r?.bidsSuppressedAt ? r.bidsSuppressedBy ?? null : null }]
  }))
}
