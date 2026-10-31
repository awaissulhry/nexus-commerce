import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { hashPin, pinKeyring } from '@nexus/factory-domain/auth/floor/pin'
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
import { LOCAL_COOKIE_SECRET, LOCAL_PIN_PEPPER } from '../../../env'
import { createOfficeAuth } from '../../../platform/auth/sessions/office-auth'

/**
 * Checks before a scan counts (B-W2b-46; MES-070, MES-097, MES-098, MES-114; design floor.operation "Checks before it
 * counts", "Scan what you used", pop-up "Team leader override") on the local stack with the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and the scan
 * trigger are real), the factory-db seeds up to production (plant A1 names workers; its operator acknowledged the
 * notice; its team leader holds the seeded team_leader floor role), a made-up second line L2 with a sewing station
 * SEW-03, made-up tablets, made-up lots of the seed's shoulder protector, and made-up PINs for the operator and the team
 * leader. Released work orders of black jackets in size 50 are made, cut and bundled through the routes. The seeded
 * routing: 10 cut, 20 sew, 30 final inspection, 40 pack. Sessions come from the test authenticator; the team leader's
 * right to override comes from their own floor role in the database. Every name, number and PIN is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/production/guards`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const ns = 'guards-a'
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
  leatherBLK: idOf('product:item-colour:leather:BLK'),
  protector: idOf('product:item:protector'),
  bin: idOf('inventory:location:A1-STORE-01'),
  line1: idOf('site:A1:line:L1'),
  sewCentre: idOf('site:A1:work-centre:SEW'),
  cutStation: idOf('site:A1:station:CUT-01'),
  sew1Station: idOf('site:A1:station:SEW-01'),
  qcStation: idOf('site:A1:station:QC-01'),
  cutter: idOf('device:A1:cutting'),
  operatorA1: idOf('worker:A1:operator'),
  leadA1: idOf('worker:A1:lead'),
  line2: newId(),
  sew3Station: newId(),
  sew1: newId(),
  sew3: newId(),
  qc: newId(),
  supervisor: newId(),
}
const LEAD_PIN = '481572'
const OPERATOR_PIN = '729304'

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const FLOOR: Permission[] = ['floor.work', 'production.cut', 'production.bundles', 'production.scan', 'inventory.issue', 'print.view', 'print.labels']
const floor = (deviceId: string, actorId: string): SessionContext => ({ audience: 'floor', tenantId: A.tenant, actorId, siteId: A.siteA1, deviceId, grants: [grant(FLOOR, [A.companyA], [A.siteA1])] })
const SESSIONS: Record<string, SessionContext> = {
  planner: office([grant(['workorders.view', 'workorders.manage', 'workorders.release'])]),
  supervisor: office([grant(['workorders.view', 'production.scan.correct', 'production.scan'])], A.supervisor),
  viewer: office([grant(['workorders.view'])]),
  companyB: office([grant(['workorders.view', 'production.scan.correct'], [A.companyB])]),
  cutter: floor(A.cutter, A.operatorA1),
  sew1: floor(A.sew1, A.operatorA1),
  sew3: floor(A.sew3, A.operatorA1),
  qc: floor(A.qc, A.operatorA1),
  /** The team leader signed in on the inspection tablet. */
  leadQc: floor(A.qc, A.leadA1),
}

type Json = Record<string, any>
type Method = 'GET' | 'POST'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let sent = 0
const clientId = () => `gd-${run}-${++sent}`
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const refusalOf = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const fixOf = (error: Json): string => String(error.issues?.find((issue: Json) => issue.path === 'fix')?.message ?? '')
const keysOf = (value: unknown): string[] =>
  Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => [key, ...keysOf(item)]) : []
const counts = async (sql: string, values: unknown[]) => (await admin<{ n: number }>(sql, values))[0]!.n
const setRules = (rules: { quantityGuard?: string; skippedOperationRule?: string }) =>
  admin(`UPDATE "ProductionSettings" SET "quantityGuard" = COALESCE($2::"FloorRuleMode", "quantityGuard"), "skippedOperationRule" = COALESCE($3::"FloorRuleMode", "skippedOperationRule") WHERE id = $1`, [A.siteA1, rules.quantityGuard ?? null, rules.skippedOperationRule ?? null])

