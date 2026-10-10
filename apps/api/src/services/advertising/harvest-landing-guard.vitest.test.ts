/**
 * Harvest fix B1 + B10 — the landing guard's decision (harvest-landing-guard.ts decideLanding, pure) and its switch of a
 * paused landing (enableLanding, the keyword state write path stubbed). The reads run on a real PostgreSQL in
 * harvest-landing-guard-postgres.vitest.test.ts. Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { LandingFacts } from './harvest-landing-guard.js'

const h = vi.hoisted(() => ({ update: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, outboundQueueId: 'q1', bidHistoryIds: [], actionLogId: 'log-1', error: null }) as Record<string, unknown>) }))
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('./ads-mutation.service.js', () => ({ updateAdTargetWithSync: (a: Record<string, unknown>) => h.update(a) }))

const { blockingNegative, decideLanding, enableLanding, landingKey } = await import('./harvest-landing-guard.js')

const facts = (over: Partial<LandingFacts> = {}): LandingFacts => ({
  term: 'touring jacket', match: 'EXACT',
  adGroup: { id: 'g-exact', name: 'Exact', status: 'ENABLED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED' } },
  existing: [], negatives: [], ...over,
})
const kw = (status: string, externalTargetId: string | null = `AMZ-${status}`) => ({ id: `t-${status.toLowerCase()}`, status, externalTargetId })

describe('harvest fix B1 — what counts as landed', () => {
  it('nothing of the term there: created, and it serves', () => {
    expect(decideLanding(facts())).toEqual({ kind: 'create', serves: true, why: 'nothing of "touring jacket" stands in ad group "Exact": it is created there' })
  })

  it('an ENABLED keyword with Amazon\'s id: landed', () => {
    expect(decideLanding(facts({ existing: [kw('ENABLED')] }))).toMatchObject({ kind: 'landed', targetId: 't-enabled', externalTargetId: 'AMZ-ENABLED', serves: true })
  })

  it('a PAUSED one: switched on again as the landing — never "found"', () => {
    expect(decideLanding(facts({ existing: [kw('PAUSED')] }))).toEqual({
      kind: 'enable', targetId: 't-paused', externalTargetId: 'AMZ-PAUSED', serves: true,
      why: 'the exact keyword "touring jacket" stands paused in ad group "Exact": it is switched on again as the landing',
    })
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
    const pausedGroup = facts({ adGroup: { id: 'g-exact', name: 'Exact', status: 'PAUSED', campaign: { id: 'c-exact', name: 'Jacket Exact', status: 'ENABLED' } }, existing: [kw('ENABLED')] })
    expect(decideLanding(pausedGroup)).toMatchObject({ kind: 'landed', serves: false, why: expect.stringMatching(/the ad group is paused, so the source is not negated$/) })
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

describe('harvest fix B1 — a paused landing is switched on through the keyword state write path', () => {
  beforeEach(() => h.update.mockClear())

  it('asks the write gate now and sends at once, as the harvest\'s own writer and change set', async () => {
    expect(await enableLanding('t-paused', { actor: 'automation:ads-brain-harvest', changeSetId: 'ap-1', reason: 'harvest' })).toEqual({ ok: true, actionLogId: 'log-1', why: null })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ adTargetId: 't-paused', patch: { status: 'ENABLED' }, actor: 'automation:ads-brain-harvest', changeSetId: 'ap-1', askGate: true, applyImmediately: true }))
  })

  it('a bare person id is that person', async () => {
    await enableLanding('t-paused', { actor: 'owner-1', manual: true, reason: 'harvest' })
    expect(h.update).toHaveBeenCalledWith(expect.objectContaining({ actor: 'user:owner-1', manual: true }))
  })

  it('a refusal comes back with its words: the caller negates nothing', async () => {
    h.update.mockResolvedValueOnce({ ok: false, outboundQueueId: null, bidHistoryIds: [], actionLogId: null, error: 'campaign_allowlist: not allowlisted' })
    expect(await enableLanding('t-paused', { actor: 'user:owner', reason: 'harvest' })).toEqual({ ok: false, actionLogId: null, why: 'campaign_allowlist: not allowlisted' })
  })
})
