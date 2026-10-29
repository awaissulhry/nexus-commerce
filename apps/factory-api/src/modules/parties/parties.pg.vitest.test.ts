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
import { FakeVies } from '../../adapters/vies/fake'
import { localFileStore } from '../../adapters/local-files/local'
import { buildApp } from '../../core/app'
import { callerFor, type CommandCaller } from '../../core/command'
import { testAuthenticator, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { createFilesRuntime, useFiles } from '../../platform/files/service'
import { createGateway } from '../../platform/gateway/gateway'
import { useImporters } from '../../platform/imports/registry'
import { applyPlan, planImport } from '../../platform/imports/worker'
import { systemContext } from '../../platform/outbox/system'
import { testRedis, type TestRedis } from '../../platform/outbox/testing'
import { createSecretsService } from '../../platform/secrets/envelope'
import { localKeyProvider } from '../../platform/secrets/local'
import { partiesImportAdapter } from './importer'
import { lockTaxNumbers } from './store'
import { createViesRuntime, useVies } from './vies'

/**
 * Customers and suppliers on the local stack (B-W1-07; features SAL-001, SAL-003..006, SCM-001, SCM-289), with the
 * app's real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login, so row-level security
 * and the ViesCheck triggers are real), sessions from the test authenticator, the gateway on the local Redis under
 * this file's own prefix with a FAKE VIES account (adapters/vies/fake.ts: a number ending in 8 is invalid, in 9 gets no
 * answer) and, for the import, the local file store in a temporary folder. Every party, number and address here is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs parties`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let redis: TestRedis
let connection: Redis
let localRoot: string
const fake = new FakeVies()

/** A made-up Partita IVA: ten digits and their check digit (DM 23.12.1976 rule, tax/tax-ids). */
function partitaIva(first10: string): string {
  let total = 0
  for (let index = 0; index < 10; index++) {
    const digit = Number(first10[index])
    total += index % 2 === 0 ? digit : digit * 2 > 9 ? digit * 2 - 9 : digit * 2
  }
  return `${first10}${(10 - (total % 10)) % 10}`
}

const tenantA = newId()
const tenantB = newId()
const companyA1 = newId()
const companyA2 = newId()
const companyB = newId()
const viesA = newId()
const VAT = { A1: `IT${partitaIva('9000000001')}`, A2: `IT${partitaIva('9000000002')}`, B: `IT${partitaIva('9000000003')}` }

const VIEW = 'parties.view'
const MANAGE = 'parties.manage'
const BLOCK = 'parties.block'
const VIES = 'parties.vies'
const IMPORTS: Permission[] = ['imports.view', 'imports.run', 'imports.apply', 'files.upload', 'files.read']

interface Person {
  readonly tenantId: string
  readonly permissions: readonly Permission[]
  readonly companies: ScopeSet
  readonly parties?: ScopeSet
}
const limitedTo: string[] = []
const PEOPLE: Record<string, Person> = {
  sales: { tenantId: tenantA, permissions: [VIEW, MANAGE, VIES, 'audit.read', ...IMPORTS], companies: 'all' },
  finance: { tenantId: tenantA, permissions: [VIEW, MANAGE, BLOCK, VIES], companies: 'all' },
  viewer: { tenantId: tenantA, permissions: [VIEW], companies: 'all' },
  companyOne: { tenantId: tenantA, permissions: [VIEW, MANAGE, VIES, ...IMPORTS], companies: [companyA1] },
  oneCustomer: { tenantId: tenantA, permissions: [VIEW, MANAGE, ...IMPORTS], companies: 'all', parties: limitedTo },
  otherTenant: { tenantId: tenantB, permissions: [VIEW, MANAGE, VIES], companies: 'all' },
}
const IDS: Record<string, string> = Object.fromEntries(Object.keys(PEOPLE).map((key) => [key, newId()]))
const sessionOf = (key: string): SessionContext | null => {
  const person = PEOPLE[key]
  if (!person) return null
  const grant: Grant = { permissions: [...person.permissions], companies: person.companies, sites: 'all', parties: person.parties ?? 'all' }
  return { audience: 'office', tenantId: person.tenantId, actorId: IDS[key]!, grants: [grant] }
}

type Json = Record<string, any>
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const call = (session: string, method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, payload?: unknown, headers: Record<string, string> = {}) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...headers }, ...(payload === undefined ? {} : { payload: payload as object }) })
const system = (tenantId = tenantA): CommandCaller => callerFor(database, systemContext(tenantId, newId()))

