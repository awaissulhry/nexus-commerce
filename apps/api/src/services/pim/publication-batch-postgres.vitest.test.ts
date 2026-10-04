import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Sheet publish parity, step 5 (item 3) — publication batches under real concurrency (real PostgreSQL, many connections,
 * the runtime role and row security). PGlite has one connection, so it cannot show these races.
 *
 *   - Two senders start one batch at the same moment: exactly one claims it, and every destination is sent once.
 *   - A cancel races a sender: every destination ends sent OR cancelled, never both, never left waiting.
 *   - Two people (two tabs) start a batch from the same reviews at once: one batch wins, the other is refused, and no
 *     review belongs to two batches.
 */
const state = vi.hoisted(() => ({ db: null as any, queued: [] as string[] }))
vi.mock('@nexus/database', () => ({
  default: new Proxy({}, { get: (_target, property) => {
    const client = state.db?.client
    if (!client) throw new Error(`publication-batch-postgres: no database (needs NEXUS_TEST_CONCURRENT_PG_URL); read "${String(property)}"`)
    const value = client[property]
    return typeof value === 'function' ? value.bind(client) : value
  } }),
}))
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => {} }))
// A created batch is queued (recorded here), not run: each race below starts its own senders.
vi.mock('../../lib/queue.js', () => ({ publicationBatchQueue: { add: async (_name: string, data: { batchId: string }) => { state.queued.push(data.batchId) } } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { CONCURRENT_PG_ENV, concurrentDatabase, concurrentDatabaseUrl } from '../../test-support/concurrent-database.js'
import { BATCH_HEARTBEAT_MS, BATCH_KIND, runPublicationBatch } from './publication-batch.processor.js'
import { cancelPublicationBatch, createPublicationBatch } from './publication-batch.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const USER = 'race-user'
let counter = 0

async function reviews(count: number, batchId: string | null = null) {
  const prefix = `race-${++counter}`
  const ids: string[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `${prefix}-${i}`
    ids.push(id)
    await prisma.bulkOperation.create({ data: { id, userId: USER, status: 'PREVIEW', productCount: 1, changeCount: 1, kind: 'studio-publication',
      productId: 'family', channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: `shop-${i % 2}`, aliasKey: '', batchId,
      expiresAt: new Date(Date.now() + 3_600_000),
      changes: { kind: 'studio-publication', productId: 'family', publicationKey: id, scope: { channel: 'SHOPIFY', marketplace: 'GLOBAL', accountId: `shop-${i % 2}` },
        ...(batchId ? { batch: { batchId, body: {} } } : {}) } } as never })
  }
  return ids
}

async function header(ids: string[]) {
  const batchId = `batch-${++counter}`
  await prisma.bulkOperation.updateMany({ where: { id: { in: ids } }, data: { batchId } })
  await prisma.bulkOperation.create({ data: { id: batchId, userId: USER, status: 'QUEUED', kind: BATCH_KIND, productCount: ids.length, changeCount: 0, checkCount: 0,
    nextCheckAt: new Date(Date.now() + BATCH_HEARTBEAT_MS), changes: { kind: BATCH_KIND, children: ids, cancelRequestedAt: null } } as never })
  return batchId
}

/** Claims each review like the real submit (PREVIEW → ACCEPTED, compare-and-set) and counts every call. */
function countingSubmit() {
  const calls = new Map<string, number>()
  const submit = async (_productId: string, id: string) => {
    calls.set(id, (calls.get(id) ?? 0) + 1)
    await new Promise(resolve => setTimeout(resolve, 5))
    const moved = await prisma.bulkOperation.updateMany({ where: { id, status: 'PREVIEW' }, data: { status: 'ACCEPTED' } })
    if (!moved.count) throw new Error(`${id} was sent twice`)
    return {}
  }
  return { calls, submit }
}

describe.skipIf(!concurrentDatabaseUrl())(`publication batches under real concurrency (needs ${CONCURRENT_PG_ENV})`, () => {
  beforeAll(async () => { state.db = await concurrentDatabase({ maxConnections: 12 }) }, 120_000)
  afterAll(async () => { await state.db?.close() }, 60_000)

  it('two senders start one batch at once: one claims it and every destination is sent exactly once', () => scoped(async () => {
    for (let round = 0; round < 5; round += 1) {
      const ids = await reviews(4)
      const batchId = await header(ids)
      const { calls, submit } = countingSubmit()
      const [a, b] = await Promise.all([runPublicationBatch(batchId, { submit }), runPublicationBatch(batchId, { submit })])
      expect([a.claimed, b.claimed].filter(Boolean)).toHaveLength(1)
      expect([...calls.values()]).toEqual([1, 1, 1, 1])
      expect(new Set((await prisma.bulkOperation.findMany({ where: { id: { in: ids } } })).map(r => r.status))).toEqual(new Set(['ACCEPTED']))
      expect(await prisma.bulkOperation.findUnique({ where: { id: batchId } })).toMatchObject({ status: 'SENT' })
    }
  }))

  it('a cancel racing a sender leaves every destination sent or cancelled, never both and never waiting', () => scoped(async () => {
    for (let round = 0; round < 5; round += 1) {
      const ids = await reviews(4)
      const batchId = await header(ids)
      const { calls, submit } = countingSubmit()
      await Promise.all([runPublicationBatch(batchId, { submit }), cancelPublicationBatch(batchId, USER).catch(() => null)])
      // A cancel that arrived while sending asks the sender to stop; the sender finishes the batch itself.
      const rows = await prisma.bulkOperation.findMany({ where: { id: { in: ids } } })
      const accepted = rows.filter(r => r.status === 'ACCEPTED').map(r => r.id)
      const cancelled = rows.filter(r => r.status === 'CANCELLED').map(r => r.id)
      expect(accepted.length + cancelled.length).toBe(ids.length)
      expect([...calls.keys()].sort()).toEqual(accepted.sort())
      expect([...calls.values()].every(n => n === 1)).toBe(true)
      expect(['SENT', 'CANCELLED']).toContain((await prisma.bulkOperation.findUnique({ where: { id: batchId } }))!.status)
    }
  }))

  it('two batches started from the same reviews at once: one wins, the other is refused, no review is in two batches', () => scoped(async () => {
    const ids = await reviews(3)
    const body = { reviews: ids.map(reviewId => ({ reviewId })) }
    process.env.ENABLE_QUEUE_WORKERS = '1'
    try {
      const outcomes = await Promise.allSettled([createPublicationBatch(body, USER), createPublicationBatch(body, USER)])
      const won = outcomes.filter((o): o is PromiseFulfilledResult<{ batchId: string }> => o.status === 'fulfilled')
      expect(won).toHaveLength(1)
      expect((outcomes.find(o => o.status === 'rejected') as PromiseRejectedResult).reason).toMatchObject({ statusCode: 409 })
      const rows = await prisma.bulkOperation.findMany({ where: { id: { in: ids } } })
      expect(new Set(rows.map(r => r.batchId))).toEqual(new Set([won[0].value.batchId]))
      expect(await prisma.bulkOperation.count({ where: { kind: BATCH_KIND, changes: { path: ['children'], array_contains: [ids[0]] } } })).toBe(1)
      expect(state.queued).toContain(won[0].value.batchId)
    } finally { delete process.env.ENABLE_QUEUE_WORKERS }
  }))
})
