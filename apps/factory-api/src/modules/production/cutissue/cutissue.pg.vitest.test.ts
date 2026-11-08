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
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * After the cut (B-W2b-117; MES-044 recut tickets, MES-047 secondary processes, MES-048 cut issue to sewing) through the app's real
 * routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_cutting_room_w2b_guards triggers are real): the factory-db seeds of two tenants up to production and numbering (the CUT_TICKET
 * series), made-up hides of one dye batch at A1, a made-up second line L2 with a sewing station, and made-up tablets at sewing
 * stations of L1 and L2. A released work order of 16 black jackets in size 50 is cut and bundled in fours through the floor's routes. In order:
 *   - recut tickets: what a bundle can take, the office's ticket from the same shade lot, its refusals, a sewing tablet's ask
 *     (numbered by the system), one from an office recut request, the cutting table's list, card, scans, print and the void;
 *   - secondary processes: fusing in house and embroidery outside, the scan at the tablet, start and done, the outside one sent
 *     from the office only, cancelled;
 *   - trolleys: loaded (a pending process and another trolley refuse), unloaded, sent, received at the line with a difference,
 *     refused at another line, a load through the floor queue (a resend answers once), cancelled; the office's lists; scopes.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/cutissue`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'cutissue-a', b: 'cutissue-b' } as const
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
  lineL1: idOf(ns.a, 'site:A1:line:L1'),
  sewCentre: idOf(ns.a, 'site:A1:work-centre:SEW'),
  cutCentre: idOf(ns.a, 'site:A1:work-centre:CUT'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  lineL2: newId(),
  sewL2Station: newId(),
  sew1: newId(),
  sewL2: newId(),
  manager: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const CUTTER: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'inventory.issue', 'print.view', 'print.labels', 'production.secondary', 'production.trolleys']
const SEWING: Permission[] = ['floor.work', 'production.scan', 'production.recuts', 'production.trolleys']
const floor = (deviceId: string, permissions: Permission[]): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [grant(permissions, [A.companyA], [A.siteA1])] })
const MANAGE: Permission[] = ['workorders.view', 'production.cutting.view', 'production.recuts', 'production.secondary', 'production.trolleys', 'production.cut', 'production.scrap', 'production.scrap.view', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  manager: office(A.tenant, [grant(MANAGE)], A.manager),
  viewer: office(A.tenant, [grant(['production.cutting.view'])]),
  companyB: office(A.tenant, [grant(MANAGE, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(MANAGE)]),
  cutter: floor(A.cutter, CUTTER),
  sew1: floor(A.sew1, SEWING),
  sewL2: floor(A.sewL2, SEWING),
  /** A sewing tablet without production.recuts. */
  noRecut: floor(A.sew1, ['floor.work', 'production.scan', 'production.trolleys']),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'POST' ? { 'idempotency-key': key ?? freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status = 409): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation|fee/i
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))

// ---- made-up stock, a work order, its cut and bundles -------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}
let shadeLot = ''
let otherBatchLot = ''