async function create(session: string, body: Json): Promise<Json> {
  const response = await call(session, 'POST', '/parties', body)
  expect(response.statusCode, response.body).toBe(201)
  return response.json().party
}
async function read(session: string, id: string): Promise<Json> {
  const response = await call(session, 'GET', `/parties/${id}`)
  expect(response.statusCode, response.body).toBe(200)
  return response.json().party
}
async function check(session: string, id: string, body: Json = { companyId: companyA1 }, status = 201): Promise<Json> {
  const response = await call(session, 'POST', `/parties/${id}/vies-checks`, body)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
const eventsOf = async (subject: string) => admin<{ type: string; payload: Json }>('SELECT type, payload FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])

const ITALIAN_VAT = partitaIva('1000000001')
const ITALIAN_CUSTOMER = {
  code: 'cli-001',
  legalName: 'Cliente Esempio S.r.l.',
  roles: ['CUSTOMER'],
  paymentTerms: 'Bonifico 30 gg d.f.',
  taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: ITALIAN_VAT, fiscalCode: ITALIAN_VAT, sdiRecipientCode: 'abc1234', validFrom: '2026-01-01' },
  addresses: [
    { kinds: ['REGISTERED', 'BILL_TO'], line1: 'Via Esempio 10', postalCode: '50100', city: 'Firenze', province: 'fi', country: 'IT' },
    { kinds: ['SHIP_TO'], name: 'Magazzino', line1: 'Via del Deposito 2', postalCode: '50019', city: 'Sesto Fiorentino', province: 'FI', country: 'IT', deliveryNotes: 'Banchina 3, 8-12' },
  ],
  contacts: [
    { name: 'Anna Esempio', email: 'Anna@Example.com', roles: ['ORDERS'] },
    { name: 'Bruno Esempio', email: 'amministrazione@example.com', roles: ['INVOICES'], language: 'it' },
  ],
}
const EU_CUSTOMER = (code: string, number: string) => ({
  code,
  legalName: `Kunde ${code} GmbH`,
  roles: ['CUSTOMER'],
  country: 'DE',
  language: 'de',
  taxIdentity: { country: 'DE', taxMode: 'EU_B2B', vatNumber: number },
  addresses: [{ kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], line1: 'Beispielstraße 1', postalCode: '10115', city: 'Berlin', country: 'DE' }],
  contacts: [{ name: 'Clara Beispiel', email: `einkauf-${code.toLowerCase()}@example.com`, roles: ['ORDERS'] }],
})

