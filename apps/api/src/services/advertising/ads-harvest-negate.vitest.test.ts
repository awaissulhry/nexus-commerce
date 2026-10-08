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
const findAdGroup = vi.fn(async () => ({ id: 'ag1', campaign: { targetingType: 'AUTO', adProduct: 'SPONSORED_PRODUCTS', type: 'SP', marketplace: 'IT' } }) as unknown)
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
// AB-11 — a graduation with no destination named gets the harvest destination the Keyword Harvest page's resolver gives.
let resolved: { chosen: { adGroupId: string } | null; source: string; shortlist: unknown[] } = { chosen: null, source: 'none', shortlist: [] }
let storedDest = new Map<string, { adGroupId: string; negateAtSource: boolean }>()
vi.mock('./harvest-destination.service.js', async (importOriginal) => ({
  loadDestinationGraph: vi.fn(async () => ({ adGroups: new Map(), productsOfAdGroup: new Map(), holdersOfTerm: new Map() })),
  resolveStoredDestinations: vi.fn(async () => storedDest),
  resolveDestination: vi.fn(() => resolved),
  sourceLines: vi.fn(async (ids: string[]) => new Map(ids.map((id) => [id, null]))),
  // Batch 2 re-review fix — the real rule: a stored destination gone or in another market refuses by name.
  storedDestinationRefusal: (await importOriginal<typeof import('./harvest-destination.service.js')>()).storedDestinationRefusal,
}))
// PB-6a — the lock reads the batch's source ad groups (by Amazon's id) and the positives near them once.
const findTargets = vi.fn(async (..._a: unknown[]) => [] as unknown[])
const searchTerms = vi.fn(async (..._a: unknown[]) => [] as unknown[])
const findAdGroups = vi.fn(async (args: { where?: Record<string, unknown> }) => {
  if (args?.where?.id) return homeGroups
  if (args?.where?.productAds) return familyGroups // PB-6a — the ad groups of the product's family
  const r = await findAdGroup()
  return r ? [{ externalAdGroupId: 'EAG1', ...(r as object) }] : []
})
let homeGroups: unknown[] = []
let familyGroups: unknown[] = []
// PB-6a — the product family: the source's product ads, and the products they name.
const findProductAds = vi.fn(async (..._a: unknown[]) => [] as unknown[])
const findProducts = vi.fn(async (..._a: unknown[]) => [] as unknown[])
vi.mock('../../db.js', () => ({
  default: {
    campaign: { findFirst: vi.fn(async () => ({ id: 'c1', marketplace: 'IT' })) },
    adGroup: { findFirst: (...a: unknown[]) => findAdGroup(...(a as [])), findMany: (a: never) => findAdGroups(a), findUnique: vi.fn(async () => ({ defaultBidCents: 40, campaign: { marketplace: 'IT' } })) },
    amazonAdsConnection: { findFirst: vi.fn(async () => ({ profileId: 'p-123' })) },
    amazonAdsSearchTerm: { groupBy: (...a: unknown[]) => searchTerms(...a) },
    adTarget: { findFirst: vi.fn(async () => null), findMany: (...a: unknown[]) => findTargets(...a) },
    adsStrategy: { findFirst: vi.fn(async () => null), findMany: vi.fn(async () => []) },
    adProductAd: { findMany: (...a: unknown[]) => findProductAds(...a) },
    product: { findMany: (...a: unknown[]) => findProducts(...a) },
  },
}))

const { applyHarvest, planList, planRuleHarvest, previewHarvest } = await import('./ads-harvest.service.js')

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
  resolved = { chosen: null, source: 'none', shortlist: [] }
  storedDest = new Map()
  writeNegativeKeyword.mockReset()
  writeNegativeProductTarget.mockReset()
  createKeywordLocal.mockReset()
  createTargetLocal.mockReset()
  checkProtectConverting.mockReset()
  checkProtectConverting.mockResolvedValue(new Map())
  mirrorNegativeKeywordLocal.mockClear()
  createNegativeKeywordCampaignLocal.mockClear()
  findTargets.mockReset()
  findTargets.mockResolvedValue([])
  searchTerms.mockReset()
  searchTerms.mockResolvedValue([])
  homeGroups = []
  familyGroups = []
  findProductAds.mockReset()
  findProductAds.mockResolvedValue([])
  findProducts.mockReset()
  findProducts.mockResolvedValue([])
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