const scanBody = (bundle: Json, good: number, extra: Json = {}) => ({ clientScanId: clientId(), code: bundle.code, good, ...extra })
async function reported(session: string, body: Json, status = 201): Promise<Json> {
  const response = await call(session, 'POST', '/production/scans', body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().scan
}
async function refused(session: string, body: Json, status = 409): Promise<Json> {
  const response = await call(session, 'POST', '/production/scans', body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const override = (session: string, report: Json, lead: Json, reasonCode = 'EARLIER_LATE', extra: Json = {}) => call(session, 'POST', '/production/guards/override', { report, lead, reasonCode, ...extra })
const flagRows = (scanId: string, action: string) => admin(`SELECT after, reason, "actorId" FROM "AuditLog" WHERE "recordType" = 'OperationScan' AND "recordId" = $1 AND action = $2`, [scanId, action])

// ---- made-up stock, work orders, cuts and bundles --------------------------------------------------------------------------------

const hides: Record<string, string> = {}
const lots = { protectorA: `T-${run}-PRO-A`, protectorB: `T-${run}-PRO-B`, protectorQ: `T-${run}-PRO-Q`, leather: `T-${run}-BIG` }
const lotIds: Record<string, string> = {}

async function addStock(count: number) {
  const lotId = newId()
  lotIds.leather = lotId
  await admin(
    `INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", "itemColourId", code, "dyeBatch", "qualityStatus", "qualityDecidedAt", "requiresCrViTest", "crViLimitMgKg", "crViStatus", "crViMgKg", "crViEvidence", "crViTestedAt", "receivedAt")
     VALUES ($1, $2, $3, $4, $5, $6, $7, '7731', 'RELEASED', now(), true, '3.000', 'PASS', '1.100', 'LOT_REPORT', '2026-10-01', '2026-10-05T08:00:00Z')`,
    [lotId, A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lots.leather],
  )
  for (let index = 1; index <= count; index++) {
    const key = `H${index}`
    const hideId = newId()
    hides[key] = `T-${run}-${key}`
    await admin(`INSERT INTO "Hide" (id, "tenantId", "siteId", "lotId", "itemId", code, area, "areaUom", "baseArea", grade, "thicknessMm") VALUES ($1, $2, $3, $4, $5, $6, '1000.0000', 'FT2', '1000.0000', 'A', '1.10')`, [hideId, A.tenant, A.siteA1, lotId, A.leather, hides[key]])
    await admin(
      `INSERT INTO "StockMove" (id, "tenantId", "companyId", "siteId", reason, "itemId", "itemColourId", "lotId", "hideId", "toLocationId", quantity, uom, "baseQuantity", "idempotencyKey", "occurredAt")
       VALUES ($1, $2, $3, $4, 'OPENING', $5, $6, $7, $8, $9, '1000.0000', 'FT2', '1000.0000', $10, now())`,
      [newId(), A.tenant, A.companyA, A.siteA1, A.leather, A.leatherBLK, lotId, hideId, A.bin, `guards-test-${run}-${key}`],
    )
  }
  for (const [key, status] of [['protectorA', 'RELEASED'], ['protectorB', 'RELEASED'], ['protectorQ', 'QUARANTINE']] as const) {
    lotIds[key] = newId()
    await admin(`INSERT INTO "Lot" (id, "tenantId", "companyId", "siteId", "itemId", code, "qualityStatus", "qualityDecidedAt", "receivedAt") VALUES ($1, $2, $3, $4, $5, $6, $7::"LotQualityStatus", $8, now())`, [
      lotIds[key],
      A.tenant,
      A.companyA,
      A.siteA1,
      A.protector,
      lots[key],
      status,
      status === 'RELEASED' ? new Date() : null,
    ])
  }
}

async function salesOrderLine(pieces: number): Promise<string> {
  const orderId = newId()
  const lineId = newId()
  await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) =>
    client.$transaction(async (tx) => {
      await tx.salesOrder.create({
        data: { id: orderId, companyId: A.companyA, partyId: A.brand, number: `T-${run}-SO`, status: 'CONFIRMED', orderDate: new Date('2026-10-20T00:00:00.000Z'), taxMode: 'IT_B2B', billTo: { legalName: 'Made-up customer' }, shipTo: { name: 'Made-up workshop' }, promiseDate: new Date('2026-12-10T00:00:00.000Z'), depositRequired: false },
        select: { id: true },
      })
      await tx.salesOrderLine.create({
        data: { id: lineId, companyId: A.companyA, orderId, partyId: A.brand, seq: 10, kind: 'SIZE_GRID', styleId: A.style, colourwayId: A.blk, quantity: pieces, unitPrice: '100.000000', netAmount: pieces * 10_000, vatRatePct: '22.00', vatAmount: pieces * 2_200, siteId: A.siteA1 },
        select: { id: true },
      })
      await tx.salesOrderLineSize.create({ data: { id: newId(), lineId, partyId: A.brand, size: '50', quantity: pieces }, select: { id: true } })
    }),
  )
  return lineId
}

async function releasedWorkOrder(lineId: string, pieces: number): Promise<Json> {
  const { workOrder } = await ok('planner', 'POST', '/production/work-orders', { lines: [{ salesOrderLineId: lineId, sizes: [{ size: '50', quantity: pieces }] }] }, 201)
  const released = await ok('planner', 'POST', `/production/work-orders/${workOrder.id}/release`, { materialOverride: { reason: 'The rest of the leather arrives next week' } })
  return released.workOrder
}

async function cutAndBundle(workOrder: Json, hideKey: string, bundleSize: number): Promise<Json[]> {
  const cut = await call('cutter', 'POST', `/production/cutting/work-orders/${workOrder.id}/cuts`, { clientEventId: clientId(), code: hides[hideKey], lines: workOrder.cells.map((cell: Json) => ({ workOrderSizeId: cell.id, sets: cell.quantity })) }, `k-${clientId()}`)
  expect(cut.statusCode, cut.body).toBe(201)
  const made = await call('cutter', 'POST', `/production/bundles/work-orders/${workOrder.id}/bundles`, { bundleSize, printerId: null }, `k-${clientId()}`)
  expect(made.statusCode, made.body).toBe(201)
  return made.json().bundles
}

const opOf = (workOrder: Json, seq: number): string => (workOrder.spec.operations as Json[]).find((op) => op.seq === seq)!.id
type Orders = 'skip' | 'strict' | 'quantity' | 'line' | 'parts'
const WO = {} as Record<Orders, Json>
const BN = {} as Record<Orders, Json[]>

beforeAll(async () => {
  db = await migratedDatabase('guards')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 12 } })
  await seedCore({ db: database, namespace: ns })
  await seedPrivacy({ db: database, namespace: ns })
  await seedProduction({ db: database, namespace: ns })
  await seedNumbering({ db: database, namespace: ns })
  await database.withScope({ audience: 'office', tenantId: A.tenant, actorId: A.actor }, (client) =>
    client.$transaction(async (tx) => {
      const certificateId = newId()
      await tx.certificate.create({
        data: { id: certificateId, holderPartyId: A.brand, standard: 'EN 17092-3:2020', ppeClass: 'AA', number: `T-${run}-CERT`, notifiedBodyName: 'Made-up Notified Body', notifiedBodyNumber: '9999', modelReference: 'SEED-JKT-02', validFrom: new Date('2026-01-01T00:00:00.000Z'), validTo: new Date('2030-12-31T00:00:00.000Z'), status: 'VALID', statusChangedAt: new Date() },
        select: { id: true },
      })
      await tx.certificateCoverage.create({ data: { id: newId(), certificateId, styleId: A.style, sizes: ['50', '52'] }, select: { id: true } })
    }),
  )
  await addStock(5)
  // A made-up second line with a sewing station of its own.
  await admin(`INSERT INTO "Line" (id, "tenantId", "companyId", "siteId", code, name) VALUES ($1, $2, $3, $4, 'L2', 'Made-up line 2')`, [A.line2, A.tenant, A.companyA, A.siteA1])
  await admin(`INSERT INTO "Station" (id, "tenantId", "companyId", "siteId", "lineId", "workCentreId", code, name) VALUES ($1, $2, $3, $4, $5, $6, 'SEW-03', 'Made-up sewing station 3')`, [A.sew3Station, A.tenant, A.companyA, A.siteA1, A.line2, A.sewCentre])
  for (const [deviceId, stationId, name] of [
    [A.sew1, A.sew1Station, 'Sewing tablet 1'],
    [A.sew3, A.sew3Station, 'Sewing tablet 3 (line 2)'],
    [A.qc, A.qcStation, 'Inspection tablet'],
  ] as const) {
    await admin(`INSERT INTO "Device" (id, "tenantId", "companyId", "siteId", "stationId", name, kind, status, "enrolledAt") VALUES ($1, $2, $3, $4, $5, $6, 'TABLET', 'ACTIVE', now())`, [deviceId, A.tenant, A.companyA, A.siteA1, stationId, name])
  }
  const keyring = pinKeyring(LOCAL_PIN_PEPPER)
  await admin(`UPDATE "Worker" SET "pinHash" = $2, "pinChangedAt" = now() WHERE id = $1`, [A.leadA1, await hashPin(LEAD_PIN, keyring)])
  await admin(`UPDATE "Worker" SET "pinHash" = $2, "pinChangedAt" = now() WHERE id = $1`, [A.operatorA1, await hashPin(OPERATOR_PIN, keyring)])

  const limits = { max: 10_000, timeWindowMs: 60_000 }
  const auth = createOfficeAuth({
    database,
    environment: 'test',
    cookieSecret: LOCAL_COOKIE_SECRET,
    pinPepper: LOCAL_PIN_PEPPER,
    webOrigin: 'http://127.0.0.1:3546',
    mailer: { deliver: async () => {} },
    rateLimits: { signIn: limits, resetRequest: limits, tokenUse: limits, codes: limits, linkUse: limits, floorSignIn: limits },
  })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET, rateLimit: limits },
    { database, officeAuth: auth, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null), logger: false },
  )
  const line = await salesOrderLine(60)
  const plan: [Orders, number, string, number][] = [
    ['skip', 10, 'H1', 5],
    ['strict', 10, 'H2', 5],
    ['quantity', 15, 'H3', 5],
    ['line', 5, 'H4', 5],
    ['parts', 10, 'H5', 5],
  ]
  for (const [name, pieces, hide, size] of plan) {
    WO[name] = await releasedWorkOrder(line, pieces)
    BN[name] = await cutAndBundle(WO[name], hide, size)
  }
}, 600_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