beforeAll(async () => {
  db = await migratedDatabase('parties')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  redis = testRedis()
  connection = redis.connect()
  localRoot = mkdtempSync(join(tmpdir(), 'factory-parties-test-'))
  for (const [tenantId, slug, companies] of [
    [tenantA, 'parties-a', [[companyA1, VAT.A1], [companyA2, VAT.A2]]],
    [tenantB, 'parties-b', [[companyB, VAT.B]]],
  ] as const) {
    await admin('INSERT INTO "Tenant" (id, slug, name) VALUES ($1, $2, $2)', [tenantId, slug])
    for (const [index, [companyId, vat]] of companies.entries()) {
      await admin('INSERT INTO "Company" (id, "tenantId", code, "legalName", "vatNumber") VALUES ($1, $2, $3, $3, $4)', [companyId, tenantId, `${slug}-${index + 1}`, vat])
    }
    await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenantId])
    await admin(
      `INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst", "circuitFailureThreshold") VALUES ($1, $2, 'VIES', 'vies', 'VIES (fake)', 'FAKE', 6000, 1000, 1000)`,
      [tenantId === tenantA ? viesA : newId(), tenantId],
    )
  }
  for (const [key, person] of Object.entries(PEOPLE)) {
    const roleId = newId()
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [IDS[key], person.tenantId, `${key}@example.com`, key])
    await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, grains) VALUES ($1, $2, $3, $4, $5, '{}')`, [roleId, person.tenantId, `custom.${key.toLowerCase()}`, key, person.permissions])
    await admin(
      `INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, $5, $6, now() - interval '1 day')`,
      [newId(), person.tenantId, IDS[key], roleId, person.companies === 'all', person.companies === 'all' ? [] : person.companies],
    )
  }
  const secrets = createSecretsService({ providers: [localKeyProvider({ masterKey: randomBytes(32), environment: 'test' })] })
  const gateway = createGateway({ environment: 'test', redis: connection, prefix: redis.prefix, secrets, sleep: async () => {}, log: { info() {}, warn() {}, error() {} } })
  useFiles(createFilesRuntime({ gateway, local: localFileStore({ root: localRoot, environment: 'test' }) }))
  useImporters([partiesImportAdapter])
  useVies(createViesRuntime({ gateway, fake }))
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    {
      database,
      routesRoot: fileURLToPath(new URL('../..', import.meta.url)),
      authenticate: testAuthenticator((request) => sessionOf(String(request.headers['x-test-session']))),
    },
  )
}, 60_000)

afterAll(async () => {
  useVies(undefined)
  useImporters(undefined)
  useFiles(undefined)
  await app?.close()
  await redis?.cleanup()
  await database?.close()
  await db?.close()
  if (localRoot) rmSync(localRoot, { recursive: true, force: true })
}, 60_000)

let italianId: string

describe('customers and suppliers through the API (SAL-001, SAL-003, SAL-004, SAL-005, SCM-001)', () => {
  it('creates an Italian company customer with its tax identity, addresses and contacts in one command', async () => {
    const party = await create('sales', ITALIAN_CUSTOMER)
    italianId = party.id
    expect(party).toMatchObject({
      code: 'CLI-001',
      companyId: null,
      kind: 'ORGANISATION',
      roles: ['CUSTOMER'],
      status: 'ACTIVE',
      country: 'IT',
      currency: 'EUR',
      language: 'it',
      taxMode: 'IT_B2B',
      vatNumber: `IT${ITALIAN_VAT}`,
      fiscalCode: ITALIAN_VAT,
      city: 'Firenze',
      vies: { state: 'NOT_APPLICABLE' },
      paymentTerms: 'Bonifico 30 gg d.f.',
      blocked: null,
      warnings: [],
      version: 1,
      createdById: IDS.sales,
    })
    expect(party.taxIdentities).toEqual([expect.objectContaining({ country: 'IT', sdiRecipientCode: 'ABC1234', validFrom: '2026-01-01', current: true })])
    // The first BILL_TO and SHIP_TO addresses became the defaults.
    expect(party.addresses.map((address: Json) => [address.kinds, address.province, address.isDefaultBillTo, address.isDefaultShipTo])).toEqual([
      [['REGISTERED', 'BILL_TO'], 'FI', true, false],
      [['SHIP_TO'], 'FI', false, true],
    ])
    expect(party.contacts.map((contact: Json) => [contact.email, contact.roles])).toEqual([
      ['anna@example.com', ['ORDERS']],
      ['amministrazione@example.com', ['INVOICES']],
    ])
    expect((await eventsOf(party.id)).map((event) => event.type)).toEqual(['party.created'])
    const audit = await admin<{ recordType: string; action: string }>('SELECT "recordType", action FROM "AuditLog" WHERE "requestId" = (SELECT "requestId" FROM "AuditLog" WHERE "recordId" = $1 LIMIT 1) ORDER BY "recordType"', [party.id])
    expect(audit.map((row) => row.recordType)).toEqual(['Party', 'PartyAddress', 'PartyAddress', 'PartyContact', 'PartyContact', 'PartyTaxIdentity'])
    expect(new Set(audit.map((row) => row.action))).toEqual(new Set(['parties.create']))
  })

  it('refuses a broken tax identity or address with the field as the path, before any write', async () => {
    const response = await call('sales', 'POST', '/parties', {
      ...ITALIAN_CUSTOMER,
      code: 'CLI-BAD',
      taxIdentity: { ...ITALIAN_CUSTOMER.taxIdentity, vatNumber: `${ITALIAN_VAT.slice(0, 10)}${(Number(ITALIAN_VAT[10]) + 1) % 10}`, fiscalCode: null },
      addresses: [{ kinds: ['REGISTERED'], line1: 'Via X 1', postalCode: '5010', city: 'Firenze', country: 'IT' }],
    })
    expect(response.statusCode).toBe(400)
    expect(response.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/taxIdentity/vatNumber', 'body/addresses/0/postalCode', 'body/addresses/0/province'])
    expect(await admin('SELECT id FROM "Party" WHERE code = $1', ['CLI-BAD'])).toEqual([])
  })

  it('refuses a VAT number or codice fiscale another party of the tenant holds; another tenant may hold it', async () => {
    const same = await call('sales', 'POST', '/parties', { ...ITALIAN_CUSTOMER, code: 'CLI-DUP', addresses: [], contacts: [] })
    expect(same.statusCode).toBe(409)
    expect(same.json().error.message).toBe('This VAT number belongs to party CLI-001: one record per business partner. Open that party, or give it the role it lacks.')
    // A company's codice fiscale is its Partita IVA's digits: the same partner.
    const byCode = await call('sales', 'POST', '/parties', { code: 'FOR-DUP', legalName: 'Fornitore Doppio S.r.l.', roles: ['SUPPLIER'], taxIdentity: { country: 'IT', taxMode: 'IT_B2C', fiscalCode: ITALIAN_VAT } })
    expect(byCode.statusCode).toBe(409)
    expect(await admin('SELECT code FROM "Party" WHERE code IN ($1, $2)', ['CLI-DUP', 'FOR-DUP'])).toEqual([])
    expect((await call('otherTenant', 'POST', '/parties', { ...ITALIAN_CUSTOMER, addresses: [], contacts: [] })).statusCode).toBe(201)
    expect((await call('sales', 'POST', '/parties', { ...ITALIAN_CUSTOMER, taxIdentity: undefined, addresses: [], contacts: [] })).statusCode).toBe(409)
  })

  it('refuses the same number from two creates at once: one party gets it', async () => {
    // Another session holds the number's lock until both requests wait for it, so they truly overlap: the second looks
    // for a clash only after the first committed (without the lock both would find none and both would insert).
    const vat = partitaIva('1000000077')
    let release!: () => void
    const released = new Promise<void>((resolve) => (release = resolve))
    let locked!: () => void
    const holding = new Promise<void>((resolve) => (locked = resolve))
    const holder = database.withScope({ audience: 'office', tenantId: tenantA, actorId: IDS.sales! }, (client) =>
      client.$transaction(
        async (tx) => {
          await lockTaxNumbers(tx, tenantA, { vatNumber: `IT${vat}`, fiscalCode: null })
          locked()
          await released
        },
        { timeout: 20_000 },
      ),
    )
    await holding
    const body = (code: string) => ({ code, legalName: `Gara ${code} S.r.l.`, roles: ['SUPPLIER'], taxIdentity: { country: 'IT', taxMode: 'IT_B2B', vatNumber: vat } })
    const results = Promise.all([call('sales', 'POST', '/parties', body('RACE-1')), call('finance', 'POST', '/parties', body('RACE-2'))])
    const waiting = async () =>
      (await admin<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())`))[0]!.n
    for (let tries = 0; (await waiting()) < 2; tries++) {
      if (tries > 250) throw new Error('the two creates never waited for the number lock')
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    release()
    await holder
    const answers = await results
    expect(answers.map((answer) => answer.statusCode).sort()).toEqual([201, 409])
    expect(await admin('SELECT count(*)::int AS n FROM "PartyTaxIdentity" WHERE "vatNumber" = $1', [`IT${vat}`])).toEqual([{ n: 1 }])
  })

  it('answers 409 to an edit made on an older version, and to an address or default changed meanwhile (COL-078)', async () => {
    const party = await read('sales', italianId)
    const first = await call('sales', 'PATCH', `/parties/${italianId}`, { version: party.version, tradeName: 'Esempio' })
    expect(first.statusCode, first.body).toBe(200)
    expect(first.json().party).toMatchObject({ tradeName: 'Esempio', version: party.version + 1 })
    const stale = await call('finance', 'PATCH', `/parties/${italianId}`, { version: party.version, tradeName: 'Altro' })
    expect(stale.statusCode).toBe(409)
    expect(stale.json().error).toMatchObject({ code: 'conflict', message: expect.stringContaining(`now at version ${party.version + 1}`) })

    const address = first.json().party.addresses[1]
    expect((await call('sales', 'PATCH', `/parties/${italianId}/addresses/${address.id}`, { version: address.version, deliveryNotes: 'Banchina 4' })).statusCode).toBe(200)
    expect((await call('finance', 'PATCH', `/parties/${italianId}/addresses/${address.id}`, { version: address.version, deliveryNotes: 'Banchina 5' })).statusCode).toBe(409)
    // The defaults move on the party's version.
    const before = await read('sales', italianId)
    expect((await call('sales', 'PUT', `/parties/${italianId}/default-addresses`, { version: before.version - 1, shipToAddressId: null })).statusCode).toBe(409)
  })

  it('keeps one default invoice and delivery address, and a removed address stops being one', async () => {
    const party = await read('sales', italianId)
    const added = await call('sales', 'POST', `/parties/${italianId}/addresses`, { kinds: ['SHIP_TO'], name: 'Negozio', line1: 'Piazza Prova 1', postalCode: '59100', city: 'Prato', province: 'PO', country: 'IT', isDefaultShipTo: true })
    expect(added.statusCode, added.body).toBe(201)
    const after = added.json().party
    expect(after.version).toBe(party.version + 1)
    expect(after.addresses.filter((address: Json) => address.isDefaultShipTo).map((address: Json) => address.city)).toEqual(['Prato'])
    const prato = after.addresses.find((address: Json) => address.city === 'Prato')
    const removed = await call('sales', 'PATCH', `/parties/${italianId}/addresses/${prato.id}`, { version: prato.version, status: 'ARCHIVED' })
    expect(removed.statusCode, removed.body).toBe(200)
    expect(removed.json().party.addresses.find((address: Json) => address.id === prato.id)).toMatchObject({ status: 'ARCHIVED', isDefaultShipTo: false })
    expect(removed.json().party.warnings.map((warning: Json) => warning.code)).toEqual(['NO_DEFAULT_SHIP_TO'])
    const sesto = removed.json().party.addresses.find((address: Json) => address.city === 'Sesto Fiorentino')
    const restored = await call('sales', 'PUT', `/parties/${italianId}/default-addresses`, { version: removed.json().party.version, shipToAddressId: sesto.id })
    expect(restored.statusCode, restored.body).toBe(200)
    expect(restored.json().party.warnings).toEqual([])
    const notBill = await call('sales', 'PUT', `/parties/${italianId}/default-addresses`, { version: restored.json().party.version, billToAddressId: sesto.id })
    expect(notBill.statusCode).toBe(400)
  })

  it('keeps contacts with roles, refuses an email used twice, and removes one by archiving it', async () => {
    const twice = await call('sales', 'POST', `/parties/${italianId}/contacts`, { name: 'Altra Anna', email: 'anna@example.com' })
    expect(twice.statusCode).toBe(409)
    const noEmail = await call('sales', 'POST', `/parties/${italianId}/contacts`, { name: 'Dario Esempio', roles: ['QUALITY'] })
    expect(noEmail.statusCode).toBe(400)
    expect(noEmail.json().error.issues).toEqual([{ path: 'body/email', message: 'A contact for quality has an email: the documents go to it.' }])
    const added = await call('sales', 'POST', `/parties/${italianId}/contacts`, { name: 'Dario Esempio', email: 'qualita@example.com', phone: '+39 055 000 0000', roles: ['QUALITY'] })
    expect(added.statusCode, added.body).toBe(201)
    const dario = added.json().party.contacts.find((contact: Json) => contact.email === 'qualita@example.com')
    const gone = await call('sales', 'PATCH', `/parties/${italianId}/contacts/${dario.id}`, { version: dario.version, status: 'ARCHIVED' })
    expect(gone.statusCode, gone.body).toBe(200)
    expect(gone.json().party.contacts.at(-1)).toMatchObject({ id: dario.id, status: 'ARCHIVED' })
    expect((await eventsOf(italianId)).map((event) => event.type)).toContain('party.contacts_changed')
  })

  it('adds a tax identity from a date and keeps the one in force until then', async () => {
    const party = await read('sales', italianId)
    const added = await call('sales', 'POST', `/parties/${italianId}/tax-identities`, { ...ITALIAN_CUSTOMER.taxIdentity, sdiRecipientCode: null, pec: 'fatture@pec.example.it', validFrom: '2099-01-01' })
    expect(added.statusCode, added.body).toBe(201)
    expect(added.json().party.taxIdentities.map((identity: Json) => [identity.validFrom, identity.current, identity.pec])).toEqual([
      ['2099-01-01', false, 'fatture@pec.example.it'],
      ['2026-01-01', true, null],
    ])
    expect(added.json().party.version).toBe(party.version)
    const sameDay = await call('sales', 'POST', `/parties/${italianId}/tax-identities`, { ...ITALIAN_CUSTOMER.taxIdentity, validFrom: '2099-01-01' })
    expect(sameDay.statusCode).toBe(409)
  })
})

