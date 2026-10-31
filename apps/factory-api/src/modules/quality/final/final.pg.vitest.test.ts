import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { hashPin } from '@nexus/factory-domain/auth/floor/pin'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedPrivacy } from '../../../../../../packages/factory-db/seed/privacy'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seed as seedQuality, type QualitySeed } from '../../../../../../packages/factory-db/seed/quality'
import { seed as seedReasons } from '../../../../../../packages/factory-db/seed/reasons'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { fileTravelDocuments, TRAVEL_DOCUMENT_PERMISSIONS } from '../../shipping/documents/testing/compliance'

/**
 * The final inspection and release by an inspector who is not a maker (B-W1-45; QHS-013, QHS-050, QHS-051, QHS-058,
 * QHS-073, PLT-097; Owner answers Q1 (a) four eyes as a setting, Q2 (a) the evidence trail, Q3 (a) goods on hold) on the
 * local stack with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login:
 * row-level security, the column grants and the …_quality_final_release_guards triggers are real), the factory-db seeds
 * of two tenants up to production, privacy (company A's floor is ready) and numbering, and the quality seed of tenant A
 * (its certificate covers SEED-JKT-02 in every size; SEED-WO-0003 is serial-tracked with two releases), the files seed's
 * FAKE R2 account behind the harness's local file store (the DoC and leaflet), a made-up lot of large black hides and a
 * second lot (blocked during the test), made-up tablets and a FAKE label printer at A1. Released work orders of SEED-JKT-02
 * are made, cut, bundled and reported through every operation by the seeded operator through the floor's routes (test
 * sessions), and their garment labels printed (B-W1-44). The signing acts use the harness's real sign-in: office
 * inspectors with two-factor (step-up), and an enrolled bench tablet with a floor inspector signed in by badge and PIN.
 * Every name and number is made up. Run with `node scripts/factory/run-pg-tests.mjs quality/final`.
 */

let h: Harness
let app: FastifyInstance
let quality: QualitySeed

