import { randomBytes } from 'node:crypto'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { FactoryDatabase } from '@nexus/factory-db'
import { grainPermission } from '@nexus/factory-domain/auth/grains/grains'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, stepUp, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Customers in depth (B-W2b-290; SAL-013, SAL-014, SAL-021, SAL-022, SAL-023, SAL-028) on the local stack with the app's
 * real routes: a throwaway PostgreSQL 17 database from the migrations (the runtime login: row-level security and the
 * …_sales_intake_w2b_guards triggers are real), tenant A from EVERY seed (SEED-C1 a tenant-wide brand and team with its
 * rider SEED-R2, terms with company A (PO number required, a credit limit) and B; SEED-C2 with its terms in A; their
 * requirements, holds and contacts' lawful bases). Test sessions hold the role templates' grants; the erasure (a fresh code)
 * goes through the harness's real sign-in with two-factor. Every name and number is made up.
 *
 * What it walks: requirements written, replaced and ended, and shown where they apply (order, shipment); an account hold
 * placed and released with words, a quote's warning, a typed order and a shipment refused, the order of an accepted quote
 * waiting for the release and then for its PO number; terms per company (made, changed, the company's own only, ended,
 * read by a new quote and a typed order); a contact's basis, objection, access copy and erasure; a rider under a team.
 * Run with `node scripts/factory/run-pg-tests.mjs modules/parties/`.
 */

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const SEED_DIR = fileURLToPath(new URL('../../../../../../packages/factory-db/seed', import.meta.url))
const NS = 'customers-290'
const id = (key: string) => seedUuid(NS, key)
const A = { tenant: id('tenant'), companyA: id('company:A'), companyB: id('company:B'), siteA1: id('site:A1'), p1: id('party:P1'), p3: id('party:P3') }
const TENANT: TestTenant = { id: A.tenant, slug: NS, companies: [{ id: A.companyA, code: 'A' }, { id: A.companyB, code: 'B' }] }

function grantsOf(role: string, companies: 'all' | readonly string[] = 'all', drop: readonly string[] = []): Grant[] {
  const template = templateOf(role)!
  const permissions = [...template.permissions, ...template.grains.map((grain) => grainPermission(grain) as Permission)].filter((permission) => !drop.includes(permission))
  return [{ permissions, companies, sites: 'all', parties: 'all' }]
}
const SESSIONS: Record<string, SessionContext> = {}
const ACTORS: Record<string, string> = {}
function office(key: string, role: string, companies: 'all' | readonly string[] = 'all', drop: readonly string[] = []): void {
  ACTORS[key] = newId()
  SESSIONS[key] = { audience: 'office', tenantId: A.tenant, actorId: ACTORS[key]!, grants: grantsOf(role, companies, drop) }
}

let h: Harness
let app: FastifyInstance
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
const one = async <T = Json>(sql: string, values: unknown[] = []): Promise<T> => (await admin<T>(sql, values))[0]!
/** Moves test data past its own guards (the admin's session only), then back. */
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
const run = randomBytes(4).toString('hex')
let keys = 0
const freshKey = () => `w2b290-${run}-${++keys}`
const call = (session: string, method: Method, url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method !== 'GET' ? { 'idempotency-key': freshKey() } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json() as Json
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return (response.json() as Json).error
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))
const outbox = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [A.tenant, type])).map((row) => row.payload)

let jacketStyleId: string
const LINE = { colourwayId: '', size: '' }
const manualLine = () => [{ styleId: jacketStyleId, colourwayId: LINE.colourwayId, unitPrice: '100', sizes: [{ size: LINE.size, quantity: 1 }] }]
let so1: { id: string }
let q2: { id: string; versionId: string }

