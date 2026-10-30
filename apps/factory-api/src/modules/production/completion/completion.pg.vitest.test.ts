import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedReturns, type ReturnsSeed } from '../../../../../../packages/factory-db/seed/returns'
import { seed as seedSchedule, type ScheduleSeed } from '../../../../../../packages/factory-db/seed/schedule'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Report finished to stock (B-W2a-12; GAP-003 work order completion into finished-goods stock, MES-011 partial
 * completion) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login, so row-level security and the wave 5 StockMove_bound_to_production trigger are real) and the factory-db
 * seeds of tenant A up to returns and the schedule: WO-0001 (in progress, batch SEED-BT-0001) released BLK 50 x1, BLK 52
 * x2 (one reversed) and RED 52 x1, and SH-0001 shipped the BLK 50 and the RED 52; WO-0003 (serial-tracked SEED-JKT-03,
 * RELEASED) released two of its four BLK 52, one of them on the DRAFT SH-0002; the A1-FG finished-goods location and the
 * FINISHED item of SEED-JKT-02-BLK-52. Every name and number is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/production/completion`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seedA: ScheduleSeed
let returnsA: ReturnsSeed

const ns = { a: 'completion-a', b: 'completion-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  storeBin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const ALL: Permission[] = ['workorders.view', 'workorders.manage', 'production.finish', 'inventory.stock.view']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const SESSIONS: Record<string, SessionContext> = {
  warehouse: office(A.tenant, [grant(ALL)]),
  viewer: office(A.tenant, [grant(['workorders.view', 'inventory.stock.view'])]),
  companyB: office(A.tenant, [grant(ALL, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(ALL)]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: newId(), siteId: A.siteA1, deviceId: newId(), grants: [grant(['floor.work', ...ALL], [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `completion-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, idempotencyKey?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, idempotencyKey?: string): Promise<Json> {
  const response = await call(session, method, url, payload, idempotencyKey)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}

const wo1 = () => seedA.production.workOrderId
const wo3 = () => returnsA.money.shipping.quality.serialWorkOrderId
const cells = () => ({ blk50: seedA.production.cellIds['BLK-50'], blk52: seedA.production.cellIds['BLK-52'], red52: seedA.production.cellIds['RED-52'], jacket: returnsA.money.shipping.quality.serialCellId })
const finished = async (workOrderId: string, session = 'warehouse') => (await ok(session, 'GET', `/production/work-orders/${workOrderId}/finished`)).finished as Json
const cellOf = (view: Json, cellId: string) => (view.cells as Json[]).find((cell) => cell.cellId === cellId)!

beforeAll(async () => {
  db = await migratedDatabase('completion')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: database, namespace })
  returnsA = await seedReturns({ db: database, namespace: ns.a })
  seedA = await seedSchedule({ db: database, namespace: ns.a })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('the pop-up: released garments per size not in stock yet (design production.workorders "Report finished to stock")', () => {
  it('GAP-003: only released garments, less reversals, less those on shipments; the site place and the SKU item', async () => {
    const view = await finished(wo1())
    expect(view).toMatchObject({ number: 'SEED-WO-0001', batchNumber: 'SEED-BT-0001', status: 'IN_PROGRESS', blockers: [], reportable: true, defaultLocationId: seedA.finishedLocationId, tracking: 'BATCH' })
    expect(view.places).toEqual([expect.objectContaining({ id: seedA.finishedLocationId, code: 'A1-FG', kind: 'FINISHED_GOODS' })])
    expect(cellOf(view, cells().blk52)).toMatchObject({ sku: 'SEED-JKT-02-BLK-52', itemId: seedA.finishedItemId, released: 2, reversed: 1, netReleased: 1, onShipments: 0, inStock: 0, canReport: 1, why: null })
    expect(cellOf(view, cells().blk50)).toMatchObject({ netReleased: 1, onShipments: 1, canReport: 0, why: 'BLK 50: 1 garment released, 0 in stock, 1 on shipments, so none is left to report.', itemId: null })
    expect(view.garments.canReport).toBe(1)
    expect(view.reports).toEqual([])
  })

  it('reaches only the work orders the grants reach; the floor, another company and another tenant never', async () => {
    expect((await refused('companyB', 'GET', `/production/work-orders/${wo1()}/finished`, undefined, 404)).code).toBe('not_found')
    expect((await refused('otherTenant', 'GET', `/production/work-orders/${wo1()}/finished`, undefined, 404)).code).toBe('not_found')
    expect((await refused('floor', 'GET', `/production/work-orders/${wo1()}/finished`, undefined, 403)).code).toBe('forbidden')
    expect((await refused('viewer', 'POST', `/production/work-orders/${wo1()}/finished`, {}, 403)).code).toBe('forbidden')
  })
})

