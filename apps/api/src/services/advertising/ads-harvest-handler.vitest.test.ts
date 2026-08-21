/**
 * HP1 — `promote_to_exact` driven for real (mocked I/O): the mapping matrix binds, the term
 * filters bind, dedupe binds, the bid is computed, and a write Amazon did not take is a FAILURE.
 * Every one of these was stored-but-unread before HP1; these tests exist to fail if a branch is
 * deleted — the fleet-stale-constant failure mode, pinned at the handler.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createKeywordLocal: vi.fn(),
  pushExistingKeyword: vi.fn(),
  createNegative: vi.fn(),
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
  createKeywordLocal: h.createKeywordLocal,
  pushExistingKeyword: h.pushExistingKeyword,
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
const meta = { dryRun: false, ruleId: 'rule-hp1' }
const promote = (action: Record<string, unknown>, context: Record<string, unknown>) =>
  (ACTION_HANDLERS.promote_to_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; error?: string; output?: Record<string, unknown> }>)(action, context, meta)

/** context: a converting term in source ad group EXT-SRC (local id src1), CPC €0.50 */
const CTX = { marketplace: 'IT', searchTerm: { query: 'giacca moto uomo', externalAdGroupId: 'EXT-SRC', clicks: 10, spendCents: 500, orders: 3 } }
const WIRE = {
  blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['PHRASE', 'EXACT'] }] }],
  filters: { containsAny: [], notContains: [], brandExclude: [], competitorOnly: false },
  dedupe: true,
}
const ACT = { type: 'promote_to_exact', bid: { mode: 'cpc', value: null }, harvest: WIRE }

beforeEach(() => {
  vi.clearAllMocks()
  db.adGroup.findFirst.mockResolvedValue({ id: 'src1' } as never)
  db.adGroup.findMany.mockResolvedValue([{ campaignId: 'c1' }] as never)
  db.adGroup.findUnique.mockResolvedValue({ defaultBidCents: 35 } as never)
  db.adTarget.findFirst.mockResolvedValue(null as never) // dedupe: nothing exists
  db.adProductAd.count.mockResolvedValue(0 as never)
  h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: 'ext-k1' })
})

describe('HP1 — promote_to_exact honours the wire', () => {
  it('creates the mapped types in the mapped destination at the term’s own CPC', async () => {
    const r = await promote(ACT, CTX)
    expect(r.ok).toBe(true)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(2)
    for (const [args] of h.createKeywordLocal.mock.calls) {
      expect(args.adGroupId).toBe('dst1')
      expect(args.bidEur).toBe(0.5) // 500¢ / 10 clicks
      expect(['PHRASE', 'EXACT']).toContain(args.matchType)
    }
    expect(r.output?.confirmed).toBe(2)
  })

  it('skips, named, when the term’s source ad group is not in the rule’s look set', async () => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'some-other-ag' } as never)
    const r = await promote(ACT, CTX)
    expect(r.ok).toBe(true)
    expect(r.output?.skipped).toBe('source-ad-group-not-in-mappings')
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('skips, named, on a brand-protected term', async () => {
    const act = { ...ACT, harvest: { ...WIRE, filters: { ...WIRE.filters, brandExclude: ['xavia'] } } }
    const r = await promote(act, { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'xavia giacca moto' } })
    expect(r.ok).toBe(true)
    expect(r.output?.skipped).toBe('term-filter')
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('dedupe: an existing same-match-type keyword in the rule group skips that creation', async () => {
    db.adTarget.findFirst.mockResolvedValue({ id: 'existing' } as never)
    const r = await promote(ACT, CTX)
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(outs.every((o) => String(o.skipped ?? '').includes('dedupe'))).toBe(true)
    expect(r.ok).toBe(true) // skips are policy working, not failure
  })

  it('🔴 a write the gate refused is a FAILURE that names the gate, never a silent success', async () => {
    h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: null, denied: { deniedAt: 'campaign_allowlist', reason: 'campaign not allowlisted' } })
    const r = await promote(ACT, CTX)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/did not reach Amazon/)
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(String(outs[0].refused)).toContain('campaign_allowlist')
  })

  it('an existing LOCAL-ONLY keyword gets a PUSH, not a silent idempotent no-op', async () => {
    h.createKeywordLocal.mockResolvedValue({ id: 't-local', externalTargetId: null, existed: true })
    h.pushExistingKeyword.mockResolvedValue({ ok: true, externalTargetId: 'ext-pushed', outcome: 'acted' })
    const r = await promote({ ...ACT, harvest: { ...WIRE, dedupe: false } }, CTX)
    expect(h.pushExistingKeyword).toHaveBeenCalled()
    expect(r.ok).toBe(true)
    expect(r.output?.confirmed).toBe(2)
  })

  it('a ticked ASIN type is refused BY NAME while keyword types still land', async () => {
    const act = { ...ACT, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT', 'ASIN'] }] }] } }
    const r = await promote(act, CTX)
    expect(r.ok).toBe(true)
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(outs.some((o) => String(o.refused ?? '').includes('product-target'))).toBe(true)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1) // EXACT only
  })

  it('an engine-native action (no wire) keeps the legacy shape — but a refused write now fails', async () => {
    h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: null, denied: { deniedAt: 'connection', reason: 'no ctx' } })
    const r = await promote({ type: 'promote_to_exact', bidEur: 0.5 }, CTX)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/connection/)
  })
})

describe('HP1 — negate-in-source respects the same mapping', () => {
  const negate = (action: Record<string, unknown>, context: Record<string, unknown>) =>
    (ACTION_HANDLERS.add_negative_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown> }>)(action, context, meta)

  it('skips, named, when the source ad group is outside the allowlist', async () => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'elsewhere' } as never)
    const r = await negate({ type: 'add_negative_exact', scope: 'AD_GROUP', sourceLookAdGroupIds: ['src1'] }, { ...CTX, campaign: { externalCampaignId: 'C1' } })
    expect(r.ok).toBe(true)
    expect(r.output?.skipped).toBe('source-ad-group-not-in-mappings')
    expect(h.createNegative).not.toHaveBeenCalled()
  })
})