const ns = { a: 'final-a', b: 'final-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  brand: idOf(ns.a, 'party:P1'),
  style: idOf(ns.a, 'production:style:JKT-02'),
  blk: idOf(ns.a, 'production:colourway:JKT-02:BLK'),
  leather: idOf(ns.a, 'product:item:leather'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  bin: idOf(ns.a, 'inventory:location:A1-STORE-01'),
  sew1Station: idOf(ns.a, 'site:A1:station:SEW-01'),
  qcStation: idOf(ns.a, 'site:A1:station:QC-01'),
  packStation: idOf(ns.a, 'site:A1:station:PACK-01'),
  cutter: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
  sew1: newId(),
  qc: newId(),
  pack: newId(),
  printer: newId(),
}
const B = { tenant: idOf(ns.b, 'tenant') }
const TENANT: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
const PIN = '482913'

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (tenantId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId, actorId: newId(), grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'production.serials', 'inventory.issue', 'print.view', 'print.labels', 'quality.inspections.view']
const floor = (deviceId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId, grants: [{ permissions: FLOOR, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] })
const VIEW: Permission[] = ['quality.inspections.view', 'quality.lots.view']
const SESSIONS: Record<string, SessionContext> = {
  planner: office(A.tenant, [grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  cutter: floor(A.cutter),
  sew1: floor(A.sew1),
  qc: floor(A.qc),
  pack: floor(A.pack),
  docs: office(A.tenant, [grant(TRAVEL_DOCUMENT_PERMISSIONS)]),
  rules: office(A.tenant, [grant(['quality.inspections.view', 'quality.settings.manage'])]),
  reverser: office(A.tenant, [grant(['quality.inspections.view', 'quality.garments.reverse'])]),
  lab: office(A.tenant, [grant(['quality.lots.view', 'quality.lots.reject'])]),
  viewer: office(A.tenant, [grant(VIEW)]),
  costViewer: office(A.tenant, [grant([...VIEW, 'money.cost'])]),
  companyB: office(A.tenant, [grant(VIEW, [A.companyB])]),
  otherParty: office(A.tenant, [grant(VIEW, 'all', [newId()])]),
  otherTenant: office(B.tenant, [grant(VIEW)]),
  // B-W2a-67: the defect library's keeper and a person who places holds.
  library: office(A.tenant, [grant(['quality.defects.view', 'quality.defects.manage'])]),
  holder: office(A.tenant, [grant(['quality.holds.view', 'quality.holds.place', 'quality.inspections.view'])]),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `t-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload, method === 'GET' ? undefined : freshKey())
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload, freshKey())
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const checksOf = (error: Json): string[] => pathsOf(error).filter((path) => /^checks\/[A-Z_]+$/.test(path)).map((path) => path.slice('checks/'.length))
const MONEY = /cost|price|margin|amount|wage|valuation/i
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []

/** A Browser call on the harness's app (the real sign-in): status checked, body returned. */
async function as(browser: Browser, method: Method, url: string, body?: unknown, status = 200, key?: string): Promise<Json> {
  const answer = await browser.send(method as 'POST', url, body, key ? { headers: { 'idempotency-key': key } } : {})
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body
}

// ---- the people ----------------------------------------------------------------------------------------------------------------

interface Person {
  readonly id: string
  readonly browser: Browser
  readonly secret: string
}
const signedIn = async (email: string, role: string): Promise<Person> => {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(TENANT.slug, user.email, user.password)
  if (answer.body.status !== 'signed_in') throw new Error(`sign-in ${email}: ${answer.status} ${JSON.stringify(answer.body)}`)
  return { id: user.id, browser, secret: await enrolTotp(h, browser) }
}
const stepped = (person: Person) => stepUp(h, person.browser, person.secret)
let inspector1: Person
let inspector2: Person
let maker: Person
let owner: Person
let supervisor: Person

const roleIdOf = async (key: string) => (await admin<{ id: string }>('SELECT id::text FROM "Role" WHERE "tenantId" = $1::uuid AND key = $2', [A.tenant, key]))[0]!.id

/** An enrolled tablet at A1's inspection bench (the office makes the code, the tablet trades it). */
async function tablet(): Promise<Browser> {
  const made = await supervisor.browser.post('/auth/floor/devices', { siteId: A.siteA1, stationId: A.qcStation, name: `Bench tablet ${newId().slice(-4)}` })
  if (made.status !== 200) throw new Error(`enrol: ${made.status} ${JSON.stringify(made.body)}`)
  const browser = new Browser(h.app)
  await browser.get('/auth/csrf')
  const enrolled = await browser.post('/floor/device/enrol', { code: made.body.enrolment.code, appVersion: '1.0.0' })
  if (enrolled.status !== 200) throw new Error(`exchange: ${enrolled.status} ${JSON.stringify(enrolled.body)}`)
  return browser
}

/** A badge (through the office's route) and a PIN (written straight in, peppered) for a worker; its floor roles. */
async function credentials(workerId: string, roles: string[]): Promise<string> {
  await stepped(supervisor)
  const placed = await supervisor.browser.send('PUT' as 'POST', `/auth/floor/workers/${workerId}/roles`, { roleIds: await Promise.all(roles.map(roleIdOf)) })
  if (placed.status !== 200) throw new Error(`roles: ${placed.status} ${JSON.stringify(placed.body)}`)
  const badge = await supervisor.browser.post(`/auth/floor/workers/${workerId}/badges`)
  if (badge.status !== 200) throw new Error(`badge: ${badge.status} ${JSON.stringify(badge.body)}`)
  await admin('UPDATE "Worker" SET "pinHash" = $2 WHERE id = $1::uuid', [workerId, await hashPin(PIN, h.auth.pins, { logN: 12, r: 8, p: 1 })])
  return badge.body.code as string
}

// ---- made-up stock, work orders, cuts, bundles, scans and labels ---------------------------------------------------------------

const hides: Record<string, string> = {}
const lots: Record<string, string> = {}

async function addLot(name: string, hideKeys: string[]) {
  const lotId = newId()
  lots[name] = lotId
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, `T-${run}-${name}`],
  )
  for (const key of hideKeys) {
    const hideId = newId()
    hides[key] = `T-${run}-${key}`
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [
      hideId,
      A.tenant,
      A.siteA1,
      lotId,
      A.leather,
      hides[key],
    ])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `final-test-${run}-${key}`],
    )
  }
}

/** A CONFIRMED sales order line of company A for black SEED-JKT-02 (customer P1). */
async function salesOrderLine(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
        select: { id: true },
      })
      for (const [size, quantity] of [
        ['50', pieces - 10],
        ['52', 10],
      ] as const) {
        await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size, quantity }, select: { id: true } })
      }
    }),
  )
  return lineId
}

type Orders = 'main' | 'override' | 'failed' | 'bench' | 'lot'
const WO = {} as Record<Orders, Json>
const cellOf = (name: Orders, size = '50'): string => WO[name].cells.find((cell: Json) => cell.size === size).id
const opOf = (workOrder: Json, seq: number): string => (workOrder.spec.operations as Json[]).find((op) => op.seq === seq)!.id

async function makeWorkOrder(name: Orders, line: string, sizes: Record<string, number>, hideKey: string) {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: line, sizes: Object.entries(sizes).map(([size, quantity]) => ({ size, quantity })) }] }, 201)
  WO[name] = (await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })).workOrder
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${WO[name].id}/cuts`, { clientEventId: `ce-${run}-${++keys}`, code: hides[hideKey], lines: WO[name].cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, freshKey())
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${WO[name].id}/bundles`, { bundleSize: 10, printerId: null }, freshKey())
  expect(made.statusCode, made.body).toBe(201)
  for (const bundle of made.json().bundles as Json[]) {
    for (const [seq, session] of [
      [10, 'cutter'],
      [20, 'sew1'],
      [30, 'qc'],
      [40, 'pack'],
    ] as const) {
      const scan = await call(session, 'POST', '/production/scans', { clientScanId: `sc-${run}-${++keys}`, code: bundle.code, workOrderOperationId: opOf(WO[name], seq), good: bundle.quantity })
      expect(scan.statusCode, scan.body).toBe(201)
    }
  }
  WO[name].batchNumber = (await admin<{ b: string }>('SELECT "batchNumber" AS b FROM "WorkOrder" WHERE id = $1', [WO[name].id]))[0]!.b
}

const printLabels = async (name: Orders, cells?: { workOrderSizeId: string; count: number }[]) => {
  const printed = await call('pack', 'POST', `/production/serials/work-orders/${WO[name].id}/labels`, { ...(cells ? { cells } : {}), printerId: A.printer }, freshKey())
  expect(printed.statusCode, printed.body).toBe(201)
}

// ---- the inspection and release helpers -----------------------------------------------------------------------------------------

const CHECKS = ['EN17092_CLASS_LABEL', 'SIZE_LABEL', 'CE_MARK', 'CARE_LABEL', 'FIBRE_COMPOSITION', 'ANIMAL_ORIGIN_PHRASE', 'ZIPS', 'REFLECTIVES', 'ARMOUR_FITTED', 'HANGTAGS', 'USER_INFORMATION', 'PACKAGING']
const allOk = () => CHECKS.map((code) => ({ code, ok: true }))
const PLAN = { inspectionLevel: 'II', aqlMajor: '2.5', aqlMinor: '4.0', acceptMajor: 0, acceptMinor: 1 }
const releasesOf = async (workOrderId: string) =>
  admin<Json>('SELECT id, "workOrderSizeId", quantity, "releasedById"::text AS "releasedById", "releasedByWorkerId"::text AS "releasedByWorkerId", "secondPersonReasons"::text[] AS reasons FROM "QualityRelease" WHERE "workOrderId" = $1 ORDER BY "createdAt"', [workOrderId])
const netReleased = async (cellId: string) =>
  (await admin<{ n: number }>('SELECT ((SELECT coalesce(sum(quantity), 0) FROM "QualityRelease" WHERE "workOrderSizeId" = $1) - (SELECT coalesce(sum(quantity), 0) FROM "QualityReleaseReversal" WHERE "workOrderSizeId" = $1))::int AS n', [cellId]))[0]!.n

/** An inspection opened, checked (every check ok) and signed by an office inspector; returns its view. */
async function passedBy(person: Person, name: Orders, plan: Json, defects: Json[] = [], decision: Json = {}): Promise<Json> {
  const opened = (await as(person.browser, 'POST', '/quality/inspections', { workOrderId: WO[name].id, ...PLAN, ...plan }, 201)).inspection
  let version = opened.version
  if (defects.length) version = (await as(person.browser, 'PUT', `/quality/inspections/${opened.id}/defects`, { version, defects })).inspection.version
  await stepped(person)
  return (await as(person.browser, 'POST', `/quality/inspections/${opened.id}/decide`, { version, result: 'PASS', checklist: allOk(), ...decision })).inspection
}
const release = (person: Person, body: Json, status = 201) => as(person.browser, 'POST', '/quality/releases', body, status)

let mainInspection: Json

beforeAll(async () => {
  h = await startHarness('quality_final')
  for (const namespace of [ns.a, ns.b]) {
    await seedCore({ db: h.database, namespace })
    await seedPrivacy({ db: h.database, namespace })
    await seedProduction({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
  }
  await seedFiles({ db: h.database, namespace: ns.a })
  quality = await seedQuality({ db: h.database, namespace: ns.a })
  // B-W2a-75: the HOLD reasons the bench's Hold lot picks from.
  await seedReasons({ db: h.database, namespace: ns.a })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  await addLot('BIG', ['H01', 'H02', 'H03', 'H04'])
  await addLot('HOLD', ['H05'])
  for (const [deviceId, stationId, name] of [
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.qc, A.qcStation, 'Inspection tablet'],
    [A.pack, A.packStation, 'Packing tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  await admin(
    `INSERT INTO "Printer" (id, "tenantId", "companyId", "siteId", code, name, kind, relay, "relayTarget", dpi, "labelWidthMm", "labelHeightMm") VALUES ($1, $2, $3, $4, 'LBL-QF', 'Made-up garment label printer', 'LABEL_ZPL', 'FAKE', 'test-final-printer:9100', 203, 100, 100)`,
    [A.printer, A.tenant, A.companyA, A.siteA1],
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  const line = await salesOrderLine(40)
  await makeWorkOrder('main', line, { '50': 4, '52': 2 }, 'H01')
  await makeWorkOrder('override', line, { '50': 2 }, 'H02')
  await makeWorkOrder('failed', line, { '50': 2 }, 'H03')
  await makeWorkOrder('bench', line, { '50': 2 }, 'H04')
  await makeWorkOrder('lot', line, { '50': 2 }, 'H05')
  // Labels: main 50 all four, main 52 one of two; the others all.
  await printLabels('main', [
    { workOrderSizeId: cellOf('main'), count: 4 },
    { workOrderSizeId: cellOf('main', '52'), count: 1 },
  ])
  for (const name of ['override', 'failed', 'bench', 'lot'] as const) await printLabels(name)

  inspector1 = await signedIn('inspector.one@example.com', 'quality_inspector')
  inspector2 = await signedIn('inspector.two@example.com', 'quality_inspector')
  maker = await signedIn('maker.person@example.com', 'quality_inspector')
  owner = await signedIn('owner.person@example.com', 'owner')
  supervisor = await signedIn('floor.supervisor@example.com', 'floor_supervisor')
  // The maker's office user is the seeded operator who cut, bundled and reported every garment.
  await admin('UPDATE "Worker" SET "userId" = $2 WHERE id = $1', [A.operatorA1, maker.id])
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ---- the inspection -------------------------------------------------------------------------------------------------------------

describe('the final inspection (QHS-050, QHS-013)', () => {
  it('is opened by an office inspector, recorded, and signed with a fresh code; the computed result is the database’s', async () => {
    const { inspection } = await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.main.id, lotSize: 6, sampleSize: 6, ...PLAN }, 201)
    expect(inspection).toMatchObject({ status: 'OPEN', plan: { lotSize: 6, sampleSize: 6, hundredPercent: true, aqlMajor: '2.500' }, inspector: { kind: 'OFFICE', userId: inspector1.id } })
    // Its own number, from company A's INSPECTION series (the seed issued INS-A-2026-0001), in the ledger under its id.
    expect(inspection.inspectionNumber).toMatch(/^INS-A-\d{4}-\d{4}$/)
    expect(inspection.label).toBe(inspection.inspectionNumber)
    expect(await admin('SELECT formatted, kind::text AS kind FROM "NumberAllocation" WHERE "recordType" = \'Inspection\' AND "recordId" = $1', [inspection.id])).toEqual([{ formatted: inspection.inspectionNumber, kind: 'INSPECTION' }])
    // More than the finished garments: refused in words.
    expect(pathsOf((await inspector1.browser.post('/quality/inspections', { workOrderId: WO.main.id, lotSize: 7, sampleSize: 1, ...PLAN })).body.error)).toEqual(['body/lotSize'])
    // Record: part of the checklist, then the defects (one minor: within Ac 1).
    let version = (await as(inspector1.browser, 'PATCH', `/quality/inspections/${inspection.id}`, { version: inspection.version, checklist: [{ code: 'CE_MARK', ok: true }] })).inspection.version
    const recorded = (await as(inspector1.browser, 'PUT', `/quality/inspections/${inspection.id}/defects`, { version, defects: [{ defectClass: 'MINOR', code: 'LOOSE-THREAD', quantity: 1, workOrderSizeId: cellOf('main') }] })).inspection
    expect(recorded.counts).toEqual({ critical: 0, major: 0, minor: 1 })
    expect(recorded.computed.result).toBe('PASS')
    version = recorded.version
    // Another inspector neither records nor signs it.
    await as(inspector2.browser, 'POST', `/quality/inspections/${inspection.id}/decide`, { version, result: 'PASS', checklist: allOk() }, 403)
    // Every check answered before signing; then the signature needs a fresh code.
    expect(pathsOf((await inspector1.browser.post(`/quality/inspections/${inspection.id}/decide`, { version, result: 'PASS', checklist: [{ code: 'CE_MARK', ok: true }] })).body.error)).toEqual(['body/checklist'])
    h.clock.advance(6 * 60_000)
    const noCode = await inspector1.browser.post(`/quality/inspections/${inspection.id}/decide`, { version, result: 'PASS', checklist: allOk() })
    expect(noCode.status).toBe(403)
    expect(noCode.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepped(inspector1)
    mainInspection = (await as(inspector1.browser, 'POST', `/quality/inspections/${inspection.id}/decide`, { version, result: 'PASS', checklist: allOk() })).inspection
    expect(mainInspection).toMatchObject({ status: 'PASSED', computed: { result: 'PASS' }, overridden: false, overrideReason: null })
    expect(mainInspection.signatureSha256).toMatch(/^[0-9a-f]{64}$/)
    expect(await admin('SELECT status::text, "computedResult"::text AS computed, "overrideReason" FROM "Inspection" WHERE id = $1', [inspection.id])).toEqual([{ status: 'PASSED', computed: 'PASS', overrideReason: null }])
    expect(await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['quality.inspection_decided', inspection.id])).toEqual([
      { payload: expect.objectContaining({ status: 'PASSED', computedResult: 'PASS', overridden: false, postedBy: 'OFFICE' }) },
    ])
    // A signed inspection never changes.
    await as(inspector1.browser, 'POST', `/quality/inspections/${inspection.id}/cancel`, { version: mainInspection.version, reason: 'Started by mistake' }, 409)
  })

  it('an override of the computed result needs the written reason, and never accepts a critical defect', async () => {
    const opened = (await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.override.id, lotSize: 2, sampleSize: 2, ...PLAN, acceptMinor: 0 }, 201)).inspection
    const withMinor = (await as(inspector1.browser, 'PUT', `/quality/inspections/${opened.id}/defects`, { version: opened.version, defects: [{ defectClass: 'MINOR', code: 'LINING-CREASE', quantity: 1 }] })).inspection
    expect(withMinor.computed).toEqual({ result: 'FAIL', words: 'FAIL: 1 garment(s) with a minor defect; the plan accepts 0.' })
    const noReason = await inspector1.browser.post(`/quality/inspections/${opened.id}/decide`, { version: withMinor.version, result: 'PASS', checklist: allOk() })
    expect(noReason.status, JSON.stringify(noReason.body)).toBe(400)
    expect(pathsOf(noReason.body.error)).toEqual(['body/overrideReason'])
    await stepped(inspector1)
    const overridden = (await as(inspector1.browser, 'POST', `/quality/inspections/${opened.id}/decide`, { version: withMinor.version, result: 'PASS', checklist: allOk(), overrideReason: 'The customer accepts a creased lining (written concession, made up).' })).inspection
    expect(overridden).toMatchObject({ status: 'PASSED', computed: { result: 'FAIL' }, overridden: true })
    expect(await as(inspector1.browser, 'GET', `/quality/inspections/${opened.id}`)).toMatchObject({ yours: true, statementNeeded: false, maker: { made: false }, inspection: { overrideReason: expect.stringMatching(/^The customer accepts/) } })
    expect((await as(inspector2.browser, 'GET', `/quality/inspections/${opened.id}`)).yours).toBe(false)
    // An inspection opened by mistake is cancelled with the reason (and never changes after).
    const mistake = (await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.override.id, lotSize: 1, sampleSize: 1, ...PLAN }, 201)).inspection
    await as(inspector1.browser, 'POST', `/quality/inspections/${mistake.id}/cancel`, { version: mistake.version + 1, reason: 'Opened on the wrong order' }, 409)
    expect((await as(inspector1.browser, 'POST', `/quality/inspections/${mistake.id}/cancel`, { version: mistake.version, reason: 'Opened on the wrong order' })).inspection).toMatchObject({ status: 'CANCELLED', version: mistake.version + 1 })
    expect(await admin('SELECT reason FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [mistake.id, 'quality.inspection.cancel'])).toEqual([{ reason: 'Opened on the wrong order' }])

    // A critical defect FAILS whatever the reason.
    const critical = (await as(inspector2.browser, 'POST', '/quality/inspections', { workOrderId: WO.failed.id, lotSize: 2, sampleSize: 2, ...PLAN }, 201)).inspection
    const withCritical = (await as(inspector2.browser, 'PUT', `/quality/inspections/${critical.id}/defects`, { version: critical.version, defects: [{ defectClass: 'CRITICAL', code: 'ARMOUR-MISSING', quantity: 1 }] })).inspection
    const never = await inspector2.browser.post(`/quality/inspections/${critical.id}/decide`, { version: withCritical.version, result: 'PASS', checklist: allOk(), overrideReason: 'We need them shipped.' })
    expect(never.status).toBe(400)
    expect(never.body.error.issues[0].message).toMatch(/^A PASS over this FAIL is never signed: 1 garment\(s\) with a critical defect/)
    await stepped(inspector2)
    expect((await as(inspector2.browser, 'POST', `/quality/inspections/${critical.id}/decide`, { version: withCritical.version, result: 'FAIL', checklist: allOk() })).inspection).toMatchObject({ status: 'FAILED', computed: { result: 'FAIL' } })
  })
})

// ---- the maker, the gate ----------------------------------------------------------------------------------------------------------

describe('the release gate (QHS-051, QHS-058, PLT-097)', () => {
  it('a maker never inspects nor releases: the office user linked to the worker who cut and reported the garments', async () => {
    const opened = await maker.browser.post('/quality/inspections', { workOrderId: WO.main.id, lotSize: 1, sampleSize: 1, ...PLAN })
    expect(opened.status, JSON.stringify(opened.body)).toBe(409)
    expect(opened.body.error.issues).toEqual([{ path: 'maker', message: expect.stringMatching(/^You made garments of work order .*: another inspector, who made none of them, signs it\.$/) }])
    const refusedRelease = await maker.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })
    expect(refusedRelease.status).toBe(409)
    expect(checksOf(refusedRelease.body.error)).toEqual(['DOCUMENTS', 'MAKER'])
    // The database refuses it too, for every login.
    await expect(
      admin(
        `INSERT INTO "QualityRelease" (id, number, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", quantity, "certificateIds", "releasedById", "releasedAt", "signatureSha256")
         VALUES ($1, 'T-REL-' || gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, 1, ARRAY[$8]::uuid[], $9, now(), 'x')`,
        [newId(), A.tenant, A.companyA, A.siteA1, WO.main.id, cellOf('main'), mainInspection.id, quality.certificateId, maker.id],
      ),
    ).rejects.toThrow(/is worker .*, who made garments of work order/)
  })

  it('refuses with every open check in words: the documents, the labels, the certificate, a failed inspection, a lot on hold — nothing is written', async () => {
    const before = (await releasesOf(WO.main.id)).length
    // 52: one label printed, two asked; no DoC or leaflet on file yet.
    const both = await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main', '52'), quantity: 2 })
    expect(both.status).toBe(409)
    expect(checksOf(both.body.error)).toEqual(['LABELS', 'DOCUMENTS'])
    expect(both.body.error.issues.find((issue: Json) => issue.path === 'checks/DOCUMENTS').message).toMatch(/Declaration of Conformity/)
    // The signed DoC and leaflet of the work order's revision, in the label's languages.
    const revisionId = (await admin<{ r: string }>('SELECT "styleRevisionId"::text AS r FROM "WorkOrder" WHERE id = $1', [WO.main.id]))[0]!.r
    for (const language of ['it', 'en']) await fileTravelDocuments(app, 'docs', A.style, revisionId, language)
    expect(checksOf((await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main', '52'), quantity: 2 })).body.error)).toEqual(['LABELS'])
    // The certificate suspended: refused in the gate's words.
    await admin(`UPDATE "Certificate" SET status = 'SUSPENDED' WHERE id = $1`, [quality.certificateId])
    const suspended = await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })
    expect(checksOf(suspended.body.error)).toEqual(['CERTIFICATE'])
    await admin(`UPDATE "Certificate" SET status = 'VALID' WHERE id = $1`, [quality.certificateId])
    // A FAILED inspection releases nothing.
    const failedInspection = (await admin<{ id: string }>(`SELECT id::text FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'FAILED'`, [WO.failed.id]))[0]!.id
    expect(checksOf((await inspector1.browser.post('/quality/releases', { inspectionId: failedInspection, workOrderSizeId: cellOf('failed'), quantity: 1 })).body.error)).toEqual(['INSPECTION', 'QUANTITY'])
    // A material lot of the work order blocked by quality: its garments are not released.
    const lotVersion = (await admin<{ v: number }>('SELECT version AS v FROM "Lot" WHERE id = $1', [lots.HOLD]))[0]!.v
    await ok('lab', 'POST', `/quality/lots/${lots.HOLD}/block`, { version: lotVersion, reason: 'Odour of solvent found on the hides (made up).' })
    const lotInspection = await passedBy(inspector2, 'lot', { lotSize: 2, sampleSize: 2 })
    const onHold = await inspector1.browser.post('/quality/releases', { inspectionId: lotInspection.id, workOrderSizeId: cellOf('lot'), quantity: 2 })
    expect(checksOf(onHold.body.error)).toEqual(['LOTS'])
    expect(onHold.body.error.issues[0].message).toBe(`Material lot(s) on hold: T-${run}-HOLD blocked. Garments made from them are not released.`)
    expect((await releasesOf(WO.main.id)).length).toBe(before)
    // The work order's final view says the same per cell, for the viewer.
    const final = await as(inspector1.browser, 'GET', `/quality/final/work-orders/${WO.main.id}`)
    expect(final.cells.map((cell: Json) => [cell.size, cell.releasable, cell.summary])).toEqual([
      ['50', 4, 'Ready to release'],
      ['52', 2, 'Ready to release'],
    ])
    expect(final.maker).toEqual({ made: false, words: expect.stringMatching(/^Made by \(from the floor's records\): 1 person\. You are not among them\.$/) })
  })

  it('a held work order moves on nowhere, in words before the database (B-W2a-F1 hooks): no inspection, no bundle, no label, no release', async () => {
    const workOrder = WO.main
    const from = (await admin<{ status: string }>('SELECT status::text AS status FROM "WorkOrder" WHERE id = $1', [workOrder.id]))[0]!.status
    expect(from).toBe('IN_PROGRESS')
    // ON_HOLD as a hold puts it (wave 5's columns): the gate of every insert below (…_awaits_hold).
    await admin(`UPDATE "WorkOrder" SET status = 'ON_HOLD', "heldFromStatus" = $2::"WorkOrderStatus", "heldAt" = now(), "holdReason" = 'Stain on a sleeve (made up)' WHERE id = $1`, [workOrder.id, from])
    const held = (what: string) => `Work order ${workOrder.number} is on hold (Stain on a sleeve (made up)): ${what} until the hold is lifted.`
    try {
      const opened = await inspector2.browser.post('/quality/inspections', { workOrderId: workOrder.id, lotSize: 1, sampleSize: 1, ...PLAN })
      expect(opened.status, JSON.stringify(opened.body)).toBe(409)
      expect(opened.body.error.message).toBe(held('its garments are not inspected'))
      const bundles = await refused('cutter', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { bundleSize: 10, printerId: null }, 409)
      expect(bundles.issues).toEqual([{ path: 'refusal/WORK_ORDER_ON_HOLD', message: held('no bundle is made for it') }])
      const labels = await refused('pack', 'POST', `/production/serials/work-orders/${workOrder.id}/labels`, { cells: [{ workOrderSizeId: cellOf('main'), count: 1 }], printerId: A.printer }, 409)
      expect(labels.message).toBe(held('its garment labels are not printed'))
      expect(pathsOf(labels)).toContain('refusal/WORK_ORDER_NOT_OPEN')
    } finally {
      await admin(`UPDATE "WorkOrder" SET status = "heldFromStatus", "heldFromStatus" = NULL, "heldAt" = NULL, "heldById" = NULL, "holdReason" = NULL, "holdRecordType" = NULL, "holdRecordId" = NULL WHERE id = $1`, [workOrder.id])
    }
    // An ACTIVE quality hold of the work order (its status kept, as for a COMPLETED one): the release is refused in the
    // gate's shape (checks/WORK_ORDER), after the signature and before the database's QualityRelease_awaits_quality_hold.
    const holdId = newId()
    await admin(
      `INSERT INTO "QualityHold" (id, "tenantId", "companyId", "siteId", "subjectType", "subjectIds", "reasonCode", "reasonNote", "placedAt", "placedById", "createdById")
       VALUES ($1, $2, $3, $4, 'WorkOrder', ARRAY[$5]::uuid[], 'QUALITY_CHECK', 'A stain found at packing (made up).', '2026-11-21T09:00:00Z', $6, $6)`,
      [holdId, A.tenant, A.companyA, A.siteA1, workOrder.id, owner.id],
    )
    try {
      const before = (await releasesOf(workOrder.id)).length
      await stepped(inspector1)
      const answer = await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 3 })
      expect(answer.status, JSON.stringify(answer.body)).toBe(409)
      expect(checksOf(answer.body.error)).toEqual(['WORK_ORDER'])
      expect(answer.body.error.message).toMatch(new RegExp(`^Work order ${workOrder.number} is on hold \\(.+, since 21 Nov 2026\\): its garments are not released until quality releases the hold\\.$`))
      expect((await releasesOf(workOrder.id)).length).toBe(before)
    } finally {
      await admin(`UPDATE "QualityHold" SET status = 'RELEASED', "releasedAt" = now(), "releasedById" = $2, "releaseSignatureSha256" = $3, "releaseNote" = 'The test is over.' WHERE id = $1`, [holdId, inspector2.id, 'f'.repeat(64)])
    }
  })

  it('the inspector who made none of the garments releases alone, with a fresh code', async () => {
    h.clock.advance(6 * 60_000)
    const noCode = await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 3 })
    expect(noCode.status).toBe(403)
    await stepped(inspector1)
    const answer = await release(inspector1, { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 3 })
    expect(answer.release.releaseNumber).toMatch(/^REL-A-\d{4}-\d{4}$/)
    expect(answer.words).toBe(`Released 3 garment(s) of BLK 50 (${answer.release.releaseNumber}): packing allowed.`)
    expect(answer.release).toMatchObject({ quantity: 3, releasedBy: { kind: 'OFFICE', userId: inspector1.id }, secondPerson: { reasons: [] }, certificates: [{ id: quality.certificateId, statusNow: 'VALID' }] })
    expect(await netReleased(cellOf('main'))).toBe(3)
    await stepped(inspector1)
    await release(inspector1, { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main', '52'), quantity: 1 })
    expect(await admin('SELECT type, payload FROM "OutboxEvent" WHERE type = $1 ORDER BY "occurredAt", id', ['quality.garments_released'])).toEqual([
      expect.objectContaining({ payload: expect.objectContaining({ quantity: 3, releaseNumber: answer.release.releaseNumber, secondPersonReasons: [], postedBy: 'OFFICE' }) }),
      expect.objectContaining({ payload: expect.objectContaining({ quantity: 1 }) }),
    ])
  })
})

// ---- four eyes as a setting (Q1 (a)) ------------------------------------------------------------------------------------------------

describe('four eyes as a setting (Owner answer Q1 (a))', () => {
  it('a listed customer needs a second person: never the inspector who signed the result, never a maker', async () => {
    const rule = await ok('rules', 'PUT', '/quality/release-rule', { companyId: A.companyA, releaseFourEyes: null, secondPersonPartyIds: [A.brand], version: 0 })
    expect(rule).toMatchObject({ loosened: false, rule: { inForce: { rule: 'WHEN_REQUIRED', source: 'DEFAULT' }, customers: [{ id: A.brand, listedOn: 'COMPANY' }], version: 1 } })
    // The company's row keeps the Cr VI evidence rule in force (the default, from no row at all).
    expect(await admin('SELECT "crViEvidenceRule"::text AS rule, "secondPersonPartyIds"::text[] AS parties FROM "QualitySettings" WHERE id = $1', [A.companyA])).toEqual([{ rule: 'SUPPLIER_REPORT_ACCEPTED', parties: [A.brand] }])
    const same = await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })
    expect(checksOf(same.body.error)).toEqual(['SECOND_PERSON'])
    expect(same.body.error.issues[0].message).toBe("You signed the result; a second person must release it: the customer's garments always need a second person.")
    expect(checksOf((await maker.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })).body.error)).toEqual(['MAKER'])
    await stepped(inspector2)
    const second = await release(inspector2, { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })
    expect(second.release.secondPerson).toEqual({ reasons: ['CUSTOMER'], words: "A second person released it: the customer's garments always need a second person." })
    expect((await releasesOf(WO.main.id)).at(-1)).toMatchObject({ releasedById: inspector2.id, reasons: ['CUSTOMER'] })
    // The database refuses the inspector alone, for every login.
    await expect(
      admin(
        `INSERT INTO "QualityRelease" (id, number, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", quantity, "certificateIds", "releasedById", "releasedAt", "signatureSha256")
         VALUES ($1, 'T-REL-' || gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, 1, ARRAY[$8]::uuid[], $9, now(), 'x')`,
        [newId(), A.tenant, A.companyA, A.siteA1, WO.main.id, cellOf('main', '52'), mainInspection.id, quality.certificateId, inspector1.id],
      ),
    ).rejects.toThrow(/needs a second person \(CUSTOMER\): the inspector who signed inspection .* does not release it alone/)

    // Taking the customer off the list loosens the rule: a reason and a fresh code.
    const put = (body: Json) => owner.browser.send('PUT' as 'POST', '/quality/release-rule', { companyId: A.companyA, releaseFourEyes: null, secondPersonPartyIds: [], version: 1, ...body })
    expect(pathsOf((await put({})).body.error)).toEqual(['body/reason'])
    h.clock.advance(6 * 60_000)
    expect((await put({ reason: 'The customer withdrew its four-eyes request (made up).' })).status).toBe(403)
    await stepped(owner)
    const loosened = await put({ reason: 'The customer withdrew its four-eyes request (made up).' })
    expect(loosened.status, JSON.stringify(loosened.body)).toBe(200)
    expect(loosened.body).toMatchObject({ loosened: true, rule: { customers: [], version: 2 } })
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'quality.release_rule_changed' ORDER BY "occurredAt", id`)).toEqual([
      { payload: expect.objectContaining({ customersAdded: [A.brand], loosened: false }) },
      { payload: expect.objectContaining({ customersRemoved: [A.brand], loosened: true }) },
    ])
    // Only customers are listed (and the database holds it too).
    expect(pathsOf(await refused('rules', 'PUT', '/quality/release-rule', { companyId: A.companyA, releaseFourEyes: 'ALWAYS', secondPersonPartyIds: [A.companyA], version: 2 }, 400))).toEqual(['body/secondPersonPartyIds'])
    await expect(admin(`UPDATE "QualitySettings" SET "secondPersonPartyIds" = ARRAY[$2]::uuid[] WHERE id = $1`, [A.companyA, A.companyA])).rejects.toThrow(/is not a customer of the tenant/)
  })

  it('an overridden inspection is released only by a second person', async () => {
    const overrideInspection = (await admin<{ id: string }>(`SELECT id::text FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'PASSED'`, [WO.override.id]))[0]!.id
    const same = await inspector1.browser.post('/quality/releases', { inspectionId: overrideInspection, workOrderSizeId: cellOf('override'), quantity: 2 })
    expect(checksOf(same.body.error)).toEqual(['SECOND_PERSON'])
    await stepped(inspector2)
    const second = await release(inspector2, { inspectionId: overrideInspection, workOrderSizeId: cellOf('override'), quantity: 2 })
    expect(second.release.secondPerson.reasons).toEqual(['OVERRIDE'])
  })

  it('the rule ALWAYS asks a second person for every release', async () => {
    await ok('rules', 'PUT', '/quality/release-rule', { companyId: A.companyA, releaseFourEyes: 'ALWAYS', secondPersonPartyIds: [], version: 2 })
    expect((await ok('viewer', 'GET', `/quality/release-rule?companyId=${A.companyA}`)).inForce).toEqual({ rule: 'ALWAYS', source: 'COMPANY', words: "Every final release needs a second person after the inspector's signature." })
    expect(checksOf((await inspector1.browser.post('/quality/releases', { inspectionId: mainInspection.id, workOrderSizeId: cellOf('main'), quantity: 1 })).body.error)).toContain('SECOND_PERSON')
    await stepped(owner)
    expect((await owner.browser.send('PUT' as 'POST', '/quality/release-rule', { companyId: A.companyA, releaseFourEyes: 'WHEN_REQUIRED', secondPersonPartyIds: [], version: 3, reason: 'Back to Q1 (a).' })).status).toBe(200)
  })
})

