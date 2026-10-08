/**
 * ONE BRAIN AB-7 — the `ads-brain` money view's shape (budget-read.ts moneyView): every amount, percent of spend and
 * sentence naming one sits under a `money` key, so a person without the ad-spend permission gets the same answer minus
 * exactly that (the ads-brain tool's restrictedFields, the filter every tool answer goes through); the rest names no amount.
 * The tool routes the view. GALE IT on 2026-10-08 (budget-plan.vitest.test.ts's facts, in short).
 */
import { describe, expect, it } from 'vitest'
import { FIELDS } from '@nexus/shared/permissions'
import { financialPayloadCopy } from '../../../lib/auth/field-filter.js'
import { ADS_BRAIN_TOOLS } from '../../agents/tools/ads-brain.tools.js'
import { budgetDayMoveBounds } from '../ads-write-gate.js'
import { resolveBrainSettings } from './settings.js'
import { moneyClock } from './budget-pace.js'
import { planProductMoney } from './budget-plan.js'
import { moneyView } from './budget-read.js'
import { camp, GALE_BAND } from './__fixtures__/budget-facts.js'

const s = resolveBrainSettings({ productId: 'gale', market: 'IT', enrolled: true, overrides: [] })
const plan = planProductMoney({
  productId: 'gale', name: 'GALE jacket', market: 'IT', currency: 'EUR', clock: moneyClock(new Date('2026-10-08T08:45:00Z'), 'Europe/Rome'), enrolled: true,
  settings: { levers: s.levers, values: s.values, excluded: s.excluded },
  envelope: { productId: 'gale', cents: 40_000, source: 'own', why: 'its own monthly budget (ads strategy: GALE (IT) v2)' },
  split: { budgetCents: 60_000, budgetFrom: 'the Budget Manager\'s 2026-10 plan', fixedCents: 40_000, sharedCents: 14_545, reserveCents: 5_455, totalCents: 54_545, why: 'IT monthly budget €600.00', warnings: [] },
  pace: { dayWeights: null, hourWeights: null, spentCents: 8_988, reportedThroughDay: 7, stream: { gapCents: 0, todayCents: 468 }, runRateCents: 1_284, dayWeightsFrom: 'even', hourCurveFrom: 'even', dataThrough: '2026-10-07' },
  portfolios: [{ portfolioId: 'pf-gale', name: 'Xavia GALE IT', campaignIds: ['c1', 'c2'], otherCampaigns: 0, lastMonthSpendCents: 38_510, monthSpendCents: 9_456, today: { policy: 'NO_CAP', amountCents: null, inBudget: true } }],
  campaigns: [camp('c1', { avgDailySpendCents: 310, usage: 0.82 }), camp('c2', { avgDailySpendCents: 240, owner: 'shared' })],
  band: GALE_BAND, limits: { minCents: 100, maxCents: 100_000_000 }, warnings: ['no Marketing Stream hours since yesterday'],
}, budgetDayMoveBounds)
const view = moneyView(plan)
const tool = ADS_BRAIN_TOOLS[0]
const ALL_FIELDS = Object.values(FIELDS)

describe('AB-7 — the money view', () => {
  it('names the plan without amounts outside `money`: levers, sources, the brake and what it does, actions', () => {
    expect(view).toMatchObject({
      productId: 'gale', market: 'IT', month: '2026-10', day: '2026-10-08', enrolled: true,
      envelope: { source: 'own' }, pace: { aimPct: 90, projection: 'stream and run rate' },
      brake: { level: 'hold_raises', abovePct: 95, does: 'no raises: bids, budgets and hours hold', stop: null },
      portfolioCap: { on: true, source: 'envelope', pct: 115, portfolios: [{ portfolioId: 'pf-gale', name: 'Xavia GALE IT', campaigns: 2, action: 'set' }] },
      campaigns: [{ campaignId: 'c1', owner: 'product', action: 'lower', onLadder: false }, { campaignId: 'c2', owner: 'shared', action: 'lower' }],
    })
    expect(view.why).toBe('GALE jacket (IT) 2026-10 day 8: envelope from its own monthly budget · brake hold_raises: no raises: bids, budgets and hours hold · portfolio cap envelope · 2 campaigns: 2 lower, 0 raise, 0 keep, 0 hold')
    expect(view.pace.money).toMatchObject({ projectedCents: 39_804, pacePct: 99.51 })
    expect(view.campaigns[0].money).toMatchObject({ usagePct: 82, band: 'in' })
  })

  it('a person without the ad-spend permission: the same answer minus every money key, and no amount left; with it, all of it', () => {
    const noMoney = { isOwner: false, permissions: new Set<string>(ALL_FIELDS.filter((f) => f !== FIELDS.financialsAdspendView && f !== FIELDS.financialsView)) }
    const partial = financialPayloadCopy(view, noMoney, tool.restrictedFields)
    const text = JSON.stringify(partial)
    expect(text).toBe(JSON.stringify(view, (k, v) => (k === 'money' ? undefined : v)))
    for (const amount of ['€', '40000', '46000', '39804', '1123', '99.51', '9456']) expect(text).not.toContain(amount)
    const adSpend = { isOwner: false, permissions: new Set<string>([FIELDS.financialsAdspendView]) }
    expect(JSON.stringify(financialPayloadCopy(view, adSpend, tool.restrictedFields))).toBe(JSON.stringify(view))
  })

  it('the tool offers the view and hides `money` (and the cap amounts) without the permission', () => {
    expect(tool.restrictedFields).toMatchObject({ money: FIELDS.financialsAdspendView, portfolioCapCents: FIELDS.financialsAdspendView })
    expect(tool.input.parse({ view: 'money', market: 'it' })).toMatchObject({ view: 'money', market: 'IT' })
    expect(tool.readOnly).toBe(true)
  })
})
