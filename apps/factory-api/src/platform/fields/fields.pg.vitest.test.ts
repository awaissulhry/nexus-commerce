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
import { callerFor, command } from '../../core/command'
import { testAuthenticator, type RequestContext, type SessionContext } from '../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../env'
import { seedUuid } from '../../../../../packages/factory-db/src/seeding'
import { exportSourceOf } from '../exports/registry'
import { processImporters } from '../imports/registry'

/**
 * Custom fields and picklists (B-W2b-421; PLT-111, PLT-115) through the app's real routes on a throwaway PostgreSQL 17
 * database from the migrations (the runtime login: row-level security and the …_config_templates_w2b_guards are real),
 * tenant A from EVERY seed (B-W2b-379's fields, lists and values among them). Made-up words only.
 *   - the editor: record types, a type's fields with how many records have a value, every list;
 *   - fields added without code: a select on its list, a money field with its grain; refusals in words (a taken code,
 *     money without a grain, a cost in the portal, a field of every company kept by a company's keeper);
 *   - archive and restore, the order of a section, the version read;
 *   - picklists: a value at the end, colours from the swatches, deactivated (kept where a record has it), reordered,
 *     a list in use never archived;
 *   - a record's values: money only with its grain, personal data only with fields.personal.view, written with the
 *     record's own edit permission at each value's version, audited with money marked, one event;
 *   - a grid page, the portal (a partner sees only the fields shown in it, a price only with the price grain);
 *   - the export of a list carries the custom columns (a money one left out without its grain) and the `cf` filter;
 *   - the import of custom values: one row per record and field, through the importer's load, check and write.
 * Run with `node scripts/factory/run-pg-tests.mjs platform/fields`.
 */

type Json = Record<string, any>
const SEED_DIR = fileURLToPath(new URL('../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'fields-a'
let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance
let serial = 0
const idem = () => `fields-${Date.now()}-${++serial}`

const A = { tenant: seedUuid(NS, 'tenant'), companyA: seedUuid(NS, 'company:A'), companyB: seedUuid(NS, 'company:B') }
const grant = (permissions: readonly string[], scope: Partial<Grant> = {}): Grant => ({ permissions: permissions as Permission[], companies: 'all', sites: 'all', parties: 'all', ...scope })
const office = (grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId: newId(), grants })
const ORDERS = ['orders.view', 'orders.manage']
const SESSIONS: Record<string, SessionContext> = {
  keeper: office([grant(['fields.view', 'fields.manage', 'fields.personal.view', ...ORDERS, 'product.styles.view', 'parties.view', 'parties.manage', 'money.price'])]),
  // Keeps company A's fields only: a field of every company is the whole group's.
  companyKeeper: office([grant(['fields.view', 'fields.manage'], { companies: [A.companyA] })]),
  // Sells: sees prices, no personal data.
  seller: office([grant([...ORDERS, 'parties.view', 'money.price'])]),
  // Reads orders, no price.
  reader: office([grant(['orders.view'])]),
  nobody: office([grant(['sites.view'])]),
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
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

let order: { id: string; partyId: string }
let partnerSession: string

beforeAll(async () => {
  db = await migratedDatabase('platform_fields')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 6 } })
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: database, namespace: NS })
  }
  order = (await admin<{ id: string; partyId: string }>(`SELECT id, "partyId" FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0004'`, [A.tenant]))[0]!
  SESSIONS.partner = { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: order.partyId, grants: [grant(['portal.salesOrders.view'], { parties: [order.partyId] })] }
  SESSIONS.partnerPrices = { audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: order.partyId, grants: [grant(['portal.salesOrders.view', 'money.price'], { parties: [order.partyId] })] }
  partnerSession = 'partnerPrices'
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 240_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
})