describe('report finished to stock (GAP-003, MES-011)', () => {
  it('refuses in words: more than released, a shipped garment, a cell of another work order, a place that is not finished goods', async () => {
    const tooMany = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: cells().blk52, quantity: 2 }] }, 409)
    expect(tooMany.message).toBe('BLK 52: 1 garment released, 0 in stock, so 1 can go into finished goods; 2 asked.')
    const shipped = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: cells().blk50, quantity: 1 }] }, 409)
    expect(shipped.message).toBe('BLK 50: 1 garment released, 0 in stock, 1 on shipments, so none is left to report. 1 asked.')
    const other = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: cells().jacket, quantity: 1 }] }, 400)
    expect(other.issues).toEqual([{ path: 'body/cells/0/cellId', message: 'Not a cell of this work order.' }])
    const place = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { toLocationId: A.storeBin }, 400)
    expect(place).toMatchObject({ message: 'Not a finished-goods place of site A1.', issues: [{ path: 'body/toLocationId', message: expect.any(String) }] })
    expect(await admin(`SELECT 1 FROM "StockMove" WHERE reason = 'PRODUCTION_RECEIPT'`)).toEqual([])
  })

  it('posts one PRODUCTION_RECEIPT per cell into the place, the batch as its reference, valued at the standard cost; a resend answers the same', async () => {
    // A made-up standard cost on the SKU's item (the company's costing method waits for the accountant).
    await admin(`UPDATE "Item" SET "standardCost" = 120 WHERE id = $1`, [seedA.finishedItemId])
    const idempotencyKey = key()
    const answer = await ok('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, {}, 201, idempotencyKey)
    expect(answer.report).toMatchObject({ locationId: seedA.finishedLocationId, locationCode: 'A1-FG', pieces: 1, valued: true, cells: [{ workOrderSizeId: cells().blk52, itemId: seedA.finishedItemId, quantity: 1 }] })
    expect(cellOf(answer.finished, cells().blk52)).toMatchObject({ inStock: 1, canReport: 0 })
    expect(answer.finished.reportable).toBe(false)
    expect(answer.finished.reports).toEqual([expect.objectContaining({ id: answer.report.id, pieces: 1, open: 1, reversed: null, locationCode: 'A1-FG' })])

    const [move] = await admin(`SELECT reason, "workOrderId", "toLocationId", "fromLocationId", "baseQuantity"::text AS qty, reference, "itemId" FROM "StockMove" WHERE id = $1`, [answer.report.id])
    expect(move).toEqual({ reason: 'PRODUCTION_RECEIPT', workOrderId: wo1(), toLocationId: seedA.finishedLocationId, fromLocationId: null, qty: '1.0000', reference: 'SEED-BT-0001', itemId: seedA.finishedItemId })
    expect(await admin(`SELECT method, "unitCost"::text AS cost FROM "StockValuation" WHERE "moveId" = $1`, [answer.report.id])).toEqual([{ method: 'STANDARD_COST', cost: '120.000000' }])
    expect(await admin(`SELECT type FROM "OutboxEvent" WHERE type = 'workorder.finished_to_stock' AND payload->>'reportId' = $1`, [answer.report.id])).toHaveLength(1)
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1 AND action = 'production.finish'`, [wo1()])).toHaveLength(1)

    const again = await ok('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, {}, 201, idempotencyKey)
    expect(again.report.id).toBe(answer.report.id)
    expect(await admin(`SELECT 1 FROM "StockMove" WHERE reason = 'PRODUCTION_RECEIPT'`)).toHaveLength(1)
    const nothing = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, {}, 409)
    expect(nothing.message).toContain('Work order SEED-WO-0001 has nothing to report to finished goods: BLK 50: 1 garment released, 0 in stock, 1 on shipments')
  })

  it('the finished goods on hand: per SKU, place and batch', async () => {
    const { items } = await ok('warehouse', 'GET', `/inventory/finished?workOrderId=${wo1()}`)
    expect(items).toEqual([
      expect.objectContaining({ itemId: seedA.finishedItemId, sku: 'SEED-JKT-02-BLK-52', colourwayCode: 'BLK', size: '52', onHand: 1, places: [expect.objectContaining({ locationCode: 'A1-FG', onHand: 1 })], workOrders: [{ workOrderId: wo1(), number: 'SEED-WO-0001', batchNumber: 'SEED-BT-0001', received: 1 }] }),
    ])
    expect((await ok('companyB', 'GET', '/inventory/finished')).items).toEqual([])
  })

  it('takes a report back with the reason (its garments leave stock); once', async () => {
    const reportId = (await finished(wo1())).reports[0].id as string
    expect((await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished/${newId()}/reverse`, { reason: 'Counted twice' }, 404)).code).toBe('not_found')
    const back = await ok('warehouse', 'POST', `/production/work-orders/${wo1()}/finished/${reportId}/reverse`, { reason: 'Counted twice' })
    expect(back.reversed).toMatchObject({ reportId, pieces: 1 })
    expect(back.overReserved).toEqual([])
    expect(cellOf(back.finished, cells().blk52)).toMatchObject({ inStock: 0, canReport: 1 })
    expect(back.finished.reports[0]).toMatchObject({ id: reportId, open: 0, reversed: { reason: 'Counted twice' } })
    expect(await admin(`SELECT method, "unitCost"::text AS cost, quantity::text AS qty FROM "StockValuation" WHERE "moveId" = $1`, [back.reversed.moveIds[0]])).toEqual([{ method: 'STANDARD_COST', cost: '120.000000', qty: '-1.0000' }])
    expect((await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished/${reportId}/reverse`, { reason: 'Again' }, 409)).message).toBe('This report was taken back already: its garments left finished goods.')
  })

  it('two reports of the last released garment at once: one goes into stock, the other is refused in words', async () => {
    const [first, second] = await Promise.all([
      call('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: cells().blk52, quantity: 1 }] }, key()),
      call('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, { cells: [{ cellId: cells().blk52, quantity: 1 }] }, key()),
    ])
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409])
    const loser = first.statusCode === 409 ? first : second
    expect(loser.json().error.message).toBe('BLK 52: 1 garment released, 1 in stock, so none is left to report. 1 asked.')
    const [sum] = await admin<{ n: string }>(`SELECT coalesce(sum(CASE WHEN "reversalOfId" IS NULL THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::int::text AS n FROM "StockMove" WHERE reason = 'PRODUCTION_RECEIPT' AND "workOrderId" = $1`, [wo1()])
    expect(sum?.n).toBe('1')
  })
})

describe('the work order and the SKU', () => {
  it('a RELEASED work order waits until it is in progress; a style without SKUs is told to make them; the first report makes the SKU item', async () => {
    const released = await finished(wo3())
    expect(released.blockers).toEqual(['Work order SEED-WO-0003 is RELEASED; its garments go into finished goods once it is IN_PROGRESS (its first issue, cut or scan starts it).'])
    expect((await refused('warehouse', 'POST', `/production/work-orders/${wo3()}/finished`, {}, 409)).code).toBe('invalid_state')
    await ok('warehouse', 'POST', `/production/work-orders/${wo3()}/start`, {})
    expect(cellOf(await finished(wo3()), cells().jacket)).toMatchObject({ netReleased: 2, onShipments: 1, canReport: 1, sku: null })
    const noSku = await refused('warehouse', 'POST', `/production/work-orders/${wo3()}/finished`, {}, 400)
    expect(noSku.message).toBe("BLK 52 has no SKU: generate the style's SKU matrix (Product › Styles) first.")

    const [cell] = await admin<{ styleId: string; colourwayId: string }>(`SELECT "styleId", "colourwayId" FROM "WorkOrderSize" WHERE id = $1`, [cells().jacket])
    await admin(`INSERT INTO "Variant" (id, "tenantId", "styleId", "colourwayId", size, sku) VALUES ($1, $2, $3, $4, '52', $5)`, [newId(), A.tenant, cell!.styleId, cell!.colourwayId, `T-${run}-JKT-03-BLK-52`])
    const answer = await ok('warehouse', 'POST', `/production/work-orders/${wo3()}/finished`, { note: 'First serial jacket in stock' }, 201, key())
    expect(answer.report).toMatchObject({ pieces: 1, valued: false })
    const [item] = await admin(`SELECT code, kind, tracking, "baseUom", "variantId" IS NOT NULL AS sku FROM "Item" WHERE id = $1`, [answer.report.cells[0].itemId])
    expect(item).toEqual({ code: `T-${run}-JKT-03-BLK-52`, kind: 'FINISHED', tracking: 'SERIAL', baseUom: 'PCS', sku: true })
    expect(answer.finished.tracking).toBe('SERIAL')
  })

  it('MES-008: a held work order and a work order on quality hold report nothing, in words', async () => {
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'IN_PROGRESS', "heldAt" = now(), "holdReason" = 'Seam check' WHERE id = $1`, [wo1()])
    const held = await refused('warehouse', 'POST', `/production/work-orders/${wo1()}/finished`, {}, 409)
    expect(held.message).toBe('Work order SEED-WO-0001 is on hold (Seam check): its garments go into finished goods once the hold is lifted.')
    await admin(`UPDATE "WorkOrder" SET status = 'IN_PROGRESS', "heldFromStatus" = NULL, "heldAt" = NULL, "holdReason" = NULL WHERE id = $1`, [wo1()])

    await admin(`INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "placedAt") VALUES ($1, $2, $3, $4, 'WorkOrder', ARRAY[$5]::uuid[], 'STAIN', now())`, [newId(), A.tenant, A.companyA, A.siteA1, wo3()])
    const view = await finished(wo3())
    expect(view.blockers).toEqual(['Work order SEED-WO-0003 is on quality hold (STAIN): its garments go into finished goods once the hold is released.'])
    expect((await refused('warehouse', 'POST', `/production/work-orders/${wo3()}/finished`, {}, 409)).code).toBe('invalid_state')
    // Taking a report back is a correction: it is not held.
    const back = await ok('warehouse', 'POST', `/production/work-orders/${wo3()}/finished/${view.reports[0].id}/reverse`, { reason: 'Wrong jacket' })
    expect(back.reversed.pieces).toBe(1)
  })
})