/**
 * 5d (review 7.4) and ONE BRAIN AB-11 — "a harvest with no destination never negates its source", fixed: with no
 * destination named, the harvest destination is resolved (stored for the source's scope, else the resolver's only one);
 * when none resolves nothing is created — never back into the ad group that found it, whatever its campaign.
 */
describe('5d / AB-11 — no destination named: resolved, or refused; never back into the source', () => {
  it('none resolves: refused by name, nothing created — an automatic source and a manual one alike', async () => {
    resolved = { chosen: null, source: 'none', shortlist: [] }
    const r = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination' } })
    expect(r.keywordsGraduated).toBe(0)
    expect(r.errors[0]).toMatch(/never back into the ad group that found it/)

    findAdGroup.mockResolvedValueOnce({ id: 'ag1', campaign: { targetingType: 'MANUAL', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' } })
    resolved = { chosen: null, source: 'resolved-ambiguous', shortlist: [{}, {}, {}] }
    const manual = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(manual.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/3 ad groups of this product could take it/) } })
  })

  it('one resolves elsewhere: the keyword lands there and the source is negated (the defect closed)', async () => {
    resolved = { chosen: { adGroupId: 'dst-exact' }, source: 'resolved-unique', shortlist: [{}] }
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-N1', reachedAmazon: true, adTargetId: 'n1' }))
    const r = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-exact', matchType: 'EXACT' }))
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ scope: 'AD_GROUP', externalAdGroupId: 'EAG1', keywordText: 'giacca moto', matchType: 'EXACT' }))
    expect(r.outcomes[0]).toMatchObject({ outcome: 'acted', destinationAdGroupId: 'dst-exact', negative: { reachedAmazon: true } })
  })

  it('the Owner\'s stored destination is the source itself, or says negateAtSource off: kept as he chose', async () => {
    findAdGroup.mockResolvedValue({ id: 'ag1', campaign: { targetingType: 'MANUAL', adProduct: 'SPONSORED_PRODUCTS', type: 'SP' } })
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    resolved = { chosen: { adGroupId: 'ag1' }, source: 'stored', shortlist: [] }
    const home = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'ag1' }))
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(home.outcomes[0].outcome).toBe('acted')

    resolved = { chosen: { adGroupId: 'dst-exact' }, source: 'stored', shortlist: [] }
    storedDest = new Map([['EXACT', { adGroupId: 'dst-exact', negateAtSource: false }]])
    const kept = await applyHarvest({ graduations: [{ ...(candidate as object), orders: 3 } as never] })
    expect(createKeywordLocal).toHaveBeenLastCalledWith(expect.objectContaining({ adGroupId: 'dst-exact' }))
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(kept.outcomes[0].outcome).toBe('acted')
    storedDest = new Map()
    findAdGroup.mockResolvedValue({ id: 'ag1', campaign: { targetingType: 'AUTO', adProduct: 'SPONSORED_PRODUCTS', type: 'SP', marketplace: 'IT' } })
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

/**
 * PB-6a — winners stay. L1 binds every caller; L2 and the handover (the Owner's choice: the source is closed only once the
 * new home meets the harvest bar there) bind a rule's harvest (`rule`). Made-up terms and ids.
 */