beforeAll(async () => {
  h = await startHarness('customers_w2b290')
  for (const file of readdirSync(SEED_DIR).filter((name) => name.endsWith('.ts')).sort()) {
    const module = (await import(pathToFileURL(join(SEED_DIR, file)).href)) as { seed: (context: { db: FactoryDatabase; namespace: string }) => Promise<unknown> }
    await module.seed({ db: h.database, namespace: NS })
  }
  // The system roles as the templates hold them now (parties.hold, parties.privacy, parties.erase for their templates).
  await h.database.withScope({ audience: 'office', tenantId: A.tenant, actorId: newId() }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId: newId() }))
  office('sales', 'sales')
  office('finance', 'finance')
  office('buyer', 'buyer')
  office('warehouse', 'warehouse')
  office('reader', 'read_only')
  office('salesB', 'sales', [A.companyB])
  office('noOrders', 'sales', 'all', ['orders.view'])
  for (const [key, actorId] of Object.entries(ACTORS)) await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [actorId, A.tenant, `w2b290-${key}-${run}@example.com`, `Made-up ${key}`])
  const colourway = await one<{ id: string; size: string }>(`SELECT c.id, (s.sizes)[1] AS size FROM "Colourway" c JOIN "Style" s ON s.id = c."styleId" WHERE c."tenantId" = $1 AND c."styleId" = (SELECT "styleIds"[1] FROM "CustomerRequirement" WHERE "tenantId" = $1 AND "supersedesId" IS NOT NULL) ORDER BY c."createdAt", c.id LIMIT 1`, [A.tenant])
  LINE.colourwayId = colourway.id
  LINE.size = colourway.size
  jacketStyleId = (await one<{ id: string }>(`SELECT "styleIds"[1]::text AS id FROM "CustomerRequirement" WHERE "tenantId" = $1 AND "supersedesId" IS NOT NULL`, [A.tenant])).id
  so1 = await one(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = 'SEED-SO-0001'`, [A.tenant])
  q2 = await one(`SELECT q.id, v.id AS "versionId" FROM "Quote" q JOIN "QuoteVersion" v ON v."quoteId" = q.id WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0002'`, [A.tenant])
  app = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('customer requirements (SAL-014)', () => {
  it('lists the requirements in force and the ended ones, with where each is shown', async () => {
    const { requirements } = await ok('sales', 'GET', `/parties/${A.p1}/requirements`)
    expect(requirements.inForce.map((row: Json) => row.kind).sort()).toEqual(['DOCUMENT', 'LABEL', 'PACKING'])
    const label = requirements.inForce.find((row: Json) => row.kind === 'LABEL')
    expect(label).toMatchObject({ everyStyle: false, styles: [{ id: jacketStyleId }], shownOn: { en: 'the quote · the order' }, supersedesId: expect.any(String) })
    expect(requirements.ended).toEqual([expect.objectContaining({ kind: 'LABEL', active: false, endReason: 'German added for the new market.' })])
    const documents = requirements.inForce.find((row: Json) => row.kind === 'DOCUMENT')
    expect(documents).toMatchObject({ companyId: null, file: { fileName: 'Seed routing guide.pdf' } })
  })

  it('adds one, replaces it in one command (the old one ended), ends it with its reason', async () => {
    const added = await ok('sales', 'POST', `/parties/${A.p1}/requirements`, { companyId: A.companyA, kind: 'SHIPPING', words: 'Pallets no higher than 1.6 m.', appliesAt: ['SHIPMENT', 'ORDER'] }, 201)
    const made = added.requirements.inForce.find((row: Json) => row.id === added.requirementId)
    expect(made).toMatchObject({ appliesAt: ['ORDER', 'SHIPMENT'], everyStyle: true, createdBy: 'Made-up sales' })
    const replaced = await ok('sales', 'POST', `/parties/${A.p1}/requirements/${made.id}/replace`, { version: made.version, companyId: A.companyA, kind: 'SHIPPING', words: 'Pallets no higher than 1.4 m.', appliesAt: ['SHIPMENT'], reason: 'New warehouse racks.' }, 201)
    const next = replaced.requirements.inForce.find((row: Json) => row.id === replaced.requirementId)
    expect(next).toMatchObject({ words: 'Pallets no higher than 1.4 m.', supersedesId: made.id })
    expect(replaced.requirements.ended.find((row: Json) => row.id === made.id)).toMatchObject({ endReason: 'New warehouse racks.', endedBy: 'Made-up sales' })
    const stale = await no('sales', 'POST', `/parties/${A.p1}/requirements/${made.id}/end`, { version: made.version, reason: 'Again' }, 409)
    expect(stale.message).toContain('ended already')
    const ended = await ok('sales', 'POST', `/parties/${A.p1}/requirements/${next.id}/end`, { version: next.version, reason: 'The customer dropped the rule.' })
    expect(ended.requirements.inForce.some((row: Json) => row.id === next.id)).toBe(false)
    expect((await outbox('party.requirement_changed')).map((payload) => payload.change)).toEqual(['ADDED', 'REPLACED', 'ENDED'])
  })

  it('refuses in words: no words, no place, a company the person does not work for, a reader', async () => {
    const empty = await no('sales', 'POST', `/parties/${A.p1}/requirements`, { companyId: null, kind: 'OTHER', words: ' ', appliesAt: [] }, 400)
    expect(paths(empty)).toEqual(['body/words', 'body/appliesAt'])
    await no('salesB', 'POST', `/parties/${A.p1}/requirements`, { companyId: A.companyA, kind: 'OTHER', words: 'A rule.', appliesAt: ['ORDER'] }, 403)
    await no('reader', 'POST', `/parties/${A.p1}/requirements`, { companyId: null, kind: 'OTHER', words: 'A rule.', appliesAt: ['ORDER'] }, 403)
  })

  it('shows the requirements where they apply: the order (ORDER), the shipment (pick & pack, shipping checklist)', async () => {
    const onOrder = await ok('sales', 'GET', `/parties/requirements/for/SalesOrder/${so1.id}`)
    expect(onOrder.record).toMatchObject({ type: 'SalesOrder', number: 'SEED-SO-0001', companyId: A.companyA })
    expect(onOrder.stages.map((stage: Json) => stage.stage)).toEqual(['ORDER'])
    expect(onOrder.stages[0].requirements.map((row: Json) => row.kind)).toContain('PACKING')
    const shipment = await one<{ id: string }>(`SELECT id FROM "Shipment" WHERE "tenantId" = $1 AND number = 'SEED-SH-0002'`, [A.tenant])
    const onShipment = await ok('sales', 'GET', `/parties/requirements/for/Shipment/${shipment.id}`)
    const at = Object.fromEntries(onShipment.stages.map((stage: Json) => [stage.stage, stage.requirements.map((row: Json) => row.kind)]))
    expect(at.PACKING).toContain('PACKING')
    expect(at.SHIPMENT).toContain('DOCUMENT')
    // The record's own view permission decides: without orders.view the order is not found.
    await no('noOrders', 'GET', `/parties/requirements/for/SalesOrder/${so1.id}`, undefined, 404)
    await no('sales', 'GET', `/parties/requirements/for/Pallet/${so1.id}`, undefined, 400)
  })
})

describe('account on hold (SAL-023)', () => {
  let holdId: string
  let holdVersion: number

  it('places a hold for company A with its reason; one per company and reason', async () => {
    const { holds } = await ok('finance', 'POST', `/parties/${A.p1}/holds`, { companyId: A.companyA, reason: 'CREDIT', words: 'Two invoices overdue by 60 days.' }, 201)
    expect(holds.onHold).toBe(true)
    expect(holds.holds[0]).toMatchObject({ inForce: true, reason: 'CREDIT', companyId: A.companyA, company: { code: expect.any(String) }, placedBy: 'Made-up finance' })
    holdId = holds.holds[0].id
    holdVersion = holds.holds[0].version
    const twin = await no('sales', 'POST', `/parties/${A.p1}/holds`, { companyId: A.companyA, reason: 'CREDIT', words: 'Again.' }, 409)
    expect(paths(twin)).toEqual(['body/reason'])
    await no('reader', 'POST', `/parties/${A.p1}/holds`, { companyId: A.companyA, reason: 'LEGAL', words: 'No.' }, 403)
    await no('buyer', 'POST', `/parties/${A.p1}/holds`, { companyId: A.companyA, reason: 'LEGAL', words: 'No.' }, 403)
    const empty = await no('finance', 'POST', `/parties/${A.p1}/holds`, { companyId: null, reason: 'LEGAL', words: '' }, 400)
    expect(empty.message).toBe('Say why the account goes on hold.')
    expect(await outbox('party.hold_placed')).toEqual([expect.objectContaining({ partyId: A.p1, holdId, companyId: A.companyA, reason: 'CREDIT' })])
  })

  it('warns on the quote; refuses a typed order and a new shipment in words; the order of an accepted quote waits', async () => {
    const { quote } = await ok('sales', 'GET', `/sales/quotes/${q2.id}`)
    expect(quote.issues).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'ACCOUNT_ON_HOLD', severity: 'WARNING', message: expect.stringContaining('SEED-C1 is on hold (credit: Two invoices overdue by 60 days.)') })]))
    const preview = await no('sales', 'POST', '/sales/orders/manual/preview', { companyId: A.companyA, partyId: A.p1, customerRef: 'PO-290-1', lines: manualLine() }, 409)
    expect(preview.message).toContain('New orders wait until it is released')
    const shipment = await no('warehouse', 'POST', '/shipping/shipments', { salesOrderId: so1.id, siteId: A.siteA1 }, 409)
    expect(shipment.message).toContain('Shipments wait until it is released')
    // SEED-Q-0002 accepted (test data, past its guards): its order is not made while the hold is in force.
    const accepted = await one<{ billTo: Json; shipTo: Json }>(`SELECT v."billTo", v."shipTo" FROM "QuoteVersion" v JOIN "Quote" q ON q.id = v."quoteId" WHERE q."tenantId" = $1 AND q.number = 'SEED-Q-0001'`, [A.tenant])
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [q2.versionId, accepted.billTo, accepted.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [q2.id])
    const held = await no('sales', 'POST', '/sales/orders', { quoteVersionId: q2.versionId }, 409)
    expect(paths(held)).toEqual(['party/hold'])
    const { holds } = await ok('sales', 'GET', `/parties/${A.p1}/holds`)
    expect(holds.ordersWaiting).toEqual([expect.objectContaining({ number: 'SEED-Q-0002', quoteVersionId: q2.versionId })])
  })

  it('releases the hold with words; the history stays; then the PO number its terms require is asked at confirm', async () => {
    await no('finance', 'POST', `/parties/${A.p1}/holds/${holdId}/release`, { version: holdVersion, words: '' }, 400)
    const { holds } = await ok('finance', 'POST', `/parties/${A.p1}/holds/${holdId}/release`, { version: holdVersion, words: 'Both invoices paid.' })
    expect(holds.holds.find((row: Json) => row.id === holdId)).toMatchObject({ inForce: false, releaseWords: 'Both invoices paid.', releasedBy: 'Made-up finance' })
    expect(await outbox('party.hold_released')).toEqual([expect.objectContaining({ holdId, stillOnHold: false })])
    const again = await no('finance', 'POST', `/parties/${A.p1}/holds/${holdId}/release`, { version: holdVersion + 1, words: 'Again.' }, 409)
    expect(again.message).toContain('released already')
    const { quote } = await ok('sales', 'GET', `/sales/quotes/${q2.id}`)
    expect(quote.issues.some((issue: Json) => issue.code === 'ACCOUNT_ON_HOLD')).toBe(false)
    // SEED-C1 with company A needs its PO number (SAL-013): the quote had none.
    const missing = await no('sales', 'POST', '/sales/orders', { quoteVersionId: q2.versionId }, 400)
    expect(paths(missing)).toEqual(['body/customerRef'])
    expect(missing.message).toContain("needs its purchase order number on every order with")
    const made = await ok('sales', 'POST', '/sales/orders', { quoteVersionId: q2.versionId, customerRef: 'PO-290-77' }, 201)
    expect(made.order).toMatchObject({ customerRef: 'PO-290-77', partyId: A.p1 })
  })

  it('a typed order without the PO number is refused at confirm, with it taken', async () => {
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', { companyId: A.companyA, partyId: A.p1, lines: manualLine() })
    expect(preview.problems.map((problem: Json) => problem.path)).toContain('body/customerRef')
    const withRef = await ok('sales', 'POST', '/sales/orders/manual/preview', { companyId: A.companyA, partyId: A.p1, customerRef: 'PO-290-2', lines: manualLine() })
    expect(withRef.problems.map((problem: Json) => problem.path)).not.toContain('body/customerRef')
  })
})

