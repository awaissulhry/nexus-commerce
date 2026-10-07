/**
 * ADS AUTONOMY W4-7 — ad-budgets: what the budget screens show, in one read, per market — the Budget Manager's monthly
 * plans (budget, Auto Pacing, Stop Over Spend, the month's spend, pace and forecast, next month), the budget schedules
 * (their windows and campaigns, on or off, what each holds now), the budget pools (their level, strategy and campaigns)
 * and the budget baselines a restore puts back. list-automations and automation-detail name these engines and their
 * rows; this is the read Claude's budget tools (set-monthly-ad-budget, set-budget-schedule, set-budget-pool,
 * restore-budget-baselines) take their ids and starting values from. Read only; every figure is money (it needs the
 * ad-spend permission). Money in minor units of its own currency (a campaign's, a pool's, the market's), labelled.
 */
import { z } from 'zod'
import { FEATURES as F, FIELDS } from '@nexus/shared/permissions'
import prisma from '../../../db.js'
import { analyzeBudgetManager, currentMonth } from '../../advertising/ads-budget-manager.service.js'
import { listBudgetSchedules, scheduleGiveBacks } from '../../advertising/ads-budget-schedule.service.js'
import { listBudgetPools } from '../../advertising/ads-budget-pool.service.js'
import { windowText, type BudgetWindow } from '../../advertising/ads-engine-tune.service.js'
import { campaignCurrency } from './ads-tool-guards.js'
import { MARKET } from './ads-budget-kit.js'
import type { AgentTool } from '../tool-types.js'

const SHOWN = 50
const SHOW = ['all', 'plans', 'schedules', 'pools', 'baselines'] as const

const input = z.object({
  market: MARKET.optional().describe('one Amazon market (IT, DE …); every market when left out'),
  month: z.string().trim().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'a month is YYYY-MM').optional().describe('the plans of this month, YYYY-MM (this month when left out)'),
  show: z.enum(SHOW).default('all').describe('all, or only plans, schedules, pools or baselines'),
})

