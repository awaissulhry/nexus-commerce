import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { openFactoryDatabase, RUNTIME_LOGIN, type FactoryDatabase } from '@nexus/factory-db'
import { migratedDatabase, type MigratedDatabase } from '@nexus/factory-db/testing'
import { plusDays } from '@nexus/factory-domain/calendars/dates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'

/**
 * Suppliers in depth (B-W2b-311; SCM-002, SCM-004, SCM-008, SCM-012, SCM-016) on the local stack with the app's real
 * routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security, the grants and
 * the …_suppliers_depth_w2b_guards triggers are real), the factory-db seeds up to production (company A's supplier and
 * subcontractor P2 with its order desk, PO1 confirmed), the seeded owner and member as the people who decide (the trigger
 * wants an active office user), and sessions from the test authenticator. Every name, date and number is made up. Run
 * with `node scripts/factory/run-pg-tests.mjs modules/purchasing/suppliers-depth`.
 */

let db: MigratedDatabase
let database: FactoryDatabase
let app: FastifyInstance

const NS = 'suppliers-depth-311'
const idOf = (key: string) => seedUuid(NS, key)
const A = {
  tenant: idOf('tenant'),
  owner: idOf('actor'),
  member: idOf('user:member'),
  companyA: idOf('company:A'),
  companyB: idOf('company:B'),
  siteA1: idOf('site:A1'),
  brand: idOf('party:P1'),
  supplier: idOf('party:P2'),
  orderDesk: idOf('party-contact:P2:orders'),
}