// ---- MES-098 ------------------------------------------------------------------------------------------------------------------------

describe('MES-098 a skipped operation: WARN (the default) counts and tells the team leader; settled once it is reported', () => {
  it('reads the site rules and what reached the operation on the check, before any count is typed', async () => {
    await reported('cutter', scanBody(BN.skip[0]!, 5))
    const check = await ok('qc', 'GET', `/production/guards/check?code=${BN.skip[0]!.code}`)
    expect(check).toMatchObject({ modes: { quantityGuard: 'STRICT', skippedOperationRule: 'WARN' }, operation: { id: opOf(WO.skip, 30), seq: 30, reported: false }, expected: 5, skipped: [{ id: opOf(WO.skip, 20), seq: 20 }], components: { asked: [] } })
    expect(check.findings).toEqual([{ kind: 'SKIPPED_OPERATION', mode: 'WARN', code: 'PREVIOUS_NOT_REPORTED', message: `Op 20 Sew and assemble the body has not passed bundle ${BN.skip[0]!.code} yet.`, fix: expect.stringMatching(/^Report it at Op 20 first/), overridable: false }])
    expect(check.overrideReasons.map((reason: Json) => reason.code)).toEqual(['COUNTED_AGAIN', 'EARLIER_LATE', 'COVERING_LINE', 'BACK_FROM_REWORK', 'OTHER'])
  })

  it('takes the final inspection with sewing skipped, keeps the finding on the scan and tells the team leaders (no person)', async () => {
    const scan = await reported('qc', scanBody(BN.skip[0]!, 5))
    expect(scan.operation.seq).toBe(30)
    const [row] = await flagRows(scan.id, 'production.scanGuardFlagged')
    expect(row!.after).toMatchObject({ bundleId: BN.skip[0]!.id, operationSeq: 30, stationId: A.qcStation, cap: 5, guards: [{ kind: 'SKIPPED_OPERATION', mode: 'WARN', code: 'PREVIOUS_NOT_REPORTED', detail: { skippedOperationIds: [opOf(WO.skip, 20)] } }] })
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_guard_flagged' AND payload->>'scanId' = $1`, [scan.id])
    expect(event!.payload).toMatchObject({ workOrderId: WO.skip.id, bundleId: BN.skip[0]!.id, operationSeq: 30, guards: ['SKIPPED_OPERATION'] })
    expect(keysOf(event!.payload).filter((key) => /worker|lead|name/i.test(key))).toEqual([])
    // The scan's own audit row keeps what reached it as the cap.
    const [audit] = await admin(`SELECT after FROM "AuditLog" WHERE "recordType" = 'OperationScan' AND "recordId" = $1 AND action = 'production.reportScan'`, [scan.id])
    expect(audit!.after.cap).toBe(5)

    const list = await ok('supervisor', 'GET', `/production/guards/flags?siteId=${A.siteA1}`)
    const flag = list.flags.find((entry: Json) => entry.scanId === scan.id)
    expect(flag).toMatchObject({ kind: 'WARNED', guards: ['SKIPPED_OPERATION'], workOrder: { id: WO.skip.id }, bundle: { code: BN.skip[0]!.code }, operation: { seq: 30 }, station: { code: 'QC-01' }, stillSkipped: 1 })
    expect(keysOf(list).filter((key) => /worker|lead|person/i.test(key))).toEqual([])
  })

  it('the late report of the skipped operation may not pass fewer good than inspection took (STRICT quantity), then settles the flag', async () => {
    const fewer = await refused('sew1', scanBody(BN.skip[0]!, 4, { scrap: [{ reason: 'STAIN', quantity: 1 }] }))
    expect(refusalOf(fewer)).toBe('refusal/LESS_THAN_TAKEN')
    expect(fewer.message).toBe(`Op 30 Final inspection took 5 garments of bundle ${BN.skip[0]!.code} already; 4 good here is fewer.`)
    expect(fixOf(fewer)).toMatch(/team leader to override/)
    await reported('sew1', scanBody(BN.skip[0]!, 5))
    const list = await ok('supervisor', 'GET', `/production/guards/flags?siteId=${A.siteA1}&guard=SKIPPED_OPERATION`)
    expect(list.flags.find((entry: Json) => entry.bundle.id === BN.skip[0]!.id).stillSkipped).toBe(0)
  })

  it('FREE lets it pass without a finding', async () => {
    await setRules({ skippedOperationRule: 'FREE' })
    try {
      await reported('cutter', scanBody(BN.skip[1]!, 5))
      const scan = await reported('qc', scanBody(BN.skip[1]!, 5))
      expect(await flagRows(scan.id, 'production.scanGuardFlagged')).toEqual([])
    } finally {
      await setRules({ skippedOperationRule: 'WARN' })
    }
  })
})

