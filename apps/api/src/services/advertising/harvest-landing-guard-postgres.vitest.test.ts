/**
 * Harvest fix B1 + B10 — the landing guard (harvest-landing-guard.ts) through the real harvest write (ads-harvest.service.ts
 * applyHarvest, as the page's promote and a recommendation's accept call it: the destination named, the source negated on
 * landing), on a real PostgreSQL (the throwaway PostgreSQL 17 of scripts/run-real-postgres-tests.mjs, row-level policies on,
 * the restricted runtime login, business profiles ON), the ads mode LIVE with Amazon's create calls stubbed at the client
 * (nothing leaves the process) and the queue stubbed (a re-enable is a queue row, never sent).
 *
 *   archived  an archived exact keyword of the term (with Amazon's id) in the destination: the create service would answer
 *             "already there" with it — held by name instead: no keyword sent, no source negative
 *   negative  an exact negative of the term in the destination ad group, or a phrase negative of its campaign holding the
 *             term's words: held the same (B10)
 *   paused    a paused exact keyword of the term: switched on again through the keyword state write path (its row ENABLED,
 *             one queue row, one action log row as the writer), no create, and then the source is negated
 *   landed    an enabled one: no create, the source negated (as before)
 *   idle      a destination whose campaign is paused: the keyword is created there, the source is NOT negated
 *   homes     servingLandings: only an enabled keyword with Amazon's id, in a serving ad group and campaign, with no negative
 *             blocking the term there, may take a term over; another business's rows are never read
 *
 * Every value is made up (public repo).
 */
import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof concurrentDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: Record<string, unknown> | null = null
  return {
    default: new Proxy({} as Record<string, unknown>, {
      get: (_t, property) => (wrapped ??= contextualDatabase(database.client as never) as unknown as Record<string, unknown>)[property as string],
    }),
  }
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
// Amazon's create calls, stubbed at the client: what reaches them is what the real services and the real gate let through.
const amz = vi.hoisted(() => ({ keywords: [] as Array<Record<string, unknown>>, negatives: [] as Array<Record<string, unknown>>, n: 0 }))
vi.mock('./ads-api-client.js', async (original) => ({
  ...(await original<object>()),
  createKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.keywords.push(input); return { ok: true, mode: 'live', externalId: `AMZ-K-${++amz.n}`, rawResponse: {}, error: null } }),
  createNegativeKeyword: vi.fn(async (_ctx: unknown, input: Record<string, unknown>) => { amz.negatives.push(input); return { ok: true, mode: 'live', externalId: `AMZ-N-${++amz.n}`, rawResponse: {} } }),
  listNegativeKeywords: vi.fn(async () => []),
}))

const { applyHarvest } = await import('./ads-harvest.service.js')
const { checkLanding, servingLandings } = await import('./harvest-landing-guard.js')
const { setAutonomy } = await import('./ads-automation-state.service.js')

const hex = randomBytes(4).toString('hex')
const H = hex.slice(0, 2).toUpperCase()
const W = `hfix_land_${hex}`
const W2 = `hfix_other_${hex}`
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inW = <T>(work: () => Promise<T>) => withWorkspace(scope(W), work)
const inW2 = <T>(work: () => Promise<T>) => withWorkspace(scope(W2), work)
const id = (s: string) => `${hex}-${s}`
const C = (s: string) => id(`c-${s}`)
const G = (s: string) => `g-${C(s)}`
const GLOVE = id('glove'), GLOVE_L = id('glove-l')

/** A converting term from the glove's auto source, as the page's promote hands it to applyHarvest. */
const term = (query: string) => ({
  query, externalCampaignId: `EXT-${C('gl-auto')}`, externalAdGroupId: `EXT-${G('gl-auto')}`,
  impressions: 600, clicks: 30, costCents: 600, orders: 3, salesCents: 9_000, market: 'IT', bidEur: 0.4,
})
const reset = () => { amz.keywords.length = 0; amz.negatives.length = 0 }
const promote = (query: string, destAdGroupId = G('gl-exact')) => inW(() => applyHarvest({ graduations: [term(query)], destinations: { EXACT: destAdGroupId }, negateScope: 'AD_GROUP', userId: 'user:owner' }))
const target = (adGroupId: string, text: string, data: Record<string, unknown>) => inW(() => database.client.adTarget.create({
  data: { adGroupId, kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: text, bidCents: 40, status: 'ENABLED', ...data },
}))

