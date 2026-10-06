/**
 * 5b — one negative write service; every path routes through it (review 7.1 local rows, 7.5 write level, 7.6, 7.12,
 * the allowlist hole).
 *
 * Every entry point that adds a negative is driven with a protected term: none of them reaches Amazon and none leaves a
 * local row. Before 5b the launches, bulk negatives, the bulk sheet and the launch repair called the client or wrote the
 * row themselves, and a gate refusal still left the row. Then what the service decides for all of them: the live-write
 * allowlist binds a negative (a launch passes `creationFlow`), the bulk sheet's campaign negative reaches Amazon, a
 * retired negative can be added again, an ASIN is not a keyword, and a create without an id is read back.
 *
 * On a real PostgreSQL (PGlite, production schema) with the fixture account (c-it allowlisted, c-off not). Live mode,
 * so the real write gate runs its live path; the Amazon client's calls are recorders — nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: false, status: 'not-initialized' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: null },
  }
})
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))

/** Amazon, as recorders. A keyword create answers with an id unless a test says otherwise. */
const amz = vi.hoisted(() => {
  let n = 0
  return {
    createNegativeKeyword: vi.fn(async (_ctx: unknown, _input: unknown) => ({ ok: true, mode: 'live', externalId: `AMZ-K-${++n}` as string | null, rawResponse: {} })),
    createNegativeProductTarget: vi.fn(async (_ctx: unknown, _input: unknown) => ({ ok: true, mode: 'live', externalId: `AMZ-P-${++n}`, rawResponse: {} })),
    liveCall: vi.fn(async (opts: { path: string }) => (opts.path === '/sp/campaignNegativeKeywords'
      ? { campaignNegativeKeywords: { success: [{ campaignNegativeKeywordId: `AMZ-C-${++n}` }] } }
      : {})),
    listNegativeKeywords: vi.fn(async () => [] as unknown[]),
  }
})
vi.mock('./ads-api-client.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  createNegativeKeyword: amz.createNegativeKeyword,
  createNegativeProductTarget: amz.createNegativeProductTarget,
  liveCall: amz.liveCall,
  listNegativeKeywords: amz.listNegativeKeywords,
}))

const business = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const inside = <T>(work: () => Promise<T>) => withWorkspace(business, work)
const amazonCalls = () => amz.createNegativeKeyword.mock.calls.length + amz.createNegativeProductTarget.mock.calls.length + amz.liveCall.mock.calls.length
const negatives = (where: Record<string, unknown> = {}) => inside(() => database.client.adTarget.findMany({
  where: { isNegative: true, ...where },
  select: { id: true, adGroupId: true, kind: true, expressionType: true, expressionValue: true, externalTargetId: true, negativeLevel: true, status: true },
}))
const negativeCount = async () => (await negatives()).length

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(async () => {
    await seedAdsFixture(database.client)
    await database.client.adKeywordProtection.create({ data: { term: 'xavia', mode: 'WHITELIST', matchType: 'CONTAINS', reason: 'brand term' } as never })
    await database.client.adKeywordProtection.create({ data: { term: 'B0PROTECT1', mode: 'WHITELIST', matchType: 'EXACT', reason: 'own product' } as never })
  })
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.createNegativeKeyword.mockClear(); amz.createNegativeProductTarget.mockClear(); amz.liveCall.mockClear(); amz.listNegativeKeywords.mockClear()
})