// ---- the team leader's override -----------------------------------------------------------------------------------------------------

describe("STRICT holds in W1's words; a team leader overrides with their PIN and a reason, never on their own scan", () => {
  let held: Json
  beforeAll(async () => {
    await setRules({ skippedOperationRule: 'STRICT' })
    await reported('cutter', scanBody(BN.strict[0]!, 5))
    await reported('cutter', scanBody(BN.strict[1]!, 5))
  })
  afterAll(async () => {
    await setRules({ skippedOperationRule: 'WARN' })
  })

  it('holds the final inspection while sewing is not reported: W1 code and words, not final', async () => {
    held = scanBody(BN.strict[0]!, 5)
    const error = await refused('qc', held)
    expect(refusalOf(error)).toBe('refusal/PREVIOUS_NOT_REPORTED')
    expect(error.message).toBe(`Op 20 Sew and assemble the body has not passed bundle ${BN.strict[0]!.code} yet.`)
    const check = await ok('qc', 'GET', `/production/guards/check?code=${BN.strict[0]!.code}`)
    expect(check.findings).toMatchObject([{ kind: 'SKIPPED_OPERATION', mode: 'STRICT', overridable: true }])
  })

  it('refuses a wrong PIN (counted on the team leader), the operator themself, a person without the right, and "Other" without words', async () => {
    const wrong = await override('qc', held, { workerId: A.leadA1, pin: '111111' })
    expect(wrong.statusCode, wrong.body).toBe(409)
    expect(refusalOf(wrong.json().error)).toBe('refusal/OVERRIDE_PIN_WRONG')
    expect((await admin(`SELECT "failedPinAttempts" FROM "Worker" WHERE id = $1`, [A.leadA1]))[0]!.failedPinAttempts).toBe(1)
    const self = await override('qc', held, { workerId: A.operatorA1, pin: OPERATOR_PIN })
    expect(refusalOf(self.json().error)).toBe('refusal/OVERRIDE_SELF')
    // The team leader is signed in; the operator (no right to override) signs.
    const notLead = await override('leadQc', held, { workerId: A.operatorA1, pin: OPERATOR_PIN })
    expect(refusalOf(notLead.json().error)).toBe('refusal/OVERRIDE_NOT_LEAD')
    const noWords = await override('qc', held, { workerId: A.leadA1, pin: LEAD_PIN }, 'OTHER')
    expect(refusalOf(noWords.json().error)).toBe('refusal/OVERRIDE_NOTE_MISSING')
    const bad = await override('qc', held, { workerId: A.leadA1, badgeCode: 'X', pin: LEAD_PIN })
    expect(bad.statusCode).toBe(400)
    expect(await counts(`SELECT count(*)::int AS n FROM "OperationScan" WHERE "clientScanId" = $1`, [held.clientScanId])).toBe(0)
  })

  it('the team leader signs with the right PIN and a reason tile: the report counts, the override is kept (one record) and told', async () => {
    const response = await override('qc', held, { workerId: A.leadA1, pin: LEAD_PIN }, 'EARLIER_LATE')
    expect(response.statusCode, response.body).toBe(201)
    const body = response.json()
    expect(body).toMatchObject({ replayed: false, scan: { operation: { seq: 30 }, goodQuantity: 5, clientScanId: held.clientScanId }, override: { guards: ['SKIPPED_OPERATION'], reasonCode: 'EARLIER_LATE' } })
    expect(keysOf(body).filter((key) => /worker|lead/i.test(key))).toEqual([])
    const [row] = await flagRows(body.scan.id, 'production.scanGuardOverridden')
    expect(row).toMatchObject({ reason: 'The earlier operation is recorded later', actorId: A.operatorA1, after: { leadWorkerId: A.leadA1, reasonCode: 'EARLIER_LATE', note: null, guards: [{ kind: 'SKIPPED_OPERATION', mode: 'STRICT' }] } })
    const [event] = await admin(`SELECT payload FROM "OutboxEvent" WHERE type = 'production.scan_guard_overridden' AND payload->>'scanId' = $1`, [body.scan.id])
    expect(event!.payload).toMatchObject({ guards: ['SKIPPED_OPERATION'], reasonCode: 'EARLIER_LATE', stationId: A.qcStation })
    expect(keysOf(event!.payload).filter((key) => /worker|lead|note/i.test(key))).toEqual([])
    // The PIN never reaches a record: no audit row, receipt or event holds it.
    expect(await counts(`SELECT count(*)::int AS n FROM "AuditLog" WHERE after::text LIKE $1 OR before::text LIKE $1`, [`%${LEAD_PIN}%`])).toBe(0)
    expect(await counts(`SELECT count(*)::int AS n FROM "IdempotencyReceipt" WHERE "requestHash" LIKE $1`, [`%${LEAD_PIN}%`])).toBe(0)
    expect(await counts(`SELECT count(*)::int AS n FROM "OutboxEvent" WHERE payload::text LIKE $1`, [`%${LEAD_PIN}%`])).toBe(0)

    // The same override sent again answers the scan recorded first.
    const again = await override('qc', held, { workerId: A.leadA1, pin: LEAD_PIN }, 'EARLIER_LATE')
    expect(again.statusCode, again.body).toBe(200)
    expect(again.json()).toMatchObject({ replayed: true, scan: { id: body.scan.id }, override: { guards: ['SKIPPED_OPERATION'] } })

    // One record: the scan's worker and the team leader by name, the reason.
    const one = await ok('supervisor', 'GET', `/production/guards/flags/${body.scan.id}`)
    expect(one.flag).toMatchObject({ worker: { id: A.operatorA1, name: 'Seed Worker A1-1' }, overridden: { lead: { id: A.leadA1, name: 'Seed Worker A1-2' }, reasonCode: 'EARLIER_LATE', reason: 'The earlier operation is recorded later' }, station: { code: 'QC-01' } })
    const list = await ok('supervisor', 'GET', `/production/guards/flags?siteId=${A.siteA1}&kind=OVERRIDDEN`)
    expect(list.flags.map((flag: Json) => flag.scanId)).toContain(body.scan.id)
    expect(keysOf(list).filter((key) => /worker|lead|person/i.test(key))).toEqual([])
  })

  it('an override when nothing holds any more counts the report and says so; "Other" with words is kept', async () => {
    await reported('sew1', scanBody(BN.strict[1]!, 5))
    const response = await override('qc', scanBody(BN.strict[1]!, 5), { workerId: A.leadA1, pin: LEAD_PIN }, 'OTHER', { note: 'Checked by hand' })
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().override).toBeNull()
    expect(await flagRows(response.json().scan.id, 'production.scanGuardOverridden')).toEqual([])
  })
})

