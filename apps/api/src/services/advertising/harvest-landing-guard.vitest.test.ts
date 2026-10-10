/**
 * Harvest fix B1 + B10 — the landing guard's decision (harvest-landing-guard.ts decideLanding, pure), the bid a paused
 * landing is switched on with (switchOnBid) and the switch itself (enableLanding, the keyword state write path stubbed).
 * The reads run on a real PostgreSQL in harvest-landing-guard-postgres.vitest.test.ts. Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LandingFacts } from './harvest-landing-guard.js'

const h = vi.hoisted(() => ({
  update: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, outboundQueueId: 'q1', bidHistoryIds: [], actionLogId: 'log-1', error: null }) as Record<string, unknown>),
  // The paused keyword: its bid now, its campaign's bounds and largest change per step.
  target: { bidCents: 20, adGroupId: 'g-exact', adGroup: { campaign: { id: 'c-exact', marketplace: 'IT', minBidCents: null as number | null, maxBidCents: null as number | null, dynamicBidding: null as unknown } } },
  limits: { minBidCents: null, maxBidCents: null, maxChangePct: null } as Record<string, unknown>,
  written: 40,
}))
vi.mock('../../db.js', () => ({
  default: { adTarget: { findUnique: vi.fn(async (a: { select: Record<string, unknown> }) => (a.select.adGroup ? h.target : { bidCents: h.written })) } },
}))
vi.mock('./ads-mutation.service.js', () => ({ updateAdTargetWithSync: (a: Record<string, unknown>) => h.update(a) }))
vi.mock('./ads-strategy/bids.js', async (original) => ({ ...(await original<object>()), bidLimitsFor: vi.fn(async () => h.limits) }))

const { blockingNegative, decideLanding, enableLanding, landingKey, switchOnBid } = await import('./harvest-landing-guard.js')

const facts = (over: Partial<LandingFacts> = {}): LandingFacts => ({
  term: 'touring jacket', match: 'EXACT',
  adGroup: { id: 'g-exact', name: 'Exact', status: 'ENABLED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED', suppressed: false } },
  existing: [], negatives: [], ...over,
})
const kw = (status: string, externalTargetId: string | null = `AMZ-${status}`, confirmed = true) => ({ id: `t-${status.toLowerCase()}`, status, externalTargetId, confirmed })

describe('harvest fix B1 — what counts as landed', () => {
  it('nothing of the term there: created, and it serves', () => {
    expect(decideLanding(facts())).toEqual({ kind: 'create', serves: true, why: 'nothing of "touring jacket" stands in ad group "Exact": it is created there' })
  })

  it('an ENABLED keyword with Amazon\'s id: landed', () => {
    expect(decideLanding(facts({ existing: [kw('ENABLED')] }))).toMatchObject({ kind: 'landed', targetId: 't-enabled', externalTargetId: 'AMZ-ENABLED', serves: true })
  })

  it('a PAUSED one: switched on again — never "found", and no landing yet (no serves: the source waits for Amazon)', () => {
    expect(decideLanding(facts({ existing: [kw('PAUSED')] }))).toEqual({
      kind: 'enable', targetId: 't-paused', externalTargetId: 'AMZ-PAUSED',
      why: 'switch on the paused exact keyword "touring jacket" in ad group "Exact" again, at the harvest\'s start bid (nothing is created); its source is negated only once Amazon confirms it',
    })
  })

  it('a paused one in a destination that does not serve: held — switching it on would land nothing', () => {
    const stopped = facts({ existing: [kw('PAUSED')], adGroup: { id: 'g-exact', name: 'Exact', status: 'ENABLED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED', suppressed: true } } })
    expect(decideLanding(stopped)).toMatchObject({ kind: 'hold', deniedAt: 'landing_idle', why: expect.stringMatching(/stands paused there, and switching it on would land nothing: its campaign's bids are suppressed/) })
  })

  it('an ENABLED one switched on a moment ago and not confirmed by Amazon yet: not landed yet (serves false)', () => {
    expect(decideLanding(facts({ existing: [kw('ENABLED', 'AMZ-ON', false)] }))).toMatchObject({ kind: 'landed', serves: false, why: expect.stringMatching(/was switched on again and Amazon has not confirmed it yet, so the source is not negated/) })
  })

  it('an ARCHIVED one: held with the reason, nothing written, the source never negated', () => {
    expect(decideLanding(facts({ existing: [kw('ARCHIVED')] }))).toEqual({
      kind: 'hold', deniedAt: 'landing_archived',
      why: 'ad group "Exact" cannot take "touring jacket": the exact keyword "touring jacket" there is archived: Amazon cannot switch an archived one on again, and Nexus does not add it twice to one ad group. Nothing was written there and the source is not negated',
    })
  })

  it('several rows: an enabled one wins over a paused one, a paused one over an archived one', () => {
    expect(decideLanding(facts({ existing: [kw('ARCHIVED'), kw('PAUSED'), kw('ENABLED')] })).kind).toBe('landed')
    expect(decideLanding(facts({ existing: [kw('ARCHIVED'), kw('PAUSED')] })).kind).toBe('enable')
  })

  it('a row Amazon never took (no id), whatever its status: the create services send it, as before', () => {
    expect(decideLanding(facts({ existing: [kw('ARCHIVED', null)] })).kind).toBe('create')
    expect(decideLanding(facts({ existing: [kw('PAUSED', null)] })).kind).toBe('create')
  })

  it('a destination that does not serve: never a landing the source may be negated for, and it says why', () => {
    const pausedCampaign = facts({ adGroup: { id: 'g-exact', name: 'Exact', status: 'ENABLED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'PAUSED' } } })
    expect(decideLanding(pausedCampaign)).toEqual({ kind: 'create', serves: false, why: 'nothing of "touring jacket" stands in ad group "Exact": it is created there; its campaign "Jacket Exact" is paused, so the source is not negated' })
    const pausedGroup = facts({ adGroup: { id: 'g-exact', name: 'Exact', status: 'PAUSED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED', suppressed: false } }, existing: [kw('ENABLED')] })
    expect(decideLanding(pausedGroup)).toMatchObject({ kind: 'landed', serves: false, why: expect.stringMatching(/the ad group is paused, so the source is not negated$/) })
  })

  it('a campaign whose bids are suppressed (a stop, or born at the floor) does not serve either', () => {
    const stopped = facts({ adGroup: { id: 'g-exact', name: 'Exact', status: 'ENABLED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED', suppressed: true } } })
    expect(decideLanding(stopped)).toEqual({ kind: 'create', serves: false, why: 'nothing of "touring jacket" stands in ad group "Exact": it is created there; its campaign\'s bids are suppressed (a stop, or born at the floor and not started), so the source is not negated' })
  })

  it('the ad group gone from Nexus: held', () => {
    expect(decideLanding(facts({ adGroup: null }))).toMatchObject({ kind: 'hold', deniedAt: 'landing_gone', why: expect.stringMatching(/no longer in Nexus/) })
  })

  it('an ASIN: its product target, by the same rules', () => {
    const asin = facts({ term: 'B0JACKET01', match: 'PRODUCT', existing: [kw('ARCHIVED')] })
    expect(decideLanding(asin)).toMatchObject({ kind: 'hold', deniedAt: 'landing_archived', why: expect.stringMatching(/the product target "B0JACKET01" there is archived/) })
  })
})

describe('harvest fix B10 — a negative there that blocks the term holds the landing', () => {
  it('an exact negative with the term\'s words, in the ad group: held, even over an enabled keyword', () => {
    const d = decideLanding(facts({ existing: [kw('ENABLED')], negatives: [{ text: 'Touring  Jacket', match: 'EXACT', level: 'AD_GROUP' }] }))
    expect(d).toEqual({
      kind: 'hold', deniedAt: 'landing_negative',
      why: 'ad group "Exact" cannot take "touring jacket": a negative exact "Touring  Jacket" in ad group "Exact" blocks "touring jacket" there: a keyword for it would never show. Nothing was written there and the source is not negated',
    })
  })

  it('a phrase negative of the campaign whose words the term holds in order: held, naming the campaign', () => {
    expect(decideLanding(facts({ negatives: [{ text: 'touring', match: 'PHRASE', level: 'CAMPAIGN' }] }))).toMatchObject({ kind: 'hold', deniedAt: 'landing_negative', why: expect.stringMatching(/a negative phrase "touring" in campaign "Jacket Exact" blocks/) })
  })

  it('negatives that do not block the term hold nothing: other words, words out of order, a longer exact', () => {
    const negatives = [
      { text: 'rain jacket', match: 'PHRASE' as const, level: 'AD_GROUP' as const },
      { text: 'jacket touring', match: 'PHRASE' as const, level: 'CAMPAIGN' as const },
      { text: 'touring jacket pro', match: 'EXACT' as const, level: 'AD_GROUP' as const },
      { text: 'B0JACKET01', match: 'PRODUCT' as const, level: 'AD_GROUP' as const },
    ]
    expect(decideLanding(facts({ negatives })).kind).toBe('create')
    expect(blockingNegative('touring jacket', negatives)).toBeNull()
  })

  it('an ASIN: its negative product target (any case) holds it; a keyword negative does not', () => {
    expect(blockingNegative('b0jacket01', [{ text: 'touring', match: 'PHRASE' }, { text: 'B0JACKET01', match: 'PRODUCT' }])).toEqual({ text: 'B0JACKET01', match: 'PRODUCT' })
    expect(blockingNegative('b0jacket01', [{ text: 'b0jacket01', match: 'EXACT' }])).toBeNull()
  })

  it('the key a term is compared by: words lower-cased and single-spaced, an ASIN upper-cased', () => {
    expect(landingKey('  Touring   Jacket ', false)).toBe('touring jacket')
    expect(landingKey('b0jacket01', true)).toBe('B0JACKET01')
  })
})

describe('harvest fix B1 — a paused landing is switched on with the harvest\'s start bid, through the keyword state write path', () => {
  beforeEach(() => {
    h.update.mockClear()
    h.target.bidCents = 20
    h.target.adGroup.campaign = { id: 'c-exact', marketplace: 'IT', minBidCents: null, maxBidCents: null, dynamicBidding: null }
    h.limits = { minBidCents: null, maxBidCents: null, maxChangePct: null }
  })

  it('status and bid in ONE patch: the bounds and the gate asked now, sent at once, as the harvest\'s own writer and change set; the bid written comes back', async () => {
    expect(await enableLanding('t-paused', 40, { actor: 'automation:ads-brain-harvest', changeSetId: 'ap-1', reason: 'harvest' })).toEqual({ ok: true, actionLogId: 'log-1', why: null, bidCents: 40 })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ adTargetId: 't-paused', patch: { status: 'ENABLED', bidCents: 40 }, actor: 'automation:ads-brain-harvest', changeSetId: 'ap-1', askGate: true, applyImmediately: true }))
  })

  it('a bare person id is that person', async () => {
    await enableLanding('t-paused', 40, { actor: 'owner-1', manual: true, reason: 'harvest' })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user:owner-1', manual: true }))
  })

  it('a refusal comes back with its words: the caller negates nothing', async () => {
    h.update.mockResolvedValueOnce({ ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'campaign_allowlist: not allowlisted' })
    expect(await enableLanding('t-paused', 40, { actor: 'user:owner', reason: 'harvest' })).toEqual({ ok: false, actionLogId: null, why: 'campaign_allowlist: not allowlisted', bidCents: null })
  })

  it('the bid: the start bid as asked when nothing binds it', async () => {
    expect(await switchOnBid({ targetId: 't-paused', wantCents: 40, who: { actor: 'automation:ads-brain-harvest' } })).toEqual({ cents: 40, currentCents: 20, held: null })
  })

  it('the bid is held like a create\'s: inside the strategy band, then the campaign\'s own bounds', async () => {
    h.limits = { minBidCents: null, maxBidCents: { value: 35, source: { level: 'market' } }, maxChangePct: null }
    expect(await switchOnBid({ targetId: 't-paused', wantCents: 40, who: { actor: 'user:owner', manual: true } })).toEqual({ cents: 35, currentCents: 20, held: 'held by the ads strategy\'s band' })
    h.target.adGroup.campaign.maxBidCents = 30
    expect(await switchOnBid({ targetId: 't-paused', wantCents: 40, who: { actor: 'user:owner', manual: true } })).toMatchObject({ cents: 30, held: 'held by the ads strategy\'s band and the campaign\'s highest bid' })
  })

  it('an engine\'s or a rule\'s switch steps from the current bid as the mutation layer does; a person\'s own does not', async () => {
    h.target.adGroup.campaign.dynamicBidding = { maxBidChangePct: 50 }
    expect(await switchOnBid({ targetId: 't-paused', wantCents: 40, who: { actor: 'automation:ads-brain-harvest' } })).toEqual({ cents: 30, currentCents: 20, held: 'held by the largest bid change per step' })
    expect(await switchOnBid({ targetId: 't-paused', wantCents: 40, who: { actor: 'user:owner', manual: true } })).toMatchObject({ cents: 40, held: null })
  })
})
