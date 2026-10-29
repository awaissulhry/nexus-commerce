import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { Dec } from '@nexus/factory-domain/tax/decimal'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { systemContext } from '../../../platform/outbox/system'
import { startOnIssueHandler } from './start'

/**
 * Pick and issue to the work order on the floor (B-W1-39; SCM-215, SCM-194, SCM-216; PLAN §4.7 stage 11a-issue; A2
 * SCR-093) on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the
 * runtime login: row-level security, the column grants and the …_supply_guards and …_production_guards triggers are
 * real), the factory-db seeds of two tenants up to production (SEED-JKT-02 with its released revision and BOM of black
 * or red leather by the hide, grey lining by the lot and protectors; plant A1 with its cutting tablet and two workers;
 * SEED-WO-0001 in progress with hide SEED-HIDE-0001 issued to it and 20 ft² of it cut; SEED-WO-0002 a draft), the
 * numbering seed, a made-up certificate, and on top made-up stock at A1: black leather lots RELEASED (twelve hides, and
 * an older lot of one hide at the cutting rack), one waiting for its chromium VI result, red leather, grey lining
 * RELEASED (in two locations) and in quarantine, protectors. Four released work orders of one black jacket each are made
 * through the work-order routes. Sessions come from the test authenticator; the floor ones are A1's (and B1's) seeded
 * tablet and workers. Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs issue`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'pick-issue-a', b: 'pick-issue-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const firstId = (namespace: string, key: string) => `00000000${idOf(namespace, key).slice(8)}`
const A = {
  tenant: idOf(ns.a, 'tenant'),
  actor: idOf(ns.a, 'actor'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  siteB1: idOf(ns.a, 'site:B1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  leatherRED: idOf(ns.a, 'product:item-colour:leather:RED'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  store: idOf(ns.a, 'inventory:location:A1-STORE'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  cut: idOf(ns.a, 'inventory:location:A1-CUT'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  deviceB1: idOf(ns.a, 'device:B1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  leadA1: idOf(ns.a, 'worker:A1:lead'),
  operatorB1: idOf(ns.a, 'worker:B1:operator'),
  seededWorkOrder: idOf(ns.a, 'production:work-order:WO-0001'),
  draftWorkOrder: firstId(ns.a, 'production:work-order:WO-0002'),
  seededHide: idOf(ns.a, 'inventory:hide:H1'),
  seededIssue: idOf(ns.a, 'inventory:move:issue:H1'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const PICK: Permission[] = ['inventory.issue', 'inventory.issue.over', 'inventory.reverse', 'inventory.stock.view']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const floor = (siteId: string, deviceId: string, actorId: string, companyId: string): SessionContext => ({
  audience: 'floor',
  tenantId: A.tenant,
  actorId,
  siteId,
  deviceId,
  grants: [grant(['floor.work', 'inventory.issue', 'inventory.locations.view'], [companyId], [siteId])],
})
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** Issues, over-issues and reverses: the warehouse role. */
  warehouse: office(A.tenant, [grant(PICK)]),
  /** Issues only. */
  issuer: office(A.tenant, [grant(['inventory.issue'])]),
  companyB: office(A.tenant, [grant(PICK, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(PICK)]),
  floor: floor(A.siteA1, A.deviceA1, A.operatorA1, A.companyA),
  /** Another worker on the same tablet. */
  floorLead: floor(A.siteA1, A.deviceA1, A.leadA1, A.companyA),
  floorB1: floor(A.siteB1, A.deviceB1, A.operatorB1, A.companyB),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? freshKey())
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work))

const pickList = (workOrderId: string, session = 'floor') => ok(session, 'GET', `/inventory/picking/work-orders/${workOrderId}`)
const issueTo = (workOrderId: string, body: Json, session = 'floor', key: string | undefined = freshKey()) => call(session, 'POST', `/inventory/picking/work-orders/${workOrderId}/issue`, body, key)
const lineOf = (list: Json, itemId: string, colourId: string | null): Json => (list.lines as Json[]).find((line) => line.itemId === itemId && line.itemColourId === colourId)!
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
/** On hand of a hide (or a lot) at a location, from the ledger. */
async function onHand(locationId: string, where: { hideId?: string; lotId?: string }): Promise<string> {
  const [row] = await admin<{ n: string }>(
    `SELECT coalesce(sum(CASE WHEN "toLocationId" = $1 THEN "baseQuantity" ELSE -"baseQuantity" END), 0)::numeric(18,4)::text AS n
       FROM "StockMove" WHERE ("toLocationId" = $1 OR "fromLocationId" = $1) AND ($2::uuid IS NULL OR "hideId" = $2) AND ($3::uuid IS NULL OR "lotId" = $3)`,
    [locationId, where.hideId ?? null, where.lotId ?? null],
  )
  return row!.n
}
/** Every key of an answer, at any depth. */
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const MONEY = /cost|price|margin|amount|wage|valuation/i

