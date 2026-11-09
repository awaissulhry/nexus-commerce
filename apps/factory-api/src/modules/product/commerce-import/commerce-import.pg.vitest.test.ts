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
import { commerceStylesImportAdapter } from './importer'

/**
 * Start a style from a Nexus Commerce product (B-W2b-209; PRD-265) on the local stack, through the app's real routes: a
 * throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the product guards are
 * real), the product seed (a tenant-wide jacket on the scale SEED-EU-JKT 48-56, its SKUs SEED-JKT-01-<colour>-<size>),
 * sessions from the test authenticator, the gateway on the local Redis under this file's own prefix and the local file
 * store in a temporary folder. The export file is a made-up Commerce export: every code, name and barcode is invented
 * (barcodes with the in-store GS1 prefix 200). Run with `node scripts/factory/run-pg-tests.mjs modules/product/commerce-import`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'commerce-import-seed'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']
const STYLES: Permission[] = ['product.styles.view', 'product.styles.manage']

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  product: { permissions: [...STYLES, ...IMPORTS, 'audit.read'], companies: 'all' },
  companyOne: { permissions: [...STYLES, ...IMPORTS], companies: [companyA] },
  viewer: { permissions: ['product.styles.view'], companies: 'all' },
  planner: { permissions: ['workorders.view'], companies: 'all' },
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

beforeAll(async () => {
  db = await migratedDatabase('commerce_import')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-commerce-import-test-'))
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
  useImporters([commerceStylesImportAdapter])
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
const start = (session: string, body: Buffer, fields: Json = {}) =>
  call(session, 'POST', '/imports', { importerKey: 'product.commerceStyles', file: { originalName: 'commerce-export.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, ...fields })
async function upload(session: string, body: Buffer, fields: Json = {}): Promise<Json> {
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
const styleByCode = async (code: string): Promise<Json> => {
  const [row] = await admin<{ id: string }>('SELECT id FROM "Style" WHERE code = $1', [code])
  return (await call('product', 'GET', `/product/styles/${row!.id}`)).json().style
}

// A made-up Commerce export as Commerce writes it (English headers, the family's own row first).
const HEADER = 'SKU;Parent SKU;Name;Color;Size;EAN;Category;Season'
const EXPORT = [
  HEADER,
  'DEMO-TOUR;;Giacca Touring Demo;;;;Giacche moto;FW27',
  'DEMO-TOUR-NER-50;DEMO-TOUR;Giacca Touring Demo - Nero - 50;Nero;50;2009001000017;;',
  'DEMO-TOUR-NER-52;DEMO-TOUR;Giacca Touring Demo - Nero - 52;Nero;52;2009001000024;;',
  'DEMO-TOUR-GRA-50;DEMO-TOUR;Giacca Touring Demo - Grigio antracite - 50;Grigio antracite;50;2009001000031;;',
  'DEMO-TOUR-GRA-52;DEMO-TOUR;Giacca Touring Demo - Grigio antracite - 52;Grigio antracite;52;;;',
]

describe('the sources (Owner answer 11-09: an export file only)', () => {
  it('says the file is on and the live read of Commerce is OFF, waiting for the Owner', async () => {
    const response = await call('viewer', 'GET', '/product/commerce-import')
    expect(response.statusCode, response.body).toBe(200)
    expect(response.json().commerceImport).toEqual({
      importerKey: 'product.commerceStyles',
      maxRows: 500,
      formats: ['csv', 'xlsx'],
      sources: [
        { source: 'EXPORT_FILE', state: 'ON', reasonCode: null },
        { source: 'LIVE_READ', state: 'OFF', reasonCode: 'OWNER_WORD' },
      ],
    })
    expect((await call('planner', 'GET', '/product/commerce-import')).statusCode).toBe(403)
  })
})

describe('a Commerce family becomes a draft style (PRD-265)', () => {
  let styleId = ''

  it('plans the family in a dry run that writes nothing, then applies exactly the plan', async () => {
    const job = await upload('product', csv(EXPORT), { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 5, createCount: 5, unchangedCount: 0, errorCount: 0 })
    expect(await admin('SELECT id FROM "Style" WHERE code = $1', ['DEMO-TOUR'])).toEqual([])
    const rows = await rowsOf('product', job.id)
    expect(rows[2]).toMatchObject({ action: 'CREATE', after: { sku: 'DEMO-TOUR-NER-52', style: 'DEMO-TOUR', colourCode: 'NERO', size: '52', gtin: '2009001000024' } })

    const applied = await apply('product', job)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedCount: 5, skippedCount: 0 })
    const style = await styleByCode('DEMO-TOUR')
    styleId = style.id
    expect(style).toMatchObject({ code: 'DEMO-TOUR', name: 'Giacca Touring Demo', productType: 'JACKET', season: 'FW27', status: 'DRAFT', companyId: companyA, sizes: ['50', '52'], baseSize: null, ppeCategory: 'NOT_PPE' })
    // Colourways made together are listed by code (the style page's order).
    expect(style.colourways.map((colourway: Json) => [colourway.code, colourway.name])).toEqual([['GRIGIO_ANTRA', 'Grigio antracite'], ['NERO', 'Nero']])
    const skus = await admin<{ sku: string; gtin: string | null; size: string }>('SELECT sku, gtin, size FROM "Variant" WHERE "styleId" = $1 ORDER BY sku', [styleId])
    expect(skus).toEqual([
      { sku: 'DEMO-TOUR-GRA-50', gtin: '2009001000031', size: '50' },
      { sku: 'DEMO-TOUR-GRA-52', gtin: null, size: '52' },
      { sku: 'DEMO-TOUR-NER-50', gtin: '2009001000017', size: '50' },
      { sku: 'DEMO-TOUR-NER-52', gtin: '2009001000024', size: '52' },
    ])
    const [facts] = await admin<{ lifecycle: string }>('SELECT lifecycle::text FROM "Style" WHERE id = $1', [styleId])
    expect(facts!.lifecycle).toBe('CONCEPT')
    const revisions = (await call('product', 'GET', `/product/styles/${styleId}/revisions`)).json().revisions
    expect(revisions).toMatchObject([{ revision: 1, status: 'DRAFT', changeNote: 'Started from the Nexus Commerce export (family DEMO-TOUR).' }])
    const events = (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [styleId])).map((event) => event.type)
    expect(events).toEqual(['style.created', 'style.skus_changed', 'style.revision_created'])
    const history: Json[] = (await (await call('product', 'GET', `/audit/Style/${styleId}`)).json()).entries
    expect(history.find((entry) => entry.after?.startedFrom)).toMatchObject({ action: 'product.styles.commerceImport', after: { startedFrom: { source: 'NEXUS_COMMERCE_EXPORT', family: 'DEMO-TOUR', importJobId: job.id } } })

    // The result step: the styles the job started, as the caller may see them.
    const started = (await call('product', 'GET', `/product/commerce-import/jobs/${job.id}`)).json()
    expect(started).toEqual({ jobId: job.id, status: 'APPLIED', styles: [{ id: styleId, code: 'DEMO-TOUR', name: 'Giacca Touring Demo', status: 'DRAFT', lifecycle: 'CONCEPT', started: true, skus: 4 }], hidden: 0 })
    expect((await call('viewer', 'GET', `/product/commerce-import/jobs/${job.id}`)).statusCode).toBe(404)
  })

  it('changes nothing when the same file is imported again', async () => {
    const job = await upload('product', csv(EXPORT), { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 5, createCount: 0, unchangedCount: 5, errorCount: 0 })
  })

  it("adds a new colour and size to the style it started while it is still a concept", async () => {
    const job = await upload('product', csv([...EXPORT, 'DEMO-TOUR-ROS-54;DEMO-TOUR;Giacca Touring Demo - Rosso - 54;Rosso;54;2009001000048;;']), { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1, unchangedCount: 5, errorCount: 0 })
    expect(await apply('product', job)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    const style = await styleByCode('DEMO-TOUR')
    expect(style.sizes).toEqual(['50', '52', '54'])
    expect(style.colourways.map((colourway: Json) => colourway.code)).toEqual(['GRIGIO_ANTRA', 'NERO', 'ROSSO'])
    expect(style.name).toBe('Giacca Touring Demo')
    const started = (await call('product', 'GET', `/product/commerce-import/jobs/${job.id}`)).json()
    expect(started.styles).toMatchObject([{ code: 'DEMO-TOUR', started: false, skus: 1 }])
  })

  it('refuses in words: past development, a SKU on another cell, a size no scale holds, a tenant-wide job by a one-company person', async () => {
    await admin(`UPDATE "Style" SET lifecycle = 'SAMPLING' WHERE id = $1`, [styleId])
    const late = await upload('product', csv([...EXPORT, 'DEMO-TOUR-ROS-56;DEMO-TOUR;x;Rosso;56;;;']), { companyId: companyA })
    expect(late).toMatchObject({ createCount: 0, unchangedCount: 5, errorCount: 1 })
    expect((await rowsOf('product', late.id)).find((row) => row.action === 'ERROR')!.errors).toEqual([
      { column: 'style', message: 'Style DEMO-TOUR is past development (sampling): add its new colours and sizes on the style itself.' },
    ])

    const other = await upload(
      'product',
      csv([HEADER, 'DEMO-PNT;;Pantalone Demo;;;;Pantaloni;', 'SEED-JKT-01-BLK-50;DEMO-PNT;x;Nero;50;;;', 'DEMO-PNT-NER-99;DEMO-PNT;x;Nero;99;;;']),
      { companyId: companyA },
    )
    expect(other).toMatchObject({ createCount: 0, errorCount: 3 })
    const refused = await rowsOf('product', other.id)
    expect(refused[1]!.errors[0].message).toContain('SKU SEED-JKT-01-BLK-50 is on style SEED-JKT-01 (colourway BLK, size 50) already')
    expect(refused[2]!.errors[0].message).toContain('No size scale holds every size of the family')
    expect(await admin('SELECT id FROM "Style" WHERE code = $1', ['DEMO-PNT'])).toEqual([])

    // A job for every company needs the right over every company.
    expect((await start('companyOne', csv(EXPORT))).statusCode).toBeGreaterThanOrEqual(400)
  })
})
