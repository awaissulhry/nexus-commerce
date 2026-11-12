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
import { systemContext } from '../../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../../platform/outbox/testing'
import { createSecretsService } from '../../../platform/secrets/envelope'
import { localKeyProvider } from '../../../platform/secrets/local'
import { useImporters } from '../../../platform/imports/registry'
import { applyPlan, planImport } from '../../../platform/imports/worker'

/**
 * Import of suppliers and their price lists (B-W2b-311; SCM-289) through the imports platform's real routes and worker
 * steps (POST /imports, the upload, the dry run, the apply): the supplier columns of the parties import (kinds, status
 * and reason, lead time, origin, a tannery's hides and tannages) and a supplier's price list (purchasing.supplierPrices:
 * approved sources). A throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and
 * the triggers are real), the seeds' parties (SEED-S1 company A's supplier and subcontractor, SEED-C1 a tenant-wide
 * customer) and products (SEED-LEA-100 leather by the hide with colours BLK and RED, SEED-LIN-200 lining by the roll), the
 * gateway on the local Redis under this file's prefix and the local file store in a temporary folder. Every code and
 * figure is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/suppliers-depth`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'suppliers-import-311'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const S1 = seedId('party:P2')

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read', 'audit.read']
const RECORDS: Permission[] = ['parties.view', 'parties.manage', 'purchasing.view', 'purchasing.sources.manage']

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  buyer: { permissions: [...IMPORTS, ...RECORDS, 'purchasing.suppliers.status', 'money.cost'], companies: 'all' },
  clerk: { permissions: [...IMPORTS, ...RECORDS], companies: 'all' },
  companyA: { permissions: [...IMPORTS, ...RECORDS, 'money.cost'], companies: [companyA] },
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
const call = (session: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (): CommandCaller => callerFor(database, systemContext(tenant, newId()))
const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
async function upload(session: string, importerKey: string, body: Buffer, fields: Json = {}): Promise<Json> {
  const started = await call(session, 'POST', '/imports', { importerKey, file: { originalName: 'sheet.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) }, ...fields })
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
const errorsOf = (rows: readonly Json[], rowNumber: number): Json[] => rows.find((row) => row.rowNumber === rowNumber)?.errors ?? []

beforeAll(async () => {
  db = await migratedDatabase('suppliers_import_311')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-suppliers-import-311-'))
  await seedCore({ db: database, namespace: NS })
  await seedProduct({ db: database, namespace: NS })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}.311@example.com`, key])
    const grains = person.permissions.filter((permission) => permission.startsWith('money.')).map((permission) => permission.slice('money.'.length))
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [roleId, tenant, `custom.${key.toLowerCase()}`, key, person.permissions.filter((permission) => !permission.startsWith('money.')), grains])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`, [
      newId(),
      tenant,
      IDS[key],
      roleId,
      person.companies === 'all',
      person.companies === 'all' ? [] : person.companies,
    ])
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters(undefined)
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
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

describe('suppliers from a sheet: kinds, status, lead time and origin (SCM-289)', () => {
  it('updates a supplier and creates one with Italian words, refusing what the supplier record refuses', async () => {
    const sheet = csv([
      'Codice;Ragione sociale;Ruoli;Tipo fornitore;Stato fornitore;Motivo stato;Lead time;Paese di produzione;Origine pelli;Concia',
      'SEED-S1;;;conceria/terzista;sospeso;Ritardi da verificare;14;IT;IT/ES;vegetale',
      'SD311-IMP;Accessori Esempio S.r.l.;fornitore;accessori;con riserva;Campioni da validare;30;PK;;',
      'SD311-BAD;Fornitore Strano S.r.l.;fornitore;accessori;;;;;;cromo',
      'SD311-NOR;Fornitore Senza Motivo S.r.l.;fornitore;;bloccato;;;;;',
    ])
    const job = await upload('buyer', 'parties.parties', sheet, { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1, updateCount: 1, errorCount: 2 })
    const rows = await rowsOf('buyer', job.id)
    expect(rows.find((row) => row.rowNumber === 2)).toMatchObject({
      action: 'UPDATE',
      before: { supplierKinds: null, supplierStatus: null, leadTimeDays: 21 },
      after: { supplierKinds: 'TANNERY; SUBCONTRACTOR', supplierStatus: 'ON_HOLD', supplierStatusReason: 'Ritardi da verificare', leadTimeDays: 14, originCountry: 'IT', hideOriginCountries: 'IT; ES', tannages: 'VEGETABLE' },
    })
    expect(errorsOf(rows, 4)).toEqual([{ column: 'tannages', message: expect.stringContaining('a tannery’s') }])
    expect(errorsOf(rows, 5)).toEqual([{ column: 'supplierStatusReason', message: expect.stringContaining('Say why the supplier is blocked') }])

    expect(await apply('buyer', job)).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const [s1] = await admin<Json>(`SELECT "supplierKinds"::text[] AS kinds, "supplierStatus"::text AS status, "supplierStatusReason" AS reason, "supplierStatusChangedById" AS "by", "leadTimeDays", "originCountry", "hideOriginCountries", tannages::text[] AS tannages FROM "Party" WHERE id = $1`, [S1])
    expect(s1).toEqual({ kinds: ['TANNERY', 'SUBCONTRACTOR'], status: 'ON_HOLD', reason: 'Ritardi da verificare', by: null, leadTimeDays: 14, originCountry: 'IT', hideOriginCountries: ['IT', 'ES'], tannages: ['VEGETABLE'] })
    const [created] = await admin<Json>(`SELECT id::text, "companyId"::text AS "companyId", "supplierKinds"::text[] AS kinds, "supplierStatus"::text AS status, "supplierStatusReason" AS reason, "originCountry" FROM "Party" WHERE code = 'SD311-IMP'`)
    expect(created).toMatchObject({ companyId: companyA, kinds: ['TRIMS'], status: 'CONDITIONAL', reason: 'Campioni da validare', originCountry: 'PK' })
    const events = await admin<{ type: string; payload: Json }>(`SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 AND type IN ('supplier.status_changed', 'party.updated') ORDER BY "occurredAt", id`, [S1])
    expect(events.map((event) => event.type)).toEqual(['party.updated', 'supplier.status_changed'])
    expect(events[1]!.payload).toMatchObject({ from: null, status: 'ON_HOLD' })

    // The same sheet again: what it gives is there now.
    const again = await upload('buyer', 'parties.parties', csv(['Codice;Tipo fornitore;Stato fornitore;Motivo stato;Lead time', 'SEED-S1;conceria/terzista;sospeso;Ritardi da verificare;14']), { companyId: companyA })
    expect(again).toMatchObject({ status: 'PLANNED', unchangedCount: 1 })
    // A move the lifecycle does not allow, and dropping the supplier role while a status is set.
    const moves = await upload('buyer', 'parties.parties', csv(['Codice;Ruoli;Stato fornitore', 'SEED-S1;;potenziale', 'SD311-IMP;cliente;']), { companyId: companyA })
    const moveRows = await rowsOf('buyer', moves.id)
    expect(errorsOf(moveRows, 2)).toEqual([{ column: 'supplierStatus', message: expect.stringContaining('on hold is not made a prospect') }])
    expect(errorsOf(moveRows, 3)).toEqual([{ column: 'roles', message: expect.stringContaining('keeps a supplier, subcontractor or carrier role') }])
  })

  it('refuses the Supplier status column for a person without purchasing.suppliers.status', async () => {
    const job = await upload('clerk', 'parties.parties', csv(['Codice;Stato fornitore', 'SEED-S1;approvato']), { companyId: companyA })
    expect(job.status).toBe('FAILED')
    expect(JSON.stringify(job.issues)).toContain('purchasing.suppliers.status')
    expect(await upload('clerk', 'parties.parties', csv(['Codice;Lead time', 'SEED-S1;12']), { companyId: companyA })).toMatchObject({ status: 'PLANNED', updateCount: 1 })
  })
})

describe('a supplier’s price list from a sheet (SCM-289)', () => {
  it('makes approved sources in the job’s company, refusing what a source refuses', async () => {
    const sheet = csv([
      'Fornitore;Articolo;Colore;Articolo fornitore;UM;Prezzo;Valuta;Minimo;Lead time;Preferenza',
      'SEED-S1;SEED-LEA-100;BLK;VACCHETTA-12;HIDE;210,50;EUR;10;21;principale',
      'SEED-S1;SEED-LIN-200;tutti;FODERA-7;ROLL;4,10;;;;',
      'SEED-S1;SEED-LEA-100;PNK;;;12;;;;',
      'SEED-C1;SEED-LEA-100;*;;;12;;;;',
      'NOPE;SEED-LEA-100;*;;;12;;;;',
      'SEED-S1;SEED-LEA-100;RED;;KG;12;;;;',
    ])
    const job = await upload('buyer', 'purchasing.supplierPrices', sheet, { companyId: companyA })
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 2, errorCount: 4 })
    const rows = await rowsOf('buyer', job.id)
    expect(errorsOf(rows, 4)).toEqual([{ column: 'colour', message: expect.stringContaining('has no colour PNK') }])
    expect(errorsOf(rows, 5)).toEqual([{ column: 'supplier', message: expect.stringContaining('is not a supplier') }])
    expect(errorsOf(rows, 6)).toEqual([{ column: 'supplier', message: 'No supplier has the code NOPE.' }])
    expect(errorsOf(rows, 7)[0]).toMatchObject({ column: 'purchaseUom' })

    expect(await apply('buyer', job)).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const sources = (await call('buyer', 'GET', `/purchasing/supplier-items?partyId=${S1}&companyId=${companyA}`)).json().items as Json[]
    expect(sources.map((source) => [source.item.code, source.colour?.code ?? '*', source.unitPrice, source.preference, source.companyId]).sort()).toEqual([
      ['SEED-LEA-100', 'BLK', '210.5', 'PRIMARY', companyA],
      ['SEED-LIN-200', '*', '4.1', 'PRIMARY', companyA],
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordType" = 'SupplierItem' AND action = 'purchasing.sources.import'`))[0]!.n).toBe(2)

    // A second sheet: one price changes, the other row is the same.
    const update = await upload('buyer', 'purchasing.supplierPrices', csv(['Fornitore;Articolo;Colore;Prezzo', 'SEED-S1;SEED-LEA-100;BLK;205', 'SEED-S1;SEED-LIN-200;*;4,10']), { companyId: companyA })
    expect(update).toMatchObject({ status: 'PLANNED', updateCount: 1, unchangedCount: 1 })
    expect((await rowsOf('buyer', update.id)).find((row) => row.rowNumber === 2)).toMatchObject({ action: 'UPDATE' })
    expect(await apply('buyer', update)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    const leather = ((await call('buyer', 'GET', `/purchasing/supplier-items?partyId=${S1}&companyId=${companyA}`)).json().items as Json[]).find((source) => source.item.code === 'SEED-LEA-100')!
    expect(leather).toMatchObject({ unitPrice: '205', supplierArticleCode: 'VACCHETTA-12', version: 2 })
  })

  it('refuses a price column without the cost grain, and a list for every company without a role over every company', async () => {
    const noCost = await upload('clerk', 'purchasing.supplierPrices', csv(['Fornitore;Articolo;Colore;Prezzo', 'SEED-S1;SEED-LIN-200;*;4']), { companyId: companyA })
    expect(noCost.status).toBe('FAILED')
    expect(JSON.stringify(noCost.issues)).toContain('cost')
    const started = await call('companyA', 'POST', '/imports', { importerKey: 'purchasing.supplierPrices', file: { originalName: 'sheet.csv', contentType: SHEET_TYPES.csv, sizeBytes: 10, sha256: sha256(Buffer.from('0123456789')) } })
    expect(started.statusCode, started.body).toBeGreaterThanOrEqual(400)
  })
})