// ---- MES-097 ------------------------------------------------------------------------------------------------------------------------

describe('MES-097 more garments than the operation before passed: STRICT holds, WARN counts and tells, FREE counts; never more than the bundle', () => {
  beforeAll(async () => {
    for (const bundle of BN.quantity) await reported('cutter', scanBody(bundle, 4, { scrap: [{ reason: 'STAIN', quantity: 1 }] }))
  })

  it("STRICT (the default) holds sewing 5 of the cut's 4, in W1 words; the team leader overrides it", async () => {
    const body = scanBody(BN.quantity[0]!, 5)
    const error = await refused('sew1', body)
    expect(refusalOf(error)).toBe('refusal/MORE_THAN_PASSED')
    expect(error.message).toBe(`Op 10 Cut leather panels passed 4 garments of bundle ${BN.quantity[0]!.code}; 5 reported here.`)
    expect(fixOf(error)).toMatch(/^Count again: at most 4, or ask a correction of Op 10 first\. A team leader may override it/)
    // The check with the counts on the pads says the same before Finish.
    const check = await ok('sew1', 'GET', `/production/guards/check?code=${BN.quantity[0]!.code}&good=5`)
    expect(check).toMatchObject({ expected: 4, beyondBundle: false, findings: [{ kind: 'QUANTITY', mode: 'STRICT', code: 'MORE_THAN_PASSED', overridable: true }] })
    const response = await override('sew1', body, { workerId: A.leadA1, pin: LEAD_PIN }, 'COUNTED_AGAIN')
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json()).toMatchObject({ scan: { goodQuantity: 5 }, override: { guards: ['QUANTITY'], reasonCode: 'COUNTED_AGAIN' } })
  })

  it('more than the bundle carries is never taken, not even with an override (W1 words, no override in the fix)', async () => {
    const body = scanBody(BN.quantity[1]!, 6)
    const error = await refused('sew1', body)
    expect(refusalOf(error)).toBe('refusal/MORE_THAN_PASSED')
    expect(fixOf(error)).toBe('Count again: at most 4, or ask a correction of Op 10 first.')
    expect(await ok('sew1', 'GET', `/production/guards/check?code=${BN.quantity[1]!.code}&good=6`)).toMatchObject({ beyondBundle: true, findings: [{ code: 'MORE_THAN_PASSED', overridable: false }] })
    const response = await override('sew1', body, { workerId: A.leadA1, pin: LEAD_PIN }, 'COUNTED_AGAIN')
    expect(response.statusCode).toBe(409)
    expect(refusalOf(response.json().error)).toBe('refusal/MORE_THAN_PASSED')
    // At the first operation it is the bundle's own garments.
    expect(refusalOf(await refused('cutter', scanBody(BN.parts[1]!, 6)))).toBe('refusal/MORE_THAN_BUNDLE')
  })

  it('WARN counts it and tells the team leader; FREE counts it without a word', async () => {
    await setRules({ quantityGuard: 'WARN' })
    try {
      const warned = await reported('sew1', scanBody(BN.quantity[1]!, 5))
      const [row] = await flagRows(warned.id, 'production.scanGuardFlagged')
      expect(row!.after.guards).toMatchObject([{ kind: 'QUANTITY', mode: 'WARN', code: 'MORE_THAN_PASSED', detail: { passed: 4, reported: 5 } }])
      await setRules({ quantityGuard: 'FREE' })
      const free = await reported('sew1', scanBody(BN.quantity[2]!, 5))
      expect(await flagRows(free.id, 'production.scanGuardFlagged')).toEqual([])
    } finally {
      await setRules({ quantityGuard: 'STRICT' })
    }
  })
})