// ---- made-up stock and work orders ----------------------------------------------------------------------------------------

const hides: Record<string, { id: string; code: string }> = {}
const lots: Record<string, { id: string; code: string }> = {}

async function addLot(spec: {
  key: string
  itemId: string
  colourId: string | null
  status: 'RELEASED' | 'QUARANTINE'
  crVi?: 'PASS' | 'PENDING'
  receivedAt: string
  stock: { locationId: string; quantity: string; uom: string; hide?: string }[]
}) {
  const lotId = newId()
  const code = `T-${run}-${spec.key}`
  lots[spec.key] = { id: lotId, code }
  const leather = spec.crVi !== undefined
  const pass = spec.crVi === 'PASS'
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
    [
      lotId,
      A.tenant,
      A.companyA,
      A.siteA1,
      spec.itemId,
      spec.colourId,
      code,
      spec.status,
      spec.status === 'RELEASED' ? new Date() : null,
      leather,
      leather ? '3.000' : null,
      leather ? spec.crVi : 'NOT_REQUIRED',
      leather && pass ? '1.100' : null,
      leather && pass ? 'LOT_REPORT' : null,
      leather && pass ? '2026-10-01' : null,
      new Date(spec.receivedAt),
    ],
  )
  for (const [index, entry] of spec.stock.entries()) {
    const hideId = entry.hide ? newId() : null
    if (hideId) {
      hides[entry.hide!] = { id: hideId, code: `T-${run}-${entry.hide}` }
      await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7)`, [
        hideId,
        A.tenant,
        A.siteA1,
        lotId,
        spec.itemId,
        `T-${run}-${entry.hide}`,
        entry.quantity,
      ])
    }
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $10, $11, $10, $12, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, spec.itemId, spec.colourId, lotId, hideId, entry.locationId, entry.quantity, entry.uom, `pick-test-${code}-${index}`],
    )
  }
}

/** A CONFIRMED sales order of company A for black SEED-JKT-02 in size 50, typed by the office. */
async function salesOrder(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: {
        id: orderId,
        companyId: A.companyA,
        partyId: A.brand,
        number: `T-${run}-SO-1`,
        status: 'CONFIRMED',
        orderDate: new Date('2026-10-20T00:00:00.000Z'),
        taxMode: 'IT_B2B',
        billTo: { legalName: 'Made-up customer' },
        shipTo: { name: 'Made-up workshop' },
        promiseDate: new Date('2026-12-10T00:00:00.000Z'),
        depositRequired: false,
      },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: {
        id: lineId,
        companyId: A.companyA,
        orderId,
        partyId: A.brand,
        seq: 10,
        kind: 'SIZE_GRID',
        styleId: A.style,
        colourwayId: A.blk,
        quantity: pieces,
        unitPrice: '100.000000',
        netAmount: pieces * 10_000,
        vatRatePct: '22.00',
        vatAmount: pieces * 2_200,
        siteId: A.siteA1,
      },
      select: { id: true },
    })
    await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: pieces }, select: { id: true } })
  })
  return lineId
}

/** A released work order of one black jacket in size 50, made and released through the work-order routes. */
async function releasedWorkOrder(lineId: string): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: 1 }] }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, {})
  expect(released.workOrder.status).toBe('RELEASED')
  return released.workOrder
}

const WO: Record<'main' | 'race1' | 'race2' | 'undo', Json> = {} as never

beforeAll(async () => {
  db = await migratedDatabase('pick_issue')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 10 } })
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: database, namespace })
    await seedProduction({ db: database, namespace })
    await seedNumbering({ db: database, namespace })
  }
  await asOffice(async (tx) => {
    const certificateId = newId()
    await tx.certificate.create({
      data: {
        id: certificateId,
        holderPartyId: A.brand,
        standard: 'EN 17092-3:2020',
        ppeClass: 'AA',
        number: `T-${run}-CERT`,
        notifiedBodyName: 'Made-up Notified Body',
        notifiedBodyNumber: '9999',
        modelReference: 'SEED-JKT-02',
        validFrom: new Date('2026-01-01T00:00:00.000Z'),
        validTo: new Date('2030-12-31T00:00:00.000Z'),
        status: 'VALID',
        statusChangedAt: new Date(),
      },
      select: { id: true },
    })
    await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
  })
  const ft2 = (locationId: string, hide: string, quantity = '55.0000') => ({ locationId, quantity, uom: 'FT2', hide })
  await addLot({
    key: 'BLK',
    itemId: A.leather,
    colourId: A.leatherBLK,
    status: 'RELEASED',
    crVi: 'PASS',
    receivedAt: '2026-10-05T08:00:00.000Z',
    stock: Array.from({ length: 12 }, (_, index) => ft2(A.bin, `H${String(index + 1).padStart(2, '0')}`)),
  })
  await addLot({ key: 'OLD', itemId: A.leather, colourId: A.leatherBLK, status: 'RELEASED', crVi: 'PASS', receivedAt: '2026-01-05T08:00:00.000Z', stock: [ft2(A.cut, 'OLD-H1', '50.0000')] })
  await addLot({ key: 'PEND', itemId: A.leather, colourId: A.leatherBLK, status: 'QUARANTINE', crVi: 'PENDING', receivedAt: '2026-10-20T08:00:00.000Z', stock: [ft2(A.bin, 'PEND-H1', '40.0000')] })
  await addLot({ key: 'RED', itemId: A.leather, colourId: A.leatherRED, status: 'RELEASED', crVi: 'PASS', receivedAt: '2026-10-06T08:00:00.000Z', stock: [ft2(A.bin, 'RED-H1', '45.0000')] })
  await addLot({
    key: 'LIN',
    itemId: A.lining,
    colourId: A.liningGRY,
    status: 'RELEASED',
    receivedAt: '2026-10-07T08:00:00.000Z',
    stock: [
      { locationId: A.store, quantity: '0.5000', uom: 'M' },
      { locationId: A.bin, quantity: '50.0000', uom: 'M' },
    ],
  })
  await addLot({ key: 'LIN-Q', itemId: A.lining, colourId: A.liningGRY, status: 'QUARANTINE', receivedAt: '2026-10-08T08:00:00.000Z', stock: [{ locationId: A.bin, quantity: '20.0000', uom: 'M' }] })
  await addLot({ key: 'PRO', itemId: A.protector, colourId: null, status: 'RELEASED', receivedAt: '2026-10-07T08:00:00.000Z', stock: [{ locationId: A.bin, quantity: '200.0000', uom: 'PCS' }] })

  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder(4)
  WO.main = await releasedWorkOrder(line)
  WO.race1 = await releasedWorkOrder(line)
  WO.race2 = await releasedWorkOrder(line)
  WO.undo = await releasedWorkOrder(line)
}, 300_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- the pick list ------------------------------------------------------------------------------------------------------------

describe('the pick list (SCR-093): need, issued, usable oldest first, held with its reason', () => {
  it('lists the released work orders of the floor site, and finds one by its scanned number', async () => {
    const { workOrders } = await ok('floor', 'GET', '/inventory/picking/work-orders')
    const numbers = (workOrders as Json[]).map((row) => row.number)
    expect(numbers).toEqual(expect.arrayContaining([WO.main.number, WO.race1.number, WO.race2.number, WO.undo.number, 'SEED-WO-0001']))
    expect(numbers).not.toContain('SEED-WO-0002')
    expect((workOrders as Json[]).every((row) => ['RELEASED', 'IN_PROGRESS'].includes(row.status) && row.siteId === A.siteA1)).toBe(true)
    const found = await ok('floor', 'GET', `/inventory/picking/work-orders?number=${WO.main.number}`)
    expect(found.workOrders).toEqual([expect.objectContaining({ id: WO.main.id, number: WO.main.number, status: 'RELEASED', pieces: 1, colourways: ['BLK'], style: expect.objectContaining({ code: 'SEED-JKT-02' }) })])
  })

  it('gives each material and colour its need, the usable stock oldest first and the held stock with its reason', async () => {
    const list = await pickList(WO.main.id)
    expect(list.workOrder).toMatchObject({ id: WO.main.id, status: 'RELEASED', issuable: true })
    const leather = lineOf(list, A.leather, A.leatherBLK)
    expect(leather).toMatchObject({ tracking: 'HIDE', baseUom: 'FT2', issued: '0.0000', covered: false })
    expect(leather.toIssue).toBe(leather.planned)
    expect(new Dec(leather.planned).gt(40)).toBe(true)
    expect(leather.rows).toEqual([expect.objectContaining({ colourwayCode: 'BLK', size: '50', planned: leather.planned, issued: '0.0000' })])
    // The oldest lot first (received in January, at the cutting rack), then the others by receipt.
    expect(leather.usable.candidates[0]).toMatchObject({ lotCode: lots.OLD!.code, hideCode: hides['OLD-H1']!.code, locationCode: 'A1-CUT', onHand: '50.0000' })
    expect((leather.usable.candidates as Json[]).some((candidate) => candidate.hideCode === hides.H01!.code)).toBe(true)
    expect(leather.held).toEqual([{ reason: 'CR_VI_PENDING', words: 'no chromium VI test result yet', lotId: lots.PEND!.id, lotCode: lots.PEND!.code, onHand: '40.0000', hides: 1 }])
    // Red leather is not this work order's colour: it is neither offered nor held here.
    expect(keysOf(leather).length).toBeGreaterThan(0)
    expect(JSON.stringify(leather)).not.toContain(hides['RED-H1']!.code)
    const lining = lineOf(list, A.lining, A.liningGRY)
    expect(lining.held).toEqual([expect.objectContaining({ reason: 'QUALITY_HOLD', lotCode: lots['LIN-Q']!.code, onHand: '20.0000', hides: 0 })])
    expect(list.undo).toBeNull()
    // The floor never sees money.
    expect(keysOf(list).filter((key) => MONEY.test(key))).toEqual([])
  })
})

// ---- issue ----------------------------------------------------------------------------------------------------------------------

describe('issue (SCM-215): a scanned released hide leaves stock against the work order', () => {
  it('issues the hide whole: stock down, the work order issued up, audited, announced, and the worker starts the work order', async () => {
    const key = freshKey()
    const response = await issueTo(WO.main.id, { code: hides.H01!.code, occurredAt: '2026-11-20T09:12:00.000Z' }, 'floor', key)
    expect(response.statusCode, response.body).toBe(201)
    const { issue, line } = response.json()
    expect(issue).toMatchObject({ workOrderId: WO.main.id, number: WO.main.number, itemId: A.leather, itemColourId: A.leatherBLK, lotId: lots.BLK!.id, hideId: hides.H01!.id, baseQuantity: '55.0000', overIssue: false, startsWorkOrder: true })
    expect(issue.moves).toEqual([
      expect.objectContaining({ id: issue.id, reason: 'ISSUE', fromLocationId: A.bin, toLocationId: null, quantity: '55.0000', uom: 'FT2', workOrderId: WO.main.id, reference: WO.main.number, idempotencyKey: `inventory.issue:${key}:1`, occurredAt: '2026-11-20T09:12:00.000Z', valued: false }),
    ])
    expect(line.issued).toBe('55.0000')
    expect(keysOf(response.json()).filter((name) => MONEY.test(name))).toEqual([])
    expect(await onHand(A.bin, { hideId: hides.H01!.id })).toBe('0.0000')

    const list = await pickList(WO.main.id)
    const leather = lineOf(list, A.leather, A.leatherBLK)
    expect(leather).toMatchObject({ issued: '55.0000', toIssue: '0.0000', covered: true })
    expect(leather.atWorkOrder).toEqual([expect.objectContaining({ hideId: hides.H01!.id, quantity: '55.0000', cut: '0.0000', returnable: '55.0000' })])
    expect(list.undo).toMatchObject({ issueId: issue.id, hideId: hides.H01!.id, baseQuantity: '55.0000' })

    const audits = await admin(`SELECT action, audience, "deviceId", "deviceTime" FROM "AuditLog" WHERE "recordType" = 'WorkOrder' AND "recordId" = $1 AND action = 'inventory.issue'`, [WO.main.id])
    expect(audits).toEqual([expect.objectContaining({ action: 'inventory.issue', audience: 'FLOOR', deviceId: A.deviceA1 })])
    const [event] = await admin(`SELECT * FROM "OutboxEvent" WHERE type = 'inventory.issued' AND subject = $1`, [WO.main.id])
    expect(event!.payload).toMatchObject({ issueId: issue.id, startsWorkOrder: true, postedBy: 'FLOOR', overIssue: false })

    // The worker's handler, as the system: RELEASED → IN_PROGRESS with its start time, once.
    const envelope = {
      eventId: event!.id,
      type: event!.type,
      version: event!.version,
      context: event!.context,
      tenantId: event!.tenantId,
      companyId: event!.companyId,
      siteId: event!.siteId,
      subject: event!.subject,
      correlationId: event!.correlationId,
      causationId: event!.causationId,
      source: event!.source,
      occurredAt: toUtcIso(event!.occurredAt),
      payload: event!.payload,
    } as EventEnvelope
    const handler = startOnIssueHandler()
    const system = callerFor(database, systemContext(A.tenant, newId()))
    await handler.handle(envelope, { caller: system, attempt: 1 })
    await handler.handle(envelope, { caller: system, attempt: 2 })
    const [started] = await admin(`SELECT status, "startedAt" FROM "WorkOrder" WHERE id = $1`, [WO.main.id])
    expect(started!.status).toBe('IN_PROGRESS')
    expect(started!.startedAt).not.toBeNull()
    expect(await admin(`SELECT payload->>'to' AS "to" FROM "OutboxEvent" WHERE type = 'workorder.status_changed' AND subject = $1`, [WO.main.id])).toEqual([{ to: 'IN_PROGRESS' }])
    expect(await admin(`SELECT audience, reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'workorders.start'`, [WO.main.id])).toEqual([
      { audience: 'SYSTEM', reason: `Started by its first work: the issue ${issue.id}.` },
    ])
  })

  it('answers a replayed Idempotency-Key with the same move, and refuses the key for another request', async () => {
    const key = freshKey()
    const first = await issueTo(WO.race1.id, { lotId: lots.PRO!.id, quantity: '1' }, 'floor', key)
    expect(first.statusCode, first.body).toBe(201)
    const again = await issueTo(WO.race1.id, { lotId: lots.PRO!.id, quantity: '1' }, 'floor', key)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json().issue.id).toBe(first.json().issue.id)
    expect(await admin(`SELECT count(*)::int AS n FROM "StockMove" WHERE "idempotencyKey" LIKE $1`, [`inventory.issue:${key}:%`])).toEqual([{ n: 1 }])
    const other = await issueTo(WO.race1.id, { lotId: lots.PRO!.id, quantity: '2' }, 'floor', key)
    expect(other.statusCode).toBe(409)
    // Protectors are tracked by lot: the material alone is not enough.
    expect((await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { itemId: A.protector, quantity: '1' }, 400)).message).toMatch(/tracked by LOT/)
  })

  it('refuses held stock, another colour and a work order that is not released, each with its reason, and writes nothing', async () => {
    const before = await admin(`SELECT count(*)::int AS n FROM "StockMove"`)
    expect(refusalOf(await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { hideId: hides['PEND-H1']!.id }, 409))).toBe('refusal/CR_VI_PENDING')
    const red = await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { code: hides['RED-H1']!.code }, 409)
    expect(refusalOf(red)).toBe('refusal/OTHER_COLOUR')
    expect(refusalOf(await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { lotId: lots['LIN-Q']!.id }, 409))).toBe('refusal/QUALITY_HOLD')
    expect(refusalOf(await refused('floor', 'POST', `/inventory/picking/work-orders/${A.draftWorkOrder}/issue`, { code: hides.H12!.code }, 409))).toBe('refusal/WORK_ORDER_NOT_OPEN')
    // A lot of hides is issued hide by hide.
    expect((await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { lotId: lots.BLK!.id }, 400)).message).toMatch(/hide by hide/)
    // A hide is issued whole.
    expect((await refused('floor', 'POST', `/inventory/picking/work-orders/${WO.race1.id}/issue`, { hideId: hides.H12!.id, quantity: '10' }, 400)).issues[0].path).toBe('body/quantity')
    expect(await admin(`SELECT count(*)::int AS n FROM "StockMove"`)).toEqual(before)
  })

  it('issues a lot by default what the work order still needs, location by location', async () => {
    const before = lineOf(await pickList(WO.race1.id), A.lining, A.liningGRY)
    expect(new Dec(before.toIssue).gt('0.5')).toBe(true)
    const response = await issueTo(WO.race1.id, { lotId: lots.LIN!.id })
    expect(response.statusCode, response.body).toBe(201)
    const { issue, line } = response.json()
    expect(issue.baseQuantity).toBe(before.toIssue)
    // A1-STORE (0.5 m) first, by location code, then A1-STORE-01.
    expect((issue.moves as Json[]).map((move) => [move.fromLocationId, move.quantity])).toEqual([
      [A.store, '0.5000'],
      [A.bin, new Dec(before.toIssue).minus('0.5').toFixed(4)],
    ])
    expect(line).toMatchObject({ issued: before.toIssue, toIssue: '0.0000' })
  })

  it('refuses an over-issue without a reason, and from anyone but the office with inventory.issue.over', async () => {
    const url = `/inventory/picking/work-orders/${WO.race1.id}/issue`
    const more = { lotId: lots.LIN!.id, quantity: '2' }
    expect(refusalOf(await refused('floor', 'POST', url, more, 409))).toBe('refusal/OVER_ISSUE')
    expect(refusalOf(await refused('issuer', 'POST', url, more, 409))).toBe('refusal/OVER_ISSUE')
    await refused('issuer', 'POST', url, { ...more, overIssueReason: 'Recut of two sleeves' }, 403)
    await refused('floor', 'POST', url, { ...more, overIssueReason: 'Recut of two sleeves' }, 403)
    const response = await issueTo(WO.race1.id, { ...more, overIssueReason: 'Recut of two sleeves' }, 'warehouse')
    expect(response.statusCode, response.body).toBe(201)
    const { issue } = response.json()
    expect(issue).toMatchObject({ overIssue: true, baseQuantity: '2.0000' })
    expect(issue.moves[0].note).toBe('Over-issue: Recut of two sleeves')
    expect(await admin(`SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = 'inventory.issue' AND reason IS NOT NULL`, [WO.race1.id])).toEqual([{ reason: 'Recut of two sleeves' }])
    expect(lineOf(await pickList(WO.race1.id, 'warehouse'), A.lining, A.liningGRY).over).toBe('2.0000')
  })

  it('issues a hide scanned at once on two tablets once: one wins, the other is told who has it, and nobody waits forever (SCM-194)', async () => {
    const hide = hides.H02!
    const answers = await Promise.all([issueTo(WO.race1.id, { hideId: hide.id }, 'floor'), issueTo(WO.race2.id, { hideId: hide.id }, 'warehouse')])
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409])
    const won = answers.find((answer) => answer.statusCode === 201)!.json().issue
    const lost = answers.find((answer) => answer.statusCode === 409)!.json().error
    expect(refusalOf(lost)).toBe('refusal/ALREADY_ISSUED')
    expect(lost.message).toContain(`already issued to work order ${won.number}`)
    expect(await admin(`SELECT count(*)::int AS n FROM "StockMove" WHERE "hideId" = $1 AND reason = 'ISSUE'`, [hide.id])).toEqual([{ n: 1 }])
    // Two issues of one lot's stock at once to two work orders: they take turns on its stock lock, and both go through.
    const both = await Promise.all([issueTo(WO.race1.id, { lotId: lots.PRO!.id, quantity: '1' }, 'floor'), issueTo(WO.race2.id, { lotId: lots.PRO!.id, quantity: '1' }, 'warehouse')])
    expect(both.map((answer) => answer.statusCode)).toEqual([201, 201])
  })
})

// ---- return ---------------------------------------------------------------------------------------------------------------------

describe('return (SCM-216): the unused part comes back with its measured quantity', () => {
  const url = `/inventory/picking/work-orders/`

  it('refuses more than the work order holds less what was cut, takes the remnant back and marks the hide REMNANT', async () => {
    // SEED-HIDE-0001: 53.2 ft² issued to SEED-WO-0001, 20 ft² of it cut.
    const over = await refused('floor', 'POST', `${url}${A.seededWorkOrder}/return`, { hideId: A.seededHide, quantity: '40', toLocationId: A.cut }, 409)
    expect(refusalOf(over)).toBe('refusal/MORE_THAN_AT_WORK_ORDER')
    expect(over.message).toContain('at most 33.2000 comes back')
    const response = await call('floor', 'POST', `${url}${A.seededWorkOrder}/return`, { hideId: A.seededHide, quantity: '30', toLocationId: A.cut, note: 'Offcut of the back panel' }, freshKey())
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().return).toMatchObject({ hideState: 'REMNANT', move: expect.objectContaining({ reason: 'RETURN', toLocationId: A.cut, fromLocationId: null, baseQuantity: '30.0000', workOrderId: A.seededWorkOrder }) })
    expect(await admin(`SELECT state FROM "Hide" WHERE id = $1`, [A.seededHide])).toEqual([{ state: 'REMNANT' }])
    expect(await onHand(A.cut, { hideId: A.seededHide })).toBe('30.0000')
    const holding = (lineOf(await pickList(A.seededWorkOrder), A.leather, A.leatherBLK).atWorkOrder as Json[]).find((row) => row.hideId === A.seededHide)
    expect(holding).toMatchObject({ quantity: '23.2000', cut: '20.0000', returnable: '3.2000' })
  })

  it('issues the remnant again, with what it measured: an over-issue once the work order is covered', async () => {
    const refusal = await refused('floor', 'POST', `${url}${WO.main.id}/issue`, { hideId: A.seededHide }, 409)
    expect(refusalOf(refusal)).toBe('refusal/OVER_ISSUE')
    const response = await issueTo(WO.main.id, { hideId: A.seededHide, overIssueReason: 'Small parts from a remnant' }, 'warehouse')
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().issue).toMatchObject({ baseQuantity: '30.0000', overIssue: true, startsWorkOrder: false })
    expect(await onHand(A.cut, { hideId: A.seededHide })).toBe('0.0000')
  })

  it('takes back part of a lot, and refuses stock the work order never had', async () => {
    const response = await call('floor', 'POST', `${url}${WO.race1.id}/return`, { lotId: lots.LIN!.id, quantity: '100', uom: 'CM', toLocationId: A.bin }, freshKey())
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().return).toMatchObject({ hideState: null, move: expect.objectContaining({ quantity: '100.0000', uom: 'CM', baseQuantity: '1.0000' }) })
    // A wrong return: the office reverses it (the lining goes back to the work order), with the reason.
    const returned = response.json().return.move
    const reversed = await ok('warehouse', 'POST', `/inventory/picking/moves/${returned.id}/reverse`, { note: 'Counted twice: nothing came back' }, 201)
    expect(reversed.reversal).toMatchObject({ reversedId: returned.id, of: 'RETURN', baseQuantity: '1.0000' })
    expect(reversed.reversal.moves).toEqual([expect.objectContaining({ reason: 'RETURN', reversalOfId: returned.id, fromLocationId: A.bin, toLocationId: null, uom: 'CM' })])
    await refused('warehouse', 'POST', `/inventory/picking/moves/${returned.id}/reverse`, { note: 'Again' }, 409)
    expect(refusalOf(await refused('floor', 'POST', `${url}${WO.race1.id}/return`, { hideId: hides.H12!.id, quantity: '1', toLocationId: A.bin }, 409))).toBe('refusal/NOTHING_AT_WORK_ORDER')
  })
})

// ---- undo and reversal ----------------------------------------------------------------------------------------------------------

describe('undo (until the next action) and the office reversal: one mirror move each', () => {
  it('undoes the last issue: stock back, the issue reversed once', async () => {
    const { issue } = (await issueTo(WO.undo.id, { hideId: hides.H03!.id })).json()
    const response = await call('floor', 'POST', `/inventory/picking/issues/${issue.id}/undo`, undefined, freshKey())
    expect(response.statusCode, response.body).toBe(201)
    const { reversal } = response.json()
    expect(reversal).toMatchObject({ reversedId: issue.id, of: 'ISSUE', workOrderId: WO.undo.id, baseQuantity: '55.0000' })
    expect(reversal.moves).toEqual([expect.objectContaining({ reason: 'ISSUE', reversalOfId: issue.id, fromLocationId: null, toLocationId: A.bin, workOrderId: WO.undo.id })])
    expect(await onHand(A.bin, { hideId: hides.H03!.id })).toBe('55.0000')
    expect(refusalOf(await refused('floor', 'POST', `/inventory/picking/issues/${issue.id}/undo`, undefined, 409))).toBe('refusal/REVERSED_ALREADY')
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'inventory.pick_reversed' AND payload->>'reversedId' = $1`, [issue.id])
    expect(event!.payload).toMatchObject({ undo: true, of: 'ISSUE', postedBy: 'FLOOR' })
    expect(lineOf(await pickList(WO.undo.id), A.leather, A.leatherBLK).issued).toBe('0.0000')
  })

  it('undoes nothing older than the last action, and nothing of another worker', async () => {
    const hide = (await issueTo(WO.undo.id, { hideId: hides.H04!.id })).json().issue
    const lining = (await issueTo(WO.undo.id, { lotId: lots.LIN!.id, quantity: '0.5' })).json().issue
    expect(refusalOf(await refused('floor', 'POST', `/inventory/picking/issues/${hide.id}/undo`, undefined, 409))).toBe('refusal/NOT_LAST_ACTION')
    expect(refusalOf(await refused('floorLead', 'POST', `/inventory/picking/issues/${lining.id}/undo`, undefined, 409))).toBe('refusal/NOT_LAST_ACTION')
    expect((await pickList(WO.undo.id, 'floorLead')).undo).toBeNull()
    expect((await pickList(WO.undo.id)).undo).toMatchObject({ issueId: lining.id })
    expect((await call('floor', 'POST', `/inventory/picking/issues/${lining.id}/undo`, undefined, freshKey())).statusCode).toBe(201)

    // An older issue: the office reverses it, with the reason.
    await refused('floor', 'POST', `/inventory/picking/moves/${hide.id}/reverse`, { note: 'Wrong hide' }, 403)
    await refused('issuer', 'POST', `/inventory/picking/moves/${hide.id}/reverse`, { note: 'Wrong hide' }, 403)
    const reversed = await ok('warehouse', 'POST', `/inventory/picking/moves/${hide.id}/reverse`, { note: 'Wrong hide: a second-grade one was meant' }, 201)
    expect(reversed.reversal).toMatchObject({ reversedId: hide.id, of: 'ISSUE', baseQuantity: '55.0000' })
    expect(reversed.reversal.moves[0].note).toBe('Wrong hide: a second-grade one was meant')
    expect(await onHand(A.bin, { hideId: hides.H04!.id })).toBe('55.0000')
  })

  it('never takes back the area of a hide that was cut, here or through the ledger', async () => {
    const error = await refused('warehouse', 'POST', `/inventory/picking/moves/${A.seededIssue}/reverse`, { note: 'Try to undo the old issue' }, 409)
    expect(refusalOf(error)).toBe('refusal/ALREADY_CUT')
    // The ledger's own reversal route sends issues and returns to the pick list.
    const ledger = await refused('warehouse', 'POST', `/inventory/moves/${A.seededIssue}/reverse`, { note: 'Try to undo the old issue' }, 409)
    expect(ledger.code).toBe('invalid_state')
    expect(ledger.message).toContain(`/inventory/picking/moves/${A.seededIssue}/reverse`)
  })
})

