import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPlanning, type PlanningSeed } from '../../../../../../packages/factory-db/seed/planning'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { systemContext } from '../../../platform/outbox/system'
import { useCountsClock } from '../counts/counts'
import { releaseForDoneWorkOrder, releaseOnWorkOrderDoneHandler, runReservationCleanup } from '../reservations/system-release'

/**
 * B-W2b-15 — stock follow-ups on the local stack, with the app's real routes on a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security, grants and the …_followups_stock_w2b_guards triggers are real), the
 * seeds of one tenant up to planning (SEED-CNT-0001 COUNTING over A1's store) and, on top, made-up stock at A1 (a released
 * black leather lot of three hides, a grey lining lot, a protector lot) and released work orders made through the routes:
 *   - Z2:01 StockMove.reasonCode: a write-off, an adjustment, a count's apply and a production scrap carry their code;
 *     the reason lists' usage counts read it (a write-off move with the code only in its column counts);
 *   - Z2:02 reversing a hide's write-off opens the hide again (back to the state it had); a hide scrapped before W2b stays;
 *   - Z2:03 / SCM-211 a done work order's reservations released by the system (the handler), never an open one's; the
 *     nightly clean-up releases what the handler missed and an order's line of a cancelled order;
 *   - Z2:04 / SCM-213 a work order's kit: staged at a place, "Mark kit complete" held while lines are short, checked once
 *     every line is picked, opened again with the reason; Picking & kits shows the place and the check;
 *   - Z2:05 the counts list's saved rows (waiting for approval, to apply), the lines per place, a thread on a count;
 *   - Z2:06 the count's item search finds finished garments.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/inventory/stock/follow-ups`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let seeded: PlanningSeed

const ns = 'stock-follow-ups-w2b'
const idOf = (key: string) => seedUuid(ns, key)
const A = {
  tenant: idOf('tenant'),
  actor: idOf('actor'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  style: idOf('production:style:JKT-02'),
  blk: idOf('production:colourway:JKT-02:BLK'),
  leather: idOf('product:item:leather'),
  lining: idOf('product:item:lining'),
  protector: idOf('product:item:protector'),
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  liningGRY: idOf('product:item-colour:lining:GRY'),
  store: idOf('inventory:location:A1-STORE'),
  bin: idOf('inventory:location:A1-STORE-01'),
  cutting: idOf('inventory:location:A1-CUT'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const counterId = newId()
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  sales: office([grant(['orders.view', 'orders.manage'])]),
  /** The warehouse role: reserve, issue, write off, adjust, reverse, count; sees no cost. */
  warehouse: office(
    [grant(['inventory.reserve', 'inventory.stock.view', 'inventory.scrap', 'inventory.reverse', 'inventory.issue', 'inventory.issue.over', 'inventory.adjust', 'inventory.counts.view', 'inventory.counts.manage', 'threads.read', 'threads.post', 'reasons.view', 'production.scrap'])],
    counterId,
  ),
  /** Sees the stock and the counts, picks nothing. */
  viewer: office([grant(['inventory.stock.view', 'inventory.counts.view'])]),
  /** Company B only. */
  'company-b': office([grant(['inventory.stock.view', 'inventory.issue', 'inventory.counts.view'], [idOf('company:B')])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))
const system = () => callerFor(database, systemContext(A.tenant, `test-${run}-${++keys}`))
const reservation = async (id: string) => (await admin<{ status: string; releasedById: string | null; releaseReason: string | null }>(`SELECT status::text, "releasedById", "releaseReason" FROM "Reservation" WHERE id = $1`, [id]))[0]!

// ---- made-up stock and work orders ----------------------------------------------------------------------------------------

