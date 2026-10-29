import { createHash, randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { applyPlan, planImport } from '../../../platform/imports/worker'

/**
 * Opening stock with the existing test reports (B-W1-35; SCM-288, QHS-029; REACH Annex XVII entry 47; PLAN R-14) on the
 * local stack, with the app's real routes and the imports platform's real dry run and apply: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security, the column grants, the Lot, Hide, StockMove and
 * LabResult triggers are real), the auth harness's local file store behind the files seed's FAKE R2 account, and the
 * factory-db seeds of two tenants (the black and red cowhide by the hide that needs the chromium VI test, the grey lining
 * in metres, the certified protector with its EN 1621-1 certificate in the register, LOT series per company). The people
 * are Users with one custom role each (the dry run judges rows for the live roles of the person who started it, the
 * apply for the one who applies) and the same grants in their test session. Every name, number, lab and value is made
 * up. Run with `node scripts/factory/run-pg-tests.mjs inventory/opening`.
 */

let h: Harness
let app: FastifyInstance

const ns = { a: 'opening-a', b: 'opening-b' } as const
const idOf = (namespace: string, key: string) => seedUuid(namespace, key)
const A = {
  tenant: idOf(ns.a, 'tenant'),
  companyA: idOf(ns.a, 'company:A'),
  companyB: idOf(ns.a, 'company:B'),
  siteA1: idOf(ns.a, 'site:A1'),
  leather: idOf(ns.a, 'product:item:leather'),
  lining: idOf(ns.a, 'product:item:lining'),
  protector: idOf(ns.a, 'product:item:protector'),
}
const B = { tenant: idOf(ns.b, 'tenant'), companyA: idOf(ns.b, 'company:A'), siteA1: idOf(ns.b, 'site:A1') }
const siteA2 = newId()

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const QUALITY: Permission[] = ['quality.lots.view', 'quality.lots.test', 'quality.lots.documents', 'quality.lots.release', 'quality.lots.reject']
const OPENING: Permission[] = ['inventory.opening.import', 'inventory.stock.view']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly grains: readonly 'cost'[]
  readonly companies: 'all' | readonly string[]
  readonly sites?: readonly string[]
}
const PEOPLE: Record<string, Person> = {
  /** Imports the stock with its reports AND holds the quality role: the four-eyes rule, not a permission, stops their release. */
  importer: { tenantId: A.tenant, permissions: [...OPENING, ...IMPORTS, ...QUALITY], grains: ['cost'], companies: 'all' },
  inspector: { tenantId: A.tenant, permissions: [...QUALITY, 'files.upload', 'files.read', 'inventory.stock.view'], grains: [], companies: 'all' },
  /** The warehouse: imports stock, no money, no lab results. */
  warehouse: { tenantId: A.tenant, permissions: [...OPENING, ...IMPORTS], grains: [], companies: 'all' },
  /** Company A, site A2 only. */
  siteA2: { tenantId: A.tenant, permissions: [...OPENING, ...IMPORTS, ...QUALITY], grains: ['cost'], companies: [A.companyA], sites: [siteA2] },
  /** Company B only. */
  companyB: { tenantId: A.tenant, permissions: [...OPENING, ...IMPORTS, ...QUALITY], grains: ['cost'], companies: [A.companyB] },
  otherTenant: { tenantId: B.tenant, permissions: [...OPENING, ...IMPORTS, ...QUALITY], grains: ['cost'], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions, ...person.grains.map((grain) => `money.${grain}` as Permission)], companies: person.companies, sites: person.sites ?? 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let counter = 0
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': `opening-${run}-${++counter}` }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const system = (tenantId = A.tenant): CommandCaller => callerFor(h.database, systemContext(tenantId, newId()))
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')
const daysAgo = (days: number) => businessDate(new Date(Date.now() - days * 86_400_000))
const italian = (day: string) => day.split('-').reverse().join('/')

/** A report's PDF (made up) into the company's opening-stock reports: announced, sent, confirmed. */
async function report(session: string, companyId: string, name: string): Promise<string> {
  const body = Buffer.from(`%PDF-1.4\n% made-up Cr VI report ${name} ${newId()}\n%%EOF\n`)
  const announced = await ok(session, 'POST', '/inventory/opening/reports', { companyId, originalName: name, contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) }, 201)
  expect(announced.file).toMatchObject({ recordType: 'OpeningStock', recordId: companyId, kind: 'CERTIFICATE', status: 'PENDING_UPLOAD' })
  const sent = await app.inject({ method: 'PUT', url: announced.upload.url, headers: announced.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  expect((await ok(session, 'POST', `/inventory/opening/reports/${announced.file.id}/complete`)).file).toMatchObject({ status: 'AVAILABLE' })
  return announced.file.id
}

/** POST /imports with the sheet, send it, confirm it, run the dry run as the worker does: the job. */
async function dryRun(session: string, body: Buffer, companyId = A.companyA, kind: 'csv' | 'xlsx' = 'csv'): Promise<Json> {
  const started = await ok(session, 'POST', '/imports', {
    importerKey: 'inventory.opening',
    companyId,
    file: { originalName: `opening.${kind}`, contentType: SHEET_TYPES[kind], sizeBytes: body.length, sha256: sha(body) },
  }, 201)
  const sent = await app.inject({ method: 'PUT', url: started.upload.url, headers: started.upload.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  await ok(session, 'POST', `/files/${started.job.fileId}/complete`)
  await planImport(system(PEOPLE[session]!.tenantId), started.job.id, { lastAttempt: true })
  return (await ok(session, 'GET', `/imports/${started.job.id}`)).job
}
async function applied(session: string, job: Json): Promise<Json> {
  await ok(session, 'POST', `/imports/${job.id}/apply`, { version: job.version })
  await applyPlan(system(PEOPLE[session]!.tenantId), job.id, { lastAttempt: true })
  return (await ok(session, 'GET', `/imports/${job.id}`)).job
}
const rowsOf = async (jobId: string, session = 'importer'): Promise<Json[]> => (await ok(session, 'GET', `/imports/${jobId}/rows`)).rows
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')

/** What tenant A's stock tables hold (the dry run writes none of it). */
const counts = async () =>
  (
    await admin<Json>(
      `SELECT (SELECT count(*) FROM "Lot" WHERE "tenantId" = $1)::int AS lots, (SELECT count(*) FROM "Hide" WHERE "tenantId" = $1)::int AS hides,
              (SELECT count(*) FROM "StockMove" WHERE "tenantId" = $1)::int AS moves, (SELECT count(*) FROM "LabResult" WHERE "tenantId" = $1)::int AS results,
              (SELECT count(*) FROM "StockValuation" WHERE "tenantId" = $1)::int AS valuations`,
      [A.tenant],
    )
  )[0]!
const openingLot = async (supplierLotRef: string) =>
  (
    await admin<Json>(
      `SELECT id, code, "qualityStatus"::text AS "qualityStatus", "crViStatus"::text AS "crViStatus", "crViMgKg"::text AS "crViMgKg", "crViEvidence"::text AS "crViEvidence",
              "receiptLineId", "createdById", "qualityDecidedById", version, (SELECT count(*) FROM "Hide" WHERE "lotId" = l.id)::int AS hides
         FROM "Lot" l WHERE "tenantId" = $1 AND "supplierLotRef" = $2`,
      [A.tenant, supplierLotRef],
    )
  )[0]!
const lotRow = async (lotId: string) => (await admin<Json>('SELECT code, version FROM "Lot" WHERE id = $1', [lotId]))[0]!
const release = async (lotId: string, session: string) => {
  const row = await lotRow(lotId)
  return call(session, 'POST', `/quality/lots/${lotId}/release`, { version: row.version, confirmCode: row.code })
}

// ---- the sheet: leather hides one per row and a lot in one row, a lining in metres, protectors per piece -----------------------

const TESTED = daysAgo(30)
const HEADER = ['Riga', 'Sito', 'Ubicazione', 'Articolo', 'Colore', 'Lotto', 'Quantità', 'UM', 'Aree pelli', 'Pelli', 'Numero pelle', 'Costo unitario', 'Cromo VI', 'Metodo', 'Laboratorio', 'N rapporto', 'Data prova', 'File rapporto', 'Certificato']
const GOLDEN: (string | number | Date | null)[][] = [
  // Two hides of dye batch DB-1 with the lab's PASS report on the lot (the same report on each row); the first with its cost.
  ['CS-0001', 'A1', 'A1-STORE', 'SEED-LEA-100', 'BLK', `DB-1-${run}`, 5.2, 'mq', null, null, 'T-1', '2,5', '1,2', 'EN ISO 17075-1', 'Example Lab', 'EL-1', italian(TESTED), 'cr6-db-1.pdf', null],
  ['CS-0002', 'A1', 'A1-STORE', 'SEED-LEA-100', 'BLK', `DB-1-${run}`, 4.85, 'M2', null, null, 'T-2', null, '1,2', 'EN ISO 17075-1', 'Example Lab', 'EL-1', italian(TESTED), 'cr6-db-1.pdf', null],
  // Dye batch DB-2: three hides in one row, no report yet.
  ['CS-0003', 'A1', 'A1-STORE', 'SEED-LEA-100', 'RED', `DB-2-${run}`, null, 'FT2', '50; 52,5; 48,25', 3, null, null, null, null, null, null, null, null, null],
  // A lining lot in metres: no test, no certificate: usable at once, as a receipt would make it.
  ['CS-0010', 'A1', 'A1-STORE', 'SEED-LIN-200', 'GRY', `R-77-${run}`, 120, 'mt', null, null, null, null, null, null, null, null, null, null, null],
  // Certified protectors per piece, with their certificate in the register: wait for the supplier's document.
  ['CS-0020', 'A1', 'A1-STORE', 'SEED-PRO-300', null, `P-1-${run}`, 24, 'pz', null, null, null, null, null, null, null, null, null, null, 'SEED-CERT-0002'],
  // Refused rows: a unit the lining does not convert, a material that does not exist, a negative quantity.
  ['CS-0030', 'A1', 'A1-STORE', 'SEED-LIN-200', 'GRY', 'R-78', 10, 'kg', null, null, null, null, null, null, null, null, null, null, null],
  ['CS-0031', 'A1', 'A1-STORE', 'NO-SUCH-ITEM', null, 'X-1', 10, 'pz', null, null, null, null, null, null, null, null, null, null, null],
  ['CS-0032', 'A1', 'A1-STORE', 'SEED-LIN-200', 'GRY', 'R-79', '-3', 'mt', null, null, null, null, null, null, null, null, null, null, null],
]

async function workbook(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('Giacenze')
  sheet.addRow(HEADER)
  for (const row of rows) sheet.addRow(row)
  return Buffer.from(await book.xlsx.writeBuffer())
}

beforeAll(async () => {
  h = await startHarness('inventory_opening')
  for (const namespace of [ns.a, ns.b]) await seedCore({ db: h.database, namespace })
  for (const namespace of [ns.a, ns.b]) {
    await seedProduction({ db: h.database, namespace })
    await seedNumbering({ db: h.database, namespace })
    await seedCompliance({ db: h.database, namespace })
    await seedFiles({ db: h.database, namespace })
  }
  // The files seed's store account keeps the default rate (10 calls at once): this file announces and confirms many.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE provider = 'R2'`)
  // A second site of company A, for the site wall.
  await admin(`INSERT INTO "Site" (id, "tenantId", "companyId", code, name, kind) VALUES ($1, $2, $3, 'A2', 'Second plant', 'PLANT')`, [siteA2, A.tenant, A.companyA])
  await admin(`INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind) VALUES ($1, $2, $3, $4, 'A2-STORE', 'Store', 'WAREHOUSE')`, [newId(), A.tenant, A.companyA, siteA2])
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], person.tenantId, `${key}-${run}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, person.tenantId, `custom.opening_${key.toLowerCase()}`, key, person.permissions, person.grains])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '1 day')`,
      [newId(), person.tenantId, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies, person.sites ?? []],
    )
  }
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

// ---- the golden import ------------------------------------------------------------------------------------------------------

describe('an opening stock sheet with the existing test reports (SCM-288, QHS-029)', () => {
  let job: Json
  let reportId: string
  let sheet: Buffer

  it('the dry run: every row planned or refused with its problems in words, and nothing written', async () => {
    reportId = await report('importer', A.companyA, 'cr6-db-1.pdf')
    sheet = await workbook(GOLDEN)
    const before = await counts()
    job = await dryRun('importer', sheet, A.companyA, 'xlsx')
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 8, createCount: 5, errorCount: 3, issues: null })
    expect(await counts()).toEqual(before)
    const rows = await rowsOf(job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'CREATE'],
      [4, 'CREATE'],
      [5, 'CREATE'],
      [6, 'CREATE'],
      [7, 'ERROR'],
      [8, 'ERROR'],
      [9, 'ERROR'],
    ])
    expect(rows[5]!.errors).toEqual([{ column: 'unit', message: 'Material SEED-LIN-200 does not convert KG to its stock unit M: give the quantity in M, CM, MM.' }])
    expect(rows[6]!.errors).toEqual([{ column: 'item', message: 'Material NO-SUCH-ITEM does not exist: import it with the materials first.' }])
    expect(rows[7]!.errors).toEqual([{ column: 'quantity', message: 'The quantity is above 0: opening stock is what lies there.' }])
    // The unit cost is the cost grain: the review shows it to whoever holds it.
    expect(rows[0]!.after).toMatchObject({ line: 'CS-0001', unit: 'M2', quantity: '5.2', unitCost: '2.5', crViMgKg: '1.2', testedOn: TESTED })
    expect(rows[2]!.after).toMatchObject({ areas: '50;52.5;48.25', hides: 3 })
  })

  it('the apply: lots, hides and OPENING moves; the PASS lot stays in QUARANTINE with its LabResult; the importer is its creator', async () => {
    job = await applied('importer', job)
    expect(job).toMatchObject({ status: 'APPLIED', appliedCount: 5, skippedCount: 0 })

    const db1 = await openingLot(`DB-1-${run}`)
    expect(db1).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'PASS', crViMgKg: '1.200', crViEvidence: 'LOT_REPORT', receiptLineId: null, createdById: IDS.importer, qualityDecidedById: null, hides: 2 })
    expect(db1.code).toMatch(/^L/)
    const [result] = await admin<Json>('SELECT verdict::text AS verdict, "valueMgKg"::text AS "valueMgKg", "limitMgKg"::text AS "limitMgKg", "fileId", "createdById", evidence::text AS evidence, lab FROM "LabResult" WHERE "lotId" = $1', [db1.id])
    expect(result).toEqual({ verdict: 'PASS', valueMgKg: '1.200', limitMgKg: '3.000', fileId: reportId, createdById: IDS.importer, evidence: 'LOT_REPORT', lab: 'Example Lab' })
    // The report is kept ten years (REACH art. 36).
    const [file] = await admin<Json>('SELECT "retainUntil" FROM "StoredFile" WHERE id = $1', [reportId])
    expect((file!.retainUntil as Date).getUTCFullYear()).toBeGreaterThanOrEqual(new Date().getUTCFullYear() + 10)

    expect(await openingLot(`DB-2-${run}`)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', hides: 3 })
    expect(await openingLot(`R-77-${run}`)).toMatchObject({ qualityStatus: 'RELEASED', crViStatus: 'NOT_REQUIRED', qualityDecidedById: IDS.importer, hides: 0 })
    expect(await openingLot(`P-1-${run}`)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'NOT_REQUIRED' })

    const moves = await admin<Json>(
      `SELECT "idempotencyKey", reason::text AS reason, quantity::text AS quantity, uom::text AS uom, "baseQuantity"::text AS "baseQuantity", reference, "hideId" IS NOT NULL AS hide
         FROM "StockMove" WHERE "tenantId" = $1 AND reason = 'OPENING' AND "idempotencyKey" LIKE 'inventory.opening:%' ORDER BY "idempotencyKey"`,
      [A.tenant],
    )
    const key = (line: string, n: number) => `inventory.opening:${A.companyA}:${line}:${n}`
    expect(moves).toEqual([
      { idempotencyKey: key('CS-0001', 1), reason: 'OPENING', quantity: '5.2000', uom: 'M2', baseQuantity: '55.9723', reference: 'CS-0001', hide: true },
      { idempotencyKey: key('CS-0002', 1), reason: 'OPENING', quantity: '4.8500', uom: 'M2', baseQuantity: '52.2050', reference: 'CS-0002', hide: true },
      { idempotencyKey: key('CS-0003', 1), reason: 'OPENING', quantity: '50.0000', uom: 'FT2', baseQuantity: '50.0000', reference: 'CS-0003', hide: true },
      { idempotencyKey: key('CS-0003', 2), reason: 'OPENING', quantity: '52.5000', uom: 'FT2', baseQuantity: '52.5000', reference: 'CS-0003', hide: true },
      { idempotencyKey: key('CS-0003', 3), reason: 'OPENING', quantity: '48.2500', uom: 'FT2', baseQuantity: '48.2500', reference: 'CS-0003', hide: true },
      { idempotencyKey: key('CS-0010', 1), reason: 'OPENING', quantity: '120.0000', uom: 'M', baseQuantity: '120.0000', reference: 'CS-0010', hide: false },
      { idempotencyKey: key('CS-0020', 1), reason: 'OPENING', quantity: '24.0000', uom: 'PCS', baseQuantity: '24.0000', reference: 'CS-0020', hide: false },
    ])

    // The cost grain: 2.50 €/m² is 0.232258 €/ft² (MANUAL, 55.9723 ft² → 13.00 €); without a unit cost, the standard cost.
    const values = await admin<Json>(
      `SELECT m."idempotencyKey", v.method::text AS method, v."unitCost"::text AS "unitCost", v."valueAmount" FROM "StockValuation" v JOIN "StockMove" m ON m.id = v."moveId"
        WHERE m."tenantId" = $1 AND m.reason = 'OPENING' ORDER BY m."idempotencyKey"`,
      [A.tenant],
    )
    expect(values.find((row) => row.idempotencyKey === key('CS-0001', 1))).toEqual({ idempotencyKey: key('CS-0001', 1), method: 'MANUAL', unitCost: '0.232258', valueAmount: 1300 })
    expect(values.find((row) => row.idempotencyKey === key('CS-0002', 1))).toMatchObject({ method: 'STANDARD_COST' })
    expect(values.find((row) => row.idempotencyKey === key('CS-0020', 1))).toMatchObject({ method: 'STANDARD_COST', unitCost: '6.500000', valueAmount: 15600 })

    const events = await admin<Json>(`SELECT type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type IN ('inventory.opening_posted', 'lot.test_recorded') ORDER BY "occurredAt", id`, [A.tenant])
    expect(events.map((event) => event.type).sort()).toEqual(['inventory.opening_posted', 'inventory.opening_posted', 'inventory.opening_posted', 'inventory.opening_posted', 'inventory.opening_posted', 'lot.test_recorded'])
    expect(events.find((event) => event.type === 'inventory.opening_posted' && event.payload.line === 'CS-0002')!.payload).toMatchObject({ jobId: job.id, newLot: false, qualityStatus: 'QUARANTINE', crViStatus: 'PASS', resultId: null })
  })

  it('the importer cannot release what they imported (four eyes); another quality person can, once its checks pass', async () => {
    const db1 = await openingLot(`DB-1-${run}`)
    const checklist = (await ok('inspector', 'GET', `/quality/lots/${db1.id}`)).checklist
    expect(checklist.checks.map((check: Json) => [check.code, check.state])).toEqual([
      ['STATE', 'OK'],
      ['RECEIPT', 'NOT_NEEDED'],
      ['CR_VI', 'OK'],
      ['PPE_CERTIFICATE', 'NOT_NEEDED'],
      ['SUPPLIER_DOCUMENTS', 'NOT_NEEDED'],
      ['HOLD', 'NOT_NEEDED'],
      ['RELEASER', 'OK'],
    ])
    const own = await release(db1.id, 'importer')
    expect(own.statusCode).toBe(409)
    expect(own.json().error.issues.map((issue: Json) => issue.path)).toEqual(['checks/RELEASER'])
    const pending = await release((await openingLot(`DB-2-${run}`)).id, 'inspector')
    expect(pending.statusCode).toBe(409)
    expect(pending.json().error.issues.map((issue: Json) => issue.path)).toEqual(['checks/CR_VI'])
    const released = await release(db1.id, 'inspector')
    expect(released.statusCode, released.body).toBe(200)
    expect(await openingLot(`DB-1-${run}`)).toMatchObject({ qualityStatus: 'RELEASED', qualityDecidedById: IDS.inspector })
  })

  it('the same file again posts nothing twice: its lines are UNCHANGED; a line with other values is refused', async () => {
    const before = await counts()
    const again = await dryRun('importer', sheet, A.companyA, 'xlsx')
    expect(again).toMatchObject({ status: 'PLANNED', createCount: 0, unchangedCount: 5, errorCount: 3 })
    expect(await applied('importer', again)).toMatchObject({ status: 'APPLIED', appliedCount: 0 })
    expect(await counts()).toEqual(before)

    const changed = await dryRun('importer', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM', `CS-0010;A1;A1-STORE;SEED-LIN-200;GRY;R-77-${run};125;M`]))
    expect((await rowsOf(changed.id))[0]!.errors).toEqual([
      { column: 'line', message: `Line CS-0010 was imported before (SEED-LIN-200 GRY, lot ${(await openingLot(`R-77-${run}`)).code} at A1 A1-STORE) with other values: a line is never posted twice. Correct the stock with an adjustment, or give this row a line of its own.` },
    ])
  })

  it('two dry runs of one sheet applied one after the other: the second one skips every line', async () => {
    const lines = ['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM', `CS-0100;A1;A1-STORE;SEED-LIN-200;GRY;R-90-${run};10;M`, `CS-0101;A1;A1-STORE;SEED-LIN-200;GRY;R-90-${run};5;M`]
    const first = await dryRun('importer', csv(lines))
    const second = await dryRun('importer', csv(lines))
    expect([first.createCount, second.createCount]).toEqual([2, 2])
    expect(await applied('importer', first)).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const before = await counts()
    expect(await applied('importer', second)).toMatchObject({ status: 'APPLIED', appliedCount: 0, skippedCount: 2 })
    expect(await counts()).toEqual(before)
    // Both lines made one lot: 15 m.
    const [lot] = await admin<Json>(`SELECT count(*)::int AS lots FROM "Lot" WHERE "tenantId" = $1 AND "supplierLotRef" = $2`, [A.tenant, `R-90-${run}`])
    expect(lot!.lots).toBe(1)
  })

  it('a later import adds hides to a lot still in quarantine, with its report; never to a lot released after the quality step', async () => {
    await report('importer', A.companyA, 'cr6-db-2.pdf')
    const later = await dryRun('importer', csv([
      'Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Cromo VI;Limite rilevabilità;Metodo;Laboratorio;Data prova;File rapporto',
      `CS-0004;A1;A1-STORE;SEED-LEA-100;RED;DB-2-${run};51;FT2;;0,5;EN ISO 17075-2;Example Lab;${italian(TESTED)};cr6-db-2.pdf`,
      `CS-0005;A1;A1-STORE;SEED-LEA-100;BLK;DB-1-${run};49;FT2;;;;;;`,
    ]))
    const rows = await rowsOf(later.id)
    expect(rows[0]!.action).toBe('CREATE')
    expect(rows[1]!.errors).toEqual([{ column: 'lot', message: `Lot ${(await openingLot(`DB-1-${run}`)).code} (DB-1-${run}) is released already: stock added to it would skip the quality step. Give these goods a lot code of their own.` }])
    await applied('importer', later)
    expect(await openingLot(`DB-2-${run}`)).toMatchObject({ qualityStatus: 'QUARANTINE', crViStatus: 'PASS', crViMgKg: null, hides: 4 })
  })

  it('the summary of the site: two numbers for leather, the lots that wait for release and why, values only with the cost grain', async () => {
    const summary = await ok('importer', 'GET', `/inventory/opening/summary?siteId=${A.siteA1}`)
    expect(summary.site).toMatchObject({ id: A.siteA1, code: 'A1' })
    const leatherBlack = summary.byMaterial.find((entry: Json) => entry.item.code === 'SEED-LEA-100' && entry.colour?.code === 'BLK')
    expect(leatherBlack).toMatchObject({ quantity: '108.1773', hides: 2, lots: 1, words: '2 hides · 108.1773 ft²' })
    expect(leatherBlack.value).toMatchObject({ currency: 'EUR' })
    expect(summary.waiting).toMatchObject({ lots: 2, hides: 4, byReason: { CR_VI_RESULT: 0, CR_VI_FAILED: 0, PPE_DOCUMENTS: 1, RELEASE: 1 } })
    expect(summary.waiting.words).toBe('2 opening lots wait for release: 1 for their PPE certificate and documents; 1 only for a quality person who did not import them to release them.')
    expect(summary.lots.find((lot: Json) => lot.supplierLotRef === `DB-2-${run}`)).toMatchObject({ waitsFor: 'RELEASE', hides: 4, importedById: IDS.importer })
    expect(summary.jobs.length).toBeGreaterThanOrEqual(5)
    const blind = await ok('warehouse', 'GET', `/inventory/opening/summary?siteId=${A.siteA1}`)
    expect(blind.value).toBeUndefined()
    expect(blind.byMaterial.every((entry: Json) => entry.value === undefined)).toBe(true)
    // Every line was valued (a unit cost or the standard cost); the count is no money, so everyone sees it.
    expect([summary.unvaluedLines, blind.unvaluedLines]).toEqual([0, 0])
  })
})

