import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase, type Prisma } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayStart } from '@nexus/factory-domain/core/time'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { parseScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import type { Log } from '../../../core/queue'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { runScanFindings } from './findings'
import { runStuckBundles } from './jobs'

/**
 * Bundles tracked (B-W2b-41; MES-067, MES-074, MES-075, MES-078, MES-168) on the local stack, through the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column
 * grants and the …_floor_work_w2b_guards BundleCoupon and ScanPatternFinding triggers are real), the factory-db seeds of
 * two tenants up to production (plant A1 names workers on a made-up union agreement, its operator acknowledged the
 * notice; plant B1 records stations), the numbering seed, a made-up certificate, two made-up lots of large black hides
 * at A1 (shade A and shade B), a made-up label printer (FAKE relay). Released work orders of black jackets are made,
 * cut and bundled through their routes; reports go through the scans route. Statuto dei Lavoratori art. 4: the
 * findings are about bundles; names come only inside ONE finding, behind the site's PERFORMANCE purpose (a made-up gate
 * row switched on and off here), with a purpose, written in the audit log. Every name and number is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/bundles`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = { a: 'tracked-a', b: 'tracked-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
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
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  station: idOf(ns.a, 'site:A1:station:CUT-01'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  notice: idOf(ns.a, 'privacy:notice:A:WORKER_FLOOR:1'),
  dpia: idOf(ns.a, 'privacy:dpia:A:1'),
  printer: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TAG = tenantTag(A.tenant)

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'inventory.issue', 'print.view', 'print.labels']
const TRACK: Permission[] = ['production.bundles.view', 'production.bundles', 'workorders.view', 'print.view', 'print.labels']
const SESSIONS: Record<string, SessionContext> = {
  settings: office(A.tenant, [grant(['production.settings.view', 'production.settings.manage'])]),
  settingsViewer: office(A.tenant, [grant(['production.settings.view'])]),
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  /** The production manager: where every bundle is, reviews findings; never the names. */
  manager: office(A.tenant, [grant([...TRACK, 'production.bundles.findings'])]),
  /** Made up for the test: a custom role the owner gave "Show who". */
  who: office(A.tenant, [grant(['production.bundles.view', 'production.bundles.who'])]),
  companyB: office(A.tenant, [grant([...TRACK, 'production.bundles.findings', 'production.bundles.who'], [A.companyB])]),
  otherTenant: office(B.tenant, [grant(TRACK)]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(FLOOR, [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
let events = 0
const clientEvent = () => `ce-${run}-${++events}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key ?? (method === 'POST' ? freshKey() : undefined))
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const asOffice = <T>(work: (tx: Prisma.TransactionClient) => Promise<T>) => database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) => client.$transaction(work, { timeout: 30_000 }))
const pathOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const PERSON = /worker|employee|user|operator|actor|createdBy|reviewedBy/i
const outbox = async (type: string) => admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id`, [type])
const silent: Log = { info: () => {}, warn: () => {}, error: () => {} }
const refOf = (code: string) => {
  const scan = parseScanId(code, { tenantTag: TAG, types: ['BUNDLE'] })
  if (!scan.ok) throw new Error(`${code}: ${scan.message}`)
  return scan.ref
}

// ---- made-up stock, work orders, cuts and bundles -------------------------------------------------------------------------------

const hides: Record<string, string> = {}

/** A lot of big black hides of one shade at A1 (1,000 ft² each: one hide cuts a whole work order). */
async function addLot(shade: string, keys: string[], area = '1000.0000') {
  const lotId = newId()
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", shade, "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-LOT-${shade}-${keys[0]}`, `77${shade}`, shade],
  )
  for (const key of keys) {
    const hideId = newId()
    hides[key] = `T-${run}-${key}`
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, $7, 'FT2', $7, 'A', '1.10')`, [hideId, A.tenant, A.siteA1, lotId, A.leather, hides[key], area])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, $11, 'FT2', $11, $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `tracked-test-${run}-${key}`, area],
    )
  }
}

