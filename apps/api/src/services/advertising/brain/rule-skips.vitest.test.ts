/**
 * ONE BRAIN AB-6 — an ads rule leaves a lever a product's brain owns (or the Owner locked) before it asks (brain/rule-skips.ts).
 *   map       the lever each one-campaign action writes; a mapped negative and the bid actions BB-9 takes are not here
 *   campaign  the bid brain's order (campaign, ad group, keyword), then a search term's ad group or campaign by Amazon's id
 *   hook      owned → a named skip with why, the lever and its holder; not owned, not live, nothing enrolled, another
 *             campaign of the picker, no campaign, a failed read → null (the rule runs as before, the write gate decides)
 *   counts    both shapes read back, per holder and lever (one skip, a handler's tally)
 *   one pass  withRulePass (follow-up of #527): the campaigns and their holders read ONCE for the pass and kept for all of it,
 *             however many rules and actions ask, and past the 15 s memory of lever-owners; inert when nothing is enrolled
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CampaignLeverOwners } from './lever-owners.js'

const campaignLeverOwners = vi.fn()
const anyBrainEnrolled = vi.fn()
vi.mock('./lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => anyBrainEnrolled(...a),
}))
const db = {
  adGroupFindFirst: vi.fn(), adGroupFindUnique: vi.fn(), adGroupFindMany: vi.fn(),
  adTargetFindUnique: vi.fn(), adTargetFindMany: vi.fn(), campaignFindFirst: vi.fn(), campaignFindMany: vi.fn(),
}
vi.mock('../../../db.js', () => ({
  default: {
    adGroup: { get findFirst() { return db.adGroupFindFirst }, get findUnique() { return db.adGroupFindUnique }, get findMany() { return db.adGroupFindMany } },
    adTarget: { get findUnique() { return db.adTargetFindUnique }, get findMany() { return db.adTargetFindMany } },
    campaign: { get findFirst() { return db.campaignFindFirst }, get findMany() { return db.campaignFindMany } },
  },
}))

const { ruleActionLever, ruleLeverSkip, ruleResultLeverSkips, withRulePass, ruleActionCampaignId } = await import('./rule-skips.js')

const held = (campaignId: string, levers: CampaignLeverOwners['levers']): Map<string, CampaignLeverOwners> =>
  new Map([[campaignId, { campaignId, name: 'GALE exact', market: 'IT', levers }]])
const OWNED = { kind: 'owned' as const, productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }
const queries = () => Object.values(db).reduce((n, f) => n + f.mock.calls.length, 0)

beforeEach(() => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  campaignLeverOwners.mockReset().mockResolvedValue(new Map())
  anyBrainEnrolled.mockReset().mockResolvedValue(true)
  for (const f of Object.values(db)) f.mockReset().mockResolvedValue(null)
  db.adGroupFindMany.mockResolvedValue([])
  db.adTargetFindMany.mockResolvedValue([])
  db.campaignFindMany.mockResolvedValue([])
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
    for (const type of ['sync_negatives_across_campaigns', 'harvest_and_negate', 'notify', 'pause_campaign', 'retail_guard', 'pace_budget', 'dayparting_apply']) expect(ruleActionLever({ type })).toBeNull()
  })
})

describe('ruleActionCampaignId — the bid brain\'s order, then the search term\'s', () => {
  it('a campaign named directly reads nothing', async () => {
    expect(await ruleActionCampaignId({ type: 'adjust_ad_budget' }, { campaign: { id: 'c1' } })).toBe('c1')
    expect(await ruleActionCampaignId({ type: 'pause_target' }, { adTarget: { id: 't1', campaignId: 'c2' } })).toBe('c2')
    expect(queries()).toBe(0)
  })
  it('an ad group, else a keyword, by Nexus\'s id', async () => {
    db.adGroupFindUnique.mockResolvedValue({ campaignId: 'c-ag' })
    expect(await ruleActionCampaignId({ type: 'bid_down', target: 'ad_group', adGroupId: 'g1' }, {})).toBe('c-ag')
    db.adTargetFindUnique.mockResolvedValue({ adGroup: { campaignId: 'c-t' } })
    expect(await ruleActionCampaignId({ type: 'pause_target' }, { adTarget: { id: 't9' } })).toBe('c-t')
  })
  it('a search term\'s action: its ad group\'s campaign, else its campaign by Amazon\'s id', async () => {
    db.adGroupFindFirst.mockResolvedValue({ campaignId: 'c-src' })
    expect(await ruleActionCampaignId({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {})).toBe('c-src')
    expect(db.adGroupFindFirst).toHaveBeenCalledWith({ where: { externalAdGroupId: 'EXT-g' }, select: { campaignId: true } })
    db.adGroupFindFirst.mockResolvedValue(null)
    db.campaignFindFirst.mockResolvedValue({ id: 'c-ext' })
    expect(await ruleActionCampaignId({ type: 'add_negative_exact' }, { searchTerm: { externalCampaignId: 'EXT-c' } })).toBe('c-ext')
  })
})

describe('ruleLeverSkip', () => {
  const budget = { type: 'adjust_ad_budget', percent: 20 }
  const ctx = { campaign: { id: 'c1' } }

  it('owned: a named skip in place of the write, with the lever, its holder and why', async () => {
    campaignLeverOwners.mockResolvedValue(held('c1', { budgets: OWNED }))
    const r = await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })
    expect(r).toEqual({
      type: 'adjust_ad_budget', ok: true,
      output: {
        skipped: 'brain-lever', campaignId: 'c1',
        why: 'left alone: a product\'s brain runs the daily budget of campaign "GALE exact" (c1) — product gale in IT (one owner per lever); a person\'s own edit still passes',
        brainSkip: { lever: 'budgets', holder: 'productBrain', campaignId: 'c1', productId: 'gale', market: 'IT', reason: 'a product\'s brain runs the daily budget of campaign "GALE exact" (c1) — product gale in IT' },
      },
    })
    expect(campaignLeverOwners).toHaveBeenCalledWith(['c1'])
  })

  it('the Owner\'s lock is said as his lock, never as a brain', async () => {
    campaignLeverOwners.mockResolvedValue(held('c1', { budgets: { ...OWNED, kind: 'locked' } }))
    const r = await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })
    expect(r?.output).toMatchObject({ brainSkip: { holder: 'ownerLock' } })
    expect(String(r?.output.why)).toContain('the Owner holds the daily budget of campaign "GALE exact" (c1) at his own value')
    expect(String(r?.output.why)).not.toContain('product\'s brain runs')
  })

  it('not owned, another lever owned: the rule runs as before', async () => {
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
    campaignLeverOwners.mockResolvedValue(held('c1', { negatives: OWNED }))
    expect(await ruleLeverSkip(budget, ctx, { ruleId: 'r1' })).toBeNull()
  })

  it('nothing enrolled (production today): one remembered answer, the campaign never even looked up', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    expect(await ruleLeverSkip({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {}, { ruleId: 'r1' })).toBeNull()
    expect(queries()).toBe(0)
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
    db.adGroupFindFirst.mockRejectedValue(new Error('db blip'))
    expect(await ruleLeverSkip({ type: 'promote_to_exact', adGroupId: 'EXT-g' }, {}, { ruleId: 'r1' })).toBeNull()
  })
})

describe('withRulePass — the campaigns and their holders read once for the whole pass', () => {
  const contexts = [
    { campaign: { id: 'c1' } },
    { searchTerm: { externalAdGroupId: 'EXT-g2', externalCampaignId: 'EXT-c2', query: 'x' } },
    { adTarget: { id: 't3' } },
  ]
  beforeEach(() => {
    db.adGroupFindMany.mockResolvedValue([{ id: 'g2', externalAdGroupId: 'EXT-g2', campaignId: 'c2' }])
    db.adTargetFindMany.mockResolvedValue([{ id: 't3', adGroup: { campaignId: 'c3' } }])
    db.campaignFindMany.mockResolvedValue([{ id: 'c2', externalCampaignId: 'EXT-c2' }])
    campaignLeverOwners.mockResolvedValue(new Map([...held('c1', { budgets: OWNED }), ...held('c2', { negatives: OWNED }), ...held('c3', { state: OWNED })]))
  })

  it('one query per kind of id and one holders read, then every rule and action reads nothing', async () => {
    const skips = await withRulePass(contexts, async () => {
      const out = []
      for (let rule = 0; rule < 3; rule++) {
        out.push(await ruleLeverSkip({ type: 'adjust_ad_budget' }, contexts[0], { ruleId: `r${rule}` }))
        out.push(await ruleLeverSkip({ type: 'add_negative_exact' }, contexts[1], { ruleId: `r${rule}` }))
        out.push(await ruleLeverSkip({ type: 'promote_to_exact' }, contexts[1], { ruleId: `r${rule}` }))
        out.push(await ruleLeverSkip({ type: 'pause_target' }, contexts[2], { ruleId: `r${rule}` }))
      }
      return out
    })
    expect(campaignLeverOwners).toHaveBeenCalledTimes(1)
    expect(new Set(campaignLeverOwners.mock.calls[0][0] as string[])).toEqual(new Set(['c1', 'c2', 'c3']))
    expect(db.adGroupFindMany).toHaveBeenCalledTimes(1)
    expect(db.adTargetFindMany).toHaveBeenCalledTimes(1)
    expect(db.campaignFindMany).toHaveBeenCalledTimes(1)
    expect(db.adGroupFindFirst).not.toHaveBeenCalled()
    expect(db.adTargetFindUnique).not.toHaveBeenCalled()
    expect(db.campaignFindFirst).not.toHaveBeenCalled()
    // budgets of c1, negatives of c2 and state of c3 are held; c2's harvest is not
    expect(skips.map((s) => (s?.output as { brainSkip?: { lever: string } } | undefined)?.brainSkip?.lever ?? null))
      .toEqual(Array.from({ length: 3 }, () => ['budgets', 'negatives', null, 'state']).flat())
  })

  it('the answer is kept for the whole pass, past the 15 s memory of lever-owners: it is never read again inside the pass', async () => {
    vi.useFakeTimers()
    try {
      await withRulePass(contexts, async () => {
        await ruleLeverSkip({ type: 'adjust_ad_budget' }, contexts[0], { ruleId: 'r1' })
        vi.advanceTimersByTime(60_000)
        campaignLeverOwners.mockResolvedValue(new Map())
        expect(await ruleLeverSkip({ type: 'adjust_ad_budget' }, contexts[0], { ruleId: 'r2' })).not.toBeNull()
      })
    } finally {
      vi.useRealTimers()
    }
    expect(campaignLeverOwners).toHaveBeenCalledTimes(1)
  })

  it('a campaign no context named is read once, then kept', async () => {
    campaignLeverOwners.mockImplementation(async (ids: string[]) => new Map(ids.includes('c9') ? held('c9', { budgets: OWNED }) : []))
    const skips = await withRulePass([{ campaign: { id: 'c1' } }], async () => {
      const out = []
      for (let i = 0; i < 3; i++) out.push(await ruleLeverSkip({ type: 'adjust_ad_budget', campaignId: 'c9' }, {}, { ruleId: 'r1' }))
      return out
    })
    expect(skips.every((s) => s !== null)).toBe(true)
    expect(campaignLeverOwners.mock.calls.filter((c) => (c[0] as string[]).includes('c9'))).toHaveLength(1)
  })

  it('nothing enrolled or not live: the pass is inert — nothing looked up at all', async () => {
    anyBrainEnrolled.mockResolvedValue(false)
    await withRulePass(contexts, async () => {
      expect(await ruleLeverSkip({ type: 'add_negative_exact' }, contexts[1], { ruleId: 'r1' })).toBeNull()
    })
    expect(queries()).toBe(0)
    expect(campaignLeverOwners).not.toHaveBeenCalled()
    vi.stubEnv('NEXUS_BID_BRAIN_MODE', '')
    anyBrainEnrolled.mockClear()
    await withRulePass(contexts, async () => undefined)
    expect(anyBrainEnrolled).not.toHaveBeenCalled()
  })

  it('a failed read before the pass never throws: each rule then reads for itself', async () => {
    db.adGroupFindMany.mockRejectedValue(new Error('db blip'))
    const r = await withRulePass(contexts, async () => ruleLeverSkip({ type: 'adjust_ad_budget' }, contexts[0], { ruleId: 'r1' }))
    expect(r).not.toBeNull()
  })
})

describe('ruleResultLeverSkips (pure)', () => {
  it('reads a one-campaign skip and a handler\'s tally per holder and lever; ignores anything else', () => {
    expect(ruleResultLeverSkips({ output: { brainSkip: { lever: 'state', holder: 'ownerLock' } } })).toEqual({ ownerLock: { state: 1 } })
    expect(ruleResultLeverSkips({ output: { brainSkips: { counts: { productBrain: { negatives: 3, nonsense: 2 }, bidBrain: { bids: 1 }, stranger: { budgets: 4 } } } } }))
      .toEqual({ productBrain: { negatives: 3 }, bidBrain: { bids: 1 } })
    expect(ruleResultLeverSkips({ output: { brainSkip: { lever: 'state' } } })).toEqual({}) // no holder: not counted as anyone's
    expect(ruleResultLeverSkips({ output: { dryRun: true } })).toEqual({})
    expect(ruleResultLeverSkips(null)).toEqual({})
  })
})