// ---- MES-070 ------------------------------------------------------------------------------------------------------------------------

describe('MES-070 a bundle of another line: held with why and what to do; the team leader overrides', () => {
  beforeAll(async () => {
    await admin(`UPDATE "WorkOrder" SET "lineId" = $2 WHERE id = $1`, [WO.line.id, A.line1])
    await reported('cutter', scanBody(BN.line[0]!, 5))
  })

  it('refuses it at a sewing station of line 2 (its work order is on line 1, which sews); the check says so first', async () => {
    const check = await ok('sew3', 'GET', `/production/guards/check?code=${BN.line[0]!.code}`)
    expect(check.findings).toEqual([{ kind: 'WRONG_BUNDLE', mode: 'STRICT', code: 'WRONG_BUNDLE', message: `Bundle ${BN.line[0]!.code} is for line L1 (work order ${WO.line.number}); SEW-03 is on line L2.`, fix: 'Take it to line L1, or ask your team leader to override it with their PIN and a reason.', overridable: true }])
    expect((await ok('sew1', 'GET', `/production/guards/check?code=${BN.line[0]!.code}`)).findings).toEqual([])
    const body = scanBody(BN.line[0]!, 5)
    const error = await refused('sew3', body)
    expect(refusalOf(error)).toBe('refusal/WRONG_BUNDLE')
    const response = await override('sew3', body, { workerId: A.leadA1, pin: LEAD_PIN }, 'COVERING_LINE')
    expect(response.statusCode, response.body).toBe(201)
    expect(response.json().override).toEqual({ guards: ['WRONG_BUNDLE'], reasonCode: 'COVERING_LINE' })
  })
})

