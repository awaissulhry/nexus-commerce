import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { buildApp } from '../../core/app'
import { callerFor } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { processImporters, type CheckRow } from '../imports/registry'

/**
 * B-TH-056 (threads plan TH-4, WALL-G08 / SHEET-G06; surface W17, wall T17): a custom field for ONE customer, through the app's
 * real routes on a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_config_brand_fields_th_guards are real), tenant A from EVERY seed. Customer A and customer B are two seeded customers with
 * orders; all words are made up.
 *   - made for one customer only on customers, quotes and orders, for an active customer, by who reaches it (refusals in words);
 *     the editor names its customer and warns for a field every customer sees in its portal;
 *   - it is on customer B's orders only: B's form, B's sheet, B's portal; never on A's (refused as unknown when written there,
 *     also by the import);
 *   - T17: customer A's portal answer holds nothing of customer B's field, and of a list only the values A's order uses;
 *   - an office person limited to customer A never sees customer B's field, not even its name.
 * Run with `node scripts/factory/run-pg-tests.mjs brand-fields`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'brand-fields-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `brand-fields-${Date.now()}-${++serial}`

const A = { tenant: seedUuid(NS, 'tenant'), companyA: seedUuid(NS, 'company:A') }
const grant = (permissions: readonly string[], scope: Partial<Grant> = {}): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const ORDERS = ['orders.view', 'orders.manage']
const SESSIONS: Record<string, SessionContext> = {
  keeper: office([grant(['fields.view', 'fields.manage', ...ORDERS, 'parties.view', 'parties.manage', 'money.price'])]),
}

const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': idem() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}

/** Customer A's order and customer B's order (two active customers of the seed). */
let orderA: { id: string; partyId: string; number: string }
let orderB: { id: string; partyId: string; number: string }
let betaField: Json
let sharedField: Json

