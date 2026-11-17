import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { isUuid, newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { fixedClock } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { namesOnlyItsParty } from '@nexus/factory-domain/production-brand/events'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, COMMAND_SETTINGS } from '../../../core/command'
import { testAuthenticator } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { findMarkers, markersOf, productionTwoBrands, twoBrandIds, twoBrandSessions, type Marker, type ProductionTwoBrands } from '../testing/two-brands'
import { keeperPlanningContext, readOrderProductionFacts } from './facts'
import { brandKeeperHandler, keepOrder, ordersOfEvent, runBrandKeeperNightly, STAGE_TOLD } from './keeper'

/**
 * B-PR-17 — the customer's stage and health keeper, PW-P07 (production plan §4; review fixes R-20, R-21, R-31, R-35, R-69; the
 * Owner rule 2026-11-16: "One brand must not be able to see anything related to any other brand. But we, as the production unit,
 * should be able to see it all. And manage it all as well.").
 *
 * On a throwaway PostgreSQL 17 database from the migrations (the runtime login; BrandOrderProduction's guard is real): the core,
 * auth, roles, files, production and numbering seeds and the production two-brand harness (brand A = the seeds' P1 with its new
 * order and DRAFT work order, brand B = the threads' second brand with SEED-SO-B001 and its DRAFT work order, a mixed work order
 * made before the one-customer rule; B-PR-15's production rows: A's two orders Urgent, B's order locked, B's open reported
 * problem). The floor's facts a step needs (a bundle, a sewing operation and its scan, a plain hold) are copied from the
 * production seed's SEED-WO-0001 by the test's admin pool with the database's rules off for that one statement. The keeper runs
 * as the worker does: `keepOrder` and the handler with a system caller of the tenant, the nightly run with its own clock.
 *
 *   - R-21: the row is made when the order is CONFIRMED (not while it waits for its approval), with PREPARING told once.
 *   - R-20: the stage moves forward with one stage_reached; a stage going back is written and never told; reached again, it is
 *     not told again. "sewing not counted here" until a sewing operation is scanned.
 *   - high volume: a scan only at a SEWING work centre and only for an order not yet at SEWING.
 *   - holds: hold_changed per order of the held work order (held, kind), its waiting-on the customer's pause; a retried job tells once.
 *   - PW-P07: an event of B's work order tells only B's order, in B's name; a legacy mixed work order tells each customer of its own
 *     order only; every brand_production event names an order of its own customer; nothing B is told carries a marker of A.
 *   - the nightly run: a passed promise reads Late, a raise past its 7 days drops, an order confirmed before the keeper gets its
 *     row; a second run changes nothing.
 *
 * Every name and number is made up. Run with `env -u FACTORY_REDIS_URL node scripts/factory/run-pg-tests.mjs modules/production/brand`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
const ns = 'pr2g-stage-keeper'
const ids = twoBrandIds(ns)
const actorId = seedUuid(ns, 'actor')
const PERMISSIONS: Permission[] = ['workorders.view', 'workorders.manage']
const SESSIONS = twoBrandSessions(ids.tenantId, ids.a, ids.b, PERMISSIONS)

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let w: ProductionTwoBrands
let aMarkers: Marker[]
const seeded = { sewOp: '', otherOp: '', scan: '', bundle: '' }
let colourwayId = ''
let cellA50 = ''

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
const lit = (value: string): string => {
  if (!isUuid(value)) throw new Error(`not an id: ${value}`)
  return `'${value}'`
}
/** One statement with the database's rules off (the harness's way to place floor facts made elsewhere). */
const raw = (statements: string): Promise<unknown> => db.admin.query(`BEGIN; SET LOCAL session_replication_role = replica; ${statements} COMMIT;`)
const system = () => callerFor(database, systemContext(ids.tenantId, `t-${newId()}`))
const handler = brandKeeperHandler()
const run = (type: string, payload: Json, eventId = newId()): Promise<void> => handler.handle(envelope(type, payload, eventId), { caller: system(), attempt: 1 })
function envelope(type: string, payload: Json, eventId: string): EventEnvelope {
  return { eventId, type, version: 1, context: 'test', tenantId: ids.tenantId, companyId: w.companyId, siteId: null, subject: String(payload.workOrderId ?? payload.orderId ?? eventId), correlationId: `t-${eventId}`, causationId: null, source: 'test', occurredAt: new Date().toISOString(), payload }
}