describe('status: block, unblock, archive (SAL-001)', () => {
  it('blocks only with parties.block and a reason, keeps the block through edits and never archives a blocked party', async () => {
    const party = await read('sales', italianId)
    expect((await call('sales', 'POST', `/parties/${italianId}/block`, { version: party.version, reason: 'Insoluti' })).statusCode).toBe(403)
    expect((await call('finance', 'POST', `/parties/${italianId}/block`, { version: party.version })).statusCode).toBe(400)
    const blocked = await call('finance', 'POST', `/parties/${italianId}/block`, { version: party.version, reason: 'Fatture insolute da 90 giorni' })
    expect(blocked.statusCode, blocked.body).toBe(200)
    expect(blocked.json().party).toMatchObject({ status: 'BLOCKED', blocked: { reason: 'Fatture insolute da 90 giorni' } })
    const archive = await call('sales', 'POST', `/parties/${italianId}/archive`, { version: blocked.json().party.version })
    expect(archive.statusCode).toBe(409)
    expect(archive.json().error.code).toBe('invalid_state')
    const unblocked = await call('finance', 'POST', `/parties/${italianId}/unblock`, { version: blocked.json().party.version })
    expect(unblocked.json().party).toMatchObject({ status: 'ACTIVE', blocked: null })
    const archived = await call('sales', 'POST', `/parties/${italianId}/archive`, { version: unblocked.json().party.version })
    expect(archived.json().party.status).toBe('ARCHIVED')
    const edit = await call('sales', 'PATCH', `/parties/${italianId}`, { version: archived.json().party.version, tradeName: 'X' })
    expect(edit.statusCode).toBe(409)
    expect((await call('sales', 'POST', `/parties/${italianId}/contacts`, { name: 'X' })).statusCode).toBe(409)
    const back = await call('sales', 'POST', `/parties/${italianId}/reactivate`, { version: archived.json().party.version })
    expect(back.json().party.status).toBe('ACTIVE')
    expect((await eventsOf(italianId)).filter((event) => event.type === 'party.status_changed').map((event) => [event.payload.from, event.payload.status])).toEqual([
      ['ACTIVE', 'BLOCKED'],
      ['BLOCKED', 'ACTIVE'],
      ['ACTIVE', 'ARCHIVED'],
      ['ARCHIVED', 'ACTIVE'],
    ])
  })
})

