import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { SCAN_TYPE_OF } from '@nexus/factory-domain/numbering/blocks'
import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../core/app'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'

/**
 * The floor sync (B-W0-30; PLT-237, PLT-239, PLT-240, PLT-189; A1 §3.8; design floor.sync SCR-023) on the local stack with
 * the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security
 * and the …_floor_sync_guards triggers are real), the factory-db seeds of two tenants up to production (plant A1 names
 * workers; its operator acknowledged the worker notice, its team leader nothing; company A's floor is ready), a made-up
 * certificate, made-up hides, made-up tablets at A1's sewing and inspection stations. Released work orders of black
 * jackets in size 50 are made, cut and bundled through the modules' routes; the tablets then send their queues through
 * POST /floor/sync. Sessions come from the test authenticator. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs floor-sync`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'fsync-a', b: 'fsync-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  cutStation: idOf(ns.a, 'site:A1:station:CUT-01'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  /** A second tablet at the cutting table (the seeded one carries the seed's scans, dated later than the tests). */
  cut2: newId(),
  sew1: newId(),
  qc: newId(),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  supervisor: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'inventory.issue', 'print.view', 'print.labels']
const floor = (deviceId: string, actorId: string, permissions: Permission[] = FLOOR): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId: A.siteA1, deviceId, grants: [grant(permissions, [A.companyA], [A.siteA1])] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  supervisor: office(A.tenant, [grant(['floorsync.view', 'floorsync.discard'])], A.supervisor),
  viewer: office(A.tenant, [grant(['floorsync.view'])]),
  companyB: office(A.tenant, [grant(['floorsync.view', 'floorsync.discard'], [A.companyB])]),
  otherTenant: office(B.tenant, [grant(['floorsync.view', 'floorsync.discard'])]),
  cutter: floor(A.cutter, A.operatorA1),
  cut2: floor(A.cut2, A.operatorA1),
  sew1: floor(A.sew1, A.operatorA1),
  qc: floor(A.qc, A.operatorA1),
  /** The team leader on the sewing tablet: has not acknowledged the notice (nothing names them). */
  leadSew1: floor(A.sew1, A.leadA1),
  /** The operator on the cutting tablet without the bundles permission. */
  cutterNoBundles: floor(A.cutter, A.operatorA1, ['floor.work', 'production.cut', 'production.scan']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
let events = 0
const eventId = () => `ev-${run}-${++events}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const count = async (sql: string, values: unknown[]) => Number((await admin<{ n: number }>(sql, values))[0]!.n)
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))

/** One send of a tablet's queue. */
const sync = (session: string, body: Json) => ok(session, 'POST', '/floor/sync', body, 200, freshKey())
const send = async (session: string, list: Json[], extra: Json = {}) => (await sync(session, { events: list, ...extra })).events as Json[]
let seq = 0
const T0 = Date.parse('2026-11-02T08:00:00.000Z')
/** Each event a second after the one before, by the tablet's clock (the queue's order). */
const ev = (kind: string, payload: Json, extra: Json = {}) => {
  const at = ++seq
  return { clientEventId: eventId(), seq: at, kind, occurredAt: new Date(T0 + at * 1000).toISOString(), workerId: A.operatorA1, payload, ...extra }
}

const hides: Record<string, { id: string; code: string }> = {}
async function addHides(count: number) {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-BIG`],
  )
  for (let index = 1; index <= count; index++) {
    const key = `H${index}`
    const hideId = newId()
    hides[key] = { id: hideId, code: `T-${run}-${key}` }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [hideId, A.tenant, A.siteA1, lotId, A.leather, hides[key]!.code])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `fsync-test-${run}-${key}`],
    )
  }
}

async function salesOrder(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: pieces }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string, size50: number): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: size50 }] }] }, 201)
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })).workOrder
}

async function cut(workOrder: Json, hideKey: string): Promise<void> {
  await ok('cutter', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: eventId(), code: hides[hideKey]!.code, lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, 201, freshKey())
}

const opOf = (workOrder: Json, seq: number): string => (workOrder.spec.operations as Json[]).find((op) => op.seq === seq)!.id
const WO = {} as Record<'scans' | 'make' | 'spare', Json>
let bundles: Json[] = []