// ---- the walls ------------------------------------------------------------------------------------------------------------------

describe('the walls: the floor at its own site, companies and tenants', () => {
  it('a floor device of another site finds no work order of this one', async () => {
    await refused('floorB1', 'GET', `/inventory/picking/work-orders/${WO.main.id}`, undefined, 404)
    await refused('floorB1', 'POST', `/inventory/picking/work-orders/${WO.main.id}/issue`, { hideId: hides.H05!.id }, 404)
    expect((await ok('floorB1', 'GET', '/inventory/picking/work-orders')).workOrders.map((row: Json) => row.siteId)).not.toContain(A.siteA1)
  })

  it('another company and another tenant do not see it either', async () => {
    await refused('companyB', 'GET', `/inventory/picking/work-orders/${WO.main.id}`, undefined, 404)
    await refused('companyB', 'POST', `/inventory/picking/work-orders/${WO.main.id}/issue`, { hideId: hides.H05!.id }, 404)
    expect((await ok('companyB', 'GET', '/inventory/picking/work-orders')).workOrders).toEqual([])
    await refused('otherTenant', 'GET', `/inventory/picking/work-orders/${WO.main.id}`, undefined, 404)
    await refused('otherTenant', 'POST', `/inventory/picking/moves/${A.seededIssue}/reverse`, { note: 'Not ours' }, 404)
    expect(await onHand(A.bin, { hideId: hides.H05!.id })).toBe('55.0000')
  })

  it('a floor write needs an Idempotency-Key', async () => {
    const response = await call('floor', 'POST', `/inventory/picking/work-orders/${WO.main.id}/issue`, { hideId: hides.H05!.id })
    expect(response.statusCode).toBe(400)
  })
})
