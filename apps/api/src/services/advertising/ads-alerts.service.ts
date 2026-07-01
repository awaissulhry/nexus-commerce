/**
 * AX2.12 — Ads alerts (anomaly watch).
 *
 * "What's going wrong right now" across the account — distinct from
 * Recommendations ("what to do to improve"). Computes recent-vs-prior
 * campaign performance from AmazonAdsDailyPerformance and flags ACOS
 * breaches, zero-sales spenders, spend spikes, and sales drops. Read-only;
 * powers the alerts strip on the Recommendations surface and can back an
 * email/Slack digest later.
 */

import prisma from '../../db.js'

export type AlertType = 'acos_breach' | 'zero_sales' | 'spend_spike' | 'sales_drop'
export type AlertSeverity = 'high' | 'medium'
export interface Alert { id: string; campaignId: string | null; campaignName: string; type: AlertType; severity: AlertSeverity; message: string }
export interface AlertsResult { generatedAt: string; windowDays: number; acosThreshold: number; alerts: Alert[]; counts: Record<AlertType, number> }

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`

export async function buildAlerts(opts: { windowDays?: number; acosThreshold?: number; marketplace?: string | null; severity?: AlertSeverity; type?: AlertType } = {}): Promise<AlertsResult> {
  const windowDays = opts.windowDays ?? 7
  const acosThreshold = opts.acosThreshold ?? 0.5
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null
  const now = Date.now()
  const recentSince = new Date(now - windowDays * 86_400_000)
  const priorSince = new Date(now - 2 * windowDays * 86_400_000)

  // Two windows of campaign-grain daily perf, keyed by local Campaign id.
  const [recent, prior] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: recentSince }, localEntityId: { not: null } }, _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: priorSince, lt: recentSince }, localEntityId: { not: null } }, _sum: { costMicros: true, sales7dCents: true } }),
  ])
  const priorMap = new Map(prior.map((p) => [p.localEntityId, { cost: Number(p._sum.costMicros ?? 0) / 10_000, sales: p._sum.sales7dCents ?? 0 }]))

  const ids = recent.map((r) => r.localEntityId).filter(Boolean) as string[]
  // marketplace filter lives here: only campaigns in the chosen market land in cMap, so the
  // loop below (which skips ids not in cMap) naturally scopes alerts + counts to that market.
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids }, ...(mk ? { marketplace: mk } : {}) }, select: { id: true, name: true, status: true } })
  const cMap = new Map(campaigns.map((c) => [c.id, c]))

  const alerts: Alert[] = []
  for (const r of recent) {
    const c = r.localEntityId ? cMap.get(r.localEntityId) : null
    if (!c || c.status !== 'ENABLED') continue
    const costCents = Math.round(Number(r._sum.costMicros ?? 0) / 10_000)
    const salesCents = r._sum.sales7dCents ?? 0
    const orders = r._sum.orders7d ?? 0
    const acos = salesCents > 0 ? costCents / salesCents : null
    const p = priorMap.get(r.localEntityId)

    if (costCents >= 1000 && orders === 0) {
      alerts.push({ id: `zero:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'zero_sales', severity: 'high', message: `Spent ${eur(costCents)} in ${windowDays}d with 0 orders.` })
    } else if (acos != null && acos > acosThreshold && costCents >= 500) {
      alerts.push({ id: `acos:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'acos_breach', severity: acos > acosThreshold * 1.5 ? 'high' : 'medium', message: `ACOS ${(acos * 100).toFixed(0)}% over target ${(acosThreshold * 100).toFixed(0)}% (${eur(costCents)} spend).` })
    }
    if (p && p.cost > 500 && costCents > p.cost * 2) {
      alerts.push({ id: `spike:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'spend_spike', severity: 'medium', message: `Spend jumped ${eur(Math.round(p.cost))} → ${eur(costCents)} vs prior ${windowDays}d.` })
    }
    if (p && p.sales > 2000 && salesCents < p.sales * 0.5) {
      alerts.push({ id: `drop:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'sales_drop', severity: 'medium', message: `Sales fell ${eur(p.sales)} → ${eur(salesCents)} vs prior ${windowDays}d.` })
    }
  }

  const sevRank = { high: 0, medium: 1 }
  alerts.sort((a, b) => sevRank[a.severity] - sevRank[b.severity])
  // counts reflect the market-scoped set (all types) so filter chips show real totals; the
  // returned list is then narrowed by the optional severity/type filter.
  const counts: Record<AlertType, number> = { acos_breach: 0, zero_sales: 0, spend_spike: 0, sales_drop: 0 }
  for (const a of alerts) counts[a.type]++
  let list = alerts
  if (opts.type) list = list.filter((a) => a.type === opts.type)
  if (opts.severity) list = list.filter((a) => a.severity === opts.severity)
  return { generatedAt: new Date().toISOString(), windowDays, acosThreshold, alerts: list, counts }
}
