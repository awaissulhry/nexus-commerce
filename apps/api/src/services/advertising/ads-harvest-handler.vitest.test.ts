/**
 * HP1 — `promote_to_exact` driven for real (mocked I/O): the mapping matrix binds, the term
 * filters bind, dedupe binds, the bid is computed, and a write Amazon did not take is a FAILURE.
 * Every one of these was stored-but-unread before HP1; these tests exist to fail if a branch is
 * deleted — the fleet-stale-constant failure mode, pinned at the handler.
 *
 * 5d — and where an account-wide harvest lands, that an ASIN becomes a product target, and that
 * negate-in-source follows only a landing in another ad group.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  createKeywordLocal: vi.fn(),
  pushExistingKeyword: vi.fn(),
  createTargetLocal: vi.fn(),
  createNegative: vi.fn(),
  writeNegativeKeyword: vi.fn(),
  writeNegativeProductTarget: vi.fn(),
  resolveStoredDestinations: vi.fn(),
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
vi.mock('./ads-negative-kw.service.js', () => ({
  createNegative: h.createNegative,
  writeNegativeKeyword: h.writeNegativeKeyword,
  writeNegativeProductTarget: h.writeNegativeProductTarget,
}))
vi.mock('./ads-create.service.js', () => ({
  createKeywordLocal: h.createKeywordLocal,
  pushExistingKeyword: h.pushExistingKeyword,
  createTargetLocal: h.createTargetLocal,
}))
vi.mock('./harvest-destination.service.js', () => ({ resolveStoredDestinations: h.resolveStoredDestinations }))
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

/** The source ad group's campaign: an automatic Sponsored Products one unless a test says otherwise. */
const AUTO_SP = { marketplace: 'IT', portfolioId: null, targetingType: 'AUTO', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' }
const MANUAL_SP = { ...AUTO_SP, targetingType: 'MANUAL' }
/** ad groups looked up by id: the stored destinations' campaigns (5d) and the default bid */
const BY_ID: Record<string, Record<string, unknown>> = {
  dstExact: { id: 'dstExact', name: 'GALE EXACT IT', campaign: MANUAL_SP, defaultBidCents: 35 },
  dstProduct: { id: 'dstProduct', name: 'GALE PAT IT', campaign: MANUAL_SP, defaultBidCents: 35 },
  dstDE: { id: 'dstDE', name: 'GALE EXACT DE', campaign: { ...MANUAL_SP, marketplace: 'DE' }, defaultBidCents: 35 },
}
const stored = (byType: Record<string, string>) => new Map(Object.entries(byType).map(([t, adGroupId]) => [t, { adGroupId, negateAtSource: true }]))

beforeEach(() => {
  vi.clearAllMocks()
  db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c1', campaign: AUTO_SP } as never)
  db.adGroup.findMany.mockResolvedValue([{ campaignId: 'c1' }] as never)
  db.adGroup.findUnique.mockImplementation(((args: { where: { id: string } }) => Promise.resolve(BY_ID[args.where.id] ?? { defaultBidCents: 35 })) as never)
  db.adTarget.findFirst.mockResolvedValue(null as never) // dedupe: nothing exists
  db.adProductAd.count.mockResolvedValue(0 as never)
  h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: 'ext-k1' })
  h.createTargetLocal.mockResolvedValue({ id: 'pt1', externalTargetId: 'ext-p1', mode: 'live' })
  h.resolveStoredDestinations.mockResolvedValue(new Map())
  h.writeNegativeKeyword.mockResolvedValue({ outcome: 'created', mode: 'live', externalTargetId: 'neg-1', reachedAmazon: true, adTargetId: 'n1', refusal: null, error: null })
  h.writeNegativeProductTarget.mockResolvedValue({ outcome: 'created', mode: 'live', externalTargetId: 'negp-1', reachedAmazon: true, adTargetId: 'n2', refusal: null, error: null })
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

  it('5d — a keyword term skips a ticked product type BY NAME while the keyword types still land', async () => {
    const act = { ...ACT, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT', 'ASIN'] }] }] } }
    const r = await promote(act, CTX)
    expect(r.ok).toBe(true)
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(outs.find((o) => o.matchType === 'ASIN')?.skipped).toMatch(/needs an ASIN/)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1) // EXACT only
    expect(h.createTargetLocal).not.toHaveBeenCalled()
  })

  it('an engine-native action (no wire) is account-wide: it lands per the destination rule, and a refused write fails', async () => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c1', campaign: MANUAL_SP } as never)
    h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: null, denied: { deniedAt: 'connection', reason: 'no ctx' } })
    const r = await promote({ type: 'promote_to_exact', bidEur: 0.6 }, CTX)
    expect(r.ok).toBe(false)
    expect(h.createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'src1', matchType: 'EXACT', bidEur: 0.6 }))
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(String(outs[0].refused)).toMatch(/connection/)
  })
})