describe('the editor (PLT-111, PLT-115)', () => {
  it('reads the record types, a type\'s fields with their counts, and every list', async () => {
    const view = await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')
    expect(view.records.map((record: Json) => record.key)).toEqual(['CUSTOMER', 'QUOTE', 'ORDER', 'STYLE', 'MATERIAL', 'SUPPLIER', 'PURCHASE_ORDER', 'LOT', 'WORK_ORDER'])
    expect(view.records.find((record: Json) => record.key === 'CUSTOMER').sharedWith).toEqual(['SUPPLIER'])
    expect(view.records.find((record: Json) => record.key === 'STYLE').fieldCount).toBe(4)
    expect(view.fields.map((field: Json) => field.code).sort()).toEqual(['fair_date', 'finish_grade', 'rush_packaging', 'target_retail_price'])
    const retail = view.fields.find((field: Json) => field.code === 'target_retail_price')
    expect(retail).toMatchObject({ type: 'MONEY', audience: 'MONEY', grain: 'price', columnId: 'cf:price:target_retail_price', valueCount: 1, shownInPortal: true })
    expect(view.picklists.find((list: Json) => list.code === 'lining_type')).toMatchObject({ fieldCount: 1, status: 'ACTIVE' })
    expect(view.canManage).toBe(true)
    await refused('seller', 'GET', '/fields/editor', undefined, 403)
  })
})

