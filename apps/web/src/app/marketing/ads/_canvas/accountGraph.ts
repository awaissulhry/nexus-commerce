import type { OpsObject, Health } from './types'

export interface ApiCampaign {
  id: string
  name: string
  marketplace: string | null
  portfolioId?: string | null
  spend?: number | string | null
  acos?: number | string | null
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

const NO_PF = 'none'

export function campaignsToObjects(campaigns: ApiCampaign[], portfolios: ApiPortfolio[] = []): OpsObject[] {
  const pfName = new Map(portfolios.map((p) => [p.portfolioId, p.name]))
  const marketSpend = new Map<string, number>()
  const pfAgg = new Map<string, { market: string; pid: string; spend: number }>()
  const campaignObjs: OpsObject[] = []

  for (const c of campaigns) {
    const market = c.marketplace || 'Unknown'
    const pid = c.portfolioId || NO_PF
    const pfKey = `${market}:${pid}`
    const spend = num(c.spend) ?? 0
    const acos = num(c.acos)
    marketSpend.set(market, (marketSpend.get(market) ?? 0) + spend)
    const cur = pfAgg.get(pfKey) ?? { market, pid, spend: 0 }
    cur.spend += spend
    pfAgg.set(pfKey, cur)
    campaignObjs.push({
      id: `c:${c.id}`,
      kind: 'campaign',
      name: c.name,
      parentId: `p:${pfKey}`,
      spend: spend || undefined,
      acos,
      health: healthFromAcos(acos),
    })
  }

  const marketObjs: OpsObject[] = [...marketSpend.entries()].map(([m, spend]) => ({
    id: `m:${m}`,
    kind: 'market',
    name: m,
    spend: spend || undefined,
    health: 'ok',
  }))
  const pfObjs: OpsObject[] = [...pfAgg.entries()].map(([key, v]) => ({
    id: `p:${key}`,
    kind: 'portfolio',
    name: v.pid === NO_PF ? 'No portfolio' : pfName.get(v.pid) ?? v.pid,
    parentId: `m:${v.market}`,
    spend: v.spend || undefined,
    health: 'ok',
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