describe('terms per company (SAL-028, SAL-013)', () => {
  it("reads every company's terms, what is in force and where it comes from", async () => {
    const { terms } = await ok('sales', 'GET', `/parties/${A.p1}/company-terms`)
    expect(terms.tenantWide).toBe(true)
    const a = terms.companies.find((row: Json) => row.company.id === A.companyA)
    const b = terms.companies.find((row: Json) => row.company.id === A.companyB)
    expect(a).toMatchObject({ terms: { poNumberRequired: true, depositPct: '30', creditLimitAmount: 5_000_000, creditLimitCurrency: 'EUR' }, inForce: { poNumberRequired: true, source: { deposit: 'COMPANY' } } })
    expect(b).toMatchObject({ terms: { depositPct: '40', poNumberRequired: false }, inForce: { depositPct: '40' } })
    // Without the price grain the limit is left out.
    const blind = await ok('buyer', 'GET', `/parties/${A.p1}/company-terms`)
    expect(blind.terms.companies.find((row: Json) => row.company.id === A.companyA).terms).not.toHaveProperty('creditLimitAmount')
  })

  it('makes, changes and ends one company’s terms; a person of B changes only B’s', async () => {
    // Company A is not one salesB works for: not found for them.
    await no('salesB', 'PUT', `/parties/${A.p3}/company-terms/${A.companyA}`, { depositPct: '25' }, 404)
    await no('reader', 'PUT', `/parties/${A.p3}/company-terms/${A.companyA}`, { depositPct: '25' }, 403)
    const made = await ok('salesB', 'PUT', `/parties/${A.p3}/company-terms/${A.companyB}`, { depositPct: '25', poNumberRequired: true })
    const b = made.terms.companies.find((row: Json) => row.company.id === A.companyB)
    expect(b).toMatchObject({ terms: { depositPct: '25', poNumberRequired: true, setBy: 'Made-up salesB' }, inForce: { depositPct: '25', poNumberRequired: true } })
    const twice = await no('salesB', 'PUT', `/parties/${A.p3}/company-terms/${A.companyB}`, { depositPct: '30' }, 409)
    expect(paths(twice)).toEqual(['body/version'])
    await no('salesB', 'PUT', `/parties/${A.p3}/company-terms/${A.companyB}`, { version: b.terms.version, depositPct: '0' }, 400)
    const changed = await ok('salesB', 'PUT', `/parties/${A.p3}/company-terms/${A.companyB}`, { version: b.terms.version, poNumberRequired: false })
    const after = changed.terms.companies.find((row: Json) => row.company.id === A.companyB)
    expect(after.terms).toMatchObject({ depositPct: '25', poNumberRequired: false })
    const ended = await ok('salesB', 'POST', `/parties/${A.p3}/company-terms/${A.companyB}/end`, { version: after.terms.version })
    const back = ended.terms.companies.find((row: Json) => row.company.id === A.companyB)
    expect(back).toMatchObject({ terms: null, inForce: { poNumberRequired: false, source: { deposit: 'PARTY' } } })
    expect(back.history[0]).toMatchObject({ endedBy: 'Made-up salesB' })
    // SEED-C1's terms with A carry its credit limit (B-W2b-304's): ended only by clearing the fields.
    const { terms } = await ok('sales', 'GET', `/parties/${A.p1}/company-terms`)
    const limited = await no('sales', 'POST', `/parties/${A.p1}/company-terms/${A.companyA}/end`, { version: terms.companies.find((row: Json) => row.company.id === A.companyA).terms.version }, 409)
    expect(limited.message).toContain('credit limit')
    expect((await outbox('party.company_terms_changed')).map((payload) => payload.change)).toEqual(['SET', 'SET', 'ENDED'])
  })

  it("a new quote of company B takes the customer's terms with B (deposit 40 %, not its own 30 %)", async () => {
    const { quote } = await ok('sales', 'POST', '/sales/quotes', { companyId: A.companyB, partyId: A.p1, customerRef: 'RFQ-290-B' }, 201)
    expect(Number(quote.current.depositPct)).toBe(40)
    const inA = await ok('sales', 'POST', '/sales/quotes', { companyId: A.companyA, partyId: A.p1, customerRef: 'RFQ-290-A' }, 201)
    expect(Number(inA.quote.current.depositPct)).toBe(30)
  })
})

