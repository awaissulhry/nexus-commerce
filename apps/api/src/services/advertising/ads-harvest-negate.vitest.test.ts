/**
 * HV.8a — the negation half of `applyHarvest`, and the reporting defect it closes.
 *
 * Two facts this locks, both measured on prod 2026-08-13 before the change:
 *
 *   AD_GROUP-scoped negatives   2,037 rows / 2,017 at Amazon (99%)
 *   CAMPAIGN-scoped negatives      20 rows /     0 at Amazon (0%)
 *
 * All 20 carry a `create_negative_keyword` audit row from `automation:auto-harvest`, with
 * `lastSyncStatus` and `lastSyncError` both NULL — the signature of a write-gate denial the old
 * code did not throw on, so the local mirror was written anyway. Every one predates NEG.0(b).
 *
 * 🔴 The defect under repair: `result.negativesAdded++` ran once per candidate the loop reached,
 * discarding the return value entirely. That is `neg=8/8` on 72 nightly runs against zero rows that
 * ever reached Amazon. The counter must now advance ONLY for rows Amazon confirmed — and a write
 * that did not land must report as `refused`/`failed`, never as created.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

// 5b — applyHarvest negates through the one negative write service (`writeNegativeKeyword`), which pushes, reads back a
// missing id (HV.9a) and records the row. Its result is what this file feeds in; the service's own read-back and
// recording are pinned in negative-write-paths.vitest.test.ts.
const writeNegativeKeyword = vi.fn()
const writeNegativeProductTarget = vi.fn()
const createKeywordLocal = vi.fn()
const createTargetLocal = vi.fn()
const checkProtectConverting = vi.fn(async () => new Map())
const findAdGroup = vi.fn(async () => ({ id: 'ag1', campaign: { targetingType: 'AUTO', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' } }) as unknown)
const createNegativeKeywordCampaignLocal = vi.fn(async () => ({ id: 'local-1', created: true }))
const mirrorNegativeKeywordLocal = vi.fn(async () => ({ id: 'mirror-1', created: true }))

vi.mock('./ads-negative-kw.service.js', () => ({
  writeNegativeKeyword: (...a: unknown[]) => writeNegativeKeyword(...a),
  writeNegativeProductTarget: (...a: unknown[]) => writeNegativeProductTarget(...a),
}))
vi.mock('./ads-create.service.js', () => ({
  createNegativeKeywordCampaignLocal: (...a: unknown[]) => createNegativeKeywordCampaignLocal(...a),
  createKeywordLocal: (...a: unknown[]) => createKeywordLocal(...a),
  createTargetLocal: (...a: unknown[]) => createTargetLocal(...a),
  mirrorNegativeKeywordLocal: (...a: unknown[]) => mirrorNegativeKeywordLocal(...a),
}))
vi.mock('./ads-protect-converting.js', () => ({
  checkProtectConverting: (...a: unknown[]) => checkProtectConverting(...(a as [])),
  protectConvertingConfig: vi.fn(() => ({})),
  normaliseNegTerm: (s: string) => s.trim().toLowerCase(),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findFirst: vi.fn(async () => ({ id: 'c1', marketplace: 'IT' })) },
    adGroup: { findFirst: (...a: unknown[]) => findAdGroup(...(a as [])) },
    amazonAdsConnection: { findFirst: vi.fn(async () => ({ profileId: 'p-123' })) },
    amazonAdsSearchTerm: { groupBy: vi.fn(async () => []) },
    adTarget: { findFirst: vi.fn(async () => null) },
  },
}))

const { applyHarvest } = await import('./ads-harvest.service.js')

const candidate = {
  query: 'giacca moto',
  externalCampaignId: 'EC1',
  externalAdGroupId: 'EAG1',
  costCents: 1795,
  clicks: 30,
  orders: 0,
} as never

/** What writeNegativeKeyword answers. */
const result = (over: Record<string, unknown>) => ({
  outcome: 'created', mode: 'live', externalTargetId: null, reachedAmazon: false, adTargetId: null, refusal: null, error: null, rawResponse: null, ...over,
})
const NO_ID = 'Amazon returned no id and a read-back did not find it, so this term is NOT negated at Amazon. Nothing was recorded here; retrying is safe.'

beforeEach(() => {
  writeNegativeKeyword.mockReset()
  writeNegativeProductTarget.mockReset()
  createKeywordLocal.mockReset()
  createTargetLocal.mockReset()
  checkProtectConverting.mockReset()
  checkProtectConverting.mockResolvedValue(new Map())
  mirrorNegativeKeywordLocal.mockClear()
  createNegativeKeywordCampaignLocal.mockClear()
})

