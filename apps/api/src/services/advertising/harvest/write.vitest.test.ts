/**
 * HARVEST ENGINE — the one writer (harvest/write.ts) with the gate, the create services and the landing guard as stubs, for
 * what the engine adds to the brain's pair (the brain's own pair: brain/harvest-write.vitest.test.ts): the funnel blocks in
 * the same change set (asked of the gate first, written only once the keyword stands), a PHRASE keyword and its negative
 * phrase, and the landing guard as the ONE landing check (HCORE review H2 + M4): a paused keyword is switched on with the
 * start bid and is NO landing — no source or funnel negative in the same call, they wait until Amazon confirmed the
 * switch-on; an archived copy or a blocking negative holds; a destination that does not serve holds. The undo pauses only a
 * keyword the harvest made. Values are made up (public repo).
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  gate: vi.fn(async (_ctx: Record<string, unknown>) => ({ allowed: true, mode: 'live' }) as Record<string, unknown>),
  keyword: vi.fn(async (_a: Record<string, unknown>) => ({ id: 'k1', externalTargetId: 'AMZ-K1', outcome: 'created' }) as Record<string, unknown>),
  negative: vi.fn(async (a: Record<string, unknown>) => ({ outcome: 'created', adTargetId: `n-${a.adGroupId}`, externalTargetId: 'AMZ-N', refusal: null, error: null }) as Record<string, unknown>),
  targets: [] as Array<Record<string, unknown>>,
  update: vi.fn(async (_a: Record<string, unknown>) => ({ ok: true, actionLogId: 'log', error: null }) as Record<string, unknown>),
  retire: vi.fn(async (a: { adTargetIds: string[] }) => ({ outcomes: a.adTargetIds.map((id) => ({ adTargetId: id, kind: 'retired', actionLogId: `log-${id}` })) }) as Record<string, unknown>),
  landing: vi.fn(async (_a: Record<string, unknown>) => ({ kind: 'create', serves: true, why: 'nothing there' }) as Record<string, unknown>),
  enable: vi.fn(async (_id: string, bid: number, _who: Record<string, unknown>) => ({ ok: true, actionLogId: 'log-on', why: null, bidCents: bid }) as Record<string, unknown>),
  switchBid: vi.fn(async (a: { wantCents: number }) => ({ cents: a.wantCents, currentCents: 10, held: null }) as Record<string, unknown>),
  serving: vi.fn(async (items: Array<{ adTargetId: string }>) => new Set(items.map((i) => i.adTargetId))),
  order: [] as string[],
  madeBefore: [] as string[],
}))
vi.mock('../../../db.js', () => ({
  default: {
    adGroup: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => args.where.id.in.map((id) => ({ id, campaignId: `c-${id}`, campaign: { marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } }))) },
    adTarget: { findMany: vi.fn(async (args: { where: { id: { in: string[] } } }) => h.targets.filter((t) => args.where.id.in.includes(String(t.id)))) },
    // Whether this very harvest made a negative before (its creation audited for the same change set).
    advertisingActionLog: { count: vi.fn(async (args: { where: { entityId: string; executionId?: string } }) => (h.madeBefore.includes(args.where.entityId) && args.where.executionId === 'ap1' ? 1 : 0)) },
  },
}))
vi.mock('../ads-mutation.service.js', () => ({ updateAdTargetWithSync: async (a: Record<string, unknown>) => { h.order.push(`${(a.patch as { status: string }).status}:${a.adTargetId}`); return h.update(a) } }))
vi.mock('../negatives-retire.service.js', () => ({ retireNegatives: async (a: { adTargetIds: string[] }) => { h.order.push(`retire:${a.adTargetIds.join(',')}`); return h.retire(a) } }))
vi.mock('../ads-write-gate.js', () => ({ checkAdsWriteGate: (ctx: Record<string, unknown>) => h.gate(ctx) }))
vi.mock('../ads-create.service.js', () => ({ createKeywordLocal: async (a: Record<string, unknown>) => { h.order.push('keyword'); return h.keyword(a) }, createTargetLocal: (a: Record<string, unknown>) => h.keyword(a) }))
vi.mock('../ads-negative-kw.service.js', () => ({ writeNegativeKeyword: async (a: Record<string, unknown>) => { h.order.push(`neg:${a.adGroupId}:${a.matchType}`); return h.negative(a) }, writeNegativeProductTarget: (a: Record<string, unknown>) => h.negative(a) }))
vi.mock('../../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../harvest-landing-guard.js', async (original) => ({
  ...(await original<object>()),
  checkLanding: (a: Record<string, unknown>) => h.landing(a),
  enableLanding: (id: string, bid: number, who: Record<string, unknown>) => { h.order.push(`enable:${id}@${bid}`); return h.enable(id, bid, who) },
  switchOnBid: (a: { wantCents: number }) => h.switchBid(a),
  servingLandings: (items: Array<{ adTargetId: string }>) => h.serving(items),
}))

const { writeHarvest, undoHarvestWrite, preflightHarvest, ENGINE_OWED_WORDS } = await import('./write.js')
const { storedOutcome } = await import('./execute.js')

const who = { actor: 'user:owner', manual: true, confirmOwnLimits: true, changeSetId: 'ap1', reason: 'test' }
const block = (adGroupId: string, over: Record<string, unknown> = {}) => ({ adGroupId, campaignId: `c-${adGroupId}`, role: 'AUTO' as const, action: 'negate' as const, why: 'x', ...over })
const input = (over: Record<string, unknown> = {}) => ({ term: 'touring jacket', isAsin: false, match: 'EXACT' as const, destAdGroupId: 'g-exact', bidCents: 40, keywordTargetId: null, sources: [block('g-auto')], funnel: [block('g-broad', { role: 'BROAD' })], metric: 'harvest', noServeWords: 'a harvest never goes into a destination that does not serve', ...over })

beforeEach(() => {
  for (const f of [h.gate, h.keyword, h.negative, h.update, h.retire, h.enable, h.switchBid, h.serving]) f.mockClear()
  h.landing.mockReset(); h.landing.mockResolvedValue({ kind: 'create', serves: true, why: 'nothing there' })
  h.order = []; h.targets = []
})

describe('one change set: keyword, sources, funnel', () => {
  it('the landing guard first, every half asked of the gate as the approver; then the keyword; then the source and the funnel block', async () => {
    const o = await writeHarvest(input(), who)
    expect(h.landing).toHaveBeenCalledWith({ adGroupId: 'g-exact', term: 'touring jacket', match: 'EXACT' })
    expect(o).toMatchObject({ status: 'DONE', keyword: { targetId: 'k1' }, why: expect.stringMatching(/one funnel block/) })
    expect(h.gate.mock.calls.map(([c]) => [c.dimension, c.campaignId, c.manual])).toEqual([['keywords', 'c-g-exact', true], ['negatives', 'c-g-auto', true], ['negatives', 'c-g-broad', true]])
    expect(h.order).toEqual(['keyword', 'neg:g-auto:EXACT', 'neg:g-broad:EXACT'])
    expect(o.funnel).toEqual([expect.objectContaining({ adGroupId: 'g-broad', result: 'landed', negativeTargetId: 'n-g-broad' })])
  })

  it('a funnel block the gate refuses writes nothing at all', async () => {
    h.gate.mockImplementation(async (ctx) => (ctx.campaignId === 'c-g-broad' ? { allowed: false, deniedAt: 'brain_lever', reason: 'the brain owns it' } : { allowed: true, mode: 'live' }))
    expect(await writeHarvest(input(), who)).toMatchObject({ status: 'REFUSED', keyword: null })
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative).not.toHaveBeenCalled()
    h.gate.mockImplementation(async () => ({ allowed: true, mode: 'live' }))
  })

  it('PHRASE: a phrase keyword (the guard asked for PHRASE), a negative phrase where the block says so', async () => {
    await writeHarvest(input({ match: 'PHRASE', sources: [block('g-auto', { negMatch: 'PHRASE' })], funnel: [] }), who)
    expect(h.landing).toHaveBeenCalledWith(expect.objectContaining({ match: 'PHRASE' }))
    expect(h.keyword).toHaveBeenCalledWith(expect.objectContaining({ matchType: 'PHRASE', keywordText: 'touring jacket', manual: true, changeSetId: 'ap1' }))
    expect(h.order).toEqual(['keyword', 'neg:g-auto:PHRASE'])
    expect(h.gate.mock.calls[1][0]).toMatchObject({ negativeMatchType: 'NEGATIVE_PHRASE' })
  })
})

describe('H2 + M4 — the landing guard is the ONE landing check', () => {
  it('a paused keyword is switched on WITH the start bid, sent at once — and is no landing: no source or funnel negative until Amazon confirms it', async () => {
    h.landing.mockResolvedValue({ kind: 'enable', targetId: 'k-paused', externalTargetId: 'AMZ-KP', why: 'switch on the paused exact keyword' })
    h.switchBid.mockResolvedValueOnce({ cents: 35, currentCents: 10, held: 'held by the ads strategy\'s band' })
    const o = await writeHarvest(input(), who)
    expect(h.switchBid).toHaveBeenCalledWith(expect.objectContaining({ targetId: 'k-paused', wantCents: 40 }))
    expect(h.enable).toHaveBeenCalledWith('k-paused', 35, expect.objectContaining({ actor: 'user:owner', manual: true, changeSetId: 'ap1' }))
    expect(h.order).toEqual(['enable:k-paused@35'])
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative).not.toHaveBeenCalled()
    expect(o).toMatchObject({ status: 'HALF_DONE', keyword: { targetId: 'k-paused', confirmed: false, bidCents: 35 } })
    expect([...o.sources, ...o.funnel].map((s) => s.result)).toEqual(['failed', 'failed'])
    // Still not confirmed at the next harvest of the term: nothing sent. Confirmed: the owed blocks follow, DONE.
    h.serving.mockResolvedValueOnce(new Set())
    expect(await writeHarvest(input({ keywordTargetId: 'k-paused', sources: o.sources, funnel: o.funnel }), who)).toMatchObject({ status: 'HALF_DONE', keyword: { confirmed: false } })
    expect(h.negative).not.toHaveBeenCalled()
    const done = await writeHarvest(input({ keywordTargetId: 'k-paused', sources: o.sources, funnel: o.funnel }), who)
    expect(done.status).toBe('DONE')
    expect(h.order.slice(-2)).toEqual(['neg:g-auto:EXACT', 'neg:g-broad:EXACT'])
  })

  it('a refused switch-on writes nothing', async () => {
    h.landing.mockResolvedValue({ kind: 'enable', targetId: 'k-paused', externalTargetId: 'AMZ-KP', why: 'switch on' })
    h.enable.mockResolvedValueOnce({ ok: false, actionLogId: null, why: 'halted', bidCents: null })
    expect(await writeHarvest(input(), who)).toMatchObject({ status: 'REFUSED', keyword: null })
    expect(h.negative).not.toHaveBeenCalled()
  })

  it('an enabled keyword with Amazon\'s id the guard found is the keyword (no create); the blocks are written', async () => {
    h.landing.mockResolvedValue({ kind: 'landed', targetId: 'k-on', externalTargetId: 'AMZ-ON', serves: true, why: 'runs' })
    expect(await writeHarvest(input(), who)).toMatchObject({ status: 'DONE', keyword: { targetId: 'k-on', existed: true } })
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative).toHaveBeenCalledTimes(2)
  })

  it('an archived copy or a blocking negative: HELD, nothing asked or written; a destination that does not serve: HELD', async () => {
    h.landing.mockResolvedValue({ kind: 'hold', deniedAt: 'landing_archived', why: 'the exact keyword there is archived' })
    expect(await writeHarvest(input(), who)).toMatchObject({ status: 'HELD', keyword: null, why: expect.stringMatching(/^held — the exact keyword there is archived/) })
    h.landing.mockResolvedValue({ kind: 'create', serves: false, why: 'its campaign is paused' })
    expect(await writeHarvest(input(), who)).toMatchObject({ status: 'HELD', why: expect.stringMatching(/a harvest never goes into a destination that does not serve/) })
    expect(h.gate).not.toHaveBeenCalled()
    expect(h.keyword).not.toHaveBeenCalled()
    expect(h.negative).not.toHaveBeenCalled()
  })
})

describe('N2 — what finishes the owed blocks is said truly (the brain\'s run, or harvesting again)', () => {
  it('the brain\'s records: its next run sends them; a person\'s / Claude\'s / a rule\'s: harvest it again to finish', async () => {
    h.landing.mockResolvedValue({ kind: 'enable', targetId: 'k-paused', externalTargetId: 'AMZ-KP', why: 'switch on' })
    const brain = await writeHarvest(input(), who)
    expect(brain.why).toMatch(/sent by the next run/)
    const engine = await writeHarvest(input({ owedWords: ENGINE_OWED_WORDS }), who)
    expect(engine).toMatchObject({ status: 'HALF_DONE', why: expect.stringMatching(/harvest it again once Amazon shows the keyword running/) })
    expect(JSON.stringify(engine)).not.toMatch(/next run/)
    // A negative that failed to land under a standing keyword.
    h.landing.mockResolvedValue({ kind: 'create', serves: true, why: 'nothing there' })
    h.negative.mockResolvedValueOnce({ outcome: 'failed', adTargetId: null, error: 'Amazon timed out' })
    const half = await writeHarvest(input({ owedWords: ENGINE_OWED_WORDS }), who)
    expect(half).toMatchObject({ status: 'HALF_DONE', why: expect.stringMatching(/harvest it again to finish/) })
    expect(half.why).not.toMatch(/next run/)
  })
})

describe('N3 (M2) — the person\'s own limits each half goes past are warned, never hidden', () => {
  it('the keyword\'s and each negative\'s own-limit warnings, by half and ad group', async () => {
    h.gate.mockImplementation(async (ctx) => (ctx.dimension === 'keywords'
      ? { allowed: true, mode: 'live', pastOwnLimits: [{ limit: 'entity_bounds', reason: 'bid above your 30¢ ceiling' }] }
      : ctx.campaignId === 'c-g-auto' ? { allowed: true, mode: 'live', pastOwnLimits: [{ limit: 'product_protected', reason: 'a product your ads strategy protects' }] } : { allowed: true, mode: 'live' }))
    const pre = await preflightHarvest({ term: 'touring jacket', isAsin: false, destAdGroupId: 'g-exact', bidCents: 40, keyword: 'create', blocks: [block('g-auto'), block('g-broad')] }, who)
    expect(pre).toEqual({ ok: true, warnings: [
      { half: 'keyword', adGroupId: 'g-exact', limit: 'entity_bounds', reason: 'bid above your 30¢ ceiling' },
      { half: 'negative', adGroupId: 'g-auto', limit: 'product_protected', reason: 'a product your ads strategy protects' },
    ] })
    // Asked as the person who confirms his own limits (the approver), so the gate warns instead of refusing.
    expect(h.gate.mock.calls.every(([c]) => c.manual === true && c.confirmOwnLimits === true)).toBe(true)
    h.gate.mockImplementation(async () => ({ allowed: true, mode: 'live' }))
  })
})

describe('N1 — completing a HALF_DONE record keeps what the first set made', () => {
  const now = new Date('2026-10-11T08:00:00Z')
  const first = { keywordTargetId: 'k-first', landedAt: new Date('2026-10-09T08:00:00Z'), judgeAfter: new Date('2026-10-19T08:00:00Z'), verdict: 'WAITING', keywordBefore: 'none' }
  const out = (status: string, over: Record<string, unknown> = {}) => ({ status, keyword: null, sources: [block('g-auto', { result: 'landed', negativeTargetId: 'n-1' })], funnel: [block('g-broad', { result: 'failed' })], why: 'held — its campaign is paused', error: 'its campaign is paused', ...over }) as never
  it('a completion that does not land stays HALF_DONE: its keyword, its landing and the blocks that landed are kept (Undo stays offered)', () => {
    for (const status of ['HELD', 'REFUSED', 'FAILED']) {
      const data = storedOutcome(out(status), now, first)
      expect(data).toMatchObject({ status: 'HALF_DONE', stage: 'NEGATIVES', why: expect.stringMatching(/did not land.*harvest it again to finish/) })
      for (const k of ['keywordTargetId', 'landedAt', 'judgeAfter', 'verdict', 'heldBy']) expect(data).not.toHaveProperty(k)
    }
  })
  it('a completion that lands keeps the first set\'s landing; one whose first set had none starts it now', () => {
    const done = out('DONE', { keyword: { targetId: 'k-first', externalTargetId: 'AMZ', existed: true }, error: null, why: 'the keyword stands' })
    expect(storedOutcome(done, now, first)).not.toHaveProperty('landedAt')
    expect(storedOutcome(done, now, { ...first, landedAt: null })).toMatchObject({ status: 'DONE', landedAt: now, verdict: 'WAITING' })
    // Not a completion: a plain HELD stays HELD.
    expect(storedOutcome(out('HELD'), now, null)).toMatchObject({ status: 'HELD', heldBy: 'its campaign is paused' })
  })
})

describe('undo', () => {
  it('lifts every block (sources and funnel), then pauses the keyword the harvest made', async () => {
    h.targets = [{ id: 'k1', isNegative: false, status: 'ENABLED', adGroup: { campaignId: 'c1', campaign: { name: 'Exact', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }, ...['n1', 'n2'].map((id) => ({ id, isNegative: true, status: 'ENABLED', adGroup: { campaignId: 'c2', campaign: { name: 'Auto', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }))]
    const o = await undoHarvestWrite({ keywordTargetId: 'k1', pauseKeyword: true, blocks: [block('g-auto', { negativeTargetId: 'n1' }), block('g-broad', { negativeTargetId: 'n2' })] }, who)
    expect(o).toMatchObject({ paused: true, retired: 2, complete: true })
    expect(h.order).toEqual(['retire:n1,n2', 'PAUSED:k1'])
  })

  it('release review (Low) — a negative that was there already is recorded as another writer\'s: its undo never lifts it', async () => {
    h.negative.mockImplementation(async (a: Record<string, unknown>) => (a.adGroupId === 'g-broad'
      ? { outcome: 'already_existed', adTargetId: 'n-theirs', externalTargetId: 'AMZ-T', refusal: null, error: null }
      : { outcome: 'created', adTargetId: `n-${a.adGroupId}`, externalTargetId: 'AMZ-N', refusal: null, error: null }))
    const o = await writeHarvest(input(), who)
    expect(o.status).toBe('DONE')
    expect(o.funnel).toEqual([expect.objectContaining({ adGroupId: 'g-broad', result: 'landed', negativeTargetId: 'n-theirs', own: false })])
    expect(o.sources[0]).not.toHaveProperty('own')
    h.order = []
    h.targets = [{ id: 'k1', isNegative: false, status: 'ENABLED', adGroup: { campaignId: 'c1', campaign: { name: 'Exact', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }, ...['n-g-auto', 'n-theirs'].map((id) => ({ id, isNegative: true, status: 'ENABLED', adGroup: { campaignId: 'c2', campaign: { name: 'Auto', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }))]
    expect(await undoHarvestWrite({ keywordTargetId: 'k1', pauseKeyword: true, blocks: [...o.sources, ...o.funnel] }, who)).toMatchObject({ retired: 1, complete: true })
    expect(h.order).toEqual(['retire:n-g-auto', 'PAUSED:k1'])
    // Re-review (Low) — after a run that died once Amazon took it, the retry finds its OWN negative: its undo lifts it.
    h.madeBefore = ['n-theirs']
    h.order = []
    const retry = await writeHarvest(input(), who)
    expect(retry.funnel[0]).not.toHaveProperty('own')
    expect(await undoHarvestWrite({ keywordTargetId: 'k1', pauseKeyword: true, blocks: [...retry.sources, ...retry.funnel] }, who)).toMatchObject({ retired: 2, complete: true })
    h.madeBefore = []
    h.negative.mockImplementation(async (a: Record<string, unknown>) => ({ outcome: 'created', adTargetId: `n-${a.adGroupId}`, externalTargetId: 'AMZ-N', refusal: null, error: null }))
  })

  it('a keyword that stood before the harvest keeps running: only the blocks are lifted', async () => {
    h.targets = [{ id: 'k1', isNegative: false, status: 'ENABLED', adGroup: { campaignId: 'c1', campaign: { name: 'Exact', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }, { id: 'n1', isNegative: true, status: 'ENABLED', adGroup: { campaignId: 'c2', campaign: { name: 'Auto', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS' } } }]
    const o = await undoHarvestWrite({ keywordTargetId: 'k1', pauseKeyword: false, blocks: [block('g-auto', { negativeTargetId: 'n1' })] }, who)
    expect(o).toMatchObject({ paused: false, retired: 1, complete: true })
    expect(h.order).toEqual(['retire:n1'])
  })
})