const grant = (permissions: Permission[], companies: Grant['companies'] = 'all', parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies, sites: 'all', parties })
const office = (actorId: string, grants: Grant[]): SessionContext => ({ audience: 'office', tenantId: A.tenant, actorId, grants })
const BUYER: Permission[] = ['parties.view', 'parties.manage', 'purchasing.suppliers.status', 'purchasing.view', 'purchasing.manage', 'purchasing.send', 'calendars.view', 'calendars.suppliers.manage', 'money.cost']
/** One person per session name for the whole file (each distinct actor is a factory-db client scope). */
const once = (make: () => SessionContext): (() => SessionContext) => {
  let made: SessionContext | undefined
  return () => (made ??= make())
}
const SESSIONS: Record<string, () => SessionContext> = Object.fromEntries(
  Object.entries({
    buyer: () => office(A.member, [grant(BUYER)]),
    owner: () => office(A.owner, [grant([...BUYER, 'parties.block'])]),
    clerk: () => office(newId(), [grant(['parties.view', 'parties.manage', 'purchasing.view'])]),
    viewer: () => office(newId(), [grant(['parties.view'])]),
    companyB: () => office(newId(), [grant(['parties.view', 'parties.manage', 'purchasing.suppliers.status'], [A.companyB])]),
    partner: () => ({ audience: 'partner', tenantId: A.tenant, actorId: newId(), partyId: A.supplier, grants: [grant(['parties.view'], 'all', [A.supplier])] }),
  } satisfies Record<string, () => SessionContext>).map(([name, make]) => [name, once(make)]),
)

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await db.admin.query(sql, values)).rows as T[]
const run = randomBytes(4).toString('hex')
let keys = 0
const key = () => `suppliers-depth-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key() }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function refused(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const profileUrl = `/purchasing/suppliers/${A.supplier}/profile`
const profile = async (session = 'buyer'): Promise<Json> => (await ok(session, 'GET', profileUrl)).supplier
const eventsOf = async (subject: string, type: string) => (await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE subject = $1 AND type = $2 ORDER BY "occurredAt", id', [subject, type])).map((row) => row.payload)
const today = businessDate(new Date())

beforeAll(async () => {
  db = await migratedDatabase('suppliers_depth_311')
  database = await openFactoryDatabase({ connectionString: db.url(RUNTIME_LOGIN), pool: { max: 8 } })
  await seedCore({ db: database, namespace: NS })
  await seedAuth({ db: database, namespace: NS })
  await seedProduction({ db: database, namespace: NS })
  await seedNumbering({ db: database, namespace: NS })
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await app?.close()
  await database?.close()
  await db?.close()
}, 60_000)

describe('a supplier’s kinds, lead time and origin (SCM-002, SCM-016)', () => {
  it('reads the supplier as W1 left it: no kinds, approved from its W1 status, POs to its orders contact by role', async () => {
    const supplier = await profile()
    expect(supplier).toMatchObject({ code: expect.any(String), roles: ['SUPPLIER', 'SUBCONTRACTOR'], kinds: [], leadTimeDays: 21, standing: { status: 'APPROVED', source: 'PARTY', supplierStatus: null }, newOrderProblem: null })
    expect(supplier.routing.find((entry: Json) => entry.kind === 'PO')).toMatchObject({ by: 'ROLE', contactIds: [A.orderDesk] })
    expect(supplier.routing.find((entry: Json) => entry.kind === 'REMITTANCE')).toMatchObject({ by: 'NONE', contactIds: [] })
  })

  it('keeps kinds, a tannery’s hides and tannages, origin and the default lead time in one change, audited', async () => {
    const before = await profile()
    const after = (
      await ok('buyer', 'PATCH', profileUrl, {
        version: before.version,
        kinds: ['SUBCONTRACTOR', 'TANNERY'],
        leadTimeDays: 10,
        originCountry: 'it',
        originRegion: 'Santa Croce sull’Arno',
        hideOriginCountries: ['IT', 'ES'],
        tannages: ['VEGETABLE', 'CHROME_FREE'],
      })
    ).supplier
    expect(after).toMatchObject({ kinds: ['TANNERY', 'SUBCONTRACTOR'], leadTimeDays: 10, origin: { country: 'IT', region: 'Santa Croce sull’Arno', hideCountries: ['IT', 'ES'], tannages: ['VEGETABLE', 'CHROME_FREE'] }, version: before.version + 1 })
    expect((await eventsOf(A.supplier, 'party.updated')).at(-1)).toMatchObject({ fields: ['supplierKinds', 'leadTimeDays', 'originCountry', 'originRegion', 'hideOriginCountries', 'tannages'] })
    const [audit] = await admin<Json>(`SELECT action, after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'purchasing.suppliers.profile' ORDER BY "occurredAt" DESC, id DESC LIMIT 1`, [A.supplier])
    expect(audit!.after).toMatchObject({ kinds: ['TANNERY', 'SUBCONTRACTOR'], leadTimeDays: 10 })
  })

  it('refuses in words: hides without the tannery kind, a stale version, a person without parties.manage, another company', async () => {
    const supplier = await profile()
    const error = await refused('buyer', 'PATCH', profileUrl, { version: supplier.version, kinds: ['TRIMS'] }, 400)
    expect(error.issues).toEqual([{ path: 'body/hideOriginCountries', message: expect.stringContaining('a tannery’s') }])
    await refused('buyer', 'PATCH', profileUrl, { version: supplier.version - 1, leadTimeDays: 12 }, 409)
    await refused('viewer', 'PATCH', profileUrl, { version: supplier.version, leadTimeDays: 12 }, 403)
    await refused('companyB', 'GET', profileUrl, undefined, 404)
    await refused('partner', 'GET', profileUrl, undefined, 403)
    await refused('buyer', 'GET', `/purchasing/suppliers/${A.brand}/profile`, undefined, 404)
  })
})

describe('contacts by what they receive (SCM-004)', () => {
  let contactId: string

  it('routes POs and claims to the contacts that receive them, and a new PO goes to the first of them', async () => {
    const party = (await ok('buyer', 'POST', `/parties/${A.supplier}/contacts`, { name: 'Ufficio Acquisti Esempio', email: 'acquisti.p2@example.com', roles: [] }, 201)).party
    contactId = party.contacts.find((contact: Json) => contact.email === 'acquisti.p2@example.com').id
    const fresh = (await profile()).contacts.find((contact: Json) => contact.id === contactId)
    const supplier = (await ok('buyer', 'PUT', `/purchasing/suppliers/${A.supplier}/contacts/${contactId}/receives`, { version: fresh.version, receives: ['CLAIM', 'PO', 'PO'] })).supplier
    expect(supplier.contacts.find((contact: Json) => contact.id === contactId)).toMatchObject({ receives: ['PO', 'CLAIM'], version: fresh.version + 1 })
    expect(supplier.routing.find((entry: Json) => entry.kind === 'PO')).toMatchObject({ by: 'RECEIVES', contactIds: [contactId], sentence: 'Purchase orders go to Ufficio Acquisti Esempio (what they receive).' })
    expect(supplier.routing.find((entry: Json) => entry.kind === 'QUALITY')).toMatchObject({ by: 'ROLE', contactIds: [A.orderDesk] })
    expect((await eventsOf(A.supplier, 'party.contacts_changed')).at(-1)).toEqual({ partyId: A.supplier, code: supplier.code, contactIds: [contactId] })

    const order = (await ok('buyer', 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: A.supplier }, 201)).order
    expect(order.contactId ?? order.contact?.id).toBe(contactId)
    const check = await ok('buyer', 'GET', `/purchasing/orders/${order.id}/send-check`)
    expect(check.checks.map((entry: Json) => entry.code)).not.toContain('CONTACT_NOT_ORDERS')
  })

  it('refuses a receiver without an e-mail, a stale contact version and another party’s contact', async () => {
    const party = (await ok('buyer', 'POST', `/parties/${A.supplier}/contacts`, { name: 'Magazzino Esempio', roles: [] }, 201)).party
    const noMail = party.contacts.find((contact: Json) => contact.name === 'Magazzino Esempio')
    expect((await refused('buyer', 'PUT', `/purchasing/suppliers/${A.supplier}/contacts/${noMail.id}/receives`, { version: noMail.version, receives: ['DOCUMENT'] }, 400)).message).toMatch(/e-mail first/)
    await refused('buyer', 'PUT', `/purchasing/suppliers/${A.supplier}/contacts/${contactId}/receives`, { version: 1, receives: [] }, 409)
    await refused('buyer', 'PUT', `/purchasing/suppliers/${A.supplier}/contacts/${idOf('party-contact:P1:buyer')}/receives`, { version: 1, receives: ['PO'] }, 404)
  })
})

describe('closures in the lead time (SCM-012)', () => {
  it('shows the supplier’s closures ahead and moves the arrival of an order placed today past them', async () => {
    const from = plusDays(today, 3)
    const to = plusDays(today, 12)
    const calendar = (await ok('buyer', 'POST', '/calendars', { scope: 'SUPPLIER', ownerId: A.supplier }, 201)).calendar
    await ok('buyer', 'POST', `/calendars/${calendar.id}/days`, { version: calendar.version, from, to, kind: 'CLOSURE', name: 'Chiusura esempio' })
    const supplier = await profile()
    expect(supplier.closures).toMatchObject({ calendarId: calendar.id, weeklyDaysOff: [6, 7], ahead: [{ from, to, kind: 'CLOSURE', name: 'Chiusura esempio', days: 10, words: expect.stringContaining('(Chiusura esempio)') }] })
    expect(supplier.closures.orderedToday).toMatchObject({ orderDate: today, leadTimeDays: 10, arrives: plusDays(today, 20), skipped: [{ from, to, days: 10 }] })
    expect(supplier.closures.orderedToday.words).toMatch(/closed .*\(Chiusura esempio\)/)
  })
})

describe('the supplier status lifecycle (SCM-008)', () => {
  let draftId: string

  it('says what a hold would reach, then holds the supplier with its reason: no new PO in words, the draft held at its send', async () => {
    draftId = (await ok('buyer', 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: A.supplier }, 201)).order.id
    const reach = (await ok('viewer', 'GET', `/purchasing/suppliers/${A.supplier}/status-reach?status=ON_HOLD`)).reach
    expect(reach).toMatchObject({ status: 'ON_HOLD', draftsHeld: expect.any(Number), openUnchanged: expect.any(Number) })
    expect(reach.draftsHeld).toBeGreaterThanOrEqual(2)
    expect(reach.sentence).toMatch(/on hold gets no new purchase order: \d+ draft purchase orders held at the send/)

    const before = await profile()
    expect((await refused('buyer', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: before.version, status: 'ON_HOLD' }, 400)).issues[0]).toMatchObject({ path: 'body/reason' })
    await refused('clerk', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: before.version, status: 'ON_HOLD', reason: 'Ritardi da verificare' }, 403)
    const held = (await ok('buyer', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: before.version, status: 'ON_HOLD', reason: 'Ritardi da verificare' })).supplier
    expect(held.standing).toMatchObject({ status: 'ON_HOLD', source: 'SUPPLIER', supplierStatus: 'ON_HOLD', reason: 'Ritardi da verificare', changedBy: 'Seed Member' })
    expect(held.newOrderProblem).toMatch(/is on hold as a supplier since \d{4}-\d{2}-\d{2} \(Ritardi da verificare\): no new purchase order goes to it/)
    expect(await eventsOf(A.supplier, 'supplier.status_changed')).toEqual([{ partyId: A.supplier, code: held.code, from: null, status: 'ON_HOLD' }])

    const error = await refused('buyer', 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: A.supplier }, 409)
    expect(error.message).toMatch(/on hold as a supplier .*no new purchase order goes to it/)
    const check = await ok('buyer', 'GET', `/purchasing/orders/${draftId}/send-check`)
    expect(check.checks).toContainEqual(expect.objectContaining({ code: 'SUPPLIER_NOT_ACTIVE', severity: 'BLOCKS', message: expect.stringContaining('Ritardi da verificare') }))
  })

  it('corrects the reason alone, refuses a move the lifecycle does not allow, approves again and orders go on', async () => {
    let supplier = await profile()
    const since = supplier.standing.changedAt
    supplier = (await ok('owner', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: supplier.version, status: 'ON_HOLD', reason: 'Ritardi di consegna in verifica' })).supplier
    expect(supplier.standing).toMatchObject({ reason: 'Ritardi di consegna in verifica', changedAt: since, changedBy: 'Seed Member' })
    expect((await refused('owner', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: supplier.version, status: 'PROSPECT' }, 400)).message).toMatch(/on hold is not made a prospect/)
    supplier = (await ok('owner', 'POST', `/purchasing/suppliers/${A.supplier}/status`, { version: supplier.version, status: 'APPROVED' })).supplier
    expect(supplier.standing).toMatchObject({ status: 'APPROVED', reason: null, changedBy: 'Seed Owner' })
    expect(supplier.newOrderProblem).toBeNull()
    await ok('buyer', 'POST', '/purchasing/orders', { companyId: A.companyA, siteId: A.siteA1, partyId: A.supplier }, 201)
    const check = await ok('buyer', 'GET', `/purchasing/orders/${draftId}/send-check`)
    expect(check.checks.map((entry: Json) => entry.code)).not.toContain('SUPPLIER_NOT_ACTIVE')
  })

  it('keeps the supplier role while a status is set (B-W2b-287’s gap), in words', async () => {
    const party = await ok('buyer', 'GET', `/parties/${A.supplier}`)
    const error = await refused('buyer', 'PATCH', `/parties/${A.supplier}`, { version: party.party.version, roles: ['CUSTOMER'] }, 409)
    expect(error.message).toMatch(/has a supplier status \(approved\): it keeps a supplier, subcontractor or carrier role/)
  })

  it('gives a new supplier its first status from W1’s, and W1’s Activate approves a prospect', async () => {
    const created = (await ok('buyer', 'POST', '/parties', { code: 'SD311-NEW', kind: 'ORGANISATION', legalName: 'Nuovo Fornitore Esempio S.r.l.', roles: ['SUPPLIER'], status: 'PROSPECT' }, 201)).party
    let supplier = (await ok('buyer', 'GET', `/purchasing/suppliers/${created.id}/profile`)).supplier
    expect(supplier.standing).toMatchObject({ status: 'PROSPECT', source: 'SUPPLIER', supplierStatus: 'PROSPECT', changedBy: null })
    await ok('buyer', 'POST', `/parties/${created.id}/activate`, { version: created.version })
    supplier = (await ok('buyer', 'GET', `/purchasing/suppliers/${created.id}/profile`)).supplier
    expect(supplier.standing).toMatchObject({ status: 'APPROVED', supplierStatus: 'APPROVED' })
    expect(await eventsOf(created.id, 'supplier.status_changed')).toEqual([{ partyId: created.id, code: 'SD311-NEW', from: 'PROSPECT', status: 'APPROVED' }])
    const customer = (await ok('buyer', 'POST', '/parties', { code: 'SD311-CLI', kind: 'ORGANISATION', legalName: 'Cliente Esempio S.r.l.', roles: ['CUSTOMER'] }, 201)).party
    expect((await admin<Json>('SELECT "supplierStatus" FROM "Party" WHERE id = $1', [customer.id]))[0]!.supplierStatus).toBeNull()
  })
})

describe('the supplier list (SCM-002, SCM-008)', () => {
  it('filters by kind and by the status the list shows, with the counts for the tiles', async () => {
    const tanneries = (await ok('viewer', 'GET', '/purchasing/suppliers?kind=TANNERY')).suppliers
    expect(tanneries.map((row: Json) => row.id)).toEqual([A.supplier])
    expect(tanneries[0]).toMatchObject({ kinds: ['TANNERY', 'SUBCONTRACTOR'], status: 'APPROVED', source: 'SUPPLIER', originCountry: 'IT', leadTimeDays: 10 })
    const approved = (await ok('viewer', 'GET', '/purchasing/suppliers?status=APPROVED')).suppliers.map((row: Json) => row.code)
    expect(approved).toContain('SD311-NEW')
    expect((await ok('viewer', 'GET', '/purchasing/suppliers?status=ON_HOLD')).suppliers).toEqual([])
    const { counts, suppliers } = await ok('viewer', 'GET', '/purchasing/suppliers/counts')
    expect(counts.APPROVED).toBeGreaterThanOrEqual(2)
    expect(counts.ON_HOLD).toBe(0)
    expect(suppliers).toBe(Object.values(counts as Record<string, number>).reduce((sum, count) => sum + count, 0))
    expect((await ok('companyB', 'GET', '/purchasing/suppliers?kind=TANNERY')).suppliers).toEqual([])
  })
})
