/**
 * ADS AUTONOMY W3-3 — stock-aware bids: which advertised products are short of stock, which ad groups advertise ONLY
 * such products, and what lowering (or giving back) their bids would move (agent-results/6 §4 W3-3; Owner 2026-10-06: a
 * stock problem LOWERS bids — to the floor, or by the strategy's step — and restores them when cover returns; never a
 * pause; never an Amazon FBA quantity). Read only: the writes are made by Claude's lower-ad-bids-for-stock and
 * restore-ad-bids-after-stock, approved like every ad change. AdGroup is advertising's own storage, so the tools read it
 * through here.
 *
 *   units      a product's units as the retail guard counts them (productReadinessReader): the ledger it sells from (its
 *              own warehouses, or the pool it borrows from) plus the units Amazon and the channels hold. Amazon's FBA
 *              number is shown apart and is only ever read.
 *   pace       units sold a day: the velocity of the product's latest replenishment suggestion (forecast, or the trailing
 *              30 days), with its date. None: its cover is unknown, and only "out of stock" counts.
 *   shared     a product selling from another business's pool: that business sells the same units, and its sales are not
 *              in this pace, so a cover would be overstated. It counts only when the pool is out of stock.
 *   lines      no business number in code — each product's own replenishment numbers: short of stock below its lead
 *              time (a reorder cannot land before it runs out), back above its lead time + safety days (the gap keeps a
 *              restore from flipping straight back). A read may ask with its own line instead (`lowBelowDays`).
 *   ad group   out-of-stock (every product out), low-stock (every product short, at least one not out), mixed (some
 *              short, some not: never lowered as a whole — split it, or lower single bids), shared (a product on shared
 *              stock in it), ok, unknown (an enabled ad Nexus cannot tie to a product), none (no enabled product ad).
 *   floor      out of stock: the ads strategy's stop bid for the ad group (the safer across its products), else the
 *              2-cent floor — the existing ad-group floor (lowerAdGroupBids), its bids remembered.
 *   step       short: ONE step down by the largest bid change per action (the lower of the ads strategy's and the
 *              campaign's own guardrail, the step clamp's rule), never below the lowest bid that binds it — a PLAIN bid
 *              lowering with no floor markers, so every stop (a cap, the retail guard, a night or Min-bid window,
 *              suppress-campaign) still floors such an ad group. Its from → to bids are kept in the request's own change
 *              record; a give-back follows those records back only while a bid still equals its stepped value.
 */
import prisma from '../../db.js'
import { productReadinessReader } from './ads-retail-readiness.service.js'
import { giveBackBounds, restoreBidsFor, SUPPRESSION_FLOOR_CENTS } from './ads-bid-suppression.service.js'
import { openStrategy } from './ads-strategy/effective.js'
import { limitsOf, strategyMarket } from './ads-strategy/bids.js'
import type { StrategySource } from './ads-strategy/resolve.js'

/** The most ad groups one read looks at; a wider question names a market or campaigns. */
export const STOCK_READ_MAX_AD_GROUPS = 2000
/**
 * The lowest bid a plain step may set: the mutation layer's floor for a write that is not a person's own (a run by rule;
 * ads-mutation.service.ts ENGINE_BID_FLOOR_CENTS), so the step the preview shows is the one that lands either way.
 */
export const STEP_MIN_CENTS = 5

// ── Pure: a product, an ad group, a bid, a step record ────────────────────────────────────────────

export type ProductStockRisk = 'out-of-stock' | 'low-stock' | 'shared' | 'ok'
export type AdGroupStockRisk = 'out-of-stock' | 'low-stock' | 'mixed' | 'shared' | 'ok' | 'unknown' | 'none'
/** What the read and the tools say of a product on shared stock. */
export const SHARED_WORDS = 'shared stock: the other business\'s sales are not counted'

/** Days of cover to one decimal, rounded down (never more cover than there is). */
const coverOf = (units: number, perDay: number | null): number | null => (perDay != null && perDay > 0 ? Math.floor((units / perDay) * 10) / 10 : null)

/**
 * One product's stock against its own lines. Out of stock: no unit to sell (a pool too). Shared: in stock from another
 * business's pool — its cover is not judged. Low: its cover is below the line. Recovered: in stock, and its cover reaches
 * the restart line — or no pace or no line is known (or it is shared), so nothing says it is short.
 */
