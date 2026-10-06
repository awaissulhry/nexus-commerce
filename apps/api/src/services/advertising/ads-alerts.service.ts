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
import { budgetDayStart } from '@nexus/shared/ads-budget-day'

export type AlertType = 'acos_breach' | 'zero_sales' | 'spend_spike' | 'sales_drop'
export type AlertSeverity = 'high' | 'medium'
/** AM-20 — whose number an ACoS alert measured against. */
export type AcosTargetSource = 'campaign' | 'account' | 'default'
export interface Alert {
  id: string; campaignId: string | null; campaignName: string; type: AlertType; severity: AlertSeverity; message: string
  /** acos_breach only: the threshold used (a fraction) and whose it is. */
  acosTarget?: number; acosTargetSource?: AcosTargetSource
}
export interface AlertsResult {
  generatedAt: string; windowDays: number
  /** The fallback threshold for a campaign with no Target ACoS of its own (a fraction). */
  acosThreshold: number
  /** AM-20 — where that fallback came from: the account's default Target ACoS, or Nexus's fixed 50 %. */
  acosThresholdSource: 'account' | 'default'
  /** AM-16 — the complete days compared: the last `windowDays` ending yesterday (UTC), and the same number before. */
  window: { from: string; to: string; priorFrom: string; priorTo: string }
  alerts: Alert[]; counts: Record<AlertType, number>
}

const eur = (cents: number) => `€${(cents / 100).toFixed(2)}`
const pct = (f: number) => `${(f * 100).toFixed(0)}%`
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const DAY = 86_400_000
/** Nexus's own alert threshold when neither the campaign nor the account has a Target ACoS. Not a target. */
const DEFAULT_ACOS_THRESHOLD = 0.5

export async function buildAlerts(opts: { windowDays?: number; acosThreshold?: number; marketplace?: string | null; severity?: AlertSeverity; type?: AlertType; now?: Date } = {}): Promise<AlertsResult> {
  const windowDays = opts.windowDays ?? 7
  const mk = opts.marketplace && opts.marketplace !== 'all' ? opts.marketplace : null
  // AM-16 — complete days only. Both windows used to be timestamps counted back from now, so the recent one ran into
  // today (no daily report yet: one day short) while the prior one held all its days — every "sales fell" alert was
  // biased towards firing. Now: the last `windowDays` complete days (UTC, the day the daily report is cut on), and the
  // same number of days before them.
  const today = budgetDayStart(opts.now ?? new Date())
  const recentSince = new Date(today.getTime() - windowDays * DAY)
  const priorSince = new Date(today.getTime() - 2 * windowDays * DAY)

  // AM-20 — the threshold an ACoS alert measures against: the campaign's own Target ACoS when the Owner set one, else
  // the account's default Target ACoS, else Nexus's fixed 50 % — and the message says which. It used to be 50 % for
  // every campaign and called it "target", so a campaign he targets at 25 % sitting at 45 % raised nothing, and the
  // word named a number he never set. An explicit `acosThreshold` from the caller still wins as the fallback.
  const dial = opts.acosThreshold == null
    ? await prisma.adsAutomationState.findUnique({ where: { id: 'singleton' }, select: { defaultTargetAcosPct: true } }).catch(() => null)
    : null
  const accountPct = dial?.defaultTargetAcosPct ?? null
  const acosThresholdSource: 'account' | 'default' = opts.acosThreshold == null && accountPct != null && accountPct > 0 ? 'account' : 'default'
  const acosThreshold = opts.acosThreshold ?? (acosThresholdSource === 'account' ? accountPct! / 100 : DEFAULT_ACOS_THRESHOLD)

  // Two windows of campaign-grain daily perf, keyed by local Campaign id.
  const [recent, prior] = await Promise.all([
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: recentSince, lt: today }, localEntityId: { not: null } }, _sum: { costMicros: true, sales7dCents: true, orders7d: true, clicks: true } }),
    prisma.amazonAdsDailyPerformance.groupBy({ by: ['localEntityId'], where: { entityType: 'CAMPAIGN', date: { gte: priorSince, lt: recentSince }, localEntityId: { not: null } }, _sum: { costMicros: true, sales7dCents: true } }),
  ])
  const priorMap = new Map(prior.map((p) => [p.localEntityId, { cost: Number(p._sum.costMicros ?? 0) / 10_000, sales: p._sum.sales7dCents ?? 0 }]))

  const ids = recent.map((r) => r.localEntityId).filter(Boolean) as string[]
  // marketplace filter lives here: only campaigns in the chosen market land in cMap, so the
  // loop below (which skips ids not in cMap) naturally scopes alerts + counts to that market.
  const campaigns = await prisma.campaign.findMany({ where: { id: { in: ids }, ...(mk ? { marketplace: mk } : {}) }, select: { id: true, name: true, status: true, dynamicBidding: true } })
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
    // The campaign's own Target ACoS (a fraction, as the Ad Manager stores it); a blank or 0 means "not set".
    const own = Number((c.dynamicBidding as { targetAcos?: unknown } | null)?.targetAcos)
    const hasOwn = Number.isFinite(own) && own > 0
    const target = hasOwn ? own : acosThreshold
    const source: AcosTargetSource = hasOwn ? 'campaign' : acosThresholdSource
    const against = source === 'campaign'
      ? `this campaign's Target ACoS ${pct(target)}`
      : source === 'account'
        ? `the account's default Target ACoS ${pct(target)} (no campaign target set)`
        : opts.acosThreshold != null
          ? `the requested threshold ${pct(target)} (no campaign target set)`
          : `${pct(target)}, Nexus's default alert threshold (no Target ACoS set)`

    if (costCents >= 1000 && orders === 0) {
      alerts.push({ id: `zero:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'zero_sales', severity: 'high', message: `Spent ${eur(costCents)} in the last ${windowDays} complete days with 0 orders.` })
    } else if (acos != null && acos > target && costCents >= 500) {
      alerts.push({ id: `acos:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'acos_breach', severity: acos > target * 1.5 ? 'high' : 'medium', message: `ACOS ${pct(acos)} is over ${against} (${eur(costCents)} spend).`, acosTarget: target, acosTargetSource: source })
    }
    if (p && p.cost > 500 && costCents > p.cost * 2) {
      alerts.push({ id: `spike:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'spend_spike', severity: 'medium', message: `Spend jumped ${eur(Math.round(p.cost))} → ${eur(costCents)} vs the ${windowDays} days before.` })
    }
    if (p && p.sales > 2000 && salesCents < p.sales * 0.5) {
      alerts.push({ id: `drop:${c.id}`, campaignId: c.id, campaignName: c.name, type: 'sales_drop', severity: 'medium', message: `Sales fell ${eur(p.sales)} → ${eur(salesCents)} vs the ${windowDays} days before.` })
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
  return {
    generatedAt: new Date().toISOString(), windowDays, acosThreshold, acosThresholdSource,
    window: { from: ymd(recentSince), to: ymd(new Date(today.getTime() - DAY)), priorFrom: ymd(priorSince), priorTo: ymd(new Date(recentSince.getTime() - DAY)) },
    alerts: list, counts,
  }
}
