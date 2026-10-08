/**
 * ONE BRAIN AB-6 — a playbook's own writers leave a lever a product's brain owns (or the Owner holds), exactly where the
 * write gate would refuse their writer: a request the business's rule ran; a person's approval passes.
 *   sync    a negative (negatives), a keyword (harvest) or a product ad (structure) on a held campaign is left alone,
 *           said item by item, counted in `leverHeld`; the rest as before
 *   build   new campaigns of a product whose structure its brain owns, or the Owner locked, are not started (product-wide)
 *   today   nothing enrolled: every item and every build as before
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DriftItem } from './drift.js'

const h = vi.hoisted(() => ({
  writeNegative: vi.fn(), createKeyword: vi.fn(), createProductAd: vi.fn(), createTarget: vi.fn(), record: vi.fn(), transaction: vi.fn(),
  campaignLeverOwners: vi.fn(), anyBrainEnrolled: vi.fn(), brainSettings: vi.fn(),
}))
vi.mock('../../../db.js', () => ({
  default: {
    adProductAd: { findMany: vi.fn(async () => []) },
    adsPlaybookLink: { findMany: vi.fn(async (args: { where: { refId?: { in: string[] } } }) => (args.where.refId?.in ?? []).map((refId) => ({ refId, playbookId: 'pb-1' }))) },
    adsPlaybook: { findUnique: vi.fn(async () => ({ state: 'RUNNING' })) },
    adBlueprintApplication: { findMany: vi.fn(async () => []), updateMany: vi.fn(async () => ({ count: 0 })) },
    $transaction: h.transaction,
  },
}))
vi.mock('../ads-winner-lock.js', () => ({ familyOfProducts: vi.fn(async () => ({})), familyOnly: vi.fn(async () => ({ excluded: [] })) }))
vi.mock('./load.js', async (importOriginal) => ({ ...(await importOriginal<object>()), waitingSyncedTargets: vi.fn(async () => new Set()) }))
vi.mock('./write.js', () => ({ recordPlaybookApply: h.record }))
vi.mock('../ads-negative-kw.service.js', () => ({ writeNegativeKeyword: h.writeNegative }))
vi.mock('../ads-create.service.js', () => ({ createKeywordLocal: h.createKeyword, createProductAdLocal: h.createProductAd, createTargetLocal: h.createTarget }))
vi.mock('../brain/lever-owners.js', () => ({
  campaignLeverOwners: (...a: unknown[]) => h.campaignLeverOwners(...a),
  anyBrainEnrolled: (...a: unknown[]) => h.anyBrainEnrolled(...a),
}))
vi.mock('../brain/enrollment.js', () => ({ brainSettings: (...a: unknown[]) => h.brainSettings(...a) }))

const { runSync } = await import('./sync.js')
const { startPlaybookBuild } = await import('./build.js')

const item = (key: string, kind: string, campaignId: string, extra: Partial<DriftItem> = {}): DriftItem =>
  ({ key, kind, slot: 'exact', says: key, fix: 'sync', campaignId, adGroupId: `g-${campaignId}`, ...extra } as DriftItem)
const NEG = item('neg-gale', 'negative', 'c-gale', { term: 'cheap', match: 'EXACT', negative: { of: 'isolation' } })
const KW = item('kw-gale', 'positive', 'c-gale', { term: 'gale jacket', match: 'EXACT', targetKind: 'KEYWORD', startBidCents: 40 })
const KW2 = item('kw-other', 'positive', 'c-gale-2', { term: 'gale coat', match: 'EXACT', targetKind: 'KEYWORD', startBidCents: 40 })
const AD = item('ad-gale', 'productAd', 'c-gale', { asin: 'B0TESTGALE', sku: 'GALE-M' })
const PLAN = {
  drift: { market: 'IT', playbook: { id: 'pb-1', scopeId: 'gale', state: 'RUNNING', version: 3 }, template: null },
  parts: { negatives: [NEG], positives: [KW, KW2], productAds: [AD], artifacts: [], slots: [] },
  build: null,
} as never
const WRITER = { actor: 'user:approver' as never, requester: 'user:asker' as never, changeSetId: 'ap-1', writer: { updatedBy: 'user:approver' } as never, manual: false, confirmOwnLimits: false }
const OWNED = { kind: 'owned', productId: 'gale', market: 'IT', why: 'AUTO by the Owner\'s product override' }

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  h.anyBrainEnrolled.mockResolvedValue(true)
  h.campaignLeverOwners.mockResolvedValue(new Map())
  h.writeNegative.mockResolvedValue({ outcome: 'created', reachedAmazon: true, adTargetId: 'n1' })
  h.createKeyword.mockResolvedValue({ id: 'k1', externalTargetId: 'EXT-k1' })
  h.createProductAd.mockResolvedValue({ id: 'a1', externalAdId: 'EXT-a1' })
  h.record.mockResolvedValue({ version: 4 })
})
afterEach(() => vi.unstubAllEnvs())

describe('runSync — a sync the business\'s rule ran', () => {
  it('each item on a held lever is left alone, said; the rest written; counted per lever', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE exact', market: 'IT', levers: { negatives: OWNED, harvest: OWNED, structure: OWNED } }]]))
    const res = await runSync(PLAN, WRITER)
    expect(h.writeNegative).not.toHaveBeenCalled()
    expect(h.createKeyword).toHaveBeenCalledTimes(1)
    expect(h.createKeyword.mock.calls[0][0]).toMatchObject({ adGroupId: 'g-c-gale-2' })
    expect(h.createProductAd).not.toHaveBeenCalled()
    expect(res.negatives.leftAlone).toEqual([{ key: 'neg-gale', why: 'Not written: a product\'s brain runs the negatives of campaign "GALE exact" (c-gale) — product gale in IT (one owner per lever).' }])
    expect(res.positives.leftAlone.map((o) => o.key)).toEqual(['kw-gale'])
    expect(res.productAds.leftAlone.map((o) => o.key)).toEqual(['ad-gale'])
    expect(res.leverHeld).toEqual({ productBrain: { negatives: 1, harvest: 1, structure: 1 } })
  })

  it('a person approved it: everything written, as at the gate', async () => {
    h.campaignLeverOwners.mockResolvedValue(new Map([['c-gale', { campaignId: 'c-gale', name: 'GALE exact', market: 'IT', levers: { negatives: OWNED, harvest: OWNED, structure: OWNED } }]]))
    const res = await runSync(PLAN, { ...WRITER, manual: true })
    expect(h.writeNegative).toHaveBeenCalledTimes(1)
    expect(h.createKeyword).toHaveBeenCalledTimes(2)
    expect(h.createProductAd).toHaveBeenCalledTimes(1)
    expect(res).not.toHaveProperty('leverHeld')
  })

  it('nothing enrolled (production today): everything written as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    const res = await runSync(PLAN, WRITER)
    expect(h.writeNegative).toHaveBeenCalledTimes(1)
    expect(h.createKeyword).toHaveBeenCalledTimes(2)
    expect(h.createProductAd).toHaveBeenCalledTimes(1)
    expect(res).not.toHaveProperty('leverHeld')
  })
})

describe('startPlaybookBuild — new campaigns are the product\'s structure lever', () => {
  const BUILD = { playbook: { id: 'pb-1', version: 3 }, applyPlan: {}, doc: {}, nameToken: 'GALE', market: 'IT', product: { productId: 'gale-m', sku: 'GALE-M' }, campaigns: [], productAds: [], template: null, portfolio: null } as never
  const start = (manual?: boolean) => startPlaybookBuild({ plan: BUILD, actor: 'user:approver' as never, requester: 'user:asker' as never, changeSetId: 'ap-1', writer: {} as never, ...(manual !== undefined ? { manual } : {}) })

  it('the Owner locked the product\'s structure: a build by rule is not started, and says why', async () => {
    h.brainSettings.mockResolvedValue({ productId: 'gale', market: 'IT', levers: { structure: { owned: false, effective: 'LOCKED', why: 'locked at the Owner\'s own value by the Owner\'s product override' } } })
    const r = await start(false)
    expect(r).toEqual({ refusal: expect.stringContaining('not built: the Owner holds the structure (new ad groups and product ads) of product gale in IT at his own value'), brainLever: 'structure', brainHolder: 'ownerLock' })
    expect(h.brainSettings).toHaveBeenCalledWith('gale-m', 'IT')
    expect(h.transaction).not.toHaveBeenCalled()
  })

  it('a person\'s approval goes past the check (nothing read), as at the gate', async () => {
    h.transaction.mockRejectedValue(new Error('claimed'))
    await expect(start(true)).rejects.toThrow('claimed')
    expect(h.brainSettings).not.toHaveBeenCalled()
  })

  it('nothing enrolled: the build goes on as before', async () => {
    h.anyBrainEnrolled.mockResolvedValue(false)
    h.transaction.mockRejectedValue(new Error('claimed'))
    await expect(start()).rejects.toThrow('claimed')
    expect(h.brainSettings).not.toHaveBeenCalled()
  })
})
