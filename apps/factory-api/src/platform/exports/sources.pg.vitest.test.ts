import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ExcelJS from 'exceljs'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { mapHeaders } from '@nexus/factory-domain/imports/headers'
import { parseRow } from '@nexus/factory-domain/imports/plan'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../adapters/ses/fake'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { loadReports } from '../../modules/insights/reports/registry'
import { startHarness, WEB_ORIGIN, type Harness } from '../auth/sessions/testing/harness'
import { processImporters } from '../imports/registry'
import { readSheet } from '../imports/sheet'
import { systemContext } from '../outbox/system'
import { mailExportLink, MAIL_HANDLER } from './mail'
import { formatsOf } from './source'
import { EXPORT_SOURCES } from './sources'
import { exportHandlers, runExport } from './worker'

/**
 * Every W1 and W2a list's export (B-W2b-11) on the local stack with EVERY factory-db seed (in name order, as the seed
 * command runs them), through the real routes and the worker: each list source exports its every column for the owner
 * (and for the planner, without the money they lack); each "Full file for re-import" goes back through its importer's
 * own load and plan as UNCHANGED rows; a report of the pack exports as Excel; a long export's link is e-mailed once to
 * the person who asked (the tenant's FAKE SES account). Run with `node scripts/factory/run-pg-tests.mjs
 * platform/exports`.
 */

let h: Harness
let app: FastifyInstance

const NS = 'exports-sources-w2b11'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const SRC = fileURLToPath(new URL('../..', import.meta.url))

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]

const PEOPLE = { owner: newId(), planner: newId() } as const
type Person = keyof typeof PEOPLE
function grantOf(person: Person): Grant {
  const template = templateOf(person)!
  return { permissions: [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)], companies: 'all', sites: 'all', parties: 'all' }
}
const session = (person: Person): SessionContext => ({ audience: 'office', tenantId: T, actorId: PEOPLE[person], companyId: companyA, grants: [grantOf(person)] })
const system = (): CommandCaller => callerFor(h.database, systemContext(T, newId()))

async function call(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown): Promise<{ status: number; body: Json; raw: Buffer }> {
  const response = await app.inject({ method, url, headers: { 'x-test-session': person }, ...(payload === undefined ? {} : { payload: payload as object }) })
  return { status: response.statusCode, body: String(response.headers['content-type'] ?? '').includes('json') ? (response.json() as Json) : {}, raw: response.rawPayload }
}
async function ok(person: Person, method: 'GET' | 'POST', url: string, payload?: unknown, status = 200): Promise<Json> {
  const answer = await call(person, method, url, payload)
  expect(answer.status, `${person} ${method} ${url}: ${JSON.stringify(answer.body).slice(0, 500)}`).toBe(status)
  return answer.body
}
/** Asks for an export, runs the worker as its handler does, answers the finished job. */
async function exported(person: Person, body: Json): Promise<Json> {
  const { job } = await ok(person, 'POST', '/exports', { query: '', title: body.listKey, locale: 'it', ...body }, 201)
  const outcome = await runExport(system(), job.id, { files: h.files })
  const done = (await ok(person, 'GET', `/exports/${job.id}`)).job
  expect(outcome, `${body.listKey} ${body.format}: ${done.failureReason}`).toBe('done')
  return done
}
async function bytesOf(person: Person, id: string): Promise<Buffer> {
  const { download } = await ok(person, 'GET', `/exports/${id}/download`)
  const got = await app.inject({ method: 'GET', url: download.url, headers: download.headers })
  expect(got.statusCode).toBe(200)
  return got.rawPayload
}
const columnsOf = (listKey: string) => Object.keys(EXPORT_SOURCES.find((source) => source.listKey === listKey)!.columns).map((key) => ({ key, label: `col ${key}` }))

