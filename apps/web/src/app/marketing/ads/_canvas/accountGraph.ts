import type { OpsObject, OpsDetail, Health } from './types'

export interface ApiCampaign {
  id: string
  name: string
  marketplace: string | null
  portfolioId?: string | null
  spend?: number | string | null
  acos?: number | string | null
  sales?: number | string | null
  roas?: number | string | null
  impressions?: number | string | null
  clicks?: number | string | null
  orders?: number | string | null
  ppcOrders?: number | string | null
  trueProfitCents?: number | string | null
  status?: string | null
  type?: string | null
  dailyBudget?: number | string | null
  lastSyncedAt?: string | null
}
export interface ApiPortfolio {
  portfolioId: string
  name: string
}

const num = (v: unknown): number | undefined => {
  if (v === null || v === undefined || v === '') return undefined
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : undefined
}

function healthFromAcos(acos?: number): Health {
  if (acos === undefined) return 'ok'
  if (acos > 0.5) return 'bad'
  if (acos > 0.35) return 'warn'
  return 'ok'
}

const deriveAcos = (spend: number, sales: number) => (sales > 0 ? spend / sales : undefined)
const deriveRoas = (spend: number, sales: number) => (spend > 0 ? sales / spend : undefined)
/**
 * ACR.0.5 — margin is undefined when profit is UNKNOWN, not 0%.
 *
 * The API now sends a null trueProfitCents when no cost price is loaded (it previously sent a
 * confident 0 computed against a zero COGS). Coercing that null to 0 here and dividing gives
 * a margin of exactly 0%, which reads as "this campaign earns nothing" — the opposite of
 * "we cannot know". The trueProfit cell already rendered '—' correctly via `|| undefined`;
 * only the margin beside it claimed a number.
 */
const deriveMargin = (trueProfitCents: number | null, sales: number) =>
  (trueProfitCents != null && sales > 0 ? trueProfitCents / 100 / sales : undefined)
const maxIso = (a: string | null, b?: string | null) => (!a ? b ?? null : !b ? a : b > a ? b : a)

const NO_PF = 'none'

interface Agg {
  spend: number
  sales: number
  impressions: number
  clicks: number
  orders: number
  trueProfitCents: number
  /** True once any member contributed a KNOWN profit. Without it, a roll-up of
   *  entirely-unknown children would report a confident 0. */
  hasProfit: boolean
  lastSyncedAt: string | null
}
const emptyAgg = (): Agg => ({ spend: 0, sales: 0, impressions: 0, clicks: 0, orders: 0, trueProfitCents: 0, hasProfit: false, lastSyncedAt: null })

function detailFromAgg(a: Agg): OpsDetail {
  return {
    sales: a.sales || undefined,
    roas: deriveRoas(a.spend, a.sales),
    impressions: a.impressions || undefined,
    clicks: a.clicks || undefined,
    orders: a.orders || undefined,
    trueProfitCents: a.hasProfit ? a.trueProfitCents : undefined,
    marginPct: deriveMargin(a.hasProfit ? a.trueProfitCents : null, a.sales),
    lastSyncedAt: a.lastSyncedAt,
  }
}

export function campaignsToObjects(campaigns: ApiCampaign[], portfolios: ApiPortfolio[] = []): OpsObject[] {
  const pfName = new Map(portfolios.map((p) => [p.portfolioId, p.name]))
  const marketAgg = new Map<string, Agg>()
  const pfAgg = new Map<string, { market: string; pid: string; agg: Agg }>()
  const campaignObjs: OpsObject[] = []

  for (const c of campaigns) {
    const market = c.marketplace || 'Unknown'
    const pid = c.portfolioId || NO_PF
    const pfKey = `${market}:${pid}`
    const spend = num(c.spend) ?? 0
    const sales = num(c.sales) ?? 0
    const impressions = num(c.impressions) ?? 0
    const clicks = num(c.clicks) ?? 0
    const orders = num(c.orders) ?? num(c.ppcOrders) ?? 0
    const trueProfitCents = num(c.trueProfitCents) ?? null
    const acos = num(c.acos) ?? deriveAcos(spend, sales)

    const ma = marketAgg.get(market) ?? emptyAgg()
    const pa = pfAgg.get(pfKey)?.agg ?? emptyAgg()
    for (const a of [ma, pa]) {
      a.spend += spend
      a.sales += sales
      a.impressions += impressions
      a.clicks += clicks
      a.orders += orders
      if (trueProfitCents != null) { a.trueProfitCents += trueProfitCents; a.hasProfit = true }
      a.lastSyncedAt = maxIso(a.lastSyncedAt, c.lastSyncedAt)
    }
    marketAgg.set(market, ma)
    pfAgg.set(pfKey, { market, pid, agg: pa })

    campaignObjs.push({
      id: `c:${c.id}`,
      kind: 'campaign',
      name: c.name,
      parentId: `p:${pfKey}`,
      spend: spend || undefined,
      acos,
      health: healthFromAcos(acos),
      detail: {
        sales: sales || undefined,
        roas: num(c.roas) ?? deriveRoas(spend, sales),
        impressions: impressions || undefined,
        clicks: clicks || undefined,
        orders: orders || undefined,
        trueProfitCents: trueProfitCents ?? undefined,
        marginPct: deriveMargin(trueProfitCents, sales),
        status: c.status ?? undefined,
        adType: c.type ?? undefined,
        dailyBudget: num(c.dailyBudget),
        lastSyncedAt: c.lastSyncedAt ?? null,
      },
    })
  }

  const marketObjs: OpsObject[] = [...marketAgg.entries()].map(([m, a]) => ({
    id: `m:${m}`,
    kind: 'market',
    name: m,
    spend: a.spend || undefined,
    acos: deriveAcos(a.spend, a.sales),
    health: healthFromAcos(deriveAcos(a.spend, a.sales)),
    detail: detailFromAgg(a),
  }))
  const pfObjs: OpsObject[] = [...pfAgg.entries()].map(([key, v]) => ({
    id: `p:${key}`,
    kind: 'portfolio',
    name: v.pid === NO_PF ? 'No portfolio' : pfName.get(v.pid) ?? v.pid,
    parentId: `m:${v.market}`,
    spend: v.agg.spend || undefined,
    acos: deriveAcos(v.agg.spend, v.agg.sales),
    health: healthFromAcos(deriveAcos(v.agg.spend, v.agg.sales)),
    detail: detailFromAgg(v.agg),
  }))
  return [...marketObjs, ...pfObjs, ...campaignObjs]
}

export function visibleObjects(objects: OpsObject[], expanded: Set<string>): OpsObject[] {
  const byId = new Map(objects.map((o) => [o.id, o]))
  const visible = (o: OpsObject): boolean => {
    if (!o.parentId) return true
    const parent = byId.get(o.parentId)
    if (!parent) return true
    return expanded.has(parent.id) && visible(parent)
  }
  return objects.filter(visible)
}

export function childParentIds(objects: OpsObject[]): Set<string> {
  const s = new Set<string>()
  for (const o of objects) if (o.parentId) s.add(o.parentId)
  return s
}
