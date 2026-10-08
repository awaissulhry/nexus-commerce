/**
 * ONE BRAIN AB-5 — what the ads worker and the mutation layer's pre-ask tell the write gate about a write's lever, and
 * what a failed read of the brain's holders does to a queued write.
 *
 *   dispatch   the worker names the lever no field names: a negative's status → `negatives` (its retire); a portfolio's own
 *              write → its `portfolioId` with no campaign, and `portfolio` for its cap; a keyword's status → its field only
 *   pre-ask    gateRefusedNow hands the gate the same (queuedWriteLever) and the deliberate-pause mark (`letsGo` →
 *              isLetGoWrite, as the worker does): a pause-ads pause is judged as letting go at both
 *   retry      review of #523 — nothing enrolled in the business and the read of AdsBrainEnrollment failing (a DB blip, no
 *              answer known yet): the gate's error goes out of the dispatch exactly as any failed read in the gate did
 *              before — the row is NOT settled SKIPPED, Nexus's copy is NOT put back, no refusal is recorded, and the
 *              reclaim sends it again; once the read works, the same write passes
 *
 * PGlite with the production schema and the REAL write gate (wrapped to see what it is handed); the Amazon client is the
 * real module with the live mode switched on, and no test reaches a dispatch: the gate refuses (a canned answer) or fails
 * first. Nothing leaves the process.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateContext, GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
/** A DB blip on the brain's enrollment table only: everything else reads PGlite. */
let brainReadFails = false
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  const blip = { findFirst: async () => { throw new Error('db blip') }, findMany: async () => { throw new Error('db blip') } }
  return {
    default: new Proxy({}, {
      get: (_t, p) => (p === 'adsBrainEnrollment' && brainReadFails ? blip : Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p)),
    }),
  }
})
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: null,
  }
})
/** What the gate was handed, and whether it answers for real or with a canned refusal (so nothing is dispatched). */
const handed: GateContext[] = []
let gateMode: 'real' | 'refuse' = 'refuse'
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()
  return {
    ...real,
    checkAdsWriteGate: async (ctx: GateContext): Promise<GateDecision> => {
      handed.push(ctx)
      return gateMode === 'real' ? real.checkAdsWriteGate(ctx) : { allowed: false, deniedAt: 'env', reason: 'test: the gate saw it and stopped here' }
    },
  }
})
vi.mock('../services/advertising/ads-api-client.js', async (importOriginal) => ({ ...(await importOriginal<object>()), adsMode: () => 'live' }))
vi.mock('../services/advertising/ads-profile-resolver.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  adsProfileFor: async () => ({ profileId: 'P-IT-TEST', mode: 'production', writesEnabledAt: new Date() }),
}))
vi.mock('../services/advertising/ads-automation-state.service.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getAutomationState: async () => ({ autonomy: 'AUTO', halted: false, haltReason: null, effectivelyStopped: false, degraded: false }),
}))

