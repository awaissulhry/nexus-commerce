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
  // The undo (batch 2 fix): the harvest record, its targets, the pause and the retire service.
  harvest: { keywordTargetId: 'k1', sources: [] as unknown[] } as Record<string, unknown>,
  targets: [] as Array<Record<string, unknown>>,
  pause: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, actionLogId: 'log-pause', error: null }) as Record<string, unknown>),
  retire: vi.fn(async (a: { adTargetIds: string[] }) => ({ outcomes: a.adTargetIds.map((id) => ({ adTargetId: id, kind: 'retired', actionLogId: `log-${id}` })) }) as Record<string, unknown>),
  order: [] as string[],
}))
vi.mock('../../../db.js', () => ({
  default: {
    adGroup: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id, campaignId: `c-${id}`, campaign: { marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } }))) },
    adsBrainHarvest: { findUniqueOrThrow: vi.fn(async () => h.harvest) },
    adTarget: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => h.targets.filter((t) => args.where.id.in.includes(String(t.id)))) },
  },
}))
vi.mock('../ads-mutation.service.js', () => ({ updateAdTargetWithSync: async (a: Record<string, unknown>) => { h.order.push(`pause:${a.adTargetId}`); return h.pause(a) } }))
vi.mock('../negatives-retire.service.js', () => ({ retireNegatives: async (a: { adTargetIds: string[] }) => { h.order.push(`retire:${a.adTargetIds.join(',')}`); return h.retire(a) } }))
vi.mock('../ads-write-gate.js', () => ({ checkAdsWriteGate: (ctx: Record<string, unknown>) => h.gate(ctx) }))
vi.mock('../ads-create.service.js', () => ({ createKeywordLocal: (a: Record<string, unknown>) => h.keyword(a), createTargetLocal: (a: Record<string, unknown>) => h.keyword(a) }))
vi.mock('../ads-negative-kw.service.js', () => ({ writeNegativeKeyword: (a: Record<string, unknown>) => h.negative(a), writeNegativeProductTarget: (a: Record<string, unknown>) => h.negative(a) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { writePair, brainWho, outcomeData, undoHarvest } = await import('./harvest-write.js')
const { HARVEST_ACTOR, JUDGE_AFTER_MS } = await import('./harvest.js')

const src = (adGroupId: string, over: Record<string, unknown> = {}) => ({ adGroupId, campaignId: `c-${adGroupId}`, clicks: 10, role: 'AUTO' as const, action: 'negate' as const, why: 'x', ...over })
const pair = (over: Record<string, unknown> = {}) => ({ term: 'touring jacket', isAsin: false, destAdGroupId: 'g-exact', bidCents: 40, keywordTargetId: null, sources: [src('g-auto'), src('g-phrase')], ...over })
const who = brainWho('test')

beforeEach(() => { h.gate.mockClear(); h.keyword.mockClear(); h.negative.mockClear(); h.pause.mockClear(); h.retire.mockClear(); h.order = [] })

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

describe('batch 2 fix — the Owner\'s negateAtSource off: the keyword alone, no source negative, nothing asked of the gate for them', () => {
  it('kept sources take no negative and no gate question; the pair is whole with the keyword', async () => {
    const o = await writePair(pair({ sources: [src('g-auto', { action: 'kept', why: 'negateAtSource off' }), src('g-phrase', { action: 'kept', why: 'negateAtSource off' })] }), who)
    expect(o).toMatchObject({ status: 'DONE', keyword: { targetId: 'k1' } })
    expect(h.gate.mock.calls.map(([c]) => c.dimension)).toEqual(['keywords'])
    expect(h.negative).not.toHaveBeenCalled()
    expect(o.sources.map((x) => x.action)).toEqual(['kept', 'kept'])
  })
})

describe('batch 2 fix — the undo is a pair: both halves asked of the gate first; the sources run the term again, then the keyword pauses', () => {
  const kw = { id: 'k1', isNegative: false, status: 'ENABLED', adGroup: { campaignId: 'c-exact', campaign: { name: 'Exact', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }
  const neg = (id: string) => ({ id, isNegative: true, status: 'ENABLED', adGroup: { campaignId: `c-${id}`, campaign: { name: `Source ${id}`, marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } })
  beforeEach(() => {
    h.harvest = { keywordTargetId: 'k1', sources: [src('g-auto', { negativeTargetId: 'n1', result: 'landed' }), src('g-phrase', { negativeTargetId: 'n2', result: 'landed' })] }
    h.targets = [kw, neg('n1'), neg('n2')]
    h.gate.mockImplementation(async () => ({ allowed: true, mode: 'live' }))
  })

  it('whole: the gate asked for every half first, the source negatives retired, then the keyword paused (a deliberate pause)', async () => {
    const u = await undoHarvest('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: 'worse' })
    expect(u).toEqual({ paused: true, retired: 2, problems: [], complete: true, actionLogIds: ['log-pause', 'log-n1', 'log-n2'] })
    expect(h.gate.mock.calls.map(([c]) => [c.campaignId, c.dimension ?? null, c.isSuppression ?? false, c.actor])).toEqual([
      ['c-n1', 'negatives', false, 'automation:auto-undo'], ['c-n2', 'negatives', false, 'automation:auto-undo'], ['c-exact', null, true, 'automation:auto-undo'],
    ])
    expect(h.order).toEqual(['retire:n1,n2', 'pause:k1'])
    expect(h.pause).toHaveBeenCalledWith(expect.objectContaining({ patch: { status: 'PAUSED' }, letsGo: true, askGate: true }))
  })

  it('a refused half: neither is written, said', async () => {
    h.gate.mockImplementation(async (ctx) => (ctx.campaignId === 'c-n2' ? { allowed: false, deniedAt: 'owner_locked', reason: 'the Owner holds it' } : { allowed: true, mode: 'live' }))
    const u = await undoHarvest('hv-1', { actor: 'user:owner', manual: true, changeSetId: 'ap-1', reason: 'worse' })
    expect(u).toMatchObject({ paused: false, retired: 0, complete: false, problems: [expect.stringMatching(/^nothing was put back — the write gate refuses the source negative in campaign "Source n2" \(owner_locked: the Owner holds it\): the undo is written whole or not at all$/)] })
    expect(h.order).toEqual([])
  })

  it('a retire that fails: the keyword is left running (the term never without a home); sent again, only what is left is written', async () => {
    h.retire.mockImplementationOnce(async (a: { adTargetIds: string[] }) => ({ outcomes: [{ adTargetId: a.adTargetIds[0], kind: 'retired', actionLogId: 'log-n1' }, { adTargetId: a.adTargetIds[1], kind: 'failed', reason: 'Amazon timed out' }] }))
    const half = await undoHarvest('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: 'worse' })
    expect(half).toMatchObject({ paused: false, retired: 1, complete: false })
    expect(half.problems).toEqual([expect.stringMatching(/Amazon timed out/), expect.stringMatching(/the keyword was left running: a source still blocks the term/)])
    expect(h.pause).not.toHaveBeenCalled()
    h.targets = [kw, { ...neg('n1'), status: 'ARCHIVED' }, neg('n2')]
    h.order = []
    expect(await undoHarvest('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: 'worse' })).toMatchObject({ paused: true, retired: 1, complete: true })
    expect(h.order).toEqual(['retire:n2', 'pause:k1'])
  })

  it('nothing left of it: complete, nothing asked, nothing written', async () => {
    h.targets = [{ ...kw, status: 'PAUSED' }, { ...neg('n1'), status: 'ARCHIVED' }, { ...neg('n2'), status: 'ARCHIVED' }]
    expect(await undoHarvest('hv-1', { actor: 'automation:auto-undo', manual: false, changeSetId: null, reason: 'worse' })).toEqual({ paused: false, retired: 0, problems: [], complete: true, actionLogIds: [] })
    expect(h.gate).not.toHaveBeenCalled()
  })
})