describe('fields added without code (PLT-111)', () => {
  it('adds a select field on a list and a money field with its grain; refusals in words', async () => {
    const lists = (await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')).picklists as Json[]
    const lining = lists.find((list) => list.code === 'lining_type')!
    const select = (await ok('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'lining_wanted', type: 'MULTI_SELECT', labelIt: 'Fodere richieste', labelEn: 'Linings wanted', picklistId: lining.id }, 201)).field
    expect(select).toMatchObject({ code: 'lining_wanted', columnId: 'cf:lining_wanted', section: 'custom', audience: 'INTERNAL', picklist: { code: 'lining_type' } })
    const money = (await ok('keeper', 'POST', '/fields', { recordType: 'ORDER', companyId: A.companyA, code: 'agreed_discount', type: 'MONEY', labelIt: 'Sconto concordato', labelEn: 'Agreed discount', grain: 'price', section: 'terms' }, 201)).field
    expect(money).toMatchObject({ audience: 'MONEY', grain: 'price', columnId: 'cf:price:agreed_discount', sortOrder: 10 })
    expect((await refused('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'lining_wanted', type: 'TEXT', labelIt: 'a', labelEn: 'b' }, 409)).issues[0].path).toBe('body/code')
    expect((await refused('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'no_grain', type: 'MONEY', labelIt: 'a', labelEn: 'b' }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/grain'])
    expect((await refused('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'unit_cost', type: 'MONEY', labelIt: 'a', labelEn: 'b', grain: 'cost', shownInPortal: true }, 400)).issues.map((issue: Json) => issue.path)).toEqual(['body/shownInPortal'])
    await refused('companyKeeper', 'POST', '/fields', { recordType: 'ORDER', code: 'group_wide', type: 'TEXT', labelIt: 'a', labelEn: 'b' }, 403)
    await refused('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'cost_note', type: 'NUMBER', labelIt: 'a', labelEn: 'b', audience: 'MONEY', grain: 'cost' }, 403)
    const made = await events('custom_field.changed')
    expect(made.filter((event) => event.change === 'CREATED').map((event) => event.codes[0])).toEqual(['lining_wanted', 'agreed_discount'])
  })

  it('archives and restores a field at the version read, and orders a section', async () => {
    const fields = (await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')).fields as Json[]
    const rush = fields.find((field) => field.code === 'rush_packaging')!
    const archived = (await ok('keeper', 'PATCH', `/fields/${rush.id}`, { version: rush.version, status: 'ARCHIVED' })).field
    expect(archived.status).toBe('ARCHIVED')
    expect((await refused('keeper', 'PATCH', `/fields/${rush.id}`, { version: rush.version, labelEn: 'Rush' }, 409)).code).toBe('conflict')
    expect((await ok('keeper', 'GET', '/fields?recordType=ORDER')).fields.map((field: Json) => field.code)).not.toContain('rush_packaging')
    const restored = (await ok('keeper', 'PATCH', `/fields/${rush.id}`, { version: archived.version, status: 'ACTIVE', labelEn: 'Rush packaging (made up)' })).field
    expect(restored).toMatchObject({ status: 'ACTIVE', labelEn: 'Rush packaging (made up)' })
    const section = ((await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')).fields as Json[]).filter((field) => field.section === 'custom' && field.status === 'ACTIVE')
    const reversed = [...section].reverse()
    const ordered = (await ok('keeper', 'POST', '/fields/order', { recordType: 'ORDER', section: 'custom', fields: reversed.map((field) => ({ id: field.id, version: field.version })) })).fields as Json[]
    expect(ordered.map((field) => field.code)).toEqual(reversed.map((field) => field.code))
    expect((await refused('keeper', 'POST', '/fields/order', { recordType: 'ORDER', section: 'custom', fields: [{ id: reversed[0].id, version: 1 }] }, 400)).issues.length).toBeGreaterThan(0)
    expect((await events('custom_field.changed')).map((event) => event.change)).toEqual(expect.arrayContaining(['ARCHIVED', 'RESTORED', 'REORDERED']))
  })
})

describe('picklists (PLT-115)', () => {
  it('adds, colours, deactivates and orders values; a list in use is never archived', async () => {
    const list = (await ok('keeper', 'POST', '/fields/picklists', { code: 'packaging', labelIt: 'Imballo', labelEn: 'Packaging' }, 201)).picklist
    let view = (await ok('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'BOX', labelIt: 'Scatola', labelEn: 'Box', colour: '#1F6FDE', icon: 'box' }, 201)).picklist
    view = (await ok('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'BAG', labelIt: 'Sacchetto', labelEn: 'Bag', description: 'Made up.' }, 201)).picklist
    expect(view.values.map((value: Json) => [value.code, value.sortOrder, value.colour])).toEqual([['BOX', 10, '#1f6fde'], ['BAG', 20, null]])
    expect((await refused('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'BAG', labelIt: 'x', labelEn: 'y' }, 409)).issues[0].path).toBe('body/code')
    expect((await refused('keeper', 'POST', `/fields/picklists/${list.id}/values`, { code: 'CRATE', labelIt: 'x', labelEn: 'y', colour: '#123456' }, 400)).issues[0].path).toBe('body/colour')
    const bag = view.values.find((value: Json) => value.code === 'BAG')
    view = (await ok('keeper', 'PATCH', `/fields/picklists/${list.id}/values/${bag.id}`, { version: bag.version, active: false })).picklist
    expect(view.values.find((value: Json) => value.code === 'BAG').active).toBe(false)
    const reordered = (await ok('keeper', 'POST', `/fields/picklists/${list.id}/order`, { values: [...view.values].reverse().map((value: Json) => ({ id: value.id, version: value.version })) })).picklist
    expect(reordered.values.map((value: Json) => value.code)).toEqual(['BAG', 'BOX'])
    await ok('keeper', 'POST', '/fields', { recordType: 'ORDER', code: 'packaging', type: 'SELECT', labelIt: 'Imballo', labelEn: 'Packaging', picklistId: list.id }, 201)
    const fresh = (await ok('keeper', 'GET', '/fields/editor?recordType=ORDER')).picklists.find((entry: Json) => entry.code === 'packaging')
    expect((await refused('keeper', 'PATCH', `/fields/picklists/${list.id}`, { version: fresh.version, status: 'ARCHIVED' }, 409)).issues[0].path).toBe('body/status')
    expect((await events('picklist.changed')).filter((event) => event.code === 'packaging').map((event) => event.change)).toEqual(['CREATED', 'VALUES_ADDED', 'VALUES_ADDED', 'VALUES_DEACTIVATED', 'VALUES_REORDERED'])
  })
})

describe("a record's values", () => {
  it('shows money only with its grain and personal data only with the right', async () => {
    const seller = await ok('seller', 'GET', `/fields/values/ORDER/${order.id}`)
    expect(seller.values.find((value: Json) => value.code === 'target_retail_price').value).toEqual({ amount: 89900, currency: 'EUR' })
    expect(seller.values.find((value: Json) => value.code === 'finish_grade')).toMatchObject({ value: 'A_GRADE', wordsEn: 'First grade', wordsIt: 'Prima scelta' })
    expect(seller.canEdit).toBe(true)
    const reader = await ok('reader', 'GET', `/fields/values/ORDER/${order.id}`)
    expect(reader.fields.map((field: Json) => field.code)).not.toContain('target_retail_price')
    expect(reader.values.map((value: Json) => value.code)).not.toContain('target_retail_price')
    expect(reader.canEdit).toBe(false)
    await refused('nobody', 'GET', `/fields/values/ORDER/${order.id}`, undefined, 403)
    await refused('seller', 'GET', `/fields/values/ORDER/${newId()}`, undefined, 404)
    const party = (await admin<{ id: string }>(`SELECT "recordId" AS id FROM "CustomFieldValue" WHERE "tenantId" = $1 AND "recordType" = 'Party' LIMIT 1`, [A.tenant]))[0]
    const customer = await ok('keeper', 'POST', '/fields/rows/CUSTOMER', { ids: [order.partyId, ...(party ? [party.id] : [])] })
    expect(customer.fields.map((field: Json) => field.code)).toContain('rider_nickname')
    expect((await ok('seller', 'POST', '/fields/rows/CUSTOMER', { ids: [order.partyId] })).fields.map((field: Json) => field.code)).not.toContain('rider_nickname')
  })

  it("writes values with the record's own edit permission, at each value's version, audited and in one event", async () => {
    const before = await ok('seller', 'GET', `/fields/values/ORDER/${order.id}`)
    const fair = before.values.find((value: Json) => value.code === 'fair_date')
    const written = await ok('seller', 'PUT', `/fields/values/ORDER/${order.id}`, {
      values: [
        { code: 'fair_date', value: '2027-02-12', version: fair.version },
        { code: 'lining_wanted', value: ['THERMAL', 'MESH'], version: null },
        { code: 'agreed_discount', value: { amount: 5000, currency: 'EUR' }, version: null },
      ],
    })
    expect(written.set).toEqual(['fair_date', 'lining_wanted', 'agreed_discount'])
    expect(written.values.find((value: Json) => value.code === 'lining_wanted')).toMatchObject({ value: ['MESH', 'THERMAL'], wordsEn: 'Breathable mesh, Thermal' })
    // The same version again: changed meanwhile.
    expect((await refused('seller', 'PUT', `/fields/values/ORDER/${order.id}`, { values: [{ code: 'fair_date', value: '2027-03-01', version: fair.version }] }, 409)).issues[0].path).toBe('body/values/0/version')
    // A deactivated list value: refused as a new pick.
    const quilted = await refused('seller', 'PUT', `/fields/values/ORDER/${order.id}`, { values: [{ code: 'lining_wanted', value: ['QUILTED'], version: 1 }] }, 400)
    expect(quilted.issues[0].message).toContain('no longer offered')
    // A field the person does not see is refused as unknown; the reader may not write at all.
    expect((await refused('reader', 'PUT', `/fields/values/ORDER/${order.id}`, { values: [{ code: 'fair_date', value: '2027-03-01', version: 2 }] }, 403)).code).toBe('forbidden')
    const audit = await admin<{ action: string; after: Json }>(`SELECT action, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordId" = $2 AND action LIKE 'fields.%' ORDER BY at, id`, [A.tenant, order.id])
    const discount = audit.find((row) => row.after?.field === 'agreed_discount')!
    expect(discount.after.value).toEqual({ $money: 'price', value: { amount: { $money: 'price', value: 5000 }, currency: 'EUR' } })
    expect((await events('custom_value.changed')).at(-1)).toEqual({ recordType: 'SalesOrder', recordId: order.id, set: ['fair_date', 'lining_wanted', 'agreed_discount'], cleared: [] })
    const cleared = await ok('seller', 'PUT', `/fields/values/ORDER/${order.id}`, { values: [{ code: 'agreed_discount', value: null, version: 1 }] })
    expect(cleared.cleared).toEqual(['agreed_discount'])
  })

  it('lets a partner read only the fields shown in the portal on its own record', async () => {
    const withPrices = await ok(partnerSession, 'GET', `/fields/portal/ORDER/${order.id}`)
    expect(withPrices.fields.map((field: Json) => field.code)).toEqual(['target_retail_price'])
    expect(withPrices.values[0].value).toEqual({ amount: 89900, currency: 'EUR' })
    expect((await ok('partner', 'GET', `/fields/portal/ORDER/${order.id}`)).fields).toEqual([])
    const other = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" <> $2 LIMIT 1`, [A.tenant, order.partyId]))[0]
    if (other) await refused(partnerSession, 'GET', `/fields/portal/ORDER/${other.id}`, undefined, 404)
    await refused(partnerSession, 'GET', `/fields/portal/STYLE/${newId()}`, undefined, 404)
  })
})

describe('exports and imports carry them', () => {
  const context = (session: string): RequestContext => ({ ...(SESSIONS[session] as Extract<SessionContext, { audience: 'office' }>), requestId: newId() })

  it('writes the custom columns of a list, a money one only with its grain, and applies the cf filter', async () => {
    const source = exportSourceOf('sales.orders')!
    expect(Object.hasOwn(source.columns, 'cf:fair_date')).toBe(true)
    expect(source.columns['cf:price:target_retail_price']!.grain).toBe('price')
    const read = async (session: string, address: string) => {
      const query = source.query(new URLSearchParams(address))
      const page = await source.read(callerFor(database, context(session)), query, null, 100, { locale: 'en' })
      return page.rows.map((row) => ({ id: source.idOf!(row), fair: source.columns['cf:fair_date']!.value(row, (code) => code), retail: source.columns['cf:price:target_retail_price']!.value(row, (code) => code), number: source.columns.number!.value(row, (code) => code) }))
    }
    const all = await read('seller', 'rows=all')
    expect(all.find((row) => row.id === order.id)).toMatchObject({ fair: { day: '2027-02-12' }, retail: { minor: 89900, currency: 'EUR' }, number: 'SEED-SO-0004' })
    const filtered = await read('seller', 'rows=all&cf=fair_date>=2027-02-01')
    expect(filtered.map((row) => row.id)).toEqual([order.id])
    expect((await read('reader', 'rows=all')).find((row) => row.id === order.id)!.retail).toBeNull()
    await expect(read('seller', 'rows=all&cf=nope:1')).rejects.toThrow(/custom field filter/)
  })

  it('imports custom values one row per record and field through the importer', async () => {
    const adapter = processImporters().get('fields.orders')!
    expect(adapter.permission).toBe('orders.manage')
    const caller = callerFor(database, context('keeper'))
    const actor = { audience: 'office' as const, tenantId: A.tenant, grants: SESSIONS.keeper!.grants }
    const scope = { companyId: A.companyA }
    const rows = [
      { rowNumber: 2, key: { record: 'SEED-SO-0004', field: 'finish_grade' }, values: { value: 'Seconda scelta' } },
      { rowNumber: 3, key: { record: 'SEED-SO-0004', field: 'agreed_discount' }, values: { priceValue: '12.50', currency: 'EUR' } },
      { rowNumber: 4, key: { record: 'SEED-SO-0004', field: 'fair_date' }, values: { number: '3' } },
      { rowNumber: 5, key: { record: 'NOPE-1', field: 'finish_grade' }, values: { value: 'A_GRADE' } },
      { rowNumber: 6, key: { record: 'SEED-SO-0004', field: 'secret' }, values: { value: 'x' } },
    ]
    const issues = await caller.withClient((client) => adapter.check!(client, rows, scope, actor))
    expect(issues.map((list) => list.map((issue) => issue.column))).toEqual([[], [], ['number'], ['record'], ['field']])
    const existing = await caller.withClient((client) => adapter.load(client, rows.map((row) => row.key), scope))
    expect(existing.find((record) => record.values.field === 'finish_grade')!.values.value).toBe('A_GRADE')
    await command(caller, { name: 'imports.applyBatch', input: { test: 'fields' } }, async (tools) => {
      await adapter.write(tools, { action: 'UPDATE', key: rows[0]!.key, recordId: existing.find((record) => record.values.field === 'finish_grade')!.id, before: { value: 'A_GRADE' }, values: { value: 'Seconda scelta' } }, scope)
      await adapter.write(tools, { action: 'CREATE', key: rows[1]!.key, recordId: null, before: {}, values: rows[1]!.values }, scope)
      return { written: 2 }
    })
    const after = await ok('seller', 'GET', `/fields/values/ORDER/${order.id}`)
    expect(after.values.find((value: Json) => value.code === 'finish_grade').value).toBe('B_GRADE')
    expect(after.values.find((value: Json) => value.code === 'agreed_discount').value).toEqual({ amount: 1250, currency: 'EUR' })
  })
})