const { drainAdsSyncOnce, reclaimCrashedAdWrites } = await import('./ads-sync.worker.js')
const { updateAdTargetWithSync, updateCampaignWithSync, updatePortfolioWithSync, updateProductAdWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { forgetLeverOwners } = await import('../services/advertising/brain/lever-owners.js')
const { RECLAIM_IN_PROGRESS_AFTER_MS } = await import('../jobs/outbound-queue-janitor.job.js')

const RULE = 'automation:rule-ab5w' as const
const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const last = () => handed[handed.length - 1]!
const queueRow = (id: string) => database.client.outboundSyncQueue.findUnique({ where: { id }, select: { syncStatus: true, errorCode: true, errorMessage: true } })

beforeAll(async () => {
  vi.stubEnv('NEXUS_BID_BRAIN_MODE', 'live')
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  database = await formulaDatabase()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id: 'bl-c', name: 'bl-c', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-bl-c',
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: 'bl-g', campaignId: 'bl-c', name: 'bl-g', externalAdGroupId: 'EXT-bl-g', defaultBidCents: 40 } as never })
    await db.adTarget.create({ data: { id: 'bl-t', adGroupId: 'bl-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: 'race jacket', bidCents: 40, externalTargetId: 'EXT-bl-t' } as never })
    await db.adTarget.create({
      data: {
        id: 'bl-neg', adGroupId: 'bl-g', kind: 'KEYWORD', expressionType: 'NEGATIVE_EXACT', expressionValue: 'cheap jacket', bidCents: 0,
        isNegative: true, negativeLevel: 'AD_GROUP', externalTargetId: 'EXT-bl-neg',
      } as never,
    })
    await db.adProductAd.create({ data: { id: 'bl-ad', adGroupId: 'bl-g', asin: 'B0BLAD0001', sku: 'BL-SKU', externalAdId: 'EXT-bl-ad' } as never })
    await db.amazonAdsConnection.create({ data: { profileId: 'P-IT-TEST', marketplace: 'IT', region: 'EU', mode: 'production', writesEnabledAt: new Date(), isActive: true } as never })
    await db.amazonAdsPortfolio.create({
      data: { id: 'bl-pf', profileId: 'P-IT-TEST', externalPortfolioId: 'AMZ-BL-PF', name: 'bl-pf', state: 'ENABLED', budgetAmount: '200.00', budgetCurrencyCode: 'EUR', budgetPolicy: 'MONTHLY_RECURRING' } as never,
    })
  })
}, 180_000)
afterAll(async () => { await database?.close(); vi.unstubAllEnvs() })
beforeEach(() => { handed.length = 0; gateMode = 'refuse'; brainReadFails = false; forgetLeverOwners() })

describe('AB-5 — the lever the worker names at dispatch', () => {
  it('a negative\'s retire is the negatives lever; a keyword\'s status names only its field', async () => {
    const retire = await inside(() => updateAdTargetWithSync({ adTargetId: 'bl-neg', patch: { status: 'ARCHIVED' }, actor: RULE, reason: 'test', applyImmediately: true }))
    expect(retire.ok).toBe(true)
    await inside(() => drainAdsSyncOnce(10))
    expect(last()).toMatchObject({ campaignId: 'bl-c', fields: ['status'], dimension: 'negatives', actor: RULE })
    expect(last().portfolioId).toBeUndefined()

    handed.length = 0
    const pause = await inside(() => updateAdTargetWithSync({ adTargetId: 'bl-t', patch: { status: 'PAUSED' }, actor: RULE, reason: 'test', applyImmediately: true }))
    expect(pause.ok).toBe(true)
    await inside(() => drainAdsSyncOnce(10))
    expect(last()).toMatchObject({ campaignId: 'bl-c', fields: ['status'] })
    expect(last().dimension).toBeUndefined()
  })

  it('a portfolio\'s own write names its portfolio with no campaign, and the portfolio lever for its cap (not for a rename)', async () => {
    const cap = await inside(() => updatePortfolioWithSync({ portfolioId: 'bl-pf', patch: { budgetAmount: 300 }, actor: RULE, reason: 'test', applyImmediately: true }))
    expect(cap.ok).toBe(true)
    await inside(() => drainAdsSyncOnce(10))
    expect(last()).toMatchObject({ portfolioId: 'bl-pf', dimension: 'portfolio', fields: ['budgetAmount'] })
    expect(last().campaignId).toBeUndefined()

    handed.length = 0
    const rename = await inside(() => updatePortfolioWithSync({ portfolioId: 'bl-pf', patch: { name: 'bl-pf renamed' }, actor: RULE, reason: 'test', applyImmediately: true }))
    expect(rename.ok).toBe(true)
    await inside(() => drainAdsSyncOnce(10))
    expect(last()).toMatchObject({ portfolioId: 'bl-pf', fields: ['name'] })
    expect(last().dimension).toBeUndefined()
  })
})

