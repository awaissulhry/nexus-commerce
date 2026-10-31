import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import type { Redis } from 'ioredis'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission, ScopeSet } from '@nexus/factory-domain/core/permissions'
import { SHEET_TYPES } from '@nexus/factory-domain/imports/job'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPlanning } from '../../../../../../packages/factory-db/seed/planning'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { createFilesRuntime, useFiles } from '../../../platform/files/service'
import { createGateway } from '../../../platform/gateway/gateway'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { itemParametersImportAdapter } from './importer'

/**
 * The item parameters' import (B-W2b-20; PLN-005, PLN-099; design planning.settings "Item parameters" › Import) on the
 * local stack, through the app's real routes and the import engine: a throwaway PostgreSQL 17 database from the
 * migrations (the runtime login: row-level security and the …_stock_plan_w2a_guards triggers are real), the factory-db
 * seeds' made-up tenant (A1's item parameters of the planning seed: the leather for every colour, the grey lining by
 * min/max, the protectors by a reorder point; SEED-S1 the leather's and lining's default supplier), sessions from the
 * test authenticator, the gateway on the local Redis under this file's own prefix and the local file store in a
 * temporary folder. Every code, quantity and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/planning/settings/importer`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'w2b20-item-import'
const idOf = (key: string): string => seedUuid(NS, key)
const tenant = idOf('tenant')
const companyA = idOf('company:A')
const companyB = idOf('company:B')
const siteA1 = idOf('site:A1')
const siteB1 = idOf('site:B1')
const item = { leather: idOf('product:item:leather'), lining: idOf('product:item:lining'), protector: idOf('product:item:protector') }
const red = idOf('product:item-colour:leather:RED')
const protectorRow = idOf('planning:item:A1:protector')
const SUPPLIER = idOf('party:P2')

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const PLANNER: Permission[] = ['planning.view', 'planning.items.manage', 'audit.read', ...IMPORTS]

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
  readonly sites: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  planner: { permissions: PLANNER, companies: 'all', sites: 'all' },
  // Sees the plans and runs imports, but keeps no item parameters.
  viewer: { permissions: ['planning.view', ...IMPORTS], companies: 'all', sites: 'all' },
  // Keeps item parameters at plant B1 only: A1's rows are refused row by row.
  plannerB1: { permissions: PLANNER, companies: 'all', sites: [siteB1] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: person.sites, parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
const start = (session: string, body: Buffer, fields: Json = {}) =>
  call(session, 'POST', '/imports', { importerKey: 'planning.itemParameters', file: { originalName: 'parametri.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, ...fields })
async function upload(session: string, body: Buffer, fields: Json = { companyId: companyA }): Promise<Json> {
  const started = await start(session, body, fields)
  expect(started.statusCode, started.body).toBe(201)
  const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
  const sent = await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })
  expect(sent.statusCode, sent.body).toBe(200)
  expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
  await planImport(system(), job.id, { lastAttempt: true })
  return (await call(session, 'GET', `/imports/${job.id}`)).json().job
}
const rowsOf = async (session: string, jobId: string): Promise<Json[]> => (await call(session, 'GET', `/imports/${jobId}/rows`)).json().rows
async function apply(session: string, job: Json): Promise<Json> {
  const response = await call(session, 'POST', `/imports/${job.id}/apply`, { version: job.version })
  expect(response.statusCode, response.body).toBe(200)
  await applyPlan(system(), job.id, { lastAttempt: true })
  return (await call(session, 'GET', `/imports/${job.id}`)).json().job
}
const HEADER = 'Sito;Articolo;Colore;Metodo;Origine;Fornitore;Lead time acquisto;Scorta di sicurezza;Punto di riordino;Lotto;Nota'

beforeAll(async () => {
  db = await migratedDatabase('w2b20_item_import')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-item-import-test-'))
  await seedCore({ db: database, namespace: NS })
  await seedPlanning({ db: database, namespace: NS })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000) ON CONFLICT DO NOTHING`, [newId(), tenant])
  // A made-up material of company B only (an import for company A never plans it).
  await admin(
    `INSERT INTO "Item" SELECT (jsonb_populate_record(NULL::"Item", to_jsonb(i) || jsonb_build_object('id', $1::text, 'code', 'SEED-B-ONLY', 'companyId', $2::text, 'version', 1))).* FROM "Item" i WHERE i.id = $3`,
    [newId(), companyB, item.protector],
  )
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, '{}')`, [roleId, tenant, `custom.${key.toLowerCase()}`, key, person.permissions])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "siteIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, $7, now() - interval '1 day')`,
      [newId(), tenant, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies, person.sites === 'all' ? [] : person.sites],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([itemParametersImportAdapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 180_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

describe('the item parameters import (B-W2b-20)', () => {
  it('plans new rows and changes, says each problem in words, then applies exactly the plan with its audit and events', async () => {
    const job = await upload(
      'planner',
      csv([
        HEADER,
        // A new row for the red leather: bought from its default supplier.
        'A1;seed-lea-100;red;ordini;acquisto;SEED-S1;;;;;Pelle rossa (made up)',
        // The protectors' safety stock 12 → 10 (the reorder point stays).
        'A1;SEED-PRO-300;*;;;;;10;;;',
        // A new row for the lining in every colour, from the orders.
        'A1;SEED-LIN-200;tutti;ORDERS;;;14;;;;',
        'A1;SEED-LEA-100;BLK;;acquisto;SEED-NOPE;;;;;',
        'A1;SEED-LEA-100;*;;;SEED-C1;;;;;',
        'A1;SEED-B-ONLY;*;ORDERS;;;;;;;',
        'Z9;SEED-LEA-100;*;ORDERS;;;;;;;',
        'A1;SEED-LEA-100;VIOLA;ORDERS;;;;;;;',
        'A1;SEED-LIN-200;GRY;REORDER_POINT;;;;;24;;',
      ]),
    )
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 9, createCount: 2, updateCount: 1, errorCount: 6 })
    const rows = await rowsOf('planner', job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([[2, 'CREATE'], [3, 'UPDATE'], [4, 'CREATE'], [5, 'ERROR'], [6, 'ERROR'], [7, 'ERROR'], [8, 'ERROR'], [9, 'ERROR'], [10, 'ERROR']])
    expect(rows[1]).toMatchObject({ before: { safetyStock: '12.0000' }, after: { safetyStock: '10' } })
    expect(rows[3]!.errors).toEqual([{ column: 'supplier', message: 'No supplier SEED-NOPE.' }])
    expect(rows[4]!.errors).toEqual([{ column: 'supplier', message: 'The preferred supplier is a party with the supplier role.' }])
    expect(rows[5]!.errors).toEqual([{ column: 'item', message: 'Item SEED-B-ONLY belongs to another company: import its parameters with that company.' }])
    expect(rows[6]!.errors).toEqual([{ column: 'site', message: 'No site Z9 in this company.' }])
    expect(rows[7]!.errors).toEqual([{ column: 'colour', message: 'Item SEED-LEA-100 has no active colour VIOLA (write * for every colour).' }])
    // The grey lining is min/max: a switch to a reorder point needs its lot size too (the PATCH's rule).
    expect(rows[8]!.errors).toEqual([{ column: 'lotSize', message: 'A reorder-point rule needs the lot size: how much to order each time.' }])
    expect(await admin('SELECT count(*)::int AS n FROM "ItemPlanning" WHERE "siteId" = $1', [siteA1])).toEqual([{ n: 3 }])

    const applied = await apply('planner', job)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedCount: 3, skippedCount: 0 })
    const stored = await admin<Json>(
      `SELECT "itemId", "itemColourId", method::text, source::text, "supplierId", "buyLeadTimeDays", "safetyStock"::text, "reorderPoint"::text, note, version FROM "ItemPlanning" WHERE "siteId" = $1 ORDER BY "itemId", "itemColourId" NULLS FIRST`,
      [siteA1],
    )
    expect(stored.find((row) => row.itemId === item.leather && row.itemColourId === red)).toMatchObject({ method: 'ORDERS', source: 'BUY', supplierId: SUPPLIER, note: 'Pelle rossa (made up)', version: 1 })
    expect(stored.find((row) => row.itemId === item.protector)).toMatchObject({ method: 'REORDER_POINT', safetyStock: '10.0000', reorderPoint: '24.0000', version: 2 })
    expect(stored.find((row) => row.itemId === item.lining && row.itemColourId === null)).toMatchObject({ method: 'ORDERS', buyLeadTimeDays: 14, source: null })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'planning.item_parameters_changed' ORDER BY "occurredAt", id`, [tenant])
    expect(events.map((event) => `${event.payload.change}:${event.payload.itemId}`).sort()).toEqual([`CREATED:${item.leather}`, `CREATED:${item.lining}`, `EDITED:${item.protector}`].sort())
    const history: Json[] = (await (await call('planner', 'GET', `/audit/ItemPlanning/${protectorRow}`)).json()).entries
    expect(history.find((entry) => entry.action === 'planning.importItemParameters')).toMatchObject({ before: { safetyStock: '12.0000' }, after: { safetyStock: '10.0000' } })
    // The grid reads the imported rows as the routes wrote them.
    const grid = (await (await call('planner', 'GET', `/planning/item-parameters?siteId=${siteA1}&q=SEED-LEA-100`)).json()).items[0]
    expect(grid.parameters.map((row: Json) => row.colour?.code ?? null)).toEqual([null, 'RED'])

    // The same sheet again: nothing left to do for the applied rows.
    const again = await upload('planner', csv([HEADER, 'A1;SEED-LEA-100;RED;ORDERS;BUY;SEED-S1;;;;;Pelle rossa (made up)', 'A1;SEED-PRO-300;*;;;;;10,0000;;;']))
    expect(again).toMatchObject({ status: 'PLANNED', unchangedCount: 2, createCount: 0, updateCount: 0, errorCount: 0 })
  })

  it('a method change clears the old method’s own fields, as the PATCH does', async () => {
    const job = await upload('planner', csv([HEADER, 'A1;SEED-PRO-300;*;MIN_MAX;;;;;;;']))
    // MIN_MAX without its minimum and maximum is refused (the rule), so the switch names them in a sheet with them.
    expect((await rowsOf('planner', job.id))[0]!.errors).toEqual([
      { column: 'minStock', message: 'A min/max rule needs the minimum stock: below it, the plan orders.' },
      { column: 'maxStock', message: 'A min/max rule needs the maximum stock: the plan orders up to it.' },
    ])
    const sheet = csv(['Sito;Articolo;Colore;Metodo;Scorta minima;Scorta massima', 'A1;SEED-PRO-300;*;MIN_MAX;20;96'])
    const planned = await upload('planner', sheet)
    const [row] = await rowsOf('planner', planned.id)
    expect(row).toMatchObject({ action: 'UPDATE', before: { method: 'REORDER_POINT', reorderPoint: '24.0000', lotSize: '48.0000', minStock: null, maxStock: null }, after: { method: 'MIN_MAX', minStock: '20', maxStock: '96' } })
    expect(await apply('planner', planned)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    expect(await admin('SELECT method::text, "reorderPoint", "lotSize", "minStock"::text, "maxStock"::text FROM "ItemPlanning" WHERE id = $1', [protectorRow])).toEqual([{ method: 'MIN_MAX', reorderPoint: null, lotSize: null, minStock: '20.0000', maxStock: '96.0000' }])
  })

  it('refuses a person without planning.items.manage, a job for every company, and rows of a site the person does not plan', async () => {
    const sheet = csv([HEADER, 'A1;SEED-LEA-100;*;;;;;5;;;'])
    const refused = await start('viewer', sheet, { companyId: companyA })
    expect(refused.statusCode).toBe(403)
    const everyCompany = await start('planner', sheet)
    expect(everyCompany.statusCode, everyCompany.body).toBeGreaterThanOrEqual(400)
    expect(everyCompany.body).toContain("Item parameters belong to a company's sites: import them for one company.")
    const limited = await upload('plannerB1', sheet)
    expect(limited).toMatchObject({ status: 'PLANNED', errorCount: 1 })
    expect((await rowsOf('plannerB1', limited.id))[0]!.errors).toEqual([{ column: 'site', message: 'Keeping the item parameters of site A1 needs planning.items.manage at that site.' }])
  })
})