beforeAll(async () => {
  h = await startHarness('exports_sources11')
  h.clock.set(new Date())
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: unknown; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  const roleIds = new Map((await admin<{ id: string; key: string }>(`SELECT id, key FROM "Role" WHERE "tenantId" = $1`, [T])).map((row) => [row.key, row.id]))
  for (const person of Object.keys(PEOPLE) as Person[]) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [PEOPLE[person], T, `w2b11-${person}@example.com`, `Person ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "validFrom") VALUES ($1, $2, $3, $4, true, now() - interval '1 day')`, [newId(), T, PEOPLE[person], roleIds.get(person)])
  }
  // Many files in a few seconds: the seeded file store's rate limit is a person's, not a test's.
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1`, [T])
  await loadReports(SRC)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: SRC, authenticate: testAuthenticator((request) => (String(request.headers['x-test-session']) in PEOPLE ? session(String(request.headers['x-test-session']) as Person) : null)) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

beforeEach(async () => {
  // Each test starts with no export running (the limit of three at once).
  await admin(`UPDATE "ExportJob" SET status = 'FAILED', "finishedAt" = now(), "failureReason" = 'test reset' WHERE status IN ('QUEUED', 'RUNNING')`)
})

describe('every list exports (the W1 and W2a lists)', () => {
  it('each source, every column, for the owner: the file’s header is the screen’s, one line per row', async () => {
    for (const source of EXPORT_SOURCES) {
      const columns = columnsOf(source.listKey)
      const done = await exported('owner', { listKey: source.listKey, format: 'CSV', columns })
      expect(done.omitted, source.listKey).toEqual([])
      const lines = (await bytesOf('owner', done.id)).toString('utf8').slice(1).split('\r\n').filter((line) => line !== '')
      // An amount column of one currency names it in its heading ("col net (EUR)").
      expect(lines[0]!.split(';').map((heading) => heading.replace(/ \([A-Z]{3}\)$/, '')), source.listKey).toEqual(columns.map((column) => column.label))
      expect(lines.length - 1, source.listKey).toBe(done.rowCount)
    }
  })

  it('the seeded lists are not empty (the sources really read their modules)', async () => {
    for (const listKey of ['products.materials', 'products.operations', 'sales.customers', 'purchasing.suppliers', 'warehouse.locations', 'sales.orders']) {
      if (!EXPORT_SOURCES.some((source) => source.listKey === listKey)) continue
      const done = await exported('owner', { listKey, format: 'XLSX', columns: columnsOf(listKey), query: 'rows=all&view=all' })
      expect(done.rowCount, listKey).toBeGreaterThan(0)
    }
  })

  it('for the planner, without the money they lack: the columns are named, never written', async () => {
    for (const source of EXPORT_SOURCES) {
      const money = Object.entries(source.columns).filter(([, column]) => column.grain && !templateOf('planner')!.grains.includes(column.grain)).map(([key]) => key)
      const allowed = await call('planner', 'POST', '/exports', { listKey: source.listKey, format: 'CSV', query: '', columns: columnsOf(source.listKey), title: source.listKey, locale: 'en' })
      if (allowed.status === 403 || (allowed.status === 400 && money.length === Object.keys(source.columns).length)) continue
      expect(allowed.status, `${source.listKey}: ${JSON.stringify(allowed.body).slice(0, 300)}`).toBe(201)
      expect((allowed.body.job.omitted as Json[]).map((column) => column.key).sort(), source.listKey).toEqual(money.sort())
      expect(await runExport(system(), allowed.body.job.id, { files: h.files }), source.listKey).toBe('done')
    }
  })
})

describe('the full file for re-import goes back through its importer unchanged', () => {
  it('materials, operations, locations, customers and suppliers: every row UNCHANGED in the dry run’s own plan', async () => {
    const offering = EXPORT_SOURCES.filter((source) => formatsOf(source).includes('XLSX_REIMPORT'))
    expect(offering.length).toBe(5)
    for (const source of offering) {
      const done = await exported('owner', { listKey: source.listKey, format: 'XLSX_REIMPORT', columns: columnsOf(source.listKey), query: 'view=all' })
      expect(done.rowCount, source.listKey).toBeGreaterThan(0)
      const adapter = processImporters().get(source.reimport!.importer)!
      const bytes = await bytesOf('owner', done.id)
      const read = await readSheet(bytes, { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', maxRows: adapter.importer.maxRows })
      const mapping = mapHeaders(adapter.importer.columns, read.headers)
      expect(mapping.issues, source.listKey).toEqual([])
      expect(mapping.ignored, source.listKey).toEqual([])
      const parsed = read.rows.map((row) => parseRow(adapter.importer, mapping.columns, row, { numberFormat: 'it' }))
      expect(parsed.flatMap((row) => row.errors), source.listKey).toEqual([])
      const keys = parsed.map((row) => Object.fromEntries(adapter.importer.keyColumns.map((name) => [name, row.values[name]!])))
      const keyOf = (values: Json) => JSON.stringify(adapter.importer.keyColumns.map((name) => String(values[name])))
      // An import writes into one company (or tenant-wide): each row is planned as its own records' import would plan it
      // (the seeded materials, operations and most parties are tenant-wide; the locations and one party are company A's).
      const plans = await Promise.all(
        [null, companyA].map(async (companyId) => {
          const existing = await system().withClient((client) => adapter.load(client as never, keys, { companyId }))
          const found = new Map(existing.map((record) => [keyOf(record.values), record]))
          return parsed.map((row) => adapter.importer.plan(row.values, found.get(keyOf(row.values)) ?? null).action)
        }),
      )
      const actions = parsed.map((_, index) => (plans.some((plan) => plan[index] === 'UNCHANGED') ? 'UNCHANGED' : plans[0]![index]))
      expect(new Set(actions), `${source.listKey}: ${JSON.stringify(parsed.map((row, index) => [actions[index], row.values]).filter(([action]) => action !== 'UNCHANGED')).slice(0, 600)}`).toEqual(new Set(['UNCHANGED']))
    }
  })
})

describe('a report of the pack exports as Excel', () => {
  it('Open orders: the run’s rows, codes in words', async () => {
    const done = await exported('owner', { listKey: 'home.reports.sales.open-orders', format: 'XLSX', columns: [{ key: 'order', label: 'Ordine' }, { key: 'status', label: 'Stato' }], title: 'Ordini aperti' })
    expect(done.rowCount).toBeGreaterThan(0)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load((await bytesOf('owner', done.id)) as unknown as ArrayBuffer)
    const sheet = workbook.worksheets[0]!
    expect(sheet.getRow(1).values).toEqual([undefined, 'Ordine', 'Stato'])
    expect(['Confermato', 'In produzione', 'Pronto da spedire', 'Spedito in parte']).toContain(sheet.getRow(2).getCell(2).value)
  })
})

describe('the e-mail of a finished export', () => {
  it('the worker’s handlers include the mail of a finished export', () => {
    expect(exportHandlers().map((handler) => handler.name)).toContain(MAIL_HANDLER)
  })

  it('a quick export is not mailed; a long one sends the link once, in the person’s language, behind sign-in', async () => {
    const quick = await exported('owner', { listKey: 'sales.orders', format: 'CSV', columns: [{ key: 'number', label: 'Numero' }] })
    expect(await mailExportLink(system(), quick.id, { runtime: h.email })).toBe('skipped')

    // Asked 30 s ago (it waited in the queue): the person has surely closed its window.
    const id = newId()
    const query = { address: 'rows=all', params: {}, columns: [{ key: 'number', label: 'Numero' }], title: 'Ordini di vendita', locale: 'it', viewName: 'Tutti' }
    await admin(`INSERT INTO "ExportJob" (id, "tenantId", "companyId", "requestedById", "listKey", format, query, status, "createdAt", "updatedAt") VALUES ($1, $2, $3, $4, 'sales.orders', 'XLSX', $5, 'QUEUED', now() - interval '30 seconds', now() - interval '30 seconds')`, [id, T, companyA, PEOPLE.owner, JSON.stringify(query)])
    expect(await runExport(system(), id, { files: h.files })).toBe('done')
    const before = h.ses.mails.length
    expect(await mailExportLink(system(), id, { runtime: h.email })).toBe('sent')
    expect(h.ses.mails.length).toBe(before + 1)
    const mail = h.ses.mails.at(-1)!
    const [company] = await admin<{ code: string }>('SELECT code FROM "Company" WHERE id = $1', [companyA])
    const text = textOf(mail.raw)
    expect(text).toContain('Ciao Person owner,')
    expect(text).toContain(`${WEB_ORIGIN}/w/${company!.code}/sales/orders?export=${id}`)
    expect(text).toContain('Ordini di vendita · Tutti')
    expect(mail.raw).not.toContain('Content-Disposition: attachment')
    const job = (await ok('owner', 'GET', `/exports/${id}`)).job
    expect(job.emailedAt).not.toBeNull()
    const [outbound] = await admin<{ recordType: string; templateKey: string; status: string }>(`SELECT "recordType", "templateKey", status FROM "EmailOutbound" WHERE "recordId" = $1`, [id])
    expect(outbound).toMatchObject({ recordType: 'ExportJob', templateKey: 'exports.ready', status: 'SENT' })
    // Once: the event coming again sends nothing.
    expect(await mailExportLink(system(), id, { runtime: h.email })).toBe('skipped')
    expect(h.ses.mails.length).toBe(before + 1)
  })
})