describe('AB-5 — the pre-ask hands the gate what the worker hands it', () => {
  it('a deliberate pause (letsGo) is letting go at the pre-ask too; an unmarked pause is not', async () => {
    const marked = await inside(() => updateProductAdWithSync({ productAdId: 'bl-ad', status: 'PAUSED', actor: RULE, letsGo: true, askGate: true }))
    expect(marked.ok).toBe(false) // the canned refusal: nothing written
    expect(last()).toMatchObject({ campaignId: 'bl-c', fields: ['status'], isSuppression: true })
    await inside(() => updateProductAdWithSync({ productAdId: 'bl-ad', status: 'PAUSED', actor: RULE, askGate: true }))
    expect(last()).toMatchObject({ isSuppression: false })
    await inside(() => updateCampaignWithSync({ campaignId: 'bl-c', patch: { status: 'ARCHIVED' }, actor: 'user:owner', manual: true, letsGo: true, askGate: true }))
    expect(last()).toMatchObject({ campaignId: 'bl-c', isSuppression: true })
  })

  it('a negative\'s retire names the negatives lever, a portfolio\'s cap its portfolio with no campaign', async () => {
    await inside(() => updateAdTargetWithSync({ adTargetId: 'bl-neg', patch: { status: 'PAUSED' }, actor: RULE, reason: 'test', askGate: true }))
    expect(last()).toMatchObject({ campaignId: 'bl-c', dimension: 'negatives' })
    const cap = await inside(() => updatePortfolioWithSync({ portfolioId: 'bl-pf', patch: { budgetAmount: 250 }, actor: RULE, reason: 'test', askGate: true }))
    expect(cap.ok).toBe(false)
    expect(last()).toMatchObject({ portfolioId: 'bl-pf', dimension: 'portfolio', fields: ['budgetAmount'], payloadValueCents: 25_000 })
    expect(last().campaignId).toBeUndefined()
    // Refused at the pre-ask: Nexus's copy is unchanged.
    expect(Number((await database.client.amazonAdsPortfolio.findUnique({ where: { id: 'bl-pf' } }))?.budgetAmount)).not.toBe(250)
  })
})

describe('review of #523 — a failed read of the brain is never a SKIPPED write', () => {
  it('nothing enrolled and the enrollment read failing with no answer known: the row stays to be reclaimed and sent again', async () => {
    gateMode = 'real'
    const queued = await inside(() => updateCampaignWithSync({ campaignId: 'bl-c', patch: { dailyBudget: 25 }, actor: RULE, reason: 'test', applyImmediately: true }))
    expect(queued.ok).toBe(true)
    const id = queued.outboundQueueId!
    brainReadFails = true
    await expect(inside(() => drainAdsSyncOnce(10))).rejects.toThrow('db blip')
    // Not refused, not settled, not put back: left in flight for the reclaim, as any failed read in the gate always was.
    expect(await queueRow(id)).toMatchObject({ syncStatus: 'IN_PROGRESS', errorCode: null })
    expect(Number((await database.client.campaign.findUnique({ where: { id: 'bl-c' } }))?.dailyBudget)).toBe(25)
    expect(await database.client.adWriteRefusal.count({ where: { queueId: id } })).toBe(0)
    expect(last()).toMatchObject({ campaignId: 'bl-c', fields: ['dailyBudget'], actor: RULE })

    // The reclaim puts it back in line; once the read works the gate passes the same write (nothing is enrolled).
    const swept = await inside(() => reclaimCrashedAdWrites(new Date(Date.now() + RECLAIM_IN_PROGRESS_AFTER_MS + 60_000)))
    expect(swept.reclaimed).toBeGreaterThanOrEqual(1)
    expect(await queueRow(id)).toMatchObject({ syncStatus: 'PENDING' })
    brainReadFails = false
    const { checkAdsWriteGate } = await import('../services/advertising/ads-write-gate.js')
    expect(await inside(() => checkAdsWriteGate({ ...last() }))).toMatchObject({ allowed: true, mode: 'live' })
  })
})
