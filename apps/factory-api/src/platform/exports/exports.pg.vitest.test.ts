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
import { expireExports } from './expire'
import { useExportSources } from './registry'
import { defineExportSource } from './source'
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

const switches = { reads: 0, failWith: null as Error | null }

const companies = defineExportSource<{ prefix: string | null }, Company>({
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
})

// ---- sessions (the route's grants) and the people's live roles (the worker's) -----------------------------------------

const ALL: Permission[] = ['views.export', 'companies.view', 'files.read', 'workorders.view', 'orders.view', 'purchasing.view', 'money.cost', 'money.price']
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
  const all = ['views.export', 'companies.view', 'files.read', 'workorders.view', 'orders.view', 'purchasing.view']
  await person(owner, tenantA, 'owner@example.com', all, ['cost', 'price'])
  await person(nocost, tenantA, 'nocost@example.com', all, ['price'])
  await person(leaver, tenantA, 'leaver@example.com', all, ['cost'])
  await person(ownerB, tenantB, 'ownerb@example.com', all, ['cost'])
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  files = createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) })
  useFiles(files)
  useExportSources([companies, ...EXPORT_SOURCES])
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
    expect(switches.reads).toBe(3)
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