// ---- MES-114 ------------------------------------------------------------------------------------------------------------------------

describe('MES-114 protectors and lots scanned per garment at the sewn operation of a style traced per garment', () => {
  beforeAll(async () => {
    await admin(`UPDATE "Style" SET "garmentTracking" = 'SERIAL' WHERE id = $1`, [A.style])
    await reported('cutter', scanBody(BN.parts[0]!, 5))
  })
  afterAll(async () => {
    await admin(`UPDATE "Style" SET "garmentTracking" = 'BATCH' WHERE id = $1`, [A.style])
  })

  it('the check lists the shoulder protector to scan at sewing (and the lot-traced lining that may be)', async () => {
    const check = await ok('sew1', 'GET', `/production/guards/check?code=${BN.parts[0]!.code}`)
    expect(check.components.asked).toEqual([{ itemId: A.protector, code: 'SEED-PRO-300', name: 'Seed shoulder protector level 2' }])
    expect(check.components.traceable.find((row: Json) => row.itemId === A.protector)).toMatchObject({ asked: true })
    expect((await ok('qc', 'GET', `/production/guards/check?code=${BN.parts[0]!.code}&workOrderOperationId=${opOf(WO.parts, 30)}`)).components.asked).toEqual([])
  })

  it('refuses a missing protector, a wrong item, an unknown lot, a lot in quarantine and lots that do not cover the garments', async () => {
    const base = (components?: Json[]) => scanBody(BN.parts[0]!, 5, components ? { components } : {})
    expect(refusalOf(await refused('sew1', base()))).toBe('refusal/COMPONENTS_MISSING')
    expect(refusalOf(await refused('sew1', base([{ code: lots.leather, garments: 5 }])))).toBe('refusal/WRONG_COMPONENT')
    expect(refusalOf(await refused('sew1', base([{ code: 'NOT-A-LOT-1', garments: 5 }])))).toBe('refusal/UNKNOWN_LOT')
    expect(refusalOf(await refused('sew1', base([{ code: lots.protectorQ, garments: 5 }])))).toBe('refusal/LOT_NOT_RELEASED')
    const short = await refused('sew1', base([{ code: lots.protectorA, garments: 3 }]))
    expect(refusalOf(short)).toBe('refusal/COMPONENT_COUNT')
    expect(short.message).toBe('The lots of SEED-PRO-300 cover 3 garments; 5 garments go on from Op 20.')
  })

  it('traces 3 garments to one lot and 2 to another; the work order and the lot read it back (the recall)', async () => {
    const scan = await reported('sew1', scanBody(BN.parts[0]!, 4, { rework: [{ reason: 'RESTITCH', quantity: 1 }], components: [{ code: lots.protectorA, garments: 3 }, { code: lots.protectorB.toLowerCase(), garments: 2 }] }))
    const [row] = await flagRows(scan.id, 'production.scanComponentsTraced')
    expect(row!.after).toMatchObject({ garments: 5, components: [{ lotCode: lots.protectorA, garments: 3 }, { lotCode: lots.protectorB, garments: 2 }] })
    const traced = await ok('viewer', 'GET', `/production/guards/work-orders/${WO.parts.id}/components`)
    expect(traced.traced).toMatchObject([{ scanId: scan.id, bundle: { code: BN.parts[0]!.code }, operation: { seq: 20 }, garments: 5, components: [{ itemCode: 'SEED-PRO-300', lotId: lotIds.protectorA, garments: 3 }, { lotId: lotIds.protectorB, garments: 2 }] }])
    const recall = await ok('viewer', 'GET', `/production/guards/lots/${lotIds.protectorA}/garments`)
    expect(recall).toMatchObject({ lot: { code: lots.protectorA }, garments: 3, uses: [{ workOrder: { id: WO.parts.id }, bundle: { id: BN.parts[0]!.id }, operation: { seq: 20 }, garments: 3 }] })
    // Final inspection asks nothing.
    await reported('qc', scanBody(BN.parts[0]!, 4))
  })

  it('the offline batch carries the lots too, and keeps a refused one for the queue', async () => {
    await reported('cutter', scanBody(BN.parts[1]!, 5))
    const missing = { action: 'REPORT', ...scanBody(BN.parts[1]!, 5) }
    const traced = { action: 'REPORT', ...scanBody(BN.parts[1]!, 5, { components: [{ code: lots.protectorB, garments: 5 }] }) }
    const batch = await ok('sew1', 'POST', '/production/scans/batch', { items: [missing, traced] })
    expect(batch.items.map((item: Json) => [item.status, item.refusal?.code ?? null])).toEqual([
      ['refused', 'COMPONENTS_MISSING'],
      ['accepted', null],
    ])
    const [row] = await flagRows(batch.items[1].scan.id, 'production.scanComponentsTraced')
    expect(row!.after.components).toMatchObject([{ lotId: lotIds.protectorB, garments: 5 }])
    expect((await ok('viewer', 'GET', `/production/guards/lots/${lotIds.protectorB}/garments`)).garments).toBe(7)
  })
})

// ---- who reads what ------------------------------------------------------------------------------------------------------------------

describe('who reads the checks: the office within its grants, never another company; the floor only the check', () => {
  it('another company sees no flags; the floor reads no flags list; a viewer without the right reads no record', async () => {
    expect((await ok('companyB', 'GET', '/production/guards/flags')).flags).toEqual([])
    expect((await call('qc', 'GET', '/production/guards/flags')).statusCode).toBe(403)
    expect((await call('viewer', 'GET', '/production/guards/flags')).statusCode).toBe(403)
    expect((await call('supervisor', 'GET', `/production/guards/flags/${newId()}`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/production/guards/lots/${lotIds.protectorA}/garments`)).statusCode).toBe(404)
  })
})