describe('PB-6a — winners stay', () => {
  type Row = { id: string; adGroupId: string; kind: string; expressionType: string; expressionValue: string; status: string; externalTargetId: string | null; isNegative: boolean }
  let targets: Row[] = []
  const keyword = (adGroupId: string, text: string, expressionType = 'EXACT', over: Partial<Row> = {}): Row => ({
    id: `t-${adGroupId}-${expressionType}`, adGroupId, kind: 'KEYWORD', expressionType, expressionValue: text, status: 'ENABLED', externalTargetId: `x-${adGroupId}`, isNegative: false, ...over,
  })
  /** The term's search-term rows in the destination: 3 orders on 12 clicks over the window (meets 2 orders). */
  const provenIn = (externalAdGroupId: string) => [{ query: 'giacca moto', campaignId: 'EC2', adGroupId: externalAdGroupId, marketplace: 'IT', _sum: { impressions: 200, clicks: 12, costMicros: 6_000_000n, orders7d: 3, sales7dCents: 9000 } }]
  const grad = { ...(candidate as object), orders: 3 } as never
  const rule = { homeScope: ['ag1', 'dst-exact'], criteria: { windowDays: 60, minOrders: 2 } }
  const dest = { EXACT: 'dst-exact' }

  beforeEach(() => {
    targets = []
    findTargets.mockImplementation(async (a: unknown) => {
      const where = (a as { where: { adGroupId: { in: string[] }; isNegative: boolean } }).where
      return targets.filter((t) => where.adGroupId.in.includes(t.adGroupId) && t.isNegative === where.isNegative)
    })
    homeGroups = [{ id: 'dst-exact', externalAdGroupId: 'EAG-DST', campaign: { marketplace: 'IT' } }]
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-N1', reachedAmazon: true }))
  })

  it('a winner that is the live EXACT keyword of its own ad group is neither created again nor negated there', async () => {
    targets = [keyword('ag1', 'Giacca Moto')]
    const r = await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.keywordsGraduated).toBe(0)
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'already_home' }, home: { adGroupId: 'ag1', live: true } })
    expect(r.outcomes[0].negateReason).toMatch(/stays there/)
  })

  it('at home in another ad group of the product: not created again, not counted; its source is negated only once that home is a winner', async () => {
    targets = [keyword('dst-exact', 'giacca moto')]
    const waiting = await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(waiting.keywordsGraduated).toBe(0)
    expect(waiting.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'already_home' } })
    expect(waiting.outcomes[0].negateReason).toMatch(/keeps running in its source/)

    searchTerms.mockResolvedValue(provenIn('EAG-DST'))
    const proven = await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(writeNegativeKeyword).toHaveBeenCalledWith(expect.objectContaining({ scope: 'AD_GROUP', externalAdGroupId: 'EAG1', keywordText: 'giacca moto', matchType: 'EXACT' }))
    expect(proven.isolationNegativesAdded).toBe(1)
    expect(proven.keywordsGraduated).toBe(0)
    expect(proven.outcomes[0]).toMatchObject({ outcome: 'acted', negative: { reachedAmazon: true } })
    expect(proven.outcomes[0].negateReason).toMatch(/now meets the harvest bar/)
  })

  it('a new exact keyword lands in its destination at the term\'s CPC, and the source keeps the term until it proves itself', async () => {
    const r = await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-exact', matchType: 'EXACT', bidEur: 0.6 })) // 1795 / 30 clicks
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.keywordsGraduated).toBe(1)
    expect(r.outcomes[0].negateReason).toMatch(/keeps running in its source/)
  })

  it('a source row that says negateOnLanding is closed at the landing; a person\'s promote (no rule) is too, as before', async () => {
    await applyHarvest({ graduations: [grad], destinations: dest, plan: { EAG1: { negateOnLanding: true } }, rule })
    expect(writeNegativeKeyword).toHaveBeenCalledTimes(1)
    await applyHarvest({ graduations: [grad], destinations: dest })
    expect(writeNegativeKeyword).toHaveBeenCalledTimes(2)
  })

  it('a source whose own plan names no destination (the wizard could not tell its theme) is refused by name, never sent elsewhere', async () => {
    const r = await applyHarvest({ graduations: [grad], destinations: dest, plan: { EAG1: { destinations: { EXACT: null } } }, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/could not be told/) } })
  })

  it('a source\'s bid mode sets the bid a rule does not name', async () => {
    await applyHarvest({ graduations: [grad], destinations: dest, plan: { EAG1: { bid: { mode: 'fixed', value: 0.42 } } }, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ bidEur: 0.42 }))
  })

  it('another product\'s keyword is no home: the rule looks only in its own ad groups (rule 3)', async () => {
    targets = [keyword('other-product-ag', 'giacca moto')]
    const r = await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-exact' }))
    expect(r.keywordsGraduated).toBe(1)
    expect(findTargets.mock.calls.flatMap((c) => (c[0] as { where: { adGroupId: { in: string[] } } }).where.adGroupId.in)).not.toContain('other-product-ag')
  })

  it('L1 lives in the negative write service: its refusal over a keyword of the ad group is reported as it is', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'refused', refusal: { deniedAt: 'own_keyword', reason: 'A negative exact "giacca moto" was not added: it would block your own exact keyword "giacca moto" in ad group "G". Remove or lower that keyword instead.' } }))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'own_keyword', reason: expect.stringMatching(/Remove or lower that keyword instead/) } })
  })

  it('🔴 a stored rule\'s home check covers every ad group of the SAME product (siblings too), not only its destinations; never another product\'s', async () => {
    // The rule's source advertises a child of a parent; its sibling's ad group (Exact | Brand) holds the term, and the
    // rule's own last-written Exact destination (dst-exact, Exact | Category) does not.
    findProductAds.mockResolvedValue([{ productId: 'p-child-1', asin: 'B0TESTKID1' }])
    findProducts.mockImplementation(async (a: unknown) => {
      const where = (a as { where: Record<string, any> }).where
      if (where.amazonAsin) return []
      if (where.id?.in) return [{ id: 'p-child-1', parentId: 'p-parent' }]
      return [{ id: 'p-parent', amazonAsin: null }, { id: 'p-child-1', amazonAsin: 'B0TESTKID1' }, { id: 'p-child-2', amazonAsin: 'B0TESTKID2' }]
    })
    familyGroups = [{ id: 'ag-brand-exact', campaign: { marketplace: 'IT' } }, { id: 'ag-de', campaign: { marketplace: 'DE' } }]
    targets = [keyword('ag-brand-exact', 'giacca moto'), keyword('ag-de', 'giacca moto blu'), keyword('other-product-ag', 'giacca moto rossa')]
    const stored = { ownAdGroups: ['ag1'], criteria: { windowDays: 60, minOrders: 2 } }
    const r = await applyHarvest({ graduations: [grad], destinations: dest, rule: stored })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'already_home' }, home: { adGroupId: 'ag-brand-exact' } })
    // The family read asks for every child of the parent, and only one market's ad groups count.
    expect(findAdGroups.mock.calls.some(([a]) => JSON.stringify(a).includes('B0TESTKID2'))).toBe(true)
    // Another product's keyword (or the same product's in another market) is no home: the term is created.
    for (const other of ['giacca moto rossa', 'giacca moto blu']) {
      createKeywordLocal.mockClear()
      await applyHarvest({ graduations: [{ ...(grad as object), query: other } as never], destinations: dest, rule: stored })
      expect(createKeywordLocal, other).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-exact', keywordText: other }))
    }
  })

  it('a term with no clicks starts at the ad group\'s default bid (no strategy lowest bid here), never a hard-coded one; with neither it is refused', async () => {
    const noClicks = { ...(candidate as object), orders: 1, clicks: 0, costCents: 0 } as never
    await applyHarvest({ graduations: [noClicks], destinations: dest, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ bidEur: 0.4 }))
    const db = (await import('../../db.js')).default as unknown as { adGroup: { findUnique: { mockResolvedValueOnce: (v: unknown) => void } } }
    db.adGroup.findUnique.mockResolvedValueOnce({ defaultBidCents: null, campaign: { marketplace: 'IT' } })
    createKeywordLocal.mockClear()
    const none = await applyHarvest({ graduations: [noClicks], destinations: dest, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(none.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'bid', reason: expect.stringMatching(/no clicks/) } })
  })

  it('a fixed bid with no amount is refused by name, never a silent CPC', async () => {
    const r = await applyHarvest({ graduations: [grad], destinations: dest, plan: { EAG1: { bid: { mode: 'fixed' } } }, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'bid', reason: expect.stringMatching(/fixed-bid mode with no bid amount/) } })
  })

  it('v2 lists are literal ([] = none); a v1 row reads [] as EXACT', async () => {
    expect(planList({ graduate: [] }, 'graduate')).toEqual(['EXACT'])
    expect(planList({ graduate: [], literal: true }, 'graduate')).toEqual([])
    expect(planList({ literal: true }, 'negate')).toEqual(['EXACT'])
    const r = await applyHarvest({ negatives: [candidate], graduations: [grad], plan: { EAG1: { negate: [], graduate: [], literal: true } }, destinations: dest, rule })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.negativeOutcomes).toEqual([])
  })

  it('a negative that already stood is not counted as added', async () => {
    writeNegativeKeyword.mockResolvedValue(result({ outcome: 'already_existed', externalTargetId: 'AMZ-OLD', reachedAmazon: true }))
    const r = await applyHarvest({ negatives: [candidate] })
    expect(r.negativesAdded).toBe(0)
    expect(r.negativeOutcomes[0]).toMatchObject({ outcome: 'acted', reachedAmazon: true })
    expect(r.negativeOutcomes[0].reason).toMatch(/already stood/)
  })

  it('the dry run proposes only what a run would change, and says what it leaves alone', async () => {
    const waste = { ...(candidate as object), query: 'giacca economica' } as never
    const blocked = { ...(candidate as object), query: 'giacca moto blu' } as never
    targets = [keyword('dst-exact', 'giacca moto'), keyword('ag1', 'giacca moto blu'), keyword('ag1', 'giacca economica', 'NEGATIVE_EXACT', { isNegative: true, id: 'n-old' })]
    const empty = { negatives: [] as never[], graduations: [] as never[], productNegatives: [] as never[], productGraduations: [] as never[] }
    const planned = await planRuleHarvest({ ...empty, negatives: [waste, blocked], graduations: [grad], destinations: dest, rule })
    expect(planned.items).toEqual([])
    expect(planned.keptHome).toEqual([expect.objectContaining({ query: 'giacca moto' })])
    expect(planned.blockedOwnKeyword).toEqual([expect.objectContaining({ query: 'giacca moto blu' })])
    expect(planned.alreadyStanding).toBe(1)

    searchTerms.mockResolvedValue(provenIn('EAG-DST'))
    const handover = await planRuleHarvest({ ...empty, graduations: [grad], destinations: dest, rule })
    expect(handover.items).toEqual([{ kind: 'graduation', query: 'giacca moto', externalAdGroupId: 'EAG1', step: 'handover' }])
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
  })
})

