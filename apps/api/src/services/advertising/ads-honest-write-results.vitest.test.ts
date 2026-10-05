/**
 * PR 1d — "Added" / "Saved" only when Amazon accepted (CM-8, CM-10, CM-17, CM-25).
 *
 *   CM-8   a person's add (`requireAmazon`, the create routes): Amazon's 207 per-item error is a refusal with Amazon's
 *          words, nothing is written in Nexus, and a row Nexus held without Amazon's id is sent on re-add.
 *   CM-25  a negative Nexus holds without Amazon's id is not "already there": the add sends it and the row takes the id.
 *   CM-10  a person's edit from a screen (`askGate`) is refused at once, in the gate's words, with nothing written.
 *   CM-17  a write Amazon rejects for good is put back in Nexus, like a gate refusal.
 *
 * Real create / negative / mutation services, the real write gate in LIVE mode and the real ads worker, on PGlite
 * (production schema) with the shared fake ads account (c-it allowlisted, c-off not). Amazon is a recorder: each
 * create answers with the 207 body a test gives it (read by the client's own `v3CreateResult`), else with an id.
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
    redis: null,
  }
})
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), notifyAutomation: async () => 0 }))

/** Amazon, as recorders. `next` holds raw 207 bodies for the next creates; empty → a success with a fresh id. */
const amz = vi.hoisted(() => ({
  next: [] as unknown[],
  creates: [] as string[],
  updateAnswer: { ok: true, rawResponse: {} } as { ok: boolean; rawResponse: unknown; error?: string | null },
  updates: [] as Array<{ externalId: string; patch: Record<string, unknown> }>,
  n: 0,
}))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const create = (resource: string, idField: string) => async () => {
    amz.creates.push(resource)
    const raw = amz.next.length ? amz.next.shift() : { [resource]: { success: [{ index: 0, [idField]: `AMZ-${++amz.n}` }], error: [] } }
    const made = real.v3CreateResult(raw, resource, idField)
    return { ok: made.externalId != null, mode: 'live', externalId: made.externalId, rawResponse: raw, error: made.error }
  }
  const update = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amz.updates.push({ externalId, patch })
    return amz.updateAnswer
  }
  return {
    ...real,
    createKeyword: create('keywords', 'keywordId'),
    createTarget: create('targetingClauses', 'targetId'),
    createProductAd: create('productAds', 'adId'),
    createAdGroup: create('adGroups', 'adGroupId'),
    createNegativeKeyword: async () => {
      amz.creates.push('negativeKeywords')
      return { ok: true, mode: 'live', externalId: `AMZ-NK-${++amz.n}`, rawResponse: {} }
    },
    listNegativeKeywords: async () => [],
    updateCampaign: update, updateAdGroup: update, updateTarget: update, updateProductAd: update,
  }
})

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
/** Amazon's 207 answer refusing one item. */
const refused207 = (resource: string, message: string) => ({
  [resource]: { success: [], error: [{ index: 0, errors: [{ errorType: 'invalidArgument', errorValue: { invalidArgumentError: { message } } }] }] },
})
const counts = () => inside(async () => ({
  targets: await db().adTarget.count(),
  groups: await db().adGroup.count(),
  ads: await db().adProductAd.count(),
  log: await db().advertisingActionLog.count(),
  queue: await db().outboundSyncQueue.count(),
}))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.next = []; amz.creates = []; amz.updates = []; amz.updateAnswer = { ok: true, rawResponse: {} }
})

describe('the create client: only an id is a create (CM-8)', () => {
  it('reads Amazon\'s own words from a 207 per-item error, an id from success, and neither as unconfirmed', async () => {
    const { v3CreateResult, CREATE_NO_ID } = await vi.importActual<typeof import('./ads-api-client.js')>('./ads-api-client.js')
    expect(v3CreateResult(refused207('keywords', 'Keyword already exists'), 'keywords', 'keywordId'))
      .toEqual({ externalId: null, error: 'Amazon refused it: Keyword already exists' })
    expect(v3CreateResult({ keywords: { success: [{ index: 0, keywordId: 4711 }], error: [] } }, 'keywords', 'keywordId'))
      .toEqual({ externalId: '4711', error: null })
    expect(v3CreateResult({ keywords: { success: [], error: [] } }, 'keywords', 'keywordId')).toEqual({ externalId: null, error: CREATE_NO_ID })
    expect(v3CreateResult(null, 'adGroups', 'adGroupId')).toEqual({ externalId: null, error: CREATE_NO_ID })
  })
})

