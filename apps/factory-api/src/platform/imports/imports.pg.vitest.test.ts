import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { cell } from '@nexus/factory-domain/imports/cells'
import { defineImporter, markValues } from '@nexus/factory-domain/imports/importer'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles } from '../files/service'
import { createGateway } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { defineImportAdapter, useImporters } from './registry'
import { applyPlan, importHandlers, planImport } from './worker'

/**
 * Imports with a dry run on the local stack, with the app's real routes: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login, so row-level security is real), the gateway on the local Redis under this file's own
 * prefix, the local file store on a temporary folder (each tenant's FAKE R2 account). The worker's two steps are called
 * as the worker calls them (the handlers once, through the file.available event they handle).
 *
 * The importer is made up for this test only: "test.companies" over the Company table (W0 has no business tables), its
 * share capital standing in for a money column of the cost grain. Run with `node scripts/factory/run-pg-tests.mjs imports`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const user = newId()

// ---- the test importer --------------------------------------------------------------------------------------------------

const companies = defineImporter({
  key: 'test.companies',
  label: 'Companies (test)',
  columns: {
    code: { label: 'Code', aliases: ['codice'], required: true, type: cell.code({ upper: true, max: 20 }) },
    legalName: { label: 'Legal name', aliases: ['ragione sociale'], required: true, type: cell.text({ max: 200 }) },
    tradeName: { label: 'Trade name', aliases: ['insegna', 'nome commerciale'], type: cell.text({ max: 200 }) },
    fiscalYearStartMonth: { label: 'Fiscal year start month', aliases: ['mese inizio esercizio'], type: cell.integer({ min: 1, max: 12 }) },
    shareCapital: { label: 'Share capital', aliases: ['capitale sociale'], type: cell.decimal({ precision: 18, scale: 2 }), grain: 'cost' },
  },
  keyColumns: ['code'],
  batchSize: 2,
})

/** Test switches: a legal name whose write throws; a load that tries to write; a legal name the row check refuses. */
const switches = { failOn: null as string | null, writeInLoad: false, refuse: null as string | null, checked: [] as { rows: number; tenantId: string | undefined }[] }

const adapter = defineImportAdapter({
  importer: companies,
  permission: 'testco.write',
  viewPermission: 'testco.read',
  async load(client, keys) {
    if (switches.writeInLoad) await client.$executeRawUnsafe(`UPDATE "Company" SET "tradeName" = 'written by a dry run' WHERE code = 'HQ'`)
    const rows = await client.company.findMany({
      where: { code: { in: keys.map((key) => String(key.code)) } },
      select: { id: true, code: true, legalName: true, tradeName: true, fiscalYearStartMonth: true, shareCapital: true },
    })
    return rows.map((row) => ({
      id: row.id,
      values: { code: row.code, legalName: row.legalName, tradeName: row.tradeName, fiscalYearStartMonth: row.fiscalYearStartMonth, shareCapital: row.shareCapital?.toString() ?? null },
    }))
  },
  async check(client, rows, _scope, actor) {
    // Reads only, in the dry run's read-only transaction and the apply batch's command.
    await client.company.count()
    switches.checked.push({ rows: rows.length, tenantId: actor.tenantId })
    return rows.map((row) => (row.values.legalName !== undefined && row.values.legalName === switches.refuse ? [{ column: 'legalName', message: `Made-up check: row ${row.rowNumber} names a refused company.` }] : []))
  },
  async write(tools, row) {
    if (switches.failOn !== null && row.values.legalName === switches.failOn) throw new Error('made-up write failure')
    const values = row.values as Record<string, string | number | undefined>
    const data = {
      ...(values.legalName !== undefined ? { legalName: String(values.legalName) } : {}),
      ...(values.tradeName !== undefined ? { tradeName: String(values.tradeName) } : {}),
      ...(values.fiscalYearStartMonth !== undefined ? { fiscalYearStartMonth: Number(values.fiscalYearStartMonth) } : {}),
      ...(values.shareCapital !== undefined ? { shareCapital: String(values.shareCapital) } : {}),
    }
    if (row.action === 'CREATE') {
      const id = newId()
      await tools.tx.company.create({ data: { id, code: String(row.key.code), legalName: String(values.legalName), ...data }, select: { id: true } })
      tools.audit({ recordType: 'Company', recordId: id, action: 'test.importCompany', after: markValues(companies, row.values) })
      return { recordId: id }
    }
    await tools.tx.company.update({ where: { id: row.recordId! }, data: { ...data, version: { increment: 1 } }, select: { id: true } })
    tools.audit({ recordType: 'Company', recordId: row.recordId!, action: 'test.importCompany', before: markValues(companies, row.before), after: markValues(companies, row.values) })
    return { recordId: row.recordId! }
  },
})

