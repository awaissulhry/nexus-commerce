/**
 * AC P-F.2 — Autopilot backtest / projection. Runs the Conductor on the plan's trailing-window
 * signals (what AUTO would propose right now), summarises the projected impact (action mix +
 * current→projected daily budget vs the spend cap), and returns the last-N-day spend/ACoS
 * trajectory from the AMS hourly store for context. Lets an operator preview behaviour BEFORE
 * flipping autonomy to AUTO. (hasData=false until Amazon Marketing Stream is provisioned.)
 */
import prisma from '../../../db.js'
import { runConductorCycle, type PlanModules } from './conductor.js'
import { DEFAULT_GUARDRAILS, type Goal, type Guardrails } from './presets.js'
import { gatherSignals } from '../../../jobs/ad-autopilot.job.js'

export async function backtestPlan(opts: { campaignIds: string[]; goal: Goal; guardrails: Partial<Guardrails>; modules: PlanModules; days: number }) {
  const { campaignIds, goal, modules, days } = opts
  const g: Guardrails = { ...DEFAULT_GUARDRAILS, ...opts.guardrails }
  const signals = await gatherSignals(campaignIds)
  const result = runConductorCycle({ goal, guardrails: opts.guardrails, modules, signals })

  // projected impact
  const byType: Record<string, number> = {}
  for (const a of result.actions) byType[a.action] = (byType[a.action] ?? 0) + 1
  const currentDailyBudgetCents = signals.reduce((n, s) => n + s.dailyBudgetCents, 0)
  const projectedDailyBudgetCents = signals.reduce((n, s) => {
    const up = result.actions.find((a) => a.campaignId === s.campaignId && a.module === 'budget')
    return n + (up?.afterCents ?? s.dailyBudgetCents)
  }, 0)

  // historical daily trajectory (context) from the AMS hourly store
  const since = new Date(); since.setUTCDate(since.getUTCDate() - days); since.setUTCHours(0, 0, 0, 0)
  const camps = await prisma.campaign.findMany({ where: { id: { in: campaignIds } }, select: { externalCampaignId: true } })
  const extIds = camps.map((c) => c.externalCampaignId).filter((x): x is string => !!x)
  const rows = await prisma.amazonAdsHourlyPerformance.findMany({
    where: { date: { gte: since }, OR: [{ localEntityId: { in: campaignIds } }, ...(extIds.length ? [{ entityId: { in: extIds } }] : [])] },
    select: { date: true, costMicros: true, sales7dCents: true },
  })
  const byDate = new Map<string, { cost: number; sales: number }>()
  for (const r of rows) {
    const k = r.date.toISOString().slice(0, 10)
    const a = byDate.get(k) ?? { cost: 0, sales: 0 }
    a.cost += Number(r.costMicros ?? 0n); a.sales += Number(r.sales7dCents ?? 0)
    byDate.set(k, a)
  }
  const daily = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([date, v]) => {
    const spend = v.cost / 1e6, sales = v.sales / 100
    return { date, spendEur: Math.round(spend * 100) / 100, salesEur: Math.round(sales * 100) / 100, acos: sales > 0 ? Math.round((spend / sales) * 1000) / 10 : null }
  })

  return {
    days, signalsEvaluated: signals.length,
    targetAcosByCampaign: result.targetAcosByCampaign,
    actions: result.actions, skipped: result.skipped,
    summary: { byType, currentDailyBudgetCents, projectedDailyBudgetCents, maxDailySpendCents: g.maxDailySpendCents },
    daily, hasData: daily.length > 0,
  }
}
