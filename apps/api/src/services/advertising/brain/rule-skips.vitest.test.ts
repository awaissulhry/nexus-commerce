/**
 * ONE BRAIN AB-6 — an ads rule leaves a lever a product's brain owns (or the Owner locked) before it asks (brain/rule-skips.ts).
 *   map       the lever each one-campaign action writes; a mapped negative and the bid actions BB-9 takes are not here
 *   hook      owned → a named skip with why and the lever; not owned, not live, another campaign of the picker, no
 *             campaign, a failed read → null (the rule runs as before, the write gate decides)
 *   counts    both shapes read back (one skip, a handler's per-lever counts)
 *   warm      one read for every campaign of a pass, Amazon's ids resolved in one query; inert when nothing is enrolled
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignLeverOwners } from './lever-owners.js'

const campaignLeverOwners = vi.fn()
const anyBrainEnrolled = vi.fn()
vi.mock('./lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => anyBrainEnrolled(...a),
}))
const adGroupFindFirst = vi.fn()
const campaignFindFirst = vi.fn()
const campaignFindMany = vi.fn()
vi.mock('../../../db.js', () => ({
  default: {
    adGroup: { get findFirst() { return adGroupFindFirst } },
    campaign: { get findFirst() { return campaignFindFirst }, get findMany() { return campaignFindMany } },
  },
}))
// The bid brain's resolver: the action's or the context's campaign (its own tests cover the ad group and keyword lookups).
vi.mock('../bid-brain/rule-directives.js', () => ({
  directiveCampaignId: async (action: Record<string, unknown>, context: { campaign?: { id?: string } } | null) => (action.campaignId as string | undefined) ?? context?.campaign?.id ?? null,
}))

const { ruleActionLever, ruleLeverSkip, ruleResultLeverSkips, warmRuleLeverOwners, ruleActionCampaignId } = await import('./rule-skips.js')

const held = (campaignId: string, levers: CampaignLeverOwners['levers']): Map<string, CampaignLeverOwners> =>
  new Map([[campaignId, { campaignId, name: 'GALE exact', market: 'IT', levers }]])
const OWNED = { kind: 'owned' as const, productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignLeverOwners.mockReset().mockResolvedValue(new Map())
  anyBrainEnrolled.mockReset().mockResolvedValue(true)
  adGroupFindFirst.mockReset()
  campaignFindFirst.mockReset()
  campaignFindMany.mockReset()
})
afterEach(() => vi.unstubAllEnvs())

describe('ruleActionLever (pure)', () => {
  it.each([
    ['adjust_ad_budget', 'budgets'], ['set_daily_budget', 'budgets'], ['budget_apply', 'budgets'],
    ['enable_campaign', 'state'], ['resume_campaign', 'state'], ['pause_target', 'state'], ['enable_target', 'state'], ['archive_keyword', 'state'],
    ['add_negative_exact', 'negatives'], ['add_negative_phrase', 'negatives'], ['promote_to_exact', 'harvest'],
    ['set_placement_multiplier', 'placements'], ['placement_apply', 'placements'],
  ])('%s writes the %s lever', (type, lever) => {
    expect(ruleActionLever({ type })).toBe(lever)
  })
  it('an ad group\'s bid move is the ad-group bids lever; a keyword\'s is BB-9\'s, not here', () => {
    expect(ruleActionLever({ type: 'bid_down', target: 'ad_group' })).toBe('adGroupBids')
    expect(ruleActionLever({ type: 'bid_up', target: 'ad_group' })).toBe('adGroupBids')
    expect(ruleActionLever({ type: 'bid_down' })).toBeNull()
    expect(ruleActionLever({ type: 'bid_apply' })).toBeNull()
  })
  it('a mapped negative asks per destination inside its handler; sweeps, alerts and the refused pauses are not here', () => {
    expect(ruleActionLever({ type: 'add_negative_exact', negative: { blocks: [] } })).toBeNull()
    for (const type of ['sync_negatives_across_campaigns', 'harvest_and_negate', 'notify', 'pause_campaign', 'retail_guard', 'pace_budget']) expect(ruleActionLever({ type })).toBeNull()
  })
})

describe('ruleActionCampaignId', () => {
  it('a search term\'s action: its ad group\'s campaign, else its campaign by Amazon\'s id', async () => {
    adGroupFindFirst.mockResolvedValue({ campaignId: 'c-src' })
    expect(await ruleActionCampaignId({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {})).toBe('c-src')
    expect(adGroupFindFirst).toHaveBeenCalledWith({ where: { externalAdGroupId: 'EXT-g' }, select: { campaignId: true } })
    adGroupFindFirst.mockResolvedValue(null)
    campaignFindFirst.mockResolvedValue({ id: 'c-ext' })
    expect(await ruleActionCampaignId({ type: 'add_negative_exact' }, { searchTerm: { externalCampaignId: 'EXT-c' } })).toBe('c-ext')
  })
})

describe('ruleLeverSkip', () => {
  const budget = { type: 'adjust_ad_budget', percent: 20 }
  const ctx = { campaign: { id: 'c1' } }

  it('owned: a named skip in place of the write, with the lever and why', async () => {
    campaignLeverOwners.mockResolvedValue(held('c1', { budgets: OWNED }))
    const r = await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })
    expect(r).toEqual({
      type: 'adjust_ad_budget', ok: true,
      output: {
        skipped: 'brain-lever', campaignId: 'c1',
        why: 'left alone: a product\'s brain runs the daily budget of campaign "GALE exact" (c1) — product gale in IT (one owner per lever); a person\'s own edit still passes',
        brainSkip: { lever: 'budgets', kind: 'owned', campaignId: 'c1', productId: 'gale', market: 'IT', reason: 'a product\'s brain runs the daily budget of campaign "GALE exact" (c1) — product gale in IT' },
      },
    })
    expect(campaignLeverOwners).toHaveBeenCalledWith(['c1'])
  })

  it('not owned, another lever owned: the rule runs as before', async () => {
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
    campaignLeverOwners.mockResolvedValue(held('c1', { negatives: OWNED }))
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
  })

  it('nothing enrolled (production today): one remembered answer, the campaign never even looked up', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    expect(await ruleLeverSkip({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {}, { ruleId: 'r1' })).toBeNull()
    expect(adGroupFindFirst).not.toHaveBeenCalled()
    expect(campaignLeverOwners).not.toHaveBeenCalled()
  })

  it('not under a live ceiling, an action of no one campaign\'s lever, no campaign: nothing read', async () => {
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'shadow')
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
    expect(await ruleLeverSkip({ type: 'notify' }, ctx, { ruleId: 'r1' })).toBeNull()
    expect(await ruleLeverSkip(budget, {}, { ruleId: 'r1' })).toBeNull()
    expect(campaignLeverOwners).not.toHaveBeenCalled()
  })

  it('a campaign the rule\'s picker leaves out is the handler\'s to say (campaign-not-selected)', async () => {
    campaignLeverOwners.mockResolvedValue(held('c1', { budgets: OWNED }))
    expect(await ruleLeverSkip({ ...budget, campaignIds: ['c9'] }, ctx, { ruleId: 'r1' })).toBeNull()
    expect(await ruleLeverSkip({ ...budget, campaignIds: ['c1'] }, ctx, { ruleId: 'r1' })).not.toBeNull()
  })

  it('a failed read is no skip: the rule runs and the write gate decides (it sends the write again when it cannot read either)', async () => {
    campaignLeverOwners.mockRejectedValue(new Error('db blip'))
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
    adGroupFindFirst.mockRejectedValue(new Error('db blip'))
    expect(await ruleLeverSkip({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {}, { ruleId: 'r1' })).toBeNull()
  })
})

describe('ruleResultLeverSkips (pure)', () => {
  it('reads a one-campaign skip and a handler\'s per-lever counts; ignores anything else', () => {
    expect(ruleResultLeverSkips({ output: { brainSkip: { lever: 'state' } } })).toEqual({ state: 1 })
    expect(ruleResultLeverSkips({ output: { brainSkips: { counts: { negatives: 3, harvest: 1, nonsense: 2 } } } })).toEqual({ negatives: 3, harvest: 1 })
    expect(ruleResultLeverSkips({ output: { dryRun: true } })).toEqual({})
    expect(ruleResultLeverSkips(null)).toEqual({})
  })
})

describe('warmRuleLeverOwners', () => {
  it('one read for every campaign a pass names; Amazon\'s campaign ids in one query', async () => {
    campaignFindMany.mockResolvedValue([{ id: 'c3' }])
    await warmRuleLeverOwners([{ campaign: { id: 'c1' } }, { adTarget: { campaignId: 'c2' } }, { searchTerm: { externalCampaignId: 'EXT-c3' } }, { campaign: { id: 'c1' } }])
    expect(campaignFindMany).toHaveBeenCalledTimes(1)
    expect(campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(new Set(campaignLeverOwners.mock.calls[0][0] as string[])).toEqual(new Set(['c1', 'c2', 'c3']))
  })
  it('nothing enrolled or not live: nothing more read; a failure never throws', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    await warmRuleLeverOwners([{ campaign: { id: 'c1' } }])
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    anyBrainEnrolled.mockRejectedValue(new Error('db blip'))
    await expect(warmRuleLeverOwners([{ campaign: { id: 'c1' } }])).resolves.toBeUndefined()
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    anyBrainEnrolled.mockReset()
    await warmRuleLeverOwners([{ campaign: { id: 'c1' } }])
    expect(anyBrainEnrolled).not.toHaveBeenCalled()
  })
})
