import { createHash, randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import ExcelJS from 'exceljs'
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
import { seed as seedProduct } from '../../../../../../packages/factory-db/seed/product'
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
import { operationsImportAdapter } from '../operations/importer'
import { bomImportAdapter } from './importer'

/**
 * The BOM export and import (PRD-090) and the operation library import (PRD-109, PLT-176) of B-W2a-09 on the local stack,
 * with the app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level
 * security and the …_product_guards triggers are real), the product seed's jacket (tenant-wide, revision 1 a draft),
 * sessions from the test authenticator, the gateway on the local Redis under this file's own prefix and the local file
 * store in a temporary folder. Every code, quantity and name is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs bom-import`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'bom-import-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const jacket = seedId('product:style:JKT-01')
const revision1 = seedId('product:revision:JKT-01:1')
const SEW_OPERATION = seedId('product:operation:SEW')

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const BOM: Permission[] = ['product.styles.view', 'product.bom.view', 'product.bom.manage', 'product.bom.release', 'product.routing.view']

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  developer: { permissions: [...BOM, 'product.operations.manage', 'audit.read', ...IMPORTS], companies: 'all' },
  viewer: { permissions: ['product.styles.view', 'product.bom.view'], companies: 'all' },
  companyOne: { permissions: [...BOM, ...IMPORTS], companies: [companyA] },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const SESSIONS: Record<string, SessionContext> = Object.fromEntries(
  Object.entries(PEOPLE).map(([key, person]) => {
    const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: 'all' }
    return [key, { audience: 'office', tenantId: tenant, actorId: IDS[key]!, grants: [grant] }]
  }),
)

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])
const bomUrl = `/product/styles/${jacket}/revisions/${revision1}/bom`
const getBom = async (): Promise<Json> => (await call('viewer', 'GET', bomUrl)).json().bom

beforeAll(async () => {
  db = await migratedDatabase('bom_import')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-bom-import-test-'))
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin(
    `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)
     ON CONFLICT DO NOTHING`,
    [newId(), tenant],
  )
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, '{}')`, [roleId, tenant, `custom.${key.toLowerCase()}`, key, person.permissions])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`,
      [newId(), tenant, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([bomImportAdapter, operationsImportAdapter])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../../..', import.meta.url)),
      authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null),
    },
  )
}, 120_000)

afterAll(async () => {
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
const start = (session: string, importerKey: string, body: Buffer, fields: Json = {}) =>
  call(session, 'POST', '/imports', { importerKey, file: { originalName: 'sheet.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, ...fields })
async function upload(session: string, importerKey: string, body: Buffer, fields: Json = {}): Promise<Json> {
  const started = await start(session, importerKey, body, fields)
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

describe('the BOM export (PRD-090)', () => {
  it('writes the import columns as CSV, in the Italian number format, one row per line in BOM order', async () => {
    const response = await call('viewer', 'GET', `${bomUrl}/export?format=csv`)
    expect(response.statusCode, response.body).toBe(200)
    expect(response.headers['content-type']).toMatch(/^text\/csv/)
    expect(response.headers['content-disposition']).toContain('bom-SEED-JKT-01-rev1.csv')
    const lines = response.body.trim().split('\r\n')
    expect(lines[0]).toBe('Style;Seq;Material;Placement;Qty per garment;Unit;Wastage %;By size;Quantity by size;By colourway;Colour by colourway;Colour;Only in colourway;Supplier;Note')
    expect(lines.slice(1)).toEqual([
      'SEED-JKT-01;10;SEED-LEA-100;Outer shell;;FT2;12;sì;"50=43; 52=45; 54=47,5";sì;"BLK=BLK; RED=RED";;;;',
      'SEED-JKT-01;20;SEED-LIN-200;Body lining;1,8;M;5;no;;no;;GRY;;;',
      'SEED-JKT-01;30;SEED-PRO-300;Shoulder pockets;2;PCS;0;no;;no;;;;;',
    ])
  })

  it('writes an Excel workbook with numbers as numbers and the columns explained, and a PDF sheet', async () => {
    const response = await call('viewer', 'GET', `${bomUrl}/export?format=xlsx&numberFormat=en`)
    expect(response.statusCode, response.body).toBe(200)
    const workbook = new ExcelJS.Workbook()
    await workbook.xlsx.load(response.rawPayload as unknown as ArrayBuffer)
    const sheet = workbook.getWorksheet('BOM')!
    expect(sheet.getRow(1).values).toContain('Quantity by size')
    expect(sheet.getRow(3).getCell(5).value).toBe(1.8)
    expect(sheet.getRow(2).getCell(9).value).toBe('50=43; 52=45; 54=47.5')
    expect(workbook.getWorksheet('Columns')!.rowCount).toBe(16)
    const pdf = await call('viewer', 'GET', `${bomUrl}/export?format=pdf&language=en`)
    expect(pdf.statusCode).toBe(200)
    expect(pdf.headers['content-type']).toBe('application/pdf')
    expect(pdf.rawPayload.subarray(0, 5).toString()).toBe('%PDF-')
    // Reading the BOM is enough; another person's style is not found.
    expect((await call('viewer', 'GET', `/product/styles/${newId()}/revisions/${revision1}/bom/export`)).statusCode).toBe(404)
  })
})

describe('the BOM import (PRD-090)', () => {
  const HEADER = 'Modello;Pos;Materiale;Q.tà;UM;Sfrido %;Per taglia;Quantità per taglia;Per variante;Colore per variante;Colore;Fornitore;Nota'

  it('an exported BOM imported again changes nothing', async () => {
    const exported = (await call('viewer', 'GET', `${bomUrl}/export?format=csv`)).rawPayload
    const job = await upload('developer', 'product.bom', Buffer.from(exported))
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 3, unchangedCount: 3, createCount: 0, updateCount: 0, errorCount: 0 })
  })

  it('plans changes and new lines in the draft, says each problem in words, then applies exactly the plan', async () => {
    const before = await getBom()
    const job = await upload(
      'developer',
      'product.bom',
      csv([
        HEADER,
        'seed-jkt-01;10;;;;15;;50=44|52=45|54=47,5;;;;;',
        'SEED-JKT-01;40;SEED-PRO-300;2;pz;;;;;;;;Elbow pockets (made up)',
        'SEED-JKT-01;50;SEED-LIN-200;1,2;m;;;;;;ZZZ;;',
        'SEED-XXX;10;SEED-LIN-200;1;m;;;;;;;;',
        'SEED-JKT-01;60;SEED-LIN-200;1;m;;sì;;;;GRY;;',
        'SEED-JKT-01;70;SEED-LIN-200;1;m;;;;;;GRY;SEED-C1;',
      ]),
    )
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 6, updateCount: 1, createCount: 1, errorCount: 4 })
    expect((await getBom()).revision.version).toBe(before.revision.version)
    const rows = await rowsOf('developer', job.id)
    expect(rows.map((row) => [row.rowNumber, row.action])).toEqual([[2, 'UPDATE'], [3, 'CREATE'], [4, 'ERROR'], [5, 'ERROR'], [6, 'ERROR'], [7, 'ERROR']])
    expect(rows[0]).toMatchObject({ before: { wastagePct: '12', sizes: '50=43;52=45;54=47.5' }, after: { wastagePct: '15', sizes: '50=44;52=45;54=47.5' } })
    expect(rows[2]!.errors).toEqual([{ column: 'colour', message: 'SEED-LIN-200 has no colour ZZZ.' }])
    expect(rows[3]!.errors).toEqual([{ column: 'style', message: 'No style SEED-XXX.' }])
    expect(rows[4]!.errors).toEqual([{ column: 'qty', message: 'A size-dependent line takes its quantity per size: send sizes.' }])
    expect(rows[5]!.errors).toEqual([{ column: 'supplier', message: 'This party is not a supplier.' }])

    const applied = await apply('developer', job)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedCount: 2, skippedCount: 0 })
    const bom = await getBom()
    expect(bom.revision.version).toBe(before.revision.version + 2)
    expect(bom.lines.map((line: Json) => [line.seq, line.item.code, line.wastagePct])).toEqual([[10, 'SEED-LEA-100', '15'], [20, 'SEED-LIN-200', '5'], [30, 'SEED-PRO-300', '0'], [40, 'SEED-PRO-300', '0']])
    expect(bom.lines[0].sizes).toEqual([{ size: '50', qty: '44' }, { size: '52', qty: '45' }, { size: '54', qty: '47.5' }])
    expect(bom.lines[3]).toMatchObject({ qty: '2', uom: 'PCS', note: 'Elbow pockets (made up)', sizeDependent: false })
    const changed = (await eventsOf(jacket)).filter((event) => event.type === 'style.bom_changed')
    expect(changed.slice(-2).map((event) => event.payload.lineIds)).toEqual([[bom.lines[0].id], [bom.lines[3].id]])
    const history: Json[] = (await (await call('developer', 'GET', `/audit/BomLine/${bom.lines[3].id}`)).json()).entries
    expect(history.find((entry) => entry.action === 'product.bom.import')).toMatchObject({ after: { seq: 40, qty: '2', uom: 'PCS' } })
  })

  it('refuses a tenant-wide BOM to a company job and to a person over one company, and a style whose revision is released', async () => {
    const sheet = csv([HEADER, 'SEED-JKT-01;20;;2;;;;;;;;;'])
    const companyJob = await upload('developer', 'product.bom', sheet, { companyId: companyA })
    expect(companyJob).toMatchObject({ status: 'PLANNED', errorCount: 1 })
    expect((await rowsOf('developer', companyJob.id))[0]!.errors).toEqual([{ column: 'style', message: 'Style SEED-JKT-01 is made by every company: import its BOM with a job for every company.' }])
    // A person over one company starts no job for every company.
    expect((await start('companyOne', 'product.bom', sheet)).statusCode).toBeGreaterThanOrEqual(400)

    const bom = await getBom()
    expect((await call('developer', 'POST', `${bomUrl.replace(/\/bom$/, '')}/release`, { version: bom.revision.version })).statusCode).toBe(200)
    const frozen = await upload('developer', 'product.bom', sheet)
    expect((await rowsOf('developer', frozen.id))[0]!.errors).toEqual([
      { column: 'style', message: 'Style SEED-JKT-01 has no draft revision (a released revision is frozen): start one, or copy the released one, before importing its BOM.' },
    ])
    // A released revision still exports.
    expect((await call('viewer', 'GET', `${bomUrl}/export?format=csv`)).statusCode).toBe(200)
  })
})

describe('the operation library import (PRD-109)', () => {
  it('changes the cells that differ, adds new operations and refuses an unknown department; routings keep their copies', async () => {
    const job = await upload(
      'developer',
      'product.operations',
      csv([
        'Codice;Descrizione;Nome (it);Reparto;Macchina;Minuti standard',
        'SEED-SEW-ASM;;Cucitura e montaggio;cucitura;Colonna 2 aghi;97,5',
        'op-new-01;Apply reinforcements;Rinforzi;montaggio;;6,25',
        'OP-BAD;X;;reparto ignoto;;1',
      ]),
    )
    expect(job).toMatchObject({ status: 'PLANNED', updateCount: 1, createCount: 1, errorCount: 1 })
    const rows = await rowsOf('developer', job.id)
    expect(rows[0]).toMatchObject({ action: 'UPDATE', before: { machineType: 'post-bed', standardMinutes: '96.5' }, after: { machineType: 'Colonna 2 aghi', standardMinutes: '97.5' } })
    expect(rows[2]!.errors).toEqual([{ column: 'workCentreKind', message: 'Expected one of CUTTING, SEWING, ASSEMBLY, FINISHING, INSPECTION, PACKING, SUBCONTRACT.' }])
    expect(await apply('developer', job)).toMatchObject({ status: 'APPLIED', appliedCount: 2 })

    const sew = (await (await call('developer', 'GET', `/product/operations/${SEW_OPERATION}`)).json()).operation
    expect(sew).toMatchObject({ machineType: 'Colonna 2 aghi', standardMinutes: '97.5', version: 2 })
    const created = (await (await call('developer', 'GET', '/product/operations?q=OP-NEW-01')).json()).operations[0]
    expect(created).toMatchObject({ code: 'OP-NEW-01', name: 'Apply reinforcements', nameI18n: { it: 'Rinforzi' }, workCentreKind: 'ASSEMBLY', standardMinutes: '6.25', companyId: null })
    expect((await eventsOf(SEW_OPERATION)).map((event) => event.type)).toContain('operation.updated')
    // The jacket's routing keeps its copy, and shows that it differs from the library now.
    const routing = (await (await call('developer', 'GET', `/product/styles/${jacket}/revisions/${revision1}/routing`)).json()).routing
    expect(routing.steps.find((step: Json) => step.code === 'SEED-SEW-ASM')).toMatchObject({ standardMinutes: '96.5', differsFromLibrary: true })
  })
})