const hides: Record<string, string> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(key: string, itemId: string, colourId: string | null, stock: { quantity: string; uom: string; hide?: string }[]) {
  const lotId = newId()
  lots[key] = { id: lotId, code: `T-${run}-${key}` }
  const leather = itemId === A.leather
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'RELEASED', now(), $8, $9, $10, $11, $12, $13, now() - interval '20 days')`,
    [lotId, A.tenant, A.companyA, A.siteA1, itemId, colourId, lots[key].code, leather, leather ? '3.000' : null, leather ? 'PASS' : 'NOT_REQUIRED', leather ? '1.100' : null, leather ? 'LOT_REPORT' : null, leather ? '2026-10-01' : null],
  )
  for (const [index, entry] of stock.entries()) {
    const hideId = entry.hide ? newId() : null
    if (hideId) {
      hides[entry.hide!] = hideId
      await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [hideId, A.tenant, A.siteA1, lotId, itemId, `T-${run}-${entry.hide}`, entry.quantity])
    }
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note)
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now() - interval '30 days', 'Made-up opening stock')`,
      [newId(), A.tenant, A.companyA, A.siteA1, itemId, colourId, lotId, hideId, A.bin, entry.quantity, entry.uom, `fu-test-${lots[key].code}-${index}`],
    )
  }
}

async function salesOrder(suffix: string): Promise<{ orderId: string; lineId: string }> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO-${suffix}`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: 1, unitPrice: '100.000000', netAmount: 10_000, vatRatePct: '22.00', vatAmount: 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: 1 }, select: { id: true } })
  })
  return { orderId, lineId }
}

async function releasedWorkOrder(suffix: string): Promise<Json> {
  const { lineId } = await salesOrder(suffix)
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 1 }] }] }, 201)
  // The seeds' own work orders count on most of the stock: released on the planner's override (this file tests stock).
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { version: workOrder.version, materialOverride: { reason: 'Made-up test: stock follow-ups' } })).workOrder
}

const workOrderVersion = async (id: string) => (await admin<{ version: number }>(`SELECT version FROM "WorkOrder" WHERE id = $1`, [id]))[0]!.version
const cancelWorkOrder = async (id: string) => ok('planner', 'POST', `/production/work-orders/${id}/cancel`, { version: await workOrderVersion(id), reason: 'Made-up cancellation' })

beforeAll(async () => {
  db = await migratedDatabase('stock_follow_ups_w2b')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  await seedCore({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await seedReasons({ db: database, namespace: ns })
  seeded = await seedPlanning({ db: database, namespace: ns })
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Carla Conti', 'ACTIVE')`, [counterId, A.tenant, `${counterId.slice(-6)}@example.com`])
  await addLot('BLK', A.leather, A.leatherBLK, [
    { quantity: '60.0000', uom: 'FT2', hide: 'H1' },
    { quantity: '55.0000', uom: 'FT2', hide: 'H2' },
    { quantity: '50.0000', uom: 'FT2', hide: 'H3' },
  ])
  await addLot('LIN', A.lining, A.liningGRY, [{ quantity: '200.0000', uom: 'M' }])
  await addLot('PRO', A.protector, null, [{ quantity: '200.0000', uom: 'PCS' }])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
      logger: false,
    },
  )
}, 180_000)

