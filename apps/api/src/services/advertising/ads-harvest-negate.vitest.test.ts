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

const createNegative = vi.fn()
const createNegativeKeywordCampaignLocal = vi.fn(async () => ({ id: 'local-1', created: true }))
const createNegativeKeywordLocal = vi.fn(async () => ({ id: 'local-2', created: true }))
const mirrorNegativeKeywordLocal = vi.fn(async () => ({ id: 'mirror-1', created: true }))
const listNegativeKeywords = vi.fn(async () => [] as unknown[])

vi.mock('./ads-negative-kw.service.js', () => ({ createNegative: (...a: unknown[]) => createNegative(...a) }))
vi.mock('./ads-create.service.js', () => ({
  createNegativeKeywordCampaignLocal: (...a: unknown[]) => createNegativeKeywordCampaignLocal(...a),
  createNegativeKeywordLocal: (...a: unknown[]) => createNegativeKeywordLocal(...a),
  createKeywordLocal: vi.fn(),
  createProductTargetLocal: vi.fn(),
  mirrorNegativeKeywordLocal: (...a: unknown[]) => mirrorNegativeKeywordLocal(...a),
}))
vi.mock('./ads-api-client.js', () => ({ listNegativeKeywords: (...a: unknown[]) => listNegativeKeywords(...a) }))
vi.mock('./ads-protect-converting.js', () => ({
  checkProtectConverting: vi.fn(async () => new Map()),
  protectConvertingConfig: vi.fn(() => ({})),
  normaliseNegTerm: (s: string) => s.trim().toLowerCase(),
}))
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findFirst: vi.fn(async () => ({ id: 'c1', marketplace: 'IT' })) },
    adGroup: { findFirst: vi.fn(async () => ({ id: 'ag1' })) },
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

beforeEach(() => {
  mirrorNegativeKeywordLocal.mockClear()
  listNegativeKeywords.mockReset(); listNegativeKeywords.mockResolvedValue([])
  createNegative.mockReset()
  createNegativeKeywordCampaignLocal.mockClear()
  createNegativeKeywordLocal.mockClear()
})

describe('HV.8a — the wasteful negation reports what actually landed', () => {
  it('counts a negative Amazon confirmed', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: 'AMZ-99', denied: null, alreadyExisted: false })
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(1)
    expect(r.negativeOutcomes).toHaveLength(1)
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: true, outcome: 'acted', externalTargetId: 'AMZ-99' })
  })

  it('🔴 does NOT count a negative that returned no Amazon id — the neg=8/8 defect', async () => {
    // This is exactly what every one of the 20 campaign-scoped rows looks like: a local row exists,
    // and nothing is negated at Amazon. The old code reported this as "+1 negative".
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: null, denied: null, alreadyExisted: false })
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: false, outcome: 'failed' })
    expect(r.negativeOutcomes[0].reason).toMatch(/NOT negated at Amazon/)
  })

  it('reports a gate refusal as refused, not failed and not created (C7)', async () => {
    createNegative.mockResolvedValue({ ok: false, externalNegativeKeywordId: null, denied: { deniedAt: 'keyword_protected', reason: 'term is whitelisted' }, alreadyExisted: false })
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0].outcome).toBe('refused')
    expect(r.negativeOutcomes[0].refusal).toMatchObject({ deniedAt: 'keyword_protected' })
  })
})

describe('HV.8a — the default scope moved to AD_GROUP', () => {
  it('negates at AD_GROUP when no scope is passed', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: 'AMZ-1', denied: null, alreadyExisted: false })
    await applyHarvest({ negatives: [candidate] })
    expect(createNegative).toHaveBeenCalledWith(expect.objectContaining({ scope: 'AD_GROUP', externalAdGroupId: 'EAG1' }))
  })

  it('still honours an explicit CAMPAIGN scope', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: 'AMZ-2', denied: null, alreadyExisted: false })
    await applyHarvest({ negatives: [candidate], negateScope: 'CAMPAIGN' })
    expect(createNegative).toHaveBeenCalledWith(expect.objectContaining({ scope: 'CAMPAIGN' }))
  })

  it('🔴 refuses rather than calling Amazon with an empty profileId', async () => {
    const db = (await import('../../db.js')).default as unknown as { amazonAdsConnection: { findFirst: ReturnType<typeof vi.fn> } }
    db.amazonAdsConnection.findFirst.mockResolvedValueOnce(null)
    const r = await applyHarvest({ negatives: [candidate] })
    expect(createNegative).not.toHaveBeenCalled()
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0].outcome).toBe('failed')
    expect(r.errors[0]).toMatch(/empty profileId/)
  })
})

/**
 * 🔴 HV.9a — found by the proof writes, not by any test.
 *
 * Amazon can CREATE the negative and return no keywordId. Measured 2026-08-13: createNegative
 * logged `success … externalId: null` for "veste moto homme homologué", we reported
 * `outcome: failed / reachedAmazon: false`, and the negative is ENABLED at Amazon as
 * id 48498817150724. A false failure is not the safe direction — an operator who believes it
 * failed retries, and the retry is a duplicate.
 */
describe('HV.9a — a null id does not mean Amazon did not create it', () => {
  it('🔴 recovers the id by reading back, and reports acted', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: null, denied: null, alreadyExisted: false })
    listNegativeKeywords.mockResolvedValue([
      { keywordId: '48498817150724', keywordText: 'giacca moto', adGroupId: 'EAG1', matchType: 'NEGATIVE_EXACT' },
    ])
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: true, outcome: 'acted', externalTargetId: '48498817150724' })
    expect(r.negativesAdded).toBe(1)
  })

  it('still reports failed when the read-back genuinely does not find it', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: null, denied: null, alreadyExisted: false })
    listNegativeKeywords.mockResolvedValue([])
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativeOutcomes[0]).toMatchObject({ reachedAmazon: false, outcome: 'failed' })
    expect(r.negativeOutcomes[0].reason).toMatch(/read-back did not find it/)
    expect(r.negativeOutcomes[0].reason).not.toMatch(/Written locally/)
  })

  it('does not throw when the read-back itself fails', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: null, denied: null, alreadyExisted: false })
    listNegativeKeywords.mockRejectedValue(new Error('429 from Amazon'))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativeOutcomes[0].outcome).toBe('failed')
  })
})

/**
 * 🔴 HV.9a — `negateCampaign` always mirrored locally; `negateAdGroup` never did. Both proof
 * writes landed at Amazon and left no row here, which is the 209-row defect pointing the other way.
 */
describe('HV.9a — an ad-group negative is mirrored locally', () => {
  it('writes a local mirror carrying the Amazon id', async () => {
    createNegative.mockResolvedValue({ ok: true, externalNegativeKeywordId: 'AMZ-7', denied: null, alreadyExisted: false })
    await applyHarvest({ negatives: [candidate] })
    expect(mirrorNegativeKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({
      keywordText: 'giacca moto', matchType: 'NEGATIVE_EXACT', externalTargetId: 'AMZ-7',
    }))
  })

  it('does not mirror when the gate refused — nothing was created', async () => {
    createNegative.mockResolvedValue({ ok: false, externalNegativeKeywordId: null, denied: { deniedAt: 'keyword_protected', reason: 'whitelisted' }, alreadyExisted: false })
    await applyHarvest({ negatives: [candidate] })
    expect(mirrorNegativeKeywordLocal).not.toHaveBeenCalled()
  })
})