describe("contacts' personal data (SAL-022)", () => {
  const buyer = () => id('party-contact:P1:buyer')
  const p3Buyer = () => id('party-contact:P3:buyer')

  it('lists every contact with its lawful basis; the erased one stays blank', async () => {
    const { privacy } = await ok('sales', 'GET', `/parties/${A.p1}/contacts/privacy`)
    const byId = new Map(privacy.contacts.map((row: Json) => [row.id, row]))
    expect(byId.get(buyer())).toMatchObject({ lawfulBasis: 'CONTRACT', erased: false, basisWords: { article: 'GDPR art. 6(1)(b)' } })
    expect(privacy.contacts.find((row: Json) => row.erased)).toMatchObject({ name: 'Erased contact', status: 'ARCHIVED' })
  })

  it('records a consent with when and how, then the withdrawal once', async () => {
    const before = (await ok('sales', 'GET', `/parties/${A.p1}/contacts/privacy`)).privacy.contacts.find((row: Json) => row.id === buyer())
    const missing = await no('sales', 'PUT', `/parties/${A.p1}/contacts/${buyer()}/lawful-basis`, { version: before.version, lawfulBasis: 'CONSENT' }, 400)
    expect(paths(missing)).toContain('body/consentAt')
    const set = await ok('sales', 'PUT', `/parties/${A.p1}/contacts/${buyer()}/lawful-basis`, { version: before.version, lawfulBasis: 'CONSENT', consentAt: '2026-11-01T09:00:00.000Z', consentSource: 'Signed form at the fair (made up)' })
    const row = set.privacy.contacts.find((entry: Json) => entry.id === buyer())
    expect(row).toMatchObject({ lawfulBasis: 'CONSENT', consentSource: 'Signed form at the fair (made up)', consentAt: '2026-11-01T09:00:00.000Z' })
    const objected = await ok('sales', 'POST', `/parties/${A.p1}/contacts/${buyer()}/objection`, { version: row.version, words: 'Withdrawn by mail (made up).' })
    const after = objected.privacy.contacts.find((entry: Json) => entry.id === buyer())
    expect(after.objectedAt).not.toBeNull()
    await no('sales', 'POST', `/parties/${A.p1}/contacts/${buyer()}/objection`, { version: after.version, words: 'Again.' }, 409)
    await no('reader', 'PUT', `/parties/${A.p1}/contacts/${buyer()}/lawful-basis`, { version: after.version, lawfulBasis: 'CONTRACT' }, 403)
    expect((await outbox('party.contact_privacy_changed')).map((payload) => payload.change).slice(0, 2)).toEqual(['BASIS', 'OBJECTED'])
  })

  it('gives the access copy of what we hold, and records that it was given (never its content)', async () => {
    const { copy } = await ok('sales', 'POST', `/parties/${A.p1}/contacts/${buyer()}/access-copy`, { words: 'Asked by mail on 10 Nov (made up).' }, 201)
    expect(copy.person).toMatchObject({ email: 'buyer.p1@example.com', name: 'Seed Buyer One' })
    expect(copy.processing).toMatchObject({ lawfulBasis: 'CONSENT', organisation: { code: 'SEED-C1' } })
    expect(copy.records.quotes.map((row: Json) => row.number)).toContain('SEED-Q-0001')
    expect(copy.changes.map((row: Json) => row.action)).toEqual(expect.arrayContaining(['parties.setLawfulBasis', 'parties.recordObjection']))
    const audit = await one<Json>(`SELECT reason, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'parties.accessCopy' AND "recordId" = $2`, [A.tenant, buyer()])
    expect(audit.reason).toBe('Asked by mail on 10 Nov (made up).')
    expect(JSON.stringify(audit.after)).not.toContain('buyer.p1@example.com')
  })

  it('erases a contact only with a fresh code, refuses while a portal user signs in with its e-mail, keeps the row blank', async () => {
    h.clock.set(new Date(Date.now() - 4 * 60_000))
    const user = await addUser(h, TENANT, { email: `w2b290-eraser-${run}@example.com`, role: 'finance' })
    const browser = new Browser(h.app)
    const signed = await browser.signIn(TENANT.slug, user.email, user.password)
    expect(signed.body.status).toBe('signed_in')
    const secret = await enrolTotp(h, browser)
    const send = (url: string, body: unknown) => browser.send('POST', url, body, { headers: { 'idempotency-key': freshKey() } })
    const first = (await ok('finance', 'GET', `/parties/${A.p3}/contacts/privacy`)).privacy.contacts.find((row: Json) => row.id === p3Buyer())
    // A recorded basis first (an audit row the erasure keeps).
    const current = (await ok('sales', 'PUT', `/parties/${A.p3}/contacts/${p3Buyer()}/lawful-basis`, { version: first.version, lawfulBasis: 'CONTRACT' })).privacy.contacts.find((row: Json) => row.id === p3Buyer())
    // Without a fresh code: refused.
    const unsigned = await send(`/parties/${A.p3}/contacts/${p3Buyer()}/erase`, { version: current.version, words: 'Erasure asked by letter (made up).' })
    expect(unsigned.status, JSON.stringify(unsigned.body)).toBe(403)
    await stepUp(h, browser, secret)
    // A contact whose e-mail a portal user signs in with: end that access first.
    const portal = await ok('sales', 'POST', `/parties/${A.p1}/contacts`, { name: 'Made-up Portal Person', email: `buyer.portal.${NS}@example.com`, roles: [] }, 201)
    const portalContact = (portal.party.contacts as Json[]).find((row) => row.email === `buyer.portal.${NS}@example.com`)!
    const busy = await send(`/parties/${A.p1}/contacts/${portalContact.id}/erase`, { version: portalContact.version, words: 'Asked (made up).' })
    expect(busy.status, JSON.stringify(busy.body)).toBe(409)
    expect((busy.body as Json).error.issues[0].path).toBe('privacy/PORTAL_USER')
    const erased = await send(`/parties/${A.p3}/contacts/${p3Buyer()}/erase`, { version: current.version, words: 'Erasure asked by letter (made up).' })
    expect(erased.status, JSON.stringify(erased.body)).toBe(200)
    const answer = erased.body as Json
    expect(answer.privacy.contacts.find((row: Json) => row.id === p3Buyer())).toMatchObject({ erased: true, name: 'Erased contact', status: 'ARCHIVED' })
    expect(answer.kept.map((entry: Json) => entry.kind)).toContain('auditRows')
    const row = await one<Json>(`SELECT name, email, phone, status::text AS status, "erasedById", version FROM "PartyContact" WHERE id = $1`, [p3Buyer()])
    expect(row).toMatchObject({ name: '', email: null, phone: null, status: 'ARCHIVED', erasedById: user.id })
    const audit = await one<Json>(`SELECT before, after FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'parties.eraseContact'`, [A.tenant])
    expect(JSON.stringify(audit)).not.toContain('buyer.p3@example.com')
    // Afterwards: no copy to give, no new basis, and W1's contact PATCH answers in words.
    await no('sales', 'POST', `/parties/${A.p3}/contacts/${p3Buyer()}/access-copy`, { words: 'Again (made up).' }, 409)
    const patched = await no('sales', 'PATCH', `/parties/${A.p3}/contacts/${p3Buyer()}`, { version: row.version, name: 'Back again', roles: [] }, 409)
    expect(paths(patched)).toEqual(['privacy/CONTACT_ERASED'])
    await no('sales', 'PUT', `/parties/${A.p3}/contacts/${p3Buyer()}/lawful-basis`, { version: row.version, lawfulBasis: 'CONSENT' }, 409)
    // sales holds parties.privacy, not parties.erase.
    await no('sales', 'POST', `/parties/${A.p1}/contacts/${buyer()}/erase`, { version: 1, words: 'No.' }, 403)
    expect(await outbox('party.contact_erased')).toEqual([{ partyId: A.p3, code: 'SEED-C2', contactId: p3Buyer() }])
  })
})