// ---- the floor -----------------------------------------------------------------------------------------------------------------------

describe('the bench (design floor.final)', () => {
  it('a floor inspector signs the result and releases with the PIN; a maker at the bench is refused', async () => {
    const bench = await tablet()
    await stepped(supervisor)
    const created = await supervisor.browser.post('/auth/floor/workers', { siteId: A.siteA1, displayName: 'Made-up Bench Inspector', locale: 'it', roleIds: [await roleIdOf('floor_inspector')] })
    expect(created.status, JSON.stringify(created.body)).toBe(200)
    const badge = await credentials(created.body.id, ['floor_inspector'])
    expect((await bench.post('/floor/sign-in', { badgeCode: badge, pin: PIN })).status).toBe(200)

    const final = await as(bench, 'GET', `/quality/final/work-orders/${WO.bench.id}`)
    expect(final.cells[0]).toMatchObject({ size: '50', releasable: 0, summary: 'Release · 2 checks open' })
    const opened = (await as(bench, 'POST', '/quality/inspections', { workOrderId: WO.bench.id, lotSize: 2, sampleSize: 2, ...PLAN }, 201, freshKey())).inspection
    expect(opened.inspector).toEqual({ kind: 'FLOOR', workerId: created.body.id, userId: null })
    // The bench numbers it from company A's INSPECTION series, after the office's; the ledger names the tablet, not the worker.
    expect(opened.inspectionNumber).toMatch(/^INS-A-\d{4}-\d{4}$/)
    const officeNumbers = (await admin<{ number: string }>('SELECT number FROM "Inspection" WHERE "companyId" = $1 AND number LIKE \'INS-A-%\' AND id <> $2', [A.companyA, opened.id])).map((row) => row.number)
    expect(officeNumbers.length).toBeGreaterThan(0)
    expect(officeNumbers.every((number) => number < opened.inspectionNumber)).toBe(true)
    const [benchAllocation] = await admin<{ allocatedById: string }>('SELECT "allocatedById"::text AS "allocatedById" FROM "NumberAllocation" WHERE "recordId" = $1', [opened.id])
    expect(benchAllocation!.allocatedById).not.toBe(created.body.id)
    expect(await admin('SELECT 1 FROM "Device" WHERE id = $1', [benchAllocation!.allocatedById])).toHaveLength(1)
    // The PIN proved at sign-in opens signing for 2 minutes; later the bench asks it again.
    h.clock.advance(3 * 60_000)
    const late = await bench.send('POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: allOk() }, { headers: { 'idempotency-key': freshKey() } })
    expect(late.status).toBe(403)
    expect(late.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    expect((await bench.post('/floor/step-up', { pin: PIN })).status).toBe(200)
    const decided = (await as(bench, 'POST', `/quality/inspections/${opened.id}/decide`, { version: opened.version, result: 'PASS', checklist: allOk() }, 200, freshKey())).inspection
    expect(decided).toMatchObject({ status: 'PASSED', inspector: { kind: 'FLOOR' } })
    const released = await as(bench, 'POST', '/quality/releases', { inspectionId: opened.id, workOrderSizeId: cellOf('bench'), quantity: 2 }, 201, freshKey())
    expect(released.release).toMatchObject({ quantity: 2, releasedBy: { kind: 'FLOOR', workerId: created.body.id, userId: null }, secondPerson: { reasons: [] } })
    // A release number taken at the bench, from the office's RELEASE series.
    expect(released.release.releaseNumber).toMatch(/^REL-A-\d{4}-\d{4}$/)
    expect(await admin('SELECT kind::text AS kind, "allocatedById"::text AS "by" FROM "NumberAllocation" WHERE "recordId" = $1', [released.release.id])).toEqual([{ kind: 'RELEASE', by: benchAllocation!.allocatedById }])
    expect(await releasesOf(WO.bench.id)).toEqual([expect.objectContaining({ releasedById: null, releasedByWorkerId: created.body.id, reasons: [] })])
    // The bench never reverses (an office act).
    expect((await bench.post(`/quality/releases/${released.release.id}/reverse`, { quantity: 1, reasonCode: 'DEFECT_FOUND_LATER', reason: 'Seam opened' }, { headers: { 'idempotency-key': freshKey() } })).status).toBe(403)

    // The seeded operator, who cut and reported the garments, as a floor inspector at another bench: refused.
    const other = await tablet()
    const operatorBadge = await credentials(A.operatorA1, ['operator', 'floor_inspector'])
    expect((await other.post('/floor/sign-in', { badgeCode: operatorBadge, pin: PIN })).status).toBe(200)
    const makerOpens = await other.send('POST', '/quality/inspections', { workOrderId: WO.bench.id, lotSize: 1, sampleSize: 1, ...PLAN }, { headers: { 'idempotency-key': freshKey() } })
    expect(makerOpens.status, JSON.stringify(makerOpens.body)).toBe(409)
    expect(makerOpens.body.error.issues[0].path).toBe('maker')
  })
})

describe('the bench\'s work orders (design floor.final "scan")', () => {
  it('lists what the site can inspect or release, finds a traveller by its number, and keeps to the site and company', async () => {
    const openOf = async (workOrderId: string) => (await admin<{ id: string }>('SELECT id::text FROM "Inspection" WHERE "workOrderId" = $1 AND status = \'OPEN\' ORDER BY "createdAt" DESC LIMIT 1', [workOrderId]))[0]?.id ?? null
    // An OPEN inspection the bench continues.
    const opened = (await as(inspector2.browser, 'POST', '/quality/inspections', { workOrderId: WO.lot.id, lotSize: 1, sampleSize: 1, ...PLAN }, 201)).inspection
    const listed = (await ok('qc', 'GET', '/quality/final/work-orders')).workOrders as Json[]
    expect(listed.length).toBeGreaterThan(0)
    for (const row of listed) {
      expect(row).toMatchObject({ siteId: A.siteA1, ready: true, style: { code: expect.any(String) } })
      expect(row.finished).toBeGreaterThan(row.released)
      expect(['RELEASED', 'IN_PROGRESS', 'COMPLETED']).toContain(row.status)
      expect(row.openInspectionId).toBe(await openOf(row.id))
    }
    expect(listed.find((row) => row.id === WO.lot.id)?.openInspectionId).toBe(opened.id)
    // Released in full: not on the list any more (the bench released WO.bench above).
    expect(listed.map((row) => row.id)).not.toContain(WO.bench.id)
    // No money and no person anywhere.
    expect(keysOf(listed).filter((key) => MONEY.test(key) || /worker|user|inspector|name$/i.test(key) && key !== 'name')).toEqual([])

    // A scanned number: that work order, whatever its state (the bench says why it is not ready).
    const scanned = (await ok('qc', 'GET', `/quality/final/work-orders?number=${encodeURIComponent(WO.bench.number)}`)).workOrders as Json[]
    expect(scanned).toEqual([expect.objectContaining({ id: WO.bench.id, number: WO.bench.number, ready: false, finished: 2, released: 2, pieces: 2 })])
    expect((await ok('qc', 'GET', '/quality/final/work-orders?number=NO-SUCH-WO')).workOrders).toEqual([])

    // The office sees its companies' rows; another company, another site's tablet, another tenant: nothing.
    expect(((await ok('viewer', 'GET', '/quality/final/work-orders')).workOrders as Json[]).map((row) => row.id)).toEqual(listed.map((row) => row.id))
    expect((await ok('companyB', 'GET', `/quality/final/work-orders?number=${encodeURIComponent(WO.main.number)}`)).workOrders).toEqual([])
    SESSIONS.elsewhere = { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: newId(), deviceId: A.qc, grants: [{ permissions: FLOOR, companies: [A.companyA], sites: 'all', parties: 'all' }] }
    expect((await ok('elsewhere', 'GET', `/quality/final/work-orders?number=${encodeURIComponent(WO.main.number)}`)).workOrders).toEqual([])
    expect((await ok('otherTenant', 'GET', '/quality/final/work-orders')).workOrders).toEqual([])
    // Without quality.inspections.view: refused.
    SESSIONS.noQuality = { ...floor(A.qc), grants: [{ permissions: ['floor.work', 'production.scan'], companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] }
    expect((await call('noQuality', 'GET', '/quality/final/work-orders')).statusCode).toBe(403)
    await as(inspector2.browser, 'POST', `/quality/inspections/${opened.id}/cancel`, { version: opened.version, reason: 'Opened for the bench list test' })
  })
})

// ---- the reversal -----------------------------------------------------------------------------------------------------------------------

describe('the reversal (Reg. 2016/425 art. 8(8))', () => {
  it('takes released garments back before they ship: on hold, a PPE register entry, released = releases − reversals', async () => {
    const [first] = await releasesOf(WO.main.id)
    const preview = await ok('viewer', 'GET', `/quality/releases/${first!.id}`)
    expect(preview.reverseImpact).toMatchObject({ reversible: 3, shipped: 0 })
    expect(pathsOf(await refused('reverser', 'POST', `/quality/releases/${first!.id}/reverse`, { quantity: 1, reasonCode: 'DEFECT_FOUND_LATER', reason: 'no' }, 400))).toEqual(['body/reason'])
    await refused('reverser', 'POST', `/quality/releases/${first!.id}/reverse`, { quantity: 4, reasonCode: 'DEFECT_FOUND_LATER', reason: 'A seam opened after release (made up).' }, 409)
    const reversed = await ok('reverser', 'POST', `/quality/releases/${first!.id}/reverse`, { quantity: 1, reasonCode: 'DEFECT_FOUND_LATER', reason: 'A seam opened after release (made up).' }, 201)
    expect(reversed.register).toMatchObject({ opened: true, reference: expect.stringMatching(/^REG-\d{4}-\d{4}$/) })
    expect(reversed.release).toMatchObject({ reversed: 1, onHold: 1, reversals: [{ quantity: 1, reasonCode: 'DEFECT_FOUND_LATER', onHold: true }] })
    // 3 + 1 released, 1 taken back.
    expect(await netReleased(cellOf('main'))).toBe(3)
    expect((await as(inspector1.browser, 'GET', `/quality/final/work-orders/${WO.main.id}`)).cells[0].released).toBe(3)
    expect(await admin(`SELECT kind::text, "sourceType", "workOrderIds"::text[] AS wos FROM "PpeRegisterEntry" WHERE "sourceId" = $1`, [reversed.reversalId])).toEqual([{ kind: 'NON_CONFORMITY', sourceType: 'QualityReleaseReversal', wos: [WO.main.id] }])
    expect(await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'quality.release_reversed'`)).toEqual([{ payload: expect.objectContaining({ quantity: 1, reasonCode: 'DEFECT_FOUND_LATER', registerEntryId: reversed.register.entryId }) }])
    // A reversal without its kind is refused by the database too.
    await expect(
      admin(`INSERT INTO "QualityReleaseReversal" (id, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "releaseId", quantity, reason, "reversedById", "reversedAt") VALUES ($1, $2, $3, $4, $5, $6, $7, 1, 'x', $8, now())`, [
        newId(),
        A.tenant,
        A.companyA,
        A.siteA1,
        WO.main.id,
        cellOf('main'),
        first!.id,
        newId(),
      ]),
    ).rejects.toThrow(/says why as a kind too/)
  })

  it('a serial-tracked release names its serials, which go to rework or scrap', async () => {
    const [, second] = quality.serialReleaseIds
    const [, , third] = quality.serialIds
    expect(pathsOf(await refused('reverser', 'POST', `/quality/releases/${second}/reverse`, { quantity: 1, reasonCode: 'RECALL', reason: 'Armour pocket torn (made up).' }, 400))).toEqual(['body/serialIds', 'body/serialsTo'])
    const reversed = await ok('reverser', 'POST', `/quality/releases/${second}/reverse`, { quantity: 1, serialIds: [third], serialsTo: 'VOID', reasonCode: 'RECALL', reason: 'Armour pocket torn (made up).' }, 201)
    expect(await admin('SELECT status::text, "voidReason" FROM "GarmentSerial" WHERE id = $1', [third])).toEqual([{ status: 'VOID', voidReason: 'Release reversed: Armour pocket torn (made up).' }])
    const text = (await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE id = $1', [third]))[0]!.serial
    expect(await admin(`SELECT kind::text, serials FROM "PpeRegisterEntry" WHERE "sourceId" = $1`, [reversed.reversalId])).toEqual([{ kind: 'RECALL', serials: [text] }])
  })
})

// ---- goods on hold (Q3 (a)) -----------------------------------------------------------------------------------------------------------

describe('goods on hold are reached from the lists (Owner answer Q3 (a))', () => {
  it('Inspections, the reversed-release view and Lots & traceability each filter what is on hold', async () => {
    const held = (await ok('viewer', 'GET', `/quality/inspections?onHold=true&companyId=${A.companyA}`)).inspections as Json[]
    // The FAILED inspection; main and SEED-WO-0003, whose released garments were taken back; SEED-WO-0001, the seed's reversal.
    expect(held.map((row) => row.workOrderId).sort()).toEqual([WO.failed.id, WO.main.id, quality.serialWorkOrderId, quality.production.workOrderId].sort())
    expect(held.find((row) => row.workOrderId === WO.failed.id)).toMatchObject({ status: 'FAILED', holdWords: 'FAILED: its garments are on hold until they are reworked and pass a new inspection.' })
    const waiting = (await ok('viewer', 'GET', '/quality/inspections?waitingRelease=true')).inspections as Json[]
    expect(waiting.map((row) => row.workOrderId)).toEqual(expect.arrayContaining([WO.lot.id]))
    const reversed = (await ok('viewer', 'GET', '/quality/releases?reversed=true')).releases as Json[]
    expect(reversed.map((row) => row.workOrderId).sort()).toEqual(expect.arrayContaining([WO.main.id, quality.serialWorkOrderId]))
    expect(((await ok('viewer', 'GET', '/quality/releases?onHold=true')).releases as Json[]).every((row) => row.onHold > 0)).toBe(true)
    const lotsOnHold = (await ok('viewer', 'GET', '/quality/lots?onHold=true')).lots as Json[]
    expect(lotsOnHold.map((row) => row.code)).toContain(`T-${run}-HOLD`)
    expect(lotsOnHold.map((row) => row.code)).not.toContain(`T-${run}-BIG`)
    // Another company's viewer sees none of them.
    expect((await ok('companyB', 'GET', '/quality/inspections?onHold=true')).inspections).toEqual([])
    expect((await ok('companyB', 'GET', '/quality/lots?onHold=true')).lots).toEqual([])
  })
})

// ---- the evidence trail (Q2 (a)) ----------------------------------------------------------------------------------------------------------

describe('the evidence trail (Owner answer Q2 (a))', () => {
  it('gathers every proof of a batch, money only with its grain, within the walls', async () => {
    const trail = await ok('viewer', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`)
    expect(trail.subject).toMatchObject({ kind: 'BATCH', batchNumber: WO.main.batchNumber, workOrder: { id: WO.main.id } })
    expect(trail.style).toMatchObject({ id: A.style, tracking: 'BATCH' })
    expect(trail.documents.map((document: Json) => `${document.kind}:${document.language}`).sort()).toEqual(['DECLARATION_OF_CONFORMITY:en', 'DECLARATION_OF_CONFORMITY:it', 'USER_INFORMATION:en', 'USER_INFORMATION:it'])
    expect(trail.certificates.today.map((entry: Json) => entry.words)).toEqual([expect.stringMatching(/^Covered: certificate /), expect.stringMatching(/^Covered: certificate /)])
    expect(trail.lots.map((lot: Json) => lot.code)).toEqual([`T-${run}-BIG`])
    expect(trail.cutting[0]).toMatchObject({ hideCode: hides.H01, worker: expect.any(String) })
    expect(trail.bundles.length).toBe(2)
    expect(trail.scans.length).toBe(8)
    expect(trail.scans[0]).toMatchObject({ operation: { seq: 10 }, kind: 'REPORT', worker: expect.any(String) })
    expect(trail.inspections).toEqual([expect.objectContaining({ id: mainInspection.id, status: 'PASSED', defects: [expect.objectContaining({ code: 'LOOSE-THREAD' })] })])
    expect(trail.releases.map((row: Json) => row.secondPerson.reasons)).toEqual(expect.arrayContaining([[], ['CUSTOMER']]))
    expect(trail.releases.some((row: Json) => row.reversals.length === 1)).toBe(true)
    expect(trail.labelPrints.map((row: Json) => row.quantity).sort()).toEqual([1, 4])
    expect(trail.registerEntries).toEqual([expect.objectContaining({ kind: 'NON_CONFORMITY', status: 'OPEN' })])
    // Money: the value issued per lot only with the cost grain.
    expect(keysOf(trail).filter((key) => MONEY.test(key))).toEqual([])
    const withCost = await ok('costViewer', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`)
    expect(Object.keys(withCost.lots[0])).toContain('issuedCostMinor')
    // The walls: another company, another customer's person, another tenant find nothing; the floor reads no trail.
    await refused('companyB', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`, undefined, 404)
    await refused('otherParty', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`, undefined, 404)
    await refused('otherTenant', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`, undefined, 404)
    await refused('pack', 'GET', `/quality/evidence?batch=${WO.main.batchNumber}`, undefined, 403)
    expect(pathsOf(await refused('viewer', 'GET', `/quality/evidence?batch=x&serial=SN-x`, undefined, 400))).toEqual(['querystring/serial'])
  })

  it('a serial: its own release and reversal, its bundle', async () => {
    const [, , third] = quality.serialIds
    const serial = (await admin<{ serial: string }>('SELECT serial FROM "GarmentSerial" WHERE id = $1', [third]))[0]!.serial
    const trail = await ok('viewer', 'GET', `/quality/evidence?serial=${encodeURIComponent(serial)}`)
    expect(trail.subject).toMatchObject({ kind: 'SERIAL', serial: { id: third, status: 'VOID', releaseId: quality.serialReleaseIds[1] } })
    expect(trail.releases).toEqual([expect.objectContaining({ id: quality.serialReleaseIds[1], reversals: [expect.objectContaining({ serialsTo: 'VOID', reasonCode: 'RECALL' })] })])
    expect(trail.registerEntries.map((entry: Json) => entry.kind)).toContain('RECALL')
  })
})

// ---- the database's own rules (…_quality_final_release_guards) ------------------------------------------------------------------

describe('the database holds the rules too, for every login', () => {
  it('writes the computed result; an override carries its reason, never over a critical defect; one releaser', async () => {
    const insertInspection = async (acceptMajor: number) => {
      const id = newId()
      await admin(
        `INSERT INTO "Inspection" (id, number, "tenantId", "companyId", "siteId", "workOrderId", "lotSize", "sampleSize", "inspectionLevel", "aqlMajor", "aqlMinor", "acceptMajor", "acceptMinor", "inspectorUserId")
         VALUES ($1, 'T-INS-' || gen_random_uuid()::text, $2, $3, $4, $5, 2, 2, 'II', 2.5, 4.0, $6, 0, $7)`,
        [id, A.tenant, A.companyA, A.siteA1, WO.bench.id, acceptMajor, inspector2.id],
      )
      return id
    }
    const decide = (id: string, status: string, reason: string | null) =>
      admin(`UPDATE "Inspection" SET status = $2::"InspectionStatus", "decidedAt" = now(), "signatureSha256" = 'x', checklist = $3::jsonb, "overrideReason" = $4 WHERE id = $1`, [id, status, JSON.stringify(allOk()), reason])
    // Written while OPEN: refused.
    const open = await insertInspection(0)
    await expect(admin(`UPDATE "Inspection" SET "computedResult" = 'PASS' WHERE id = $1`, [open])).rejects.toThrow(/only a decided inspection has a computed result or an override reason/)
    // One major defect, the plan accepts none: a PASS only as an override with its reason; the database writes FAIL.
    await admin(`INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, quantity) VALUES ($1, $2, $3, $4, $5, 'MAJOR', 'SEAM-OPEN', 1)`, [newId(), A.tenant, A.siteA1, WO.bench.id, open])
    await expect(decide(open, 'PASSED', null)).rejects.toThrow(/its plan accepts 0 and 0, so it FAILS \(a PASS over it is an override with the inspector's written reason, QHS-013\)/)
    await decide(open, 'PASSED', 'Accepted by the customer in writing (made up).')
    expect(await admin('SELECT "computedResult"::text AS computed FROM "Inspection" WHERE id = $1', [open])).toEqual([{ computed: 'FAIL' }])
    // No defect: a FAIL is an override too; a decision as computed carries no reason.
    const clean = await insertInspection(0)
    await expect(decide(clean, 'FAILED', null)).rejects.toThrow(/decided FAILED against its computed result PASS; an override carries the inspector's written reason/)
    await expect(decide(clean, 'PASSED', 'Looks fine')).rejects.toThrow(/decided PASSED as computed; it has no override reason/)
    await decide(clean, 'PASSED', null)
    // A critical defect never PASSES, whatever the reason.
    const critical = await insertInspection(1)
    await admin(`INSERT INTO "InspectionDefect" (id, "tenantId", "siteId", "workOrderId", "inspectionId", "defectClass", code, quantity) VALUES ($1, $2, $3, $4, $5, 'CRITICAL', 'CE-MISSING', 1)`, [newId(), A.tenant, A.siteA1, WO.bench.id, critical])
    await expect(decide(critical, 'PASSED', 'We need them shipped.')).rejects.toThrow(/a critical defect is never accepted, it FAILS/)
    // A release names exactly one releaser.
    const row = (releasedById: string | null, releasedByWorkerId: string | null) =>
      admin(
        `INSERT INTO "QualityRelease" (id, number, "tenantId", "companyId", "siteId", "workOrderId", "workOrderSizeId", "inspectionId", quantity, "certificateIds", "releasedById", "releasedByWorkerId", "releasedAt", "signatureSha256")
         VALUES ($1, 'T-REL-' || gen_random_uuid()::text, $2, $3, $4, $5, $6, $7, 1, ARRAY[$8]::uuid[], $9, $10, now(), 'x')`,
        [newId(), A.tenant, A.companyA, A.siteA1, WO.bench.id, cellOf('bench'), clean, quality.certificateId, releasedById, releasedByWorkerId],
      )
    await expect(row(null, null)).rejects.toThrow(/names exactly one releaser/)
    await expect(row(inspector1.id, A.operatorA1)).rejects.toThrow(/names exactly one releaser/)
  })
})

// ---- B-W2a-75: Hold lot at the bench ------------------------------------------------------------------------------------------------

describe('Hold lot at the bench (design floor.final "Hold lot": a reason, and an NCR)', () => {
  it('holds the work order with a HOLD reason and raises the NCR that decides it, in one command, once; the bench sees it; the placer never releases it', async () => {
    const workOrderId = WO.failed.id
    const RECORD: Permission[] = [...FLOOR, 'quality.inspections.record']
    SESSIONS.benchHold = { ...floor(A.qc), grants: [{ permissions: RECORD, companies: [A.companyA], sites: [A.siteA1], parties: 'all' }] }
    SESSIONS.benchView = floor(A.qc)
    SESSIONS.benchElsewhere = { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: newId(), deviceId: A.qc, grants: [{ permissions: RECORD, companies: [A.companyA], sites: 'all', parties: 'all' }] }
    SESSIONS.officeRecorder = office(A.tenant, [grant(['quality.inspections.view', 'quality.inspections.record', 'quality.holds.place'])])
    const url = `/quality/final/work-orders/${workOrderId}/hold`
    expect((await ok('benchHold', 'GET', `/quality/final/work-orders/${workOrderId}`)).holds).toEqual([])

    // Refused before anything is written: no key, an unknown reason, OTHER without its note, an inspection of another work order.
    const unkeyed = await call('benchHold', 'POST', url, { reasonCode: 'QUALITY_CHECK', quantity: 2 })
    expect(unkeyed.statusCode, unkeyed.body).toBe(400)
    expect(pathsOf(await refused('benchHold', 'POST', url, { reasonCode: 'NO_SUCH_REASON', quantity: 2 }, 400))).toEqual(['body/reasonCode'])
    expect(pathsOf(await refused('benchHold', 'POST', url, { reasonCode: 'OTHER', quantity: 2 }, 400))).toEqual(['body/reasonNote'])
    const otherInspection = (await admin<{ id: string }>('SELECT id::text FROM "Inspection" WHERE "workOrderId" = $1 LIMIT 1', [WO.bench.id]))[0]!.id
    await refused('benchHold', 'POST', url, { reasonCode: 'QUALITY_CHECK', quantity: 2, inspectionId: otherInspection }, 404)
    // Not the bench's: the office (its own Holds page), a tablet without the right, another site's tablet.
    await refused('officeRecorder', 'POST', url, { reasonCode: 'QUALITY_CHECK', quantity: 2 }, 403)
    await refused('benchView', 'POST', url, { reasonCode: 'QUALITY_CHECK', quantity: 2 }, 403)
    await refused('benchElsewhere', 'POST', url, { reasonCode: 'QUALITY_CHECK', quantity: 2 }, 404)
    expect(await admin('SELECT 1 FROM "QualityHold" WHERE $1::uuid = ANY("subjectIds")', [workOrderId])).toEqual([])

    const before = (await admin<{ status: string }>('SELECT status::text AS status FROM "WorkOrder" WHERE id = $1', [workOrderId]))[0]!.status
    const key = freshKey()
    const first = await call('benchHold', 'POST', url, { reasonCode: 'QUALITY_CHECK', reasonNote: 'Seams look loose on two jackets', quantity: 2 }, key)
    expect(first.statusCode, first.body).toBe(201)
    const held = first.json()
    expect(held).toMatchObject({
      hold: { reasonCode: 'QUALITY_CHECK', reasonEn: 'Quality check', reasonIt: 'Verifica qualità', reasonNote: 'Seams look loose on two jackets', placedBy: 'WORKER', ncrNumber: held.ncr.number },
      workOrderHeld: before !== 'COMPLETED',
      replayed: false,
    })
    expect(held.ncr.number).toMatch(/^NCR-/)
    // A resend with the same key answers the same hold and NCR: nothing twice.
    const again = await call('benchHold', 'POST', url, { reasonCode: 'QUALITY_CHECK', reasonNote: 'Seams look loose on two jackets', quantity: 2 }, key)
    expect(again.statusCode, again.body).toBe(201)
    expect(again.json()).toMatchObject({ hold: { id: held.hold.id }, ncr: held.ncr, replayed: true })
    expect(await admin('SELECT id::text FROM "QualityHold" WHERE $1::uuid = ANY("subjectIds")', [workOrderId])).toEqual([{ id: held.hold.id }])

    // The hold: placed by the worker (never an office user), from the bench, decided by the NCR.
    expect(await admin('SELECT "placedById"::text AS "user", "placedByWorkerId"::text AS worker, "ncrId"::text AS ncr, "subjectType"::text AS type, status::text AS status FROM "QualityHold" WHERE id = $1', [held.hold.id])).toEqual([
      { user: null, worker: A.operatorA1, ncr: held.ncr.id, type: 'WorkOrder', status: 'ACTIVE' },
    ])
    expect(await admin('SELECT status::text AS status FROM "WorkOrder" WHERE id = $1', [workOrderId])).toEqual([{ status: before === 'COMPLETED' ? 'COMPLETED' : 'ON_HOLD' }])
    // The NCR: found at the final inspection by the worker, MAJOR, the garments held; its first containment is the hold, done.
    expect(
      await admin(
        'SELECT source::text AS source, "foundAt"::text AS "foundAt", severity::text AS severity, "quantityAffected"::text AS quantity, uom::text AS uom, "foundById"::text AS "foundBy", "foundByWorkerId"::text AS worker, "createdById"::text AS "createdBy", "workOrderId"::text AS wo FROM "Nonconformance" WHERE id = $1',
        [held.ncr.id],
      ),
    ).toEqual([{ source: 'INSPECTION', foundAt: 'FINAL', severity: 'MAJOR', quantity: '2.0000', uom: 'PCS', foundBy: null, worker: A.operatorA1, createdBy: null, wo: workOrderId }])
    expect(await admin('SELECT kind::text AS kind, status::text AS status, "recordId"::text AS hold FROM "NcrContainmentAction" WHERE "ncrId" = $1', [held.ncr.id])).toEqual([{ kind: 'HOLD_STOCK', status: 'DONE', hold: held.hold.id }])
    // The ledger names the tablet and the worker.
    const audit = await admin<{ after: Json }>('SELECT after FROM "AuditLog" WHERE action = \'quality.benchHold\' AND "recordId" = $1', [held.hold.id])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ workOrderId, ncrId: held.ncr.id, deviceId: A.qc, workerId: A.operatorA1 })

    // The bench and the office see the hold on the work order's final state; a release waits for quality, in words.
    const bench = await ok('benchView', 'GET', `/quality/final/work-orders/${workOrderId}`)
    expect(bench.holds).toEqual([expect.objectContaining({ id: held.hold.id, reasonCode: 'QUALITY_CHECK', placedBy: 'WORKER', ncrNumber: held.ncr.number })])
    expect((await ok('viewer', 'GET', `/quality/final/work-orders/${workOrderId}`)).holds.map((hold: Json) => hold.id)).toEqual([held.hold.id])
    expect(keysOf(bench.holds).filter((name) => MONEY.test(name) || /worker|user|name$/i.test(name))).toEqual([])
    // The worker who placed it (the maker's office user is linked to them) never releases it.
    const detail = await as(maker.browser, 'GET', `/quality/holds/${held.hold.id}`)
    expect(detail.release.checks).toContainEqual(expect.objectContaining({ key: 'NOT_PLACER', ok: false }))
    expect(detail.release.releasable).toBe(false)
  })
})

// ---- B-W2a-67: assigning an inspector, defects from the library, failed - not decided ---------------------------------------------

describe('inspections every day (B-W2a-67; design qi-assign, ins-defects, qi-metrics)', () => {
  it('the office assigns an open inspection to an inspector who made none of the garments; the assignee records and signs it', async () => {
    // The picker: the office people who record inspections at the site, each with the work orders they made.
    const picker = await as(inspector1.browser, 'GET', `/quality/inspections/inspectors?siteId=${A.siteA1}&workOrderIds=${WO.override.id}`)
    const byId = new Map((picker.inspectors as Json[]).map((entry) => [entry.id, entry]))
    expect(byId.get(inspector1.id)).toMatchObject({ kind: 'USER', me: true, made: [] })
    expect(byId.get(inspector2.id)).toMatchObject({ kind: 'USER', me: false, made: [] })
    expect(byId.get(maker.id)).toMatchObject({ kind: 'USER', made: [WO.override.number] })
    expect(picker.inspectors[0].id).toBe(inspector1.id)
    expect(picker.floorListed).toBe(false)
    await as(supervisor.browser, 'GET', `/quality/inspections/inspectors?siteId=${A.siteA1}`, undefined, 403)

    const opened = (await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.override.id, lotSize: 1, sampleSize: 1, ...PLAN }, 201)).inspection
    expect(opened.assigned).toBeNull()
    // A maker is refused in words; nothing is assigned.
    const toMaker = await inspector1.browser.post('/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version }], assigneeId: maker.id })
    expect(toMaker.status, JSON.stringify(toMaker.body)).toBe(409)
    expect(toMaker.body.error.issues).toEqual([{ path: 'inspections/0', message: expect.stringMatching(/Made garments of work order .*another inspector, who made none of them, inspects it\.$/) }])
    // A decided inspection is never assigned; a stale version is a conflict.
    const decided = await inspector1.browser.post('/quality/inspections/assign', { inspections: [{ id: mainInspection.id, version: mainInspection.version }], assigneeId: inspector2.id })
    expect(decided.status).toBe(409)
    expect(decided.body.error.issues[0]).toMatchObject({ path: 'inspections/0', message: expect.stringMatching(/is passed: only an open inspection is assigned\.$/) })
    expect((await inspector1.browser.post('/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version + 5 }], assigneeId: inspector2.id })).status).toBe(409)

    const assigned = await as(inspector1.browser, 'POST', '/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version }], assigneeId: inspector2.id })
    expect(assigned.inspections).toEqual([{ id: opened.id, version: opened.version + 1, assigned: { kind: 'USER', userId: inspector2.id, workerId: null, name: 'inspector two' } }])
    // The same assignee again changes nothing: the answer as it stands, no write, no second event (a no-op is no command).
    expect((await as(inspector1.browser, 'POST', '/quality/inspections/assign', { inspections: [{ id: opened.id, version: opened.version + 1 }], assigneeId: inspector2.id })).inspections[0]).toMatchObject({ version: opened.version + 1 })
    expect(await admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['quality.inspection_assigned', opened.id])).toEqual([{ payload: { inspectionId: opened.id, workOrderId: WO.override.id, number: WO.override.number, assigned: true } }])
    expect(await admin('SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action = $2', [opened.id, 'quality.inspection.assign'])).toHaveLength(1)
    // The opener no longer records it; the assignee does, and becomes its inspector.
    expect((await as(inspector1.browser, 'GET', `/quality/inspections/${opened.id}`)).yours).toBe(false)
    expect((await inspector1.browser.send('PATCH' as 'POST', `/quality/inspections/${opened.id}`, { version: opened.version + 1, checklist: [{ code: 'CE_MARK', ok: true }] })).status).toBe(403)
    const recorded = (await as(inspector2.browser, 'PATCH', `/quality/inspections/${opened.id}`, { version: opened.version + 1, checklist: [{ code: 'CE_MARK', ok: true }] })).inspection
    expect(recorded).toMatchObject({ inspector: { kind: 'OFFICE', userId: inspector2.id }, assigned: { userId: inspector2.id } })
    // The list names the office assignee; `assigned=me` keeps the caller's.
    const mine = (await as(inspector2.browser, 'GET', '/quality/inspections?assigned=me')).inspections as Json[]
    expect(mine.map((row) => row.id)).toContain(opened.id)
    expect(mine.find((row) => row.id === opened.id)).toMatchObject({ assigned: { kind: 'USER', name: 'inspector two' }, version: recorded.version })
    expect(((await as(inspector1.browser, 'GET', '/quality/inspections?assigned=me')).inspections as Json[]).map((row) => row.id)).not.toContain(opened.id)
    // Cleared: open to whoever opened it again (it is inspector two's now, who recorded it).
    const cleared = await as(inspector1.browser, 'POST', '/quality/inspections/assign', { inspections: [{ id: opened.id, version: recorded.version }], assigneeId: null })
    expect(cleared.inspections[0].assigned).toBeNull()
    expect((await as(inspector2.browser, 'GET', `/quality/inspections/${opened.id}`)).yours).toBe(true)
    // At opening: the office may assign it at once (never to a maker).
    const atOnce = (await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.override.id, lotSize: 1, sampleSize: 1, ...PLAN, assigneeId: inspector2.id }, 201)).inspection
    expect(atOnce.assigned).toMatchObject({ kind: 'USER', userId: inspector2.id })
    expect((await inspector1.browser.post('/quality/inspections', { workOrderId: WO.override.id, lotSize: 1, sampleSize: 1, ...PLAN, assigneeId: maker.id })).status).toBe(409)
    // The floor never assigns (an office route).
    expect((await call('qc', 'POST', '/quality/inspections/assign', { inspections: [{ id: atOnce.id, version: atOnce.version }], assigneeId: null }, freshKey())).statusCode).toBe(403)
  })

  it('a defect picked from the library carries its code and garment zone; a category, a wrong code or zone are refused', async () => {
    const category = (await ok('library', 'POST', '/quality/defects', { code: 'SEAM', labelIt: 'Cuciture', labelEn: 'Seams' }, 201)).defect
    const defect = (await ok('library', 'POST', '/quality/defects', { code: 'STITCH-SKIP', parentId: category.id, labelIt: 'Punto saltato', labelEn: 'Skipped stitch', severity: 'MINOR', zone: 'SLEEVE_L' }, 201)).defect
    const opened = (await as(inspector1.browser, 'POST', '/quality/inspections', { workOrderId: WO.override.id, lotSize: 2, sampleSize: 2, ...PLAN }, 201)).inspection
    const put = (defects: Json[]) => inspector1.browser.send('PUT' as 'POST', `/quality/inspections/${opened.id}/defects`, { version: opened.version, defects })
    expect(pathsOf((await put([{ defectClass: 'MINOR', code: 'SEAM', quantity: 1, defectCodeId: category.id }])).body.error)).toEqual(['body/defects/0/defectCodeId'])
    expect(pathsOf((await put([{ defectClass: 'MINOR', code: 'STITCH-OTHER', quantity: 1, defectCodeId: defect.id }])).body.error)).toEqual(['body/defects/0/code'])
    expect(pathsOf((await put([{ defectClass: 'MINOR', code: 'STITCH-SKIP', quantity: 1, defectCodeId: defect.id, zone: 'NOSE' }])).body.error)).toEqual(['body/defects/0/zone'])
    const recorded = (await as(inspector1.browser, 'PUT', `/quality/inspections/${opened.id}/defects`, { version: opened.version, defects: [{ defectClass: 'MINOR', code: 'STITCH-SKIP', quantity: 1, defectCodeId: defect.id, zone: 'SLEEVE_R', workOrderSizeId: cellOf('override') }] })).inspection
    expect(recorded.defects).toEqual([expect.objectContaining({ code: 'STITCH-SKIP', defectCodeId: defect.id, zone: 'SLEEVE_R', quantity: 1 })])
    // A retired defect stays on the line that names it, and leaves the pickers.
    await ok('library', 'PATCH', `/quality/defects/${defect.id}`, { version: defect.version, active: false })
    const kept = (await as(inspector1.browser, 'PUT', `/quality/inspections/${opened.id}/defects`, { version: recorded.version, defects: [{ defectClass: 'MINOR', code: 'STITCH-SKIP', quantity: 2, defectCodeId: defect.id, zone: 'SLEEVE_R' }] })).inspection
    expect(kept.defects[0]).toMatchObject({ quantity: 2, defectCodeId: defect.id })
    expect(pathsOf((await inspector1.browser.send('PUT' as 'POST', `/quality/inspections/${opened.id}/defects`, { version: kept.version, defects: [{ defectClass: 'MAJOR', code: 'STITCH-SKIP', quantity: 1, defectCodeId: defect.id }] })).body.error)).toEqual(['body/defects/0/defectCodeId'])
  })

  it('"Failed - not decided": a failed inspection without a hold or an NCR from it, until someone decides', async () => {
    const failed = (await admin<{ id: string }>(`SELECT id::text FROM "Inspection" WHERE "workOrderId" = $1 AND status = 'FAILED'`, [WO.failed.id]))[0]!.id
    const undecided = (await ok('viewer', 'GET', '/quality/inspections?failedUndecided=true')).inspections as Json[]
    expect(undecided.find((row) => row.id === failed)).toMatchObject({ status: 'FAILED', undecided: true, holds: 0, ncrs: 0, onHold: true })
    expect(undecided.every((row) => row.status === 'FAILED' && row.undecided)).toBe(true)
    // A hold placed from it decides it for this tile.
    await seedReasons({ db: h.database, namespace: ns.a })
    await ok('holder', 'POST', '/quality/holds', { subjectType: 'WorkOrder', subjectIds: [WO.failed.id], reasonCode: 'QUALITY_CHECK', sourceType: 'Inspection', sourceId: failed }, 201)
    expect(((await ok('viewer', 'GET', '/quality/inspections?failedUndecided=true')).inspections as Json[]).map((row) => row.id)).not.toContain(failed)
    const row = ((await ok('viewer', 'GET', `/quality/inspections?workOrderId=${WO.failed.id}`)).inspections as Json[]).find((entry) => entry.id === failed)
    expect(row).toMatchObject({ holds: 1, undecided: false })
  })
})
