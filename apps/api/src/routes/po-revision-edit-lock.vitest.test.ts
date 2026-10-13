/**
 * PO revision editor — the optimistic lock on PATCH /fulfillment/purchase-orders/:id/revisions/:revisionId.
 *
 * 🔴 WHAT THIS GUARDS. The revision editor autosaves the whole proposed line list. With no version, a second tab (or a
 * save that left before another one came back) silently overwrote the other's edits. `snapshotJson.editVersion` now
 * counts saved edits: the editor sends the editVersion its last save returned, and a stale one answers 409 with the
 * current editVersion, leaving the stored revision as it was. A body without editVersion (an older tab) still saves.
 *
 * Real PostgreSQL in-process (PGlite), the real fulfilment routes through Fastify inject. Every id is invented.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))
vi.mock('../lib/queue.js', () => {
  const queue = { add: vi.fn(async () => ({})), addBulk: vi.fn(async () => []), getJob: vi.fn(async () => null), getJobCounts: vi.fn(async () => ({})) }
  return {
    addJobSafely: vi.fn(async () => ({ enqueued: false, skipped: true })),
    outboundSyncQueue: queue, channelSyncQueue: queue, readCacheQueue: queue, searchIndexQueue: queue, bulkJobQueue: queue, adsSyncQueue: queue,
    queueEvents: { on: vi.fn() }, channelSyncQueueEvents: { on: vi.fn() }, redis: { connection: null },
  }
})
vi.mock('../services/po-events.service.js', () => ({
  publishPoEvent: () => {},
  subscribePoEvents: () => () => {},
  getPoListenerCount: () => 0,
  startPoEventIntake: async () => {},
  stopPoEventIntake: async () => {},
}))

import { LEGACY_WORKSPACE_ID, withWorkspace } from '../lib/workspace-context.js'

const BUSINESS = { workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }
const scoped = <T>(work: () => Promise<T>) => withWorkspace(BUSINESS, work)
let app: FastifyInstance
const db = () => database.client

beforeAll(async () => {
  database = await formulaDatabase()
  app = Fastify()
  app.addHook('onRequest', (_request, _reply, done) => { withWorkspace(BUSINESS, done) })
  await app.register((await import('./fulfillment.routes.js')).default, { prefix: '/api' })
  await app.ready()
}, 180_000)
afterAll(async () => { await app?.close(); await database?.close() }, 60_000)

const line = (sku: string, quantityOrdered: number, unitCostCents = 500) =>
  ({ productId: null, supplierSku: null, sku, quantityOrdered, unitCostCents, note: null })

/** A sent PO with one line and an open (PENDING) revision on it. */
async function openRevision(tag: string) {
  const po = await scoped(() => db().purchaseOrder.create({
    data: {
      poNumber: `PO-TEST-REV-${tag}`, status: 'SUBMITTED', totalCents: 5000,
      items: { create: [{ sku: `SKU-${tag}`, quantityOrdered: 10, unitCostCents: 500 }] },
    },
  }))
  const res = await app.inject({ method: 'POST', url: `/api/fulfillment/purchase-orders/${po.id}/revisions`, payload: {} })
  expect(res.statusCode, res.body).toBe(200)
  return { poId: po.id, revisionId: res.json().id as string, sku: `SKU-${tag}` }
}

const patch = (rev: { poId: string; revisionId: string }, payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: `/api/fulfillment/purchase-orders/${rev.poId}/revisions/${rev.revisionId}`, payload })
const stored = (revisionId: string) =>
  scoped(() => db().purchaseOrderRevision.findUniqueOrThrow({ where: { id: revisionId }, select: { snapshotJson: true, reason: true } }))

describe('revision PATCH — editVersion', () => {
  it('🔴 each save returns the next editVersion, and a save carrying it goes through', async () => {
    const rev = await openRevision('a')
    const first = await patch(rev, { items: [line(rev.sku, 12)], reason: 'price', editVersion: 0 })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().snapshotJson).toMatchObject({ editVersion: 1, after: [{ quantityOrdered: 12 }] })

    const second = await patch(rev, { items: [line(rev.sku, 14)], reason: 'price', editVersion: 1 })
    expect(second.statusCode, second.body).toBe(200)
    expect(second.json().snapshotJson).toMatchObject({ editVersion: 2, after: [{ quantityOrdered: 14 }], afterTotalCents: 7000 })
  })

  it('🔴 a stale editVersion answers 409 with the current one and leaves the revision as it was', async () => {
    const rev = await openRevision('b')
    expect((await patch(rev, { items: [line(rev.sku, 20)], reason: 'tab one', editVersion: 0 })).statusCode).toBe(200)

    // A second tab still holding editVersion 0.
    const late = await patch(rev, { items: [line(rev.sku, 3)], reason: 'tab two', editVersion: 0 })
    expect(late.statusCode, late.body).toBe(409)
    expect(late.json()).toMatchObject({ current: { id: rev.revisionId, editVersion: 1 } })

    const after = await stored(rev.revisionId)
    expect(after.reason).toBe('tab one')
    expect(after.snapshotJson).toMatchObject({ editVersion: 1, after: [{ quantityOrdered: 20 }] })
  })

  it('a body without editVersion (an older tab) still saves and still bumps it', async () => {
    const rev = await openRevision('c')
    const res = await patch(rev, { items: [line(rev.sku, 7)] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().snapshotJson).toMatchObject({ editVersion: 1, after: [{ quantityOrdered: 7 }] })
  })

  it('apply still commits the saved lines (editVersion rides along in the snapshot only)', async () => {
    const rev = await openRevision('d')
    expect((await patch(rev, { items: [line(rev.sku, 9, 600)], editVersion: 0 })).statusCode).toBe(200)
    const applied = await app.inject({ method: 'POST', url: `/api/fulfillment/purchase-orders/${rev.poId}/revisions/${rev.revisionId}/apply` })
    expect(applied.statusCode, applied.body).toBe(200)
    const po = await scoped(() => db().purchaseOrder.findUniqueOrThrow({ where: { id: rev.poId }, include: { items: true } }))
    expect(po.totalCents).toBe(5400)
    expect(po.items.map((it) => [it.sku, it.quantityOrdered, it.unitCostCents])).toEqual([[rev.sku, 9, 600]])
  })
})