interface Told {
  readonly id: string
  readonly type: string
  readonly subject: string
  readonly payload: Json
}
const told = (): Promise<Told[]> => admin<Told>(`SELECT id, type, subject, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type LIKE 'brand_production.%' ORDER BY id`, [ids.tenantId])
/** The brand_production events written after `before` (a list read earlier). */
const toldSince = async (before: readonly Told[]): Promise<Told[]> => {
  const seen = new Set(before.map((event) => event.id))
  return (await told()).filter((event) => !seen.has(event.id))
}
const rowOf = (orderId: string) => one<Json>(`SELECT * FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])
const factsOf = (orderId: string) => system().withClient((client) => readOrderProductionFacts(client, keeperPlanningContext(ids.tenantId, 'test'), orderId, new Date(), { health: false }))
/** Every order's customer, as the database has it (the wall's other side). */
const partiesOf = async (): Promise<Map<string, string>> => new Map((await admin<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1`, [ids.tenantId])).map((row) => [row.id, row.partyId]))
/** PW-P07: each event names one order and that order's own customer. */
async function expectOwnCustomer(events: readonly Told[]): Promise<void> {
  const partyOf = await partiesOf()
  for (const event of events) {
    expect(event.subject, event.type).toBe(event.payload.orderId)
    expect(namesOnlyItsParty({ partyId: event.payload.partyId, orderIds: [event.payload.orderId] }, partyOf), `${event.type} ${event.payload.orderId}`).toBe(true)
  }
}

/** A made-up order of a customer with one goods line (sizes 50 × 2, 52 × 2), written as the office writes it. */
async function newOrder(partyId: string, label: string): Promise<{ orderId: string; lineId: string }> {
  const orderId = newId()
  const lineId = newId()
  await database.withScope({ audience: 'office', tenantId: ids.tenantId, actorId }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: w.companyId, partyId, number: `T-PR17-${label}-${orderId.slice(-6)}`, customerRef: `T-PR17-PO-${orderId.slice(-6)}`, status: 'CONFIRMED', orderDate: new Date('2026-11-05T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-18T00:00:00.000Z') },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: w.companyId, orderId, partyId, seq: 10, kind: 'SIZE_GRID', styleId: w.styleId, colourwayId, quantity: 4, unitPrice: '100.000000', netAmount: 40_000, vatRatePct: '22.00', vatAmount: 8_800 },
        select: { id: true },
      })
      await tx.salesOrderLineSize.createMany({ data: [['50', 2], ['52', 2]].map(([size, quantity]) => ({ id: newId(), lineId, partyId, size: size as string, quantity: quantity as number })) })
    }),
  )
  return { orderId, lineId }
}

/** A copy of the seed's bundle on a cell of a work order (cut: the CUT signal). */
async function bundleOn(workOrderId: string, cellId: string): Promise<string> {
  const id = newId()
  await raw(`INSERT INTO "Bundle" SELECT (jsonb_populate_record(NULL::"Bundle", to_jsonb(b) || jsonb_build_object('id', ${lit(id)}, 'workOrderId', ${lit(workOrderId)}, 'workOrderSizeId', ${lit(cellId)}, 'code', 'T-PR17-BN-${id.slice(-8)}', 'replacedCodes', '[]'::jsonb, 'clientEventId', NULL, 'status', 'ACTIVE'))).* FROM "Bundle" b WHERE b.id = ${lit(seeded.bundle)};`)
  return id
}
/** A copy of the seed's scanned sewing operation on a work order (sewing is counted there). */
async function sewingOperationOn(workOrderId: string): Promise<string> {
  const id = newId()
  await raw(`INSERT INTO "WorkOrderOperation" SELECT (jsonb_populate_record(NULL::"WorkOrderOperation", to_jsonb(o) || jsonb_build_object('id', ${lit(id)}, 'workOrderId', ${lit(workOrderId)}, 'seq', 20, 'scanRequired', true))).* FROM "WorkOrderOperation" o WHERE o.id = ${lit(seeded.sewOp)};`)
  return id
}
/** A copy of the seed's sewing REPORT for a bundle at an operation (the SEWING signal). */
async function sewingScan(workOrderId: string, operationId: string, bundleId: string): Promise<string> {
  const id = newId()
  await raw(`INSERT INTO "OperationScan" SELECT (jsonb_populate_record(NULL::"OperationScan", to_jsonb(s) || jsonb_build_object('id', ${lit(id)}, 'workOrderId', ${lit(workOrderId)}, 'workOrderOperationId', ${lit(operationId)}, 'bundleId', ${lit(bundleId)}, 'clientScanId', 'T-PR17-${id.slice(-8)}', 'correctsId', NULL, 'kind', 'REPORT'))).* FROM "OperationScan" s WHERE s.id = ${lit(seeded.scan)};`)
  return id
}