// ---- sessions ---------------------------------------------------------------------------------------------------------

const ALL: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read', 'testco.write', 'testco.read', 'money.cost', 'money.price']
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, SessionContext> = {
  owner: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL)] },
  nocost: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL.filter((permission) => permission !== 'money.cost'))] },
  runner: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(ALL.filter((permission) => permission !== 'imports.apply'))] },
  viewer: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['imports.view', 'testco.read'])] },
  outsider: { audience: 'office', tenantId: tenantA, actorId: user, grants: [grant(['imports.view', 'imports.run', 'imports.apply', 'files.upload'])] },
  ownerB: { audience: 'office', tenantId: tenantB, actorId: user, grants: [grant(ALL)] },
}

// ---- helpers ----------------------------------------------------------------------------------------------------------

type Job = { id: string; fileId: string; status: string; version: number; rowCount: number; createCount: number; updateCount: number; unchangedCount: number; errorCount: number; appliedCount: number; skippedCount: number; issues: { path: string; message: string }[] | null; error: string | null; layout: any; mode: string }
type Row = { rowNumber: number; action: string; key: string | null; recordId: string | null; errors: { column?: string; message: string }[] | null; before: any; after: any; outcome: string | null; note: string | null }

const admin = async <T = Record<string, any>>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (tenantId = tenantA): CommandCaller => callerFor(database, systemContext(tenantId, newId()))
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')

const SHEET = [
  'Codice;Ragione sociale;Insegna;Mese inizio esercizio;Capitale sociale;Note',
  'new-1;Nuova S.r.l.;Nuova;4;1.234.567,89;da creare',
  'hq;Seed HQ S.r.l.;Sede;1;10.000,00;',
  'KEEP;Keep S.p.A.;;;;',
  'BAD;;;13;dieci;',
  'NEW-1;Duplicato;;;;',
]

/** POST /imports, send the bytes, confirm the upload: an UPLOADED job whose sheet is AVAILABLE. */
async function upload(session: string, body: Buffer, fields: Record<string, unknown> = {}, file: Record<string, unknown> = {}): Promise<Job> {
  const started = await call(session, 'POST', '/imports', {
    importerKey: 'test.companies',
    file: { originalName: 'aziende.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body), ...file },
    ...fields,
  })
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload: presigned } = started.json() as { job: Job; upload: { url: string; headers: Record<string, string> } }
  const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  const confirmed = await call(session, 'POST', `/files/${job.fileId}/complete`)
  expect(confirmed.statusCode, confirmed.body).toBe(200)
  return job
}
const getJob = async (jobId: string, session = 'owner'): Promise<Job> => {
  const response = await call(session, 'GET', `/imports/${jobId}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().job
}
const rowsOf = async (jobId: string, session = 'owner', query = ''): Promise<Row[]> => {
  const response = await call(session, 'GET', `/imports/${jobId}/rows${query}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().rows
}
const planned = async (session: string, body: Buffer, fields: Record<string, unknown> = {}): Promise<Job> => {
  const job = await upload(session, body, fields)
  await planImport(system(), job.id, { lastAttempt: true })
  return getJob(job.id)
}
const applied = async (job: Job, session = 'owner'): Promise<Job> => {
  const response = await call(session, 'POST', `/imports/${job.id}/apply`, { version: job.version })
  expect(response.statusCode, response.body).toBe(200)
  await applyPlan(system(), job.id, { lastAttempt: true })
  return getJob(job.id)
}
const companiesOf = (tenantId = tenantA) =>
  admin<{ code: string; legalName: string; tradeName: string | null; fiscalYearStartMonth: number; shareCapital: string | null; version: number; updatedAt: Date }>(
    'SELECT code, "legalName", "tradeName", "fiscalYearStartMonth", "shareCapital"::text AS "shareCapital", version, "updatedAt" FROM "Company" WHERE "tenantId" = $1 ORDER BY code',
    [tenantId],
  )
const eventsOf = async (jobId: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [jobId])).map((event) => event.type)