describe('every entry point × a protected term → no Amazon call, no local row', () => {
  const svc = () => import('./ads-negative-kw.service.js')
  const create = () => import('./ads-create.service.js')
  const PROTECTED = 'giacca xavia'

  const entries: Array<[string, () => Promise<unknown>]> = [
    ['writeNegativeKeyword, ad group', async () => (await svc()).writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: PROTECTED, matchType: 'EXACT' })],
    ['writeNegativeKeyword, campaign', async () => (await svc()).writeNegativeKeyword({ scope: 'CAMPAIGN', campaignId: 'c-it', keywordText: PROTECTED, matchType: 'PHRASE' })],
    ['createNegative (rules, n-grams, funnel, route)', async () => (await svc()).createNegative({ profileId: 'P-IT-TEST', marketplace: 'IT', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: PROTECTED, matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' })],
    ['createNegativeKeywordLocal (launches, AI goals)', async () => (await create()).createNegativeKeywordLocal({ adGroupId: 'g-c-it', keywordText: PROTECTED, matchType: 'EXACT' })],
    ['createNegativeKeywordLocal with creationFlow (single launch)', async () => (await create()).createNegativeKeywordLocal({ adGroupId: 'g-c-it', keywordText: PROTECTED, matchType: 'EXACT', creationFlow: true })],
    ['bulkNegativeKeywords (launch repair, bulk route, blueprints)', async () => (await create()).bulkNegativeKeywords([{ adGroupId: 'g-c-it', keywordText: PROTECTED, matchType: 'PHRASE' }])],
    ['createNegativeProductTargetLocal (a protected ASIN)', async () => (await create()).createNegativeProductTargetLocal({ adGroupId: 'g-c-it', asin: 'B0PROTECT1' })],
    ['applyHarvest, wasteful negative', async () => (await import('./ads-harvest.service.js')).applyHarvest({
      negatives: [{ query: PROTECTED, externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', impressions: 100, clicks: 10, costCents: 900, orders: 0, salesCents: 0 }],
      protectConverting: false,
    })],
    ['applyHarvest, campaign scope', async () => (await import('./ads-harvest.service.js')).applyHarvest({
      negatives: [{ query: PROTECTED, externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', impressions: 100, clicks: 10, costCents: 900, orders: 0, salesCents: 0 }],
      protectConverting: false, negateScope: 'CAMPAIGN',
    })],
  ]

  for (const [name, run] of entries) {
    it(name, async () => {
      const before = await negativeCount()
      await inside(run)
      expect(amazonCalls(), 'an Amazon call was made').toBe(0)
      expect(await negativeCount(), 'a local row was written').toBe(before)
    })
  }

  it('the bulk sheet: ad-group, campaign and product negatives', async () => {
    const { applyPlan } = await import('./bulksheet/apply.js')
    const db = (await import('../../db.js')).default as never
    const before = await negativeCount()
    const row = (rowIndex: number, entity: string, parentId: string, diffs: Array<[string, string]>) => ({
      rowIndex, entity, operation: 'Create', rowKey: '', targetId: null, parentId, label: '', status: 'CREATE' as const,
      diffs: diffs.map(([field, next]) => ({ field, current: '', next })),
    })
    const out = await inside(() => applyPlan(db, 'job-protected', [
      row(0, 'Negative keyword', 'g-c-it', [['Keyword text', PROTECTED], ['Match type', 'Negative exact']]),
      row(1, 'Campaign negative keyword', 'c-it', [['Keyword text', PROTECTED], ['Match type', 'Negative phrase']]),
      row(2, 'Negative product targeting', 'g-c-it', [['Product targeting expression', 'asin="B0PROTECT1"']]),
    ] as never, { actor: 'user:u1', applyImmediately: true, strict: false, conflicts: 'skip' }))
    expect(out.failed).toBe(3)
    for (const r of out.results) expect(r.message).toMatch(/^Not created — refused at keyword_protected: .*protected term/)
    expect(amazonCalls()).toBe(0)
    expect(await negativeCount()).toBe(before)
  })

  it('the launch repair: a local-only protected negative is not pushed, and says why', async () => {
    const seeded = await inside(() => database.client.adTarget.create({
      data: { adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'xavia jacket', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP' },
    }))
    const { pushCampaignStructure } = await create()
    const out = await inside(() => pushCampaignStructure('c-it'))
    expect(amazonCalls()).toBe(0)
    expect(out.negKeywords).toBe(0)
    expect(out.errors.join(' ')).toMatch(/negKw "xavia jacket" NEGATIVE_EXACT: refused at keyword_protected/)
    const [row] = await negatives({ id: seeded.id })
    expect(row!.externalTargetId).toBeNull()
    await inside(() => database.client.adTarget.delete({ where: { id: seeded.id } }))
  })
})

describe('the live-write allowlist binds negatives (it was skipped for every rule, harvest and launch negative)', () => {
  it('off the allowlist: refused with the reason, nothing sent, nothing written', async () => {
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const before = await negativeCount()
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-off', keywordText: 'cheap socks', matchType: 'EXACT' }))
    expect(r).toMatchObject({ outcome: 'refused', adTargetId: null, refusal: { deniedAt: 'campaign_allowlist', reason: expect.stringContaining('not on the live-write allowlist') } })
    expect(amazonCalls()).toBe(0)
    expect(await negativeCount()).toBe(before)
  })

  it('a launch (creationFlow) is part of the creation: sent, and recorded with Amazon\'s id', async () => {
    const { createNegativeKeywordLocal } = await import('./ads-create.service.js')
    const r = await inside(() => createNegativeKeywordLocal({ adGroupId: 'g-c-off', keywordText: 'cheap socks', matchType: 'EXACT', creationFlow: true }))
    expect(amz.createNegativeKeyword).toHaveBeenCalledTimes(1)
    expect(r.externalTargetId).toMatch(/^AMZ-K-/)
    const [row] = await negatives({ id: r.id! })
    expect(row).toMatchObject({ adGroupId: 'g-c-off', expressionType: 'NEGATIVE_EXACT', negativeLevel: 'AD_GROUP', externalTargetId: r.externalTargetId })
  })
})

describe('7.12 — the bulk sheet\'s campaign negative reaches Amazon', () => {
  it('POSTs /sp/campaignNegativeKeywords, records the CAMPAIGN row with Amazon\'s id, and reports it created on Amazon', async () => {
    const { applyPlan } = await import('./bulksheet/apply.js')
    const db = (await import('../../db.js')).default as never
    const out = await inside(() => applyPlan(db, 'job-campaign', [{
      rowIndex: 0, entity: 'Campaign negative keyword', operation: 'Create', rowKey: '', targetId: null, parentId: 'c-it', label: 'cheap gloves', status: 'CREATE',
      diffs: [{ field: 'Keyword text', current: '', next: 'cheap gloves' }, { field: 'Match type', current: '', next: 'Negative exact' }],
    }] as never, { actor: 'user:u1', applyImmediately: true, strict: false, conflicts: 'skip' }))
    expect(amz.liveCall).toHaveBeenCalledTimes(1)
    expect(amz.liveCall.mock.calls[0]![0]).toMatchObject({
      method: 'POST', path: '/sp/campaignNegativeKeywords',
      body: { campaignNegativeKeywords: [{ campaignId: 'EXT-c-it', keywordText: 'cheap gloves', matchType: 'NEGATIVE_EXACT', state: 'ENABLED' }] },
    })
    expect(out.applied).toBe(1)
    expect(out.results[0]!.message).toMatch(/^Created on Amazon \(AMZ-C-\d+\)/)
    const [row] = await negatives({ expressionValue: 'cheap gloves' })
    expect(row).toMatchObject({ negativeLevel: 'CAMPAIGN', expressionType: 'NEGATIVE_EXACT', externalTargetId: expect.stringMatching(/^AMZ-C-/) })
  })
})

describe('7.6 — a retired negative can be added again; a standing one is found whatever its case or spelling', () => {
  it('created, then found case-insensitively, then — once retired — created again', async () => {
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const first = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'Giacca Pelle Nera', matchType: 'EXACT' }))
    expect(first).toMatchObject({ outcome: 'created', reachedAmazon: true })
    const again = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'giacca pelle nera', matchType: 'NEGATIVE_EXACT' }))
    expect(again).toMatchObject({ outcome: 'already_existed', adTargetId: first.adTargetId })
    expect(amz.createNegativeKeyword).toHaveBeenCalledTimes(1)

    await inside(() => database.client.adTarget.update({ where: { id: first.adTargetId! }, data: { status: 'ARCHIVED', retiredAt: new Date() } }))
    const readded = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'giacca pelle nera', matchType: 'EXACT' }))
    expect(readded).toMatchObject({ outcome: 'created', reachedAmazon: true })
    expect(readded.adTargetId).not.toBe(first.adTargetId)
    expect(amz.createNegativeKeyword).toHaveBeenCalledTimes(2)
  })

  it('the sync\'s plain EXACT spelling stands too (the fixture\'s "free")', async () => {
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    await inside(() => database.client.adTarget.update({ where: { id: 't-neg' }, data: { expressionType: 'EXACT' } }))
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'FREE', matchType: 'EXACT' }))
    expect(r).toMatchObject({ outcome: 'already_existed', adTargetId: 't-neg' })
    expect(amazonCalls()).toBe(0)
  })
})

