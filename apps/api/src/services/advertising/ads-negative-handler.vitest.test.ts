/**
 * NEG-P1 — `add_negative_exact`'s mapped wire path driven for real (mocked I/O): the mapping
 * matrix binds (look gates, create-ticks decide what lands where), the term/brand filters bind,
 * dedupe binds, every Negation Level is written including 'both', a landed write is mirrored
 * locally, and a write Amazon did not take is a FAILURE naming its gate. Every one of these was
 * stored-but-unread before NEG-P1 — the exact HP1 defect one tab over, pinned at the handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createNegative: vi.fn(),
  mirrorNegativeKeywordLocal: vi.fn(),
  createNegativeKeywordCampaignLocal: vi.fn(),
  createNegativeProductTargetLocal: vi.fn(),
  checkProtectConverting: vi.fn(),
}))

vi.mock('../automation-rule.service.js', () => ({
  ACTION_HANDLERS: {} as Record<string, unknown>,
  getFieldPath: vi.fn(),
}))
vi.mock('./ads-mutation.service.js', () => ({
  updateCampaignWithSync: vi.fn(),
  updateAdGroupWithSync: vi.fn(),
  updateAdTargetWithSync: vi.fn(),
}))
vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: h.createNegative }))
vi.mock('./ads-create.service.js', () => ({
  createKeywordLocal: vi.fn(),
  pushExistingKeyword: vi.fn(),
  mirrorNegativeKeywordLocal: h.mirrorNegativeKeywordLocal,
  createNegativeKeywordCampaignLocal: h.createNegativeKeywordCampaignLocal,
  createNegativeProductTargetLocal: h.createNegativeProductTargetLocal,
}))
vi.mock('./ads-protect-converting.js', () => ({
  checkProtectConverting: h.checkProtectConverting,
  protectConvertingConfig: (a: Record<string, unknown>) => ({ enabled: a.protectConverting !== false, windowDays: 30 }),
  normaliseNegTerm: (s: string) => s.toLowerCase().trim(),
}))
vi.mock('../../db.js', () => ({
  default: {
    amazonAdsSearchTerm: { groupBy: vi.fn() },
    amazonAdsConnection: { findFirst: vi.fn() },
    campaign: { findMany: vi.fn(), findFirst: vi.fn() },
    automationRule: { findUnique: vi.fn() },
    automationRuleExecution: { findMany: vi.fn() },
    adGroup: { findFirst: vi.fn(), findMany: vi.fn(), findUnique: vi.fn() },
    adTarget: { findFirst: vi.fn() },
    adProductAd: { count: vi.fn() },
  },
}))

import prisma from '../../db.js'
import { ACTION_HANDLERS } from '../automation-rule.service.js'
import './automation-action-handlers.js'

const db = vi.mocked(prisma, true)
const meta = { dryRun: false, ruleId: 'rule-negp1' }
const negate = (action: Record<string, unknown>, context: Record<string, unknown>, m = meta) =>
  (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, mm: unknown) => Promise<{ ok: boolean; error?: string; output?: Record<string, unknown> }>)(action, context, m)

/** context: a wasting term in source ad group EXT-SRC (local id src1) */
const CTX = { marketplace: 'IT', searchTerm: { query: 'ciabatte piscina', externalCampaignId: 'EXT-CSRC', externalAdGroupId: 'EXT-SRC', clicks: 9, spendCents: 700, orders: 0 } }
const WIRE = {
  blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT'] }] }],
  filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false },
  dedupe: true,
}
const ACT = { type: 'add_negative_exact', scope: 'AD_GROUP', levels: ['AD_GROUP'], negative: WIRE, protectConverting: true }

/** adGroup.findFirst answers both lookups: by externalAdGroupId (source) and by id (destination). */
const DSTS: Record<string, unknown> = {
  dst1: { id: 'dst1', externalAdGroupId: 'EXT-DST1', campaignId: 'c9', campaign: { externalCampaignId: 'EXT-C9' } },
  dst2: { id: 'dst2', externalAdGroupId: 'EXT-DST2', campaignId: 'c9', campaign: { externalCampaignId: 'EXT-C9' } },
  src1: { id: 'src1', externalAdGroupId: 'EXT-SRC', campaignId: 'c1', campaign: { externalCampaignId: 'EXT-CSRC' } },
}