afterAll(async () => {
  useCountsClock(undefined)
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- Z2:01 + Z2:02 -------------------------------------------------------------------------------------------------------

describe('moves carry their reason code (Z2:01) and a hide written off comes back (Z2:02)', () => {
  let hideMove: Json

  it('a write-off\'s SCRAP moves keep the code in their own column (the note still starts with it)', async () => {
    const { writeOff } = await ok('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'DAMAGED', note: 'Torn at the edge', lines: [{ hideId: hides.H3 }, { lotId: lots.LIN!.id, fromLocationId: A.bin, quantity: '1.5' }] }, 201)
    expect(writeOff.moves.map((move: Json) => [move.reason, move.reasonCode, move.note])).toEqual([
      ['SCRAP', 'DAMAGED', 'DAMAGED: Torn at the edge'],
      ['SCRAP', 'DAMAGED', 'DAMAGED: Torn at the edge'],
    ])
    hideMove = writeOff.moves.find((move: Json) => move.hideId === hides.H3)
    const rows = await admin<{ code: string }>(`SELECT "reasonCode" AS code FROM "StockMove" WHERE id = ANY($1::uuid[])`, [writeOff.moves.map((move: Json) => move.id)])
    expect(rows.map((row) => row.code)).toEqual(['DAMAGED', 'DAMAGED'])
    const [hide] = await admin<{ state: string; previous: string }>(`SELECT state::text, "previousState"::text AS previous FROM "Hide" WHERE id = $1`, [hides.H3])
    expect(hide).toEqual({ state: 'SCRAPPED', previous: 'FULL' })
    // The ledger still reads the write-off's code and words.
    const ledger = await ok('warehouse', 'GET', `/inventory/ledger?siteId=${A.siteA1}&writeOffs=true`)
    expect(ledger.moves.find((move: Json) => move.id === hideMove.id).writeOff).toMatchObject({ reasonCode: 'DAMAGED', note: 'Torn at the edge' })
  })

  it('reversing the hide\'s scrap opens the hide again, back to the state it had, in one command', async () => {
    const { move, reversed, reopenedHide } = await ok('warehouse', 'POST', `/inventory/moves/${hideMove.id}/reverse`, { note: 'Written off by mistake: the tear is on the offcut' }, 201)
    expect(reversed).toBe(hideMove.id)
    expect(move).toMatchObject({ reason: 'SCRAP', reversalOfId: hideMove.id, toLocationId: A.bin, hideId: hides.H3 })
    expect(reopenedHide).toEqual({ id: hides.H3, code: `T-${run}-H3`, state: 'FULL' })
    const [hide] = await admin<{ state: string; previous: string | null }>(`SELECT state::text, "previousState"::text AS previous FROM "Hide" WHERE id = $1`, [hides.H3])
    expect(hide).toEqual({ state: 'FULL', previous: null })
    const audit = await admin<{ before: Json; after: Json }>(`SELECT before, after FROM "AuditLog" WHERE "recordType" = 'Hide' AND "recordId" = $1 AND action = 'inventory.hideState' ORDER BY at, id`, [hides.H3])
    expect(audit.map((row) => [row.before.state, row.after.state])).toEqual([
      ['FULL', 'SCRAPPED'],
      ['SCRAPPED', 'FULL'],
    ])
    // It is usable again: a reservation may hold it.
    const work = await releasedWorkOrder('REOPEN')
    await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: work.id, lines: [{ hideId: hides.H3 }] }, 201)
  })

  it('a hide scrapped before W2b (no state kept) stays SCRAPPED: its scrap is refused in words', async () => {
    const { writeOff } = await ok('warehouse', 'POST', '/inventory/write-offs', { siteId: A.siteA1, reasonCode: 'LOST', lines: [{ hideId: hides.H2 }] }, 201)
    // As a hide written off before the database kept the state (B-W2b-01): its previous state erased by the owner.
    await admin(`ALTER TABLE "Hide" DISABLE TRIGGER USER`)
    await admin(`UPDATE "Hide" SET "previousState" = NULL WHERE id = $1`, [hides.H2])
    await admin(`ALTER TABLE "Hide" ENABLE TRIGGER USER`)
    const error = await refused('warehouse', 'POST', `/inventory/moves/${writeOff.moves[0].id}/reverse`, { note: 'Found again' }, 409)
    expect(error.message).toMatch(/scrapped before the state it had was kept: it stays SCRAPPED/)
    expect((await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "StockMove" WHERE "reversalOfId" = $1`, [writeOff.moves[0].id]))[0]!.n).toBe(0)
  })

  it('an adjustment takes a code of the ADJUSTMENT list (an unknown one is refused); the lists\' usage counts read the column', async () => {
    const before = await ok('warehouse', 'GET', '/reasons/lists?list=WRITE_OFF,ADJUSTMENT')
    const used = (answer: Json, list: string, code: string) => answer.lists.find((entry: Json) => entry.list === list).reasons.find((reason: Json) => reason.code === code).usedCount as number
    expect(paths(await refused('warehouse', 'POST', '/inventory/adjustments', { siteId: A.siteA1, itemId: A.lining, lotId: lots.LIN!.id, locationId: A.bin, direction: 'IN', quantity: '0.5', note: 'Found behind the rack', reasonCode: 'NO_SUCH' }, 400))).toEqual(['body/reasonCode'])
    const { move } = await ok('warehouse', 'POST', '/inventory/adjustments', { siteId: A.siteA1, itemId: A.lining, lotId: lots.LIN!.id, locationId: A.bin, direction: 'IN', quantity: '0.5', note: 'Found behind the rack', reasonCode: 'FOUND' }, 201)
    expect(move).toMatchObject({ reason: 'ADJUSTMENT', reasonCode: 'FOUND', note: 'Found behind the rack' })
    // A write-off move whose note is the person's words only: its code is read from the column.
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "fromLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt", note, "reasonCode")
       VALUES ($1, $2, $3, $4, 'SCRAP', $5, $6, $7, $8, '0.2000', 'M', '0.2000', $9, now(), 'Gone mouldy', 'EXPIRED')`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.lining, A.liningGRY, lots.LIN!.id, A.bin, `inventory.writeOff:col-${run}:1`],
    )
    const after = await ok('warehouse', 'GET', '/reasons/lists?list=WRITE_OFF,ADJUSTMENT')
    expect(used(after, 'ADJUSTMENT', 'FOUND')).toBe(used(before, 'ADJUSTMENT', 'FOUND') + 1)
    expect(used(after, 'WRITE_OFF', 'EXPIRED')).toBe(used(before, 'WRITE_OFF', 'EXPIRED') + 1)
    // The write-offs of the first two tests: one per write-off, not per move.
    expect(used(after, 'WRITE_OFF', 'DAMAGED')).toBe(1)
    expect(used(after, 'WRITE_OFF', 'LOST')).toBe(1)
  })

  it('production scrap keeps the floor list\'s code on its SCRAP moves', async () => {
    const work = await releasedWorkOrder('SCRAP')
    const answer = await ok('warehouse', 'POST', '/production/scrap/stock', { workOrderId: work.id, reasonCode: (await admin<{ code: string }>(`SELECT code FROM "ScrapReason" WHERE kind = 'SCRAP' AND active ORDER BY "sortOrder", code LIMIT 1`))[0]!.code, note: 'Stained at the line side', lines: [{ lotId: lots.LIN!.id, fromLocationId: A.bin, quantity: '0.5' }] }, 201)
    const moveIds = (answer.scrap.moves as Json[]).map((move) => move.id)
    const rows = await admin<{ code: string | null; note: string }>(`SELECT "reasonCode" AS code, note FROM "StockMove" WHERE id = ANY($1::uuid[])`, [moveIds])
    expect(rows.length).toBe(1)
    expect(rows[0]!.code).toBe(answer.scrap.reasonCode)
    expect(rows[0]!.note).toBe(`${answer.scrap.reasonCode}: Stained at the line side`)
  })
})

// ---- Z2:03 + SCM-211 -----------------------------------------------------------------------------------------------------

describe('reservations released by the system (Z2:03) and the nightly clean-up (SCM-211)', () => {
  it('a cancelled work order\'s reservations are released by the handler: no person, the reason in words, one event', async () => {
    const work = await releasedWorkOrder('CANCEL')
    const { reservations } = await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: work.id, lines: [{ lotId: lots.LIN!.id, quantity: '2' }] }, 201)
    // While the work order is open the system releases nothing (the handler ignores other moves; a direct call too).
    const handler = releaseOnWorkOrderDoneHandler()
    const envelope = (to: string): EventEnvelope => ({ eventId: newId(), type: 'workorder.status_changed', version: 1, tenantId: A.tenant, payload: { workOrderId: work.id, number: work.number, from: 'RELEASED', to } }) as unknown as EventEnvelope
    await handler.handle(envelope('IN_PROGRESS'), { caller: system(), attempt: 1 })
    expect(await releaseForDoneWorkOrder(system(), work.id)).toEqual({ released: [] })
    expect((await reservation(reservations[0].id)).status).toBe('ACTIVE')
    await cancelWorkOrder(work.id)
    await handler.handle(envelope('CANCELLED'), { caller: system(), attempt: 1 })
    expect(await reservation(reservations[0].id)).toEqual({ status: 'RELEASED', releasedById: null, releaseReason: `Released by the system: work order ${work.number} is cancelled, so nothing needs the rest any more.` })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.reservations_released' AND payload->'reservationIds' ? $1`, [reservations[0].id])
    expect(events.map((row) => row.payload.bySystem)).toEqual(['WORK_ORDER_DONE'])
    const [audit] = await admin<{ actorId: string | null; reason: string }>(`SELECT "actorId", reason FROM "AuditLog" WHERE "recordType" = 'Reservation' AND "recordId" = $1 AND action = 'inventory.releaseReservation'`, [reservations[0].id])
    expect(audit!.reason).toMatch(/^Released by the system/)
    // A repeat finds nothing to release.
    expect(await releaseForDoneWorkOrder(system(), work.id)).toEqual({ released: [] })
    // It is no longer stale: nothing is left for a person to release.
    const stale = await ok('warehouse', 'GET', `/inventory/reservations?stale=true&siteId=${A.siteA1}`)
    expect(stale.reservations.map((row: Json) => row.id)).not.toContain(reservations[0].id)
  })

  it('the nightly clean-up releases what the handler missed and an order line of a cancelled order; an open demand keeps its own', async () => {
    const missed = await releasedWorkOrder('MISSED')
    const open = await releasedWorkOrder('OPEN')
    const held = (await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: missed.id, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] }, 201)).reservations[0]
    const kept = (await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, workOrderId: open.id, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] }, 201)).reservations[0]
    const order = await salesOrder('LINE')
    const forLine = (await ok('warehouse', 'POST', '/inventory/reservations', { siteId: A.siteA1, salesOrderLineId: order.lineId, lines: [{ lotId: lots.LIN!.id, quantity: '1' }] }, 201)).reservations[0]
    await cancelWorkOrder(missed.id)
    const [orderRow] = await admin<{ version: number }>(`SELECT version FROM "SalesOrder" WHERE id = $1`, [order.orderId])
    await ok('sales', 'POST', `/sales/orders/${order.orderId}/cancel`, { version: orderRow!.version, reason: 'Made-up: the customer withdrew' })
    const logged: Json[] = []
    const result = await runReservationCleanup({ database, log: { info: (fields: Json) => logged.push(fields), warn: () => undefined, error: () => undefined } as never })
    expect(result.failed).toBe(0)
    expect(result.released).toBeGreaterThanOrEqual(2)
    expect(await reservation(held.id)).toMatchObject({ status: 'RELEASED', releasedById: null, releaseReason: `Released by the nightly clean-up: work order ${missed.number} is cancelled, so nothing needs it any more.` })
    expect(await reservation(forLine.id)).toMatchObject({ status: 'RELEASED', releasedById: null, releaseReason: `Released by the nightly clean-up: order T-${run}-SO-LINE is cancelled, so nothing needs it any more.` })
    expect((await reservation(kept.id)).status).toBe('ACTIVE')
    expect(logged.some((fields) => fields.released >= 2)).toBe(true)
    // A second night finds nothing.
    expect((await runReservationCleanup({ database, log: { info: () => undefined, warn: () => undefined, error: () => undefined } as never })).stale).toBe(0)
  })
})

