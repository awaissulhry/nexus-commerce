/**
 * 2026-10-07 — a queued ad write's own BullMQ job and the drain cron send it ONCE.
 *
 * In production every queued ad write logged "[ads-mutation] BullMQ enqueue failed (cron drain will handle)" with
 * "Custom Id cannot contain :" until #465 (00:27–01:51 UTC on the API, worker and scheduler): only the drain sent ad
 * writes. With a job id BullMQ accepts, both lanes are live, so this pins:
 *   1  the real enqueue asks BullMQ for an id it accepts ("ads-sync-<row>"), delayed by the row's own hold window
 *   2  inside the 5-minute window neither the drain nor a job that fires early sends it
 *   3  after the window the job sends it; the drain's next tick, and the job delivered again, send nothing more
 *   4  the job and the drain on the same due row at the same moment: one send — by the entity claim, and (the claim
 *      failing open) by the row's compare-and-set
 *
 * PGlite with the production schema. The gate allows everything (mode live); Amazon is a recorder, nothing leaves the
 * process. The BullMQ worker's processor is taken from a stand-in Worker. All ids are made up.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { Job } from 'bullmq'
import { formulaDatabase } from '../test-support/formula-database.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'
import type { GateDecision } from '../services/advertising/ads-write-gate.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', async () => {
  const { contextualDatabase } = await import('../lib/database-context.js')
  let wrapped: object | null = null
  return { default: new Proxy({}, { get: (_t, p) => Reflect.get((wrapped ??= contextualDatabase(database.client as never)), p) }) }
})
vi.mock('../services/outbound-destination.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  resolveDestinations: async (_db: unknown, rows: unknown[]) => rows.map(() => ({ connectionId: null, reason: 'NO_ACCOUNT' })),
}))
type Added = { name: string; data: { queueId: string; syncType: string }; opts: { jobId?: string; delay?: number }; at: number }
const queued = vi.hoisted(() => ({ adds: [] as Added[] }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  const adsSyncQueue = { ...queue, add: vi.fn(async (name: string, data: Added['data'], opts: Added['opts']) => { queued.adds.push({ name, data, opts, at: Date.now() }); return {} }) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() },
    getQueueStats: vi.fn(async () => ({})), initializeQueue: vi.fn(async () => true), closeQueue: vi.fn(async () => {}),
    getRedisRuntimeStatus: () => ({ configured: true, status: 'ready' }), resolveRedisTarget: vi.fn(), resetEnqueueCircuitForTests: vi.fn(),
    redis: { connection: {} },
  }
})
const worker = vi.hoisted(() => ({ processor: null as null | ((job: unknown) => Promise<{ status: string; queueId: string }>) }))
vi.mock('../lib/workspace-jobs.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  WorkspaceWorker: class {
    constructor(_name: string, processor: never) { worker.processor = processor }
    on() { return this }
    close() { return Promise.resolve() }
  },
}))
vi.mock('../services/advertising/ads-write-gate.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../services/advertising/ads-write-gate.js')>()),
  checkAdsWriteGate: async (): Promise<GateDecision> => ({ allowed: true, mode: 'live', profileId: 'P-IT-TEST' }),
  logGateDeny: () => undefined,
  recordSuccessfulWrite: async () => undefined,
  recordCampaignLiveWrite: async () => undefined,
}))
const amazon = vi.hoisted(() => ({ calls: [] as Array<{ externalId: string; patch: Record<string, unknown> }> }))
vi.mock('../services/advertising/ads-api-client.js', () => {
  const record = async (_ctx: unknown, externalId: string, patch: Record<string, unknown>) => {
    amazon.calls.push({ externalId, patch })
    return { ok: true, rawResponse: {} }
  }
  return { adsMode: () => 'live', updateCampaign: record, updateAdGroup: record, updateTarget: record, updateProductAd: record, updatePortfolio: record, archiveSpEntity: record }
})
// The moment both lanes hold the row as PENDING: after the first one read it and claimed the entity, before it takes
// the row. `meet` runs the other lane there; `claimFailsOpen` makes the entity claim fail open (its catch path).
const race = vi.hoisted(() => ({ meetIn: null as string | null, meet: null as null | (() => Promise<unknown>), met: null as unknown, claimFailsOpen: false }))
vi.mock('../services/advertising/ads-mutation.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../services/advertising/ads-mutation.service.js')>()
  return {
    ...real,
    claimEntityWrite: async (...args: Parameters<typeof real.claimEntityWrite>) => (race.claimFailsOpen ? true : real.claimEntityWrite(...args)),
    supersedeOlderWrites: async (queueId: string) => {
      if (race.meetIn === queueId && race.meet) {
        race.meetIn = null
        race.met = await race.meet()
      }
      return real.supersedeOlderWrites(queueId)
    },
  }
})

const { drainAdsSyncOnce, initializeAdsSyncWorker } = await import('./ads-sync.worker.js')
const { updateAdTargetWithSync } = await import('../services/advertising/ads-mutation.service.js')
const { adsSyncJobId } = await import('../lib/job-id.js')

const inside = <T>(work: () => Promise<T>) =>
  withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ACTOR = 'automation:job-drain-test-engine' as const

/** BullMQ's own check, offline (as lib/bullmq-job-ids.vitest.test.ts). */
function bullmqRefusal(jobId: string): string | null {
  const queue = { opts: {}, keys: {}, toKey: (key: string) => key, qualifiedName: 'bull:check', client: Promise.resolve({}) }
  try {
    const job = new Job(queue as never, 'check', {}, { jobId })
    ;(job as unknown as { validateOptions(data: unknown): void }).validateOptions(job.asJSON())
    return null
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
}

/** Queue a bid write as an engine does: with the grace window unless told otherwise. Returns the row and its job. */
async function queueBid(targetId: string, bidCents: number, applyImmediately = false) {
  const before = queued.adds.length
  const r = await inside(() => updateAdTargetWithSync({ adTargetId: targetId, patch: { bidCents }, actor: ACTOR, applyImmediately }))
  expect(r.ok, r.error ?? '').toBe(true)
  expect(queued.adds.length).toBe(before + 1)
  const added = queued.adds.at(-1)!
  return { id: r.outboundQueueId!, added, job: { id: added.opts.jobId, data: added.data } }
}
const rowOf = (id: string) => inside(() => database.client.outboundSyncQueue.findUniqueOrThrow({ where: { id }, select: { syncStatus: true, holdUntil: true } }))
const endWindow = (id: string) => inside(() => database.client.outboundSyncQueue.update({ where: { id }, data: { holdUntil: new Date(Date.now() - 1000) } }))
const runJob = (job: unknown) => inside(() => worker.processor!(job))

beforeAll(async () => {
  database = await formulaDatabase()
  initializeAdsSyncWorker()
  const db = database.client
  await inside(async () => {
    await db.campaign.create({
      data: {
        id: 'jd-c', name: 'jd-c', type: 'SP', adProduct: 'SPONSORED_PRODUCTS', marketplace: 'IT', externalCampaignId: 'EXT-jd-c',
        dailyBudget: '20.00', startDate: new Date('2026-01-01T00:00:00Z'), liveBidWritesEnabled: true,
      } as never,
    })
    await db.adGroup.create({ data: { id: 'jd-g', campaignId: 'jd-c', name: 'jd-g', externalAdGroupId: 'EXT-jd-g', defaultBidCents: 40 } as never })
    for (const id of ['jd-t1', 'jd-t2', 'jd-t3']) {
      await db.adTarget.create({ data: { id, adGroupId: 'jd-g', kind: 'KEYWORD', expressionType: 'EXACT', expressionValue: `kw ${id}`, bidCents: 35, externalTargetId: `EXT-${id}` } as never })
    }
  })
}, 180_000)
afterAll(async () => { await database?.close() })
beforeEach(() => { amazon.calls = []; race.meetIn = null; race.meet = null; race.met = null; race.claimFailsOpen = false })

describe('a queued ad write: its job and the drain send it once', () => {
  it('the enqueue asks BullMQ for an id it accepts, delayed by the row\'s hold; inside the window nothing is sent; after it, one send', async () => {
    const { id, added, job } = await queueBid('jd-t1', 50)
    expect(worker.processor).toBeTypeOf('function')
    expect(added.data).toEqual({ queueId: id, syncType: expect.any(String) })
    expect(added.opts.jobId).toBe(adsSyncJobId(id))
    expect(bullmqRefusal(added.opts.jobId!)).toBeNull()
    expect(bullmqRefusal(`w_${LEGACY_WORKSPACE_ID}_${added.opts.jobId}`)).toBeNull() // the business prefix WorkspaceQueue adds
    // The job is due when the row is: its delay ends at the row's holdUntil (the 5-minute cancel window).
    const held = (await rowOf(id)).holdUntil!.getTime()
    expect(added.opts.delay).toBeGreaterThan(0)
    expect(Math.abs(added.at + added.opts.delay! - held)).toBeLessThan(5_000)

    // Inside the window: the drain does not take it, and a job that fires early leaves it for later.
    expect((await inside(() => drainAdsSyncOnce(50))).results).toEqual([])
    await expect(runJob(job)).resolves.toEqual({ status: 'NOT_DUE', queueId: id })
    expect(amazon.calls).toEqual([])
    expect((await rowOf(id)).syncStatus).toBe('PENDING')

    // The window ends: the job sends it.
    await endWindow(id)
    await runJob(job)
    expect(amazon.calls.map((c) => c.externalId)).toEqual(['EXT-jd-t1'])
    expect((await rowOf(id)).syncStatus).toBe('SUCCESS')
    // The drain's next tick, and the same job delivered again (a stalled job), send nothing more.
    expect((await inside(() => drainAdsSyncOnce(50))).results).toEqual([])
    await expect(runJob(job)).resolves.toEqual({ status: 'SKIPPED', queueId: id })
    expect(amazon.calls).toHaveLength(1)
  })

  it('the drain sent it first: the job, when it fires, sends nothing', async () => {
    const { id, job } = await queueBid('jd-t2', 60, true)
    const out = await inside(() => drainAdsSyncOnce(50))
    expect(out.results).toEqual([{ status: expect.any(String), queueId: id }])
    expect(amazon.calls.map((c) => c.externalId)).toEqual(['EXT-jd-t2'])
    await expect(runJob(job)).resolves.toEqual({ status: 'SKIPPED', queueId: id })
    expect(amazon.calls).toHaveLength(1)
  })

  it('the job and the drain on one due row at the same moment: the entity claim lets one send', async () => {
    const { id, job } = await queueBid('jd-t3', 70)
    await endWindow(id)
    // The job read the row and claimed the entity; the drain arrives before the job takes the row.
    race.meetIn = id
    race.meet = () => inside(() => drainAdsSyncOnce(50))
    await runJob(job)
    expect(race.met).toMatchObject({ results: [{ status: 'DEFERRED', queueId: id }] })
    expect(amazon.calls.map((c) => c.externalId)).toEqual(['EXT-jd-t3'])
    expect((await rowOf(id)).syncStatus).toBe('SUCCESS')
  })

  it('the same moment with the entity claim failing open: the row\'s compare-and-set still lets only one send', async () => {
    const { id, job } = await queueBid('jd-t3', 75)
    await endWindow(id)
    race.claimFailsOpen = true
    race.meetIn = id
    race.meet = () => inside(() => drainAdsSyncOnce(50))
    // The drain, inside the job's gap, takes the row and sends it; the job then finds the row taken.
    await expect(runJob(job)).resolves.toEqual({ status: 'SKIPPED', queueId: id })
    expect(race.met).toMatchObject({ results: [{ queueId: id }] })
    expect(amazon.calls.map((c) => c.externalId)).toEqual(['EXT-jd-t3'])
    expect((await rowOf(id)).syncStatus).toBe('SUCCESS')
  })
})