beforeEach(() => {
  vi.clearAllMocks()
  db.adGroup.findFirst.mockImplementation((args: { where?: { externalAdGroupId?: string; id?: string } } = {}) => {
    const w = args.where ?? {}
    if (w.externalAdGroupId === 'EXT-SRC') return Promise.resolve({ id: 'src1' }) as never
    if (w.externalAdGroupId === 'EXT-ELSEWHERE') return Promise.resolve({ id: 'elsewhere1' }) as never
    if (w.id != null) return Promise.resolve(DSTS[w.id] ?? null) as never
    return Promise.resolve(null) as never
  })
  db.amazonAdsConnection.findFirst.mockResolvedValue({ profileId: 'p1' } as never)
  db.adTarget.findFirst.mockResolvedValue(null as never) // dedupe: nothing negated yet
  db.adProductAd.count.mockResolvedValue(0 as never)
  h.checkProtectConverting.mockResolvedValue(new Map())
  h.createNegative.mockResolvedValue({ ok: true, mode: 'live', externalNegativeKeywordId: 'neg-1', alreadyExisted: false, denied: null })
  h.mirrorNegativeKeywordLocal.mockResolvedValue({ id: 'm1', created: true })
  h.createNegativeKeywordCampaignLocal.mockResolvedValue({ id: 'm2', created: true })
  h.createNegativeProductTargetLocal.mockResolvedValue({ id: 'pt1', externalTargetId: 'ext-pt1', mode: 'live' })
})