async function seed() {
  const db = database.client
  await seedAdsFixture(db)
  await db.product.create({ data: { id: GLOVE, sku: `HFIX-GLOVE-${hex}`, name: 'Glove', isParent: true, basePrice: '30.00', totalStock: 5 } })
  await db.product.create({ data: { id: GLOVE_L, sku: `HFIX-GLOVE-L-${hex}`, name: 'Glove L', parentId: GLOVE, amazonAsin: `B0HFIXGL${H}`, basePrice: '30.00', totalStock: 5 } })
  const campaign = async (key: string, groupName: string, extra: Record<string, unknown> = {}) => {
    await db.campaign.create({ data: { id: C(key), name: `${key} ${hex}`, type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: `EXT-${C(key)}`, dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true, targetingType: 'MANUAL', ...extra } })
    await db.adGroup.create({ data: { id: G(key), campaignId: C(key), name: groupName, externalAdGroupId: `EXT-${G(key)}`, defaultBidCents: 40 } })
    await db.adProductAd.create({ data: { adGroupId: G(key), productId: GLOVE_L } })
  }
  await campaign('gl-auto', 'Auto', { targetingType: 'AUTO' })
  await campaign('gl-exact', 'Exact')
  await campaign('gl-paused', 'Exact paused', { status: 'PAUSED' })
  await db.adsStrategy.create({ data: { channel: 'AMAZON', market: 'IT', level: 'MARKET', scopeId: '*', label: 'IT', targetKind: 'ACOS', targetPct: 25, targetHiPct: 30, updatedBy: 'user:owner' } })
  await db.marketplace.create({ data: { channel: 'AMAZON', code: 'IT', name: 'Amazon Italy', region: 'EU', currency: 'EUR', language: 'it' } })
  await db.adSpendCeiling.create({ data: { grain: 'MARKET', scopeId: 'IT', label: 'IT', dailyCapCents: 10_000 } })
}

