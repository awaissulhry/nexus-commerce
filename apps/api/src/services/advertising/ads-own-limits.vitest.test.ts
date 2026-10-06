/**
 * 3A (Owner decided 2026-10-06) — HIS limits warn, they never block HIS OWN edits.
 *
 * A person's write (the routes' manual mark + a `user:` actor) past one of his own limits writes nothing and answers
 * "needs confirmation" with every limit it passes; the same write sent again with `confirmOwnLimits` is written, queued
 * with the confirm, reaches Amazon through the worker's own gate, and the action log says "sent past <limit> by
 * <person>". An engine's write past the same limit is refused as before. Amazon's own range refuses him, confirm or not.
 *
 * Real mutation + create services, the real write gate in LIVE mode and the real worker, on PGlite (production schema)
 * with the shared fake ads account (c-it on the live-write allowlist). Amazon is a recorder; nothing leaves the process.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { seedAdsFixture } from '../../test-support/ads-fixtures.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', async () => {
  const { contextualDatabase } = await import('../../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
// On PGlite's single connection the queue row's account lookup cannot run beside the open enqueue transaction.
vi.mock('../outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
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
vi.mock('./ads-automation-notify.service.js', async (importOriginal) => ({ ...(await importOriginal<object>()), notifyAutomation: async () => 0 }))

/** Amazon, as a recorder. */
const amz = vi.hoisted(() => ({ calls: [] as Array<{ kind: string; externalId?: string; input: Record<string, unknown> }>, n: 0 }))
vi.mock('./ads-api-client.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('./ads-api-client.js')>()
  const update = (kind: string) => async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amz.calls.push({ kind, externalId, input: patch })
    return { ok: true, mode: 'live', rawResponse: {} }
  }
  const create = (kind: string) => async (_ctx: unknown, input: Record<string, unknown>) => {
    amz.calls.push({ kind, input })
    return { ok: true, mode: 'live', externalId: `AMZ-${++amz.n}`, rawResponse: {}, error: null }
  }
  return {
    ...real,
    adsMode: () => 'live',
    updateCampaign: update('updateCampaign'), updateAdGroup: update('updateAdGroup'), updateTarget: update('updateTarget'),
    createKeyword: create('createKeyword'), createTarget: create('createTarget'),
  }
})

const { updateCampaignWithSync, updateAdTargetWithSync } = await import('./ads-mutation.service.js')
const { createKeywordLocal } = await import('./ads-create.service.js')
const { drainAdsSyncOnce } = await import('../../workers/ads-sync.worker.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const db = () => database.client
const OWNER = 'user:owner-test' as const
const ENGINE = 'automation:rule-test' as const

const budgetOf = async () => Number((await inside(() => db().campaign.findUniqueOrThrow({ where: { id: 'c-it' }, select: { dailyBudget: true } }))).dailyBudget)
const queueRow = (id: string) => inside(() => db().outboundSyncQueue.findUniqueOrThrow({ where: { id }, select: { payload: true, syncStatus: true, errorMessage: true } }))
const logRow = (id: string) => inside(() => db().advertisingActionLog.findUniqueOrThrow({ where: { id }, select: { evidence: true, userId: true } }))
const setBounds = (data: { maxBudgetCents?: number | null; maxBidCents?: number | null }) =>
  inside(() => db().campaign.update({ where: { id: 'c-it' }, data }))

beforeAll(async () => {
  database = await formulaDatabase()
  await inside(() => seedAdsFixture(database.client))
}, 180_000)
afterAll(async () => { vi.unstubAllEnvs(); await database?.close() }, 30_000)
beforeEach(() => {
  vi.stubEnv('NEXUS_AMAZON_ADS_MODE', 'live')
  amz.calls = []
})
afterEach(async () => {
  await setBounds({ maxBudgetCents: null, maxBidCents: null })
  await inside(() => db().campaign.update({ where: { id: 'c-it' }, data: { dailyBudget: '20.00' } }))
})

describe('3A — a person past his own budget limit', () => {
  it('without his confirm: nothing written, no queue row, and the answer names the limit', async () => {
    await setBounds({ maxBudgetCents: 3_000 }) // €30 ceiling
    const queued = await inside(() => db().outboundSyncQueue.count())
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 40 }, actor: OWNER, manual: true, askGate: true }))
    expect(r.ok).toBe(false)
    expect(r.needsConfirmation?.limits.map((l) => l.limit)).toContain('entity_bounds')
    expect(r.error).toContain('you can send it anyway')
    expect(await budgetOf()).toBe(20)
    expect(await inside(() => db().outboundSyncQueue.count())).toBe(queued)
  })

  it('with his confirm: written, queued with the confirm, sent by the worker, and logged "sent past … by <person>"', async () => {
    await setBounds({ maxBudgetCents: 3_000 })
    const r = await inside(() => updateCampaignWithSync({
      campaignId: 'c-it', patch: { dailyBudget: 40 }, actor: OWNER, manual: true, askGate: true, confirmOwnLimits: true, applyImmediately: true,
    }))
    expect(r.ok).toBe(true)
    expect(await budgetOf()).toBe(40)
    const row = await queueRow(r.outboundQueueId!)
    expect(row.payload).toMatchObject({ manual: true, confirmOwnLimits: true })
    const log = await logRow(r.actionLogId!)
    expect((log.evidence as { sentPastOwnLimits?: string }).sentPastOwnLimits).toMatch(/^sent past your bid or budget limit.* by user:owner-test: /)

    // The worker asks the real gate again at dispatch, with the confirm off the queue row: it goes to Amazon.
    await inside(() => drainAdsSyncOnce(50))
    expect((await queueRow(r.outboundQueueId!)).syncStatus).toBe('SUCCESS')
    expect(amz.calls.filter((c) => c.kind === 'updateCampaign')).toHaveLength(1)
  })

  it('an engine past the same limit is refused, and a confirm flag on its write changes nothing', async () => {
    await setBounds({ maxBudgetCents: 3_000 })
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 40 }, actor: ENGINE, confirmOwnLimits: true }))
    expect(r.ok).toBe(false)
    expect(r.needsConfirmation).toBeUndefined()
    expect(r.error).toMatch(/budget|ceiling/i)
    expect(await budgetOf()).toBe(20)
  })

  it('the manual mark with an engine\'s actor is not a person: refused, not asked', async () => {
    await setBounds({ maxBudgetCents: 3_000 })
    const r = await inside(() => updateCampaignWithSync({ campaignId: 'c-it', patch: { dailyBudget: 40 }, actor: ENGINE, manual: true, askGate: true, confirmOwnLimits: true }))
    expect(r.ok).toBe(false)
    expect(r.needsConfirmation).toBeUndefined()
  })
})

