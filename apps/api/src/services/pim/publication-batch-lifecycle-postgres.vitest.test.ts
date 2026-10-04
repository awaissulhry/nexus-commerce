import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, build shape v2, P6 — the lifecycle children of a mixed Publish under real concurrency (real
 * PostgreSQL, many connections, the runtime role and row security). PGlite has one connection, so it cannot show these.
 *
 *   - Two resumes of one stopped batch start at the same moment: one claims the header, and every lifecycle child is
 *     sent exactly once.
 *   - Two runs that BOTH got past the header (the first one's lease looked stale while it was still sending): the
 *     engine's own claim (PREVIEW → RUNNING) lets only one of them send each child; the other skips it or waits for it.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`publication-batch-lifecycle-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => {} }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, LIFECYCLE_KIND, runPublicationBatch } from './publication-batch.processor.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'lifecycle-race-user'
const ACTIONS = ['resume', 'pause', 'end', 'delete']
let counter = 0

/** A stopped batch (RUNNING, heartbeat stale) with `count` lifecycle children waiting, on two channel accounts. */
async function stoppedBatch(count: number) {
  const batchId = `lifecycle-race-${++counter}`
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `${batchId}-${i}`
    const account = `acc-${i % 2}`
    ids.push(id)
    await prisma.bulkOperation.create({ data: { id, userId: USER, status: 'PREVIEW', productCount: 1, changeCount: 1, kind: LIFECYCLE_KIND, productId: 'family',
      channel: 'AMAZON', marketplace: 'IT', channelConnectionId: account, aliasKey: '', batchId, expiresAt: new Date(Date.now() + 3_600_000),
      changes: { kind: LIFECYCLE_KIND, action: ACTIONS[i % ACTIONS.length], requested: null, preview: {}, batch: { batchId, step: ACTIONS[i % ACTIONS.length], values: [] } } } as never })
  }
  await prisma.bulkOperation.create({ data: { id: batchId, userId: USER, status: 'RUNNING', kind: BATCH_KIND, productCount: ids.length, changeCount: 0, checkCount: 1,
    nextCheckAt: new Date(Date.now() - 1_000), changes: { kind: BATCH_KIND, stage: 'send', children: ids, cancelRequestedAt: null } } as never })
  return { batchId, ids }
}

/** Claims each child like the real engine (PREVIEW → RUNNING, compare-and-set; else 409), then stores DONE. Counts every send. */
function countingExecute(during?: (id: string) => Promise<void>) {
  const sends = new Map<string, number>()
  const execute = async (previewId: string) => {
    const claimed = await prisma.bulkOperation.updateMany({ where: { id: previewId, status: 'PREVIEW' }, data: { status: 'RUNNING' } })
    if (!claimed.count) throw Object.assign(new Error('This change was already sent. Open it again to see its result.'), { statusCode: 409 })
    sends.set(previewId, (sends.get(previewId) ?? 0) + 1)
    await during?.(previewId)
    await new Promise(resolve => setTimeout(resolve, 5))
    await prisma.bulkOperation.update({ where: { id: previewId }, data: { status: 'DONE', completedAt: new Date() } })
    return { previewId, action: 'pause' as const, status: 'DONE' as const, message: 'done', rows: [] }
  }
  return { sends, execute }
}

const deps = (execute: ReturnType<typeof countingExecute>['execute']) => ({ execute, gate: () => null, settleValues: async () => undefined })

describe.skipIf(!concurrentDatabaseUrl())(`lifecycle children under real concurrency (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => { state.db = await concurrentDatabase({ maxConnections: 12 }) }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('two resumes of one stopped batch at once: one claims it, and every lifecycle child is sent exactly once', () => scoped(async () => {
    for (let round = 0; round < 5; round += 1) {
      const { batchId, ids } = await stoppedBatch(6)
      const { sends, execute } = countingExecute()
      const [a, b] = await Promise.all([runPublicationBatch(batchId, deps(execute)), runPublicationBatch(batchId, deps(execute))])
      expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1)
      expect(ids.map(id => sends.get(id) ?? 0)).toEqual(ids.map(() => 1))
      expect(new Set((await prisma.bulkOperation.findMany({ where: { id: { in: ids } } })).map(r => r.status))).toEqual(new Set(['DONE']))
      expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'SENT' })
    }
  }))

  it('two runs past the header at once (a lease that looked stale): the engine\'s claim sends each child once', () => scoped(async () => {
    for (let round = 0; round < 5; round += 1) {
      const { batchId, ids } = await stoppedBatch(6)
      let second: Promise<unknown> | null = null
      const { sends, execute } = countingExecute(async () => {
        // While the first run sends its first child, its header lease is made to look stale and a second run starts.
        if (second) return
        await prisma.bulkOperation.updateMany({ where: { id: batchId }, data: { nextCheckAt: new Date(Date.now() - BATCH_HEARTBEAT_MS) } })
        second = runPublicationBatch(batchId, deps(execute))
      })
      await runPublicationBatch(batchId, deps(execute))
      await second
      expect(ids.map(id => sends.get(id) ?? 0)).toEqual(ids.map(() => 1))
      expect(new Set((await prisma.bulkOperation.findMany({ where: { id: { in: ids } } })).map(r => r.status))).toEqual(new Set(['DONE']))
    }
  }))
})