/** A CONFIRMED sales order line of company A for black SEED-JKT-02. */
async function salesOrder(sizes: Record<string, number>): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  const pieces = Object.values(sizes).reduce((sum, value) => sum + value, 0)
  await asOffice(async (tx) => {
    await tx.salesOrder.create({
      data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
      select: { id: true },
    })
    await tx.salesOrderLine.create({
      data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
      select: { id: true },
    })
    for (const [size, quantity] of Object.entries(sizes)) await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size, quantity }, select: { id: true } })
  })
  return lineId
}

async function releasedWorkOrder(lineId: string, sizes: Record<string, number>): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
  return (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })).workOrder
}

async function cut(workOrder: Json, hideKey: string, sets?: number): Promise<Json> {
  const response = await call('floor', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: clientEvent(), code: hides[hideKey], lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: sets ?? cell.quantity })) }, freshKey())
  expect(response.statusCode, response.body).toBe(201)
  return response.json().cut
}

async function makeBundles(workOrder: Json, body: Json): Promise<Json[]> {
  return (await ok('floor', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { printerId: null, ...body }, 201, freshKey())).bundles
}

const report = (body: Json) => call('floor', 'POST', '/production/scans', { clientScanId: `cs-${run}-${++keys}`, ...body })

type Orders = 'track' | 'coupon' | 'mixed' | 'other'
const WO = {} as Record<Orders, Json>
const BUNDLES = {} as Record<Orders, Json[]>
let operations: Json[] = []