// ---- Z2:04 + SCM-213 -----------------------------------------------------------------------------------------------------

describe('a work order\'s kit: staged, checked complete, opened again (Z2:04, SCM-213)', () => {
  let work: Json
  let kit: Json

  it('starts with no record (version 0, OPEN, nowhere); "Mark kit complete" is held while lines are short', async () => {
    work = await releasedWorkOrder('KIT')
    kit = (await ok('warehouse', 'GET', `/inventory/kits/${work.id}`)).kit
    expect(kit).toMatchObject({ workOrderId: work.id, number: work.number, status: 'OPEN', location: null, checkedAt: null, version: 0 })
    expect(kit.lines.all).toBeGreaterThan(0)
    expect(kit.actions).toEqual({ stage: { allowed: true, held: null }, complete: { allowed: false, held: 'LINES_SHORT', count: kit.lines.all }, reopen: { allowed: false, held: 'NOT_CHECKED' } })
    const held = await refused('warehouse', 'POST', `/inventory/kits/${work.id}/complete`, { version: 0 }, 409)
    expect(paths(held)).toEqual(['kit/LINES_SHORT'])
    expect(held.message).toBe(`${kit.lines.all} line(s) of work order ${work.number} are still short: the kit is checked complete once every line is picked in full.`)
  })

  it('is staged at a place of the site (the record made by the first write), never a workshop\'s; a stale version is refused', async () => {
    const staged = (await ok('warehouse', 'POST', `/inventory/kits/${work.id}/stage`, { version: 0, locationId: A.cutting })).kit
    expect(staged).toMatchObject({ location: { id: A.cutting, code: 'A1-CUT' }, version: 1, checkedAt: null })
    expect((await refused('warehouse', 'POST', `/inventory/kits/${work.id}/stage`, { version: 0, locationId: A.bin }, 409)).message).toMatch(/changed since you read it/)
    const workshop = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "siteId" = $1 AND kind = 'SUBCONTRACTOR' LIMIT 1`, [A.siteA1]))[0]
    if (workshop) expect(paths(await refused('warehouse', 'POST', `/inventory/kits/${work.id}/stage`, { version: 1, locationId: workshop.id }, 400))).toEqual(['body/locationId'])
    const otherSite = (await admin<{ id: string }>(`SELECT id FROM "Location" WHERE "siteId" <> $1 LIMIT 1`, [A.siteA1]))[0]!
    expect(paths(await refused('warehouse', 'POST', `/inventory/kits/${work.id}/stage`, { version: 1, locationId: otherSite.id }, 400))).toEqual(['body/locationId'])
    const [event] = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.kit_changed' AND subject = $1 ORDER BY id`, [work.id])
    expect(event!.payload).toEqual({ workOrderId: work.id, number: work.number, change: 'STAGED', stagingLocationId: A.cutting, checked: false })
    kit = staged
  })

  it('is the warehouse\'s: a viewer cannot stage it, another company does not see it', async () => {
    expect((await call('viewer', 'POST', `/inventory/kits/${work.id}/stage`, { version: 1, locationId: A.bin })).statusCode).toBe(403)
    expect((await call('company-b', 'GET', `/inventory/kits/${work.id}`)).statusCode).toBe(404)
    expect((await call('company-b', 'POST', `/inventory/kits/${work.id}/stage`, { version: 1, locationId: A.bin })).statusCode).toBe(404)
  })

  it('once every line is picked, it is checked complete (when, never who, in the answer) and Picking & kits shows place and check', async () => {
    // Pick every line: hides for the leather until it is covered, the lining and the protectors from their lots.
    for (const hide of ['H1']) await ok('warehouse', 'POST', `/inventory/picking/work-orders/${work.id}/issue`, { hideId: hides[hide] }, 201)
    await ok('warehouse', 'POST', `/inventory/picking/work-orders/${work.id}/issue`, { lotId: lots.LIN!.id }, 201)
    await ok('warehouse', 'POST', `/inventory/picking/work-orders/${work.id}/issue`, { lotId: lots.PRO!.id }, 201)
    kit = (await ok('warehouse', 'GET', `/inventory/kits/${work.id}`)).kit
    expect(kit).toMatchObject({ status: 'COMPLETE', lines: { short: 0 }, actions: { complete: { allowed: true, held: null } } })
    const checked = (await ok('warehouse', 'POST', `/inventory/kits/${work.id}/complete`, { version: kit.version, note: 'Counted at the rack' })).kit
    expect(checked).toMatchObject({ checkedAt: expect.any(String), note: 'Counted at the rack', version: kit.version + 1, actions: { complete: { held: 'ALREADY_CHECKED' }, reopen: { allowed: true } } })
    expect(JSON.stringify(checked)).not.toMatch(/Carla|completedById/)
    const [row] = await admin<{ by: string }>(`SELECT "completedById" AS by FROM "WorkOrderKit" WHERE id = $1`, [work.id])
    expect(row!.by).toBe(counterId)
    const page = await ok('warehouse', 'GET', `/inventory/picking/pick-lists?siteId=${A.siteA1}&q=${encodeURIComponent(work.number)}`)
    expect(page.rows.find((entry: Json) => entry.workOrder.id === work.id).kit).toEqual({ status: 'COMPLETE', location: { id: A.cutting, code: 'A1-CUT', name: 'Cutting room rack' }, checkedAt: checked.checkedAt, version: checked.version })
    const sheet = await ok('warehouse', 'GET', `/inventory/picking/pick-lists/sheet?workOrderIds=${work.id}`)
    expect(sheet.sheets[0].kit).toMatchObject({ status: 'COMPLETE', location: { code: 'A1-CUT' }, checkedAt: checked.checkedAt, all: kit.lines.all, short: 0 })
    kit = checked
  })

  it('is opened again with the reason (kept in the work order\'s history); it may be checked again', async () => {
    expect(paths(await refused('warehouse', 'POST', `/inventory/kits/${work.id}/reopen`, { version: kit.version }, 400))).toContain('body/reason')
    const reopened = (await ok('warehouse', 'POST', `/inventory/kits/${work.id}/reopen`, { version: kit.version, reason: 'A protector pocket is missing' })).kit
    expect(reopened).toMatchObject({ checkedAt: null, actions: { complete: { allowed: true }, reopen: { held: 'NOT_CHECKED' } } })
    const history = await admin<{ action: string; reason: string | null }>(`SELECT action, reason FROM "AuditLog" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1 AND action LIKE 'inventory.kit%' ORDER BY at, id`, [work.id])
    expect(history.map((row) => row.action)).toEqual(['inventory.kitStaged', 'inventory.kitCompleted', 'inventory.kitReopened'])
    expect(history[2]!.reason).toBe('A protector pocket is missing')
    const changes = await admin<{ change: string }>(`SELECT payload->>'change' AS change FROM "OutboxEvent" WHERE type = 'inventory.kit_changed' AND subject = $1 ORDER BY id`, [work.id])
    expect(changes.map((row) => row.change)).toEqual(['STAGED', 'COMPLETED', 'REOPENED'])
  })

  it('a done work order\'s kit is not staged or checked any more', async () => {
    const other = await releasedWorkOrder('KIT-DONE')
    await cancelWorkOrder(other.id)
    const answer = (await ok('warehouse', 'GET', `/inventory/kits/${other.id}`)).kit
    expect(answer.actions.stage).toEqual({ allowed: false, held: 'WORK_ORDER_NOT_OPEN' })
    expect(paths(await refused('warehouse', 'POST', `/inventory/kits/${other.id}/stage`, { version: 0, locationId: A.cutting }, 409))).toEqual(['kit/WORK_ORDER_NOT_OPEN'])
  })
})