/**
 * PB-6b — the intent router in a rule's harvest: an Auto source's winners land in the product's own Brand, Competitor or
 * Category Exact by their words; a term already at home in the product's campaigns stays there (L2 beats the router);
 * and another product's keyword is never a reason to skip one (rule 3). Made-up terms and ids.
 */
describe('PB-6b — the intent router', () => {
  type Row = { id: string; adGroupId: string; kind: string; expressionType: string; expressionValue: string; status: string; externalTargetId: string | null; isNegative: boolean }
  let targets: Row[] = []
  const exact = (adGroupId: string, text: string): Row => ({ id: `t-${adGroupId}`, adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, status: 'ENABLED', externalTargetId: `x-${adGroupId}`, isNegative: false })
  const router = { router: 'intent' as const, BRAND: 'a-brand', COMPETITOR: 'a-rival', CATEGORY: 'a-cat', brand: ['testbrand'], competitor: ['rivalco'] }
  // The compiled playbook rule's source row: literal lists, its own router destination, the handover "proven".
  const plan = { EAG1: { literal: true, graduate: ['EXACT'], negate: ['EXACT'], negateOnLanding: false, destinations: { EXACT: router } } }
  const rule = { homeScope: ['ag1', 'a-brand', 'a-rival', 'a-cat'], criteria: { windowDays: 60, minOrders: 2 } }
  const grad = (query: string) => ({ ...(candidate as object), query, orders: 3 }) as never
  const queried = () => findTargets.mock.calls.flatMap((c) => (c[0] as { where: { adGroupId: { in: string[] } } }).where.adGroupId.in)

  beforeEach(() => {
    targets = []
    findTargets.mockImplementation(async (a: unknown) => {
      const where = (a as { where: { adGroupId: { in: string[] }; isNegative: boolean } }).where
      return targets.filter((t) => where.adGroupId.in.includes(t.adGroupId) && t.isNegative === where.isNegative)
    })
    homeGroups = []
    createKeywordLocal.mockImplementation(async (a: { adGroupId: string }) => ({ id: `k-${a.adGroupId}`, externalTargetId: `AMZ-${a.adGroupId}` }))
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-N1', reachedAmazon: true }))
  })

  it('lands a brand term in the Brand ad group, a competitor term in the Competitor one, the rest in Category — and says which', async () => {
    const r = await applyHarvest({ graduations: [grad('testbrand jacket'), grad('rivalco jacket'), grad('waterproof jacket')], plan, rule })
    expect(createKeywordLocal.mock.calls.map((c) => [(c[0] as { keywordText: string }).keywordText, (c[0] as { adGroupId: string }).adGroupId, (c[0] as { matchType: string }).matchType])).toEqual([
      ['testbrand jacket', 'a-brand', 'EXACT'], ['rivalco jacket', 'a-rival', 'EXACT'], ['waterproof jacket', 'a-cat', 'EXACT'],
    ])
    expect(r.keywordsGraduated).toBe(3)
    expect(r.outcomes.map((o) => [o.destinationAdGroupId, o.intent])).toEqual([['a-brand', 'BRAND'], ['a-rival', 'COMPETITOR'], ['a-cat', 'CATEGORY']])
    // Handover B: the Auto source keeps running each term until its new keyword proves itself.
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
  })

  it('the dry run\'s card names the router\'s pick for each new keyword', async () => {
    const empty = { negatives: [] as never[], productNegatives: [] as never[], productGraduations: [] as never[] }
    const planned = await planRuleHarvest({ ...empty, graduations: [grad('testbrand jacket')], plan, rule })
    expect(planned.items).toEqual([{ kind: 'graduation', query: 'testbrand jacket', externalAdGroupId: 'EAG1', step: 'create', intent: 'BRAND' }])
  })

  it('L2 beats the router: a brand term already living in the product\'s Exact | Category stays there, even when the rule\'s own scope leaves that ad group out', async () => {
    targets = [exact('a-cat', 'testbrand jacket')]
    const r = await applyHarvest({ graduations: [grad('testbrand jacket')], plan, rule: { ...rule, homeScope: ['ag1'] } })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.keywordsGraduated).toBe(0)
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'already_home' }, home: { adGroupId: 'a-cat', live: true } })
    expect(queried()).toEqual(expect.arrayContaining(['a-brand', 'a-rival', 'a-cat']))
  })

  it('rule 3 — A harvests "x" into A\'s own Exact while product B holds "x" as an exact keyword; B is never read or touched', async () => {
    targets = [exact('b-exact', 'waterproof jacket')]
    const r = await applyHarvest({ graduations: [grad('waterproof jacket')], plan, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'a-cat', keywordText: 'waterproof jacket', matchType: 'EXACT' }))
    expect(r.keywordsGraduated).toBe(1)
    expect(queried()).not.toContain('b-exact')
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
  })

  it('a router that misses one of its ad groups is refused by name, never landed elsewhere', async () => {
    const broken = { EAG1: { ...plan.EAG1, destinations: { EXACT: { ...router, BRAND: '' } } } }
    const r = await applyHarvest({ graduations: [grad('testbrand jacket')], plan: broken as never, rule })
    expect(createKeywordLocal).not.toHaveBeenCalled()
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'no_destination', reason: expect.stringMatching(/cannot be read/) } })
  })
})