beforeAll(async () => {
  db = await migratedDatabase('imports')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-imports-test-'))
  for (const [tenantId, slug, companyId] of [
    [tenantA, 'imports-a', companyA],
    [tenantB, 'imports-b', companyB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName") VALUES ($1, $2, $3, $3)', [companyId, tenantId, `${slug}-main`])
    await admin(
      `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`,
      [newId(), tenantId],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([adapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 60_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

beforeEach(async () => {
  switches.failOn = null
  switches.writeInLoad = false
  switches.refuse = null
  switches.checked = []
  // Each test starts from the same records: HQ (to update) and KEEP (unchanged), nothing else of the test's codes.
  await admin(`DELETE FROM "Company" WHERE "tenantId" = $1 AND id <> $2 AND id NOT IN (SELECT "companyId" FROM "ImportJob" WHERE "companyId" IS NOT NULL)`, [tenantA, companyA])
  await admin(
    `INSERT INTO "Company" (id, "tenantId", code, "legalName", "fiscalYearStartMonth", "shareCapital") VALUES ($1, $3, 'HQ', 'Seed HQ S.r.l.', 1, 10000), ($2, $3, 'KEEP', 'Keep S.p.A.', 1, NULL)`,
    [newId(), newId(), tenantA],
  )
})

describe('upload → dry run → review → apply (PLT-176)', () => {
  it('plans every row without writing a business row, then applies exactly the planned changes', async () => {
    const before = await companiesOf()
    const job = await upload('owner', csv(SHEET))
    expect(job).toMatchObject({ status: 'UPLOADED', mode: 'DRY_RUN' })

    // The worker's handler starts the dry run from the upload's file.available event.
    const [event] = await admin('SELECT * FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['file.available', job.fileId])
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
      occurredAt: (event!.occurredAt as Date).toISOString(),
      payload: event!.payload,
    }
    await importHandlers()[0]!.handle(envelope, { caller: system(), attempt: 1 })

    // Dry run: the plan, and not one business row written.
    expect(await companiesOf()).toEqual(before)
    const plannedJob = await getJob(job.id)
    expect(plannedJob).toMatchObject({ status: 'PLANNED', rowCount: 5, createCount: 1, updateCount: 1, unchangedCount: 1, errorCount: 2, issues: null })
    expect(plannedJob.layout).toMatchObject({ format: 'csv', delimiter: ';', encoding: 'utf-8', ignored: [{ header: 'Note', reason: 'unknown' }] })
    const rows = await rowsOf(job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([
      [2, 'CREATE'],
      [3, 'UPDATE'],
      [4, 'UNCHANGED'],
      [5, 'ERROR'],
      [6, 'ERROR'],
    ])
    expect(rows[0]).toMatchObject({ key: '["NEW-1"]', after: { code: 'NEW-1', legalName: 'Nuova S.r.l.', tradeName: 'Nuova', fiscalYearStartMonth: 4, shareCapital: '1234567.89' } })
    // 10.000,00 is the stored 10000: only the trade name changes.
    expect(rows[1]).toMatchObject({ key: '["HQ"]', before: { tradeName: null }, after: { tradeName: 'Sede' } })
    expect(rows[3]!.errors).toEqual([
      { column: 'legalName', message: 'Legal name is required.' },
      { column: 'fiscalYearStartMonth', message: 'Expected a whole number from 1 to 12.' },
      { column: 'shareCapital', message: 'Expected a number like 1.234,56 or 1234,56.' },
    ])
    expect(rows[4]!.errors).toEqual([{ message: 'The same Code as row 2; only the first one is imported.' }])
    expect(await eventsOf(job.id)).toEqual(['import.planned'])

    // The review hides the money column from a person without its grain.
    const forViewer = await rowsOf(job.id, 'viewer', '?action=CREATE')
    expect(forViewer[0]!.after).toEqual({ code: 'NEW-1', legalName: 'Nuova S.r.l.', tradeName: 'Nuova', fiscalYearStartMonth: 4 })
    const errorsFile = await call('viewer', 'GET', `/imports/${job.id}/errors`)
    expect(errorsFile.headers['content-type']).toMatch(/^text\/csv/)
    expect(errorsFile.body).toContain('5,Ragione sociale,Legal name is required.')
    expect(errorsFile.body).toContain('5,Capitale sociale,"Expected a number like 1.234,56 or 1234,56."')
    expect(errorsFile.body).not.toContain('dieci')

    // Apply: only with imports.apply, and only with the grain of every money column the sheet maps.
    expect((await call('runner', 'POST', `/imports/${job.id}/apply`, { version: plannedJob.version })).statusCode).toBe(403)
    const noGrain = await call('nocost', 'POST', `/imports/${job.id}/apply`, { version: plannedJob.version })
    expect(noGrain.statusCode).toBe(403)
    expect(noGrain.json().error.issues).toEqual([{ path: 'column/shareCapital', message: 'The column "Capitale sociale" holds cost values (the cost money grain), which may not be imported without that grain.' }])
    const done = await applied(plannedJob)
    expect(done).toMatchObject({ status: 'APPLIED', appliedCount: 2, skippedCount: 0 })
    expect(await eventsOf(job.id)).toEqual(['import.planned', 'import.apply_requested', 'import.applied'])

    const after = await companiesOf()
    expect(after.map((company) => [company.code, company.legalName, company.tradeName, company.fiscalYearStartMonth, company.shareCapital])).toEqual([
      ['HQ', 'Seed HQ S.r.l.', 'Sede', 1, '10000.00'],
      ['KEEP', 'Keep S.p.A.', null, 1, null],
      ['NEW-1', 'Nuova S.r.l.', 'Nuova', 4, '1234567.89'],
      ['imports-a-main', 'imports-a-main', null, 1, null],
    ])
    expect(after.find((company) => company.code === 'KEEP')).toEqual(before.find((company) => company.code === 'KEEP'))
    expect((await rowsOf(job.id, 'owner', '?outcome=APPLIED')).map((row) => row.rowNumber)).toEqual([2, 3])
    // Each written record has its audit row, the money value marked with its grain.
    const audit = await admin<{ after: any }>(`SELECT after FROM "AuditLog" WHERE action = 'test.importCompany' AND "tenantId" = $1 ORDER BY at, id`, [tenantA])
    expect(audit[0]!.after.shareCapital).toEqual({ $money: 'cost', value: '1234567.89' })

    // A second apply is refused; the worker leaves an applied job alone.
    expect((await call('owner', 'POST', `/imports/${job.id}/apply`, { version: done.version })).json().error.code).toBe('invalid_state')
    expect(await applyPlan(system(), job.id)).toBe('settled')

    // The same sheet again: everything is already there, so the new plan changes nothing and its apply writes nothing.
    const again = await planned('owner', csv(SHEET))
    expect(again).toMatchObject({ createCount: 0, updateCount: 0, unchangedCount: 3, errorCount: 2 })
    expect(await applied(again)).toMatchObject({ status: 'APPLIED', appliedCount: 0, skippedCount: 0 })
    expect(await companiesOf()).toEqual(after)
  })

  it('reads an Excel sheet by name: formulas as values, numbers as Excel stores them', async () => {
    const book = new ExcelJS.Workbook()
    book.addWorksheet('Istruzioni').addRow(['Compila il foglio Aziende'])
    const sheet = book.addWorksheet('Aziende')
    sheet.addRow(['Codice', 'Ragione sociale', 'Capitale sociale', 'Mese inizio esercizio'])
    sheet.addRow(['xl-1', 'Excel S.r.l.', { formula: '1000*12.5', result: 12500 }, 7])
    const body = Buffer.from(await book.xlsx.writeBuffer())
    const job = await upload('owner', body, { sheetName: 'aziende' }, { originalName: 'aziende.xlsx', contentType: SHEET_TYPES.xlsx })
    await planImport(system(), job.id)
    expect(await getJob(job.id)).toMatchObject({ status: 'PLANNED', createCount: 1, layout: { format: 'xlsx', sheet: 'Aziende', sheets: ['Istruzioni', 'Aziende'] } })
    expect((await rowsOf(job.id))[0]!.after).toEqual({ code: 'XL-1', legalName: 'Excel S.r.l.', shareCapital: '12500', fiscalYearStartMonth: 7 })
  })

  it('in mode APPLY, applies the valid rows as soon as the dry run is done', async () => {
    const job = await upload('owner', csv(['code;legal name', 'AUTO-1;Auto S.r.l.', 'AUTO-2;']), { mode: 'APPLY' })
    await planImport(system(), job.id)
    expect(await getJob(job.id)).toMatchObject({ status: 'APPLYING', createCount: 1, errorCount: 1 })
    expect(await applyPlan(system(), job.id)).toBe('applied')
    expect(await getJob(job.id)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    expect((await companiesOf()).map((company) => company.code)).toContain('AUTO-1')
    expect((await call('runner', 'POST', '/imports', { importerKey: 'test.companies', mode: 'APPLY', file: { originalName: 'a.csv', contentType: 'text/csv', sizeBytes: 1, sha256: 'a'.repeat(64) } })).statusCode).toBe(403)
  })
})

describe('what the engine refuses', () => {
  it('a dry run cannot write: the importer\'s load runs in a transaction that is rolled back and refused if it wrote', async () => {
    switches.writeInLoad = true
    const before = await companiesOf()
    const job = await upload('owner', csv(SHEET))
    await expect(planImport(system(), job.id)).rejects.toThrow(/wrote to the database while reading for a dry run/)
    expect(await getJob(job.id)).toMatchObject({ status: 'FAILED', error: 'The dry run failed: The importer wrote to the database while reading for a dry run; the write was undone.' })
    expect(await rowsOf(job.id)).toEqual([])
    expect(await companiesOf()).toEqual(before)
  })

  it('a money column the creator\'s grains do not cover: the sheet is refused, and nothing is planned', async () => {
    const job = await planned('nocost', csv(SHEET))
    expect(job).toMatchObject({ status: 'FAILED', error: 'The sheet cannot be imported as it is: see the issues.' })
    expect(job.issues).toEqual([{ path: 'column/shareCapital', message: 'The column "Capitale sociale" holds cost values (the cost money grain), which may not be imported without that grain.' }])
    expect(job.layout.headers).toEqual(['Codice', 'Ragione sociale', 'Insegna', 'Mese inizio esercizio', 'Capitale sociale', 'Note'])
    expect(await rowsOf(job.id)).toEqual([])
    expect(await eventsOf(job.id)).toEqual(['import.failed'])
    // The same person may ignore that column (a mapping override) and import the rest.
    const without = await planned('nocost', csv(SHEET), { mapping: { 'Capitale sociale': null } })
    expect(without).toMatchObject({ status: 'PLANNED', createCount: 1, errorCount: 2 })
  })

  it('a sheet without a required column, an unreadable sheet, too many rows', async () => {
    expect(await planned('owner', csv(['Codice;Insegna', 'A;b']))).toMatchObject({
      status: 'FAILED',
      issues: [{ path: 'column/legalName', message: 'The sheet has no column for Legal name, which is required.' }],
    })
    const bad = await planned('owner', Buffer.from('not a workbook'), {})
    expect(bad.status).toBe('FAILED')
    const many = ['code;legal name', ...Array.from({ length: 10_001 }, (_, index) => `C${index};X`)]
    expect((await planned('owner', csv(many))).issues![0]!.message).toMatch(/10001 rows of data; this import takes at most 10000/)
  })

  it('at the start: an unknown importer, a macro workbook, an importer the caller may not use', async () => {
    const file = { originalName: 'a.csv', contentType: 'text/csv', sizeBytes: 10, sha256: 'a'.repeat(64) }
    expect((await call('owner', 'POST', '/imports', { importerKey: 'test.nothing', file })).statusCode).toBe(400)
    const macro = await call('owner', 'POST', '/imports', { importerKey: 'test.companies', file: { ...file, originalName: 'a.xlsm', contentType: 'application/vnd.ms-excel.sheet.macroEnabled.12' } })
    expect(macro.statusCode).toBe(400)
    expect(macro.json().error.issues[0].message).toMatch(/macros/)
    expect((await call('outsider', 'POST', '/imports', { importerKey: 'test.companies', file })).statusCode).toBe(403)
    expect((await call('owner', 'POST', '/imports', { importerKey: 'test.companies', file, mapping: { Codice: 'colour' } })).statusCode).toBe(400)
  })
})

describe('apply in batches', () => {
  const FIVE = ['code;legal name', 'B-1;One', 'B-2;Two', 'B-3;Three', 'B-4;Four', 'B-5;Five']

  it('a batch that throws writes nothing of its rows and fails the job; applying again goes on from that batch', async () => {
    const job = await planned('owner', csv(FIVE))
    expect(job.createCount).toBe(5)
    switches.failOn = 'Four'
    const response = await call('owner', 'POST', `/imports/${job.id}/apply`, { version: job.version })
    expect(response.statusCode).toBe(200)
    await expect(applyPlan(system(), job.id, { lastAttempt: true })).rejects.toThrow('made-up write failure')
    const failed = await getJob(job.id)
    expect(failed).toMatchObject({ status: 'FAILED', appliedCount: 2 })
    expect(failed.error).toMatch(/^Rows 4 to 5 could not be applied, so none of them was written/)
    // Batches of two: rows 2 and 3 applied; 4 and 5 (the failing batch) and 6 not.
    expect((await companiesOf()).map((company) => company.code).filter((code) => code.startsWith('B-'))).toEqual(['B-1', 'B-2'])

    switches.failOn = null
    const resumed = await applied(failed)
    expect(resumed).toMatchObject({ status: 'APPLIED', appliedCount: 5, skippedCount: 0, error: null })
    expect((await companiesOf()).map((company) => company.code).filter((code) => code.startsWith('B-'))).toEqual(['B-1', 'B-2', 'B-3', 'B-4', 'B-5'])
  })

  it('a record changed since the dry run is skipped, never overwritten; one already as planned is skipped as done', async () => {
    const job = await planned('owner', csv(['code;trade name;legal name', 'HQ;Sede nuova;Seed HQ S.r.l.', 'KEEP;Insegna;Keep S.p.A.']))
    expect(job.updateCount).toBe(2)
    await admin(`UPDATE "Company" SET "tradeName" = 'Changed by hand' WHERE "tenantId" = $1 AND code = 'HQ'`, [tenantA])
    await admin(`UPDATE "Company" SET "tradeName" = 'Insegna' WHERE "tenantId" = $1 AND code = 'KEEP'`, [tenantA])
    expect(await applied(job)).toMatchObject({ status: 'APPLIED', appliedCount: 0, skippedCount: 2 })
    expect((await rowsOf(job.id)).map((row) => [row.rowNumber, row.outcome, row.note])).toEqual([
      [2, 'SKIPPED', 'changed_since_dry_run'],
      [3, 'SKIPPED', 'already_done'],
    ])
    expect((await companiesOf()).find((company) => company.code === 'HQ')!.tradeName).toBe('Changed by hand')
  })

  it("the adapter's row check: an ERROR with its issues in the dry run; at the apply, a row it refuses now is skipped, never written", async () => {
    switches.refuse = 'Two'
    const refused = await planned('owner', csv(FIVE))
    expect(refused).toMatchObject({ status: 'PLANNED', createCount: 4, errorCount: 1 })
    expect((await rowsOf(refused.id)).find((row) => row.rowNumber === 3)).toMatchObject({ action: 'ERROR', errors: [{ column: 'legalName', message: 'Made-up check: row 3 names a refused company.' }] })
    // Every row whose cells parsed, once, for the job's tenant.
    expect(switches.checked).toEqual([{ rows: 5, tenantId: tenantA }])

    switches.refuse = null
    const job = await planned('owner', csv(FIVE))
    expect(job).toMatchObject({ createCount: 5, errorCount: 0 })
    switches.refuse = 'Four'
    expect(await applied(job)).toMatchObject({ status: 'APPLIED', appliedCount: 4, skippedCount: 1 })
    expect((await rowsOf(job.id)).find((row) => row.rowNumber === 5)).toMatchObject({ outcome: 'SKIPPED', note: 'changed_since_dry_run' })
    expect((await companiesOf()).map((company) => company.code).filter((code) => code.startsWith('B-'))).toEqual(['B-1', 'B-2', 'B-3', 'B-5'])
  })

  it('a cancelled import is never applied', async () => {
    const job = await planned('owner', csv(FIVE))
    const cancelled = await call('owner', 'POST', `/imports/${job.id}/cancel`, { version: job.version, reason: 'Wrong sheet' })
    expect(cancelled.json().job).toMatchObject({ status: 'CANCELLED' })
    expect((await call('owner', 'POST', `/imports/${job.id}/apply`, { version: cancelled.json().job.version })).json().error.code).toBe('invalid_state')
    expect(await applyPlan(system(), job.id)).toBe('settled')
    expect((await companiesOf()).some((company) => company.code.startsWith('B-'))).toBe(false)
  })
})

describe('the tenant wall', () => {
  it('another tenant neither sees nor works on a job, through the API or the worker', async () => {
    const job = await planned('owner', csv(SHEET))
    for (const url of [`/imports/${job.id}`, `/imports/${job.id}/rows`, `/imports/${job.id}/errors`]) expect((await call('ownerB', 'GET', url)).statusCode).toBe(404)
    expect((await call('ownerB', 'POST', `/imports/${job.id}/apply`, { version: job.version })).statusCode).toBe(404)
    expect((await call('ownerB', 'GET', '/imports')).json().jobs).toEqual([])
    expect((await call('owner', 'GET', '/imports')).json().jobs.map((entry: Job) => entry.id)).toContain(job.id)
    expect(await planImport(system(tenantB), job.id)).toBe('settled')
    expect(await applyPlan(system(tenantB), job.id)).toBe('settled')
    // Row-level security, underneath the API: tenant B's system context reads none of A's rows.
    expect(await system(tenantB).withClient((client) => client.importRow.count({ where: { jobId: job.id } }))).toBe(0)
    expect(await system(tenantA).withClient((client) => client.importRow.count({ where: { jobId: job.id } }))).toBe(5)
  })

  it('the importers list shows only what the caller may use', async () => {
    expect((await call('owner', 'GET', '/imports/importers')).json().importers).toEqual([
      expect.objectContaining({ key: 'test.companies', keyColumns: ['code'], columns: expect.arrayContaining([expect.objectContaining({ name: 'shareCapital', grain: 'cost', describe: 'a number with up to 2 decimals' })]) }),
    ])
    expect((await call('outsider', 'GET', '/imports/importers')).json().importers).toEqual([])
  })
})