describe('VIES proof for a zero-rated EU sale (SAL-006; art. 41 DL 331/1993)', () => {
  it('creates an EU business customer that is not proven until VIES answers', async () => {
    const party = await create('sales', EU_CUSTOMER('DE-OK', '100000000'))
    expect(party).toMatchObject({ taxMode: 'EU_B2B', vatNumber: 'DE100000000', vies: { state: 'UNCHECKED', checkedAt: null } })
    expect(party.warnings.map((warning: Json) => warning.code)).toEqual(['VIES_NOT_PROVEN'])
  })

  it('records a VALID identified check with its consultation number, through one gateway call', async () => {
    const party = (await call('sales', 'GET', '/parties?q=DE-OK')).json().parties[0]
    const answer = await check('sales', party.id)
    expect(answer.check).toMatchObject({
      countryCode: 'DE',
      vatNumber: '100000000',
      requesterVatNumber: VAT.A1,
      companyId: companyA1,
      result: 'VALID',
      consultationNumber: expect.stringMatching(/^FAKE[0-9A-F]{12}$/),
      traderName: 'FAKE TRADER DE100000000',
      errorCode: null,
      createdById: IDS.sales,
    })
    expect(answer.vies).toMatchObject({ state: 'VALID', proofCheckId: answer.check.id, maxAgeDays: 30 })
    expect(answer.party.warnings).toEqual([])
    expect(answer.party.viesChecks.map((entry: Json) => entry.id)).toEqual([answer.check.id])
    expect(fake.requests.at(-1)).toEqual({ countryCode: 'DE', vatNumber: '100000000', requester: { countryCode: 'IT', vatNumber: VAT.A1.slice(2) } })
    const [ledger] = await admin('SELECT operation, status, attempts, "requestSummary" FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt" DESC LIMIT 1', [viesA])
    expect(ledger).toMatchObject({ operation: 'vies.check_vat', status: 'SUCCEEDED', attempts: 1, requestSummary: { countryCode: 'DE', identified: true } })
    expect((await eventsOf(party.id)).map((event) => event.type)).toContain('party.vies_checked')
    // The proof is kept as it was made: no login changes or removes it.
    await expect(admin('UPDATE "ViesCheck" SET result = $1 WHERE id = $2', ['INVALID', answer.check.id])).rejects.toThrow(/append-only/)
  })

  it('records an INVALID answer: no zero-rated sale', async () => {
    const party = await create('sales', EU_CUSTOMER('DE-NO', '100000008'))
    const answer = await check('sales', party.id)
    expect(answer.check).toMatchObject({ result: 'INVALID', consultationNumber: null })
    expect(answer.vies).toMatchObject({ state: 'INVALID', proofCheckId: null, message: expect.stringContaining('not valid') })
    expect(answer.party.warnings).toEqual([expect.objectContaining({ code: 'VIES_NOT_PROVEN' })])
  })

  it('records a check that got no answer as ERROR and holds the party: never a silent pass', async () => {
    const party = await create('sales', EU_CUSTOMER('DE-DOWN', '100000009'))
    const answer = await check('sales', party.id)
    expect(answer.check).toMatchObject({ result: 'ERROR', errorCode: 'MS_UNAVAILABLE', errorMeaning: expect.stringContaining('member state'), consultationNumber: null })
    expect(answer.vies).toMatchObject({ state: 'HELD', proofCheckId: null, message: expect.stringContaining('Held') })
    expect(answer.party.warnings).toEqual([expect.objectContaining({ code: 'VIES_NOT_PROVEN', message: answer.vies.message })])
    // The gateway tried an answer that may pass later three times, then recorded one failed call.
    const [ledger] = await admin('SELECT status, attempts FROM "IntegrationCall" WHERE "accountId" = $1 ORDER BY "startedAt" DESC LIMIT 1', [viesA])
    expect(ledger).toEqual({ status: 'FAILED', attempts: 3 })

    // The kill switch: nothing is sent, the check is still recorded as held.
    await admin(`UPDATE "IntegrationAccount" SET status = 'PAUSED' WHERE id = $1`, [viesA])
    try {
      const sent = fake.requests.length
      const paused = await check('sales', party.id)
      expect(paused.check).toMatchObject({ result: 'ERROR', errorCode: 'GATEWAY_ACCOUNT_PAUSED' })
      expect(paused.vies.state).toBe('HELD')
      expect(fake.requests.length).toBe(sent)
    } finally {
      await admin(`UPDATE "IntegrationAccount" SET status = 'ACTIVE' WHERE id = $1`, [viesA])
    }
    const history = (await call('viewer', 'GET', `/parties/${party.id}/vies-checks?limit=1`)).json()
    expect(history.checks).toHaveLength(1)
    expect(history.checks[0].errorCode).toBe('GATEWAY_ACCOUNT_PAUSED')
    const older = (await call('viewer', 'GET', `/parties/${party.id}/vies-checks?limit=1&cursor=${history.nextCursor}`)).json()
    expect(older.checks.map((entry: Json) => entry.errorCode)).toEqual(['MS_UNAVAILABLE'])
  })

  it('checks only an EU number outside Italy, asked by a company with a VAT number, by a person with parties.vies', async () => {
    const italian = await call('sales', 'POST', `/parties/${italianId}/vies-checks`, {})
    expect(italian.statusCode).toBe(409)
    expect(italian.json().error.message).toContain('an Italian Partita IVA')
    const party = (await call('sales', 'GET', '/parties?q=DE-OK')).json().parties[0]
    expect((await call('viewer', 'POST', `/parties/${party.id}/vies-checks`, {})).statusCode).toBe(403)
    // A company-limited checker asks for its own company only.
    expect((await call('companyOne', 'POST', `/parties/${party.id}/vies-checks`, { companyId: companyA2 })).statusCode).toBe(403)
    await admin('UPDATE "Company" SET "vatNumber" = NULL WHERE id = $1', [companyA2])
    try {
      const noVat = await call('sales', 'POST', `/parties/${party.id}/vies-checks`, { companyId: companyA2 })
      expect(noVat.statusCode).toBe(409)
      expect(noVat.json().error.message).toContain('has no VAT number')
    } finally {
      await admin('UPDATE "Company" SET "vatNumber" = $1 WHERE id = $2', [VAT.A2, companyA2])
    }
  })

  it('starts a corrected VAT number unchecked: an old proof never covers a new number', async () => {
    const party = (await call('sales', 'GET', '/parties?q=DE-OK')).json().parties[0]
    const record = await read('sales', party.id)
    const identity = record.taxIdentities[0]
    const corrected = await call('sales', 'PATCH', `/parties/${party.id}/tax-identities/${identity.id}`, { version: identity.version, vatNumber: 'DE100000010' })
    expect(corrected.statusCode, corrected.body).toBe(200)
    expect(corrected.json().party).toMatchObject({ vatNumber: 'DE100000010', vies: { state: 'UNCHECKED' } })
    expect((await call('sales', 'PATCH', `/parties/${party.id}/tax-identities/${identity.id}`, { version: identity.version, vatNumber: 'DE100000020' })).statusCode).toBe(409)
  })
})