async function addLot(key: string, dyeBatch: string, hideCount: number): Promise<string> {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-${key}`, dyeBatch],
  )
  for (let index = 1; index <= hideCount; index++) {
    const hideKey = `${key}${index}`
    const hideId = newId()
    hides[hideKey] = { id: hideId, code: `T-${run}-${hideKey}` }
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [hideId, A.tenant, A.siteA1, lotId, A.leather, hides[hideKey]!.code])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `cutissue-test-${run}-${hideKey}`],
    )
  }
  return lotId
}

async function releasedWorkOrder(size50: number): Promise<Json> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: size50, unitPrice: '100.000000', netAmount: size50 * 10_000, vatRatePct: '22.00', vatAmount: size50 * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: size50 }, select: { id: true } })
  })
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: size50 }] }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

let WO: Json
let BN: Json[] = []
let cell = ''

beforeAll(async () => {
  db = await migratedDatabase('production_cutissue')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedPrivacy({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  // A made-up EU type-examination certificate of the style (a released work order of PPE garments needs one).
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  shadeLot = await addLot('SHADE', '7731', 2)
  otherBatchLot = await addLot('OTHER', '9100', 1)
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'L2', 'Line 2 (A1)')`, [A.lineL2, A.tenant, A.companyA, A.siteA1])
  await admin(`INSERT INTO "Station" (id, "tenantId", "companyId", "siteId", "lineId", "workCentreId", code, name) VALUES ($1, $2, $3, $4, $5, $6, 'SEW-21', 'Sewing station L2')`, [A.sewL2Station, A.tenant, A.companyA, A.siteA1, A.lineL2, A.sewCentre])
  for (const [deviceId, stationId, name] of [
    [A.sew1, A.sew1Station, 'Sewing tablet L1'],
    [A.sewL2, A.sewL2Station, 'Sewing tablet L2'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, 'Made-up production manager', 'ACTIVE')`, [A.manager, A.tenant, `${A.manager}-${run}@example.test`])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  WO = await releasedWorkOrder(16)
  cell = WO.cells[0].id
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${WO.id}/cuts`, { clientEventId: `cut-${run}-1`, code: hides.SHADE1!.code, lines: [{ workOrderSizeId: cell, sets: 16 }] })
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${WO.id}/bundles`, { bundleSize: 4, printerId: null })
  expect(made.statusCode, made.body).toBe(201)
  BN = made.json().bundles
  expect(BN).toHaveLength(4)
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- recut tickets (MES-044) ----------------------------------------------------------------------------------------------------

describe('recut tickets (MES-044): replacement panels that join the original bundle', { timeout: 60_000 }, () => {
  const T = {} as Record<'office' | 'floor' | 'extra' | 'fromRequest', Json>
  let part = ''

  it('answers what a recut of a bundle can be: its cell, parts and shade lot (its genealogy)', async () => {
    const options = await ok('manager', 'GET', `/production/recut-tickets/options?code=${BN[0]!.code}`)
    expect(options).toMatchObject({ bundle: { id: BN[0]!.id, live: 4, status: 'ACTIVE' }, workOrder: { id: WO.id, status: 'RELEASED' }, cell: { id: cell, size: '50' }, refusal: null })
    expect(options.shadeLots).toEqual([expect.objectContaining({ id: shadeLot, dyeBatch: '7731' })])
    expect(options.parts.length).toBeGreaterThan(0)
    part = options.parts[0]
    // A tablet sees the same, but never an office recut request.
    expect((await ok('sew1', 'GET', `/production/recut-tickets/options?code=${BN[0]!.code}`)).replacements).toEqual([])
    await refused('noRecut', 'GET', `/production/recut-tickets/options?code=${BN[0]!.code}`, undefined, 403)
  })

  it('the office makes one from the same shade lot: numbered from the CUT_TICKET series, audited, live', async () => {
    const made = await ok('manager', 'POST', '/production/recut-tickets', { code: BN[0]!.code, part, quantity: 2, lotId: shadeLot, reason: 'Two panels with a scuff' }, 201)
    T.office = made.ticket
    expect(made.warnings).toEqual([])
    expect(made.ticket).toMatchObject({ status: 'OPEN', bundle: { id: BN[0]!.id, code: BN[0]!.code }, part, quantity: 2, lot: { id: shadeLot, dyeBatch: '7731' }, endBits: false, cell: { size: '50' }, workOrder: { id: WO.id }, replacement: null })
    expect(made.ticket.code).toBe(made.ticket.number.toUpperCase())
    expect(made.ticket.from.en).toBe(`Lot T-${run}-SHADE`)
    const [row] = await admin(`SELECT kind, "workOrderId", "workOrderSizeId", "bundleId", "lotItemId", "createdById" FROM "CutTicket" WHERE id = $1`, [made.ticket.id])
    expect(row).toMatchObject({ kind: 'RECUT', workOrderId: WO.id, workOrderSizeId: cell, bundleId: BN[0]!.id, lotItemId: A.leather, createdById: A.manager })
    const audit = await admin(`SELECT action, "recordType", reason FROM "AuditLog" WHERE "recordId" IN ($1, $2) AND action = 'production.makeRecutTicket' ORDER BY "recordType"`, [made.ticket.id, WO.id])
    expect(audit.map((entry) => entry.recordType)).toEqual(['CutTicket', 'WorkOrder'])
    expect(audit[0]!.reason).toBe('Two panels with a scuff')
    expect((await events('recut_ticket.changed')).at(-1)).toMatchObject({ ticketId: made.ticket.id, change: 'MADE', workOrderId: WO.id, bundleId: BN[0]!.id, quantity: 2, ticketStatus: 'OPEN' })
    expect(keysOf(made).filter((key) => MONEY.test(key))).toEqual([])
  })

  it('refuses in words: no source, another dye batch, more than the bundle, a part the pattern does not name', async () => {
    const base = { code: BN[0]!.code, part, quantity: 1, reason: 'Panel torn' }
    expect(refusalOf(await refused('manager', 'POST', '/production/recut-tickets', base))).toBe('refusal/NO_SOURCE')
    const shade = await refused('manager', 'POST', '/production/recut-tickets', { ...base, lotId: otherBatchLot })
    expect(refusalOf(shade)).toBe('refusal/LOT_NOT_SAME_SHADE')
    expect(shade.message).toBe(`Lot T-${run}-OTHER is not the shade of the bundle (T-${run}-SHADE): cut from the same shade lot or from end bits.`)
    expect(refusalOf(await refused('manager', 'POST', '/production/recut-tickets', { ...base, endBits: true, quantity: 7 }))).toBe('refusal/MORE_THAN_BUNDLE')
    expect(refusalOf(await refused('manager', 'POST', '/production/recut-tickets', { ...base, endBits: true, part: 'Not a panel' }))).toBe('refusal/NOT_A_PART')
    // Another company's office and another tenant never see the bundle.
    await refused('companyB', 'POST', '/production/recut-tickets', { ...base, endBits: true }, 404)
    await refused('otherTenant', 'POST', '/production/recut-tickets', { ...base, endBits: true }, 404)
  })

  it('a sewing tablet asks for one: the system numbers it (never the tablet); a tablet without the right is refused', async () => {
    const asked = await ok('sew1', 'POST', '/production/recut-tickets', { code: BN[1]!.code, part, quantity: 1, endBits: true, reason: 'Seam allowance cut short' }, 201)
    T.floor = asked.ticket
    expect(asked.ticket).toMatchObject({ status: 'OPEN', bundle: { id: BN[1]!.id }, lot: null, endBits: true, replacement: null })
    expect(asked.ticket.from.it).toBe('Ritagli')
    const [audit] = await admin(`SELECT audience, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'production.makeRecutTicket'`, [asked.ticket.id])
    expect(audit).toMatchObject({ audience: 'SYSTEM', after: expect.objectContaining({ askedAt: 'FLOOR', deviceId: A.sew1 }) })
    expect((await admin(`SELECT "createdById" FROM "CutTicket" WHERE id = $1`, [asked.ticket.id]))[0]!.createdById).toBeNull()
    await refused('noRecut', 'POST', '/production/recut-tickets', { code: BN[1]!.code, quantity: 1, endBits: true, reason: 'x' }, 403)
    // The same key answers the same ticket.
    const key = freshKey()
    const first = await ok('sew1', 'POST', '/production/recut-tickets', { code: BN[2]!.code, quantity: 1, endBits: true, reason: 'Again' }, 201, key)
    const again = await ok('sew1', 'POST', '/production/recut-tickets', { code: BN[2]!.code, quantity: 1, endBits: true, reason: 'Again' }, 201, key)
    expect(again.ticket.id).toBe(first.ticket.id)
    expect(again.replayed).toBe(true)
    T.extra = first.ticket
  })

  it('answers an office recut request (it then names the ticket for good)', async () => {
    // A whole garment to recut (the scrap page's "Ask for recut"): the ticket takes its part (none) and its sets.
    const asked = await ok('manager', 'POST', '/production/replacements', { kind: 'RECUT', quantity: 1, workOrderId: WO.id, workOrderSizeId: cell, reason: 'Garment lost at sewing' }, 201)
    const replacement = asked.replacement
    expect(refusalOf(await refused('manager', 'POST', '/production/recut-tickets', { replacementId: replacement.id, code: BN[3]!.code, part, endBits: true, reason: 'Another part' }))).toBe('refusal/REPLACEMENT_OTHER_PART')
    const made = await ok('manager', 'POST', '/production/recut-tickets', { replacementId: replacement.id, code: BN[3]!.code, endBits: true, reason: 'From the recut list' }, 201)
    expect(made.ticket).toMatchObject({ part: null, quantity: 1, replacement: { id: replacement.id, status: 'OPEN', quantity: 1 } })
    expect((await admin(`SELECT "recutTicketId" FROM "ReplacementRequest" WHERE id = $1`, [replacement.id]))[0]!.recutTicketId).toBe(made.ticket.id)
    expect(refusalOf(await refused('manager', 'POST', '/production/recut-tickets', { replacementId: replacement.id, code: BN[3]!.code, endBits: true, reason: 'Twice' }))).toBe('refusal/REPLACEMENT_HAS_TICKET')
    // A tablet never names an office request.
    await refused('sew1', 'POST', '/production/recut-tickets', { replacementId: replacement.id, code: BN[3]!.code, endBits: true, reason: 'x' }, 403)
    T.fromRequest = made.ticket
  })

  it('the cutting table lists them, scans the start and the end; the panels join the bundle', async () => {
    const waiting = await ok('cutter', 'GET', '/production/recut-tickets/waiting')
    expect(waiting.rows.map((row: Json) => row.id)).toEqual(expect.arrayContaining([T.office.id, T.floor.id, T.fromRequest.id]))
    expect(waiting.counts).toMatchObject({ started: 0 })
    expect(waiting.rows.every((row: Json) => row.replacement === null)).toBe(true)
    const card = await ok('cutter', 'GET', `/production/recut-tickets/scan?code=${T.office.code.toLowerCase()}`)
    expect(card.next).toMatchObject({ next: 'START', refusal: null, words: { en: 'Scan to start the recut.' } })
    const started = await ok('cutter', 'POST', '/production/recut-tickets/start', { code: T.office.code })
    expect(started).toMatchObject({ ticket: { status: 'STARTED' }, next: { next: 'FINISH' }, replayed: false })
    expect(refusalOf(await refused('cutter', 'POST', '/production/recut-tickets/start', { code: T.office.code }))).toBe('refusal/TICKET_STARTED')
    expect(refusalOf(await refused('cutter', 'POST', '/production/recut-tickets/finish', { code: T.floor.code }))).toBe('refusal/TICKET_NOT_STARTED')
    const done = await ok('cutter', 'POST', '/production/recut-tickets/finish', { code: T.office.code })
    expect(done).toMatchObject({ ticket: { status: 'DONE' }, next: { next: 'NONE', refusal: { code: 'TICKET_DONE' } } })
    expect(refusalOf(await refused('cutter', 'POST', '/production/recut-tickets/finish', { code: T.office.code }))).toBe('refusal/TICKET_DONE')
    // The bundle's genealogy names the recut; the events follow the ticket.
    const [joined] = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Bundle' AND "recordId" = $1 AND action = 'production.finishRecutTicket'`, [BN[0]!.id])
    expect(joined!.after).toMatchObject({ recutJoined: { ticketId: T.office.id, quantity: 2 } })
    expect((await events('recut_ticket.changed')).filter((event) => event.ticketId === T.office.id).map((event) => event.change)).toEqual(['MADE', 'STARTED', 'DONE'])
    // The office scans nothing at the table; an unknown code is not found.
    await refused('manager', 'POST', '/production/recut-tickets/start', { code: T.floor.code }, 403)
    await refused('cutter', 'GET', '/production/recut-tickets/scan?code=NOPE-0001', undefined, 404)
  })

  it('prints its label (shown when no printer is chosen), and the office voids a wrong one with the reason', async () => {
    const printed = await ok('cutter', 'POST', `/production/recut-tickets/${T.floor.id}/print`, { printerId: null, language: 'en' })
    expect(printed).toMatchObject({ job: null, problem: 'No label printer is chosen: the label is shown, not printed.' })
    expect(printed.label.title).toBe(`${part} × 1 sets · SEED-JKT-02 BLK 50`)
    expect(printed.label.fields).toEqual(expect.arrayContaining([{ label: 'Joins bundle', value: BN[1]!.code }, { label: 'Cut from', value: 'End bits' }]))
    const voided = await ok('manager', 'POST', `/production/recut-tickets/${T.extra.id}/void`, { version: T.extra.version, reason: 'Asked twice' })
    expect(voided.ticket).toMatchObject({ status: 'VOID', voidReason: 'Asked twice' })
    expect(refusalOf(await refused('cutter', 'POST', '/production/recut-tickets/start', { code: T.extra.code }))).toBe('refusal/TICKET_VOID')
    await refused('sew1', 'POST', `/production/recut-tickets/${T.floor.id}/void`, { version: 1, reason: 'x' }, 403)
    const list = await ok('manager', 'GET', `/production/recut-tickets?view=all&workOrderId=${WO.id}`)
    expect(list.tiles).toEqual({ open: 2, started: 0, done: 1, void: 1 })
    expect(list.rows.find((row: Json) => row.id === T.fromRequest.id).replacement).not.toBeNull()
    expect((await ok('companyB', 'GET', `/production/recut-tickets?view=all`)).rows).toEqual([])
  })
})

