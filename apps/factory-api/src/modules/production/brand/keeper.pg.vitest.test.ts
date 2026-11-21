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
import { HAND_CLEARED } from './keeper' // B-MS-004
import { readHandFloor, SET_BRAND_STAGE } from './keeper' // B-SC-003

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
 *   - B-MS-004 (set the stage by hand, design A): under a hand Sewing a bundle and a sewing scan are still followed (R7) and the
 *     scan ends it with no second notice; set by hand, then cancelled: the hand columns empty, the stage where the work reached,
 *     one SalesOrder audit row with no `status` key (R2, R6); the nightly run clears one whose status event was missed. The hand
 *     stage is written by the admin pool as B-MS-005's command writes it (the database's guard is real).
 *   - B-SC-003 (stage control B, end rule E1): set back to Preparing over a floor at Cutting (its set's audit row names the floor
 *     then), a bundle under it is followed and it stands — the customer reads Preparing, nothing told; a sewing scan moves the
 *     floor past where it stood at the set: it ends, Sewing written and told from Preparing, one History row.
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

// ── B-MS-004 ──
describe('B-MS-004: the stage set by hand (design A; R2, R6, R7)', () => {
  /** The seeds' owner: an active office person of the tenant (the guard's rule for who sets a stage by hand). */
  const owner = seedUuid(ns, 'actor')
  const handOf = (orderId: string) =>
    one<Json>(`SELECT stage::text AS stage, "stageSet"::text AS "stageSet", "stageSetReason"::text AS reason, "stageSetNote" AS note, "stageSetAt" AS "setAt", "stageSetById" AS "setById", version FROM "BrandOrderProduction" WHERE key = $1`, [`brand-production:${orderId}`])
  /** A stage set by hand, as B-MS-005's command writes it: `stage` equals it, with a reason, a made-up note, when and by whom. */
  const setByHand = (orderId: string, stage: string) =>
    admin(
      `UPDATE "BrandOrderProduction" SET stage = $2::"BrandStage", "stageAt" = now(), "stageSet" = $2::"BrandStage", "stageSetReason" = 'OUTAGE', "stageSetNote" = 'Made-up: the tablets were down all morning.', "stageSetAt" = now(), "stageSetById" = $3, version = version + 1 WHERE key = $1`,
      [`brand-production:${orderId}`, stage, owner],
    )
  /** The order's own History rows of a hand stage the keeper ended. */
  const ended = (orderId: string) => admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'SalesOrder' AND "recordId" = $1 AND action = $2 ORDER BY at, id`, [orderId, HAND_CLEARED])
  const stagesTold = async (orderId: string, since: readonly Told[]) => (await toldSince(since)).filter((event) => event.type === 'brand_production.stage_reached' && event.subject === orderId)
  const cleared = { stageSet: null, reason: null, note: null, setAt: null, setById: null }

  it('R7: under a hand Sewing a bundle and a sewing scan are still followed (never skipped); the scan ends it, with no second notice', async () => {
    const { orderId, lineId } = await newOrder(ids.a, 'HAND')
    const made = await app.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId: w.siteId, lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
    expect(made.statusCode, made.body).toBe(201)
    const workOrderId = (made.json() as { workOrder: { id: string } }).workOrder.id
    await keepOrder(system(), orderId, { what: 'test' })
    expect((await handOf(orderId)).stage).toBe('PREPARING')
    await setByHand(orderId, 'SEWING')
    const before = await told()
    const reader = system()

    // A bundle: the stored Sewing is the hand's, not the floor's — the event still names the order.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.bundle_created', payload: { workOrderId } }))).toEqual({ orderIds: [orderId], hold: null })
    const cell = (await one<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [workOrderId])).id
    const bundle = await bundleOn(workOrderId, cell)
    await run('production.bundle_created', { workOrderId })
    // The floor at Cutting, under the hand Sewing: the stage stays, the hand stage stands, nothing told.
    expect((await factsOf(orderId))!.stage?.stage).toBe('CUTTING')
    expect(await handOf(orderId)).toMatchObject({ stage: 'SEWING', stageSet: 'SEWING', reason: 'OUTAGE', setById: owner })

    // A sewing scan: named too, and it ends the hand stage — the five columns cleared in the same write, Sewing stays, no notice.
    const op = await sewingOperationOn(workOrderId)
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.scan_recorded', payload: { workOrderId, operationId: op } }))).toEqual({ orderIds: [orderId], hold: null })
    await sewingScan(workOrderId, op, bundle)
    await run('production.scan_recorded', { workOrderId, operationId: op })
    expect(await handOf(orderId)).toMatchObject({ stage: 'SEWING', ...cleared })
    expect(await stagesTold(orderId, before)).toEqual([])
    // The order's History: one row says it ended (the floor reached it) — never a `status` key.
    expect(await ended(orderId)).toEqual([{ before: { stage: 'SEWING' }, after: { stage: 'SEWING', floor: 'SEWING', why: 'REACHED' } }])
    // At Sewing with no hand stage, a scan is skipped again.
    expect(await reader.withClient((client) => ordersOfEvent(client, { type: 'production.scan_recorded', payload: { workOrderId, operationId: op } }))).toEqual({ orderIds: [], hold: null })
  })

  // ── B-SC-003 (stage control B, end rule E1) ──
  describe('B-SC-003: a stage set back (below the floor) stands until the floor agrees or moves on', () => {
    let orderId = ''
    let workOrderId = ''
    let bundle = ''
    /**
     * A stage set by hand BACK, as B-MS-005's command writes it: the row (`stage` equals it) and its set's audit row on the
     * production row, `after.floor` the floor's stage then (the keeper's floorAtSet, readHandFloor).
     */
    async function setBack(stage: string, floor: string): Promise<void> {
      await setByHand(orderId, stage)
      const row = await rowOf(orderId)
      await raw(`INSERT INTO "AuditLog" (id, "tenantId", "companyId", at, audience, "actorId", action, "recordType", "recordId", before, after, reason, "requestId")
        VALUES (${lit(newId())}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, now(), 'OFFICE', ${lit(owner)}, '${SET_BRAND_STAGE}', 'BrandOrderProduction', ${lit(row.id)},
          '{"stage": "${floor}", "hand": null}'::jsonb, '{"salesOrderId": "${orderId}", "stage": "${stage}", "hand": "${stage}", "floor": "${floor}", "reasonCode": "OTHER", "note": "Made-up: a wrong cut was logged."}'::jsonb,
          'Stage set by hand: ${stage} (OTHER).', 't-${newId()}');`)
    }

    it('set back to Preparing over a floor at Cutting: a bundle under it is followed and it stands — Preparing read, nothing told', async () => {
      const made = await newOrder(ids.a, 'BACK')
      orderId = made.orderId
      const created = await app.inject({ method: 'POST', url: '/production/work-orders', headers: { 'x-test-session': 'office.all' }, payload: { siteId: w.siteId, lines: [{ salesOrderLineId: made.lineId, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 2 }] }] } })
      expect(created.statusCode, created.body).toBe(201)
      workOrderId = (created.json() as { workOrder: { id: string } }).workOrder.id
      const cell = (await one<{ id: string }>(`SELECT id FROM "WorkOrderSize" WHERE "workOrderId" = $1 AND size = '50'`, [workOrderId])).id
      bundle = await bundleOn(workOrderId, cell)
      await keepOrder(system(), orderId, { what: 'production.bundle_created', health: false })
      expect((await handOf(orderId)).stage).toBe('CUTTING')
      await setBack('PREPARING', 'CUTTING')
      // The keeper reads the floor at the set back from the set's own audit row.
      const rowId = (await rowOf(orderId)).id as string
      expect(await system().withClient((client) => readHandFloor(client, rowId))).toBe('CUTTING')
      const before = await told()
      // Another bundle of the same cut: the floor still at Cutting, where it stood at the set — the hand Preparing stands.
      await bundleOn(workOrderId, cell)
      await run('production.bundle_created', { workOrderId })
      expect((await factsOf(orderId))!.stage?.stage).toBe('CUTTING')
      expect(await handOf(orderId)).toMatchObject({ stage: 'PREPARING', stageSet: 'PREPARING', reason: 'OUTAGE' })
      expect(await stagesTold(orderId, before)).toEqual([])
      expect(await ended(orderId)).toEqual([])
    })

    it('a sewing scan moves the floor past where it stood at the set: it ends — Sewing written and told from Preparing, one History row', async () => {
      const before = await told()
      const op = await sewingOperationOn(workOrderId)
      await sewingScan(workOrderId, op, bundle)
      await run('production.scan_recorded', { workOrderId, operationId: op })
      expect(await handOf(orderId)).toMatchObject({ stage: 'SEWING', ...cleared })
      expect((await stagesTold(orderId, before)).map((event) => event.payload)).toEqual([{ orderId, partyId: ids.a, stage: 'SEWING', previous: 'PREPARING' }])
      expect(await ended(orderId)).toEqual([{ before: { stage: 'PREPARING' }, after: { stage: 'SEWING', floor: 'SEWING', why: 'REACHED' } }])
    })
  })
  // ── end B-SC-003 ──

  it('R2: set by hand, then cancelled — the hand columns empty, the stage where the work reached; one History row, no status key; nothing told', async () => {
    const { orderId } = await newOrder(ids.a, 'GONE')
    await keepOrder(system(), orderId, { what: 'test' })
    await setByHand(orderId, 'QUALITY')
    await raw(`UPDATE "SalesOrder" SET status = 'CANCELLED' WHERE id = ${lit(orderId)};`)
    const before = await told()
    await run('sales_order.status_changed', { orderId, number: 'T-PR17', from: 'CONFIRMED', to: 'CANCELLED', by: 'person' })
    // Nothing of it was ever cut: Preparing, never the hand's Quality check.
    expect(await handOf(orderId)).toMatchObject({ stage: 'PREPARING', ...cleared })
    expect((await toldSince(before)).filter((event) => event.subject === orderId)).toEqual([])
    const rows = await ended(orderId)
    expect(rows).toEqual([{ before: { stage: 'QUALITY' }, after: { stage: 'PREPARING', floor: 'PREPARING', why: 'LEFT_PRODUCTION' } }])
    for (const row of rows) expect([...Object.keys(row.before), ...Object.keys(row.after)]).not.toContain('status')
    // Kept again: a cancelled order with no hand stage is left alone.
    expect(await keepOrder(system(), orderId, { what: 'test' })).toEqual({ orderId, changed: false, told: [] })
  })

  it('R2, the safety net: a hand stage left on an order whose status event was missed is cleared by the nightly run; a second run changes nothing', async () => {
    const { orderId } = await newOrder(ids.b, 'MISS')
    await keepOrder(system(), orderId, { what: 'test' })
    await setByHand(orderId, 'CUTTING')
    await raw(`UPDATE "SalesOrder" SET status = 'CLOSED' WHERE id = ${lit(orderId)};`)
    const silent = { info() {}, warn() {}, error() {} }
    const clock = fixedClock('2027-01-10T10:00:00.000Z')
    expect((await runBrandKeeperNightly({ database, log: silent, clock })).failed).toBe(0)
    expect(await handOf(orderId)).toMatchObject({ stage: 'PREPARING', ...cleared })
    expect(await ended(orderId)).toMatchObject([{ before: { stage: 'CUTTING' }, after: { stage: 'PREPARING', why: 'LEFT_PRODUCTION' } }])
    expect(await runBrandKeeperNightly({ database, log: silent, clock })).toMatchObject({ failed: 0, changed: 0 })
  })
})
// ── end B-MS-004 ──

// ── B-PT-016 (order production tab C2) ──
/**
 * "Waiting on the customer's material": a CustomerMaterial row of the order expecting more than was received raises the
 * CUSTOMER_MATERIAL blocker (since that row was made) while the order is CONFIRMED or IN_PRODUCTION with work still to do, so the
 * order waits on the customer; a receipt that covers it takes it away; an order whose work is done (READY) never waits on it. The
 * keeper follows customer_material.changed (its orderId). The row is written by the admin pool as inventory/receipts' plan writes
 * one (a BOM line of the seeds; made-up quantities), the receipt as its recount does.
 */
describe('B-PT-016: waiting on the customer’s material', () => {
  let order: { orderId: string; lineId: string }
  const material = newId()
  const blockerOf = async (orderId: string) => (await factsOf(orderId))!.blockers.filter((blocker) => blocker.kind === 'CUSTOMER_MATERIAL')
  const changed = (orderId: string) => run('customer_material.changed', { orderId, number: 'T-PT016', change: 'RECOUNTED', rows: 1, partyId: ids.a })

  beforeAll(async () => {
    order = await newOrder(ids.a, 'CM')
    const bomLine = await one<{ id: string; revisionId: string; itemId: string }>(`SELECT id, "revisionId", "itemId" FROM "BomLine" WHERE "tenantId" = $1 ORDER BY id LIMIT 1`, [ids.tenantId])
    await raw(
      `UPDATE "SalesOrder" SET "depositRequired" = false WHERE id = ${lit(order.orderId)};
       INSERT INTO "CustomerMaterial" (id, "tenantId", "companyId", "partyId", "orderId", "orderLineId", "bomRevisionId", "bomLineId", "itemId", uom, "expectedQuantity", "receivedQuantity", "createdAt", "updatedAt")
         VALUES (${lit(material)}, ${lit(ids.tenantId)}, ${lit(w.companyId)}, ${lit(ids.a)}, ${lit(order.orderId)}, ${lit(order.lineId)}, ${lit(bomLine.revisionId)}, ${lit(bomLine.id)}, ${lit(bomLine.itemId)}, 'M', 8, 0, '2026-11-10T08:00:00.000Z', now());`,
    )
  })

  it('expected 8, received 0: the order waits on the customer, since the row was made; the keeper keeps it so', async () => {
    expect(await blockerOf(order.orderId)).toEqual([{ kind: 'CUSTOMER_MATERIAL', since: new Date('2026-11-10T08:00:00.000Z'), ref: null }])
    expect((await factsOf(order.orderId))!.waiting.on).toBe('BRAND')
    // The keeper follows customer_material.changed by its orderId, and keeps the order waiting on the customer.
    expect((await system().withClient((client) => ordersOfEvent(client, { type: 'customer_material.changed', payload: { orderId: order.orderId, number: 'T-PT016', change: 'PLANNED', rows: 1, partyId: ids.a } }))).orderIds).toEqual([order.orderId])
    await changed(order.orderId)
    expect(await rowOf(order.orderId)).toMatchObject({ waitingOn: 'BRAND' })
  })

  it('half arrived: still waiting; a receipt that covers it: no longer (the keeper follows the event)', async () => {
    await raw(`UPDATE "CustomerMaterial" SET "receivedQuantity" = 4 WHERE id = ${lit(material)};`)
    expect(await blockerOf(order.orderId)).toHaveLength(1)
    await raw(`UPDATE "CustomerMaterial" SET "receivedQuantity" = 8 WHERE id = ${lit(material)};`)
    expect(await blockerOf(order.orderId)).toEqual([])
    await changed(order.orderId)
    expect((await rowOf(order.orderId)).waitingOn).not.toBe('BRAND')
  })

  it('an order whose work is done (READY) never waits on the customer’s material, even with some still to come', async () => {
    await raw(`UPDATE "CustomerMaterial" SET "receivedQuantity" = 2 WHERE id = ${lit(material)}; UPDATE "SalesOrder" SET status = 'READY' WHERE id = ${lit(order.orderId)};`)
    expect(await blockerOf(order.orderId)).toEqual([])
    await raw(`UPDATE "SalesOrder" SET status = 'CONFIRMED' WHERE id = ${lit(order.orderId)};`)
    expect(await blockerOf(order.orderId)).toHaveLength(1)
  })

  it('the wall: only the order’s own rows count — another customer’s order never waits on A’s material', async () => {
    expect(await blockerOf(w.b.salesOrderId)).toEqual([])
    const facts = await factsOf(order.orderId)
    expect(findMarkers(JSON.stringify(facts!.blockers), await markersOf(db, ids.b))).toEqual([])
  })
})
// ── end B-PT-016 ──