describe('riders under a team (SAL-021)', () => {
  it("lists the team's riders and puts a new rider (a person) under it; refuses an organisation as rider and a person as team", async () => {
    const { riders } = await ok('sales', 'GET', `/parties/${A.p1}/riders`)
    expect(riders.kind).toBe('ORGANISATION')
    expect(riders.riders.map((row: Json) => row.code)).toContain('SEED-R2')
    const rider = (await ok('sales', 'POST', '/parties', { code: `R290${run}`.toUpperCase().slice(0, 20), kind: 'PERSON', legalName: 'Made-up Rider 290', roles: ['CUSTOMER'], country: 'IT', currency: 'EUR', language: 'it' }, 201)).party
    const put = await ok('sales', 'PUT', `/parties/${rider.id}/team`, { version: rider.version, teamPartyId: A.p1 })
    expect(put.riders.team).toMatchObject({ id: A.p1, code: 'SEED-C1' })
    expect((await ok('sales', 'GET', `/parties/${A.p1}/riders`)).riders.riders.map((row: Json) => row.id)).toContain(rider.id)
    const r2 = await one<{ id: string; version: number }>(`SELECT id, version FROM "Party" WHERE "tenantId" = $1 AND code = 'SEED-R2'`, [A.tenant])
    const asTeam = await no('sales', 'PUT', `/parties/${rider.id}/team`, { version: put.riders.version, teamPartyId: r2.id }, 400)
    expect(asTeam.message).toContain('a rider rides for a team or dealer')
    const orgAsRider = await no('sales', 'PUT', `/parties/${A.p3}/team`, { version: 1, teamPartyId: A.p1 }, 400)
    expect(orgAsRider.message).toContain('only a person rides for a team')
    const off = await ok('sales', 'PUT', `/parties/${rider.id}/team`, { version: put.riders.version, teamPartyId: null })
    expect(off.riders.team).toBeNull()
    expect(await outbox('party.team_changed')).toEqual([
      expect.objectContaining({ partyId: rider.id, teamPartyId: A.p1, previousTeamPartyId: null }),
      expect.objectContaining({ partyId: rider.id, teamPartyId: null, previousTeamPartyId: A.p1 }),
    ])
  })
})