beforeAll(async () => {
  db = await migratedDatabase('brand_fields')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  const customers = `SELECT o.id, o."partyId", o.number FROM "SalesOrder" o JOIN "Party" p ON p."tenantId" = o."tenantId" AND p.id = o."partyId"
                     WHERE o."tenantId" = $1 AND p.status = 'ACTIVE' AND 'CUSTOMER' = ANY (p.roles::text[])`
  orderA = (await admin<typeof orderA>(`${customers} AND o.number = 'SEED-SO-0004'`, [A.tenant]))[0]!
  orderB = (await admin<typeof orderB>(`${customers} AND o."partyId" <> $2 ORDER BY o.number LIMIT 1`, [A.tenant, orderA.partyId]))[0]!
  const partner = (partyId: string): SessionContext => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId, grants: [grant(['portal.salesOrders.view'], { parties: [partyId] })] })
  SESSIONS.partnerA = partner(orderA.partyId)
  SESSIONS.partnerB = partner(orderB.partyId)
  // Sells for customer A only (a sales rep's accounts), and keeps fields for customer A only.
  SESSIONS.sellerA = office([grant([...ORDERS, 'parties.view'], { parties: [orderA.partyId] })])
  SESSIONS.keeperA = office([grant(['fields.view', 'fields.manage', ...ORDERS], { parties: [orderA.partyId] })])
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('a field for one customer is made', () => {
  it('for an active customer, on customers, quotes and orders, by who reaches it; the editor names its customer and warns for every customer’s portal column', async () => {
    expect(orderA.partyId).not.toBe(orderB.partyId)
    const list = (await ok('keeper', 'POST', '/fields/picklists', { code: 'finish_label', labelIt: 'Etichetta finitura', labelEn: 'Finish label' }, 201)).picklist
    await ok('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'STANDARD', labelIt: 'Standard', labelEn: 'Standard' }, 201)
    await ok('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'BETA_SPECIAL', labelIt: 'Speciale Beta (inventata)', labelEn: 'Beta special (made up)' }, 201)
    betaField = (
      await ok('keeper', 'POST', '/fields', { recordType: 'ORDER', partyId: orderB.partyId, code: 'beta_lining_code', type: 'TEXT', labelIt: 'Codice fodera Beta (inventato)', labelEn: 'Beta lining code (made up)', shownInPortal: true }, 201)
    ).field
    expect(betaField).toMatchObject({ partyId: orderB.partyId, shownInPortal: true })
    sharedField = (await ok('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'finish_label', type: 'SELECT', labelIt: 'Etichetta finitura', labelEn: 'Finish label', picklistId: list.id, shownInPortal: true }, 201)).field
    expect(sharedField.partyId).toBeNull()

    const editor = (await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')).fields as Json[]
    expect(editor.find((field) => field.code === 'beta_lining_code')).toMatchObject({ partyId: orderB.partyId, partyName: expect.any(String), portalNotice: null })
    expect(editor.find((field) => field.code === 'finish_label')).toMatchObject({ partyId: null, partyName: null, portalNotice: 'EVERY_CUSTOMER' })
    // A keeper limited to customer A neither sees nor keeps customer B's field.
    const limited = (await ok('keeperA', 'GET', '/fields/editor?recordType=ORDER')).fields as Json[]
    expect(limited.map((field) => field.code)).not.toContain('beta_lining_code')
    expect(JSON.stringify(limited)).not.toContain('Beta lining code')
    await refused('keeperA', 'PATCH', `/fields/${betaField.id}`, { version: betaField.version, labelEn: 'Renamed' }, 404)
    await refused('keeperA', 'POST', '/fields', { recordType: 'ORDER', partyId: orderB.partyId, code: 'beta_other', type: 'TEXT', labelIt: 'a', labelEn: 'b' }, 403)

    // Refusals in words.
    expect((await refused('keeper', 'POST', '/fields', { recordType: 'STYLE', partyId: orderB.partyId, code: 'beta_style', type: 'TEXT', labelIt: 'a', labelEn: 'b' }, 400)).issues[0].path).toBe('body/partyId')
    const supplier = (await admin<{ id: string }>(`SELECT id FROM "Party" WHERE "tenantId" = $1 AND NOT ('CUSTOMER' = ANY (roles::text[])) LIMIT 1`, [A.tenant]))[0]!
    const notCustomer = await refused('keeper', 'POST', '/fields', { recordType: 'ORDER', partyId: supplier.id, code: 'supplier_only', type: 'TEXT', labelIt: 'a', labelEn: 'b' }, 409)
    expect(notCustomer.issues[0]).toEqual({ path: 'body/partyId', message: 'Pick one of our customers.' })
  })
})

describe('it is on that customer’s records only', () => {
  it('written on B’s order; refused as unknown on A’s (the form, the import); B’s form and sheet show it, A’s never', async () => {
    const written = await ok('keeper', 'PUT', `/fields/values/ORDER/${orderB.id}`, { values: [{ code: 'beta_lining_code', value: 'BL-77', version: null }, { code: 'finish_label', value: 'BETA_SPECIAL', version: null }] })
    expect(written.set).toEqual(['beta_lining_code', 'finish_label'])
    await ok('keeper', 'PUT', `/fields/values/ORDER/${orderA.id}`, { values: [{ code: 'finish_label', value: 'STANDARD', version: null }] })
    const onA = await refused('keeper', 'PUT', `/fields/values/ORDER/${orderA.id}`, { values: [{ code: 'beta_lining_code', value: 'X', version: null }] }, 400)
    expect(onA.issues[0]).toEqual({ path: 'body/values/0/code', message: 'No custom field beta_lining_code on this order.' })

    const formA = await ok('keeper', 'GET', `/fields/values/ORDER/${orderA.id}`)
    expect(formA.fields.map((field: Json) => field.code)).not.toContain('beta_lining_code')
    const formB = await ok('keeper', 'GET', `/fields/values/ORDER/${orderB.id}`)
    expect(formB.values.find((value: Json) => value.code === 'beta_lining_code').value).toBe('BL-77')

    // One customer's sheet: the fields for every customer and its own; across customers, B's column on B's rows only.
    expect((await ok('keeper', 'GET', `/fields?recordType=ORDER&partyId=${orderA.partyId}`)).fields.map((field: Json) => field.code)).not.toContain('beta_lining_code')
    expect((await ok('keeper', 'GET', `/fields?recordType=ORDER&partyId=${orderB.partyId}`)).fields.map((field: Json) => field.code)).toContain('beta_lining_code')
    const rows = (await ok('keeper', 'POST', '/fields/rows/ORDER', { ids: [orderA.id, orderB.id] })).rows as Json[]
    expect(Object.keys(rows.find((row) => row.id === orderA.id)!.values)).not.toContain('beta_lining_code')
    expect(rows.find((row) => row.id === orderB.id)!.values.beta_lining_code.value).toBe('BL-77')

    // The import: a row of customer B's field on customer A's order is refused in words.
    const adapter = processImporters().get('fields.orders')!
    const context: RequestContext = { ...(SESSIONS.keeper as Extract<SessionContext, { audience: 'office' }>), requestId: newId() }
    const check: CheckRow[] = [{ rowNumber: 2, key: { record: orderA.number, field: 'beta_lining_code' }, values: { value: 'X' } }]
    const issues = await callerFor(database, context).withClient((client) => adapter.check!(client, check, { companyId: A.companyA }, { audience: 'office', tenantId: A.tenant, grants: SESSIONS.keeper!.grants }))
    expect(issues[0]).toEqual([{ column: 'field', message: 'No custom field beta_lining_code on this order.' }])
  })

  it('a sales rep limited to customer A never sees customer B’s field, not even its name', async () => {
    const fields = await ok('sellerA', 'GET', '/fields?recordType=ORDER')
    expect(fields.fields.map((field: Json) => field.code)).not.toContain('beta_lining_code')
    expect(JSON.stringify(fields)).not.toMatch(/Beta lining code|Codice fodera Beta/)
    await refused('sellerA', 'GET', `/fields/values/ORDER/${orderB.id}`, undefined, 404)
  })
})

describe('T17 the portal', () => {
  it('customer A’s portal answer holds nothing of customer B’s field, and of a list only the values A’s order uses', async () => {
    const answerA = await ok('partnerA', 'GET', `/fields/portal/ORDER/${orderA.id}`)
    expect(answerA.fields.map((field: Json) => field.code)).toEqual(['finish_label'])
    expect(answerA.fields[0].picklist.values.map((value: Json) => value.code)).toEqual(['STANDARD'])
    expect(answerA.values.map((value: Json) => [value.code, value.value])).toEqual([['finish_label', 'STANDARD']])
    const text = JSON.stringify(answerA)
    for (const word of ['beta_lining_code', 'Beta lining code', 'Codice fodera Beta', 'BETA_SPECIAL', 'Beta special', 'BL-77', orderB.partyId]) expect(text).not.toContain(word)
    // Customer B's own portal: its field and its list value.
    const answerB = await ok('partnerB', 'GET', `/fields/portal/ORDER/${orderB.id}`)
    expect(answerB.fields.map((field: Json) => field.code).sort()).toEqual(['beta_lining_code', 'finish_label'])
    expect(answerB.fields.find((field: Json) => field.code === 'finish_label').picklist.values.map((value: Json) => value.code)).toEqual(['BETA_SPECIAL'])
    // Never another customer's order.
    await refused('partnerA', 'GET', `/fields/portal/ORDER/${orderB.id}`, undefined, 404)
  })
})