beforeAll(async () => {
  db = await migratedDatabase('pr2g_stage_keeper')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  for (const seed of [seedCore, seedAuth, seedRoles, seedFiles]) await seed({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session']) as keyof typeof SESSIONS] ?? null) },
  )
  w = await productionTwoBrands({ db, database, app, namespace: ns })
  expect(w.a.partyId).toBe(ids.a)
  aMarkers = await markersOf(db, ids.a)

  // The production seed's SEED-WO-0001 (released, of SEED-SO-0002): its scanned sewing operation, a REPORT there, a bundle, and
  // an operation of another work centre.
  const seedWo = (await one<{ id: string }>(`SELECT id FROM "WorkOrder" WHERE "tenantId" = $1 AND number = 'SEED-WO-0001'`, [ids.tenantId])).id
  seeded.sewOp = (await one<{ id: string }>(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1 AND c.kind = 'SEWING' AND o."scanRequired" ORDER BY o.seq LIMIT 1`, [seedWo])).id
  seeded.otherOp = (await one<{ id: string }>(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" = $1 AND c.kind <> 'SEWING' ORDER BY o.seq LIMIT 1`, [seedWo])).id
  seeded.scan = (await one<{ id: string }>(`SELECT id FROM "OperationScan" WHERE "workOrderOperationId" = $1 AND kind = 'REPORT' AND "correctsId" IS NULL ORDER BY "serverTime", id LIMIT 1`, [seeded.sewOp])).id
  seeded.bundle = (await one<{ id: string }>(`SELECT id FROM "Bundle" WHERE "workOrderId" = $1 ORDER BY id LIMIT 1`, [seedWo])).id
  colourwayId = (await one<{ colourwayId: string }>(`SELECT "colourwayId" FROM "SalesOrderLine" WHERE id = $1`, [w.a.salesOrderLineId])).colourwayId
  cellA50 = (await one<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [w.a.workOrderId])).id
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the row is made when the order is CONFIRMED (R-21)', () => {
  it("a confirmed order with no work order yet gets its row (PREPARING, who it waits on), told PREPARING once, in its own customer's name", async () => {
    const { orderId } = await newOrder(ids.a, 'CONF')
    const before = await told()
    const kept = await keepOrder(system(), orderId, { what: 'test' })
    expect(kept.changed).toBe(true)
    const row = await rowOf(orderId)
    expect(row).toMatchObject({ partyId: ids.a, companyId: w.companyId, salesOrderId: orderId, stage: 'PREPARING', urgency: 'REGULAR', waitingOn: 'US', version: 1 })
    const events = await toldSince(before)
    expect(events.filter((event) => event.type === 'brand_production.stage_reached').map((event) => event.payload)).toEqual([{ orderId, partyId: ids.a, stage: 'PREPARING', previous: null }])
    expect(events.filter((event) => event.type === 'brand_production.health_changed').map((event) => [event.payload.orderId, event.payload.partyId, event.payload.previous])).toEqual([[orderId, ids.a, null]])
    await expectOwnCustomer(events)
    // Kept again with nothing new: no command, nothing told.
    const again = await keepOrder(system(), orderId, { what: 'test' })
    expect(again).toEqual({ orderId, changed: false, told: [] })
    expect(await toldSince([...before, ...events])).toEqual([])
  })

  it('an order still waiting for its approval gets no row; once CONFIRMED (sales_order.status_changed) the handler makes it', async () => {
    const { orderId } = await newOrder(ids.a, 'PEND')
    await raw(`UPDATE "SalesOrder" SET status = 'PENDING_APPROVAL' WHERE id = ${lit(orderId)};`)
    expect(await keepOrder(system(), orderId, { what: 'test' })).toEqual({ orderId, changed: false, told: [] })
    expect(await admin(`SELECT id FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])).toEqual([])
    await raw(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = ${lit(orderId)};`)
    await run('sales_order.status_changed', { orderId, number: 'T-PR17', from: 'PENDING_APPROVAL', to: 'CONFIRMED', by: 'person' })
    expect(await rowOf(orderId)).toMatchObject({ partyId: ids.a, stage: 'PREPARING' })
  })
})

describe('the stage moves forward, told once per stage (R-20)', () => {
  let sewOp = ''
  let bundle = ''
  let scan = ''
  const stageTold = async (stage: string) =>
    (await told()).filter((event) => event.type === 'brand_production.stage_reached' && event.subject === w.a.salesOrderId && event.payload.stage === stage)

  it("brand A's order: a bundle made is CUTTING, told once; with no scanned sewing operation it reads 'sewing not counted here'", async () => {
    // The harness's work orders follow a revision with no routing: no sewing operation is scanned on A's lines yet.
    const sewing = await admin(`SELECT o.id FROM "WorkOrderOperation" o JOIN "WorkCentre" c ON c.id = o."workCentreId" WHERE o."workOrderId" IN (${lit(w.a.workOrderId)}, ${lit(w.mixed.workOrderId)}) AND c.kind = 'SEWING'`)
    expect(sewing, "the harness makes A's work orders with no sewing operation").toEqual([])
    await keepOrder(system(), w.a.salesOrderId, { what: 'test' })
    expect((await rowOf(w.a.salesOrderId)).stage).toBe('PREPARING')
    bundle = await bundleOn(w.a.workOrderId, cellA50)
    const kept = await keepOrder(system(), w.a.salesOrderId, { what: 'production.bundle_created', health: false })
    expect(kept.told).toContain('brand_production.stage_reached')
    expect((await rowOf(w.a.salesOrderId)).stage).toBe('CUTTING')
    expect((await stageTold('CUTTING')).map((event) => event.payload)).toEqual([{ orderId: w.a.salesOrderId, partyId: ids.a, stage: 'CUTTING', previous: 'PREPARING' }])
    expect((await factsOf(w.a.salesOrderId))!.stage).toEqual({ stage: 'CUTTING', ahead: 0, next: 'SEWING', sewingNotCounted: true })
  })

  it('a sewing scan is SEWING, told once; taken back it reads CUTTING again (written, not told); reached again it is not told again', async () => {
    sewOp = await sewingOperationOn(w.a.workOrderId)
    scan = await sewingScan(w.a.workOrderId, sewOp, bundle)
    await keepOrder(system(), w.a.salesOrderId, { what: 'production.scan_recorded', health: false })
    expect((await rowOf(w.a.salesOrderId)).stage).toBe('SEWING')
    expect(await stageTold('SEWING')).toHaveLength(1)

    await raw(`DELETE FROM "OperationScan" WHERE id = ${lit(scan)};`)
    const back = await keepOrder(system(), w.a.salesOrderId, { what: 'production.scan_recorded', health: false })
    expect(back.told).toEqual([])
    expect((await rowOf(w.a.salesOrderId)).stage).toBe('CUTTING')
    expect((await factsOf(w.a.salesOrderId))!.stage?.sewingNotCounted).toBe(false)

    scan = await sewingScan(w.a.workOrderId, sewOp, bundle)
    const again = await keepOrder(system(), w.a.salesOrderId, { what: 'production.scan_recorded', health: false })
    expect(again.changed).toBe(true)
    expect(again.told).toEqual([])
    expect((await rowOf(w.a.salesOrderId)).stage).toBe('SEWING')
    expect(await stageTold('SEWING')).toHaveLength(1)
    expect(await stageTold('CUTTING')).toHaveLength(1)
    const markers = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'BrandOrderProduction' AND "recordId" = $1 AND action = $2 ORDER BY at, id`, [(await rowOf(w.a.salesOrderId)).id, STAGE_TOLD])
    expect(markers.map((row) => row.after.stage)).toEqual(['CUTTING', 'SEWING'])
    // The order's own timeline (its audit rows) carries none of the keeper's rows.
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action LIKE 'production.brandKeeper%'`, [w.a.salesOrderId])).toEqual([])
  })

  it('high volume: a scan names an order only at a SEWING work centre and only while the order is not yet at SEWING', async () => {
    const reader = system()
    // A at SEWING: its sewing scans name no order.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.scan_recorded', payload: { workOrderId: w.a.workOrderId, operationId: sewOp } }))).toEqual({ orderIds: [], hold: null })
    // Another work centre: no order.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.scan_recorded', payload: { workOrderId: w.a.workOrderId, operationId: seeded.otherOp } }))).toEqual({ orderIds: [], hold: null })
    // B's work order with a sewing operation, B not yet at SEWING: B's order only — never A's.
    const bSewOp = await sewingOperationOn(w.b.workOrderId)
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.scan_recorded', payload: { workOrderId: w.b.workOrderId, operationId: bSewOp } }))).toEqual({ orderIds: [w.b.salesOrderId], hold: null })
    // A start counts, a pause does not.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.operation_timed', payload: { workOrderId: w.b.workOrderId, operationId: bSewOp, kind: 'START' } }))).toEqual({ orderIds: [w.b.salesOrderId], hold: null })
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.operation_timed', payload: { workOrderId: w.b.workOrderId, operationId: bSewOp, kind: 'PAUSE' } }))).toEqual({ orderIds: [], hold: null })
    // A cut on A's work order: A is past CUTTING, nothing to do.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.cut_logged', payload: { workOrderId: w.a.workOrderId } }))).toEqual({ orderIds: [], hold: null })
  })
})