describe('the tenant and company walls', () => {
  let ownId: string
  let otherCompanyId: string

  it("keeps another tenant's parties out of reach", async () => {
    const theirs = (await call('otherTenant', 'GET', '/parties')).json().parties
    expect(theirs.map((row: Json) => row.code)).toEqual(['CLI-001'])
    expect((await call('otherTenant', 'GET', `/parties/${italianId}`)).statusCode).toBe(404)
    expect((await call('otherTenant', 'PATCH', `/parties/${italianId}`, { version: 1, tradeName: 'X' })).statusCode).toBe(404)
    expect((await call('sales', 'GET', `/parties/${theirs[0].id}`)).statusCode).toBe(404)
  })

  it('keeps a company-limited person to its company: no tenant-wide party, no other company\'s party', async () => {
    const tenantWide = await call('companyOne', 'POST', '/parties', { code: 'C1-WIDE', legalName: 'Ovunque S.r.l.', roles: ['CUSTOMER'] })
    expect(tenantWide.statusCode).toBe(403)
    ownId = (await create('companyOne', { companyId: companyA1, code: 'C1-OWN', legalName: 'Cliente Uno S.r.l.', roles: ['CUSTOMER'] })).id
    otherCompanyId = (await create('sales', { companyId: companyA2, code: 'C2-OWN', legalName: 'Cliente Due S.r.l.', roles: ['CUSTOMER'] })).id
    expect((await call('companyOne', 'GET', `/parties/${otherCompanyId}`)).statusCode).toBe(404)
    const listed = (await call('companyOne', 'GET', '/parties?q=-OWN')).json().parties.map((row: Json) => row.code)
    expect(listed).toEqual(['C1-OWN'])
    // A tenant-wide party is seen, but changed only by a role over every company.
    const wide = await read('companyOne', italianId)
    expect((await call('companyOne', 'PATCH', `/parties/${italianId}`, { version: wide.version, tradeName: 'Y' })).statusCode).toBe(403)
    expect((await call('companyOne', 'POST', '/parties', { companyId: companyA2, code: 'C1-OTHER', legalName: 'Altro S.r.l.', roles: ['CUSTOMER'] })).statusCode).toBe(403)
  })

  it('keeps a person limited to some parties to those', async () => {
    limitedTo.push(ownId)
    try {
      expect((await call('oneCustomer', 'GET', '/parties?status=ALL')).json().parties.map((row: Json) => row.code)).toEqual(['C1-OWN'])
      expect((await call('oneCustomer', 'GET', `/parties/${otherCompanyId}`)).statusCode).toBe(404)
      expect((await call('oneCustomer', 'POST', '/parties', { companyId: companyA1, code: 'NEW-ONE', legalName: 'Nuovo S.r.l.', roles: ['CUSTOMER'] })).statusCode).toBe(403)
      const own = await read('oneCustomer', ownId)
      expect((await call('oneCustomer', 'PATCH', `/parties/${ownId}`, { version: own.version, paymentTerms: 'Rimessa diretta' })).statusCode).toBe(200)
    } finally {
      limitedTo.length = 0
    }
  })

  it('lists by role, status, country and VAT number, one page at a time', async () => {
    const customers = (await call('viewer', 'GET', '/parties?role=CUSTOMER,BRAND&country=DE')).json()
    expect(customers.parties.map((row: Json) => [row.code, row.vies.state])).toEqual([
      ['DE-DOWN', 'HELD'],
      ['DE-NO', 'INVALID'],
      ['DE-OK', 'UNCHECKED'],
    ])
    // One of the two racing creates won the number.
    expect((await call('viewer', 'GET', '/parties?role=SUPPLIER')).json().parties.filter((row: Json) => row.code.startsWith('RACE-'))).toHaveLength(1)
    // A VAT number as typed (prefix, spaces) finds its party.
    expect((await call('viewer', 'GET', `/parties?q=${encodeURIComponent(`it ${ITALIAN_VAT.slice(0, 5)} ${ITALIAN_VAT.slice(5)}`)}`)).json().parties.map((row: Json) => row.code)).toEqual(['CLI-001'])
    const first = (await call('viewer', 'GET', '/parties?limit=2')).json()
    expect(first.parties).toHaveLength(2)
    const second = (await call('viewer', 'GET', `/parties?limit=2&cursor=${first.nextCursor}`)).json()
    expect(second.parties[0].code > first.parties[1].code).toBe(true)
    expect(first.count).toBe(second.count)
    expect((await call('viewer', 'GET', '/parties?role=FRIEND')).statusCode).toBe(400)
  })
})

