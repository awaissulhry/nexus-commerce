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
    adTarget: { findFirst: vi.fn(), findMany: vi.fn() },
    adProductAd: { count: vi.fn(), findMany: vi.fn() },
    product: { findMany: vi.fn() },
    adsStrategy: { findMany: vi.fn(), findFirst: vi.fn() },
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
  db.adTarget.findMany.mockResolvedValue([] as never) // PB-6a — no keyword of the product holds the term yet (L2)
  db.adProductAd.count.mockResolvedValue(0 as never)
  db.adProductAd.findMany.mockResolvedValue([] as never) // PB-6a — no product family: the scope is the source and destination
  db.product.findMany.mockResolvedValue([] as never)
  db.adsStrategy.findMany.mockResolvedValue([] as never) // no strategy: the harvest defaults are the bar
  db.adsStrategy.findFirst.mockResolvedValue(null as never)
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
 * 5d (review 7.3, Owner decision D4) — negate-in-source rides inside promote_to_exact and skips the converting guard.
 * PB-6a (handover "proven") — it follows only a home elsewhere that meets the harvest bar there; a fresh landing keeps
 * the term running in its source. `proven()` makes dst1 hold the term as a live exact keyword that sold 3 times there.
 */
describe('5d / PB-6a — negate-in-source only once the home proves itself', () => {
  const NEG = { ...ACT, negateInSource: true }
  const proven = (query = 'giacca moto uomo', orders = 3) => {
    db.adTarget.findMany.mockResolvedValue([{ id: 'home1', adGroupId: 'dst1', kind: query.startsWith('B0') ? 'PRODUCT' : 'KEYWORD', expressionType: query.startsWith('B0') ? 'ASIN' : 'EXACT', expressionValue: query, status: 'ENABLED', externalTargetId: 'x-home' }] as never)
    db.adGroup.findMany.mockResolvedValue([{ id: 'dst1', campaignId: 'c1', externalAdGroupId: 'EXT-DST', campaign: MANUAL_SP }] as never)
    db.amazonAdsSearchTerm.groupBy.mockResolvedValue([{ query: query.toLowerCase(), campaignId: 'EXT-C', adGroupId: 'EXT-DST', marketplace: 'IT', _sum: { impressions: 100, clicks: 10, costMicros: 5_000_000n, orders7d: orders, sales7dCents: 9000 } }] as never)
  }

  it('a fresh landing elsewhere: the keyword is created, the source is NOT negated yet (and nothing without the switch)', async () => {
    const r = await promote(NEG, CTX)
    expect(r.ok).toBe(true)
    expect(h.createKeywordLocal).toHaveBeenCalled()
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.output?.isolation).toMatchObject({ attempted: false, reason: expect.stringMatching(/keeps running in its source until the new keyword meets the harvest bar/) })
    const off = await promote(ACT, CTX)
    expect(off.output).not.toHaveProperty('isolation')
  })

  it('L2 — at home in another ad group of the product: not created again; once that home meets the bar, the source is negated', async () => {
    proven('giacca moto uomo', 1) // sold once: under the defaults' 2 orders
    const waiting = await promote(NEG, CTX)
    // The wire ticks PHRASE and EXACT: the EXACT is at home, so only the PHRASE is created.
    expect(h.createKeywordLocal.mock.calls.map(([a]) => a.matchType)).toEqual(['PHRASE'])
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(waiting.output?.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ adGroupId: 'dst1', matchType: 'EXACT', skipped: 'already-home', homeAdGroupId: 'dst1' })]))

    proven()
    const handover = await promote(NEG, CTX)
    expect(h.createKeywordLocal.mock.calls.map(([a]) => a.matchType)).toEqual(['PHRASE', 'PHRASE'])
    expect(h.writeNegativeKeyword).toHaveBeenCalledTimes(1)
    expect(h.writeNegativeKeyword.mock.calls[0][0]).toMatchObject({ scope: 'AD_GROUP', adGroupId: 'src1', keywordText: 'giacca moto uomo', matchType: 'EXACT', protectConverting: null })
    expect(handover.output?.isolation).toMatchObject({ attempted: true, adGroupId: 'src1', reachedAmazon: true })
  })

  it('nothing landed and no home → no negative', async () => {
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

  it('an ASIN whose product target elsewhere has proven itself gets a negative PRODUCT target in the source', async () => {
    proven('B0ABCD1234')
    const act = { ...NEG, harvest: { ...WIRE, blocks: [{ look: ['src1'], create: [{ adGroupId: 'dst1', types: ['ASIN'] }] }] } }
    const r = await promote(act, { ...CTX, searchTerm: { ...CTX.searchTerm, query: 'B0ABCD1234' } })
    expect(r.ok).toBe(true)
    expect(h.createTargetLocal).not.toHaveBeenCalled()
    expect(h.writeNegativeProductTarget).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'src1', asin: 'B0ABCD1234' }))
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
  })

  it('a refusal (a protected term, a keyword of the source) is named, not a failure; a negative that did not land is a failure', async () => {
    proven()
    h.writeNegativeKeyword.mockResolvedValue({ outcome: 'refused', mode: 'live', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: { deniedAt: 'own_keyword', reason: 'it would block your own exact keyword' }, error: null })
    const refused = await promote(NEG, CTX)
    expect(refused.ok).toBe(true)
    expect(String((refused.output?.isolation as { refused?: string }).refused)).toMatch(/^own_keyword: /)
    h.writeNegativeKeyword.mockResolvedValue({ outcome: 'failed', mode: 'live', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: null, error: 'Amazon returned no id' })
    const failed = await promote(NEG, CTX)
    expect(failed.ok).toBe(false)
    expect(failed.error).toMatch(/negative in the source ad group did not reach Amazon/)
  })

  it('the dry run says the source waits for a fresh landing, proposes the handover of a proven home, and writes nothing', async () => {
    const dry = (ACTION_HANDLERS.promote_to_exact as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, unknown> }>)
    const fresh = await dry(NEG, CTX, { ...meta, dryRun: true })
    expect(fresh.output?.isolation).toMatchObject({ wouldNegate: false, adGroupId: 'src1', reason: expect.stringMatching(/keeps running in its source/) })
    proven()
    const handover = await dry(NEG, CTX, { ...meta, dryRun: true })
    expect(handover.output?.isolation).toMatchObject({ wouldNegate: true, adGroupId: 'src1', matchType: 'NEGATIVE_EXACT', homeAdGroupId: 'dst1' })
    expect(handover.output?.outcomes).toEqual(expect.arrayContaining([expect.objectContaining({ adGroupId: 'src1', wouldCreate: true, handover: true })]))
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

/**
 * PB-6a — harvest_and_negate: the rule's half (`mode`), its bid, the card's items and the cadence. A made-up wizard rule
 * with its own numbers: one source (src1 = EXT-SRC, automatic), EXACT lands in dst1. Two search terms: a converting one
 * (3 orders, CPC 0.80) and a wasting one (0 orders, 20.00 spent).
 */
describe('PB-6a — harvest_and_negate keeps winners and runs only its own half', () => {
  const harvest = (action: Record<string, unknown>, m: Record<string, unknown> = meta) =>
    (ACTION_HANDLERS.harvest_and_negate as (a: unknown, c: unknown, m: unknown) => Promise<{ ok: boolean; output?: Record<string, any> }>)(action, {}, m)
  const RULE = {
    type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents: 1000, minOrders: 2,
    sources: [{ adGroupId: 'src1', campaignId: 'c1', harvestFrom: true, graduate: ['EXACT'], negate: ['EXACT'] }],
    destinations: { EXACT: 'dst1' },
  }
  const row = (query: string, orders: number, clicks: number, costMicros: bigint) =>
    ({ query, campaignId: 'EXT-C1', adGroupId: 'EXT-SRC', marketplace: 'IT', _sum: { impressions: 100, clicks, costMicros, orders7d: orders, sales7dCents: orders * 3000 } })

  /** The account's ad groups: the automatic source and the exact destination. */
  const GROUPS = [{ id: 'src1', externalAdGroupId: 'EXT-SRC', campaignId: 'c1', campaign: AUTO_SP }, { id: 'dst1', externalAdGroupId: 'EXT-DST', campaignId: 'c2', campaign: MANUAL_SP }]
  /** Search-term rows, read per ad group as the service asks for them. */
  let terms: ReturnType<typeof row>[] = []
  const termsInWindow = ((args: { where: { adGroupId?: { in: string[] } } }) => Promise.resolve(terms.filter((t) => !args.where.adGroupId || args.where.adGroupId.in.includes(t.adGroupId)))) as never
  beforeEach(() => {
    db.automationRule.findUnique.mockResolvedValue(null as never) // not drag-bound
    terms = [row('giacca moto uomo', 3, 10, 8_000_000n), row('giacca economica', 0, 25, 20_000_000n)]
    db.amazonAdsSearchTerm.groupBy.mockImplementation(termsInWindow)
    db.adGroup.findMany.mockImplementation(((args: { where: { id?: { in: string[] }; externalAdGroupId?: { in: string[] } } }) => Promise.resolve(
      args.where.id ? GROUPS.filter((g) => args.where.id!.in.includes(g.id))
        : args.where.externalAdGroupId ? GROUPS.filter((g) => args.where.externalAdGroupId!.in.includes(g.externalAdGroupId)) : [],
    )) as never)
  })

  it('mode "harvest" graduates only; mode "negative" negates only (each stored rule ran both halves before)', async () => {
    await harvest({ ...RULE, mode: 'harvest' })
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1)
    expect(h.createKeywordLocal.mock.calls[0][0]).toMatchObject({ adGroupId: 'dst1', keywordText: 'giacca moto uomo', matchType: 'EXACT' })
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled() // no waste negative, and the source keeps the new winner (handover: proven)

    vi.clearAllMocks()
    db.adTarget.findMany.mockResolvedValue([] as never)
    h.writeNegativeKeyword.mockResolvedValue({ outcome: 'created', mode: 'live', externalTargetId: 'neg-1', reachedAmazon: true, adTargetId: 'n1', refusal: null, error: null })
    const neg = await harvest({ ...RULE, mode: 'negative' })
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
    expect(h.writeNegativeKeyword).toHaveBeenCalledTimes(1)
    expect(h.writeNegativeKeyword.mock.calls[0][0]).toMatchObject({ keywordText: 'giacca economica', externalAdGroupId: 'EXT-SRC' })
    expect(neg.output).toMatchObject({ mode: 'negative', negativesAdded: 1, keywordsGraduated: 0 })
  })

  it('no graduationBidEur → the term\'s CPC; a rule that names one keeps it', async () => {
    await harvest({ ...RULE, mode: 'harvest' })
    expect(h.createKeywordLocal.mock.calls[0][0].bidEur).toBe(0.8)
    await harvest({ ...RULE, mode: 'harvest', graduationBidEur: 0.3 })
    expect(h.createKeywordLocal.mock.calls[1][0].bidEur).toBe(0.3)
  })

  it('a dry run lists its items and writes nothing; an accepted card applies only its items', async () => {
    const dry = await harvest(RULE, { ...meta, dryRun: true })
    expect(dry.output).toMatchObject({ dryRun: true, noChange: false, wouldGraduate: 1, wouldNegate: 1 })
    expect(dry.output?.items).toEqual([
      { kind: 'negative', query: 'giacca economica', externalAdGroupId: 'EXT-SRC', step: 'negate' },
      { kind: 'graduation', query: 'giacca moto uomo', externalAdGroupId: 'EXT-SRC', step: 'create' },
    ])
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()

    // The card (the proposal merges the output) with its graduation item only: the waste negative is not written.
    const accepted = await harvest({ ...RULE, ...dry.output, items: [dry.output!.items[1]] })
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1)
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(accepted.output).toMatchObject({ keywordsGraduated: 1, negativesAdded: 0 })

    // An item today's data no longer holds is left alone, and said.
    const gone = await harvest({ ...RULE, items: [{ kind: 'graduation', query: 'giacca vecchia', externalAdGroupId: 'EXT-SRC', step: 'create' }] })
    expect(gone.output).toMatchObject({ skipped: 'no-longer-due' })
    expect(h.createKeywordLocal).toHaveBeenCalledTimes(1)
  })

  it('a v2 rule\'s empty list is none: a source with graduate [] proposes no graduation', async () => {
    const dry = await harvest({ ...RULE, v: 2, sources: [{ ...RULE.sources[0], graduate: [] }] }, { ...meta, dryRun: true })
    expect(dry.output).toMatchObject({ wouldGraduate: 0, wouldNegate: 1 })
    const v1 = await harvest({ ...RULE, sources: [{ ...RULE.sources[0], graduate: [] }] }, { ...meta, dryRun: true })
    expect(v1.output).toMatchObject({ wouldGraduate: 1 })
  })

  it('cadenceDays: a sweep within the cadence holds the next one back; a held run does not count as a sweep', async () => {
    db.automationRuleExecution.findMany.mockResolvedValue([{ actionResults: [{ type: 'harvest_and_negate', ok: true, output: { wouldNegate: 1 } }] }] as never)
    const held = await harvest({ ...RULE, cadenceDays: 7 }, { ...meta, dryRun: true })
    expect(held.output).toMatchObject({ noChange: true, cadenceHeld: true })
    expect(db.amazonAdsSearchTerm.groupBy).not.toHaveBeenCalled()

    db.automationRuleExecution.findMany.mockResolvedValue([{ actionResults: [{ type: 'harvest_and_negate', ok: true, output: { noChange: true, cadenceHeld: true } }] }] as never)
    const swept = await harvest({ ...RULE, cadenceDays: 7 }, { ...meta, dryRun: true })
    expect(swept.output).toMatchObject({ noChange: false })
  })

  it('🔴 a Negative Targeting rule that names 0 orders still proposes its waste (the Single builder\'s and the wizard\'s stored shapes)', async () => {
    const source = { adGroupId: 'src1', campaignId: 'c1', harvestFrom: true, graduate: [], negate: ['EXACT'] }
    const single = { type: 'harvest_and_negate', control: 'manual', mode: 'negative', windowDays: 60, minSpendCents: 1000, minOrders: 0, sources: [source], destinations: {} }
    const wizardV1 = { type: 'harvest_and_negate', control: 'manual', windowDays: 60, minSpendCents: 1500, minOrders: 0, graduationBidEur: 0.5, sources: [source], destinations: { EXACT: 'dst1' }, mode: 'negative' }
    for (const action of [single, wizardV1, { ...wizardV1, v: 2 }]) {
      const dry = await harvest(action, { ...meta, dryRun: true })
      expect(dry.output, JSON.stringify(action)).toMatchObject({ noChange: false, wouldNegate: 1, wouldGraduate: 0 })
      expect(dry.output?.items).toEqual([{ kind: 'negative', query: 'giacca economica', externalAdGroupId: 'EXT-SRC', step: 'negate' }])
    }
  })

  it('a winner the rule cannot place is listed with its reason, so the card is never empty while it waits', async () => {
    const unrouted = { ...RULE, v: 2, mode: 'harvest', destinations: {}, sources: [{ ...RULE.sources[0], destinations: { EXACT: null } }] }
    const dry = await harvest(unrouted, { ...meta, dryRun: true })
    expect(dry.output).toMatchObject({ noChange: false, wouldGraduate: 0, wouldRefuse: 1, refused: 1 })
    expect(dry.output?.items).toEqual([expect.objectContaining({ kind: 'graduation', query: 'giacca moto uomo', step: 'refused', why: expect.stringMatching(/could not be told/) })])
    // Accepting it applies nothing, and says why.
    const accepted = await harvest({ ...unrouted, ...dry.output })
    expect(accepted.output).toMatchObject({ skipped: 'no-longer-due', notApplied: 1 })
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('a fixed bid with no amount is refused by name, never a silent CPC', async () => {
    const fixed = { ...RULE, mode: 'harvest', sources: [{ ...RULE.sources[0], bid: { mode: 'fixed' } }] }
    const dry = await harvest(fixed, { ...meta, dryRun: true })
    expect(dry.output?.items).toEqual([expect.objectContaining({ kind: 'graduation', step: 'refused', why: expect.stringMatching(/fixed-bid mode with no bid amount/) })])
    await harvest(fixed)
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
  })

  it('an accepted card re-checks each item\'s step: a create that would now be a source negation is not applied', async () => {
    const dry = await harvest({ ...RULE, mode: 'harvest' }, { ...meta, dryRun: true })
    expect(dry.output?.items).toEqual([{ kind: 'graduation', query: 'giacca moto uomo', externalAdGroupId: 'EXT-SRC', step: 'create' }])
    // Since the card: the term became an exact keyword in dst1, and it sold 3 times there (it meets the bar).
    db.adTarget.findMany.mockImplementation(((args: { where: { isNegative: boolean; adGroupId: { in: string[] } } }) => Promise.resolve(
      !args.where.isNegative && args.where.adGroupId.in.includes('dst1')
        ? [{ id: 'home1', adGroupId: 'dst1', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'giacca moto uomo', status: 'ENABLED', externalTargetId: 'x-home' }] : [],
    )) as never)
    terms = [...terms, { ...row('giacca moto uomo', 3, 10, 5_000_000n), adGroupId: 'EXT-DST' }]
    const accepted = await harvest({ ...RULE, mode: 'harvest', ...dry.output })
    expect(h.createKeywordLocal).not.toHaveBeenCalled()
    expect(h.writeNegativeKeyword).not.toHaveBeenCalled()
    expect(accepted.output).toMatchObject({ skipped: 'no-longer-due', notApplied: 1 })
    expect(accepted.output?.topNotApplied[0].why).toMatch(/proposed to create its keyword; on today's data the rule would negate it in its source/)
    // A fresh run proposes the handover as its own card.
    const next = await harvest({ ...RULE, mode: 'harvest' }, { ...meta, dryRun: true })
    expect(next.output?.items).toEqual([{ kind: 'graduation', query: 'giacca moto uomo', externalAdGroupId: 'EXT-SRC', step: 'handover' }])
  })
})