describe("holds, and PW-P07: no event for another brand's order", () => {
  const holdId = newId()
  const placedAt = '2026-11-14T10:00:00.000Z'

  it("a pause on B's work order: hold_changed for B's order only (held, BRAND), it waits on the customer since the pause; a retried job tells once", async () => {
    await raw(`INSERT INTO "WorkOrderHold" (id, "tenantId", "companyId", "siteId", "workOrderId", "partyId", kind, "reasonCode", status, "placedAt", "placedById") VALUES (${lit(holdId)}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, ${lit(w.siteId)}, ${lit(w.b.workOrderId)}, ${lit(ids.b)}, 'BRAND', 'OTHER', 'ACTIVE', '${placedAt}', ${lit(actorId)});
      UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = 'DRAFT', "heldAt" = '${placedAt}', "heldById" = ${lit(actorId)}, "holdReason" = 'Made-up pause', "holdRecordType" = 'WorkOrderHold', "holdRecordId" = ${lit(holdId)} WHERE id = ${lit(w.b.workOrderId)};`)
    const before = await told()
    const eventId = newId()
    const payload = { holdId, workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, siteId: w.siteId, partyId: ids.b, kind: 'BRAND', requestId: null }
    await run('work_order_hold.placed', payload, eventId)
    const events = await toldSince(before)
    expect(events.filter((event) => event.type === 'brand_production.hold_changed').map((event) => event.payload)).toEqual([{ orderId: w.b.salesOrderId, partyId: ids.b, held: true, kind: 'BRAND' }])
    expect(events.every((event) => event.payload.partyId === ids.b && event.subject === w.b.salesOrderId)).toBe(true)
    expect(findMarkers(events, aMarkers)).toEqual([])
    await expectOwnCustomer(events)
    const row = await rowOf(w.b.salesOrderId)
    expect([row.waitingOn, new Date(row.waitingSince).toISOString()]).toEqual(['BRAND', placedAt])
    // The worker retried the same job: nothing told twice.
    await run('work_order_hold.placed', payload, eventId)
    expect((await toldSince([...before, ...events])).filter((event) => event.type === 'brand_production.hold_changed')).toEqual([])
  })

  it("the pause lifted: hold_changed (held no more), it waits on us again (B's reported problem)", async () => {
    await raw(`UPDATE "WorkOrderHold" SET status = 'LIFTED', "liftedAt" = now(), "liftedById" = ${lit(actorId)}, "liftReason" = 'Made-up resume' WHERE id = ${lit(holdId)};
      UPDATE "WorkOrder" SET status = 'DRAFT', "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL, "holdRecordType" = NULL, "holdRecordId" = NULL WHERE id = ${lit(w.b.workOrderId)};`)
    const before = await told()
    await run('work_order_hold.lifted', { holdId, workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, siteId: w.siteId, partyId: ids.b, kind: 'BRAND', requestId: null })
    const events = await toldSince(before)
    expect(events.filter((event) => event.type === 'brand_production.hold_changed').map((event) => event.payload)).toEqual([{ orderId: w.b.salesOrderId, partyId: ids.b, held: false, kind: 'BRAND' }])
    expect(findMarkers(events, aMarkers)).toEqual([])
    const row = await rowOf(w.b.salesOrderId)
    expect(row.waitingOn).toBe('US')
    expect(new Date(row.waitingSince).getTime()).toBeLessThanOrEqual(Date.parse('2026-10-29T08:20:00.000Z'))
  })

  it("an event of B's work order tells nothing of A's orders; a legacy mixed work order tells each customer of its own order only", async () => {
    const before = await told()
    await run('workorder.status_changed', { workOrderId: w.b.workOrderId, number: w.b.workOrderNumber, partyId: ids.b, from: 'ON_HOLD', to: 'DRAFT' })
    const ofB = await toldSince(before)
    expect(ofB.every((event) => event.payload.partyId === ids.b && event.subject === w.b.salesOrderId)).toBe(true)
    expect(findMarkers(ofB, aMarkers)).toEqual([])

    const mixedBefore = await told()
    await run('work_order_hold.placed', { holdId: newId(), workOrderId: w.mixed.workOrderId, number: w.mixed.number, siteId: w.siteId, partyId: null, kind: 'PRODUCTION', requestId: null })
    const ofMixed = (await toldSince(mixedBefore)).filter((event) => event.type === 'brand_production.hold_changed')
    expect(ofMixed.map((event) => [event.payload.orderId, event.payload.partyId]).sort()).toEqual([[w.a.salesOrderId, ids.a], [w.b.salesOrderId, ids.b]].sort())
    await expectOwnCustomer(ofMixed)
    expect(findMarkers(ofMixed.filter((event) => event.payload.partyId === ids.b), aMarkers)).toEqual([])
  })

  it('every brand_production event the keeper wrote names one order of its own customer', async () => {
    await expectOwnCustomer(await told())
  })
})

