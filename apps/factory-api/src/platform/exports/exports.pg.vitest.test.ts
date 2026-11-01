import { randomBytes } from 'node:crypto'
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
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import { defineImporter } from '@nexus/factory-domain/imports/importer'
import { parseRow } from '@nexus/factory-domain/imports/plan'
import { periodFilter } from '@nexus/factory-domain/insights/reports/definition'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles, type FilesRuntime } from '../files/service'
import { createGateway } from '../gateway/gateway'
import { systemContext } from '../outbox/system'
import { testRedis, type TestRedis } from '../outbox/testing'
import { createSecretsService } from '../secrets/envelope'
import { localKeyProvider } from '../secrets/local'
import { defineReport } from '../../modules/insights/reports/report'
import { useReports } from '../../modules/insights/reports/registry'
import { defineImportAdapter, processImporters, useImporters } from '../imports/registry'
import { readSheet } from '../imports/sheet'
import { expireExports } from './expire'
import { useExportSources } from './registry'
import { defineExportSource, type ExportSource } from './source'
import { EXPORT_SOURCES } from './sources'
import { runExport } from './worker'

/**
 * The export of a list (B-W2a-23; PLT-179) on the local stack, with the app's real routes: a throwaway PostgreSQL 17
 * database from the migrations (the runtime login, so row-level security is real), the gateway on the local Redis
 * under this file's own prefix, the local file store on a temporary folder (each tenant's FAKE R2 account). The worker
 * is called as its handler calls it (runExport), the sweep as its cron does (expireExports).
 *
 * The list is made up for this test only: "test.companies" over the Company table, its share capital standing in for a
 * money column of the cost grain; the real sources (sales orders, purchase orders, work orders) are read once each on
 * an empty tenant, through their modules' own reads. Run with `node scripts/factory/run-pg-tests.mjs platform/exports`.
 *
 * W2b (B-W2b-11): the count before the run (the total on the job while it runs; a view too large refused before the
 * first row; a one-page list read once), the full file for re-import (a made-up importer over the same companies: the
 * file reads back through it UNCHANGED), and a report as a source (made-up reports over the companies: XLSX, the
 * small-group rule, the report's own refusals).
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
let files: FilesRuntime

const tenantA = newId()
const tenantB = newId()
const companyA = newId()
const companyB = newId()
const owner = newId()
const nocost = newId()
const leaver = newId()
const ownerB = newId()

type Company = { id: string; code: string; legalName: string; shareCapital: { toString(): string } | null }

const switches = { reads: 0, failWith: null as Error | null, many: 0, onRead: null as ((from: number) => Promise<void>) | null }

const companiesSpec: ExportSource<{ prefix: string | null }, Company> = {
  listKey: 'test.companies',
  permission: 'companies.view',
  query: (address) => ({ prefix: address.get('code')?.toUpperCase() ?? null }),
  async read(caller, query, cursor, limit) {
    switches.reads++
    if (switches.failWith) throw switches.failWith
    const rows = await caller.withClient((client) =>
      client.company.findMany({
        where: { AND: [query.prefix ? { code: { startsWith: query.prefix } } : {}, cursor ? { code: { gt: cursor } } : {}] },
        orderBy: { code: 'asc' },
        take: limit + 1,
        select: { id: true, code: true, legalName: true, shareCapital: true },
      }),
    )
    const page = rows.slice(0, limit)
    return { rows: page, next: rows.length > limit ? page.at(-1)!.code : null }
  },
  columns: {
    code: { value: (row) => row.code },
    name: { value: (row) => row.legalName },
    kind: { value: (_row, words) => words('kind.DEMO') },
    capital: { grain: 'cost', value: (row) => (row.shareCapital === null ? null : { minor: Math.round(Number(row.shareCapital.toString()) * 100), currency: 'EUR' }) },
  },
  words: { it: { 'kind.DEMO': 'Prova' }, en: { 'kind.DEMO': 'Demo' } },
}
const companies = defineExportSource(companiesSpec)

/** In memory: `switches.many` rows, for the count (a one-page list, a list too large) and the total seen while it runs. */
const many = defineExportSource<Record<string, never>, { n: number }>({
  listKey: 'test.many',
  permission: 'companies.view',
  query: () => ({}),
  async read(_caller, _query, cursor, limit) {
    switches.reads++
    const from = cursor === null ? 0 : Number(cursor)
    if (switches.onRead) await switches.onRead(from)
    const rows = Array.from({ length: Math.max(0, Math.min(limit, switches.many - from)) }, (_, index) => ({ n: from + index }))
    return { rows, next: from + limit < switches.many ? String(from + limit) : null }
  },
  columns: { n: { value: (row) => row.n } },
})