export function productStockRisk(p: { units: number; unitsPerDay: number | null; lowBelowDays: number | null; restoreAtDays: number | null; pooled?: boolean }): { risk: ProductStockRisk; daysOfCover: number | null; recovered: boolean } {
  if (p.units <= 0) return { risk: 'out-of-stock', daysOfCover: 0, recovered: false }
  if (p.pooled) return { risk: 'shared', daysOfCover: null, recovered: true }
  const daysOfCover = coverOf(p.units, p.unitsPerDay)
  const low = daysOfCover != null && p.lowBelowDays != null && daysOfCover < p.lowBelowDays
  const recovered = daysOfCover == null || p.restoreAtDays == null || daysOfCover >= p.restoreAtDays
  return { risk: low ? 'low-stock' : 'ok', daysOfCover, recovered }
}

/** An ad group's verdict from its products (enabled product ads only). `unknownAds`: enabled ads Nexus cannot tie to a product. */
export function adGroupStockRisk(products: ReadonlyArray<{ risk: ProductStockRisk }>, unknownAds: number): AdGroupStockRisk {
  const short = products.filter((p) => p.risk === 'out-of-stock' || p.risk === 'low-stock').length
  const shared = products.some((p) => p.risk === 'shared')
  if (!short) return products.length ? (shared ? 'shared' : 'ok') : unknownAds ? 'unknown' : 'none'
  if (unknownAds) return 'unknown'
  if (shared) return 'shared'
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

/** One step down (rounded as the mutation layer's step clamp rounds), never below `minCents`; never up. */
export function stockSteppedCents(currentCents: number, minCents: number, stepPct: number): number {
  if (currentCents <= minCents) return currentCents
  return Math.max(minCents, Math.round(currentCents * (1 - stepPct / 100)))
}

/** A step lowering as its change record keeps it: each bid it moved, `${kind}:${id}` → from → to. */
export interface StepRecord { approvalId: string; bids: ReadonlyMap<string, { fromCents: number; toCents: number }> }

/**
 * Where a bid goes back to through the step records (newest first): while the bid equals a record's stepped value, the
 * value that record moved it from. `moved`: the newest record that names it stepped it to another value — an engine or a
 * person moved it since, so it is left as it is. `cents` null: nothing to give back.
 */
export function chainStepBack(key: string, valueCents: number, records: readonly StepRecord[]): { cents: number | null; moved: boolean } {
  let value = valueCents, chained = false
  for (const r of records) {
    const step = r.bids.get(key)
    if (!step) continue
    if (step.toCents !== value) return { cents: chained ? value : null, moved: !chained }
    value = step.fromCents
    chained = true
  }
  return { cents: chained ? value : null, moved: false }
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
  /** It sells from another business's pool (SHARED_WORDS). */
  pooled: boolean
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
    const pooled = r.pooled === true
    const judged = productStockRisk({ units, unitsPerDay: pace?.unitsPerDay ?? null, lowBelowDays, restoreAtDays, pooled })
    products.set(id, {
      known: r.sku != null, productId: id, sku: r.sku, name: r.name, units, warehouseUnits: r.warehouseQty ?? 0, amazonFbaUnits: r.amazonFbaQty ?? 0, pooled,
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

/**
 * Each product's latest replenishment suggestion — its pace (units a day), lead time, safety days, inbound units and
 * date — one row per product read (DISTINCT ON: never every suggestion ever kept).
 */
async function latestPaces(productIds: string[]): Promise<Map<string, { unitsPerDay: number | null; leadTimeDays: number; safetyDays: number; inboundUnits: number; asOf: Date }>> {
  if (!productIds.length) return new Map()
  const rows = await prisma.$queryRaw<Array<{ productId: string; velocity: unknown; leadTimeDays: number; safetyDays: number; inboundWithinLeadTime: number; generatedAt: Date }>>`
    SELECT DISTINCT ON ("productId") "productId", velocity, "leadTimeDays", "safetyDays", "inboundWithinLeadTime", "generatedAt"
    FROM "ReplenishmentRecommendation"
    WHERE "productId" = ANY(${productIds}::text[])
    ORDER BY "productId", "generatedAt" DESC, id DESC`
  const out = new Map<string, { unitsPerDay: number | null; leadTimeDays: number; safetyDays: number; inboundUnits: number; asOf: Date }>()
  for (const r of rows) {
    const perDay = Number(r.velocity)
    out.set(r.productId, { unitsPerDay: Number.isFinite(perDay) ? perDay : null, leadTimeDays: r.leadTimeDays, safetyDays: r.safetyDays, inboundUnits: r.inboundWithinLeadTime, asOf: r.generatedAt })
  }
  return out
}

export interface StockBidRule {
  /** Out of stock: the floor (the strategy's stop bid, else 2¢). */
  floorCents: number
  floorFrom: StrategySource | null
  /** Short: the step, and the lowest bid it may set (the floor, the lowest bid that binds the ad group, the 5¢ write floor). */
  stepPct: number | null
  stepBy: 'strategy' | 'campaign' | null
  stepFrom: StrategySource | null
  stepMinCents: number
}

/** Each ad group's floor and step (stockStepOf), each market's strategy opened once, each campaign's bounds read once. */
export async function stockBidRules(groups: ReadonlyArray<Pick<StockAdGroup, 'id' | 'campaign'>>): Promise<Map<string, StockBidRule>> {
  const byMarket = new Map<string, Array<Pick<StockAdGroup, 'id' | 'campaign'>>>()
  for (const g of groups) {
    const market = strategyMarket(g.campaign.marketplace) ?? ''
    byMarket.set(market, [...(byMarket.get(market) ?? []), g])
  }
  const byCampaign = new Map<string, string[]>()
  for (const g of groups) byCampaign.set(g.campaign.id, [...(byCampaign.get(g.campaign.id) ?? []), g.id])
  // The lowest bid that binds each ad group (its campaign's own bounds, the bid policies, the ads strategy band).
  const lowest = new Map<string, number | null>()
  for (const [campaignId, ids] of byCampaign) {
    const boundsOf = await giveBackBounds(campaignId, ids)
    for (const id of ids) lowest.set(id, boundsOf(id).min?.value ?? null)
  }
  const out = new Map<string, StockBidRule>()
  for (const [market, list] of byMarket) {
    const view = market ? await openStrategy(market) : null
    const resolved = view && !view.empty ? await view.forAdGroups(list.map((g) => g.id)) : new Map()
    for (const g of list) {
      const e = resolved.get(g.id) ?? null
      const stopFrom = e?.resolved.fields.get('stop')?.source ?? null
      const floorCents = e?.values.stop && stopFrom ? e.values.stop.bidCents : SUPPRESSION_FLOOR_CENTS
      const strategyStep = e ? limitsOf(e).maxChangePct : null
      const step = stockStepOf(g.campaign.dynamicBidding, strategyStep?.value ?? null)
      out.set(g.id, {
        floorCents, floorFrom: e?.values.stop && stopFrom ? stopFrom : null,
        stepPct: step.pct, stepBy: step.by, stepFrom: step.by === 'strategy' ? strategyStep?.source ?? null : null,
        stepMinCents: Math.max(floorCents, STEP_MIN_CENTS, lowest.get(g.id) ?? 0),
      })
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
  /** The bid the ad group's own floor remembers (what lifting it puts back), or null. */
  rememberedCents: number | null
  /** A give-back held inside a bid limit instead of the bid it had: which one. */
  heldBy?: string | null
  /** A give-back that goes back through the stock steps (a plain write after the floor's own give-back, if any). */
  viaSteps?: boolean
}

export const moveKey = (m: Pick<StockBidMove, 'kind' | 'id'>) => `${m.kind}:${m.id}`

/**
 * The bids lowering ONE ad group moves: to the floor (out of stock — what lowerAdGroupBids writes: its default bid and
 * every keyword and target bid above the floor, never a negative), or one step down (short — a plain lowering of the
 * same bids, never below `minCents`).
 */
export async function stockLoweringMoves(group: Pick<StockAdGroup, 'id' | 'name' | 'defaultBidCents'>, how: { floorCents: number } | { stepPct: number; minCents: number }): Promise<StockBidMove[]> {
  const floor = 'floorCents' in how ? how.floorCents : how.minCents
  const to = (cents: number) => ('floorCents' in how ? (cents > floor ? floor : cents) : stockSteppedCents(cents, how.minCents, how.stepPct))
  const moves: StockBidMove[] = []
  const memory = await prisma.adGroup.findUnique({ where: { id: group.id }, select: { suppressedFromBidCents: true } })
  if (to(group.defaultBidCents) < group.defaultBidCents) moves.push({ kind: 'adGroup', id: group.id, text: group.name, fromCents: group.defaultBidCents, toCents: to(group.defaultBidCents), rememberedCents: memory?.suppressedFromBidCents ?? null })
  const targets = await prisma.adTarget.findMany({
    where: { adGroupId: group.id, isNegative: false, bidCents: { gt: floor } },
    select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
    orderBy: { id: 'asc' },
  })
  for (const t of targets) if (to(t.bidCents) < t.bidCents) moves.push({ kind: 'target', id: t.id, text: t.expressionValue, fromCents: t.bidCents, toCents: to(t.bidCents), rememberedCents: t.suppressedFromBidCents })
  return moves
}

/**
 * The bids a give-back of ONE ad group puts back: under its own floor, each remembered bid (as restoreAdGroupBids gives
 * it back); then, through the stock steps on record (newest first), each bid that still equals its stepped value goes back
 * to the value it was stepped from (chainStepBack). Every value is held inside the campaign's own bounds, the bid policies
 * and the ads strategy band (restoreBidsFor). `moved`: bids a step lowered that an engine or a person moved since — left.
 */
export async function stockGiveBackMoves(
  group: Pick<StockAdGroup, 'id' | 'name' | 'campaign' | 'ownFloor'>, records: readonly StepRecord[],
): Promise<{ moves: StockBidMove[]; moved: Array<{ kind: 'adGroup' | 'target'; id: string; text: string; nowCents: number }> }> {
  const stepped = new Set(records.flatMap((r) => [...r.bids.keys()]))
  const targetIds = [...stepped].filter((k) => k.startsWith('target:')).map((k) => k.slice('target:'.length))
  const floored = !!group.ownFloor
  const [own, targets] = await Promise.all([
    prisma.adGroup.findUnique({ where: { id: group.id }, select: { defaultBidCents: true, suppressedFromBidCents: true } }),
    prisma.adTarget.findMany({
      where: { adGroupId: group.id, OR: [...(floored ? [{ suppressedFromBidCents: { not: null } }] : []), ...(targetIds.length ? [{ id: { in: targetIds } }] : [])] },
      select: { id: true, expressionValue: true, bidCents: true, suppressedFromBidCents: true },
      orderBy: { id: 'asc' },
    }),
  ])
  const entities = [
    ...(own ? [{ kind: 'adGroup' as const, id: group.id, text: group.name, bidCents: own.defaultBidCents, remembered: own.suppressedFromBidCents }] : []),
    ...targets.map((t) => ({ kind: 'target' as const, id: t.id, text: t.expressionValue, bidCents: t.bidCents, remembered: t.suppressedFromBidCents })),
  ]
  const wanted: Array<{ e: (typeof entities)[number]; cents: number; viaSteps: boolean }> = []
  const moved: Array<{ kind: 'adGroup' | 'target'; id: string; text: string; nowCents: number }> = []
  for (const e of entities) {
    const key = moveKey(e)
    // Under its own floor the remembered bid comes back first; a step is followed from there.
    const base = floored && e.remembered != null ? e.remembered : e.bidCents
    const back = stepped.has(key) ? chainStepBack(key, base, records) : { cents: null, moved: false }
    if (back.moved) moved.push({ kind: e.kind, id: e.id, text: e.text, nowCents: e.bidCents })
    const cents = back.cents ?? (floored && e.remembered != null ? e.remembered : null)
    if (cents != null && cents !== e.bidCents) wanted.push({ e, cents, viaSteps: back.cents != null })
  }
  const held = await restoreBidsFor(group.campaign.id, wanted.map((w) => ({ id: moveKey(w.e), adGroupId: group.id, bidCents: w.e.bidCents, suppressedFromBidCents: w.cents })))
  const moves = wanted.map((w): StockBidMove => ({
    kind: w.e.kind, id: w.e.id, text: w.e.text, fromCents: w.e.bidCents, toCents: held.get(moveKey(w.e))?.cents ?? w.cents,
    rememberedCents: w.e.remembered, heldBy: held.get(moveKey(w.e))?.heldBy ?? null, viaSteps: w.viaSteps,
  }))
  return { moves, moved }
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

/** The bids now of ad group defaults and targets (`${kind}:${id}` → cents; a row gone is absent). */
export async function stockBidsNow(keys: readonly string[]): Promise<Map<string, number>> {
  const groupIds = keys.filter((k) => k.startsWith('adGroup:')).map((k) => k.slice('adGroup:'.length))
  const targetIds = keys.filter((k) => k.startsWith('target:')).map((k) => k.slice('target:'.length))
  const [groups, targets] = await Promise.all([
    groupIds.length ? prisma.adGroup.findMany({ where: { id: { in: groupIds } }, select: { id: true, defaultBidCents: true } }) : [],
    targetIds.length ? prisma.adTarget.findMany({ where: { id: { in: targetIds } }, select: { id: true, bidCents: true } }) : [],
  ])
  return new Map([...groups.map((g) => [`adGroup:${g.id}`, g.defaultBidCents] as const), ...targets.map((t) => [`target:${t.id}`, t.bidCents] as const)])
}