// ---- Z2:05 + Z2:06 -------------------------------------------------------------------------------------------------------

describe('counts: the saved rows, lines per place, a thread (Z2:05) and finished garments in the search (Z2:06)', () => {
  it('lists the lines per place of SEED-CNT-0001: every place with its lines, counted and differing', async () => {
    const { places } = await ok('viewer', 'GET', `/inventory/stock-counts/${seeded.countId}/places`)
    expect(places).toEqual([{ location: { id: A.bin, code: 'A1-STORE-01', name: expect.any(String), path: 'A1-STORE/A1-STORE-01' }, lines: 2, counted: 1, differing: 1 }])
    expect((await call('company-b', 'GET', `/inventory/stock-counts/${seeded.countId}/places`)).statusCode).toBe(404)
  })

  it('"waiting for approval" and "to apply" are filtered by the API as the tiles count them', async () => {
    const list = async (view: string) => ((await ok('viewer', 'GET', `/inventory/stock-counts?siteId=${A.siteA1}&view=${view}`)).counts as Json[]).map((count) => count.id)
    expect(await list('toApply')).not.toContain(seeded.countId)
    expect(await list('waitingApproval')).not.toContain(seeded.countId)
    // Counted and submitted (the counts' clock after the seeded snapshot): under the limit it waits to be applied.
    useCountsClock({ now: () => new Date('2026-12-01T09:00:00.000Z') })
    const { lines } = await ok('warehouse', 'GET', `/inventory/stock-counts/${seeded.countId}/lines`)
    await ok('warehouse', 'POST', `/inventory/stock-counts/${seeded.countId}/lines/record`, {
      lines: lines.map((line: Json) => (line.counted === null ? { lineId: line.id, version: line.version, counted: line.expected } : { lineId: line.id, version: line.version, reasonCode: 'COUNT_ERROR' })),
    })
    const { count } = await ok('warehouse', 'GET', `/inventory/stock-counts/${seeded.countId}`)
    const submitted = (await ok('warehouse', 'POST', `/inventory/stock-counts/${seeded.countId}/submit`, { version: count.version })).count
    const tiles = await ok('viewer', 'GET', `/inventory/stock-counts/counts?siteId=${A.siteA1}`)
    if (submitted.approvalRequired) {
      expect(await list('waitingApproval')).toEqual([seeded.countId])
      expect(await list('toApply')).not.toContain(seeded.countId)
      expect(tiles.waitingApproval).toBe(1)
    } else {
      expect(await list('toApply')).toEqual([seeded.countId])
      expect(await list('waitingApproval')).not.toContain(seeded.countId)
      expect(tiles.toApply).toBe(1)
    }
    expect((await call('viewer', 'GET', `/inventory/stock-counts?view=nothing`)).statusCode).toBe(400)
  })

  it('a count has its own thread: a note posted and read back, of the count\'s company and site', async () => {
    const posted = await call('warehouse', 'POST', `/threads/StockCount/${seeded.countId}/notes`, { body: 'The second shelf was counted twice by mistake.' })
    expect(posted.statusCode, posted.body).toBe(201)
    const thread = await ok('warehouse', 'GET', `/threads/StockCount/${seeded.countId}`)
    expect(JSON.stringify(thread)).toContain('The second shelf was counted twice by mistake.')
    const [row] = await admin<{ companyId: string; siteId: string }>(`SELECT "companyId", "siteId" FROM "Thread" WHERE "recordType" = 'StockCount' AND "recordId" = $1`, [seeded.countId])
    expect(row).toEqual({ companyId: A.companyA, siteId: A.siteA1 })
    expect((await call('warehouse', 'GET', `/threads/StockCount/${newId()}`)).statusCode).toBe(404)
  })

  it('the item search finds materials and finished garments (FINISHED, one per SKU) of the site\'s company, with their colours', async () => {
    const variantId = newId()
    const finishedId = newId()
    await admin(`INSERT INTO "Variant" (id, "tenantId", "styleId", "colourwayId", size, sku) VALUES ($1, $2, $3, $4, '64', $5)`, [variantId, A.tenant, A.style, A.blk, `T-${run}-JKT-BLK-64`])
    await admin(
      `INSERT INTO "Item" (id, "tenantId", "companyId", code, name, kind, tracking, "baseUom", "purchaseUom", "consumptionUom", "variantId") VALUES ($1, $2, $3, $4, 'Made-up jacket black 64', 'FINISHED', 'SERIAL', 'PCS', 'PCS', 'PCS', $5)`,
      [finishedId, A.tenant, A.companyA, `T-${run}-JKT-BLK-64`, variantId],
    )
    const finished = await ok('viewer', 'GET', `/inventory/stock-counts/items?siteId=${A.siteA1}&q=${encodeURIComponent(`T-${run}-JKT`)}`)
    expect(finished.items).toEqual([{ id: finishedId, code: `T-${run}-JKT-BLK-64`, name: 'Made-up jacket black 64', kind: 'FINISHED', baseUom: 'PCS', tracking: 'SERIAL', colours: [] }])
    const lining = await ok('viewer', 'GET', `/inventory/stock-counts/items?siteId=${A.siteA1}&q=lining`)
    expect(lining.items.find((item: Json) => item.id === A.lining)).toMatchObject({ kind: 'LINING', colours: expect.arrayContaining([expect.objectContaining({ id: A.liningGRY })]) })
    expect((await ok('viewer', 'GET', `/inventory/stock-counts/items?siteId=${A.siteA1}&q=lining&kind=FINISHED`)).items).toEqual([])
    expect((await call('company-b', 'GET', `/inventory/stock-counts/items?siteId=${A.siteA1}&q=lining`)).statusCode).toBe(404)
  })
})