const adBudgets: AgentTool = {
  name: 'ad-budgets',
  title: 'Ad budgets',
  category: 'insights',
  riskTier: 'low',
  readOnly: true,
  requires: [F.adsView, FIELDS.financialsAdspendView],
  description:
    'Read the business\'s Amazon ads budgets, as the budget screens show them, per market: the monthly budget plans '
    + '(budget, Auto Pacing, Stop Over Spend, the month\'s spend, pace and month-end forecast, next month\'s budget, how '
    + 'many campaigns carry their own lowest and highest daily budget), the budget schedules (id, type, on or off, '
    + 'windows, campaigns with their budget now, how many budgets each holds now), the budget pools (id, level — off, dry '
    + 'run or live — strategy, daily budget, campaigns with their share and budget now) and the campaigns with a captured '
    + 'budget baseline (the budget now and the baseline a restore puts back). Money is in minor units of its own '
    + 'currency, labelled. The change tools: set-monthly-ad-budget, set-budget-schedule, set-budget-pool, '
    + 'restore-budget-baselines, set-campaign-budget.',
  input,
  async handler(args) {
    const market = (args.market as string | undefined) ?? null
    const month = (args.month as string | undefined) ?? currentMonth()
    const show = (args.show as (typeof SHOW)[number] | undefined) ?? 'all'
    const want = (part: (typeof SHOW)[number]) => show === 'all' || show === part
    const out: Record<string, unknown> = { month, ...(market ? { market } : {}) }

    if (want('plans')) {
      const bm = await analyzeBudgetManager({ month })
      const { budgetEnforceMode } = await import('../../advertising/ads-budget-enforce.service.js')
      const engine = await budgetEnforceMode()
      const { marketCurrencyRows, marketCurrency } = await import('../../pim/market-currency.js')
      const rows = await marketCurrencyRows('AMAZON')
      const currencyOf = (m: string) => { try { return marketCurrency('AMAZON', m, rows) } catch { return null } }
      out.plans = {
        dayBoundary: bm.dayBoundary,
        dataThrough: bm.dataThrough,
        elapsedDays: bm.elapsedDays,
        engine: { label: engine.label, sentence: engine.sentence },
        markets: bm.rows.filter((r) => !r.tag && (!market || r.marketplace === market)).map((r) => ({
          market: r.marketplace,
          currency: currencyOf(r.marketplace),
          planId: r.id,
          monthlyBudgetCents: r.monthlyBudgetCents,
          autoPacing: r.autoPacing,
          stopOverSpend: r.stopOverSpend,
          calendar: r.calendar.length ? 'its own calendar' : 'an even split',
          spendCents: r.spendCents,
          spentPct: r.pct == null ? null : Math.round(r.pct * 1000) / 10,
          expectedPct: Math.round(r.expectedPct * 1000) / 10,
          status: r.status,
          forecastSpendCents: r.forecastSpendCents,
          projectedOverspend: r.projectedOverspend,
          nextMonthBudgetCents: r.nextMonthBudgetCents,
          campaignsWithOwnLimits: r.campaignLimitCount,
        })),
      }
    }

    // The campaigns the schedules and pools name, once, with their budget now.
    const schedules = want('schedules') ? await listBudgetSchedules() : []
    const pools = want('pools') ? (await listBudgetPools()).items : []
    const ids = new Set<string>()
    for (const s of schedules) for (const c of Array.isArray(s.campaigns) ? (s.campaigns as Array<{ id?: string }>) : []) if (c?.id) ids.add(c.id)
    for (const p of pools) for (const a of p.allocations) if (a.campaignId) ids.add(a.campaignId)
    const campaigns = ids.size
      ? await prisma.campaign.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true, marketplace: true, status: true, dailyBudget: true, dailyBudgetCurrency: true } })
      : []
    const byId = new Map(campaigns.map((c) => [c.id, { campaignId: c.id, name: c.name, market: c.marketplace, status: String(c.status), currency: campaignCurrency(c), dailyBudgetCents: Math.round(Number(c.dailyBudget) * 100) }]))
    const inMarket = (list: string[]) => !market || list.some((id) => byId.get(id)?.market === market)

    if (want('schedules')) {
      const shown = []
      for (const s of schedules) {
        const list = (Array.isArray(s.campaigns) ? (s.campaigns as Array<{ id?: string }>) : []).map((c) => String(c?.id ?? '')).filter(Boolean)
        if (!inMarket(list)) continue
        const holds = s.enabled ? (await scheduleGiveBacks(s)).filter((g) => g.act === 'giveBack').length : 0
        shown.push({
          scheduleId: s.id, name: s.name, type: s.type, enabled: s.enabled, timezone: s.timezone,
          startDate: s.startDate ? s.startDate.toISOString().slice(0, 10) : null, endDate: s.neverExpire || !s.endDate ? null : s.endDate.toISOString().slice(0, 10),
          markets: [...new Set(list.map((id) => byId.get(id)?.market).filter((m): m is string => !!m))].sort(),
          windows: (Array.isArray(s.windows) ? (s.windows as unknown as BudgetWindow[]) : []).map((w) => windowText(w, s.type)),
          campaigns: list.slice(0, SHOWN).map((id) => byId.get(id) ?? { campaignId: id, name: null, gone: true }),
          ...(list.length > SHOWN ? { moreCampaigns: list.length - SHOWN } : {}),
          holdsNow: holds,
          lastEvaluatedAt: s.lastEvaluatedAt?.toISOString() ?? null,
        })
      }
      out.schedules = shown
    }

    if (want('pools')) {
      out.pools = pools.filter((p) => inMarket(p.allocations.map((a) => a.campaignId).filter((id): id is string => !!id))).map((p) => ({
        poolId: p.id, name: p.name, description: p.description,
        level: !p.enabled ? 'off' : p.dryRun ? 'dry run (records its rebalances, writes nothing)' : 'live',
        strategy: p.strategy, currency: p.currency, totalDailyBudgetCents: p.totalDailyBudgetCents,
        coolDownMinutes: p.coolDownMinutes, maxShiftPerRebalancePct: p.maxShiftPerRebalancePct,
        lastRebalancedAt: p.lastRebalancedAt?.toISOString() ?? null, rebalances: p._count.rebalances,
        campaigns: p.allocations.slice(0, SHOWN).map((a) => ({
          ...(a.campaignId ? byId.get(a.campaignId) ?? { campaignId: a.campaignId, name: null } : { campaignId: null }),
          targetSharePct: Number(a.targetSharePct), minDailyBudgetCents: a.minDailyBudgetCents, maxDailyBudgetCents: a.maxDailyBudgetCents,
        })),
        ...(p.allocations.length > SHOWN ? { moreCampaigns: p.allocations.length - SHOWN } : {}),
      }))
    }

    if (want('baselines')) {
      const rows = await prisma.campaign.findMany({
        where: { budgetBaselineCents: { not: null }, status: { not: 'ARCHIVED' }, ...(market ? { marketplace: market } : {}) },
        select: { id: true, name: true, marketplace: true, dailyBudget: true, dailyBudgetCurrency: true, budgetBaselineCents: true },
        orderBy: [{ marketplace: 'asc' }, { name: 'asc' }],
        take: 500,
      })
      const lines = rows.map((c) => ({ campaignId: c.id, name: c.name, market: c.marketplace, currency: campaignCurrency(c), dailyBudgetCents: Math.round(Number(c.dailyBudget) * 100), budgetBaselineCents: c.budgetBaselineCents! }))
      const off = lines.filter((l) => l.dailyBudgetCents !== l.budgetBaselineCents)
      out.baselines = {
        captured: lines.length,
        offBaseline: off.length,
        campaigns: off.slice(0, SHOWN),
        ...(off.length > SHOWN ? { more: `${off.length - SHOWN} more campaigns are off their baseline: name a market to narrow.` } : {}),
        note: 'Only campaigns whose budget is not at its baseline are listed: restore-budget-baselines puts them back.',
      }
    }
    return { ok: true, data: out }
  },
}

export const ADS_BUDGET_READ_TOOLS: AgentTool[] = [adBudgets]
