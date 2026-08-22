/**
 * BUD-PP — the honest budget preview. Each case pins one of the five ways the old client-side
 * preview lied, so a regression names which lie came back.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  buildCampaignBudgetContexts: vi.fn(),
  budgetApply: vi.fn(),
  placementApply: vi.fn(),
  adSchedule: vi.fn(),
  bidHistory: vi.fn(),
}))

// PLC-P2 — the placement preview reads AdSchedule + CampaignBidHistory to say who ELSE writes the
// lane. Stubbed so the suite stays offline; the tests below assert what the service does with the
// answers, which is the part that can be wrong.
vi.mock('../../db.js', () => ({
  default: {
    adSchedule: { findMany: h.adSchedule },
    campaignBidHistory: { findMany: h.bidHistory },
  },
}))

vi.mock('../../jobs/advertising-rule-evaluator.job.js', () => ({
  buildCampaignBudgetContexts: h.buildCampaignBudgetContexts,
}))
// Only ACTION_HANDLERS is stubbed. `getFieldPath` MUST stay real — `conditions-tree` evaluates
// through it, so stubbing it would make every condition trivially pass and the criteria tests
// would prove nothing.
vi.mock('../automation-rule.service.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  ACTION_HANDLERS: { budget_apply: h.budgetApply, placement_apply: h.placementApply } as Record<string, unknown>,
}))
vi.mock('./automation-action-handlers.js', () => ({}))

import { previewBudgetRule, previewPlacementRule } from './ads-rule-preview.service.js'

const ctx = (id: string, name: string, mkt: string, budgetEur: number, utilPct: number, spendEur = 20) => ({
  trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  marketplace: mkt,
  campaign: {
    id, name, externalCampaignId: `ext-${id}`,
    dailyBudgetCents: Math.round(budgetEur * 100),
    spendCents: Math.round(spendEur * 100),
    salesCents: 10000, acos: 0.2, roas: 5,
    impressions: 1000, clicks: 50, orders: 5, ctr: 0.05, cvr: 0.1, cpcCents: 20,
    avgDailySpendCents: Math.round(spendEur * 100 / 7),
    budgetUtilization: utilPct / 100,
  },
})

/** A builder draft: util <= 10% AND spend >= EUR5 -> decrease 25%. */
const draft = (campaignIds: string[], over: Record<string, unknown> = {}) => ({
  actions: [{ type: 'budget', campaigns: campaignIds.map((id) => ({ id })), budgetFloor: 1, windowDays: 7, ...over }],
  conditions: [{
    match: 'all',
    action: { op: 'decPct', value: '25' },
    conditions: [
      { metric: 'Budget Utilization', op: 'lte', value: '10' },
      { metric: 'Spend', op: 'gte', value: '5' },
    ],
  }],
})

beforeEach(() => {
  vi.clearAllMocks()
  // The handler's real dryRun contract: a `wouldChange` sentence and no write.
  h.budgetApply.mockImplementation(async (a: Record<string, unknown>) => ({
    ok: true, output: { dryRun: true, campaignId: a.campaignId, wouldChange: '€20.00 → €15.00' },
  }))
  // placement_apply's real dryRun contract: a percent sentence, the lane it acted on, no write.
  h.placementApply.mockImplementation(async (a: Record<string, unknown>) => ({
    ok: true, output: { dryRun: true, campaignId: a.campaignId, placement: a.placement, wouldChange: '30% → 50%' },
  }))
  h.adSchedule.mockResolvedValue([])
  h.bidHistory.mockResolvedValue([])
})

