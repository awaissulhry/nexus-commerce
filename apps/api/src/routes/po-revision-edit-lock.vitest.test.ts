/**
 * PO editors — what their saves may overwrite.
 *
 * 🔴 WHAT THIS GUARDS.
 *   - Revision PATCH: the revision editor autosaves the whole proposed line list. With no version, a second tab (or a
 *     save that left before another one came back) silently overwrote the other's edits. `snapshotJson.editVersion`
 *     counts saved edits: the editor sends the editVersion its last save returned, and a stale one answers 409 with
 *     the current editVersion, leaving the stored revision as it was. A body without editVersion still saves.
 *   - Revision apply: it applies exactly the copy it read — a save that lands in between answers 409 and the PO keeps
 *     its lines (it used to get the older lines while the revision showed the newer ones).
 *   - Lines PATCH (draft editor) and apply: a line's factory naming (factoryName / factorySize / factorySpec) is kept
 *     when the save does not send it; an explicit null clears it. Every draft-editor save used to wipe it.
 *
 * Real PostgreSQL in-process (PGlite), the real fulfilment routes through Fastify inject. Every id is invented.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import Fastify, { type FastifyInstance } from 'fastify'
import { formulaDatabase } from '../test-support/formula-database.js'

let database: Awaited<ReturnType<typeof formulaDatabase>>
// Lets one test run a write right after the route reads a revision (another tab's save landing in between).
const race = vi.hoisted(() => ({ afterRevisionRead: null as null | ((row: any) => Promise<void>) }))
vi.mock('../db.js', () => ({
  default: new Proxy({}, {
    get: (_target, property) => {
      const real = Reflect.get(database.client, property)
      if (property !== 'purchaseOrderRevision' || !race.afterRevisionRead) return real
      const hook = race.afterRevisionRead
      return new Proxy(real, {
        get: (delegate, method) => method !== 'findUnique' ? Reflect.get(delegate, method) : async (args: unknown) => {
          const row = await delegate.findUnique(args)
          race.afterRevisionRead = null
          await hook(row)
          return row
        },
      })
    },
  }),
}))
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
afterEach(() => { race.afterRevisionRead = null })

const line = (sku: string, quantityOrdered: number, unitCostCents = 500) =>
  ({ productId: null, supplierSku: null, sku, quantityOrdered, unitCostCents, note: null })

const NAMING = { factoryName: 'Giacca Factory', factorySize: 'XL', factorySpec: 'spec A' }

/** A sent PO with one line (factory naming on it) and an open (PENDING) revision on it. */
async function openRevision(tag: string) {
  const po = await scoped(() => db().purchaseOrder.create({
    data: {
      poNumber: `PO-TEST-REV-${tag}`, status: 'SUBMITTED', totalCents: 5000,
      items: { create: [{ sku: `SKU-${tag}`, quantityOrdered: 10, unitCostCents: 500, ...NAMING }] },
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

  it('answers the copy it wrote, reason included', async () => {
    const rev = await openRevision('e')
    const res = await patch(rev, { items: [line(rev.sku, 11)], reason: '  supplier short  ', editVersion: 0 })
    expect(res.statusCode, res.body).toBe(200)
    const after = await stored(rev.revisionId)
    expect(res.json()).toMatchObject({ id: rev.revisionId, reason: 'supplier short', snapshotJson: after.snapshotJson })
  })

  it('a body without editVersion (an older tab) still saves and still bumps it', async () => {
    const rev = await openRevision('c')
    const res = await patch(rev, { items: [line(rev.sku, 7)] })
    expect(res.statusCode, res.body).toBe(200)
    expect(res.json().snapshotJson).toMatchObject({ editVersion: 1, after: [{ quantityOrdered: 7 }] })
  })

})

const apply = (rev: { poId: string; revisionId: string }) =>
  app.inject({ method: 'POST', url: `/api/fulfillment/purchase-orders/${rev.poId}/revisions/${rev.revisionId}/apply` })
const poLines = (poId: string) =>
  scoped(() => db().purchaseOrder.findUniqueOrThrow({ where: { id: poId }, include: { items: { orderBy: { lineOrder: 'asc' } } } }))

describe('revision apply', () => {
  it('commits the saved lines, and each line keeps the factory naming stored for its SKU', async () => {
    const rev = await openRevision('d')
    expect((await patch(rev, { items: [line(rev.sku, 9, 600), line('SKU-d-new', 1, 100)], editVersion: 0 })).statusCode).toBe(200)
    const applied = await apply(rev)
    expect(applied.statusCode, applied.body).toBe(200)
    const po = await poLines(rev.poId)
    expect(po.totalCents).toBe(5500)
    expect(po.items.map((it) => [it.sku, it.quantityOrdered, it.unitCostCents, it.factoryName, it.factorySize, it.factorySpec])).toEqual([
      [rev.sku, 9, 600, NAMING.factoryName, NAMING.factorySize, NAMING.factorySpec],
      ['SKU-d-new', 1, 100, null, null, null],
    ])
  })

  it('🔴 a save that lands between the read and the write answers 409; the PO keeps its lines and the revision stays open', async () => {
    const rev = await openRevision('f')
    expect((await patch(rev, { items: [line(rev.sku, 15)], editVersion: 0 })).statusCode).toBe(200)
    race.afterRevisionRead = async (row) => {
      // Another tab's save, after apply read the copy with quantity 15.
      await scoped(() => db().purchaseOrderRevision.update({
        where: { id: row.id },
        data: { snapshotJson: { ...row.snapshotJson, after: [line(rev.sku, 30)], afterTotalCents: 15000, editVersion: 2 } },
      }))
    }
    const applied = await apply(rev)
    expect(applied.statusCode, applied.body).toBe(409)
    expect(applied.json()).toMatchObject({ current: { id: rev.revisionId, status: 'PENDING', editVersion: 2 } })
    const po = await poLines(rev.poId)
    expect(po.items.map((it) => it.quantityOrdered)).toEqual([10])
    expect(po.totalCents).toBe(5000)
    // Applying again applies the copy the revision shows now.
    expect((await apply(rev)).statusCode).toBe(200)
    expect((await poLines(rev.poId)).items.map((it) => it.quantityOrdered)).toEqual([30])
  })
})

describe('lines PATCH (draft editor) — factory naming', () => {
  async function draftPo(tag: string) {
    return scoped(() => db().purchaseOrder.create({
      data: {
        poNumber: `PO-TEST-LINES-${tag}`, status: 'DRAFT', totalCents: 0,
        items: { create: [
          { sku: `A-${tag}`, quantityOrdered: 1, unitCostCents: 100, lineOrder: 0, ...NAMING },
          { sku: `B-${tag}`, quantityOrdered: 2, unitCostCents: 100, lineOrder: 1, factoryName: 'B Factory', factorySize: null, factorySpec: 'spec B' },
        ] },
      },
    }))
  }
  const savePo = (poId: string, version: number, items: unknown[]) =>
    app.inject({ method: 'PATCH', url: `/api/fulfillment/purchase-orders/${poId}/lines`, payload: { version, items } })
  const naming = async (poId: string) =>
    (await poLines(poId)).items.map((it) => [it.sku, it.quantityOrdered, it.factoryName, it.factorySize, it.factorySpec])

  it('🔴 a save that does not send it (the draft editor) keeps each line\'s factory naming, reordered too', async () => {
    const po = await draftPo('k')
    const res = await savePo(po.id, po.version, [
      { productId: null, sku: 'B-k', supplierSku: null, quantityOrdered: 5, unitCostCents: 100, note: null, lineOrder: 0 },
      { productId: null, sku: 'A-k', supplierSku: null, quantityOrdered: 4, unitCostCents: 100, note: null, lineOrder: 1 },
      { productId: null, sku: 'C-k', supplierSku: null, quantityOrdered: 1, unitCostCents: 100, note: null, lineOrder: 2 },
    ])
    expect(res.statusCode, res.body).toBe(200)
    expect(await naming(po.id)).toEqual([
      ['B-k', 5, 'B Factory', null, 'spec B'],
      ['A-k', 4, NAMING.factoryName, NAMING.factorySize, NAMING.factorySpec],
      ['C-k', 1, null, null, null],
    ])
  })

  it('an explicit value replaces it and an explicit null clears it', async () => {
    const po = await draftPo('m')
    const res = await savePo(po.id, po.version, [
      { productId: null, sku: 'A-m', supplierSku: null, quantityOrdered: 1, unitCostCents: 100, note: null, factoryName: null, factorySize: 'S' },
      { productId: null, sku: 'B-m', supplierSku: null, quantityOrdered: 2, unitCostCents: 100, note: null },
    ])
    expect(res.statusCode, res.body).toBe(200)
    expect(await naming(po.id)).toEqual([
      ['A-m', 1, null, 'S', NAMING.factorySpec],
      ['B-m', 2, 'B Factory', null, 'spec B'],
    ])
  })
})
