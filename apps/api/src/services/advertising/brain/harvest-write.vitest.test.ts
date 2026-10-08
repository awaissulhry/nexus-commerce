/**
 * ONE BRAIN AB-11 — the pair writer (brain/harvest-write.ts writePair), with the write gate and the create services as
 * stubs: both halves asked of the gate first (any refusal: neither written); the keyword first, a source negated only once
 * it stands; a negative that fails leaves it HALF_DONE (a refusal is named and not retried by the brain, a person's
 * approval asks for it again). Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gate: vi.fn(async (_ctx: Record<string, unknown>) => ({ allowed: true, mode: 'live' }) as Record<string, unknown>),
  keyword: vi.fn(async (_a: Record<string, unknown>) => ({ id: 'k1', externalTargetId: 'AMZ-K1', outcome: 'created' }) as Record<string, unknown>),
  negative: vi.fn(async (_a: Record<string, unknown>) => ({ outcome: 'created', adTargetId: 'n1', externalTargetId: 'AMZ-N1', refusal: null, error: null }) as Record<string, unknown>),
}))
vi.mock('../../../db.js', () => ({
  default: { adGroup: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id, campaignId: `c-${id}`, campaign: { marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } }))) } },
}))
vi.mock('../ads-write-gate.js', () => ({ checkAdsWriteGate: (ctx: Record<string, unknown>) => h.gate(ctx) }))
vi.mock('../ads-create.service.js', () => ({ createKeywordLocal: (a: Record<string, unknown>) => h.keyword(a), createTargetLocal: (a: Record<string, unknown>) => h.keyword(a) }))
vi.mock('../ads-negative-kw.service.js', () => ({ writeNegativeKeyword: (a: Record<string, unknown>) => h.negative(a), writeNegativeProductTarget: (a: Record<string, unknown>) => h.negative(a) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { writePair, brainWho, outcomeData } = await import('./harvest-write.js')
const { HARVEST_ACTOR, JUDGE_AFTER_MS } = await import('./harvest.js')

const src = (adGroupId: string, over: Record<string, unknown> = {}) => ({ adGroupId, campaignId: `c-${adGroupId}`, clicks: 10, role: 'AUTO' as const, action: 'negate' as const, why: 'x', ...over })
const pair = (over: Record<string, unknown> = {}) => ({ term: 'touring jacket', isAsin: false, destAdGroupId: 'g-exact', bidCents: 40, keywordTargetId: null, sources: [src('g-auto'), src('g-phrase')], ...over })
const who = brainWho('test')

beforeEach(() => { h.gate.mockClear(); h.keyword.mockClear(); h.negative.mockClear() })

describe('AB-11 — the pair: both halves or neither', () => {
  it('the gate is asked for the keyword and every source as the brain first; then the keyword; then each source negative exact', async () => {
    const o = await writePair(pair(), who)
    expect(o).toMatchObject({ status: 'DONE', keyword: { targetId: 'k1' } })
    expect(h.gate.mock.calls.map(([c]) => [c.dimension, c.campaignId, c.actor])).toEqual([['keywords', 'c-g-exact', HARVEST_ACTOR], ['negatives', 'c-g-auto', HARVEST_ACTOR], ['negatives', 'c-g-phrase', HARVEST_ACTOR]])
    expect(h.keyword).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'g-exact', keywordText: 'touring jacket', matchType: 'EXACT', bidEur: 0.4, userId: HARVEST_ACTOR, requireAmazon: true }))
    expect(h.negative.mock.calls.map(([a]) => [a.adGroupId, a.matchType, a.scope])).toEqual([['g-auto', 'EXACT', 'AD_GROUP'], ['g-phrase', 'EXACT', 'AD_GROUP']])
    expect(o.sources.map((s) => s.result)).toEqual(['landed', 'landed'])
  })

  it('a refused half writes neither: no keyword, no negative', async () => {
    h.gate.mockImplementation(async (ctx) => (ctx.campaignId === 'c-g-phrase' ? { allowed: false, deniedAt: 'campaign_allowlist', reason: 'not allowlisted' } : { allowed: true, mode: 'live' }))
    const o = await writePair(pair(), who)
    expect(o).toMatchObject({ status: 'REFUSED', keyword: null, why: expect.stringMatching(/nothing was written — the write gate refuses the source negative \(campaign_allowlist/) })
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative).not.toHaveBeenCalled()
    h.gate.mockImplementation(async () => ({ allowed: true, mode: 'live' }))
  })

  it('a keyword that does not reach Amazon: nothing is negated (the term is never left without a home)', async () => {
    h.keyword.mockResolvedValueOnce({ id: null, externalTargetId: null, outcome: 'failed', reason: 'Amazon returned no id' })
    const o = await writePair(pair(), who)
    expect(o).toMatchObject({ status: 'FAILED', keyword: null })
    expect(h.negative).not.toHaveBeenCalled()
  })

  it('a negative that fails leaves it HALF_DONE; the retry sends only what is owed; a refusal is named and not retried by the brain, a person asks again', async () => {
    h.negative.mockResolvedValueOnce({ outcome: 'created', adTargetId: 'n1', externalTargetId: 'AMZ-N1' }).mockResolvedValueOnce({ outcome: 'failed', adTargetId: null, error: 'Amazon returned no id' })
    const half = await writePair(pair(), who)
    expect(half).toMatchObject({ status: 'HALF_DONE', why: expect.stringMatching(/retried by the next run/) })
    expect(half.sources.map((s) => s.result)).toEqual(['landed', 'failed'])
    h.negative.mockClear(); h.keyword.mockClear()
    const done = await writePair(pair({ keywordTargetId: 'k1', sources: half.sources }), who)
    expect(done.status).toBe('DONE')
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative.mock.calls.map(([a]) => a.adGroupId)).toEqual(['g-phrase'])
    // A refused negative stays refused for the brain; a person's approval (retryRefused) asks for it again.
    const refused = [src('g-auto', { result: 'landed', negativeTargetId: 'n1' }), src('g-phrase', { result: 'refused', error: 'owner_locked: x' })]
    h.negative.mockClear()
    expect(await writePair(pair({ keywordTargetId: 'k1', sources: refused }), who)).toMatchObject({ status: 'HALF_DONE' })
    expect(h.negative).not.toHaveBeenCalled()
    expect(await writePair(pair({ keywordTargetId: 'k1', sources: refused, retryRefused: true }), { ...who, actor: 'user:owner', manual: true })).toMatchObject({ status: 'DONE' })
    expect(h.negative).toHaveBeenCalledTimes(1)
  })

  it('the judging clock starts once the keyword stands, and only once', () => {
    const now = new Date('2026-10-09T05:25:00Z')
    const data = outcomeData({ status: 'DONE', keyword: { targetId: 'k1', externalTargetId: 'AMZ-K1', existed: false }, sources: [], why: 'x', error: null }, now) as Record<string, unknown>
    expect(data).toMatchObject({ status: 'DONE', landedAt: now, verdict: 'WAITING', judgeAfter: new Date(now.getTime() + JUDGE_AFTER_MS) })
    expect(outcomeData({ status: 'DONE', keyword: null, sources: [], why: 'x', error: null }, now, new Date(0))).not.toHaveProperty('landedAt')
  })
})