describe('NEG-P1 — the mapped wire path', () => {
  it('creates the ticked types in the mapped destination and mirrors each landed write', async () => {
    const act = { ...ACT, negative: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT', 'PHRASE'] }] }] } }
    const r = await negate(act, CTX)
    expect(r.ok).toBe(true)
    expect(h.createNegative).toHaveBeenCalledTimes(2)
    const matchTypes = h.createNegative.mock.calls.map(([a]) => (a as { matchType: string }).matchType).sort()
    expect(matchTypes).toEqual(['NEGATIVE_EXACT', 'NEGATIVE_PHRASE'])
    for (const [a] of h.createNegative.mock.calls) {
      expect(a).toMatchObject({ externalCampaignId: 'EXT-C9', externalAdGroupId: 'EXT-DST1', scope: 'AD_GROUP', keywordText: 'ciabatte piscina', marketplace: 'IT' })
    }
    expect(h.mirrorNegativeKeywordLocal).toHaveBeenCalledTimes(2)
    expect((r.output as { confirmed: number }).confirmed).toBe(2)
  })

  it('skips a term whose source ad group is outside the mappings — and creates nothing', async () => {
    const r = await negate(ACT, { ...CTX, searchTerm: { ...CTX.searchTerm, externalAdGroupId: 'EXT-ELSEWHERE' } })
    expect(r.ok).toBe(true)
    expect((r.output as { skipped?: string }).skipped).toBe('source-ad-group-not-in-mappings')
    expect(h.createNegative).not.toHaveBeenCalled()
  })

  it('the brand filter refuses with the token named — "never negate your own brand terms" is real', async () => {
    const act = { ...ACT, negative: { ...WIRE, filters: { ...WIRE.filters, brandExclude: ['xavia'] } } }
    const r = await negate(act, { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'xavia ciabatte' } })
    expect(r.ok).toBe(true)
    expect((r.output as { skipped?: string }).skipped).toBe('term-filter')
    expect(String((r.output as { reason?: string }).reason)).toContain('xavia')
    expect(h.createNegative).not.toHaveBeenCalled()
  })

  it('protectConverting refuses BEFORE any write, as a failure carrying the evidence', async () => {
    h.checkProtectConverting.mockResolvedValue(new Map([[
      'ciabatte piscina', { allowed: false, reason: 'converted 3× in 30d', evidence: { orders: 3 } },
    ]]))
    const r = await negate(ACT, CTX)
    expect(r.ok).toBe(false)
    expect((r.output as { refusedBy?: string }).refusedBy).toBe('protectConverting')
    expect(h.createNegative).not.toHaveBeenCalled()
  })

  it('dedupe skips a term already negated at this level with this match type', async () => {
    db.adTarget.findFirst.mockResolvedValue({ id: 'existing-neg' } as never)
    const r = await negate(ACT, CTX)
    expect(r.ok).toBe(true)
    expect(h.createNegative).not.toHaveBeenCalled()
    const rows = (r.output as { outcomes: Array<{ skipped?: string }> }).outcomes
    expect(rows[0]?.skipped).toContain('dedupe')
  })

  it("levels ['AD_GROUP','CAMPAIGN'] writes BOTH — and one campaign write per campaign, however many destinations share it", async () => {
    const act = {
      ...ACT,
      levels: ['AD_GROUP', 'CAMPAIGN'],
      negative: { ...WIRE, dedupe: false, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT'] }, { adGroupId: 'dst2', types: ['EXACT'] }] }] },
    }
    const r = await negate(act, CTX)
    expect(r.ok).toBe(true)
    const scopes = h.createNegative.mock.calls.map(([a]) => (a as { scope: string }).scope)
    expect(scopes.filter((s) => s === 'AD_GROUP')).toHaveLength(2) // dst1 + dst2
    expect(scopes.filter((s) => s === 'CAMPAIGN')).toHaveLength(1) // c9 once, not twice
    expect(h.createNegativeKeywordCampaignLocal).toHaveBeenCalledTimes(1)
  })

  it('a gate denial is a FAILURE naming the gate, never a silent success', async () => {
    h.createNegative.mockResolvedValue({ ok: false, mode: 'live', externalNegativeKeywordId: null, alreadyExisted: false, denied: { deniedAt: 'whitelist', reason: 'protected term' } })
    const r = await negate({ ...ACT, negative: { ...WIRE, dedupe: false } }, CTX)
    expect(r.ok).toBe(false)
    expect(String(r.error)).toContain('did not reach Amazon')
    const rows = (r.output as { outcomes: Array<{ refused?: string }> }).outcomes
    expect(String(rows[0]?.refused)).toContain('whitelist')
    expect(h.mirrorNegativeKeywordLocal).not.toHaveBeenCalled()
  })

  it('a sandbox stub is NOT a landed negative (NEG.X lesson: read res.mode)', async () => {
    h.createNegative.mockResolvedValue({ ok: true, mode: 'sandbox', externalNegativeKeywordId: null, alreadyExisted: false, denied: null })
    const r = await negate({ ...ACT, negative: { ...WIRE, dedupe: false } }, CTX)
    expect(r.ok).toBe(false)
    const rows = (r.output as { outcomes: Array<{ refused?: string }> }).outcomes
    expect(String(rows[0]?.refused)).toContain('mode=sandbox')
  })

  it('the product tick negates an ASIN-shaped term as a PRODUCT target — and names the skip for a keyword term', async () => {
    const act = { ...ACT, negative: { ...WIRE, dedupe: false, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['ASIN'] }] }] } }
    const rAsin = await negate(act, { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'b0abcd1234' } })
    expect(rAsin.ok).toBe(true)
    expect(h.createNegativeProductTargetLocal).toHaveBeenCalledWith({ adGroupId: 'dst1', asin: 'b0abcd1234' })
    const rKw = await negate(act, CTX)
    expect(rKw.ok).toBe(true)
    const rows = (rKw.output as { outcomes: Array<{ skipped?: string }> }).outcomes
    expect(String(rows[0]?.skipped)).toContain('ASIN-shaped')
  })

  it('dryRun previews every write it would make and calls nothing', async () => {
    const act = { ...ACT, levels: ['AD_GROUP', 'CAMPAIGN'], negative: { ...WIRE, dedupe: false } }
    const r = await negate(act, CTX, { ...meta, dryRun: true })
    expect(r.ok).toBe(true)
    const rows = (r.output as { outcomes: Array<{ wouldCreate?: boolean; level?: string }> }).outcomes
    expect(rows.filter((o) => o.wouldCreate)).toHaveLength(2) // AD_GROUP + CAMPAIGN
    expect(h.createNegative).not.toHaveBeenCalled()
    expect(h.mirrorNegativeKeywordLocal).not.toHaveBeenCalled()
  })

  it('account-wide (no mappings) negates the SOURCE ad group, exact only — the legacy semantic through the wire', async () => {
    const r = await negate({ ...ACT, negative: { ...WIRE, dedupe: false, blocks: null } }, CTX)
    expect(r.ok).toBe(true)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
    const [a] = h.createNegative.mock.calls[0]
    expect(a).toMatchObject({ externalAdGroupId: 'EXT-SRC', externalCampaignId: 'EXT-CSRC', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' })
  })

  it('a rule WITHOUT the wire takes the legacy path untouched', async () => {
    h.createNegative.mockResolvedValue({ ok: true, mode: 'live', externalNegativeKeywordId: 'neg-9', alreadyExisted: false, denied: null })
    const r = await negate({ type: 'add_negative_exact', scope: 'CAMPAIGN' }, CTX)
    expect(r.ok).toBe(true)
    expect(h.createNegative).toHaveBeenCalledTimes(1)
    expect((h.createNegative.mock.calls[0][0] as { scope: string }).scope).toBe('CAMPAIGN')
  })
})