describe('3A — a person past his own bid limit', () => {
  it('a bid edit asks, then goes with his confirm', async () => {
    await setBounds({ maxBidCents: 100 })
    const ask = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 150 }, actor: OWNER, manual: true, askGate: true }))
    expect(ask.needsConfirmation?.limits.map((l) => l.limit)).toEqual(['entity_bounds'])
    const sent = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 150 }, actor: OWNER, manual: true, askGate: true, confirmOwnLimits: true }))
    expect(sent.ok).toBe(true)
    expect((await logRow(sent.actionLogId!)).evidence).toMatchObject({ sentPastOwnLimits: expect.stringContaining('by user:owner-test') })
  })

  it('Amazon\'s own range refuses him even with his confirm — it is not his limit', async () => {
    const r = await inside(() => updateAdTargetWithSync({ adTargetId: 't-it', patch: { bidCents: 1 }, actor: OWNER, manual: true, askGate: true, confirmOwnLimits: true }))
    expect(r.ok).toBe(false)
    expect(r.needsConfirmation).toBeUndefined()
    expect(r.error).toMatch(/Amazon's minimum/)
  })

  it('a keyword he adds past his bid limit asks first; with his confirm it is created and the audit says so', async () => {
    await setBounds({ maxBidCents: 100 })
    const ask = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'own limit add', matchType: 'EXACT', bidEur: 1.5, requireAmazon: true, manual: true, userId: 'user:u-1' }))
    expect(ask).toMatchObject({ ok: false, outcome: 'needs_confirmation', id: null })
    expect(ask.needsConfirmation?.limits.map((l) => l.limit)).toEqual(['entity_bounds'])
    expect(amz.calls).toEqual([])

    const engine = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'own limit engine', matchType: 'EXACT', bidEur: 1.5, userId: 'automation:rule-1', confirmOwnLimits: true }))
    expect(engine.externalTargetId).toBeNull()
    expect(engine.denied).toMatchObject({ deniedAt: 'entity_bounds' })
    expect(amz.calls).toEqual([])

    const sent = await inside(() => createKeywordLocal({ adGroupId: 'g-c-it', keywordText: 'own limit add', matchType: 'EXACT', bidEur: 1.5, requireAmazon: true, manual: true, userId: 'user:u-1', confirmOwnLimits: true }))
    expect(sent).toMatchObject({ ok: true, outcome: 'created' })
    const audit = await inside(() => db().advertisingActionLog.findFirstOrThrow({ where: { actionType: 'create_keyword', entityId: sent.id! }, select: { evidence: true } }))
    expect(audit.evidence).toMatchObject({ sentPastOwnLimits: expect.stringMatching(/^sent past your bid or budget limit by user:u-1: /) })
  })
})