describe('the five lies the old preview told', () => {
  it('1 — CRITERIA are applied: a non-matching campaign is not listed', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([
      ctx('c1', 'Idle DE', 'DE', 20, 9),    // util 9% -> matches
      ctx('c2', 'Busy DE', 'DE', 20, 95),   // util 95% -> does NOT match
    ])
    const r = await previewBudgetRule(draft(['c1', 'c2']))
    expect(r.ok).toBe(true)
    expect(r.selected).toBe(2)
    expect(r.matched).toBe(1)
    expect(r.rows.map((x) => x.campaign)).toEqual(['Idle DE'])
  })

  it("2b — 'all' means UNSCOPED, not a marketplace literally named 'all'", async () => {
    // 🔴 Regression pin. The builder's market control stores 'all' for "every market". Sent
    // through as-is, `ruleMatchesScope` compared 'all' !== 'DE' and dropped every context, so the
    // preview said "0 of 70 match" — confidently, and wrongly. Caught only by driving the real UI.
    h.buildCampaignBudgetContexts.mockResolvedValue([
      ctx('c1', 'Idle DE', 'DE', 20, 9),
      ctx('c2', 'Idle ES', 'ES', 20, 9),
    ])
    const r = await previewBudgetRule({ ...draft(['c1', 'c2']), scopeMarketplace: 'all' })
    expect(r.inScope).toBe(2)
    expect(r.matched).toBe(2)
  })

  it('2 — MARKETPLACE SCOPE is applied: a DE rule never lists ES', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([
      ctx('c1', 'Idle DE', 'DE', 20, 9),
      ctx('c2', 'Idle ES', 'ES', 20, 9),    // matches the criteria, wrong market
    ])
    const r = await previewBudgetRule({ ...draft(['c1', 'c2']), scopeMarketplace: 'DE' })
    expect(r.inScope).toBe(1)
    expect(r.rows.map((x) => x.campaign)).toEqual(['Idle DE'])
  })

  it('3 — MULTI-BLOCK: the first block whose conditions match acts, not block 1', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'Busy DE', 'DE', 20, 95)])
    const twoBlock = {
      actions: draft(['c1']).actions,
      conditions: [
        // block 1 does NOT match (util <= 10)
        { match: 'all', action: { op: 'decPct', value: '25' }, conditions: [{ metric: 'Budget Utilization', op: 'lte', value: '10' }] },
        // block 2 DOES (util >= 90) and carries a different action
        { match: 'all', action: { op: 'incPct', value: '20' }, conditions: [{ metric: 'Budget Utilization', op: 'gte', value: '90' }] },
      ],
    }
    const r = await previewBudgetRule(twoBlock)
    expect(r.matched).toBe(1)
    // The handler must have been called with BLOCK 2's action.
    const action = h.budgetApply.mock.calls[0][0] as Record<string, unknown>
    expect(action.op).toBe('incPct')
    expect(action.value).toBe(20)
  })

  it('4 — the VALUE comes from the handler, never recomputed here', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'Idle DE', 'DE', 20, 9)])
    // The handler anchors to budgetBaselineCents (BUD.2). Its answer is €50 → €30, which no
    // arithmetic on the context's €20 daily budget could produce — proving we report ITS number.
    h.budgetApply.mockResolvedValue({ ok: true, output: { wouldChange: '€50.00 → €30.00' } })
    const r = await previewBudgetRule(draft(['c1']))
    expect(r.rows[0].currentEur).toBe(50)
    expect(r.rows[0].proposedEur).toBe(30)
    expect(r.rows[0].deltaEur).toBe(-20)
    // and it ran in dryRun, so nothing was written
    expect((h.budgetApply.mock.calls[0][2] as Record<string, unknown>).dryRun).toBe(true)
  })

  it('5 — the CONTEXT FLOOR is respected: a campaign with no context is never previewed', async () => {
    // c2 is picked but produced no context (no spend in the settled window).
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'Idle DE', 'DE', 20, 9)])
    const r = await previewBudgetRule(draft(['c1', 'c2']))
    expect(r.selected).toBe(2)
    expect(r.measurable).toBe(1)
    expect(r.rows).toHaveLength(1)
  })
})

describe('honesty at the edges', () => {
  it('a guardrail no-op is reported as no change, not as a decrease', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'At floor', 'DE', 1, 9)])
    h.budgetApply.mockResolvedValue({ ok: true, output: { wouldChange: '€1.00 → €1.00' } })
    const r = await previewBudgetRule(draft(['c1']))
    expect(r.rows[0].deltaEur).toBe(0)
    expect(r.rows[0].clamped).toBe(true)
    expect(r.noChange).toBe(1)
  })

  it('refuses a draft whose metric has no engine signal, rather than previewing the rest', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'Idle DE', 'DE', 20, 9)])
    const bad = {
      actions: draft(['c1']).actions,
      conditions: [{ match: 'all', action: { op: 'decPct', value: '25' }, conditions: [{ metric: 'Moon Phase', op: 'lte', value: '10' }] }],
    }
    const r = await previewBudgetRule(bad)
    expect(r.ok).toBe(false)
    expect(r.error).toBe('untranslatable_conditions')
    expect(r.untranslatable).toContain('Moon Phase')
    expect(h.budgetApply).not.toHaveBeenCalled()
  })

  it('an empty picker previews nothing and touches no data', async () => {
    const r = await previewBudgetRule(draft([]))
    expect(r.ok).toBe(true)
    expect(r.rows).toHaveLength(0)
    expect(h.buildCampaignBudgetContexts).not.toHaveBeenCalled()
  })

  it('the rule’s own lookback is what the contexts are built over', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([])
    await previewBudgetRule(draft(['c1'], { windowDays: 30 }))
    expect(h.buildCampaignBudgetContexts).toHaveBeenCalledWith(30)
    vi.clearAllMocks()
    h.buildCampaignBudgetContexts.mockResolvedValue([])
    await previewBudgetRule(draft(['c1'], { windowDays: 999 })) // clamped like the adapter clamps
    expect(h.buildCampaignBudgetContexts).toHaveBeenCalledWith(90)
  })

  it('rejects a non-budget draft instead of guessing', async () => {
    const r = await previewBudgetRule({ actions: [{ type: 'bid', campaigns: [{ id: 'c1' }] }] })
    expect(r.ok).toBe(false)
    expect(r.error).toBe('not_a_budget_draft')
  })
})

