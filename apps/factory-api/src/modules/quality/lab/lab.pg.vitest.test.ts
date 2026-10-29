import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addRole, addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * The lab step for incoming lots (B-W1-34; QHS-029, QHS-030, SCM-117, QHS-073; REACH Annex XVII entry 47; Owner
 * question Q14, design answer W3; PLAN §4.7 stage 09b-cr6) on the local stack, with the app's real routes: a throwaway
 * PostgreSQL 17 database from the migrations (the runtime login: row-level security, the column grants and the
 * …_supply_guards Lot trigger are real), the auth harness's local file store behind the files seed's FAKE R2 account,
 * and the factory-db seeds of two tenants up to production (the black cowhide by the hide that needs the chromium VI
 * test, the certified shoulder protector with its EN 1621-1 certificate in the register, SEED-LOT-LEA-01 released with
 * its PASS and one hide issued to SEED-WO-0001), the numbering and compliance seeds. Goods arrive through the receipts
 * route (B-W1-32). Sessions come from the test authenticator; the step-up of a loosening uses the harness's real office
 * sign-in with two-factor. Every name, number, lab and value is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs quality/lab`.
 */

let h: Harness
let app: FastifyInstance

const ns = { a: 'lab-a', b: 'lab-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  supplier: idOf(ns.a, 'party:P2'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
  leatherBLK: idOf(ns.a, 'product:item-colour:leather:BLK'),
  liningGRY: idOf(ns.a, 'product:item-colour:lining:GRY'),
  seedLot: idOf(ns.a, 'inventory:lot:LEA-01'),
  seedHide: idOf(ns.a, 'inventory:hide:H1'),
  workOrder: idOf(ns.a, 'production:work-order:WO-0001'),
  deviceA1: idOf(ns.a, 'device:A1:cutting'),
  operatorA1: idOf(ns.a, 'worker:A1:operator'),
}
const B = { tenant: idOf(ns.b, 'tenant') }

const QUALITY: Permission[] = ['quality.lots.view', 'quality.lots.test', 'quality.lots.documents', 'quality.lots.release', 'quality.lots.reject', 'files.upload', 'files.read', 'planning.view']
const RECEIVE: Permission[] = ['inventory.receive', 'inventory.stock.view', 'inventory.reverse']
const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', sites: Grant['sites'] = 'all'): Grant => ({ permissions, companies, sites, parties: 'all' })
const office = (tenantId: string, grants: Grant[], actorId: string = newId()): SessionContext => ({ audience: 'office', tenantId, actorId, grants })
const receiverId = newId()
const inspectorId = newId()
const SESSIONS: Record<string, SessionContext> = {
  /** Receives goods AND holds the quality role: the four-eyes rule, not a missing permission, stops their release. */
  receiver: office(A.tenant, [grant([...RECEIVE, ...QUALITY])], receiverId),
  inspector: office(A.tenant, [grant(QUALITY)], inspectorId),
  /** A second quality person (the PPE lot's documents come from the buyer in real life). */
  buyer: office(A.tenant, [grant(['quality.lots.view', 'quality.lots.documents', 'files.upload'])]),
  viewer: office(A.tenant, [grant(['quality.lots.view'])]),
  /** Saves the evidence rule tenant-wide (tightening needs no step-up). */
  rules: office(A.tenant, [grant(['quality.lots.view', 'quality.settings.manage'])]),
  rulesB: office(A.tenant, [grant(['quality.lots.view', 'quality.settings.manage'], [A.companyB])]),
  companyB: office(A.tenant, [grant(QUALITY, [A.companyB])]),
  otherTenant: office(B.tenant, [grant(QUALITY)]),
  floor: { audience: 'floor', tenantId: A.tenant, actorId: A.operatorA1, siteId: A.siteA1, deviceId: A.deviceA1, grants: [grant(['floor.work', 'inventory.locations.view'], [A.companyA], [A.siteA1])] },
}

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const freshKey = () => `lab-${run}-${++counter}`
const call = (session: string, method: Method, url: string, payload?: unknown, key: string | undefined = freshKey()) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const pathsOf = (error: Json) => (error.issues ?? []).map((issue: Json) => issue.path)
const today = () => businessDate(new Date())
const pdf = (text: string) => Buffer.from(`%PDF-1.4\n% made-up lab report: ${text}\n%%EOF\n`)
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

const lotRow = async (lotId: string) =>
  (await admin<Json>('SELECT code, "qualityStatus"::text AS "qualityStatus", "qualityNote", "crViStatus"::text AS "crViStatus", "crViMgKg"::text AS "crViMgKg", "crViEvidence"::text AS "crViEvidence", "crViLimitMgKg"::text AS "crViLimitMgKg", version, "qualityDecidedById" FROM "Lot" WHERE id = $1', [lotId]))[0]!
const eventsOf = (type: string, subject: string) => admin('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2 ORDER BY "occurredAt", id', [type, subject])
const auditOf = (lotId: string, action: string) => admin('SELECT action, before, after, reason, "actorId" FROM "AuditLog" WHERE "recordType" = \'Lot\' AND "recordId" = $1 AND action = $2 ORDER BY at, id', [lotId, action])
const unusable = async (lotId: string) => ((await ok('inspector', 'GET', `/planning/unusable-stock?siteId=${A.siteA1}`)).lines as Json[]).filter((line) => line.lot?.id === lotId).map((line) => line.reason)

// ---- made-up goods, received through the receipts route (B-W1-32) -----------------------------------------------------------------

let orders = 0
async function makeOrder(lines: readonly { itemId: string; colourId: string | null; quantity: string; uom: string; requiresCrViTest?: boolean }[]): Promise<{ id: string; lines: string[] }> {
  const id = newId()
  await admin(`INSERT INTO "PurchaseOrder" (id, "tenantId", "companyId", "siteId", number, "partyId", "orderDate", "createdById") VALUES ($1, $2, $3, $4, $5, $6, current_date, $7)`, [id, A.tenant, A.companyA, A.siteA1, `T-LAB-${run}-${++orders}`, A.supplier, receiverId])
  const ids: string[] = []
  for (const [index, line] of lines.entries()) {
    const lineId = newId()
    ids.push(lineId)
    await admin(
      `INSERT INTO "PurchaseOrderLine" (id, "tenantId", "purchaseOrderId", "partyId", "siteId", seq, "itemId", "itemColourId", quantity, uom, "baseQuantity", "unitPrice", "netAmount", "needDate", "areaTolerancePct", "requiresCrViTest")
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::"Uom", $9, '5.000000', 100, current_date + 20, 10, $11)`,
      [lineId, A.tenant, id, A.supplier, A.siteA1, (index + 1) * 10, line.itemId, line.colourId, line.quantity, line.uom, line.requiresCrViTest ?? false],
    )
  }
  await admin(`UPDATE "PurchaseOrder" SET status = 'SENT', "sentAt" = now(), "sentById" = $2, "netAmount" = 100, version = 2 WHERE id = $1`, [id, receiverId])
  return { id, lines: ids }
}

/** A leather lot of two hides (100 ft²) received by the receiver: QUARANTINE, Cr VI PENDING. */
async function leatherLot(extra: Json = {}): Promise<{ lotId: string; receiptId: string }> {
  const order = await makeOrder([{ itemId: A.leather, colourId: A.leatherBLK, quantity: '100', uom: 'FT2', requiresCrViTest: true }])
  const answer = await ok('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: `DDT-${run}-${orders}`, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ dyeBatch: `DB-${orders}`, hides: [{ area: '50' }, { area: '50' }], ...extra }] }] }, 201)
  return { lotId: answer.receipt.lines[0].lots[0].id, receiptId: answer.receipt.id }
}
async function lotOf(itemId: string, colourId: string | null, quantity: string, uom: string, extra: Json = {}): Promise<string> {
  const order = await makeOrder([{ itemId, colourId, quantity, uom }])
  const answer = await ok('receiver', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: order.lines[0], lots: [{ quantity, ...extra }] }] }, 201)
  return answer.receipt.lines[0].lots[0].id
}

/** Announce a report (or a supplier document), send it to the local store: the file's id. */
async function uploaded(session: string, lotId: string, path: 'results/report' | 'documents/upload', text = 'Cr VI'): Promise<string> {
  const body = pdf(`${text} ${newId()}`)
  const announced = await ok(session, 'POST', `/quality/lots/${lotId}/${path}`, { originalName: 'report.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
  expect(announced.file).toMatchObject({ recordType: 'Lot', recordId: lotId, kind: 'CERTIFICATE', status: 'PENDING_UPLOAD' })
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  return announced.file.id
}
const RESULT = { test: 'CR_VI', method: 'EN ISO 17075-1', lab: 'Test Lab One', reportNumber: 'TL-0001', evidence: 'LOT_REPORT' }
async function result(lotId: string, fields: Json = {}, session = 'inspector') {
  const fileId = fields.fileId ?? (await uploaded(session, lotId, 'results/report'))
  return call(session, 'POST', `/quality/lots/${lotId}/results`, { version: (await lotRow(lotId)).version, testedOn: today(), ...RESULT, ...fields, fileId })
}
async function passed(lotId: string, fields: Json = { valueMgKg: '1.2' }): Promise<Json> {
  const response = await result(lotId, fields)
  expect(response.statusCode, response.body).toBe(201)
  return response.json()
}
const release = async (lotId: string, session = 'inspector', confirmCode?: string) => call(session, 'POST', `/quality/lots/${lotId}/release`, { version: (await lotRow(lotId)).version, confirmCode: confirmCode ?? (await lotRow(lotId)).code })

beforeAll(async () => {
  h = await startHarness('quality_lab')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  for (const namespace of [ns.a, ns.b]) {
    await seedProduction({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    await seedCompliance({ db: h.database, namespace })
    await seedFiles({ db: h.database, namespace })
  }
  // The files seed's store account keeps the default rate (10 calls at once): this file announces and confirms many.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) =>
    applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }),
  )
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database: h.database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

// ---- the golden flow: quarantine → PASS → release by the quality role → usable ---------------------------------------------------

describe('a leather lot from quarantine to usable stock (PLAN §4.7 09b-cr6)', () => {
  let lotId: string

  it('arrives in QUARANTINE with Cr VI PENDING and the legal limit; the checklist names what is missing; planning does not count it', async () => {
    ;({ lotId } = await leatherLot())
    expect(await lotRow(lotId)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', crViLimitMgKg: '3.000' })
    const record = await ok('inspector', 'GET', `/quality/lots/${lotId}`)
    expect(record.rule).toEqual({ crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', source: 'DEFAULT', words: 'A supplier report that covers the article and the period counts as chromium VI evidence, as does a lab report on the lot.' })
    expect(record.lot).toMatchObject({ qualityStatus: 'QUARANTINE', receivedById: receiverId, crVi: { required: true, status: 'PENDING', limitMgKg: '3.000', valueMgKg: null } })
    expect(record.checklist.checks.map((check: Json) => [check.code, check.state])).toEqual([
      ['STATE', 'OK'],
      ['RECEIPT', 'OK'],
      ['CR_VI', 'OPEN'],
      ['PPE_CERTIFICATE', 'NOT_NEEDED'],
      ['SUPPLIER_DOCUMENTS', 'NOT_NEEDED'],
      ['HOLD', 'NOT_NEEDED'],
      ['RELEASER', 'OK'],
    ])
    expect(record.checklist.words).toBe('Release · 1 check open')
    expect(await unusable(lotId)).toEqual(['CR_VI_PENDING'])

    const held = await release(lotId)
    expect(held.statusCode).toBe(409)
    expect(pathsOf(held.json().error)).toEqual(['checks/CR_VI'])
    expect((await lotRow(lotId)).qualityStatus).toBe('QUARANTINE')
  })

  it('a PASS with the lab report: the verdict computed against the limit, the lot PASS, the report kept ten years, one audit row and the event', async () => {
    const answer = await passed(lotId, { valueMgKg: '1.2', note: 'Composite sample of both hides.' })
    expect(answer.result).toMatchObject({ verdict: 'PASS', valueMgKg: '1.200', limitMgKg: '3.000', unit: 'mg/kg', method: 'EN ISO 17075-1', evidence: 'LOT_REPORT', words: 'PASS: 1.2 mg/kg is below the limit of 3 mg/kg.', supersedesId: null })
    expect(answer.lot).toMatchObject({ qualityStatus: 'QUARANTINE', crVi: { status: 'PASS', valueMgKg: '1.200', evidence: 'LOT_REPORT', testedOn: today() } })
    expect(answer.checklist).toMatchObject({ ready: true, words: 'Ready to release' })
    expect(answer.trace).toBeNull()
    const [file] = await admin<Json>('SELECT status::text AS status, "retainUntil" FROM "StoredFile" WHERE id = $1', [answer.result.fileId])
    expect(file!.status).toBe('AVAILABLE')
    expect(new Date(file!.retainUntil).getUTCFullYear()).toBe(new Date().getUTCFullYear() + 10)
    expect(await auditOf(lotId, 'quality.lots.recordResult')).toMatchObject([{ before: { crViStatus: 'PENDING' }, after: { crViStatus: 'PASS', crViMgKg: '1.200', verdict: 'PASS' } }])
    expect(await eventsOf('lot.test_recorded', lotId)).toMatchObject([{ payload: { verdict: 'PASS', crViStatus: 'PASS', qualityStatus: 'QUARANTINE', laterFail: false } }])
    const listed = await ok('viewer', 'GET', `/quality/lots/${lotId}/results`)
    expect(listed.results.map((row: Json) => [row.verdict, row.valueMgKg, row.lab, row.file.status, row.superseded])).toEqual([['PASS', '1.200', 'Test Lab One', 'AVAILABLE', false]])
    // A second PASS changes nothing: only a later FAIL on new evidence does.
    const again = await result(lotId, { valueMgKg: '0.8' })
    expect(again.statusCode).toBe(409)
    expect(again.json().error.message).toContain('only a later FAIL')
  })

  it('the typed code must be the lot\'s; the release then makes it usable (planning nets it), audited with its checks, the event emitted', async () => {
    const wrong = await release(lotId, 'inspector', 'LA-999999')
    expect(wrong.statusCode).toBe(400)
    expect(pathsOf(wrong.json().error)).toEqual(['body/confirmCode'])
    const code = (await lotRow(lotId)).code as string
    const response = await release(lotId, 'inspector', ` ${code.toLowerCase()} `)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().lot).toMatchObject({ qualityStatus: 'RELEASED', words: 'Released: usable stock.' })
    expect(await lotRow(lotId)).toMatchObject({ qualityStatus: 'RELEASED', qualityDecidedById: inspectorId })
    const [audit] = await auditOf(lotId, 'quality.lots.release')
    expect(audit).toMatchObject({ before: { qualityStatus: 'QUARANTINE' }, after: { qualityStatus: 'RELEASED' } })
    expect((audit!.after as Json).checks.map((check: Json) => check.code)).toEqual(['STATE', 'RECEIPT', 'CR_VI', 'PPE_CERTIFICATE', 'SUPPLIER_DOCUMENTS', 'HOLD', 'RELEASER'])
    expect(await eventsOf('lot.released', lotId)).toMatchObject([{ payload: { code, from: 'QUARANTINE' } }])
    expect(await unusable(lotId)).toEqual([])
    // Released already; a stale version is a conflict.
    expect((await release(lotId)).statusCode).toBe(409)
    expect((await call('inspector', 'POST', `/quality/lots/${lotId}/release`, { version: 1, confirmCode: code })).statusCode).toBe(409)
  })

  it('block (a finding) and unblock (the same checks again), each with its reason; a block of a lot in quarantine is refused', async () => {
    const blocked = await ok('inspector', 'POST', `/quality/lots/${lotId}/block`, { version: (await lotRow(lotId)).version, reason: 'Customer complaint about the shade.' })
    expect(blocked).toMatchObject({ lot: { qualityStatus: 'BLOCKED', qualityNote: 'Customer complaint about the shade.' }, trace: { workOrders: [] } })
    expect(await eventsOf('lot.blocked', lotId)).toMatchObject([{ payload: { cause: 'FINDING', workOrderIds: [] } }])
    expect(await unusable(lotId)).toEqual(['BLOCKED'])
    expect(pathsOf(await refused('inspector', 'POST', `/quality/lots/${lotId}/unblock`, { version: (await lotRow(lotId)).version, reason: ' ' }, 400))).toEqual(['body/reason'])
    const unblocked = await ok('inspector', 'POST', `/quality/lots/${lotId}/unblock`, { version: (await lotRow(lotId)).version, reason: 'The shade is within the sample.' })
    expect(unblocked.lot.qualityStatus).toBe('RELEASED')
    expect(await eventsOf('lot.released', lotId)).toMatchObject([{ payload: { from: 'QUARANTINE' } }, { payload: { from: 'BLOCKED' } }])
    const { lotId: fresh } = await leatherLot()
    expect((await refused('inspector', 'POST', `/quality/lots/${fresh}/block`, { version: 1, reason: 'x' }, 409)).message).toContain('in quarantine')
  })
})

// ---- four eyes, failures, holds, documents ------------------------------------------------------------------------------------------

describe('who releases, and what is never released', () => {
  it('the person who received the lot never releases it, even with the quality role (design W3 (A))', async () => {
    const { lotId } = await leatherLot()
    await passed(lotId)
    const own = await release(lotId, 'receiver')
    expect(own.statusCode).toBe(409)
    expect(own.json().error.issues).toEqual([{ path: 'checks/RELEASER', message: 'You received this lot: another person with the quality role releases it (four eyes).' }])
    const view = await ok('receiver', 'GET', `/quality/lots/${lotId}/release-check`)
    expect(view.checklist.open.map((check: Json) => check.code)).toEqual(['RELEASER'])
    expect((await release(lotId, 'inspector')).statusCode).toBe(200)
  })

  it('a FAIL (at or above the limit) is final: never released, no new result, rejected with the typed code', async () => {
    const { lotId } = await leatherLot()
    const failed = await passed(lotId, { valueMgKg: '3.000' })
    expect(failed.result).toMatchObject({ verdict: 'FAIL', words: 'FAIL: 3 mg/kg is at or above the limit of 3 mg/kg: this lot cannot be used (REACH Annex XVII entry 47).' })
    expect(failed.effect).toContain('reject it')
    expect(await lotRow(lotId)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'FAIL', crViMgKg: '3.000' })
    expect(await unusable(lotId)).toEqual(['CR_VI_FAILED'])
    expect(pathsOf((await release(lotId)).json().error)).toEqual(['checks/CR_VI'])
    // No new result: the report cannot even be announced, and one sent with the earlier report is refused in words.
    expect((await refused('inspector', 'POST', `/quality/lots/${lotId}/results/report`, { originalName: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 409)).message).toContain('a FAIL is final')
    expect((await result(lotId, { valueMgKg: '0.5', fileId: failed.result.fileId })).json().error.message).toContain('a FAIL is final')
    const code = (await lotRow(lotId)).code as string
    expect(pathsOf(await refused('inspector', 'POST', `/quality/lots/${lotId}/reject`, { version: (await lotRow(lotId)).version, confirmCode: 'nope', reason: 'Cr VI fail.' }, 400))).toEqual(['body/confirmCode'])
    const rejected = await ok('inspector', 'POST', `/quality/lots/${lotId}/reject`, { version: (await lotRow(lotId)).version, confirmCode: code, reason: 'Cr VI fail: back to the tannery.' })
    expect(rejected.lot).toMatchObject({ qualityStatus: 'REJECTED', qualityNote: 'Cr VI fail: back to the tannery.' })
    expect(await eventsOf('lot.rejected', lotId)).toMatchObject([{ payload: { from: 'QUARANTINE' } }])
    expect((await refused('inspector', 'POST', `/quality/lots/${lotId}/reject`, { version: (await lotRow(lotId)).version, confirmCode: code, reason: 'again' }, 409)).message).toContain('rejected already')
  })

  it('"not detected" below a detection limit at the limit passes; a value with four decimals or no lab is refused, all at once', async () => {
    const { lotId } = await leatherLot()
    const bad = await result(lotId, { valueMgKg: '1.2345', lab: ' ', method: 'ISO 0000' })
    expect(bad.statusCode).toBe(400)
    expect(pathsOf(bad.json().error)).toEqual(['body/method', 'body/valueMgKg', 'body/lab'])
    const lod = await passed(lotId, { valueMgKg: null, belowDetectionLimit: true, detectionLimitMgKg: '3' })
    expect(lod.result).toMatchObject({ verdict: 'PASS', valueMgKg: null, belowDetectionLimit: true, detectionLimitMgKg: '3.000' })
    expect(await lotRow(lotId)).toMatchObject({ crViStatus: 'PASS', crViMgKg: null })
  })

  it('a later FAIL on a lot still in quarantine supersedes its PASS: the lot is never released', async () => {
    const { lotId } = await leatherLot()
    const first = await passed(lotId)
    const later = await passed(lotId, { valueMgKg: '4.1', lab: 'Test Lab Two', reportNumber: 'TL2-77' })
    expect(later.result).toMatchObject({ verdict: 'FAIL', supersedesId: first.result.id })
    expect(later.effect).toContain('never released')
    expect(later.trace).toBeNull()
    expect(await lotRow(lotId)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'FAIL', crViMgKg: '4.100' })
    const listed = (await ok('inspector', 'GET', `/quality/lots/${lotId}/results`)).results
    expect(listed.map((row: Json) => [row.verdict, row.superseded])).toEqual([['FAIL', false], ['PASS', true]])
  })

  it('a later FAIL on a RELEASED lot blocks it and traces the work orders it went to (the issue ledger)', async () => {
    const before = await lotRow(A.seedLot)
    expect(before).toMatchObject({ qualityStatus: 'RELEASED', crViStatus: 'PASS' })
    const later = await passed(A.seedLot, { valueMgKg: '3.5', lab: 'Test Lab Two', reportNumber: 'TL2-1' })
    expect(later.lot).toMatchObject({ qualityStatus: 'BLOCKED', crVi: { status: 'FAIL', valueMgKg: '3.500' } })
    expect(later.trace.workOrders).toEqual([expect.objectContaining({ workOrderId: A.workOrder, number: 'SEED-WO-0001', hideIds: [A.seedHide], returned: '0.0000' })])
    expect(later.lot.qualityNote).toBe('Chromium VI FAIL on later evidence (Test Lab Two, report TL2-1): FAIL: 3.5 mg/kg is at or above the limit of 3 mg/kg: this lot cannot be used (REACH Annex XVII entry 47).')
    expect(await eventsOf('lot.blocked', A.seedLot)).toMatchObject([{ payload: { cause: 'CR_VI_FAIL', workOrderIds: [A.workOrder] } }])
    expect(await eventsOf('lot.test_recorded', A.seedLot)).toMatchObject([{ payload: { verdict: 'FAIL', laterFail: true, qualityStatus: 'BLOCKED' } }])
    expect(await unusable(A.seedLot)).toEqual(['CR_VI_FAILED'])
    // Never released again: a Cr VI FAIL has no override.
    const unblock = await refused('inspector', 'POST', `/quality/lots/${A.seedLot}/unblock`, { version: (await lotRow(A.seedLot)).version, reason: 'Try.' }, 409)
    expect(pathsOf(unblock)).toEqual(['checks/CR_VI'])
  })

  it("a reversed receipt's lot is never released (and takes no result)", async () => {
    const { lotId, receiptId } = await leatherLot()
    await passed(lotId)
    const receipt = (await admin<{ version: number }>('SELECT version FROM "GoodsReceipt" WHERE id = $1', [receiptId]))[0]!
    await ok('receiver', 'POST', `/inventory/receipts/${receiptId}/reverse`, { version: receipt.version, reason: 'Wrong order received.' }, 201)
    expect((await lotRow(lotId)).qualityStatus).toBe('REJECTED')
    const held = await release(lotId)
    expect(held.statusCode).toBe(409)
    expect(pathsOf(held.json().error)).toEqual(['checks/STATE', 'checks/RECEIPT'])
    expect((await refused('inspector', 'POST', `/quality/lots/${lotId}/results/report`, { originalName: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) }, 409)).message).toContain('rejected')
  })

  it("the receiver's hold: release held until another quality person clears it with what was found", async () => {
    const lotId = await lotOf(A.lining, A.liningGRY, '40', 'M', { holdReason: 'Wet cartons' })
    expect(await lotRow(lotId)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'NOT_REQUIRED', qualityNote: 'Wet cartons' })
    expect(await unusable(lotId)).toEqual(['QUALITY_HOLD'])
    const held = await release(lotId)
    expect(held.json().error.issues).toEqual([{ path: 'checks/HOLD', message: 'Held at receipt: Wet cartons Check what the receiver held it for, then clear the hold with what you found.' }])
    expect((await refused('receiver', 'POST', `/quality/lots/${lotId}/hold/clear`, { version: (await lotRow(lotId)).version, reason: 'Dry now.' }, 409)).message).toContain('four eyes')
    const cleared = await ok('inspector', 'POST', `/quality/lots/${lotId}/hold/clear`, { version: (await lotRow(lotId)).version, reason: 'Rolls dried; no stain.' })
    expect(cleared).toMatchObject({ lot: { hold: null }, checklist: { ready: true } })
    expect(await auditOf(lotId, 'quality.lots.clearHold')).toMatchObject([{ reason: 'Rolls dried; no stain.', before: { hold: 'Wet cartons' }, after: { hold: null } }])
    expect((await release(lotId)).statusCode).toBe(200)
    expect(await unusable(lotId)).toEqual([])
  })
})

describe('supplier documents of a certified PPE component (QHS-030)', () => {
  it('held without the supplier document, though the register covers the component; released once a valid one is attached', async () => {
    const lotId = await lotOf(A.protector, null, '24', 'PCS')
    const before = await ok('inspector', 'GET', `/quality/lots/${lotId}/release-check`)
    expect(before.checklist.checks.filter((check: Json) => check.state !== 'NOT_NEEDED').map((check: Json) => [check.code, check.state])).toEqual([
      ['STATE', 'OK'],
      ['RECEIPT', 'OK'],
      ['PPE_CERTIFICATE', 'OK'],
      ['SUPPLIER_DOCUMENTS', 'OPEN'],
      ['RELEASER', 'OK'],
    ])
    expect(before.checklist.checks.find((check: Json) => check.code === 'PPE_CERTIFICATE').words).toBe('Certificate SEED-CERT-0002 (EN 1621-1:2012) covers the component, valid to 2030-05-31.')
    expect(pathsOf((await release(lotId)).json().error)).toEqual(['checks/SUPPLIER_DOCUMENTS'])

    // An expired one is refused at once; the generic files route may not slip a lot's certificate in.
    const fileId = await uploaded('buyer', lotId, 'documents/upload', 'supplier declaration')
    expect(pathsOf(await refused('buyer', 'POST', `/quality/lots/${lotId}/documents`, { fileId, kind: 'PPE_CERTIFICATE', validTo: '2020-01-01' }, 400))).toEqual(['body/validTo'])
    const generic = await call('inspector', 'POST', '/files', { companyId: A.companyA, recordType: 'Lot', recordId: lotId, kind: 'CERTIFICATE', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) })
    expect(generic.statusCode).toBe(409)
    expect(generic.json().error.message).toContain('POST /quality/lots/:lotId/documents/upload')

    const attached = await ok('buyer', 'POST', `/quality/lots/${lotId}/documents`, { fileId, kind: 'PPE_CERTIFICATE', validTo: '2030-12-31' }, 201)
    expect(attached.documents).toMatchObject([{ kind: 'PPE_CERTIFICATE', validTo: '2030-12-31', inForce: true, file: { status: 'AVAILABLE' } }])
    expect(attached.checklist).toMatchObject({ ready: true })
    expect(await eventsOf('lot.document_attached', lotId)).toMatchObject([{ payload: { kind: 'PPE_CERTIFICATE', fileId } }])
    expect((await refused('buyer', 'POST', `/quality/lots/${lotId}/documents`, { fileId, kind: 'PPE_CERTIFICATE' }, 409)).message).toContain('attached to the lot already')
    expect((await release(lotId)).statusCode).toBe(200)
  })
})

describe('the Cr VI evidence rule is a setting (Q14)', () => {
  let supplierLot: string
  let supplierFile: string

  it("under the default (a): a supplier report covering the article and the period counts, and can be reused for another lot of the article", async () => {
    ;({ lotId: supplierLot } = await leatherLot())
    const period = { evidence: 'SUPPLIER_REPORT', article: 'Seed cowhide black', periodFrom: '2026-01-01', periodTo: '2026-12-31' }
    const outside = await result(supplierLot, { valueMgKg: '1.1', ...period, periodTo: '2026-01-31' })
    expect(pathsOf(outside.json().error)).toEqual(['body/periodTo'])
    const first = await passed(supplierLot, { valueMgKg: '1.1', ...period })
    supplierFile = first.result.fileId
    expect(first.result).toMatchObject({ evidence: 'SUPPLIER_REPORT', article: 'Seed cowhide black', periodFrom: '2026-01-01', periodTo: '2026-12-31' })
    const { lotId: other } = await leatherLot()
    const reused = await passed(other, { valueMgKg: '1.1', ...period, fileId: supplierFile })
    expect(reused.result.fileId).toBe(supplierFile)
    // Not as a lot report, and never for another article.
    expect(pathsOf((await result(other, { valueMgKg: '1.1', fileId: supplierFile })).json().error)).toEqual(['body/fileId'])
    const lining = await lotOf(A.lining, A.liningGRY, '10', 'M')
    expect((await call('inspector', 'POST', `/quality/lots/${lining}/results`, { version: 1, testedOn: today(), ...RESULT, valueMgKg: '1', fileId: supplierFile })).statusCode).toBe(409)
  })

  it('tightening to (b) needs no step-up: a supplier report then no longer counts, and a lot that rests on one is held', async () => {
    const read = await ok('viewer', 'GET', '/quality/settings')
    expect(read.settings).toMatchObject({ companyId: null, crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', source: 'DEFAULT', version: 0, legalLimitMgKg: '3.000' })
    expect((await refused('inspector', 'PUT', '/quality/settings', { crViEvidenceRule: 'LOT_REPORT_REQUIRED', version: 0 }, 403)).code).toBe('forbidden')
    expect((await refused('rulesB', 'PUT', '/quality/settings', { crViEvidenceRule: 'LOT_REPORT_REQUIRED', version: 0 }, 403)).message).toContain('every company')
    const saved = await ok('rules', 'PUT', '/quality/settings', { crViEvidenceRule: 'LOT_REPORT_REQUIRED', version: 0 })
    expect(saved).toMatchObject({ previousRule: 'SUPPLIER_REPORT_ACCEPTED', settings: { crViEvidenceRule: 'LOT_REPORT_REQUIRED', source: 'TENANT', version: 1 } })
    expect(await admin('SELECT payload FROM "OutboxEvent" WHERE type = \'quality.settings_changed\' AND subject = $1', [A.tenant])).toMatchObject([{ payload: { crViEvidenceRule: 'LOT_REPORT_REQUIRED', previousRule: 'SUPPLIER_REPORT_ACCEPTED', loosened: false } }])
    expect((await refused('rules', 'PUT', '/quality/settings', { crViEvidenceRule: 'LOT_REPORT_REQUIRED', version: 0 }, 409)).issues).toEqual([{ path: 'version', message: 'The current version is 1.' }])

    const check = await ok('inspector', 'GET', `/quality/lots/${supplierLot}/release-check`)
    expect(check.checklist.open.map((entry: Json) => entry.code)).toEqual(['CR_VI'])
    const { lotId } = await leatherLot()
    expect(pathsOf((await result(lotId, { valueMgKg: '1', evidence: 'SUPPLIER_REPORT', article: 'x', periodFrom: '2026-01-01', periodTo: '2026-12-31' })).json().error)).toEqual(['body/evidence'])
    expect((await ok('viewer', 'GET', `/quality/settings?companyId=${A.companyA}`)).settings).toMatchObject({ crViEvidenceRule: 'LOT_REPORT_REQUIRED', source: 'TENANT', version: 0 })
  })

  it('loosening back to (a) asks for the reason and a fresh step-up (the real office sign-in with two-factor)', async () => {
    expect(pathsOf(await refused('rules', 'PUT', '/quality/settings', { crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', version: 1 }, 400))).toEqual(['body/reason'])
    const tenant: TestTenant = { id: A.tenant, slug: ns.a, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }
    const user = await addUser(h, tenant, { email: 'owner.lab@example.com' })
    await addRole(h, tenant, user.id, 'owner')
    const browser = new Browser(h.app)
    expect((await browser.signIn(tenant.slug, user.email, user.password)).body.status).toBe('signed_in')
    const secret = await enrolTotp(h, browser)
    const put = (body: Json) => browser.send('PUT' as 'POST', '/quality/settings', body)
    const noStepUp = await put({ crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', version: 1, reason: 'The tanneries send yearly reports (Q14 a).' })
    expect(noStepUp.status, JSON.stringify(noStepUp.body)).toBe(403)
    expect(noStepUp.body.error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
    await stepUp(h, browser, secret)
    const loosened = await put({ crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', version: 1, reason: 'The tanneries send yearly reports (Q14 a).' })
    expect(loosened.status, JSON.stringify(loosened.body)).toBe(200)
    expect(loosened.body).toMatchObject({ previousRule: 'LOT_REPORT_REQUIRED', settings: { crViEvidenceRule: 'SUPPLIER_REPORT_ACCEPTED', version: 2 } })
    expect(await admin('SELECT reason FROM "AuditLog" WHERE action = \'quality.settingsSaved\' AND "recordId" = $1 ORDER BY at', [A.tenant])).toEqual([{ reason: null }, { reason: 'The tanneries send yearly reports (Q14 a).' }])
    expect((await ok('inspector', 'GET', `/quality/lots/${supplierLot}/release-check`)).checklist.ready).toBe(true)
  })
})

describe('the walls', () => {
  it('another company, another tenant, a read-only person, the floor and no session are kept out', async () => {
    const { lotId } = await leatherLot()
    for (const session of ['companyB', 'otherTenant']) {
      expect((await call(session, 'GET', `/quality/lots/${lotId}`)).statusCode).toBe(404)
      expect((await call(session, 'POST', `/quality/lots/${lotId}/release`, { version: 1, confirmCode: 'x' })).statusCode).toBe(404)
    }
    expect((await call('viewer', 'GET', `/quality/lots/${lotId}`)).statusCode).toBe(200)
    expect((await call('viewer', 'POST', `/quality/lots/${lotId}/release`, { version: 1, confirmCode: 'x' })).statusCode).toBe(403)
    expect((await call('viewer', 'POST', `/quality/lots/${lotId}/results/report`, { originalName: 'r.pdf', contentType: 'application/pdf', sizeBytes: 10, sha256: 'a'.repeat(64) })).statusCode).toBe(403)
    expect((await call('floor', 'GET', `/quality/lots/${lotId}`)).statusCode).toBe(403)
    expect((await call('floor', 'POST', `/quality/lots/${lotId}/release`, { version: 1, confirmCode: 'x' })).statusCode).toBe(403)
    expect((await app.inject({ method: 'GET', url: `/quality/lots/${lotId}` })).statusCode).toBe(401)
    expect((await lotRow(lotId)).qualityStatus).toBe('QUARANTINE')
  })
})