describe('a person\'s add: nothing in Nexus unless Amazon took it (CM-8)', () => {
  it('keyword refused by Amazon (207): not ok, Amazon\'s reason, no row and no audit row', async () => {
    const { createKeywordLocal } = await import('./ads-create.service.js')
    const before = await counts()
    amz.next.push(refused207('keywords', 'Bid is below the minimum'))
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'summer gloves', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true }))
    expect(r).toMatchObject({ ok: false, outcome: 'failed', id: null, externalTargetId: null, reason: 'Amazon refused it: Bid is below the minimum' })
    expect(await counts()).toEqual(before)
  })

  it('keyword taken: ok, the row carries Amazon\'s id; adding it again is "already there" with no second call', async () => {
    const { createKeywordLocal } = await import('./ads-create.service.js')
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'summer gloves', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true }))
    expect(r).toMatchObject({ ok: true, outcome: 'created', externalTargetId: expect.stringMatching(/^AMZ-/) })
    const again = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'Summer Gloves', matchType: 'EXACT', bidEur: 0.4, requireAmazon: true }))
    expect(again).toMatchObject({ ok: true, outcome: 'already_existed', id: r.id })
    expect(amz.creates).toEqual(['keywords'])
  })

  it('a keyword Nexus held without Amazon\'s id is sent on re-add (never "added" from the dedupe)', async () => {
    const { createKeywordLocal } = await import('./ads-create.service.js')
    const held = await inside(() => db().adTarget.create({ data: { adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'PHRASE', expressionValue: 'rain jacket', bidCents: 30 } }))
    const before = await counts()
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'rain jacket', matchType: 'PHRASE', bidEur: 0.55, requireAmazon: true }))
    expect(r).toMatchObject({ ok: true, outcome: 'created', id: held.id, externalTargetId: expect.stringMatching(/^AMZ-/) })
    expect(amz.creates).toEqual(['keywords'])
    const row = await inside(() => db().adTarget.findUniqueOrThrow({ where: { id: held.id } }))
    expect(row).toMatchObject({ externalTargetId: r.externalTargetId, bidCents: 55 })
    expect((await counts()).targets).toBe(before.targets)
  })

  it('refused by the write gate: the gate\'s words, nothing sent, nothing written', async () => {
    const { createKeywordLocal } = await import('./ads-create.service.js')
    const before = await counts()
    // €600 is past the €500 value cap (and Amazon's own bid range): refused before any call.
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'gold jacket', matchType: 'EXACT', bidEur: 600, requireAmazon: true }))
    expect(r).toMatchObject({ ok: false, outcome: 'refused', id: null })
    expect(r.reason).toBeTruthy()
    expect(amz.creates).toEqual([])
    expect(await counts()).toEqual(before)
  })

  it('product target, product ad and ad group refused by Amazon: no rows, Amazon\'s reason each time', async () => {
    const { createTargetLocal, createProductAdLocal, createAdGroupLocal } = await import('./ads-create.service.js')
    const before = await counts()
    amz.next.push(refused207('targetingClauses', 'Target already exists'), refused207('productAds', 'SKU is not eligible'), refused207('adGroups', 'Duplicate ad group name'))
    const t = await inside(() => createTargetLocal({ adGroupId: 'g-c-it', kind: 'PRODUCT', value: 'B0TESTASIN', bidEur: 0.5, requireAmazon: true }))
    const a = await inside(() => createProductAdLocal({ adGroupId: 'g-c-it', sku: 'SKU-TEST-1', requireAmazon: true }))
    const g = await inside(() => createAdGroupLocal({ campaignId: 'c-it', name: 'Second group', defaultBidEur: 0.5, requireAmazon: true }))
    expect(t).toMatchObject({ ok: false, outcome: 'failed', id: null, reason: 'Amazon refused it: Target already exists' })
    expect(a).toMatchObject({ ok: false, outcome: 'failed', id: null, reason: 'Amazon refused it: SKU is not eligible' })
    expect(g).toMatchObject({ ok: false, outcome: 'failed', id: null, reason: 'Amazon refused it: Duplicate ad group name' })
    expect(await counts()).toEqual(before)
  })

  it('every other caller keeps its row (a launch, a rule): unchanged, and now told Amazon\'s reason', async () => {
    const { createKeywordLocal } = await import('./ads-create.service.js')
    amz.next.push(refused207('keywords', 'Keyword is not allowed'))
    const r = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'odd word', matchType: 'BROAD', bidEur: 0.3 }))
    expect(r.id).toBeTruthy()
    expect(r).toMatchObject({ externalTargetId: null, pushError: 'Amazon refused it: Keyword is not allowed' })
    expect(r.ok).toBeUndefined()
  })
})

describe('a negative without Amazon\'s id is not "already there" (CM-25)', () => {
  it('re-adding it sends it, and the row Nexus held takes Amazon\'s id', async () => {
    const { writeNegativeKeyword, createNegative } = await import('./ads-negative-kw.service.js')
    const held = await inside(() => db().adTarget.create({
      data: { adGroupId: 'g-c-it', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'cheap helmet', bidCents: 0, isNegative: true, negativeLevel: 'AD_GROUP' },
    }))
    const r = await inside(() => writeNegativeKeyword({ scope: 'AD_GROUP', adGroupId: 'g-c-it', keywordText: 'cheap helmet', matchType: 'EXACT' }))
    expect(r).toMatchObject({ outcome: 'created', reachedAmazon: true, adTargetId: held.id })
    expect(amz.creates).toEqual(['negativeKeywords'])
    const row = await inside(() => db().adTarget.findUniqueOrThrow({ where: { id: held.id } }))
    expect(row.externalTargetId).toBe(r.externalTargetId)
    // Now Amazon holds it: the next add (the route's push-only wrapper) is "already there", with no call.
    const again = await inside(() => createNegative({ profileId: 'P-IT-TEST', marketplace: 'IT', externalCampaignId: 'EXT-c-it', externalAdGroupId: 'EXT-g-c-it', keywordText: 'cheap helmet', matchType: 'NEGATIVE_EXACT', scope: 'AD_GROUP' }))
    expect(again).toMatchObject({ ok: true, alreadyExisted: true })
    expect(amz.creates).toEqual(['negativeKeywords'])
  })
})