describe('validation before anything is sent', () => {
  it('7.5 — an ASIN is a product, not a keyword; a phrase longer than Amazon takes is refused', async () => {
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const asin = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'B0ABCDEFGH', matchType: 'EXACT' }))
    expect(asin).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'asin_keyword', reason: expect.stringContaining('negative product target') } })
    const long = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'giacca moto donna estiva rete', matchType: 'PHRASE' }))
    expect(long).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'text_limits' } })
    expect(amazonCalls()).toBe(0)
  })

  it('the converting guard, when the caller asks for it', async () => {
    await inside(() => database.client.amazonAdsSearchTerm.create({
      data: { profileId: 'P-IT-TEST', marketplace: 'IT', adProduct: 'SPONSORED_PRODUCTS', date: new Date(), campaignId: 'EXT-c-it', adGroupId: 'EXT-g-c-it', query: 'guanti estivi', impressions: 500, clicks: 20, costMicros: 9_000_000n, currencyCode: 'EUR', orders7d: 2, sales7dCents: 9000 },
    }))
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'guanti estivi', matchType: 'EXACT', protectConverting: { enabled: true, days: 30 } }))
    expect(r).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'protect_converting' } })
    expect(amazonCalls()).toBe(0)
  })
})

describe('HV.9a — a create that comes back without an id is read back before it is believed', () => {
  it('found at Amazon: recorded with the id read back', async () => {
    amz.createNegativeKeyword.mockResolvedValueOnce({ ok: true, mode: 'live', externalId: null, rawResponse: {} })
    amz.listNegativeKeywords.mockResolvedValueOnce([{ keywordId: '48498817150724', keywordText: 'Veste Moto', adGroupId: 'EXT-g-c-it', matchType: 'NEGATIVE_PHRASE' }])
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'veste moto', matchType: 'PHRASE' }))
    expect(r).toMatchObject({ outcome: 'created', externalTargetId: '48498817150724', reachedAmazon: true })
  })

  it('not found: failed, and nothing is recorded (a null-id row is what the launch repair would push twice)', async () => {
    amz.createNegativeKeyword.mockResolvedValueOnce({ ok: true, mode: 'live', externalId: null, rawResponse: {} })
    const { writeNegativeKeyword } = await import('./ads-negative-kw.service.js')
    const before = await negativeCount()
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'pantaloni estivi', matchType: 'EXACT' }))
    expect(r).toMatchObject({ outcome: 'failed', adTargetId: null, error: expect.stringMatching(/read-back did not find it/) })
    expect(await negativeCount()).toBe(before)
  })
})