describe('the customers and suppliers import (SCM-289, PLT-176)', () => {
  const sha256 = (body: Buffer): string => createHash('sha256').update(body).digest('hex')
  const csv = (lines: string[]): Buffer => Buffer.from(lines.join('\r\n'), 'utf8')
  const HEADER = 'Codice;Ragione sociale;Ruoli;Paese;Partita IVA;Codice destinatario;PEC;Indirizzo;CAP;Città;Provincia;Referente;Email'
  const NEW_VAT = partitaIva('1000000555')

  const start = (session: string, body: Buffer, fields: Json = {}) =>
    call(session, 'POST', '/imports', {
      importerKey: 'parties.parties',
      file: { originalName: 'clienti.csv', contentType: SHEET_TYPES.csv, sizeBytes: body.length, sha256: sha256(body) },
      ...fields,
    })
  async function upload(session: string, body: Buffer, fields: Json = {}): Promise<Json> {
    const started = await start(session, body, fields)
    expect(started.statusCode, started.body).toBe(201)
    const { job, upload: presigned } = started.json() as { job: Json; upload: { url: string; headers: Record<string, string> } }
    expect((await app.inject({ method: 'PUT', url: presigned.url, headers: presigned.headers, payload: body })).statusCode).toBe(200)
    expect((await call(session, 'POST', `/files/${job.fileId}/complete`)).statusCode).toBe(200)
    await planImport(system(), job.id, { lastAttempt: true })
    return (await call(session, 'GET', `/imports/${job.id}`)).json().job
  }
  const rowsOf = async (jobId: string): Promise<Json[]> => (await call('sales', 'GET', `/imports/${jobId}/rows`)).json().rows
  const byCode = async (code: string): Promise<Json | undefined> => (await call('sales', 'GET', `/parties?q=${code}&status=ALL`)).json().parties.find((row: Json) => row.code === code)

  it('plans every row without writing a party, then applies exactly the plan', async () => {
    const sheet = csv([
      HEADER,
      `imp-1;Importato Esempio S.r.l.;cliente;IT;${NEW_VAT};ABC9999;;Via Importata 1;20121;Milano;MI;Elena Esempio;elena@example.com`,
      'CLI-001;;cliente, fornitore;;;;fatture@pec.example.it;;;;;Franco Esempio;franco@example.com',
      `IMP-BAD;Sbagliato S.r.l.;cliente;IT;${NEW_VAT.slice(0, 10)}${(Number(NEW_VAT[10]) + 1) % 10};;;;;;;;`,
    ])
    const before = await admin('SELECT code, version FROM "Party" WHERE "tenantId" = $1 ORDER BY code', [tenantA])
    const job = await upload('sales', sheet)
    const rows = await rowsOf(job.id)
    expect(rows.map((row) => [row.rowNumber, row.action, row.errors])).toEqual([[2, 'CREATE', null], [3, 'UPDATE', null], [4, 'ERROR', expect.any(Array)]])
    expect(job).toMatchObject({ status: 'PLANNED', rowCount: 3, createCount: 1, updateCount: 1, errorCount: 1 })
    expect(await admin('SELECT code, version FROM "Party" WHERE "tenantId" = $1 ORDER BY code', [tenantA])).toEqual(before)
    expect(rows[1]).toMatchObject({
      before: { roles: 'CUSTOMER', pec: null, contactName: null, contactEmail: null },
      after: { roles: 'CUSTOMER; SUPPLIER', pec: 'fatture@pec.example.it', contactName: 'Franco Esempio', contactEmail: 'franco@example.com' },
    })
    expect(rows[2]!.errors).toEqual([{ column: 'vatNumber', message: expect.stringContaining('check digit') }])

    expect((await call('sales', 'POST', `/imports/${job.id}/apply`, { version: job.version })).statusCode).toBe(200)
    await applyPlan(system(), job.id, { lastAttempt: true })
    expect((await call('sales', 'GET', `/imports/${job.id}`)).json().job).toMatchObject({ status: 'APPLIED', appliedCount: 2, skippedCount: 0 })

    const created = await read('sales', (await byCode('IMP-1'))!.id)
    expect(created).toMatchObject({ companyId: null, roles: ['CUSTOMER'], taxMode: 'IT_B2B', vatNumber: `IT${NEW_VAT}`, city: 'Milano', createdById: null, warnings: [] })
    expect(created.addresses[0]).toMatchObject({ kinds: ['REGISTERED', 'BILL_TO', 'SHIP_TO'], isDefaultBillTo: true, isDefaultShipTo: true })
    expect(created.contacts).toEqual([expect.objectContaining({ email: 'elena@example.com', roles: ['ORDERS'] })])
    const updated = await read('sales', italianId)
    expect(updated.roles).toEqual(['CUSTOMER', 'SUPPLIER'])
    expect(updated.contacts.map((contact: Json) => contact.email)).toContain('franco@example.com')
    // A changed PEC is a new identity from the import's day; the older one stays as it was.
    expect(updated.taxIdentities.find((identity: Json) => identity.current)).toMatchObject({ pec: 'fatture@pec.example.it', sdiRecipientCode: 'ABC1234' })
    expect(await admin(`SELECT action FROM "AuditLog" WHERE "recordId" = $1 AND action = 'parties.import'`, [created.id])).toHaveLength(1)
  })

  it('stops the batch on a VAT number another party holds, naming it', async () => {
    const job = await upload('sales', csv([HEADER, `IMP-DUP;Doppione S.r.l.;cliente;IT;${ITALIAN_VAT};;;;;;;;`]))
    expect(job).toMatchObject({ status: 'PLANNED', createCount: 1 })
    expect((await call('sales', 'POST', `/imports/${job.id}/apply`, { version: job.version })).statusCode).toBe(200)
    await expect(applyPlan(system(), job.id, { lastAttempt: true })).rejects.toThrow(/belongs to party CLI-001/)
    const failed = (await call('sales', 'GET', `/imports/${job.id}`)).json().job
    expect(failed.status).toBe('FAILED')
    expect(JSON.stringify(failed)).toContain('CLI-001')
    expect(await byCode('IMP-DUP')).toBeUndefined()
  })

  it('lets a company-limited person import for that company only, and nobody limited to some parties', async () => {
    const sheet = csv([HEADER, 'IMP-C1;Uno Importato S.r.l.;fornitore;IT;;;;;;;;;'])
    const everyCompany = await start('companyOne', sheet)
    expect(everyCompany.statusCode).toBe(403)
    expect(everyCompany.json().error.issues).toEqual([{ path: 'companyId', message: 'A parties import for every company needs parties.manage over every company; import for one company instead.' }])
    limitedTo.push(italianId)
    try {
      const limited = await start('oneCustomer', sheet, { companyId: companyA1 })
      expect(limited.statusCode).toBe(403)
    } finally {
      limitedTo.length = 0
    }
    const own = await upload('companyOne', sheet, { companyId: companyA1 })
    expect(own).toMatchObject({ status: 'PLANNED', createCount: 1 })
    expect((await call('companyOne', 'POST', `/imports/${own.id}/apply`, { version: own.version })).statusCode).toBe(200)
    await applyPlan(system(), own.id, { lastAttempt: true })
    expect(await admin('SELECT code, "companyId" FROM "Party" WHERE code = $1', ['IMP-C1'])).toEqual([{ code: 'IMP-C1', companyId: companyA1 }])
  })
})