// ---- who may, and the walls -----------------------------------------------------------------------------------------------------

describe('who may import, and the tenant, company and site walls', () => {
  it('a sheet with report columns needs quality.lots.test; without the cost grain the unit cost column is refused', async () => {
    const withReport = await dryRun('warehouse', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Cromo VI', `W-1;A1;A1-STORE;SEED-LIN-200;GRY;W-1;1;M;`]))
    expect(withReport).toMatchObject({ status: 'FAILED' })
    expect(withReport.issues).toEqual([{ path: 'column/crViMgKg', message: "This sheet brings chromium VI reports: recording them needs quality.lots.test over the import's company (the lab step's permission)." }])
    const withCost = await dryRun('warehouse', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Costo unitario', `W-2;A1;A1-STORE;SEED-LIN-200;GRY;W-2;1;M;3`]))
    expect(withCost).toMatchObject({ status: 'FAILED', issues: [{ path: 'column/unitCost', message: expect.stringContaining('cost') }] })
    // Without those columns the warehouse imports; the standard cost values it.
    const plain = await dryRun('warehouse', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM', `W-3;A1;A1-STORE;SEED-LIN-200;GRY;W-3-${run};2;M`]))
    expect(await applied('warehouse', plain)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    expect(await openingLot(`W-3-${run}`)).toMatchObject({ createdById: IDS.warehouse })
    // A tenant-wide job is refused at the start.
    const body = csv(['Riga;Sito;Ubicazione;Articolo;UM;Quantità', 'W-4;A1;A1-STORE;SEED-LIN-200;M;1'])
    const wide = await call('importer', 'POST', '/imports', { importerKey: 'inventory.opening', file: { originalName: 'o.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha(body) } })
    expect(wide.statusCode).toBe(403)
    expect(wide.json().error.issues).toEqual([{ path: 'companyId', message: "Opening stock is a company's: start the import for one company." }])
  })

  it('a person of site A2 only: a row at site A1 is refused in the dry run; company B never sees company A', async () => {
    const job = await dryRun('siteA2', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM', `S-1;A1;A1-STORE;SEED-LIN-200;GRY;S-1;1;M`, `S-2;A2;A2-STORE;SEED-LIN-200;GRY;S-2-${run};1;M`]))
    const rows = await rowsOf(job.id, 'siteA2')
    expect(rows.map((row) => [row.action, row.errors])).toEqual([
      ['ERROR', [{ column: 'site', message: 'Your role does not reach site A1 for opening stock (inventory.opening.import).' }]],
      ['CREATE', null],
    ])
    expect((await call('companyB', 'POST', '/imports', { importerKey: 'inventory.opening', companyId: A.companyA, file: { originalName: 'o.csv', contentType: SHEET_TYPES.csv, sizeBytes: 10, sha256: sha(Buffer.from('0123456789')) } })).statusCode).toBe(403)
    // Company B's import: company A's site and report are not its own (the seed's materials are every company's).
    const other = await dryRun(
      'companyB',
      csv([
        'Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Cromo VI;Metodo;Laboratorio;Data prova;File rapporto',
        'B-1;A1;A1-STORE;SEED-LIN-200;GRY;B-1;1;M;;;;;',
        'B-2;B1;B1-STORE;SEED-LIN-200;GRY;B-2;1;M;;;;;',
        `B-3;B1;B1-STORE;SEED-LEA-100;BLK;B-3;50;FT2;1;EN ISO 17075-1;Example Lab;${italian(TESTED)};cr6-db-1.pdf`,
      ]),
      A.companyB,
    )
    expect((await rowsOf(other.id, 'companyB')).map((row) => row.errors)).toEqual([
      [{ column: 'site', message: 'Site A1 is not a site of this company.' }],
      null,
      [{ column: 'reportFile', message: 'No opening-stock report of this company is named cr6-db-1.pdf: upload it first.' }],
    ])
    expect((await call('companyB', 'GET', `/inventory/opening/reports?companyId=${A.companyA}`)).statusCode).toBe(404)
    expect((await call('companyB', 'GET', `/inventory/opening/summary?siteId=${A.siteA1}`)).statusCode).toBe(403)
  })

  it('another tenant sees nothing of it: not the reports, the summary, the jobs; its own import never reaches tenant A', async () => {
    expect((await call('otherTenant', 'GET', `/inventory/opening/summary?siteId=${A.siteA1}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'GET', `/inventory/opening/reports?companyId=${A.companyA}`)).json().reports ?? []).toEqual([])
    const job = await dryRun('otherTenant', csv(['Riga;Sito;Ubicazione;Articolo;Colore;Lotto;Quantità;UM;Cromo VI;Metodo;Laboratorio;Data prova;File rapporto', `T-1;A1;A1-STORE;SEED-LEA-100;BLK;T-1;5;FT2;1;EN ISO 17075-1;Lab;${italian(TESTED)};cr6-db-1.pdf`]), B.companyA)
    // Tenant B's own seed site and material; tenant A's report of that name is not found.
    expect((await rowsOf(job.id, 'otherTenant'))[0]!.errors).toEqual([{ column: 'reportFile', message: 'No opening-stock report of this company is named cr6-db-1.pdf: upload it first.' }])
    expect((await call('importer', 'GET', `/imports/${job.id}`)).statusCode).toBe(404)
  })

  it('the generic upload cannot add an opening-stock report (module-owned files)', async () => {
    const body = Buffer.from('%PDF-1.4\n%%EOF\n')
    const generic = await call('importer', 'POST', '/files', { companyId: A.companyA, recordType: 'OpeningStock', recordId: A.companyA, kind: 'CERTIFICATE', originalName: 'x.pdf', contentType: 'application/pdf', sizeBytes: body.length, sha256: sha(body) })
    expect(generic.statusCode).toBe(409)
    expect(generic.json().error.message).toContain('POST /inventory/opening/reports')
    // The reports list shows what rests on each.
    const reports = (await ok('importer', 'GET', `/inventory/opening/reports?companyId=${A.companyA}`)).reports as Json[]
    expect(reports.find((entry) => entry.originalName === 'cr6-db-1.pdf')).toMatchObject({ status: 'AVAILABLE', results: 1 })
  })

  it('the template: every column, made-up rows the import reads', async () => {
    const response = await call('warehouse', 'GET', '/inventory/opening/template')
    expect(response.statusCode).toBe(200)
    expect(response.headers['content-type']).toContain('text/csv')
    expect(response.body.split('\r\n')[0]).toMatch(/^Line;Site;Location;Material;Colour;Lot;/)
    const xlsx = await call('warehouse', 'GET', '/inventory/opening/template?format=xlsx&numberFormat=en')
    expect(xlsx.statusCode).toBe(200)
    expect(xlsx.headers['content-type']).toBe(SHEET_TYPES.xlsx)
    expect((await call('inspector', 'GET', '/inventory/opening/template')).statusCode).toBe(403)
  })
})