beforeAll(async () => {
  db = await migratedDatabase('bundles_tracked')
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
  await addLot('A', ['A1', 'A2', 'A4'])
  // Two smaller hides of two shades for one work order (one hide alone does not cover it: no over-issue).
  await addLot('A', ['A3'], '300.0000')
  await addLot('B', ['B1'], '300.0000')
  await admin(`INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-CP', 'Made-up coupon printer', 'LABEL_ZPL', 'FAKE', 'test-coupon-printer:9100', 203, 100, 50)`, [
    A.printer,
    A.tenant,
    A.companyA,
    A.siteA1,
  ])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrder({ '50': 48, '52': 6 })
  WO.track = await releasedWorkOrder(line, { '50': 12 })
  await cut(WO.track, 'A1')
  BUNDLES.track = await makeBundles(WO.track, { bundleSize: 5 })
  WO.coupon = await releasedWorkOrder(line, { '50': 12 })
  await cut(WO.coupon, 'A2')
  BUNDLES.coupon = await makeBundles(WO.coupon, { bundleSize: 6 })
  // Half from shade A, bundled; then half from shade B: the second bundle names both cuts (W1's genealogy rule).
  WO.mixed = await releasedWorkOrder(line, { '50': 12 })
  await cut(WO.mixed, 'A3', 6)
  const first = await makeBundles(WO.mixed, {})
  await cut(WO.mixed, 'B1', 6)
  BUNDLES.mixed = [...first, ...(await makeBundles(WO.mixed, {}))]
  WO.other = await releasedWorkOrder(line, { '52': 6 })
  await cut(WO.other, 'A4')
  BUNDLES.other = await makeBundles(WO.other, {})
  operations = (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.coupon.id}`)).operations
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

const opAt = (seq: number) => operations.find((operation) => operation.seq === seq)!

// ---- one bundle code or a coupon per operation (MES-067) ---------------------------------------------------------------------

describe('one bundle code or a coupon per operation (MES-067)', () => {
  let coupons: Json[] = []

  it('prints no coupons while the site scans one code; the settings switch it with a version and an event', async () => {
    const refusal = await refused('floor', 'POST', `/production/bundles/work-orders/${WO.coupon.id}/coupons`, { printerId: null }, 409)
    expect(pathOf(refusal)).toBe('refusal/COUPONS_OFF')
    const rules = await ok('settingsViewer', 'GET', `/production/bundles/sites/${A.siteA1}/rules`)
    expect(rules).toMatchObject({ bundleCodeMode: 'ONE_CODE', stuckBundleHours: 4 })
    await refused('settingsViewer', 'POST', `/production/bundles/sites/${A.siteA1}/rules`, { bundleCodeMode: 'COUPON_PER_OPERATION' }, 403)
    expect(pathOf(await refused('settings', 'POST', `/production/bundles/sites/${A.siteA1}/rules`, { stuckBundleHours: 0 }, 400))).toContain('stuckBundleHours')
    const changed = await ok('settings', 'POST', `/production/bundles/sites/${A.siteA1}/rules`, { bundleCodeMode: 'COUPON_PER_OPERATION', version: rules.version ?? undefined }, 200, freshKey())
    expect(changed).toMatchObject({ bundleCodeMode: 'COUPON_PER_OPERATION', stuckBundleHours: 4, changed: true })
    // The same values again change nothing; a stale version is refused.
    expect((await ok('settings', 'POST', `/production/bundles/sites/${A.siteA1}/rules`, { bundleCodeMode: 'COUPON_PER_OPERATION' }, 200, freshKey())).changed).toBe(false)
    await refused('settings', 'POST', `/production/bundles/sites/${A.siteA1}/rules`, { stuckBundleHours: 6, version: changed.version - 1 }, 409)
    expect((await outbox('production.bundle_rules_changed')).map((row) => row.payload)).toEqual([{ siteId: A.siteA1, bundleCodeMode: 'COUPON_PER_OPERATION', stuckBundleHours: 4 }])
    expect((await ok('floor', 'GET', `/production/bundles/work-orders/${WO.coupon.id}`)).bundleCodeMode).toBe('COUPON_PER_OPERATION')
  })

  it('prints one coupon per scanned operation of every ACTIVE bundle, with consecutive codes; a resend answers the same', async () => {
    const key = freshKey()
    const issued = await ok('floor', 'POST', `/production/bundles/work-orders/${WO.coupon.id}/coupons`, { printerId: A.printer }, 201, key)
    coupons = issued.coupons
    // Two bundles of six × four scanned operations.
    expect(coupons).toHaveLength(8)
    expect(new Set(coupons.map((coupon) => coupon.bundleId))).toEqual(new Set(BUNDLES.coupon.map((bundle) => bundle.id)))
    expect(coupons.filter((coupon) => coupon.bundleId === BUNDLES.coupon[0]!.id).map((coupon) => coupon.operation.seq)).toEqual([10, 20, 30, 40])
    const refs = coupons.map((coupon) => refOf(coupon.code)).sort((a, b) => a - b)
    expect(refs.at(-1)! - refs[0]!).toBe(7)
    expect(issued.printed.every((row: Json) => row.job?.status === 'QUEUED' && row.label.kind === 'BUNDLE')).toBe(true)
    expect(issued.printed[0].coupon).toMatchObject({ bundleCode: expect.stringMatching(/^BN-/), operation: { seq: expect.any(Number) } })
    const again = await ok('floor', 'POST', `/production/bundles/work-orders/${WO.coupon.id}/coupons`, { printerId: A.printer }, 200, key)
    expect(again.replayed).toBe(true)
    expect(again.coupons.map((coupon: Json) => coupon.id)).toEqual(coupons.map((coupon) => coupon.id))
    expect(await admin(`SELECT count(*)::int AS n FROM "PrintJob" WHERE "recordType" = 'BundleCoupon'`)).toEqual([{ n: 8 }])
    expect(pathOf(await refused('floor', 'POST', `/production/bundles/work-orders/${WO.coupon.id}/coupons`, { printerId: null }, 409))).toBe('refusal/NOTHING_TO_COUPON')
    expect((await outbox('production.bundle_coupons_changed')).filter((row) => row.payload.change === 'ISSUED')).toHaveLength(2)
  })

  it('a scanned coupon reports its own operation; a coupon of another operation is refused; the card names it', async () => {
    const bundle = BUNDLES.coupon[0]!
    const own = (seq: number) => coupons.find((coupon) => coupon.bundleId === bundle.id && coupon.operation.seq === seq)!
    const card = await ok('floor', 'GET', `/production/bundles/scan?code=${own(20).code}`)
    expect(card).toMatchObject({ bundle: { id: bundle.id }, refusal: null, coupon: { code: own(20).code, status: 'ACTIVE', operation: { seq: 20 } } })
    const first = await report({ code: own(10).code, good: 6 })
    expect(first.statusCode, first.body).toBe(201)
    expect(first.json().scan).toMatchObject({ bundleId: bundle.id, operation: { seq: 10 } })
    // Named op 20 with op 30's coupon: refused in words.
    const wrong = await report({ code: own(30).code, good: 6, workOrderOperationId: opAt(20).id })
    expect(wrong.statusCode, wrong.body).toBe(409)
    expect(pathOf(wrong.json().error)).toBe('refusal/NOT_AN_OPERATION')
    expect(wrong.json().error.message).toContain('is for operation 30')
    // At the cutting station op 20's coupon still reports op 20 (with the reason the station is of another kind).
    const sewn = await report({ code: own(20).code, good: 6, kindReason: 'The sewing tablet is out of order' })
    expect(sewn.statusCode, sewn.body).toBe(201)
    expect(sewn.json().scan.operation.seq).toBe(20)
  })

  it('a reprinted coupon replaces the old one (refused with the new code); a voided one takes no scan', async () => {
    const bundle = BUNDLES.coupon[0]!
    const lost = coupons.find((coupon) => coupon.bundleId === bundle.id && coupon.operation.seq === 30)!
    const reprinted = await ok('floor', 'POST', `/production/bundles/coupons/${lost.id}/reprint`, { reason: 'Torn at the press', printerId: null }, 201, freshKey())
    expect(reprinted).toMatchObject({ coupon: { id: lost.id, status: 'VOID', voidReason: 'Torn at the press' }, replacement: { replacesId: lost.id, status: 'ACTIVE', operation: { seq: 30 } }, printed: { job: null } })
    const old = await report({ code: lost.code, good: 6 })
    expect(old.statusCode, old.body).toBe(409)
    expect(old.json().error).toMatchObject({ message: `Coupon ${lost.code} was replaced by ${reprinted.replacement.code}: use the new coupon.` })
    expect((await ok('manager', 'GET', `/production/bundles/scan?code=${lost.code}`)).refusal).toMatchObject({ code: 'REPLACED' })
    expect(pathOf(await refused('floor', 'POST', `/production/bundles/coupons/${lost.id}/void`, { reason: 'Again' }, 409))).toBe('refusal/COUPON_VOIDED')
    const pack = coupons.find((coupon) => coupon.bundleId === bundle.id && coupon.operation.seq === 40)!
    expect((await ok('manager', 'POST', `/production/bundles/coupons/${pack.id}/void`, { reason: 'Printed twice by mistake' }, 201, freshKey())).coupon.status).toBe('VOID')
    const voided = await report({ code: pack.code, good: 6 })
    expect(voided.statusCode, voided.body).toBe(409)
    expect(pathOf(voided.json().error)).toBe('refusal/VOIDED')
  })

  it('a voided bundle takes its ACTIVE coupons with it', async () => {
    const bundle = BUNDLES.coupon[1]!
    await ok('floor', 'POST', `/production/bundles/${bundle.id}/void`, { reason: 'Made from the wrong cut' }, 201, freshKey())
    const rows = await admin<{ status: string; voidReason: string }>(`SELECT status, "voidReason" FROM "BundleCoupon" WHERE "bundleId" = $1`, [bundle.id])
    expect(rows).toHaveLength(4)
    expect(rows.every((row) => row.status === 'VOID' && row.voidReason === `Bundle ${bundle.code} voided: Made from the wrong cut`)).toBe(true)
    expect((await outbox('production.bundle_coupons_changed')).some((row) => row.payload.bundleId === bundle.id && row.payload.change === 'VOIDED' && row.payload.couponIds.length === 4)).toBe(true)
  })
})

// ---- where is this bundle and stuck bundles (MES-074, MES-168) -------------------------------------------------------------------

describe('where every bundle is, and the stuck ones (MES-074, MES-168)', () => {
  it('lists every bundle with its place now, last scan and genealogy; filters by place; never a person or money', async () => {
    const list = await ok('manager', 'GET', `/production/bundles?workOrderId=${WO.track.id}`)
    expect(list.bundles).toHaveLength(3)
    expect(list.bundles.every((row: Json) => row.place === 'CUTTING' && row.next.seq === 10 && row.lastScan === null && row.hides.length === 1)).toBe(true)
    const coupon = await ok('manager', 'GET', `/production/bundles?workOrderId=${WO.coupon.id}`)
    const sewn = coupon.bundles.find((row: Json) => row.id === BUNDLES.coupon[0]!.id)
    expect(sewn).toMatchObject({ place: 'LINE', operation: { seq: 20 }, next: { seq: 30 }, lastScan: { operation: { seq: 20 }, station: { code: 'CUT-01' } }, stuck: { stuck: false, limitHours: 4 } })
    expect(coupon.bundles.find((row: Json) => row.id === BUNDLES.coupon[1]!.id).place).toBe('VOID')
    const onLine = await ok('manager', 'GET', `/production/bundles?place=LINE&siteId=${A.siteA1}`)
    expect(onLine.bundles.map((row: Json) => row.id)).toContain(BUNDLES.coupon[0]!.id)
    expect(onLine.bundles.every((row: Json) => row.place === 'LINE')).toBe(true)
    expect(onLine.bundles.some((row: Json) => BUNDLES.track.some((bundle) => bundle.id === row.id))).toBe(false)
    // Search or scan: a coupon's code and a work order number find their bundles.
    expect((await ok('manager', 'GET', `/production/bundles?q=${encodeURIComponent(sewn.code)}`)).bundles.map((row: Json) => row.id)).toEqual([sewn.id])
    expect((await ok('manager', 'GET', `/production/bundles?q=${encodeURIComponent(WO.other.number)}`)).bundles.map((row: Json) => row.id)).toEqual(BUNDLES.other.map((bundle) => bundle.id))
    // Pages: newest first, a cursor to the next page.
    const page = await ok('manager', 'GET', '/production/bundles?limit=2')
    expect(page.bundles).toHaveLength(2)
    expect(page.nextCursor).toBe(page.bundles[1].id)
    for (const answer of [list, coupon, page]) {
      expect(keysOf(answer).filter((name) => PERSON.test(name))).toEqual([])
      expect(keysOf(answer).filter((name) => /cost|price|margin|amount/i.test(name))).toEqual([])
    }
  })

  it("opens one bundle's record: progress done · here · not reached, ticket and coupons, genealogy with the shade", async () => {
    const record = await ok('manager', 'GET', `/production/bundles/${BUNDLES.coupon[0]!.id}`)
    expect(record.progress.map((row: Json) => [row.seq, row.state, row.good])).toEqual([
      [10, 'DONE', 6],
      [20, 'DONE', 6],
      [30, 'HERE', null],
      [40, 'NOT_REACHED', null],
    ])
    expect(record.ticket.coupons).toHaveLength(5)
    expect(record.ticket.coupons.filter((coupon: Json) => coupon.status === 'ACTIVE').map((coupon: Json) => coupon.operation.seq).sort()).toEqual([10, 20, 30])
    expect(record.genealogy).toMatchObject({ shades: ['A'], parent: null, children: [] })
    expect(record.genealogy.hides).toHaveLength(1)
    expect(keysOf(record).filter((name) => PERSON.test(name))).toEqual([])
  })

  it('is stuck after the limit in working hours; the scheduler tells it once per wait', async () => {
    const bundle = BUNDLES.track[0]!
    const cutting = (await ok('floor', 'GET', `/production/bundles/work-orders/${WO.track.id}`)).operations.find((operation: Json) => operation.seq === 10)
    // A report ten days ago (an offline queue's late send): the wait counts working hours on A1's calendar since then.
    await admin(
      `INSERT INTO "OperationScan" (id, "tenantId", "siteId", "workOrderId", "workOrderOperationId", "bundleId", kind, "goodQuantity", "workerId", "stationId", "deviceId", "clientScanId", "deviceTime", "serverTime", "createdById")
       VALUES ($1, $2, $3, $4, $5, $6, 'REPORT', 5, $7, $8, $9, $10, now() - interval '10 days', now() - interval '10 days', $7)`,
      [newId(), A.tenant, A.siteA1, WO.track.id, cutting.id, bundle.id, A.operatorA1, A.station, A.deviceA1, `late-${run}`],
    )
    const stuck = await ok('manager', 'GET', `/production/bundles/stuck?siteId=${A.siteA1}`)
    expect(stuck.bundles.map((row: Json) => row.id)).toEqual([bundle.id])
    expect(stuck.bundles[0]).toMatchObject({ place: 'LINE', operation: { seq: 10 }, stuck: { stuck: true, limitHours: 4 } })
    expect(stuck.bundles[0].stuck.workingHours).toBeGreaterThanOrEqual(4)
    const tiles = await ok('manager', 'GET', `/production/bundles/tiles?siteId=${A.siteA1}`)
    expect(tiles).toMatchObject({ stuck: 1, stuckLimitHours: 4, onHold: 0, atSubcontractor: 0, capped: false })
    // Today's replaced tickets: the coupon reprinted above, and any ticket reprint of the day (the seed's are dated later).
    const today = businessDate(new Date())
    const [replaced] = await admin<{ n: number }>(
      `SELECT ((SELECT count(*) FROM "BundleReprint" WHERE "tenantId" = $1 AND "siteId" = $2 AND "createdAt" >= $3 AND "createdAt" < $4) + (SELECT count(*) FROM "BundleCoupon" WHERE "tenantId" = $1 AND "siteId" = $2 AND "replacesId" IS NOT NULL AND "createdAt" >= $3 AND "createdAt" < $4))::int AS n`,
      [A.tenant, A.siteA1, businessDayStart(today), businessDayStart(plusDays(today, 1))],
    )
    // The seed's reprints are dated later (a made-up November day): never today's.
    expect(replaced!.n).toBe(1)
    expect(tiles.ticketsReplacedToday).toBe(replaced!.n)
    const [active] = await admin<{ n: number }>(`SELECT count(*)::int AS n FROM "Bundle" b JOIN "WorkOrder" w ON w.id = b."workOrderId" WHERE b."tenantId" = $1 AND b."siteId" = $2 AND b.status = 'ACTIVE' AND w.status IN ('RELEASED', 'IN_PROGRESS', 'ON_HOLD')`, [A.tenant, A.siteA1])
    expect(tiles.active).toBe(active!.n)
    const first = await runStuckBundles({ database, log: silent })
    expect(first.told).toBe(1)
    expect((await runStuckBundles({ database, log: silent })).told).toBe(0)
    expect((await outbox('production.bundle_stuck')).map((row) => row.payload)).toEqual([expect.objectContaining({ bundleId: bundle.id, place: 'LINE', limitHours: 4 })])
  })

  it('keeps every company and tenant apart; the floor reads no office list', async () => {
    await refused('companyB', 'GET', `/production/bundles/${BUNDLES.track[0]!.id}`, undefined, 404)
    expect((await ok('companyB', 'GET', '/production/bundles')).bundles).toEqual([])
    const ids = new Set(Object.values(BUNDLES).flat().map((bundle) => bundle.id))
    expect((await ok('otherTenant', 'GET', '/production/bundles')).bundles.some((row: Json) => ids.has(row.id))).toBe(false)
    await refused('floor', 'GET', '/production/bundles', undefined, 403)
    await refused('planner', 'GET', '/production/bundles/tiles', undefined, 403)
  })
})

// ---- scan-pattern checks (MES-075) ------------------------------------------------------------------------------------------

describe('scan-pattern checks about bundles, never people (MES-075; Statuto art. 4)', () => {
  let gateId = ''
  let finding: Json

  it('reads nothing while the site’s PERFORMANCE purpose is off; the panel says why', async () => {
    // Two reports at the cutting station seconds apart: well under half of 14 min × 5 garments.
    for (const bundle of BUNDLES.track.slice(1)) {
      const response = await report({ code: bundle.code, good: bundle.quantity })
      expect(response.statusCode, response.body).toBe(201)
    }
    expect((await runScanFindings({ database, log: silent })).sites).toBe(0)
    expect(await admin(`SELECT count(*)::int AS n FROM "ScanPatternFinding" WHERE "workOrderId" = $1`, [WO.track.id])).toEqual([{ n: 0 }])
    const summary = await ok('manager', 'GET', '/production/bundles/findings/summary')
    expect(summary.sites.find((site: Json) => site.id === A.siteA1)).toMatchObject({ checks: 'GATE_CLOSED' })
    expect(summary.sites.find((site: Json) => site.id === A.siteB1)).toMatchObject({ checks: 'STATION_SITE', words: 'Not available: this site records stations, not people.' })
    expect(summary.legalNote).toContain('L. 300/1970 art. 4')
  })

  it('finds the patterns once the purpose is on: counts per line and operation, the bundles behind them, no person', async () => {
    gateId = newId()
    await admin(
      `INSERT INTO "PeopleLegalGate" (id, "tenantId", "companyId", "siteId", purpose, basis, "basisReference", "noticeId", "dpiaId", "switchedOnAt", "switchedOnById")
       VALUES ($1, $2, $3, $4, 'PERFORMANCE', 'UNION_AGREEMENT', 'Made-up RSU agreement 2026/01', $5, $6, now() - interval '1 day', $7)`,
      [gateId, A.tenant, A.companyA, A.siteA1, A.notice, A.dpia, A.actor],
    )
    const first = await runScanFindings({ database, log: silent })
    expect(first).toMatchObject({ sites: 1, failed: 0 })
    expect(first.written).toBeGreaterThanOrEqual(1)
    // Run again: nothing new is written.
    expect((await runScanFindings({ database, log: silent })).written).toBe(0)
    const summary = await ok('manager', 'GET', `/production/bundles/findings/summary?siteId=${A.siteA1}`)
    expect(summary.sites).toEqual([expect.objectContaining({ id: A.siteA1, checks: 'ON' })])
    expect(summary.rows.find((row: Json) => row.kind === 'GAP_BELOW_STANDARD')).toMatchObject({ operation: { code: 'SEED-CUT-LEA' }, open: expect.any(Number) })
    const list = await ok('manager', 'GET', `/production/bundles/findings?siteId=${A.siteA1}&kind=GAP_BELOW_STANDARD`)
    finding = list.findings.find((row: Json) => row.bundle.id === BUNDLES.track[1]!.id)
    expect(finding).toMatchObject({ status: 'OPEN', operation: { seq: 10 }, workOrder: { id: WO.track.id }, seen: { pieces: 5, standardMinutes: 70 } })
    for (const answer of [summary, list]) expect(keysOf(answer).filter((name) => PERSON.test(name) || /station/i.test(name))).toEqual([])
    const stored = await admin<{ detail: Json; createdById: string | null }>(`SELECT detail, "createdById" FROM "ScanPatternFinding" WHERE "siteId" = $1`, [A.siteA1])
    expect(stored.every((row) => row.createdById === null && !keysOf(row.detail).some((name) => PERSON.test(name) || /station/i.test(name)))).toBe(true)
    expect((await outbox('production.scan_findings_found'))[0]!.payload).toMatchObject({ siteId: A.siteA1, gapBelowStandard: expect.any(Number) })
  })

  it('opens the names behind ONE finding with a purpose, written in the audit log; held without the permission or the purpose', async () => {
    await refused('manager', 'POST', `/production/bundles/findings/${finding.id}/who`, { purpose: 'TALK_WITH_THE_WORKER' }, 403)
    await refused('who', 'POST', `/production/bundles/findings/${finding.id}/who`, {}, 400)
    const shown = await ok('who', 'POST', `/production/bundles/findings/${finding.id}/who`, { purpose: 'TALK_WITH_THE_WORKER', note: 'Asked at the shift meeting' }, 201)
    expect(shown).toMatchObject({ finding: { id: finding.id }, logged: true })
    expect(shown.scans.length).toBeGreaterThanOrEqual(1)
    expect(shown.scans.every((scan: Json) => scan.worker?.id === A.operatorA1 && scan.worker.name !== '')).toBe(true)
    const audit = await admin<{ after: Json; reason: string }>(`SELECT after, reason FROM "AuditLog" WHERE action = 'production.showFindingWho' AND "recordId" = $1`, [finding.id])
    expect(audit).toEqual([{ after: { purpose: 'TALK_WITH_THE_WORKER', shown: shown.scans.length, workerIds: [A.operatorA1] }, reason: 'TALK_WITH_THE_WORKER: Asked at the shift meeting' }])
    // No receipt keeps the names.
    expect(await admin(`SELECT count(*)::int AS n FROM "IdempotencyReceipt" WHERE scope = 'production.showFindingWho'`)).toEqual([{ n: 0 }])
    // Switched off: held again, in words, with the gate's path.
    await admin(`UPDATE "PeopleLegalGate" SET "switchedOffAt" = now(), "switchedOffById" = $2, "switchOffReason" = 'The agreement ended (made up)' WHERE id = $1`, [gateId, A.actor])
    const held = await refused('who', 'POST', `/production/bundles/findings/${finding.id}/who`, { purpose: 'PAY_QUERY' }, 409)
    expect(pathOf(held)).toBe('gate/PERFORMANCE')
    await refused('companyB', 'POST', `/production/bundles/findings/${finding.id}/who`, { purpose: 'PAY_QUERY' }, 404)
  })

  it('a person reviews or dismisses a finding (a dismissal says why), once', async () => {
    expect(pathOf(await refused('manager', 'POST', `/production/bundles/findings/${finding.id}/review`, { status: 'DISMISSED' }, 400))).toBe('body/note')
    const reviewed = await ok('manager', 'POST', `/production/bundles/findings/${finding.id}/review`, { status: 'REVIEWED', note: 'Two bundles of a rush order', version: finding.version }, 201, freshKey())
    expect(reviewed.finding).toMatchObject({ status: 'REVIEWED', reviewNote: 'Two bundles of a rush order' })
    await refused('manager', 'POST', `/production/bundles/findings/${finding.id}/review`, { status: 'DISMISSED', note: 'Again' }, 409)
    await refused('who', 'POST', `/production/bundles/findings/${finding.id}/review`, { status: 'REVIEWED' }, 403)
    expect((await outbox('production.scan_finding_reviewed')).map((row) => row.payload)).toEqual([{ findingId: finding.id, siteId: A.siteA1, bundleId: finding.bundle.id, status: 'REVIEWED' }])
  })
})

// ---- pair and set matching (MES-078) ------------------------------------------------------------------------------------------

describe('pairs and sets matched by shade (MES-078)', () => {
  it('matches a cell’s bundles per shade and names a bundle cut from two shades', async () => {
    const sets = await ok('floor', 'GET', `/production/bundles/work-orders/${WO.mixed.id}/sets`)
    expect(sets.cells).toHaveLength(1)
    expect(sets.cells[0].mixed).toEqual([{ id: BUNDLES.mixed[1]!.id, code: BUNDLES.mixed[1]!.code, shades: ['A', 'B'] }])
    expect(sets.cells[0].sets).toEqual([expect.objectContaining({ shade: 'A', complete: 6 })])
  })

  it('checks bundles meant to be joined: one shade passes, two shades or two cells are refused in words', async () => {
    const pass = await ok('floor', 'GET', `/production/bundles/sets/check?bundleIds=${BUNDLES.track[0]!.id},${BUNDLES.track[1]!.id}`)
    expect(pass).toMatchObject({ ok: true, shade: 'A', refusal: null })
    const mixed = await ok('manager', 'GET', `/production/bundles/sets/check?bundleIds=${BUNDLES.mixed[0]!.id},${BUNDLES.mixed[1]!.id}`)
    expect(mixed).toMatchObject({ ok: false, refusal: { code: 'MIXED_SHADES' } })
    const cells = await ok('floor', 'GET', `/production/bundles/sets/check?bundleIds=${BUNDLES.track[0]!.id},${BUNDLES.other[0]!.id}`)
    expect(cells.refusal.code).toBe('NOT_ONE_SET')
    await refused('floor', 'GET', `/production/bundles/sets/check?bundleIds=${BUNDLES.track[0]!.id}`, undefined, 400)
    await refused('otherTenant', 'GET', `/production/bundles/sets/check?bundleIds=${BUNDLES.track[0]!.id},${BUNDLES.track[1]!.id}`, undefined, 404)
  })
})