describe('HV.8a — the wasteful negation reports what actually landed', () => {
  it('counts a negative Amazon confirmed', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-99', reachedAmazon: true, adTargetId: 'row-1' }))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(1)
    expect(r.negativeOutcomes).toHaveLength(1)
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: true, outcome: 'acted', externalTargetId: 'AMZ-99' })
  })

  it('🔴 does NOT count a negative that returned no Amazon id — the neg=8/8 defect', async () => {
    // This is exactly what every one of the 20 campaign-scoped rows looked like: a local row existed, and nothing was
    // negated at Amazon. The old code reported this as "+1 negative"; the service now records no row for it at all.
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'failed', error: NO_ID }))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: false, outcome: 'failed' })
    expect(r.negativeOutcomes[0].reason).toMatch(/NOT negated at Amazon/)
    expect(r.negativeOutcomes[0].reason).toMatch(/read-back did not find it/)
  })

  it('reports a gate refusal as refused, not failed and not created (C7)', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'refused', refusal: { deniedAt: 'keyword_protected', reason: 'term is whitelisted' } }))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0].outcome).toBe('refused')
    expect(r.negativeOutcomes[0].refusal).toMatchObject({ deniedAt: 'keyword_protected' })
  })

  it('5b — a campaign-scope refusal is refused too (it used to be thrown and reported as failed)', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'refused', refusal: { deniedAt: 'campaign_allowlist', reason: 'not on the live-write allowlist' } }))
    const r = await applyHarvest({ negatives: [candidate], negateScope: 'CAMPAIGN' })
    expect(r.negativeOutcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'campaign_allowlist' } })
    expect(r.errors).toEqual([])
  })
})

describe('HV.8a — the default scope moved to AD_GROUP', () => {
  it('negates at AD_GROUP when no scope is passed', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-1', reachedAmazon: true }))
    await applyHarvest({ negatives: [candidate] })
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ scope: 'AD_GROUP', externalCampaignId: 'EC1', externalAdGroupId: 'EAG1', keywordText: 'giacca moto', matchType: 'EXACT' }))
  })

  it('still honours an explicit CAMPAIGN scope', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-2', reachedAmazon: true }))
    await applyHarvest({ negatives: [candidate], negateScope: 'CAMPAIGN' })
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ scope: 'CAMPAIGN', externalCampaignId: 'EC1' }))
    expect(writeNegativeKeyword.mock.calls[0]![0]).not.toHaveProperty('externalAdGroupId')
  })

  it('names a negative-broad plan instead of sending it', async () => {
    const r = await applyHarvest({ negatives: [candidate], plan: { EAG1: { negate: ['BROAD'] } } })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.negativeOutcomes[0].outcome).toBe('failed')
    expect(r.errors[0]).toMatch(/Amazon SP accepts EXACT and PHRASE only/)
  })
})

/**
 * 🔴 HV.9a / 5b — the read-back and the local row belong to the service now. applyHarvest records nothing itself: no
 * mirror helper is called, so a refused or failed negative cannot leave a row behind here.
 */
describe('HV.9a — the row is the service\'s, written only for a negative that stands', () => {
  it('reports the id the service read back, and calls no mirror helper itself', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: '48498817150724', reachedAmazon: true, adTargetId: 'row-9' }))
    const r = await applyHarvest({ negatives: [candidate], userId: 'u-1' })
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: true, outcome: 'acted', externalTargetId: '48498817150724' })
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u-1' }))
    expect(mirrorNegativeKeywordLocal).not.toHaveBeenCalled()
    expect(createNegativeKeywordCampaignLocal).not.toHaveBeenCalled()
  })

  it('does not mirror when the gate refused — nothing was created', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'refused', refusal: { deniedAt: 'keyword_protected', reason: 'whitelisted' } }))
    await applyHarvest({ negatives: [candidate], negateScope: 'CAMPAIGN' })
    expect(mirrorNegativeKeywordLocal).not.toHaveBeenCalled()
    expect(createNegativeKeywordCampaignLocal).not.toHaveBeenCalled()
  })
})