describe('the nightly run (lateness by date)', () => {
  it("a passed promise reads Late, a raise past its 7 days drops, an order confirmed before the keeper gets its row; a second run changes nothing", async () => {
    const { orderId: earlier } = await newOrder(ids.b, 'NIGHT')
    await admin(
      `UPDATE "BrandOrderProduction" SET "healthSet" = 'AT_RISK', "healthReasonCode" = 'CAPACITY', "healthNote" = 'Made-up: the line is full this week.', "healthSetAt" = '2026-11-12T09:00:00Z', "healthSetById" = $2, "healthSetUntil" = '2026-11-19' WHERE key = $1`,
      [`brand-production:${w.b.salesOrderId}`, actorId],
    )
    const silent = { info() {}, warn() {}, error() {} }
    const clock = fixedClock('2027-01-10T10:00:00.000Z')
    const before = await told()
    const first = await runBrandKeeperNightly({ database, log: silent, clock })
    expect(first.failed).toBe(0)
    expect(first.orders).toBeGreaterThan(3)
    expect((await rowOf(w.a.salesOrderId)).health).toBe('LATE')
    // The customer was told Late (in this run, or earlier when the real day is already past the promise).
    expect((await told()).filter((event) => event.type === 'brand_production.health_changed' && event.subject === w.a.salesOrderId).at(-1)?.payload).toMatchObject({ orderId: w.a.salesOrderId, partyId: ids.a, health: 'LATE' })
    expect(await rowOf(w.b.salesOrderId)).toMatchObject({ healthSet: null, healthReasonCode: null, healthNote: null, healthSetAt: null, healthSetById: null, healthSetUntil: null })
    expect(await rowOf(earlier)).toMatchObject({ partyId: ids.b, salesOrderId: earlier, stage: 'PREPARING' })
    await expectOwnCustomer(await toldSince(before))

    const second = await runBrandKeeperNightly({ database, log: silent, clock })
    expect(second).toMatchObject({ failed: 0, changed: 0 })
  })

  it('an office caller may keep an order too (as the worker does); a portal caller never', async () => {
    const office = callerFor(database, { audience: 'office', tenantId: ids.tenantId, actorId, grants: [], requestId: `t-${newId()}` })
    await expect(keepOrder(office, w.a.salesOrderId, { what: 'test' }, COMMAND_SETTINGS)).resolves.toMatchObject({ orderId: w.a.salesOrderId })
    const partner = callerFor(database, { audience: 'partner', tenantId: ids.tenantId, actorId: newId(), partyId: ids.a, grants: [], requestId: `t-${newId()}` })
    await expect(keepOrder(partner, w.a.salesOrderId, { what: 'test' })).rejects.toThrow()
  })
})