/**
 * PLC-P2 — the Placement preview. The first five cases are the SAME five lies, re-pinned against
 * the placement path: both types run one `runDraftPreview`, so a regression in the shared pipeline
 * must fail on both sides rather than only on the side that has tests.
 */
const pDraft = (campaignIds: string[], over: Record<string, unknown> = {}, groups?: unknown[]) => ({
  actions: [{ type: 'placement', campaigns: campaignIds.map((id) => ({ id })), placeFloor: 0, placeCeiling: 900, ...over }],
  conditions: groups ?? [{
    match: 'all',
    action: { op: 'set', value: '50', placeTarget: 'tos' },
    conditions: [{ metric: 'ACOS', op: 'gt', value: '10' }],
  }],
})

describe('PLC-P2 — the placement preview runs the engine', () => {
  it('1 — CRITERIA are applied: an unsatisfiable draft lists nothing (the 9999% case, measured on prod)', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'DE_Auto_Close', 'DE', 20, 50), ctx('c2', 'GALE BROAD IT', 'IT', 20, 50)])
    const out = await previewPlacementRule(pDraft(['c1', 'c2'], {}, [{
      match: 'all', action: { op: 'set', value: '50', placeTarget: 'tos' },
      conditions: [{ metric: 'ACOS', op: 'gt', value: '9999' }],
    }]))
    expect(out.ok).toBe(true)
    expect(out.selected).toBe(2)
    expect(out.matched).toBe(0)
    expect(out.rows).toHaveLength(0)
    expect(h.placementApply).not.toHaveBeenCalled()
  })

  it('2 — MARKETPLACE SCOPE is applied: a DE-scoped draft never lists an IT campaign', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'DE_Auto_Close', 'DE', 20, 50), ctx('c2', 'GALE BROAD IT', 'IT', 20, 50)])
    const out = await previewPlacementRule({ ...pDraft(['c1', 'c2']), scopeMarketplace: 'DE' })
    expect(out.inScope).toBe(1)
    expect(out.rows.map((r) => r.campaign)).toEqual(['DE_Auto_Close'])
  })

  it("2b — 'all' means UNSCOPED, not a marketplace named 'all'", async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50), ctx('c2', 'b', 'IT', 20, 50)])
    const out = await previewPlacementRule({ ...pDraft(['c1', 'c2']), scopeMarketplace: 'all' })
    expect(out.inScope).toBe(2)
    expect(out.rows).toHaveLength(2)
  })

  it('3 — MULTI-BLOCK: each campaign gets the LANE of whichever block matched it', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'high', 'DE', 20, 95), ctx('c2', 'low', 'DE', 20, 5)])
    const out = await previewPlacementRule(pDraft(['c1', 'c2'], {}, [
      { match: 'all', action: { op: 'set', value: '50', placeTarget: 'tos' }, conditions: [{ metric: 'Budget Utilization', op: 'gte', value: '90' }] },
      { match: 'all', action: { op: 'set', value: '0', placeTarget: 'ros' }, conditions: [{ metric: 'Budget Utilization', op: 'lte', value: '10' }] },
    ]))
    expect(out.matched).toBe(2)
    const byName = Object.fromEntries(out.rows.map((r) => [r.campaign, r.placement]))
    expect(byName.high).toBe('PLACEMENT_TOP')
    expect(byName.low).toBe('PLACEMENT_REST_OF_SEARCH')
  })

  it('4 — the VALUE comes from the handler, never recomputed here', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    h.placementApply.mockResolvedValue({ ok: true, output: { placement: 'PLACEMENT_TOP', wouldChange: '12% → 7%' } })
    const out = await previewPlacementRule(pDraft(['c1']))
    // The draft says "set 50". The handler said 7. The handler wins — that is the whole point.
    expect(out.rows[0].currentPct).toBe(12)
    expect(out.rows[0].proposedPct).toBe(7)
    expect(out.rows[0].deltaPct).toBe(-5)
  })

  it('5 — the CONTEXT FLOOR is respected: a picked campaign with no context is never previewed', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    const out = await previewPlacementRule(pDraft(['c1', 'c-no-spend']))
    expect(out.selected).toBe(2)
    expect(out.measurable).toBe(1)
    expect(out.rows).toHaveLength(1)
  })
})