/**
 * 5d (review 7.4) — an ACCOUNT-WIDE harvest used to create the keyword back in its source ad group, automatic
 * campaigns included, which take no keyword (the push failed and left local-only rows). It lands in the stored
 * destination now; the source only when it is a manual Sponsored Products ad group; otherwise a named refusal.
 */
describe('5d — an account-wide harvest lands in a destination', () => {
  const ACCOUNT_WIDE = { ...ACT, harvest: { ...WIRE, blocks: null } }

  it('the stored EXACT destination receives the keyword, not the source', async () => {
    h.resolveStoredDestinations.mockResolvedValue(stored({ EXACT: 'dstExact' }))
    const r = await promote(ACCOUNT_WIDE, CTX)
    expect(r.ok).toBe(true)
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1)
    expect(h.createKeywordLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'dstExact', matchType: 'EXACT' })
    expect(h.resolveStoredDestinations).toHaveBeenCalledWith(expect.objectContaining({ market: 'IT', campaign: 'c1', adGroup: 'src1' }))
  })

  it('no destination: an automatic source is refused by name (nothing written); a manual Sponsored Products source receives it', async () => {
    const r = await promote(ACCOUNT_WIDE, CTX)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/No harvest destination is set for exact keywords in IT/)
    expect(r.error).toMatch(/automatic campaign/)
    expect(r.output?.refusedBy).toBe('destination')
    expect(h.createKeywordLocal).not.toHaveBeenCalled()

    db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c1', campaign: MANUAL_SP } as never)
    const manual = await promote(ACCOUNT_WIDE, CTX)
    expect(manual.ok).toBe(true)
    expect(h.createKeywordLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'src1' })
  })

  it('a Sponsored Brands source is not a fallback either', async () => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c1', campaign: { ...MANUAL_SP, adProduct: 'SPONSORED_BRANDS', type: 'SB' } } as never)
    const r = await promote(ACCOUNT_WIDE, CTX)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/Sponsored Brands campaign/)
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('a stored destination in another market is refused by name', async () => {
    h.resolveStoredDestinations.mockResolvedValue(stored({ EXACT: 'dstDE' }))
    const r = await promote(ACCOUNT_WIDE, CTX)
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/is in DE, but this search term is from IT/)
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('the dry run names the destination it would use', async () => {
    h.resolveStoredDestinations.mockResolvedValue(stored({ EXACT: 'dstExact' }))
    const r = await (ACTION_HANDLERS.promote_to_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown> }>)(ACCOUNT_WIDE, CTX, { ...meta, dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.output?.outcomes).toEqual([expect.objectContaining({ adGroupId: 'dstExact', matchType: 'EXACT', wouldCreate: true })])
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })
})

/** 5d (review 7.5) — an ASIN search term is a product: it becomes a PRODUCT target, never a keyword. */
describe('5d — an ASIN becomes a product target', () => {
  const ASIN_CTX = { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'B0ABCD1234' } }

  it('a mapped rule creates it where the product type is ticked, and skips the keyword ticks by name', async () => {
    const act = { ...ACT, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['EXACT', 'ASIN'] }] }] } }
    const r = await promote(act, ASIN_CTX)
    expect(r.ok).toBe(true)
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
    expect(h.createTargetLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst1', kind: 'PRODUCT', value: 'B0ABCD1234', bidEur: 0.5 }))
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(outs.find((o) => o.matchType === 'EXACT')?.skipped).toMatch(/an ASIN is a product/)
    expect(r.output?.confirmed).toBe(1)
  })

  it('an account-wide rule uses the stored PRODUCT destination', async () => {
    h.resolveStoredDestinations.mockResolvedValue(stored({ EXACT: 'dstExact', PRODUCT: 'dstProduct' }))
    const r = await promote({ ...ACT, harvest: { ...WIRE, blocks: null } }, ASIN_CTX)
    expect(r.ok).toBe(true)
    expect(h.createTargetLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'dstProduct', kind: 'PRODUCT' })
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('a product target Amazon did not take is a failure', async () => {
    h.createTargetLocal.mockResolvedValue({ id: 'pt1', externalTargetId: null, mode: 'local' })
    const act = { ...ACT, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['ASIN'] }] }] } }
    const r = await promote(act, ASIN_CTX)
    expect(r.ok).toBe(false)
    const outs = r.output?.outcomes as Array<Record<string, unknown>>
    expect(String(outs[0].refused)).toMatch(/nothing was sent/)
  })
})