/** 5d (review 7.5) — an ASIN in the keyword lists is a product: negated as a product target, graduated as one. */
describe('5d — the harvest apply path treats an ASIN as a product', () => {
  const asinCandidate = { ...(candidate as object), query: 'B0ABCD1234' } as never

  it('a wasteful ASIN gets a negative product target in its ad group, not a negative keyword', async () => {
    writeNegativeProductTarget.mockResolvedValue(result({ externalTargetId: 'AMZ-P1', reachedAmazon: true }))
    const r = await applyHarvest({ negatives: [asinCandidate] })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(writeNegativeProductTarget).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'ag1', asin: 'B0ABCD1234' }))
    expect(r.negativeOutcomes[0]).toMatchObject({ outcome: 'acted', matchTypes: ['PRODUCT'] })
  })

  it('at campaign scope it is refused by name and nothing is written', async () => {
    const r = await applyHarvest({ negatives: [asinCandidate], negateScope: 'CAMPAIGN' })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(writeNegativeProductTarget).not.toHaveBeenCalled()
    expect(r.negativeOutcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'asin_campaign_level' } })
  })

  it('a converting ASIN graduates as a PRODUCT target in the PRODUCT destination', async () => {
    createTargetLocal.mockResolvedValue({ id: 'pt1', externalTargetId: 'AMZ-PT', mode: 'live' })
    const r = await applyHarvest({ graduations: [{ ...(asinCandidate as object), orders: 3 } as never], destinations: { PRODUCT: 'dst-pat' } })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(createTargetLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-pat', kind: 'PRODUCT', value: 'B0ABCD1234' }))
    expect(r.productsGraduated).toBe(1)
    expect(r.keywordsGraduated).toBe(0)
  })
})

/** 5d (review 7.4) — the source ad group is a fallback destination only when it can take the target. */
describe('5d — no destination and an automatic source: refused, nothing created', () => {
  it('names the refusal on the outcome and creates nothing; a manual Sponsored Products source still takes it', async () => {
    const r = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination' } })
    expect(r.keywordsGraduated).toBe(0)
    expect(r.errors[0]).toMatch(/not in a manual Sponsored Products campaign/)

    findAdGroup.mockResolvedValueOnce({ id: 'ag1', campaign: { targetingType: 'MANUAL', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' } })
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    const manual = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'ag1' }))
    expect(writeNegativeKeyword).not.toHaveBeenCalled() // it landed in its own source: a negative there would cancel it
    expect(manual.outcomes[0].outcome).toBe('acted')
  })
})

/**
 * 5d (review 7.3, Owner decision D4) — the H.3 isolation negative fires only after the keyword LANDED in a different
 * ad group, and then it skips the converting guard (which refused every one: a graduated term converted by definition).
 */
describe('5d — the isolation negative follows a landing elsewhere', () => {
  const grad = { ...(candidate as object), orders: 3 } as never

  it('landed in the destination → negated in the source, although the term converted', async () => {
    checkProtectConverting.mockResolvedValue(new Map([['giacca moto', { allowed: false, reason: 'converted 3× in 30 days' }]]) as never)
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-N1', reachedAmazon: true }))
    const r = await applyHarvest({ graduations: [grad], destinations: { EXACT: 'dst-exact' } })
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ scope: 'AD_GROUP', externalAdGroupId: 'EAG1', keywordText: 'giacca moto', matchType: 'EXACT' }))
    expect(r.isolationNegativesAdded).toBe(1)
    expect(r.negativesProtected).toBe(0)
    expect(r.outcomes[0].negative).toMatchObject({ attempted: true, reachedAmazon: true })
  })

  it('the keyword did not reach Amazon → no negative in the source', async () => {
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: null, denied: { deniedAt: 'campaign_allowlist', reason: 'not allowlisted' } })
    const r = await applyHarvest({ graduations: [grad], destinations: { EXACT: 'dst-exact' } })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.outcomes[0].negative).toBeNull()
    expect(r.outcomes[0].negateReason).toMatch(/nothing reached Amazon/)
  })

  it('a product target that did not land leaves the source un-negated too', async () => {
    createTargetLocal.mockResolvedValue({ id: 'pt1', externalTargetId: null, mode: 'local' })
    await applyHarvest({ productGraduations: [{ ...(candidate as object), query: 'B0ABCD1234', orders: 3 } as never], plan: { EAG1: { graduateProduct: true } }, destinations: { PRODUCT: 'dst-pat' } })
    expect(createTargetLocal).toHaveBeenCalled()
    expect(writeNegativeProductTarget).not.toHaveBeenCalled()
  })
})