beforeAll(async () => {
  db = await migratedDatabase('floor_sync_api')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedPrivacy({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  await addHides(3)
  for (const [deviceId, stationId, name] of [
    [A.cut2, A.cutStation, 'Second cutting tablet'],
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.qc, A.qcStation, 'Inspection tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder(26)
  WO.scans = await releasedWorkOrder(line, 12)
  await cut(WO.scans, 'H1')
  bundles = (await ok('cutter', 'POST', `/production/bundles/work-orders/${WO.scans.id}/bundles`, { bundleSize: 2, printerId: null }, 201, freshKey())).bundles
  WO.make = await releasedWorkOrder(line, 12)
  await cut(WO.make, 'H2')
  // Released, not cut: what a cut sent under another event's id would cut.
  WO.spare = await releasedWorkOrder(line, 2)
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const report = (bundle: Json, good: number, op?: string, extra: Json = {}) => ev('production.scan.report', { code: bundle.code, good, ...(op ? { workOrderOperationId: op } : {}) }, extra)
const ledgerRows = (clientEventId: string) => count(`SELECT count(*)::int AS n FROM "FloorSyncEvent" WHERE "clientEventId" = $1`, [clientEventId])

// ---- once per event --------------------------------------------------------------------------------------------------------------

describe('a resend never acts twice (PLT-189, PLT-237)', () => {
  it('records an event once: the resend is answered from the ledger with the same record', async () => {
    const event = report(bundles[0]!, 2, opOf(WO.scans, 10))
    const [first] = await send('cut2', [event])
    expect(first).toMatchObject({ clientEventId: event.clientEventId, status: 'accepted', result: { type: 'OperationScan' }, refusal: null })
    const [again] = await send('cut2', [event])
    expect(again).toMatchObject({ status: 'duplicate', result: first!.result, serverTime: first!.serverTime })
    expect(await count(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "clientScanId" = $1`, [event.clientEventId])).toBe(1)
    expect(await ledgerRows(event.clientEventId)).toBe(1)
    const [row] = await admin(`SELECT outcome, "deviceSeq", "deviceTime", kind, "resultType" FROM "FloorSyncEvent" WHERE "clientEventId" = $1`, [event.clientEventId])
    expect(row).toMatchObject({ outcome: 'ACCEPTED', deviceSeq: event.seq, kind: 'production.scan.report', resultType: 'OperationScan' })
    expect(new Date(row!.deviceTime).toISOString()).toBe(event.occurredAt)
  })

  it('answers a resend from the ledger even when the module would refuse the copy (the recorded one stands)', async () => {
    const event = report(bundles[1]!, 2, opOf(WO.scans, 10))
    expect((await send('cut2', [event]))[0]!.status).toBe('accepted')
    // The same event again with another count: it was recorded; nothing is done again, nothing is refused.
    const [again] = await send('cut2', [{ ...event, payload: { ...event.payload, good: 1 } }])
    expect(again).toMatchObject({ status: 'duplicate' })
    expect(await count(`SELECT count(*)::int AS n FROM "FloorRefusedAction" WHERE "clientEventId" = $1`, [event.clientEventId])).toBe(0)
  })

  it("refuses an id the ledger recorded for another kind, even where that kind's module would take it (a cut under a bundle's id)", async () => {
    const cell = WO.make.cells[0]
    const made = ev('production.bundles.make', { workOrderId: WO.make.id, cells: [{ workOrderSizeId: cell.id, quantities: [1] }], printerId: null })
    expect((await send('cutter', [made]))[0]).toMatchObject({ status: 'accepted', result: { type: 'Bundle' } })
    const asCut = { ...made, kind: 'production.cut.log', payload: { workOrderId: WO.spare.id, code: hides.H3!.code, lines: WO.spare.cells.map((row: Json) => ({ workOrderSizeId: row.id, sets: row.quantity })) } }
    const [answer] = await send('cutter', [asCut])
    expect(answer).toMatchObject({ status: 'refused', refusal: { code: 'CLIENT_ID_REUSED', final: true } })
    expect(await count(`SELECT count(*)::int AS n FROM "CutLog" WHERE "workOrderId" = $1`, [WO.spare.id])).toBe(0)
  })

  it('refuses the same id for another kind, and keeps the refusal', async () => {
    const event = report(bundles[2]!, 2, opOf(WO.scans, 10))
    expect((await send('cut2', [event]))[0]!.status).toBe('accepted')
    const [reused] = await send('cut2', [{ ...event, kind: 'production.scan.undo', payload: { undoesClientScanId: event.clientEventId } }])
    expect(reused).toMatchObject({ status: 'refused', refusal: { code: 'CLIENT_ID_REUSED', final: true } })
  })

  it('makes a bundle once with the ticket code the tablet numbered from its own block; a resend answers the same bundle', async () => {
    const top = await sync('cutter', { events: [], blocks: [{ kind: 'BUNDLE', remaining: 0 }] })
    const block = (top.blocks.blocks as Json[]).find((row) => row.kind === 'BUNDLE' && row.remaining > 0)!
    const code = formatScanId({ type: SCAN_TYPE_OF.BUNDLE, tenantTag: tenantTag(A.tenant), ref: block.highestUsedRef === null ? block.fromRef : block.highestUsedRef + 1 })
    const cell = WO.make.cells[0]
    const event = ev('production.bundles.make', { workOrderId: WO.make.id, cells: [{ workOrderSizeId: cell.id, quantities: [6] }], printerId: null, ticketCode: code })
    const [made] = await send('cutter', [event])
    expect(made).toMatchObject({ status: 'accepted', result: { type: 'Bundle' } })
    const [bundle] = await admin(`SELECT code, quantity, "clientEventId" FROM "Bundle" WHERE id = $1`, [made!.result.id])
    expect(bundle).toEqual({ code, quantity: 6, clientEventId: event.clientEventId })
    expect(await count(`SELECT count(*)::int AS n FROM "NumberBlockUse" WHERE code = $1 AND "recordId" = $2`, [code, made!.result.id])).toBe(1)
    const [again] = await send('cutter', [event])
    expect(again).toMatchObject({ status: 'duplicate', result: made!.result })
    expect(await count(`SELECT count(*)::int AS n FROM "Bundle" WHERE "clientEventId" = $1`, [event.clientEventId])).toBe(1)
  })

  it("refuses a ticket number outside the tablet's own blocks, in words, with the fix to print a new label", async () => {
    const cell = WO.make.cells[0]
    const foreign = formatScanId({ type: SCAN_TYPE_OF.BUNDLE, tenantTag: tenantTag(A.tenant), ref: 999_999 })
    const [refused] = await send('cutter', [ev('production.bundles.make', { workOrderId: WO.make.id, cells: [{ workOrderSizeId: cell.id, quantities: [2] }], printerId: null, ticketCode: foreign })])
    expect(refused).toMatchObject({ status: 'refused', refusal: { code: 'NOT_RESERVED', final: true, fix: expect.stringMatching(/Print a new/) } })
    expect(await count(`SELECT count(*)::int AS n FROM "Bundle" WHERE code = $1`, [foreign])).toBe(0)
  })
})

// ---- in the tablet's order --------------------------------------------------------------------------------------------------------

describe("in the tablet's order (FIFO per device)", () => {
  it('applies one send by seq: an undo listed before its report still follows it', async () => {
    const reportEvent = report(bundles[3]!, 2, opOf(WO.scans, 10))
    const undoEvent = ev('production.scan.undo', { undoesClientScanId: reportEvent.clientEventId })
    const answers = await send('cut2', [undoEvent, reportEvent])
    expect(answers.map((answer) => [answer.seq, answer.kind, answer.status]), JSON.stringify(answers)).toEqual([
      [reportEvent.seq, 'production.scan.report', 'accepted'],
      [undoEvent.seq, 'production.scan.undo', 'accepted'],
    ])
    const [undone] = await admin(`SELECT kind, "correctsId" FROM "OperationScan" WHERE id = $1`, [answers[1]!.result.id])
    expect(undone).toEqual({ kind: 'UNDO', correctsId: answers[0]!.result.id })
  })

  it('refuses a send that names a seq or an id twice', async () => {
    const one = report(bundles[4]!, 1)
    const response = await call('sew1', 'POST', '/floor/sync', { events: [one, { ...one, clientEventId: eventId() }] }, freshKey())
    expect(response.statusCode).toBe(400)
    expect(response.json().error.message).toMatch(/twice/)
  })

  it("keeps another person's action waiting, never recorded under the name of the one signed in", async () => {
    const event = report(bundles[4]!, 2, opOf(WO.scans, 10), { workerId: A.leadA1 })
    const [answer] = await send('cut2', [event])
    expect(answer).toMatchObject({ status: 'waiting', refusal: { id: null, code: 'OTHER_WORKER', final: false } })
    expect(await count(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "clientScanId" = $1`, [event.clientEventId])).toBe(0)
    expect(await count(`SELECT count(*)::int AS n FROM "FloorRefusedAction" WHERE "clientEventId" = $1`, [event.clientEventId])).toBe(0)
  })

  it("flags the tablet's clock when it is more than five minutes off (PLT-240)", async () => {
    const sentAt = new Date(Date.now() - 10 * 60_000).toISOString()
    const answer = await sync('sew1', { sentAt, events: [] })
    expect(answer.clock).toMatchObject({ deviceSentAt: sentAt, off: true, flagged: false })
    expect(answer.clock.skewSeconds).toBeGreaterThanOrEqual(599)
  })
})

// ---- refused actions -------------------------------------------------------------------------------------------------------------

describe('a refused action is kept with its reason in words and one fix (PLT-239)', () => {
  it('keeps a refused scan (and the scans module keeps its own record of it); the tablet sees it, the office too', async () => {
    const event = ev('production.scan.report', { code: 'NOT-A-BUNDLE-123', good: 1 })
    const [answer] = await send('sew1', [event])
    expect(answer).toMatchObject({ status: 'refused', refusal: { code: 'UNKNOWN_BUNDLE', final: true } })
    const [row] = await admin(`SELECT status, code, message, fix, "moduleRefusalType", "workerId", summary FROM "FloorRefusedAction" WHERE id = $1`, [answer!.refusal.id])
    expect(row).toMatchObject({ status: 'OPEN', code: 'UNKNOWN_BUNDLE', moduleRefusalType: 'FloorScanRefusal', workerId: A.operatorA1, summary: { code: 'NOT-A-BUNDLE-123', good: 1 } })
    const mine = await ok('sew1', 'GET', '/floor/sync')
    expect(mine.subject).toBe('WORKER')
    expect(mine.refused.map((refused: Json) => refused.id)).toContain(answer!.refusal.id)
    const list = await ok('supervisor', 'GET', `/floor-sync/refused?deviceId=${A.sew1}`)
    expect(list.refused.map((refused: Json) => refused.id)).toContain(answer!.refusal.id)
    expect(list.refused.find((refused: Json) => refused.id === answer!.refusal.id)).toMatchObject({ device: { id: A.sew1, name: 'Sewing tablet 1' }, code: 'UNKNOWN_BUNDLE', fix: expect.any(String) })
    expect(JSON.stringify(list)).not.toContain('Seed Worker')
    const one = await ok('supervisor', 'GET', `/floor-sync/refused/${answer!.refusal.id}`)
    expect(one.refused).toMatchObject({ worker: { id: A.operatorA1 }, payload: { code: 'NOT-A-BUNDLE-123', good: 1 }, moduleRefusal: { type: 'FloorScanRefusal' } })
  })

  it("counts another person's refused actions on the tablet, never shows them (Statuto dei Lavoratori art. 4)", async () => {
    const [answer] = await send('leadSew1', [ev('production.scan.report', { code: 'NOT-A-BUNDLE-456', good: 1 }, { workerId: A.leadA1 })])
    expect(answer!.status).toBe('refused')
    // The lead has not acknowledged the notice: the refusal names nobody, so the operator's view counts it as another person's.
    const mine = await ok('sew1', 'GET', '/floor/sync')
    expect(mine.refused.map((refused: Json) => refused.id)).not.toContain(answer!.refusal.id)
    expect(mine.othersRefused).toBeGreaterThanOrEqual(1)
    expect((await call('sew1', 'POST', `/floor/sync/refused/${answer!.refusal.id}/discard`, {}, freshKey())).statusCode).toBe(404)
  })

  it('a refusal that may pass later is resolved when the same event passes', async () => {
    // Inspection before sewing: the previous operation is not reported (it may be in another tablet's queue).
    const early = report(bundles[5]!, 2, opOf(WO.scans, 30))
    const [first] = await send('qc', [early])
    expect(first).toMatchObject({ status: 'refused', refusal: { code: 'PREVIOUS_NOT_REPORTED', final: false } })
    expect((await send('cut2', [report(bundles[5]!, 2, opOf(WO.scans, 10))]))[0]!.status).toBe('accepted')
    expect((await send('sew1', [report(bundles[5]!, 2, opOf(WO.scans, 20))]))[0]!.status).toBe('accepted')
    const [later] = await send('qc', [early])
    expect(later).toMatchObject({ status: 'accepted', result: { type: 'OperationScan' } })
    const [row] = await admin(`SELECT r.status, r."resolvedAt" IS NOT NULL AS at, e."clientEventId" FROM "FloorRefusedAction" r JOIN "FloorSyncEvent" e ON e.id = r."resolvedByEventId" WHERE r.id = $1`, [first!.refusal.id])
    expect(row).toEqual({ status: 'RESOLVED', at: true, clientEventId: early.clientEventId })
    expect((await ok('qc', 'GET', '/floor/sync')).refused.map((refused: Json) => refused.id)).not.toContain(first!.refusal.id)
  })

  it("the tablet discards its own: it will not be recorded, and the scans module's record closes with it", async () => {
    const [answer] = await send('sew1', [ev('production.scan.report', { code: 'NOT-A-BUNDLE-789', good: 2 })])
    const discarded = await ok('sew1', 'POST', `/floor/sync/refused/${answer!.refusal.id}/discard`, {}, 200, freshKey())
    expect(discarded.refused).toMatchObject({ status: 'DISCARDED', discardedBy: 'FLOOR', discardReason: expect.stringMatching(/tablet/) })
    const [module] = await admin(`SELECT m."discardedAt" IS NOT NULL AS closed FROM "FloorRefusedAction" r JOIN "FloorScanRefusal" m ON m.id = r."moduleRefusalId" WHERE r.id = $1`, [answer!.refusal.id])
    expect(module).toEqual({ closed: true })
    // Once: again answers as it is.
    expect((await ok('sew1', 'POST', `/floor/sync/refused/${answer!.refusal.id}/discard`, {}, 200, freshKey())).refused.status).toBe('DISCARDED')
  })

  it('the office discards with a reason and the version it read; within its scope only', async () => {
    const [answer] = await send('cutterNoBundles', [ev('production.bundles.make', { workOrderId: WO.make.id, printerId: null })])
    expect(answer).toMatchObject({ status: 'refused', refusal: { code: 'NOT_ALLOWED', final: true } })
    const id = answer!.refusal.id as string
    expect((await call('companyB', 'GET', `/floor-sync/refused/${id}`)).statusCode).toBe(404)
    expect((await ok('companyB', 'GET', '/floor-sync/refused')).refused).toEqual([])
    expect((await call('otherTenant', 'GET', `/floor-sync/refused/${id}`)).statusCode).toBe(404)
    expect((await call('viewer', 'POST', `/floor-sync/refused/${id}/discard`, { reason: 'Not needed any more.', version: 1 })).statusCode).toBe(403)
    expect((await call('supervisor', 'POST', `/floor-sync/refused/${id}/discard`, { reason: 'x', version: 1 })).statusCode).toBe(400)
    expect((await call('supervisor', 'POST', `/floor-sync/refused/${id}/discard`, { reason: 'Not needed any more.', version: 9 })).statusCode).toBe(409)
    const discarded = await ok('supervisor', 'POST', `/floor-sync/refused/${id}/discard`, { reason: 'Not needed any more.', version: 1 })
    expect(discarded.refused).toMatchObject({ status: 'DISCARDED', discardedBy: 'OFFICE', discardReason: 'Not needed any more.' })
    expect((await ok('supervisor', 'GET', '/floor-sync/refused')).refused.map((refused: Json) => refused.id)).not.toContain(id)
    expect((await ok('supervisor', 'GET', '/floor-sync/refused?status=DISCARDED')).refused.map((refused: Json) => refused.id)).toContain(id)
    const [audit] = await admin(`SELECT reason, audience FROM "AuditLog" WHERE "recordId" = $1 AND action = 'floorsync.discardRefused'`, [id])
    expect(audit).toEqual({ reason: 'Not needed any more.', audience: 'OFFICE' })
    expect(await count(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE type = 'floor.refused_action_closed' AND payload->>'refusedId' = $1`, [id])).toBe(1)
  })

  it('refuses an unknown kind and a payload its module refuses, in words', async () => {
    const answers = await send('sew1', [ev('production.scan.teleport', {}), ev('production.scan.report', { good: 'many' })])
    expect(answers.map((answer) => [answer.status, answer.refusal.code])).toEqual([
      ['refused', 'UNKNOWN_KIND'],
      ['refused', 'BAD_EVENT'],
    ])
  })
})

// ---- number blocks ----------------------------------------------------------------------------------------------------------------

describe("the tablet's number blocks are topped up with its sync", () => {
  it('reserves a block when the tablet runs low, and none while it has enough', async () => {
    const blocksOf = async () => count(`SELECT count(*)::int AS n FROM "NumberBlock" WHERE "deviceId" = $1 AND kind = 'BUNDLE' AND purpose = 'DEVICE'`, [A.sew1])
    const before = await blocksOf()
    const low = await sync('sew1', { events: [], blocks: [{ kind: 'BUNDLE', remaining: 0 }] })
    expect(await blocksOf()).toBe(before + 1)
    expect(low.blocks.scanTag).toBe(tenantTag(A.tenant))
    expect((low.blocks.blocks as Json[]).filter((block) => block.kind === 'BUNDLE').length).toBe(before + 1)
    await sync('sew1', { events: [], blocks: [{ kind: 'BUNDLE', remaining: 150 }] })
    expect(await blocksOf()).toBe(before + 1)
    // Without counts: only the open blocks, nothing reserved.
    expect((await sync('sew1', { events: [], blocks: [] })).blocks.blocks.length).toBeGreaterThan(0)
    expect(await blocksOf()).toBe(before + 1)
  })
})