/**
 * 5d (review 7.3, Owner decision D4) — negate-in-source rides inside promote_to_exact: the source's isolation
 * negative is written only AFTER the term landed in ANOTHER ad group, and it skips the converting guard.
 */
describe('5d — negate-in-source only after landing elsewhere', () => {
  const NEG = { ...ACT, negateInSource: true }

  it('lands in another ad group → an EXACT negative in the source, converting guard skipped (and none without the switch)', async () => {
    const r = await promote(NEG, CTX)
    expect(r.ok).toBe(true)
    expect(h.writeNegativeKeyword).toHaveBeenCalledTimes(1)
    expect(h.writeNegativeKeyword.mock.calls[0][0]).toMatchObject({ scope: 'AD_GROUP', adGroupId: 'src1', keywordText: 'giacca moto uomo', matchType: 'EXACT', protectConverting: null })
    expect(r.output?.isolation).toMatchObject({ attempted: true, adGroupId: 'src1', reachedAmazon: true })

    const off = await promote(ACT, CTX)
    expect(off.ok).toBe(true)
    expect(h.writeNegativeKeyword).toHaveBeenCalledTimes(1)
    expect(off.output).not.toHaveProperty('isolation')
  })

  it('nothing landed → no negative', async () => {
    h.createKeywordLocal.mockResolvedValue({ id: 't1', externalTargetId: null, denied: { deniedAt: 'campaign_allowlist', reason: 'not allowlisted' } })
    const r = await promote(NEG, CTX)
    expect(r.ok).toBe(false)
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output?.isolation).toMatchObject({ attempted: false })
  })

  it('landed only in the source ad group → no negative (it would cancel the keyword)', async () => {
    db.adGroup.findFirst.mockResolvedValue({ id: 'src1', campaignId: 'c1', campaign: MANUAL_SP } as never)
    const r = await promote({ ...NEG, harvest: { ...WIRE, blocks: null } }, CTX)
    expect(r.ok).toBe(true)
    expect(h.createKeywordLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'src1' })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(String((r.output?.isolation as { reason?: string }).reason)).toMatch(/only in the ad group it came from/)
  })

  it('an ASIN that landed elsewhere gets a negative PRODUCT target in the source', async () => {
    const act = { ...NEG, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['ASIN'] }] }] } }
    const r = await promote(act, { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'B0ABCD1234' } })
    expect(r.ok).toBe(true)
    expect(h.writeNegativeProductTarget).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'src1', asin: 'B0ABCD1234' }))
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
  })

  it('a refusal (a protected term) is named, not a failure; a negative that did not land is a failure', async () => {
    h.writeNegativeKeyword.mockResolvedValue({ outcome: 'refused', mode: 'live', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: { deniedAt: 'keyword_protected', reason: 'protected term' }, error: null })
    const refused = await promote(NEG, CTX)
    expect(refused.ok).toBe(true)
    expect(String((refused.output?.isolation as { refused?: string }).refused)).toMatch(/keyword_protected/)
    h.writeNegativeKeyword.mockResolvedValue({ outcome: 'failed', mode: 'live', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: null, error: 'Amazon returned no id' })
    const failed = await promote(NEG, CTX)
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/negative in the source ad group did not reach Amazon/)
  })

  it('the dry run previews it and writes nothing', async () => {
    const r = await (ACTION_HANDLERS.promote_to_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown> }>)(NEG, CTX, { ...meta, dryRun: true })
    expect(r.ok).toBe(true)
    expect(r.output?.isolation).toMatchObject({ wouldNegate: true, adGroupId: 'src1', matchType: 'NEGATIVE_EXACT' })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
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