describe.skipIf(!concurrentDatabaseUrl())('harvest fix B1 + B10 — a harvest lands only where the term serves (real PostgreSQL)', { timeout: 180_000 }, () => {
  beforeAll(async () => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
    database = await concurrentDatabase()
    for (const w of [W, W2]) await database.pool.query('INSERT INTO "Workspace" (id,name,status,"createdByUserId","creationKey","updatedAt") VALUES ($1,$1,\'active\',\'test\',$1,now())', [w])
    await inW(async () => { await seed(); await setAutonomy('AUTO', 'test') })
  }, 240_000)
  afterAll(async () => { await database?.close(); vi.unstubAllEnvs() }, 60_000)

  it('an archived exact keyword of the term in the destination: held by name — no keyword sent, the source never negated', async () => {
    reset()
    await target(G('gl-exact'), 'archived gloves', { status: 'ARCHIVED', externalTargetId: 'AMZ-ARCH-1' })
    expect(await inW(() => checkLanding({ adGroupId: G('gl-exact'), term: 'Archived Gloves', match: 'EXACT' }))).toMatchObject({ kind: 'hold', deniedAt: 'landing_archived' })
    const r = await promote('archived gloves')
    expect(amz.keywords).toEqual([])
    expect(amz.negatives).toEqual([])
    expect(r.outcomes[0]).toMatchObject({ outcome: 'refused', negative: null, refusal: { deniedAt: 'landing_archived', reason: expect.stringMatching(/is archived: Amazon cannot switch an archived one on again/) } })
    expect(await inW(() => database.client.adTarget.count({ where: { adGroupId: G('gl-auto'), isNegative: true, expressionValue: 'archived gloves' } }))).toBe(0)
  })

  it('a negative of the destination that blocks the term — exact in its ad group, or phrase at its campaign: held, nothing sent (B10)', async () => {
    reset()
    await target(G('gl-exact'), 'winter gloves', { isNegative: true, negativeLevel: 'AD_GROUP', expressionType: 'NEGATIVE_EXACT', externalTargetId: 'AMZ-NEG-1', bidCents: 0 })
    await target(G('gl-exact'), 'thermal', { isNegative: true, negativeLevel: 'CAMPAIGN', expressionType: 'NEGATIVE_PHRASE', externalTargetId: 'AMZ-NEG-2', bidCents: 0 })
    const exact = await promote('winter gloves')
    const phrase = await promote('thermal gloves men')
    expect(amz.keywords).toEqual([])
    expect(amz.negatives).toEqual([])
    expect(exact.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'landing_negative', reason: expect.stringMatching(/a negative exact "winter gloves" in ad group "Exact" blocks/) } })
    expect(phrase.outcomes[0]).toMatchObject({ outcome: 'refused', refusal: { deniedAt: 'landing_negative', reason: expect.stringMatching(/a negative phrase "thermal" in campaign "gl-exact .*" blocks "thermal gloves men"/) } })
    // A term the negatives do not block lands as before, and its source is negated.
    await promote('summer gloves')
    expect(amz.keywords).toEqual([expect.objectContaining({ keywordText: 'summer gloves', matchType: 'EXACT' })])
    expect(amz.negatives).toEqual([expect.objectContaining({ keywordText: 'summer gloves' })])
  })

  it('a paused exact keyword of the term: switched on again (one queue row, one action log row as the writer), no create, then the source is negated', async () => {
    reset()
    const paused = await target(G('gl-exact'), 'paused gloves', { status: 'PAUSED', externalTargetId: 'AMZ-PAUSED-1' })
    const r = await promote('paused gloves')
    expect(amz.keywords).toEqual([])
    expect(r.outcomes[0]).toMatchObject({ outcome: 'acted', targetId: paused.id, externalTargetId: 'AMZ-PAUSED-1', negative: { reachedAmazon: true } })
    expect(amz.negatives).toEqual([expect.objectContaining({ keywordText: 'paused gloves' })])
    const row = await inW(() => database.client.adTarget.findUniqueOrThrow({ where: { id: paused.id }, select: { status: true } }))
    expect(row.status).toBe('ENABLED')
    const logs = await inW(() => database.client.advertisingActionLog.findMany({ where: { entityId: paused.id }, select: { userId: true, actionType: true, payloadBefore: true, payloadAfter: true, outboundQueueId: true } }))
    expect(logs).toEqual([expect.objectContaining({ userId: 'user:owner', actionType: 'AD_ENTITY_STATE_UPDATE', payloadBefore: expect.objectContaining({ status: 'PAUSED' }), payloadAfter: expect.objectContaining({ status: 'ENABLED' }) })])
    // Sent at once (no grace window): the source negative follows the switch, never the other way round for long.
    const queued = await inW(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id: logs[0].outboundQueueId! }, select: { syncType: true, holdUntil: true } }))
    expect(queued.syncType).toBe('AD_ENTITY_STATE_UPDATE')
    expect(queued.holdUntil!.getTime()).toBeLessThanOrEqual(Date.now())
  })

  it('an enabled one: no create, the source negated (as before); a destination whose campaign is paused: created there, the source NOT negated', async () => {
    reset()
    await target(G('gl-exact'), 'enabled gloves', { externalTargetId: 'AMZ-ON-1' })
    const on = await promote('enabled gloves')
    expect(amz.keywords).toEqual([])
    expect(on.outcomes[0]).toMatchObject({ outcome: 'acted', externalTargetId: 'AMZ-ON-1', negative: { reachedAmazon: true } })
    reset()
    const idle = await promote('idle gloves', G('gl-paused'))
    expect(amz.keywords).toEqual([expect.objectContaining({ keywordText: 'idle gloves' })])
    expect(amz.negatives).toEqual([])
    expect(idle.outcomes[0]).toMatchObject({ negative: null, negateReason: expect.stringMatching(/its campaign "gl-paused .*" is paused, so the source is not negated/) })
  })

  it('servingLandings: only an enabled keyword at Amazon, serving, unblocked, may take a term over; another business\'s rows never read', async () => {
    const live = await target(G('gl-exact'), 'home gloves', { externalTargetId: 'AMZ-HOME-1' })
    const pausedHome = await target(G('gl-exact'), 'resting gloves', { status: 'PAUSED', externalTargetId: 'AMZ-HOME-2' })
    const idleHome = await target(G('gl-paused'), 'home gloves', { externalTargetId: 'AMZ-HOME-3' })
    const blockedHome = await target(G('gl-exact'), 'fleece liner', { externalTargetId: 'AMZ-HOME-4' })
    await target(G('gl-exact'), 'liner', { isNegative: true, negativeLevel: 'CAMPAIGN', expressionType: 'NEGATIVE_PHRASE', externalTargetId: 'AMZ-NEG-3', bidCents: 0 })
    const items = [
      { adTargetId: live.id, term: 'home gloves' }, { adTargetId: pausedHome.id, term: 'resting gloves' },
      { adTargetId: idleHome.id, term: 'home gloves' }, { adTargetId: blockedHome.id, term: 'fleece liner' },
    ]
    expect([...await inW(() => servingLandings(items))]).toEqual([live.id])
    expect((await inW2(() => servingLandings(items))).size).toBe(0)
  })
})
