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
import { seed as seedParties } from '../../../../../../packages/factory-db/seed/parties'
import { seed as seedPlant } from '../../../../../../packages/factory-db/seed/plant'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { localFileStore } from '../../../adapters/local-files/local'
import { buildApp } from '../../../core/app'
import { callerFor, type CommandCaller } from '../../../core/command'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { machinesImportAdapter } from '../../../modules/plant/machines/import'
import { createFilesRuntime, useFiles } from '../../files/service'
import { createGateway } from '../../gateway/gateway'
import { systemContext } from '../../outbox/system'
import { testRedis, type TestRedis } from '../../outbox/testing'
import { createSecretsService } from '../../secrets/envelope'
import { localKeyProvider } from '../../secrets/local'
import { IMPORTERS, useImporters } from '../registry'
import { applyPlan, planImport } from '../worker'

/**
 * B-W2b-25's importer follow-ups through the imports platform's real routes and worker steps (POST /imports, the upload,
 * the dry run, the apply): a customer's commercial terms columns in the parties import (the B-W2a-49 gap), the Workshop
 * column in the locations import (B-W2a-25) and the machines import for Plant (B-W2a-53). A throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the triggers are real), the seeds' parties
 * (SEED-C1 a tenant-wide customer and brand, SEED-C2 a tenant-wide customer, SEED-S1 company A's supplier and
 * subcontractor) and plant (sites A1 of company A and B1 of company B, the machine classes, SEED-SEW-L1-01 at SEW-01),
 * made-up payment terms and price lists, the gateway on the local Redis under this file's prefix and the local file store
 * in a temporary folder. Every code and figure is made up. Run with `node scripts/factory/run-pg-tests.mjs platform/imports/importers`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string

const NS = 'importers-w2b25'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const companyB = seedId('company:B')
const C2 = seedId('party:P3')
const S1 = seedId('party:P2')
const sewMachine = `00000000${seedId('plant:machine:SEED-SEW-L1-01').slice(8)}`

const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read', 'audit.read']
const RECORDS: Permission[] = ['parties.view', 'parties.manage', 'inventory.locations.view', 'inventory.locations.manage', 'plant.view', 'plant.machines.manage', 'paymentterms.view', 'pricelists.view']

interface Person {
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
}
const PEOPLE: Record<string, Person> = {
  manager: { permissions: [...IMPORTS, ...RECORDS, 'pricelists.manage', 'money.price', 'money.cost'], companies: 'all' },
  noLists: { permissions: [...IMPORTS, ...RECORDS, 'money.price', 'money.cost'], companies: 'all' },
  noCost: { permissions: [...IMPORTS, ...RECORDS, 'pricelists.manage', 'money.price'], companies: 'all' },
  companyB: { permissions: [...IMPORTS, ...RECORDS, 'money.cost'], companies: [companyB] },
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
const errorsOf = (rows: readonly Json[], rowNumber: number): Json[] => rows.find((row) => row.rowNumber === rowNumber)?.errors ?? []

const termsId = newId()
const oldTermsId = newId()
const listId = newId()
const dollarListId = newId()
const secondListId = newId()

beforeAll(async () => {
  db = await migratedDatabase('importers_w2b25')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-importers-w2b25-'))
  await seedCore({ db: database, namespace: NS })
  await seedParties({ db: database, namespace: NS })
  await seedPlant({ db: database, namespace: NS })
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  await admin(
    `INSERT INTO "PaymentTerms" (id, "tenantId", code, name, method, instalments, status) VALUES
       ($1, $3, 'TEST-BB60', 'Bonifico 60 gg (made up)', 'MP05', '[{"sharePct": "100.0000", "from": "INVOICE", "days": 60}]', 'ACTIVE'),
       ($2, $3, 'TEST-OLD', 'Old terms (made up)', 'MP05', '[{"sharePct": "100.0000", "from": "INVOICE", "days": 30}]', 'ARCHIVED')`,
    [termsId, oldTermsId, tenant],
  )
  await admin(
    `INSERT INTO "PriceList" (id, "tenantId", code, name, kind, currency) VALUES ($1, $3, 'TEST-PL-ALL', 'Made-up list', 'BASE', 'EUR'), ($2, $3, 'TEST-PL-USD', 'Made-up dollar list', 'BASE', 'USD'), ($4, $3, 'TEST-PL-B', 'Made-up second list', 'BASE', 'EUR')`,
    [listId, dollarListId, tenant, secondListId],
  )
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], tenant, `${key}@example.com`, key])
    const grains = person.permissions.filter((permission) => permission.startsWith('money.')).map((permission) => permission.slice('money.'.length))
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, $6)`, [
      roleId,
      tenant,
      `custom.${key.toLowerCase()}`,
      key,
      person.permissions.filter((permission) => !permission.startsWith('money.')),
      grains,
    ])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`,
      [newId(), tenant, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters(undefined)
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

describe("a customer's commercial terms in the parties import (B-W2b-25)", () => {
  it('creates a customer with its terms and gives another its list, refusing what the terms card refuses', async () => {
    const sheet = csv([
      'Code;Legal name;Roles;Payment terms code;Price list;Default deposit %;Invoicing;Incoterm;Preferred carrier;Minimum order',
      'NEW-C1;Nuovo Cliente S.r.l.;cliente;TEST-BB60;TEST-PL-ALL;30;mensile;DAP;BRT;1.250,50',
      'SEED-C2;;;;TEST-PL-ALL;;;FCA;;',
      'NEW-S9;Fornitore Nuovo S.r.l.;fornitore;;;;;EXW;;',
      'NEW-C3;Altro Cliente S.r.l.;cliente;TEST-OLD;;;;;;',
      'NEW-C4;Cliente Dollari S.r.l.;cliente;;TEST-PL-USD;;;;;',
      'NEW-C5;Cliente Strano S.r.l.;cliente;;;120;;XYZ;;',
    ])
    const job = await upload('manager', 'parties.parties', sheet)
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1, updateCount: 1, errorCount: 4 })
    const rows = await rowsOf('manager', job.id)
    expect(rows.find((row) => row.rowNumber === 3)).toMatchObject({ action: 'UPDATE', before: { list: null, incoterm: null }, after: { list: 'TEST-PL-ALL', incoterm: 'FCA' } })
    expect(errorsOf(rows, 4)).toEqual([{ column: 'incoterm', message: expect.stringContaining("Commercial terms are a customer's") }])
    expect(errorsOf(rows, 5)).toEqual([{ column: 'paymentTermsCode', message: 'TEST-OLD is archived: give the customer active terms.' }])
    expect(errorsOf(rows, 6)).toEqual([{ column: 'list', message: "TEST-PL-USD is in USD; NEW-C4's documents are in EUR." }])
    expect(errorsOf(rows, 7).map((issue) => issue.column)).toEqual(['defaultDepositPct', 'incoterm'])

    const applied = await apply('manager', job)
    expect(applied).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const created = (await admin<{ id: string }>(`SELECT id::text FROM "Party" WHERE code = 'NEW-C1'`))[0]!
    const terms = (await call('manager', 'GET', `/parties/${created.id}/commercial-terms`)).json().terms
    expect(terms).toMatchObject({
      paymentTermsId: termsId,
      priceListId: listId,
      defaultDepositPct: '30',
      invoiceTiming: 'MONTHLY',
      incoterm: 'DAP',
      preferredCarrierCode: 'BRT',
      minimumOrderAmount: 125050,
    })
    expect((await call('manager', 'GET', `/parties/${C2}/commercial-terms`)).json().terms).toMatchObject({ priceListId: listId, incoterm: 'FCA' })
    // The audit row in the terms card's shape (the list as listId, the minimum marked price), and party.updated with the fields.
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'Party' AND "recordId" = $1 AND action = 'parties.setCommercialTerms'`, [C2])
    expect(audit).toHaveLength(1)
    expect(audit[0]!.after).toMatchObject({ listId, incoterm: 'FCA', minimumOrderAmount: { $money: 'price', value: null } })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'party.updated'`, [C2])
    expect(events.map((event) => event.payload.fields)).toContainEqual(['priceListId', 'incoterm'])

    // B-W2b-16: the dated list history follows, as with the terms card: one open row from today for each customer given a list.
    const history = await admin<{ party: string; list: string; open: boolean; today: boolean }>(
      `SELECT p.code AS party, l.code AS list, a."validTo" IS NULL AS open, a."validFrom" = (now() AT TIME ZONE 'Europe/Rome')::date AS today
       FROM "PartyPriceListAssignment" a JOIN "Party" p ON p.id = a."partyId" JOIN "PriceList" l ON l.id = a."priceListId" WHERE p.code IN ('NEW-C1', 'SEED-C2') ORDER BY p.code`,
    )
    expect(history).toEqual([
      { party: 'NEW-C1', list: 'TEST-PL-ALL', open: true, today: true },
      { party: 'SEED-C2', list: 'TEST-PL-ALL', open: true, today: true },
    ])
    expect((await admin(`SELECT count(*)::int AS n FROM "AuditLog" WHERE "recordId" = $1 AND action = 'priceLists.assign'`, [C2]))[0]!.n).toBe(1)
    // A customer's list changes at most once a day: a second list today is refused in the dry run, in the history's words.
    const twice = await upload('manager', 'parties.parties', csv(['Code;Price list', 'SEED-C2;TEST-PL-B']))
    expect(twice).toMatchObject({ status: 'PLANNED', errorCount: 1 })
    expect(errorsOf(await rowsOf('manager', twice.id), 2)).toEqual([{ column: 'list', message: expect.stringMatching(/SEED-C2 has had TEST-PL-ALL since .*: a customer's list changes at most once a day/) }])

    // The same sheet again: the terms rows are unchanged now.
    const again = await upload('manager', 'parties.parties', csv(['Code;Price list;Incoterm', 'SEED-C2;TEST-PL-ALL;FCA', 'NEW-C1;TEST-PL-ALL;DAP']))
    expect(again).toMatchObject({ unchangedCount: 2, errorCount: 0 })
  })

  it('refuses a sheet with a price list for a person who may not give lists, and a minimum order without the price grain', async () => {
    // The columns are known once the sheet is read: the dry run fails the job with the reason.
    const lists = await upload('noLists', 'parties.parties', csv(['Code;Price list', 'SEED-C2;TEST-PL-ALL']))
    expect(lists.status).toBe('FAILED')
    expect(JSON.stringify(lists.issues)).toContain('pricelists.manage')
    // The minimum order carries the price grain: a person without it cannot map it (companyB holds no price grain).
    const noPrice = await upload('companyB', 'parties.parties', csv(['Code;Minimum order', 'NEW-B1;100']), { companyId: companyB })
    expect(noPrice.status).toBe('FAILED')
    expect(JSON.stringify(noPrice.issues)).toContain('price')
    // Without the list column, a person who may not give lists imports the other terms.
    expect(await upload('noLists', 'parties.parties', csv(['Code;Minimum order;Incoterm', 'SEED-C2;100;FCA']))).toMatchObject({ status: 'PLANNED', updateCount: 1 })
    // The currency moves while the customer keeps a list in euros: refused in the dry run, at the currency.
    const currency = await upload('manager', 'parties.parties', csv(['Code;Currency', 'SEED-C2;USD']))
    expect(errorsOf(await rowsOf('manager', currency.id), 2)).toEqual([{ column: 'currency', message: expect.stringContaining('give it a list in USD') }])
  })
})

describe('the Workshop column of the locations import (B-W2b-25)', () => {
  it("makes a workshop's stock location with its workshop and refuses what the locations page refuses", async () => {
    const job = await upload(
      'manager',
      'inventory.locations',
      csv([
        'Site;Code;Name;Kind;Workshop',
        'A1;A1-TERZ-S1;Stock at the workshop;SUBCONTRACTOR;SEED-S1',
        'A1;A1-TERZ-C1;Not a workshop;SUBCONTRACTOR;SEED-C1',
        'A1;A1-BIN-X;A bin;BIN;SEED-S1',
        'A1;A1-TERZ-S1B;The same workshop again;SUBCONTRACTOR;SEED-S1',
        'A1;A1-TERZ-NONE;No workshop named;SUBCONTRACTOR;',
      ]),
      { companyId: companyA },
    )
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1, errorCount: 4 })
    const rows = await rowsOf('manager', job.id)
    expect(errorsOf(rows, 3)).toEqual([{ column: 'workshop', message: 'The party is no subcontractor: give it the SUBCONTRACTOR role first.' }])
    expect(errorsOf(rows, 4)).toEqual([{ column: 'workshop', message: expect.stringContaining('Only a Subcontractor location') }])
    expect(errorsOf(rows, 5)).toEqual([{ column: 'workshop', message: expect.stringContaining('named twice') }])
    expect(errorsOf(rows, 6)).toEqual([{ column: 'workshop', message: expect.stringContaining('name it') }])
    expect(await apply('manager', job)).toMatchObject({ status: 'APPLIED', appliedCount: 1 })
    expect(await admin(`SELECT kind::text, "partyId"::text AS "partyId" FROM "Location" WHERE code = 'A1-TERZ-S1'`)).toEqual([{ kind: 'SUBCONTRACTOR', partyId: S1 }])

    // One stock location per workshop and site: a second one is refused; the same row again is unchanged.
    const second = await upload('manager', 'inventory.locations', csv(['Site;Code;Name;Kind;Workshop', 'A1;A1-TERZ-S1C;Another;SUBCONTRACTOR;SEED-S1', 'A1;A1-TERZ-S1;Stock at the workshop;SUBCONTRACTOR;SEED-S1']), { companyId: companyA })
    expect(second).toMatchObject({ errorCount: 1, unchangedCount: 1 })
    expect(errorsOf(await rowsOf('manager', second.id), 2)).toEqual([{ column: 'workshop', message: expect.stringContaining('has its stock location A1-TERZ-S1 on site A1 already') }])
  })
})

describe('the machines import (B-W2b-25)', () => {
  it('is registered beside the W1 and W2a importers', () => {
    expect(IMPORTERS).toContain(machinesImportAdapter)
  })

  it('registers a machine and moves another, with their events and audit rows, and refuses codes it cannot find', async () => {
    const job = await upload(
      'manager',
      'plant.machines',
      csv([
        'Asset number;Site;Class;Make;Year;Station;Work centre;Supplier;Purchase cost;Note',
        'new-sew-09;A1;LOCKSTITCH;Esempio;2020;SEW-02;SEW;SEED-S1;1.250,50;Nuova',
        'SEED-SEW-L1-01;;;;;SEW-02;;;;Spostata',
        'NEW-X-01;A1;NOPE;;;;;;;',
        'NEW-X-02;;LOCKSTITCH;;;;;;;',
        'NEW-X-03;A1;LOCKSTITCH;;;CUT-99;;SEED-C2;;',
        'NEW-X-04;B1;LOCKSTITCH;;;;;;;',
      ]),
      { companyId: companyA },
    )
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1, updateCount: 1, errorCount: 4 })
    const rows = await rowsOf('manager', job.id)
    expect(rows.find((row) => row.rowNumber === 3)).toMatchObject({ action: 'UPDATE', before: { station: 'SEW-01', note: null }, after: { station: 'SEW-02', note: 'Spostata' } })
    expect(errorsOf(rows, 4)).toEqual([{ column: 'machineClass', message: "No machine class NOPE in the group's list." }])
    expect(errorsOf(rows, 5)).toEqual([{ column: 'site', message: 'Site is needed for a new machine.' }])
    expect(errorsOf(rows, 6)).toEqual([
      { column: 'station', message: 'Site A1 has no station CUT-99.' },
      { column: 'supplier', message: 'SEED-C2 is not a supplier.' },
    ])
    expect(errorsOf(rows, 7)).toEqual([{ column: 'site', message: "Site B1 is not a site of the import's company." }])

    expect(await apply('manager', job)).toMatchObject({ status: 'APPLIED', appliedCount: 2 })
    const made = (await admin<Json>(`SELECT id::text, status::text, "purchaseCost", year, make, note, "companyId"::text AS "companyId" FROM "Machine" WHERE "assetNumber" = 'NEW-SEW-09'`))[0]!
    expect(made).toMatchObject({ status: 'RUNNING', purchaseCost: 125050, year: 2020, make: 'Esempio', note: 'Nuova', companyId: companyA })
    const record = (await call('manager', 'GET', `/plant/machines/${made.id}`)).json().card
    expect(record).toBeTruthy()
    expect((await admin<{ type: string }>(`SELECT type FROM "OutboxEvent" WHERE subject = $1`, [made.id])).map((event) => event.type)).toContain('machine.registered')
    const changed = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = 'machine.changed'`, [sewMachine])
    expect(changed.map((event) => event.payload.fields)).toContainEqual(['stationId', 'note'])
    const audit = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'plant.importMachine'`, [made.id])
    expect(audit[0]!.after).toMatchObject({ assetNumber: 'NEW-SEW-09', purchaseCost: { $money: 'cost', value: 125050 } })
  })

  it("refuses the cost column without the cost grain, another company's machine, and a job for a company the person does not keep", async () => {
    const cost = await upload('noCost', 'plant.machines', csv(['Asset number;Purchase cost', 'SEED-SEW-L1-01;10']), { companyId: companyA })
    expect(cost.status).toBe('FAILED')
    expect(JSON.stringify(cost.issues)).toContain('cost')
    const other = await upload('manager', 'plant.machines', csv(['Asset number;Note', 'SEED-SEW-L1-01;From B']), { companyId: companyB })
    expect(errorsOf(await rowsOf('manager', other.id), 2)).toEqual([{ column: 'assetNumber', message: expect.stringContaining("another company's machine") }])
    expect((await start('companyB', 'plant.machines', csv(['Asset number;Note', 'X-1;x']), { companyId: companyA })).statusCode).toBe(403)
  })
})