/**
 * PB-6b — a source whose playbook edge says not to negate it (`negateSource: false`) is never negated for a term that
 * graduated from it: not at the landing, not once its new home proves itself. Its waste negatives are unaffected.
 */
describe('PB-6b — a source that is never negated for its graduates', () => {
  type Row = { id: string; adGroupId: string; kind: string; expressionType: string; expressionValue: string; status: string; externalTargetId: string | null; isNegative: boolean }
  let targets: Row[] = []
  const exact = (adGroupId: string, text: string, kind = 'KEYWORD', expressionType = 'EXACT'): Row => ({ id: `t-${adGroupId}`, adGroupId, kind, expressionType, expressionValue: text, status: 'ENABLED', externalTargetId: `x-${adGroupId}`, isNegative: false })
  const provenIn = (externalAdGroupId: string, query = 'giacca moto') => [{ query, campaignId: 'EC2', adGroupId: externalAdGroupId, marketplace: 'IT', _sum: { impressions: 200, clicks: 12, costMicros: 6_000_000n, orders7d: 3, sales7dCents: 9000 } }]
  const grad = { ...(candidate as object), orders: 3 } as never
  const rule = { homeScope: ['ag1', 'dst-exact'], criteria: { windowDays: 60, minOrders: 2 } }
  const dest = { EXACT: 'dst-exact' }
  const kept = { EAG1: { negateSource: false } }

  beforeEach(() => {
    targets = []
    findTargets.mockImplementation(async (a: unknown) => {
      const where = (a as { where: { adGroupId: { in: string[] }; isNegative: boolean } }).where
      return targets.filter((t) => where.adGroupId.in.includes(t.adGroupId) && t.isNegative === where.isNegative)
    })
    homeGroups = [{ id: 'dst-exact', externalAdGroupId: 'EAG-DST', campaign: { marketplace: 'IT' } }]
    createKeywordLocal.mockResolvedValue({ id: 'k1', externalTargetId: 'AMZ-K1' })
    writeNegativeKeyword.mockResolvedValue(result({ externalTargetId: 'AMZ-N1', reachedAmazon: true }))
    writeNegativeProductTarget.mockResolvedValue({ outcome: 'created', externalTargetId: 'AMZ-NP1', refusal: null })
  })

  it('its home elsewhere proves itself: the source is still not negated, and the outcome says why', async () => {
    targets = [exact('dst-exact', 'giacca moto')]
    searchTerms.mockResolvedValue(provenIn('EAG-DST'))
    // The control: the same proven home closes a source that says nothing.
    await applyHarvest({ graduations: [grad], destinations: dest, rule })
    expect(writeNegativeKeyword).toHaveBeenCalledTimes(1)
    writeNegativeKeyword.mockClear()
    const r = await applyHarvest({ graduations: [grad], destinations: dest, plan: kept, rule })
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.isolationNegativesAdded).toBe(0)
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'already_home', reason: expect.stringMatching(/never negated for a term that graduated from it/) } })
  })

  it('not at the landing either, even where the row asks for negateOnLanding', async () => {
    const r = await applyHarvest({ graduations: [grad], destinations: dest, plan: { EAG1: { negateSource: false, negateOnLanding: true } }, rule })
    expect(createKeywordLocal).toHaveBeenCalledWith(expect.objectContaining({ adGroupId: 'dst-exact' }))
    expect(writeNegativeKeyword).not.toHaveBeenCalled()
    expect(r.outcomes[0].negateReason).toMatch(/landed elsewhere\. This source is never negated/)
  })

  it('the dry run proposes no handover for it; it lists the term as kept at home', async () => {
    targets = [exact('dst-exact', 'giacca moto')]
    searchTerms.mockResolvedValue(provenIn('EAG-DST'))
    const empty = { negatives: [] as never[], productNegatives: [] as never[], productGraduations: [] as never[] }
    const planned = await planRuleHarvest({ ...empty, graduations: [grad], destinations: dest, plan: kept, rule })
    expect(planned.items).toEqual([])
    expect(planned.keptHome).toEqual([expect.objectContaining({ query: 'giacca moto', why: expect.stringMatching(/never negated/) })])
  })

  it('an ASIN at home in the product-targeting slot, proven there: no negative product target in the source', async () => {
    const asin = 'B0TEST0042'
    targets = [exact('dst-pat', asin, 'PRODUCT', 'ASIN_SAME_AS')]
    homeGroups = [{ id: 'dst-pat', externalAdGroupId: 'EAG-PAT', campaign: { marketplace: 'IT' } }]
    searchTerms.mockResolvedValue(provenIn('EAG-PAT', asin))
    const pg = { ...(candidate as object), query: asin, orders: 3 } as never
    const args = { productGraduations: [pg], destinations: { PRODUCT: 'dst-pat' }, rule: { homeScope: ['ag1', 'dst-pat'], criteria: { windowDays: 60, minOrders: 2 } } }
    await applyHarvest({ ...args, plan: { EAG1: { graduateProduct: true } } })
    expect(writeNegativeProductTarget).toHaveBeenCalledTimes(1) // the control: proven, so closed
    writeNegativeProductTarget.mockClear()
    await applyHarvest({ ...args, plan: { EAG1: { graduateProduct: true, negateSource: false } } })
    expect(writeNegativeProductTarget).not.toHaveBeenCalled()
  })
})

/** 🔴 PB-6a review — a rule that names 0 orders (a Negative Targeting rule's "Orders = 0") still finds its waste. */
describe('previewHarvest — a term graduates only once it has sold', () => {
  const row = (query: string, orders: number, costMicros: bigint) => ({ query, campaignId: 'EC1', adGroupId: 'EAG1', marketplace: 'IT', _sum: { impressions: 100, clicks: 20, costMicros, orders7d: orders, sales7dCents: orders * 3000 } })
  it('minOrders 0: the zero-order spender is a negative, not a graduation; a term that sold graduates', async () => {
    searchTerms.mockResolvedValue([row('waste term', 0, 20_000_000n), row('sold term', 2, 9_000_000n)])
    const p = await previewHarvest({ windowDays: 60, minSpendCents: 1000, minOrders: 0 })
    expect(p.negatives.map((c) => c.query)).toEqual(['waste term'])
    expect(p.graduations.map((c) => c.query)).toEqual(['sold term'])
  })
})