describe('a person\'s edit is refused at once, in the gate\'s words (CM-10)', () => {
  it('a bid on a campaign off the live-write allowlist: not ok, nothing written, nothing queued', async () => {
    const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
    const before = await counts()
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-off', patch: { bidCents: 35 }, actor: 'user:u1', askGate: true }))
    expect(r).toMatchObject({ ok: false, outboundQueueId: null, error: expect.stringMatching(/^Not sent to Amazon: .*not on the live-write allowlist/) })
    expect((await inside(() => db().adTarget.findUniqueOrThrow({ where: { id: 't-off' } }))).bidCents).toBe(30)
    expect(await counts()).toEqual(before)
  })

  it('a daily budget past the value cap: the same', async () => {
    const { updateCampaignWithSync } = await import('./ads-mutation.service.js')
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 600 }, actor: 'user:u1', askGate: true }))
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/^Not sent to Amazon: /) })
    expect(Number((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-it' } }))).dailyBudget)).toBe(20)
  })

  it('a portfolio id is not money: a portfolio move is not refused by the value cap', async () => {
    const { writeValueCents } = await import('./ads-mutation.service.js')
    expect(writeValueCents([{ field: 'portfolioId', oldValue: null, newValue: '123456789012345' }])).toBe(0)
    expect(writeValueCents([{ field: 'dailyBudget', oldValue: '20', newValue: '25.5' }, { field: 'name', oldValue: 'a', newValue: '2024' }])).toBe(2550)
    expect(writeValueCents([{ field: 'bid', oldValue: '45', newValue: '60' }])).toBe(60)
  })

  it('callers that do not ask (rules, engines) keep the queue-then-dispatch path', async () => {
    const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-off', patch: { bidCents: 33 }, actor: 'automation:tst-rule' }))
    expect(r).toMatchObject({ ok: true, outboundQueueId: expect.any(String) })
    await inside(() => db().outboundSyncQueue.update({ where: { id: r.outboundQueueId! }, data: { syncStatus: 'CANCELLED' } }))
    await inside(() => db().adTarget.update({ where: { id: 't-off' }, data: { bidCents: 30 } }))
  })
})

describe('a write Amazon rejects for good is put back in Nexus (CM-17)', () => {
  it('an ad group\'s default bid comes back to the value it replaced', async () => {
    const { updateAdGroupWithSync } = await import('./ads-mutation.service.js')
    const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')
    await inside(() => db().adGroup.update({ where: { id: 'g-c-it' }, data: { defaultBidCents: 50 } }))
    const r = await inside(() => updateAdGroupWithSync({ adGroupId: 'g-c-it', patch: { defaultBidCents: 70 }, actor: 'user:u1', applyImmediately: true }))
    expect(r.ok).toBe(true)
    expect((await inside(() => db().adGroup.findUniqueOrThrow({ where: { id: 'g-c-it' } }))).defaultBidCents).toBe(70)
    amz.updateAnswer = { ok: false, rawResponse: {}, error: 'amazon_rejected: [{"errorType":"invalidArgument","message":"Bid is invalid"}]' }
    await inside(() => drainAdsSyncOnce(50))
    expect(amz.updates).toEqual([{ externalId: 'EXT-g-c-it', patch: expect.objectContaining({ defaultBid: 0.7 }) }])
    const row = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: r.outboundQueueId! } }))
    expect(row.syncStatus).toBe('FAILED')
    expect((await inside(() => db().adGroup.findUniqueOrThrow({ where: { id: 'g-c-it' } }))).defaultBidCents).toBe(50)
  })

  it('a transient failure that is retried keeps the value (it may still land)', async () => {
    const { updateAdTargetWithSync } = await import('./ads-mutation.service.js')
    const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 50 }, actor: 'user:u1', applyImmediately: true }))
    amz.updateAnswer = { ok: false, rawResponse: {}, error: 'HTTP 503 Service Unavailable' }
    await inside(() => drainAdsSyncOnce(50))
    const row = await inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id: r.outboundQueueId! } }))
    expect(row.syncStatus).toBe('PENDING')
    expect((await inside(() => db().adTarget.findUniqueOrThrow({ where: { id: 't-it' } }))).bidCents).toBe(50)
  })
})