/**
 * PB-6a (L1) — a negative never blocks a keyword where it lands, whoever writes it: the rules, the harvest, n-grams,
 * the funnel, Claude's tools, the screens (a person's own add included) and the bulk sheet all come through here. The
 * fixture's c-it ad group holds the EXACT keyword "race jacket"; a product target is added for the product case.
 */
describe('PB-6a — a negative over a keyword of its own ad group is refused for every writer, by name', () => {
  const svc = () => import('./ads-negative-kw.service.js')
  const entries: Array<[string, () => Promise<{ refusal?: { deniedAt: string; reason: string } | null; denied?: { deniedAt: string; reason: string } | null }>]> = [
    ['exact negative, ad group', async () => (await svc()).writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'Race Jacket', matchType: 'EXACT' })],
    ['phrase negative whose words the keyword holds', async () => (await svc()).writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'jacket', matchType: 'PHRASE' })],
    ['campaign scope', async () => (await svc()).writeNegativeKeyword({ scope: 'CAMPAIGN', campaignId: 'c-it', keywordText: 'race jacket', matchType: 'EXACT' })],
    ['a person\'s own add from a screen', async () => (await svc()).writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'race jacket', matchType: 'EXACT', manual: true, userId: 'user:test-person' })],
    ['createNegative (add_negative_exact/phrase, sync, n-grams, funnel, route)', async () => (await svc()).createNegative({ profileId: 'P-IT-TEST', marketplace: 'IT', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'race jacket', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' })],
    ['a negative product target over the product target of its ASIN', async () => (await svc()).writeNegativeProductTarget({ adGroupId: 'g-c-it', asin: 'B0TESTPOS1' })],
  ]

  beforeAll(async () => {
    await inside(() => database.client.adTarget.create({ data: { id: 't-it-pt', adGroupId: 'g-c-it', kind: 'PRODUCT', expressionType: 'ASIN', expressionValue: 'B0TESTPOS1', bidCents: 40, externalTargetId: 'EXT-t-it-pt' } }))
  })

  for (const [name, run] of entries) {
    it(name, async () => {
      const before = await negativeCount()
      const r = await inside(run)
      const refusal = r.refusal ?? r.denied
      expect(refusal?.deniedAt).toBe('own_keyword')
      expect(refusal?.reason).toMatch(/it would block your own (exact keyword "race jacket"|product target B0TESTPOS1) in ad group ".+"\. Remove or lower that keyword instead\.$/)
      expect(amazonCalls(), 'an Amazon call was made').toBe(0)
      expect(await negativeCount(), 'a local row was written').toBe(before)
    })
  }

  it('a negative that blocks no keyword of its ad group still goes (an exact "race" is not "race jacket")', async () => {
    const r = await inside(async () => (await svc()).writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'race', matchType: 'EXACT' }))
    expect(r).toMatchObject({ outcome: 'created', reachedAmazon: true })
  })
})