// ---- secondary processes (MES-047) ----------------------------------------------------------------------------------------------

describe('secondary processes after cutting (MES-047): a route step before sewing', { timeout: 60_000 }, () => {
  let fusing: Json
  let embroidery: Json

  it('gives bundles a process: fusing in house at a work centre, embroidery outside; one open process of a kind', async () => {
    const added = await ok('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[1]!.code }], kind: 'FUSING', place: 'IN_HOUSE', workCentreId: A.cutCentre }, 201)
    fusing = added.processes[0]
    expect(fusing).toMatchObject({ kind: 'FUSING', place: 'IN_HOUSE', status: 'WAITING', quantity: 4, seq: 10, workCentre: { code: 'CUT' }, bundle: { id: BN[1]!.id }, words: { it: 'termoadesivatura' }, subcontractOrder: null })
    const outside = await ok('manager', 'POST', '/production/secondary-processes', { bundles: [{ bundleId: BN[1]!.id }], kind: 'EMBROIDERY', place: 'OUTSIDE', quantity: 3, note: 'Logo on the sleeve' }, 201)
    embroidery = outside.processes[0]
    expect(embroidery).toMatchObject({ place: 'OUTSIDE', quantity: 3, seq: 20, workCentre: null })
    expect(refusalOf(await refused('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[1]!.code }], kind: 'FUSING', place: 'IN_HOUSE' }))).toBe('refusal/KIND_OPEN_ALREADY')
    expect(refusalOf(await refused('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[2]!.code }], kind: 'PRINT', place: 'OUTSIDE', workCentreId: A.cutCentre }))).toBe('refusal/WORK_CENTRE_OUTSIDE')
    expect(refusalOf(await refused('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[2]!.code }], kind: 'PRINT', place: 'IN_HOUSE', quantity: 9 }))).toBe('refusal/MORE_THAN_BUNDLE')
    expect((await events('secondary_process.changed')).filter((event) => event.bundleId === BN[1]!.id).map((event) => event.change)).toEqual(['ADDED', 'ADDED'])
  })

  it('a scan of the bundle says what a tap does next; the tablet starts and finishes the fusing', async () => {
    const scanned = await ok('cutter', 'GET', `/production/secondary-processes/bundle?code=${BN[1]!.code}`)
    expect(scanned.next).toMatchObject({ processId: fusing.id, move: 'start', words: { en: 'Start fusing' } })
    expect(scanned.toSewing.en).toBe(`Bundle ${BN[1]!.code} waits for fusing, embroidery: it goes to sewing after them.`)
    expect(scanned.processes.every((process: Json) => process.subcontractOrder === null)).toBe(true)
    const started = await ok('cutter', 'POST', `/production/secondary-processes/${fusing.id}/start`, {})
    expect(started.process).toMatchObject({ status: 'IN_PROGRESS', startedAt: expect.any(String) })
    expect(refusalOf(await refused('cutter', 'POST', `/production/secondary-processes/${fusing.id}/start`, {}))).toBe('refusal/WRONG_STATE')
    const done = await ok('cutter', 'POST', `/production/secondary-processes/${fusing.id}/done`, {})
    expect(done.process).toMatchObject({ status: 'DONE', doneAt: expect.any(String) })
  })

  it('an outside process is sent from the office with its subcontract order (the tablet is refused), or cancelled with the reason', async () => {
    expect(refusalOf(await refused('cutter', 'POST', `/production/secondary-processes/${embroidery.id}/start`, {}))).toBe('refusal/OUTSIDE_FROM_OFFICE')
    expect(refusalOf(await refused('manager', 'POST', `/production/secondary-processes/${embroidery.id}/start`, { version: embroidery.version }))).toBe('refusal/SUBCONTRACT_NEEDED')
    await refused('manager', 'POST', `/production/secondary-processes/${embroidery.id}/cancel`, { version: embroidery.version }, 400)
    const cancelled = await ok('manager', 'POST', `/production/secondary-processes/${embroidery.id}/cancel`, { version: embroidery.version, reason: 'Embroidered on the finished jacket instead' })
    expect(cancelled.process).toMatchObject({ status: 'CANCELLED', cancelReason: 'Embroidered on the finished jacket instead' })
    const list = await ok('manager', 'GET', `/production/secondary-processes?view=all&workOrderId=${WO.id}`)
    expect(list.tiles).toEqual({ waiting: 0, inProgress: 0, done: 1, cancelled: 1 })
    expect((await ok('companyB', 'GET', '/production/secondary-processes?view=all')).rows).toEqual([])
    expect(keysOf(list).filter((key) => MONEY.test(key))).toEqual([])
  })
})

// ---- trolleys to sewing (MES-048) -----------------------------------------------------------------------------------------------

describe('cut issue to sewing (MES-048): bundles onto a trolley, to a line, confirmed by its scan', { timeout: 60_000 }, () => {
  it('loads bundles onto a trolley (its line: the one named); a pending process and another trolley refuse', async () => {
    // Bundle 3 waits for perforation: it goes to sewing after it.
    const perforation = (await ok('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[2]!.code }], kind: 'PERFORATION', place: 'IN_HOUSE' }, 201)).processes[0]
    const first = await ok('cutter', 'POST', '/production/trolleys/load', { trolley: ' t-3 ', bundle: BN[0]!.code, lineId: A.lineL1 })
    expect(first.trolley).toMatchObject({ trolleyCode: 'T-3', status: 'LOADING', line: { id: A.lineL1, code: 'L1' }, counts: { bundles: 1 } })
    await ok('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-3', bundle: BN[1]!.code })
    const pending = await refused('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-3', bundle: BN[2]!.code })
    expect(refusalOf(pending)).toBe('refusal/PROCESS_PENDING')
    expect(pending.message).toBe(`Bundle ${BN[2]!.code} waits for perforation: it goes to sewing after it.`)
    expect(refusalOf(await refused('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-4', bundle: BN[0]!.code, lineId: A.lineL1 }))).toBe('refusal/ON_ANOTHER_TROLLEY')
    expect(refusalOf(await refused('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-3', bundle: BN[0]!.code }))).toBe('refusal/ON_THIS_TROLLEY')
    await refused('cutter', 'POST', '/production/trolleys/load', { trolley: 'T 3', bundle: BN[0]!.code }, 400)
    // A bundle given a process once it is on a trolley is refused.
    expect(refusalOf(await refused('cutter', 'POST', '/production/secondary-processes', { bundles: [{ code: BN[0]!.code }], kind: 'PRINT', place: 'IN_HOUSE' }))).toBe('refusal/ON_A_TROLLEY')
    await ok('cutter', 'POST', `/production/secondary-processes/${perforation.id}/start`, {})
    await ok('cutter', 'POST', `/production/secondary-processes/${perforation.id}/done`, {})
    await ok('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-3', bundle: BN[2]!.code })
    // A wrong scan is taken off.
    const unloaded = await ok('cutter', 'POST', '/production/trolleys/unload', { trolley: 'T-3', bundle: BN[2]!.code })
    expect(unloaded.trolley.counts.bundles).toBe(2)
    expect(refusalOf(await refused('cutter', 'POST', '/production/trolleys/unload', { trolley: 'T-3', bundle: BN[2]!.code }))).toBe('refusal/NOT_ON_TROLLEY')
  })

  it('a load from the floor queue (by the trolley label) is applied once; a resend answers duplicate', async () => {
    const event = { clientEventId: `trolley-${run}-1`, seq: 1, kind: 'production.trolley.load', occurredAt: new Date().toISOString(), payload: { trolley: 'T-3', bundle: BN[2]!.code } }
    const sent = await ok('cutter', 'POST', '/floor/sync', { events: [event] })
    expect(sent.events[0]).toMatchObject({ status: 'accepted', result: { type: 'CutIssue' } })
    const again = await ok('cutter', 'POST', '/floor/sync', { events: [event] })
    expect(again.events[0]).toMatchObject({ status: 'duplicate' })
    const card = await ok('cutter', 'GET', '/production/trolleys/scan?code=T-3')
    expect(card).toMatchObject({ code: 'T-3', next: 'LOAD', trolley: { counts: { bundles: 3 }, send: { en: 'Send 3 bundles to line L1' } } })
    // A queued load the trolley refuses is kept with its words.
    const bad = await ok('cutter', 'POST', '/floor/sync', { events: [{ clientEventId: `trolley-${run}-2`, seq: 2, kind: 'production.trolley.load', payload: { trolley: 'T-9', bundle: BN[2]!.code, lineId: A.lineL1 } }] })
    expect(bad.events[0]).toMatchObject({ status: 'refused', refusal: { code: 'ON_ANOTHER_TROLLEY' } })
  })

  it('sends the trolley; the line confirms it by scanning its label, with a bundle not found as a difference', async () => {
    const sent = await ok('cutter', 'POST', '/production/trolleys/send', { trolley: 'T-3' })
    expect(sent.trolley).toMatchObject({ status: 'SENT', sentAt: expect.any(String) })
    expect(refusalOf(await refused('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-3', bundle: BN[3]!.code }))).toBe('refusal/TROLLEY_SENT')
    const open = await ok('sew1', 'GET', '/production/trolleys/open')
    expect(open.here).toMatchObject({ id: A.lineL1 })
    expect(open.rows[0]).toMatchObject({ trolleyCode: 'T-3', status: 'SENT' })
    expect((await ok('sew1', 'GET', '/production/trolleys/scan?code=T-3')).next).toBe('RECEIVE')
    const other = await refused('sewL2', 'POST', '/production/trolleys/receive', { trolley: 'T-3' })
    expect(other).toMatchObject({ message: 'Trolley T-3 goes to line L1; this tablet is at line L2.' })
    const received = await ok('sew1', 'POST', '/production/trolleys/receive', { trolley: 'T-3', missing: [BN[2]!.code, 'BN-NOT-HERE'] })
    expect(received.trolley).toMatchObject({ status: 'RECEIVED', counts: { bundles: 3, received: 2, missing: 1 } })
    expect(received.differences).toBe(`Not found on the trolley: ${BN[2]!.code}. Named missing but not on it: BN-NOT-HERE.`)
    expect(received.trolley.bundles.find((row: Json) => row.bundle.id === BN[2]!.id).receivedAt).toBeNull()
    expect((await events('cut_issue.changed')).filter((event) => event.trolleyCode === 'T-3').map((event) => event.change)).toEqual(['OPENED', 'LOADED', 'LOADED', 'LOADED', 'UNLOADED', 'LOADED', 'SENT', 'RECEIVED'])
    expect((await events('cut_issue.changed')).at(-1)).toMatchObject({ missing: 1, bundles: 3, issueStatus: 'RECEIVED' })
    // Received: a new scan of the label starts a new load.
    expect((await ok('cutter', 'GET', '/production/trolleys/scan?code=T-3'))).toMatchObject({ trolley: null, next: 'LOAD' })
  })

  it('a trolley loaded by mistake is cancelled; the office reads every trolley; scopes hold', async () => {
    const loaded = await ok('cutter', 'POST', '/production/trolleys/load', { trolley: 'T-5', bundle: BN[3]!.code, lineId: A.lineL2 })
    expect(refusalOf(await refused('cutter', 'POST', '/production/trolleys/receive', { trolley: 'T-5' }))).toBe('refusal/TROLLEY_NOT_SENT')
    const cancelled = await ok('cutter', 'POST', `/production/trolleys/${loaded.trolley.id}/cancel`, { version: loaded.trolley.version, reason: 'Wrong line' })
    expect(cancelled.trolley).toMatchObject({ status: 'CANCELLED', cancelReason: 'Wrong line' })
    const list = await ok('manager', 'GET', `/production/trolleys?view=all&siteId=${A.siteA1}`)
    expect(list.tiles).toMatchObject({ received: 1, cancelled: 1 })
    const record = await ok('viewer', 'GET', `/production/trolleys/${list.rows.find((row: Json) => row.trolleyCode === 'T-3').id}`)
    expect(record.trolley.bundles).toHaveLength(3)
    expect(record.trolley.note).toContain('Not found on the trolley')
    await refused('companyB', 'GET', `/production/trolleys/${record.trolley.id}`, undefined, 404)
    await refused('otherTenant', 'GET', `/production/trolleys/${record.trolley.id}`, undefined, 404)
    expect((await ok('companyB', 'GET', '/production/trolleys?view=all')).rows).toEqual([])
    expect(keysOf(record).filter((key) => MONEY.test(key))).toEqual([])
  })
})
