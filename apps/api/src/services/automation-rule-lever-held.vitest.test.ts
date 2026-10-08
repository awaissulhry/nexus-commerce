/**
 * ONE BRAIN AB-6 — an ads rule's action on a lever a product's brain owns is left before the rule asks (evaluateRule).
 *   owned      the action is a named skip in the execution row, its handler never runs, and the rule's refusal record
 *              counts BRAIN_OWNED:<lever> (automation-activity) — each holder named as what it is; a dry run records it
 *              once a day; the run is not a failure
 *   not owned  the handler runs exactly as before and nothing is recorded
 *   handlers   an action that writes several campaigns reports its own per-lever counts, recorded the same way
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const execCreate = vi.fn(async () => ({ id: 'exec-new' }))
const execCount = vi.fn(async () => 0)
const ruleUpdate = vi.fn(async () => ({}))
const actionLogCount = vi.fn(async () => 0)
const refusalFind = vi.fn(async (): Promise<{ count: number } | null> => null)
const refusalUpsert = vi.fn(async (_args: unknown) => ({}))
const ruleFindUnique = vi.fn()
vi.mock('../db.js', () => ({
  default: {
    automationRuleExecution: { get count() { return execCount }, get create() { return execCreate } },
    automationRule: { get update() { return ruleUpdate }, get findUnique() { return ruleFindUnique } },
    advertisingActionLog: { get count() { return actionLogCount } },
    automationRefusalDaily: { get findUnique() { return refusalFind }, get upsert() { return refusalUpsert } },
  },
}))
vi.mock('./advertising/bid-brain/rule-directives.js', () => ({
  ruleBrainInput: vi.fn(async () => null),
  directiveCampaignId: async (action: Record<string, unknown>, context: { campaign?: { id?: string } } | null) => (action.campaignId as string | undefined) ?? context?.campaign?.id ?? null,
}))
const campaignLeverOwners = vi.fn()
vi.mock('./advertising/brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => campaignLeverOwners(...a),
  anyBrainEnrolled: vi.fn(async () => true),
}))
vi.mock('./advertising/ads-suggestions.service.js', () => ({ generateSuggestionsFromExecution: vi.fn(async () => 0) }))
vi.mock('./advertising/ads-rule-adapter.service.js', () => ({ maybeTranslateAdsRule: () => null, BUILDER_SLUG_ACTIONS: {} }))
vi.mock('./ads-execution-events.service.js', () => ({ publishAdsExecution: vi.fn() }))

const { evaluateRule, ACTION_HANDLERS } = await import('./automation-rule.service.js')

const RULE = {
  id: 'rule-b', name: 'Raise budgets of winners', domain: 'advertising', trigger: 'CAMPAIGN_PERFORMANCE_BUDGET',
  conditions: [], actions: [{ type: 'adjust_ad_budget', percent: 20 }],
  enabled: true, dryRun: false, autonomyLevel: 'AUTO', maxExecutionsPerDay: null, maxWritesPerDay: null,
  maxValueCentsEur: null, maxDailyAdSpendCentsEur: null, scopeMarketplace: null,
}
const CTX = { trigger: 'CAMPAIGN_PERFORMANCE_BUDGET', marketplace: 'IT', campaign: { id: 'c-gale', name: 'GALE exact' } }
const owned = (levers: Record<string, unknown>) => new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE exact', market: 'IT', levers }]])
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const handler = vi.fn(async (action: { type: string }) => ({ type: action.type, ok: true, output: { campaignId: 'c-gale', newDailyBudget: 24 } }))

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  for (const f of [execCreate, execCount, ruleUpdate, actionLogCount, refusalFind, refusalUpsert, handler]) f.mockClear()
  refusalFind.mockResolvedValue(null)
  campaignLeverOwners.mockReset().mockResolvedValue(new Map())
  ACTION_HANDLERS.adjust_ad_budget = handler as never
})
afterEach(() => vi.unstubAllEnvs())

const run = (rule: Record<string, unknown> = {}) => {
  ruleFindUnique.mockResolvedValueOnce({ ...RULE, ...rule })
  return evaluateRule({ ruleId: RULE.id, context: CTX })
}

describe('AB-6 — a rule leaves a lever a product\'s brain owns', () => {
  it('owned: a named skip, the handler never runs, BRAIN_OWNED:budgets counted, the run is no failure', async () => {
    campaignLeverOwners.mockResolvedValue(owned({ budgets: OWNED }))
    const r = await run()
    expect(handler).not.toHaveBeenCalled()
    expect(r.status).toBe('SUCCESS')
    expect(r.actionResults).toEqual([expect.objectContaining({
      type: 'adjust_ad_budget', ok: true,
      output: expect.objectContaining({ skipped: 'brain-lever', brainSkip: expect.objectContaining({ lever: 'budgets', holder: 'productBrain', campaignId: 'c-gale' }) }),
    })])
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
    const call = refusalUpsert.mock.calls[0][0] as { create: { reason: string; count: number; lastReason: string; actorId: string } }
    expect(call.create).toMatchObject({ actorId: 'rule-b', reason: 'BRAIN_OWNED:budgets', count: 1 })
    expect(call.create.lastReason).toBe('Raise budgets of winners left 1 write on its budgets lever alone — a product\'s brain runs the daily budget of campaign "GALE exact" (c-gale) — product gale in IT (one owner per lever).')
  })

  it('not owned (nothing enrolled — production today): the handler runs exactly as before, nothing recorded', async () => {
    const r = await run()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(r.actionResults).toEqual([{ type: 'adjust_ad_budget', ok: true, output: { campaignId: 'c-gale', newDailyBudget: 24 } }])
    expect(refusalUpsert).not.toHaveBeenCalled()
  })

  it('another lever of the campaign owned: the budget action runs', async () => {
    campaignLeverOwners.mockResolvedValue(owned({ negatives: OWNED }))
    await run()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('the ceiling not live: nothing read, the handler runs', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    campaignLeverOwners.mockResolvedValue(owned({ budgets: OWNED }))
    await run()
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('a failed read: the handler runs (the write gate decides), nothing recorded as left', async () => {
    campaignLeverOwners.mockRejectedValue(new Error('db blip'))
    await run()
    expect(handler).toHaveBeenCalledTimes(1)
    expect(refusalUpsert).not.toHaveBeenCalled()
  })

  it('a dry run (PROPOSE): skipped too, so it proposes nothing; counted once a day', async () => {
    campaignLeverOwners.mockResolvedValue(owned({ budgets: OWNED }))
    const r = await run({ dryRun: true, autonomyLevel: 'PROPOSE' })
    expect(r.status).toBe('DRY_RUN')
    expect(handler).not.toHaveBeenCalled()
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
    refusalFind.mockResolvedValue({ count: 1 })
    await run({ dryRun: true, autonomyLevel: 'PROPOSE' })
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
  })

  it('a handler that writes several campaigns: its own per-lever counts are recorded, all of them for a writing rule', async () => {
    // e.g. a pool's rebalance or pace_budget: the campaign the context names is not held, three others are.
    handler.mockResolvedValueOnce({
      type: 'adjust_ad_budget', ok: true,
      output: { raised: 2, brainSkips: { counts: { productBrain: { budgets: 3 } }, sample: [{ lever: 'budgets', holder: 'productBrain', campaignId: 'c-x', why: 'a product\'s brain runs the daily budget of campaign c-x' }] } },
    } as never)
    const r = await run()
    expect(r.status).toBe('SUCCESS')
    expect(refusalUpsert).toHaveBeenCalledTimes(1)
    expect((refusalUpsert.mock.calls[0][0] as { create: { reason: string; count: number; lastReason: string } }).create).toMatchObject({
      reason: 'BRAIN_OWNED:budgets', count: 3, lastReason: expect.stringContaining('campaign c-x'),
    })
  })

  it('a bid brain campaign\'s keyword bids are recorded as the bid brain\'s (BID_BRAIN:bids), in its own words', async () => {
    handler.mockResolvedValueOnce({
      type: 'adjust_ad_budget', ok: true,
      output: { changed: 0, brainSkips: { counts: { bidBrain: { bids: 1 } }, sample: [{ lever: 'bids', holder: 'bidBrain', campaignId: 'c-bb', why: 'the bid brain runs the keyword bids of campaign "bid brain" (c-bb)' }] } },
    } as never)
    await run()
    const create = (refusalUpsert.mock.calls[0][0] as { create: { reason: string; count: number; lastReason: string } }).create
    expect(create).toMatchObject({ reason: 'BID_BRAIN:bids', count: 1 })
    expect(create.lastReason).toBe('Raise budgets of winners left 1 write on its bids lever alone — the bid brain runs the keyword bids of campaign "bid brain" (c-bb) (one owner per lever).')
    expect(create.lastReason).not.toMatch(/product's brain|Owner/)
  })

  it('the same handler counts in a dry run: once a day', async () => {
    ACTION_HANDLERS.sync_negatives_across_campaigns = vi.fn(async (action: { type: string }) => ({
      type: action.type, ok: true, output: { dryRun: true, wouldNegateIn: 4, brainSkips: { counts: { ownerLock: { negatives: 3 } } } },
    })) as never
    const r = await run({ actions: [{ type: 'sync_negatives_across_campaigns', keyword: 'cheap' }], dryRun: true, autonomyLevel: 'PROPOSE' })
    expect(r.status).toBe('DRY_RUN')
    expect((refusalUpsert.mock.calls[0][0] as { create: { reason: string; count: number } }).create).toMatchObject({ reason: 'OWNER_LOCKED:negatives', count: 1, lastReason: expect.stringContaining('the Owner holds that lever at his own value') })
  })
})