describe('PLC-P2 — the honesty placement needs and budget does not', () => {
  it('names the lane in words, never the Amazon enum', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    h.placementApply.mockResolvedValue({ ok: true, output: { placement: 'PLACEMENT_REST_OF_SEARCH', wouldChange: '0% → 45%' } })
    const out = await previewPlacementRule(pDraft(['c1']))
    expect(out.rows[0].placementLabel).toBe('Rest of Search')
    expect(out.rows[0].placementLabel).not.toMatch(/PLACEMENT_/)
  })

  it('🔴 flags a campaign the rank engine governs, and says when it last wrote that lane', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'governed', 'DE', 20, 50), ctx('c2', 'free', 'DE', 20, 50)])
    h.adSchedule.mockResolvedValue([{ campaignId: 'c1' }])
    const when = new Date('2026-08-21T21:15:43.183Z')
    h.bidHistory.mockResolvedValue([{ campaignId: 'c1', field: 'PLACEMENT_TOP', changedAt: when }])
    const out = await previewPlacementRule(pDraft(['c1', 'c2']))
    const byName = Object.fromEntries(out.rows.map((r) => [r.campaign, r]))
    expect(byName.governed.governed).toBe(true)
    expect(byName.governed.lastEngineWriteAt).toBe(when.toISOString())
    expect(byName.free.governed).toBe(false)
    expect(byName.free.lastEngineWriteAt).toBeNull()
    expect(out.governedMatched).toBe(1)
  })

  it('🔴 always states the hour it read the current multipliers', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    const out = await previewPlacementRule(pDraft(['c1']))
    expect(out.readAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    expect(Number.isFinite(Date.parse(out.readAt))).toBe(true)
  })

  it('takes the LATEST engine write per lane, not whichever row came back first', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    h.adSchedule.mockResolvedValue([{ campaignId: 'c1' }])
    // The service orders newest-first and keeps the first sighting; an out-of-order reply must not
    // make it report an older write as the latest.
    h.bidHistory.mockResolvedValue([
      { campaignId: 'c1', field: 'PLACEMENT_TOP', changedAt: new Date('2026-08-21T21:00:00.000Z') },
      { campaignId: 'c1', field: 'PLACEMENT_TOP', changedAt: new Date('2026-08-20T09:00:00.000Z') },
    ])
    const out = await previewPlacementRule(pDraft(['c1']))
    expect(out.rows[0].lastEngineWriteAt).toBe('2026-08-21T21:00:00.000Z')
  })

  it('a guardrail no-op is reported as no change, not as a raise', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    h.placementApply.mockResolvedValue({ ok: true, output: { placement: 'PLACEMENT_TOP', wouldChange: '50% → 50%' } })
    const out = await previewPlacementRule(pDraft(['c1']))
    expect(out.rows[0].deltaPct).toBe(0)
    expect(out.rows[0].clamped).toBe(true)
    expect(out.noChange).toBe(1)
  })

  it('refuses a draft whose metric has no engine signal rather than previewing the rest', async () => {
    h.buildCampaignBudgetContexts.mockResolvedValue([ctx('c1', 'a', 'DE', 20, 50)])
    const out = await previewPlacementRule(pDraft(['c1'], {}, [{
      match: 'all', action: { op: 'set', value: '50', placeTarget: 'tos' },
      conditions: [{ metric: 'Share of Voice', op: 'lt', value: '20' }],
    }]))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('untranslatable_conditions')
    expect(out.untranslatable).toContain('Share of Voice')
    expect(out.rows).toHaveLength(0)
  })

  it('rejects a BUDGET draft instead of previewing it as placement', async () => {
    const out = await previewPlacementRule(draft(['c1']))
    expect(out.ok).toBe(false)
    expect(out.error).toBe('not_a_placement_draft')
    expect(h.buildCampaignBudgetContexts).not.toHaveBeenCalled()
  })

  it('an empty picker previews nothing and touches no data', async () => {
    const out = await previewPlacementRule(pDraft([]))
    expect(out.ok).toBe(true)
    expect(out.rows).toHaveLength(0)
    expect(h.buildCampaignBudgetContexts).not.toHaveBeenCalled()
    expect(h.adSchedule).not.toHaveBeenCalled()
  })
})