/** A made-up importer of the same companies: its key the code, the share capital of the cost grain. */
const companiesImporter = defineImporter({
  key: 'test.companies',
  label: 'Test companies',
  columns: {
    code: { label: 'Code', aliases: ['codice'], required: true, type: cell.code({ upper: true }) },
    name: { label: 'Legal name', aliases: ['ragione sociale'], type: cell.text({ max: 200 }) },
    capital: { label: 'Share capital', aliases: ['capitale'], type: cell.decimal({ scale: 2 }), grain: 'cost' },
  },
  keyColumns: ['code'],
})
const companiesAdapter = defineImportAdapter({
  importer: companiesImporter,
  permission: 'companies.manage',
  viewPermission: 'companies.view',
  async load(client, keys) {
    const rows = await client.company.findMany({ where: { code: { in: keys.map((key) => String(key.code)) } }, select: { id: true, code: true, legalName: true, shareCapital: true } })
    return rows.map((row) => ({ id: row.id, values: { code: row.code, name: row.legalName, capital: row.shareCapital === null ? null : row.shareCapital.toString() } }))
  },
  async write() {
    throw new Error('never written by these tests')
  },
})
const reimportable = defineExportSource<{ prefix: string | null }, Company>({
  ...companiesSpec,
  listKey: 'test.reimport',
  reimport: { importer: 'test.companies', key: (row) => ({ code: row.code }) },
})

/** Made-up reports over the companies: rows with a code, an amount of the cost grain and a people figure (5 or fewer). */
const capitalReport = defineReport({
  key: 'finance.test-capital',
  area: 'finance',
  title: 'Test capital',
  question: 'Which made-up companies hold which capital?',
  permission: 'companies.view',
  needs: null,
  columns: [
    { key: 'code', label: 'Code', kind: 'text' },
    { key: 'state', label: 'State', kind: 'code', codes: ['OPEN', 'LATE'] },
    { key: 'capital', label: 'Capital', kind: 'money', grain: 'cost', sum: true },
    { key: 'efficiency', label: 'Efficiency', kind: 'percent', people: true },
  ],
  filters: [periodFilter(['THIS_WEEK', 'LAST_WEEK'], null)],
  groupBy: null,
  sources: 'Companies (made up).',
  definition: 'Every made-up company whose code starts with DEMO000.',
  numbers: [],
  mail: null,
  formats: ['CSV', 'PDF'],
  async read(run) {
    const rows = await run.caller.withClient((client) => client.company.findMany({ where: { code: { startsWith: 'DEMO000' } }, orderBy: { code: 'asc' }, select: { id: true, code: true, shareCapital: true } }))
    return {
      complete: true,
      rows: rows.map((row, index) => ({
        id: row.id,
        record: null,
        currency: 'EUR',
        people: index === 0 ? 3 : 8,
        cells: { code: row.code, state: index % 2 === 0 ? 'OPEN' : 'LATE', capital: row.shareCapital === null ? null : Math.round(Number(row.shareCapital.toString()) * 100), efficiency: '87.5' },
      })),
    }
  },
})
const costReport = defineReport({ ...capitalReport, key: 'finance.test-cost', title: 'Test cost', needs: 'cost' })

// ---- sessions (the route's grants) and the people's live roles (the worker's) -----------------------------------------

const ALL: Permission[] = ['views.export', 'companies.view', 'files.read', 'workorders.view', 'orders.view', 'purchasing.view', 'home.reports.view', 'money.cost', 'money.price']
const grant = (permissions: readonly Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const session = (tenantId: string, actorId: string, permissions: readonly Permission[]): SessionContext => ({ audience: 'office', tenantId, actorId, companyId: tenantId === tenantA ? companyA : companyB, grants: [grant(permissions)] })
const SESSIONS: Record<string, SessionContext> = {
  owner: session(tenantA, owner, ALL),
  nocost: session(tenantA, nocost, ALL.filter((permission) => permission !== 'money.cost')),
  leaver: session(tenantA, leaver, ALL),
  noexport: session(tenantA, owner, ALL.filter((permission) => permission !== 'views.export')),
  nolist: session(tenantA, owner, ALL.filter((permission) => permission !== 'companies.view')),
  ownerB: session(tenantB, ownerB, ALL),
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (who: string, method: 'GET' | 'POST', url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': who, ...(key ? { 'idempotency-key': key } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(who: string, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(who, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const system = (tenantId = tenantA): CommandCaller => callerFor(database, systemContext(tenantId, newId()))
const COLUMNS = [
  { key: 'code', label: 'Codice' },
  { key: 'name', label: 'Ragione sociale' },
  { key: 'kind', label: 'Tipo' },
  { key: 'capital', label: 'Capitale' },
  { key: 'more', label: '' },
]
const ask = (who: string, over: Json = {}, key?: string) => ok(who, 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'Aziende di prova', locale: 'it', ...over }, 201, key)
const job = async (id: string, who = 'owner') => (await ok(who, 'GET', `/exports/${id}`)).job
/** The bytes of a finished export, through its presigned download on the local store. */
async function bytesOf(id: string, who = 'owner'): Promise<Buffer> {
  const { download } = await ok(who, 'GET', `/exports/${id}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode, got.body).toBe(200)
  return got.rawPayload
}

async function person(id: string, tenantId: string, email: string, permissions: readonly string[], grains: readonly string[], status = 'ACTIVE') {
  await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $3, $4)`, [id, tenantId, email, status])
  const roleId = newId()
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, audience, permissions, grains) VALUES ($1, $2, $3, $3, 'OFFICE', $4, $5)`, [roleId, tenantId, `custom.${email.split('@')[0]}`, permissions, grains])
  await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), tenantId, id, roleId])
  return roleId
}

beforeAll(async () => {
  db = await migratedDatabase('platform_exports')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-exports-test-'))
  for (const [tenantId, slug, companyId] of [
    [tenantA, 'exports-a', companyA],
    [tenantB, 'exports-b', companyB],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName", "shareCapital") VALUES ($1, $2, $3, $4, 10000.5)`, [companyId, tenantId, `${slug}-main`.toUpperCase(), `Demo ${slug} S.r.l.`])
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
  }
  // 450 made-up companies in tenant A: more than two pages of the list (200 a page).
  const values = Array.from({ length: 450 }, (_, index) => `('${newId()}', '${tenantA}', 'DEMO${String(index).padStart(4, '0')}', 'Demo ${index}; "Figli" S.r.l.', ${index % 2 === 0 ? 'NULL' : `${index}.25`})`)
  await admin(`INSERT INTO "Company" (id, "tenantId", code, "legalName", "shareCapital") VALUES ${values.join(', ')}`)
  const all = ['views.export', 'companies.view', 'files.read', 'workorders.view', 'orders.view', 'purchasing.view', 'home.reports.view']
  await person(owner, tenantA, 'owner@example.com', all, ['cost', 'price'])
  await person(nocost, tenantA, 'nocost@example.com', all, ['price'])
  await person(leaver, tenantA, 'leaver@example.com', all, ['cost'])
  await person(ownerB, tenantB, 'ownerb@example.com', all, ['cost'])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  useExportSources([companies, many, reimportable, ...EXPORT_SOURCES])
  useImporters([...processImporters().list(), companiesAdapter])
  useReports([capitalReport, costReport])
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
  useExportSources(undefined)
  useImporters(undefined)
  useReports(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

beforeEach(async () => {
  switches.reads = 0
  switches.failWith = null
  switches.many = 0
  switches.onRead = null
  // Each test starts with no export running (the limit of three at once).
  await admin(`UPDATE "ExportJob" SET status = 'FAILED', "finishedAt" = now(), "failureReason" = 'test reset' WHERE status = 'QUEUED'`)
  await admin(`UPDATE "ExportJob" SET status = 'FAILED', "finishedAt" = now(), "failureReason" = 'test reset' WHERE status = 'RUNNING'`)
})

describe('asking for an export (views.export and the list’s own permission)', () => {
  it('queues the view on screen, the columns as the screen named them; an unknown column is not part of it; a repeat answers the same job', async () => {
    const body = { query: 'code=demo00&open=0190f0e2-0000-7000-8000-000000000001' }
    const { job: asked } = await ask('owner', body, 'export-owner-0001')
    expect(asked).toMatchObject({ listKey: 'test.companies', format: 'CSV', status: 'QUEUED', title: 'Aziende di prova', viewName: null, omitted: [], rowsDone: 0, rowCount: null, file: null })
    expect(asked.columns.map((column: Json) => column.key)).toEqual(['code', 'name', 'kind', 'capital'])
    expect((await ask('owner', body, 'export-owner-0001')).job.id).toBe(asked.id)
    // The same key for another request is refused.
    expect((await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: 'code=x', columns: COLUMNS, title: 'Aziende di prova', locale: 'it' }, 'export-owner-0001')).statusCode).toBe(409)
    const [row] = await admin<{ query: Json; omittedColumns: string[]; viewId: string | null }>('SELECT query, "omittedColumns", "viewId" FROM "ExportJob" WHERE id = $1', [asked.id])
    expect(row).toMatchObject({ query: { address: 'code=demo00', params: { prefix: 'DEMO00' }, locale: 'it' }, omittedColumns: [], viewId: null })
    expect((await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1', [asked.id])).map((event) => event.type)).toEqual(['export.requested'])
  })

  it('leaves out the columns of a grain the person does not hold, and names them', async () => {
    const { job: asked } = await ask('nocost')
    expect(asked.columns.map((column: Json) => column.key)).toEqual(['code', 'name', 'kind'])
    expect(asked.omitted).toEqual([{ key: 'capital', label: 'Capitale' }])
  })

  it('refuses without views.export, without the list, a list without an export, a format it lacks, three at once', async () => {
    expect((await call('noexport', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it' })).statusCode).toBe(403)
    expect((await call('nolist', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it' })).statusCode).toBe(403)
    expect((await call('owner', 'POST', '/exports', { listKey: 'admin.users', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it' })).statusCode).toBe(404)
    expect((await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'XLSX_REIMPORT', query: '', columns: COLUMNS, title: 'X', locale: 'it' })).statusCode).toBe(400)
    expect((await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: [{ key: 'more', label: '' }], title: 'X', locale: 'it' })).statusCode).toBe(400)
    for (let index = 0; index < 3; index++) await ask('owner')
    const fourth = await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it' })
    expect(fourth.statusCode, fourth.body).toBe(409)
    expect(fourth.json().error.message).toMatch(/3 exports running/)
  })

  it('a person sees only their own exports', async () => {
    const { job: asked } = await ask('owner')
    expect((await call('nocost', 'GET', `/exports/${asked.id}`)).statusCode).toBe(404)
    expect((await call('ownerB', 'GET', `/exports/${asked.id}`)).statusCode).toBe(404)
    expect((await ok('owner', 'GET', '/exports?listKey=test.companies')).jobs.map((entry: Json) => entry.id)).toContain(asked.id)
    expect((await ok('nocost', 'GET', '/exports?listKey=test.companies')).jobs.map((entry: Json) => entry.id)).not.toContain(asked.id)
  })
})

describe('the worker writes the file (as the person, with their live rights)', () => {
  it('reads every page as the screen does, writes the CSV in Italian and keeps it as a file of the job', async () => {
    const { job: asked } = await ask('owner', { query: 'code=DEMO' })
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    // Counted first (three pages), then read and written (three pages).
    expect(switches.reads).toBe(6)
    const [counted] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'exports.count'`, [asked.id])
    expect(counted?.after).toEqual({ rowCount: 450 })
    const done = await job(asked.id)
    expect(done).toMatchObject({ status: 'DONE', rowsDone: 450, rowCount: 450, file: { name: 'aziende-di-prova-' + done.finishedAt.slice(0, 10) + '.csv' } })
    expect(Date.parse(done.expiresAt) - Date.parse(done.finishedAt)).toBe(7 * 86_400_000)
    const text = (await bytesOf(asked.id)).toString('utf8')
    expect(text.charCodeAt(0)).toBe(0xfeff)
    const lines = text.slice(1).split('\r\n')
    expect(lines[0]).toBe('Codice;Ragione sociale;Tipo;Capitale (EUR)')
    expect(lines[1]).toBe('DEMO0000;"Demo 0; ""Figli"" S.r.l.";Prova;')
    expect(lines[2]).toBe('DEMO0001;"Demo 1; ""Figli"" S.r.l.";Prova;1,25')
    expect(lines).toHaveLength(452)
    const [file] = await admin<{ recordType: string; recordId: string; kind: string; status: string; contentType: string }>('SELECT "recordType", "recordId", kind, status, "contentType" FROM "StoredFile" WHERE id = $1', [done.file.id])
    expect(file).toEqual({ recordType: 'ExportJob', recordId: asked.id, kind: 'DOCUMENT', status: 'AVAILABLE', contentType: 'text/csv' })
    expect((await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [asked.id])).map((event) => event.type)).toEqual(['export.requested', 'export.finished'])
    // Run again (a doubled event): nothing more happens.
    expect(await runExport(system(), asked.id, { files })).toBe('settled')
  })

  it('the file says above its header which columns the person’s rights left out; Excel in English with numbers and the note', async () => {
    const { job: asked } = await ask('nocost', { format: 'XLSX', locale: 'en', title: 'Demo companies', query: 'code=DEMO000', columns: [{ key: 'code', label: 'Code' }, { key: 'capital', label: 'Capital' }, { key: 'kind', label: 'Kind' }] })
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await bytesOf(asked.id, 'nocost')) as unknown as ArrayBuffer)
    const sheet = workbook.worksheets[0]!
    expect(sheet.name).toBe('Demo companies')
    expect(sheet.getRow(1).getCell(1).value).toBe('Columns left out by your rights: Capital')
    expect(sheet.getRow(2).values).toEqual([undefined, 'Code', 'Kind'])
    expect(sheet.getRow(3).values).toEqual([undefined, 'DEMO0000', 'Demo'])
    expect(sheet.rowCount).toBe(12)
  })

  it('Excel amounts are numbers with two decimals', async () => {
    const { job: asked } = await ask('owner', { format: 'XLSX', query: 'code=DEMO0001', columns: [{ key: 'code', label: 'Codice' }, { key: 'capital', label: 'Capitale' }] })
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await bytesOf(asked.id)) as unknown as ArrayBuffer)
    const sheet = workbook.worksheets[0]!
    expect(sheet.getRow(1).values).toEqual([undefined, 'Codice', 'Capitale (EUR)'])
    expect(sheet.getRow(2).getCell(2).value).toBe(1.25)
    expect(sheet.getRow(2).getCell(2).numFmt).toBe('#,##0.00')
  })

  it('fails in words when the person lost the right meanwhile, left, or the view is too large; a broken read is retried, then failed', async () => {
    const lost = (await ask('owner')).job
    await admin(`UPDATE "Role" SET grains = '{price}' WHERE key = 'custom.owner'`)
    expect(await runExport(system(), lost.id, { files })).toBe('failed')
    expect(await job(lost.id)).toMatchObject({ status: 'FAILED', failureReason: 'Your rights changed since you asked: export the list again.', file: null })
    await admin(`UPDATE "Role" SET grains = '{cost,price}' WHERE key = 'custom.owner'`)

    const gone = (await ask('leaver')).job
    await admin(`UPDATE "User" SET status = 'DEACTIVATED' WHERE id = $1`, [leaver])
    expect(await runExport(system(), gone.id, { files })).toBe('failed')
    expect((await admin<{ failureReason: string }>('SELECT "failureReason" FROM "ExportJob" WHERE id = $1', [gone.id]))[0]!.failureReason).toMatch(/no longer have the right/)

    const broken = (await ask('owner')).job
    switches.failWith = new Error('made-up read failure')
    await expect(runExport(system(), broken.id, { files })).rejects.toThrow('made-up read failure')
    expect((await job(broken.id)).status).toBe('RUNNING')
    expect(await runExport(system(), broken.id, { files, lastAttempt: true })).toBe('failed')
    expect(await job(broken.id)).toMatchObject({ status: 'FAILED', failureReason: expect.stringMatching(/stopped before the end/) })
    // The cause stays in the log: never on the job.
    expect(JSON.stringify(await job(broken.id))).not.toContain('made-up')
  })

  it('reads the real lists through their modules (empty here): sales orders, purchase orders, work orders', async () => {
    for (const [listKey, columns] of [
      ['sales.orders', [{ key: 'number', label: 'Numero' }, { key: 'net', label: 'Netto' }]],
      ['purchasing.orders', [{ key: 'number', label: 'Numero' }, { key: 'value', label: 'Valore' }]],
      ['production.work-orders', [{ key: 'number', label: 'Numero' }, { key: 'pieces', label: 'Capi' }]],
    ] as const) {
      const { job: asked } = await ask('owner', { listKey, columns, query: 'late=true&q=demo', title: listKey })
      expect(await runExport(system(), asked.id, { files }), listKey).toBe('done')
      expect(await job(asked.id)).toMatchObject({ status: 'DONE', rowCount: 0 })
      expect((await bytesOf(asked.id)).toString('utf8').slice(1).split('\r\n')[0], listKey).toBe(`Numero;${columns[1].label}`)
    }
  })
})

describe('the count before the run (PLT-184: job progress with a total)', () => {
  it('keeps the total on the job before the first row is written; a one-page list is read once', async () => {
    switches.many = 450
    const { job: asked } = await ask('owner', { listKey: 'test.many', columns: [{ key: 'n', label: 'N' }] })
    const seen: (number | null)[] = []
    switches.onRead = async (from) => {
      if (from !== 200) return
      const [row] = await admin<{ rowCount: number | null }>('SELECT "rowCount" FROM "ExportJob" WHERE id = $1', [asked.id])
      seen.push(row!.rowCount)
    }
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    // The second page while counting (no total yet), then while writing (the total is there).
    expect(seen).toEqual([null, 450])
    expect(switches.reads).toBe(6)
    expect(await job(asked.id)).toMatchObject({ status: 'DONE', rowsDone: 450, rowCount: 450 })

    switches.onRead = null
    switches.reads = 0
    switches.many = 10
    const small = (await ask('owner', { listKey: 'test.many', columns: [{ key: 'n', label: 'N' }] })).job
    expect(await runExport(system(), small.id, { files })).toBe('done')
    expect(switches.reads).toBe(1)
    expect(await job(small.id)).toMatchObject({ status: 'DONE', rowCount: 10 })
  })

  it('refuses a view above the most rows a file holds before it writes a row', async () => {
    switches.many = 50_001
    const { job: asked } = await ask('owner', { listKey: 'test.many', columns: [{ key: 'n', label: 'N' }] })
    expect(await runExport(system(), asked.id, { files })).toBe('failed')
    expect(await job(asked.id)).toMatchObject({ status: 'FAILED', failureReason: 'This view has more than 50,000 rows: narrow it with a filter and export it again.', rowsDone: 0, file: null })
    // Counting stopped at the first page past the limit; nothing was read for the file.
    expect(switches.reads).toBe(251)
    expect(await admin('SELECT id FROM "StoredFile" WHERE "recordId" = $1', [asked.id])).toEqual([])
  })
})

describe('the selected rows only (B-W2b-13, Z16:02: the selection row’s Export N)', () => {
  it('writes the view’s rows whose id was selected, their number the total (no count read); none left in the view → failed in words', async () => {
    const picked = await admin<{ id: string; code: string }>(`SELECT id, code FROM "Company" WHERE code IN ('DEMO0003', 'DEMO0420') ORDER BY code`)
    const { job: asked } = await ask('owner', { query: 'code=DEMO', ids: picked.map((row) => row.id) })
    expect(asked).toMatchObject({ status: 'QUEUED', selected: 2 })
    const [row] = await admin<{ query: Json }>('SELECT query FROM "ExportJob" WHERE id = $1', [asked.id])
    expect(row!.query.ids).toEqual(picked.map((entry) => entry.id))
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    // Three pages read once for the file; nothing read to count.
    expect(switches.reads).toBe(3)
    const [counted] = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'exports.count'`, [asked.id])
    expect(counted?.after).toEqual({ rowCount: 2 })
    expect(await job(asked.id)).toMatchObject({ status: 'DONE', rowsDone: 2, rowCount: 2, selected: 2 })
    const lines = (await bytesOf(asked.id)).toString('utf8').slice(1).split('\r\n')
    expect(lines.map((line) => line.split(';')[0])).toEqual(['Codice', 'DEMO0003', 'DEMO0420', ''])

    // A filter that leaves none of them in the view.
    const gone = (await ask('owner', { query: 'code=DEMO01', ids: picked.map((entry) => entry.id) })).job
    expect(await runExport(system(), gone.id, { files })).toBe('failed')
    expect(await job(gone.id)).toMatchObject({ status: 'FAILED', failureReason: 'None of the selected rows is in this view any more: export the view instead.', file: null, selected: 2 })
    // The whole view says no selection; a selection above the limit or twice the same row is refused.
    expect((await ask('owner', { query: 'code=DEMO04' })).job.selected).toBeNull()
    expect((await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it', ids: [picked[0]!.id, picked[0]!.id] })).statusCode).toBe(400)
    expect((await call('owner', 'POST', '/exports', { listKey: 'test.companies', format: 'CSV', query: '', columns: COLUMNS, title: 'X', locale: 'it', ids: Array.from({ length: 501 }, () => newId()) })).statusCode).toBe(400)
  })
})

describe('the full file for re-import (the importer’s layout)', () => {
  it('writes the importer’s columns, whatever the screen shows; the file reads back through the importer unchanged', async () => {
    const { job: asked } = await ask('owner', { listKey: 'test.reimport', format: 'XLSX_REIMPORT', query: 'code=DEMO000', columns: [{ key: 'name', label: 'Ragione sociale' }] })
    expect(asked.columns).toEqual([{ key: 'code', label: 'Code' }, { key: 'name', label: 'Legal name' }, { key: 'capital', label: 'Share capital' }])
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    const done = await job(asked.id)
    expect(done).toMatchObject({ status: 'DONE', rowCount: 10, file: { name: expect.stringMatching(/^aziende-di-prova-reimport-\d{4}-\d{2}-\d{2}\.xlsx$/) } })
    const bytes = await bytesOf(asked.id)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(bytes as unknown as ArrayBuffer)
    expect(workbook.worksheets.map((sheet) => sheet.name)).toEqual(['Test companies', 'Colonne'])
    const sheet = workbook.worksheets[0]!
    expect(sheet.getRow(1).values).toEqual([undefined, 'Code', 'Legal name', 'Share capital'])
    expect(sheet.getRow(2).values).toEqual([undefined, 'DEMO0000', 'Demo 0; "Figli" S.r.l.'])
    expect(sheet.getRow(3).values).toEqual([undefined, 'DEMO0001', 'Demo 1; "Figli" S.r.l.', 1.25])
    // Back through the import, in either number format: every row UNCHANGED.
    const read = await readSheet(bytes, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxRows: 1000 })
    const mapping = mapHeaders(companiesImporter.columns, read.headers).columns
    expect(mapping.map((column) => column.column)).toEqual(['code', 'name', 'capital'])
    for (const numberFormat of ['it', 'en'] as const) {
      const parsed = read.rows.map((row) => parseRow(companiesImporter, mapping, row, { numberFormat }))
      expect(parsed.flatMap((row) => row.errors)).toEqual([])
      const existing = await system().withClient((client) => companiesAdapter.load(client as never, parsed.map((row) => ({ code: row.values.code! })), { companyId: null }))
      const plans = parsed.map((row) => companiesImporter.plan(row.values, existing.find((record) => record.values.code === row.values.code) ?? null))
      expect(plans, numberFormat).toEqual(Array.from({ length: 10 }, () => ({ action: 'UNCHANGED' })))
    }
  })

  it('leaves out a money column without its grain and names it on the second sheet, never above the header', async () => {
    const { job: asked } = await ask('nocost', { listKey: 'test.reimport', format: 'XLSX_REIMPORT', query: 'code=DEMO0001', locale: 'en' })
    expect(asked.omitted).toEqual([{ key: 'capital', label: 'Share capital' }])
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await bytesOf(asked.id, 'nocost')) as unknown as ArrayBuffer)
    expect(workbook.worksheets[0]!.getRow(1).values).toEqual([undefined, 'Code', 'Legal name'])
    const help: string[] = []
    workbook.worksheets[1]!.eachRow((row) => help.push(String(row.getCell(1).value ?? '')))
    expect(workbook.worksheets[1]!.name).toBe('Columns')
    expect(help).toContain('Columns left out by your rights: Share capital')
  })
})

describe('a report as a source (XLSX of a report)', () => {
  const columns = [
    { key: 'code', label: 'Codice' },
    { key: 'state', label: 'Stato' },
    { key: 'capital', label: 'Capitale' },
    { key: 'efficiency', label: 'Efficienza' },
  ]

  it('writes the run as the Results tab shows it: codes in words, amounts with their grain, people figures of small groups blanked', async () => {
    const { job: asked } = await ask('owner', { listKey: 'home.reports.finance.test-capital', format: 'XLSX', query: 'period=THIS_WEEK&tab=results&group=none', columns, title: 'Capitale di prova' })
    expect(await runExport(system(), asked.id, { files })).toBe('done')
    expect(await job(asked.id)).toMatchObject({ status: 'DONE', rowCount: 10 })
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await bytesOf(asked.id)) as unknown as ArrayBuffer)
    const sheet = workbook.worksheets[0]!
    expect(sheet.getRow(1).values).toEqual([undefined, 'Codice', 'Stato', 'Capitale (EUR)', 'Efficienza'])
    // The first company's figure is made by 3 people: blanked (Statuto dei Lavoratori art. 4).
    expect(sheet.getRow(2).values).toEqual([undefined, 'DEMO0000', 'Aperta'])
    expect(sheet.getRow(3).values).toEqual([undefined, 'DEMO0001', 'In ritardo', 1.25, 87.5])
  })

  it('refuses a report the person may not run, a filter value it does not know, a report that does not exist; leaves out a grain', async () => {
    const needs = await call('nocost', 'POST', '/exports', { listKey: 'home.reports.finance.test-cost', format: 'XLSX', query: '', columns, title: 'X', locale: 'en' })
    expect(needs.statusCode, needs.body).toBe(403)
    expect(needs.json().error.message).toBe('This report needs cost rights.')
    expect((await call('owner', 'POST', '/exports', { listKey: 'home.reports.finance.test-capital', format: 'XLSX', query: 'period=NEVER', columns, title: 'X', locale: 'en' })).statusCode).toBe(400)
    expect((await call('owner', 'POST', '/exports', { listKey: 'home.reports.finance.nothing-here', format: 'XLSX', query: '', columns, title: 'X', locale: 'en' })).statusCode).toBe(404)
    expect((await call('owner', 'POST', '/exports', { listKey: 'home.reports.finance.test-capital', format: 'XLSX_REIMPORT', query: '', columns, title: 'X', locale: 'en' })).statusCode).toBe(400)
    const { job: asked } = await ask('nocost', { listKey: 'home.reports.finance.test-capital', format: 'CSV', query: '', columns, title: 'X', locale: 'en' })
    expect(asked.omitted).toEqual([{ key: 'capital', label: 'Capitale' }])
  })
})

describe('the sweep (cron exports.expire)', () => {
  it('deletes a file after its days and marks the job EXPIRED; fails a job no worker touched for half an hour', async () => {
    const { job: asked } = await ask('owner', { query: 'code=DEMO0002' })
    await runExport(system(), asked.id, { files })
    const done = await job(asked.id)
    const stuck = (await ask('owner')).job
    await admin(`UPDATE "ExportJob" SET status = 'RUNNING', "startedAt" = now() - interval '2 hours', "updatedAt" = now() - interval '2 hours' WHERE id = $1`, [stuck.id])
    const log = { info() {}, warn() {}, error() {} } as never
    const later = { now: () => new Date(Date.parse(done.expiresAt) + 1000) }
    const result = await expireExports({ database, log, clock: later, files })
    expect(result).toMatchObject({ failed: 0 })
    expect(result.expired).toBeGreaterThanOrEqual(1)
    expect(result.stuck).toBeGreaterThanOrEqual(1)
    expect(await job(asked.id)).toMatchObject({ status: 'EXPIRED', file: null })
    expect((await admin<{ status: string }>('SELECT status FROM "StoredFile" WHERE id = $1', [done.file.id]))[0]!.status).toBe('DELETED')
    const refused = await call('owner', 'GET', `/exports/${asked.id}/download`)
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error.message).toMatch(/deleted after 7 days/)
    expect(await job(stuck.id)).toMatchObject({ status: 'FAILED', failureReason: 'The export stopped half way: export the list again.' })
  })
})
