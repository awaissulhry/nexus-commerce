import { randomBytes } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedApprovals } from '../../../../../../packages/factory-db/seed/approvals'
import { seed as seedAuth } from '../../../../../../packages/factory-db/seed/auth'
import { seed as seedRoles } from '../../../../../../packages/factory-db/seed/roles'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { startHarness, type Harness } from '../../../platform/auth/sessions/testing/harness'

/**
 * B-TH-025 — Make order from a request (threads plan TH-2, G3, N8, L2-G06; wall W37) through the app's real routes on a throwaway
 * PostgreSQL 17 database from the migrations (row-level security and the TH-2 guards are real), on the seeds up to the sales
 * intake and approvals (the brand P1 = SEED-C1 and its own-label jacket SEED-JKT-02, the customer P3 = SEED-C2, our own vest made here, the
 * SALES_ORDER series of company A, the credit-override rule "Orders over the credit limit"). Every word and number is made up.
 *
 *   - a request of P1 with ready lines becomes ONE order: CONFIRMED, of P1 and company A (the request's, W37), its PO and promise
 *     date the request's, priced as typed; the request ORDERED naming it, `inquiry.closed` ORDERED with the order, the order's
 *     source read names the request; a file whose bytes are not in the store is said, never stops the order;
 *   - over the credit limit the order is made PENDING_APPROVAL and the answer says it waits (never "confirmed");
 *   - a line asked in words, a prospect, an ordered request, a role that makes no orders: refused in words;
 *   - W37: an office person limited to another customer finds neither the request nor its order; the body names no customer.
 * Run with `node scripts/factory/run-pg-tests.mjs inquiries/make-order`.
 */

vi.setConfig({ testTimeout: 120_000 })

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PUT' | 'PATCH'

const NS = 'th2-make-order'
const idOf = (key: string): string => seedUuid(NS, key)
const T = idOf('tenant')
const companyA = idOf('company:A')
const P1 = idOf('party:P1')
const P3 = idOf('party:P3')

const sales = templateOf('sales')!
const owner = templateOf('owner')!
const withGrains = (template: { permissions: readonly string[]; grains: readonly string[] }) => [...template.permissions, ...template.grains.map((grain) => `money.${grain}`)] as Permission[]
const grant = (permissions: Permission[], parties: Grant['parties'] = 'all'): Grant => ({ permissions, companies: 'all', sites: 'all', parties })
const PEOPLE = { ada: newId(), olivia: newId() } as const
const SESSIONS: Record<string, SessionContext> = {
  ada: { audience: 'office', tenantId: T, actorId: PEOPLE.ada, grants: [grant(withGrains(sales))] },
  // The owner sets the credit limit (sales.credit.limits).
  olivia: { audience: 'office', tenantId: T, actorId: PEOPLE.olivia, grants: [grant(withGrains(owner))] },
  // A sales rep limited to another customer: P1's request and its order are not there for them.
  rep: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(withGrains(sales), [P3])] },
  // Reads and keeps requests but makes no orders (orders.manage taken out).
  noOrders: { audience: 'office', tenantId: T, actorId: newId(), grants: [grant(withGrains(sales).filter((name) => name !== 'orders.manage'))] },
}

let h: Harness
let app: FastifyInstance
const run = randomBytes(4).toString('hex')
let serial = 0
const admin = async <Row = Json>(sql: string, values: unknown[] = []): Promise<Row[]> => (await h.db.admin.query(sql, values)).rows as Row[]
const one = async (sql: string, values: unknown[] = []): Promise<Json> => (await admin(sql, values))[0]!
const call = (session: string, method: Method, url: string, payload?: unknown, key?: string) =>
  app.inject({ method, url, headers: { 'x-test-session': session, ...(method === 'GET' ? {} : { 'idempotency-key': key ?? `mo-${run}-${++serial}` }) }, ...(payload === undefined ? {} : { payload: payload as object }) })
async function ok(session: string, method: Method, url: string, payload?: unknown, status = 200, key?: string): Promise<Json> {
  const response = await call(session, method, url, payload, key)
  expect(response.statusCode, response.body).toBe(status)
  return response.json()
}
async function no(session: string, method: Method, url: string, payload: unknown, status: number): Promise<Json> {
  const response = await call(session, method, url, payload)
  expect(response.statusCode, response.body).toBe(status)
  return response.json().error
}
const refusal = (error: Json): string => String(error.issues?.[0]?.path ?? '')
const events = async (type: string, subject: string) => admin(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 AND subject = $3 ORDER BY "occurredAt", id`, [T, type, subject])

let jacket = '' // SEED-JKT-02: P1's own-label jacket, released
let black = ''
let liner = '' // our own collection's vest, made in beforeAll (any customer orders it)
let grey = ''
const wanted = businessDate(new Date(Date.now() + 45 * 86_400_000))

/** A request typed by the office for a customer, its lines as given. */
async function request(partyId: string | null, lines: Json[], extra: Json = {}): Promise<Json> {
  const { inquiry } = await ok(
    'ada',
    'POST',
    '/sales/inquiries',
    { companyId: companyA, source: 'PHONE', ...(partyId ? { partyId } : { prospect: { company: 'Made-up Moto Club', email: 'club@example.com' } }), request: 'Made-up: team jackets for the season.', wantedDate: wanted, lines, ...extra },
    201,
  )
  return inquiry
}

beforeAll(async () => {
  h = await startHarness('th2_make_order')
  await seedCore({ db: h.database, namespace: NS })
  await seedAuth({ db: h.database, namespace: NS })
  await seedRoles({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  await seedApprovals({ db: h.database, namespace: NS })
  const salesRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'sales'`, [T])).id
  const ownerRole = (await one(`SELECT id FROM "Role" WHERE "tenantId" = $1 AND key = 'owner'`, [T])).id
  for (const [person, userId] of Object.entries(PEOPLE)) {
    await admin(`INSERT INTO "User" (id, "tenantId", email, "displayName", status) VALUES ($1, $2, $3, $4, 'ACTIVE')`, [userId, T, `th2-${person}-${run}@example.test`, `Made-up ${person}`])
    await admin(`INSERT INTO "RoleAssignment" (id, "tenantId", "userId", "roleId", "allCompanies", "companyIds", "validFrom") VALUES ($1, $2, $3, $4, true, '{}'::uuid[], now() - interval '30 days')`, [newId(), T, userId, person === 'olivia' ? ownerRole : salesRole])
  }
  jacket = (await one('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])).id
  black = (await one('SELECT id FROM "Colourway" WHERE "styleId" = $1 AND code = $2', [jacket, 'BLK'])).id
  app = await buildApp(
    { environment: 'test', cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])] ?? null) },
  )
  // Our own collection's vest (no brand: any customer orders it), made by the owner through the style library's route.
  const scale = (await one('SELECT "sizeScaleId" FROM "Style" WHERE id = $1', [jacket])).sizeScaleId
  const colour = (await one('SELECT "colourId" FROM "Colourway" WHERE id = $1', [black])).colourId
  const { style } = await ok('olivia', 'POST', '/product/styles', { companyId: companyA, code: `TH2-OWN-${run}`.toUpperCase(), name: 'Made-up own vest', productType: 'VEST', sizeScaleId: scale, sizes: ['50', '52'], baseSize: '52', ppeCategory: 'NOT_PPE', colourways: [{ code: 'GRY', name: 'Grey', colourId: colour }], generateSkus: true }, 201)
  liner = style.id
  grey = style.colourways[0].id
}, 900_000)

afterAll(async () => {
  await app?.close()
  await h?.close()
}, 60_000)

describe('B-TH-025 Make order from a request', () => {
  let made: Json
  let inquiry: Json

  it('a request of P1 with ready lines becomes one CONFIRMED order of P1 and company A, priced as typed, its PO and wanted date carried', async () => {
    inquiry = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 4, '52': 6 } }])
    // A file of the request whose bytes never reached the store: said in the answer, never a reason to fail the order.
    const sample = (await one(`SELECT id FROM "StoredFile" WHERE "tenantId" = $1 AND status = 'AVAILABLE' ORDER BY "createdAt" LIMIT 1`, [T])).id
    await admin(
      `INSERT INTO "StoredFile" SELECT (jsonb_populate_record(NULL::"StoredFile", to_jsonb(f) || jsonb_build_object('id', $1::uuid, 'recordType', 'Inquiry', 'recordId', $2::uuid, 'storageKey', $3::text, 'originalName', 'Made-up team sketch.pdf', 'partyId', NULL, 'visibility', '{OFFICE}', 'seriesId', NULL, 'versionNo', 1, 'sourceFileId', NULL, 'category', NULL))).*
       FROM "StoredFile" f WHERE f.id = $4`,
      [newId(), inquiry.id, `t/${T}/made-up/${run}/sketch`, sample],
    )
    const seen = await ok('ada', 'GET', `/sales/inquiries/${inquiry.id}`)
    expect(seen.inquiry.actions.order).toEqual({ allowed: true, refusal: null })
    made = await ok('ada', 'POST', `/sales/inquiries/${inquiry.id}/order`, { version: seen.inquiry.version, lines: [{ seq: 10, unitPrice: '150' }], customerRef: 'MADE-UP-PO-77' }, 201)
    expect(made.order).toMatchObject({ number: expect.stringMatching(/^SO-/), status: 'CONFIRMED', waitsFor: null })
    expect(made.said.en).toBe(`Order ${made.order.number} was made from ${inquiry.number} and is confirmed.`)
    expect(made.said.it).toContain('confermato')
    expect(made.inquiry).toMatchObject({ status: 'ORDERED', order: { id: made.order.id, number: made.order.number, status: 'CONFIRMED' }, actions: { order: { allowed: false, refusal: { code: 'CLOSED' } } } })
    const order = await one('SELECT "partyId", "companyId", "customerRef", status, "promiseDate", "requestedDate" FROM "SalesOrder" WHERE id = $1', [made.order.id])
    expect(order).toMatchObject({ partyId: P1, companyId: companyA, customerRef: 'MADE-UP-PO-77', status: 'CONFIRMED' })
    expect(businessDate(order.promiseDate)).toBe(wanted)
    const lines = await admin<Json>('SELECT l."styleId", l."colourwayId", l.quantity, l."unitPrice"::text AS price FROM "SalesOrderLine" l WHERE l."orderId" = $1', [made.order.id])
    expect(lines).toEqual([{ styleId: jacket, colourwayId: black, quantity: 10, price: expect.stringMatching(/^150(\.0+)?$/) }])
    expect(await one('SELECT status, "salesOrderId", "closedById" FROM "Inquiry" WHERE id = $1', [inquiry.id])).toEqual({ status: 'ORDERED', salesOrderId: made.order.id, closedById: PEOPLE.ada })
    expect((await events('inquiry.closed', inquiry.id))[0]!.payload).toMatchObject({ status: 'ORDERED', salesOrderId: made.order.id, quoteId: null, partyId: P1 })
    expect(await events('sales_order.created', made.order.id)).toHaveLength(1)
    // The order's own page names the request it came from.
    expect((await ok('ada', 'GET', `/sales/inquiries/source?salesOrderId=${made.order.id}`)).inquiry).toMatchObject({ id: inquiry.id, number: inquiry.number })
    // The file is listed as not carried, with why; nothing else of the order changed.
    expect(made.files.carried).toEqual([])
    expect(made.files.notCarried).toEqual([expect.objectContaining({ name: 'Made-up team sketch.pdf', reason: expect.stringContaining('file store') })])
  })

  it('the same call again (its idempotency key) answers the same order; a second Make order is refused: the request is ordered', async () => {
    const again = await call('ada', 'POST', `/sales/inquiries/${inquiry.id}/order`, { version: 1 })
    expect(again.statusCode).toBe(409)
    expect(refusal(again.json().error)).toBe('refusal/CLOSED')
    expect((await admin('SELECT id FROM "SalesOrder" WHERE id IN (SELECT "salesOrderId" FROM "Inquiry" WHERE id = $1)', [inquiry.id])).length).toBe(1)
    // Replayed with its own key: the stored answer, no second order.
    const fresh = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '54': 2 } }])
    const key = `mo-replay-${run}`
    const body = { version: fresh.version, lines: [{ seq: 10, unitPrice: '140' }], customerRef: 'MADE-UP-PO-78' }
    const first = await ok('ada', 'POST', `/sales/inquiries/${fresh.id}/order`, body, 201, key)
    const replay = await ok('ada', 'POST', `/sales/inquiries/${fresh.id}/order`, body, 201, key)
    expect(replay.order.id).toBe(first.order.id)
    expect((await events('inquiry.closed', fresh.id)).length).toBe(1)
  })

  it('over the credit limit the order is made PENDING_APPROVAL, and the answer says it waits for approval (never confirmed)', async () => {
    // The company holds orders over a customer's credit limit: its seeded rule "Orders over the credit limit" switched on (a
    // fixture: the seeds write every rule off, Owner answer Q3).
    await admin(`UPDATE "ApprovalRule" SET active = true WHERE "tenantId" = $1 AND kind = 'CREDIT_OVERRIDE'`, [T])
    await ok('olivia', 'PUT', `/sales/credit/limits/${P3}/${companyA}`, { amount: 100, currency: 'EUR', reason: 'Made-up: a new customer starts small.' })
    const asked = await request(P3, [{ styleId: liner, colourwayId: grey, sizes: { '52': 3 } }])
    const waiting = await ok('ada', 'POST', `/sales/inquiries/${asked.id}/order`, { version: asked.version, lines: [{ seq: 10, unitPrice: '150' }] }, 201)
    expect(waiting.order).toMatchObject({ status: 'PENDING_APPROVAL', waitsFor: 'CREDIT' })
    expect(waiting.said.en).toContain('waits for approval')
    expect(waiting.said.en).not.toContain('confirmed')
    expect(waiting.inquiry.order).toMatchObject({ status: 'PENDING_APPROVAL' })
    expect((await one('SELECT status, "partyId" FROM "SalesOrder" WHERE id = $1', [waiting.order.id]))).toEqual({ status: 'PENDING_APPROVAL', partyId: P3 })
  })

  it('the customer’s terms want its PO number: an order without one is refused in words (the normal order checks)', async () => {
    const ready = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 1 } }])
    const refused = await no('ada', 'POST', `/sales/inquiries/${ready.id}/order`, { version: ready.version, lines: [{ seq: 10, unitPrice: '120' }] }, 400)
    expect(refused.message).toContain('purchase order number')
    expect((await one('SELECT status FROM "Inquiry" WHERE id = $1', [ready.id])).status).toBe('NEW')
  })

  it('a line asked in words, a line without sizes, no lines, a prospect: refused in words, nothing made', async () => {
    const words = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 1 } }, { description: 'Made-up: matching gloves', quantity: 4 }])
    const refused = await no('ada', 'POST', `/sales/inquiries/${words.id}/order`, { version: words.version }, 409)
    expect(refusal(refused)).toBe('refusal/LINES_NOT_READY')
    expect(refused.message).toContain('line 20: No style picked')
    expect(refused.message).toContain('make the style draft')
    expect((await ok('ada', 'GET', `/sales/inquiries/${words.id}`)).inquiry.actions.order).toMatchObject({ allowed: false, refusal: { code: 'LINES_NOT_READY' } })
    const sizeless = await request(P1, [{ styleId: jacket, colourwayId: black, quantity: 3 }])
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${sizeless.id}/order`, { version: sizeless.version }, 409))).toBe('refusal/LINES_NOT_READY')
    const bare = await request(P1, [])
    expect(refusal(await no('ada', 'POST', `/sales/inquiries/${bare.id}/order`, { version: bare.version }, 409))).toBe('refusal/NO_LINES')
    const prospect = await request(null, [{ styleId: liner, colourwayId: grey, sizes: { '50': 1 } }])
    const fromProspect = await no('ada', 'POST', `/sales/inquiries/${prospect.id}/order`, { version: prospect.version }, 409)
    expect(refusal(fromProspect)).toBe('refusal/NEEDS_CUSTOMER')
    expect(fromProspect.message).toContain('make the customer first')
    // A price for a line the request does not have.
    const ready = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 1 } }])
    expect((await no('ada', 'POST', `/sales/inquiries/${ready.id}/order`, { version: ready.version, lines: [{ seq: 99, unitPrice: '1' }] }, 400)).message).toContain('no line 99')
    expect((await admin('SELECT id FROM "Inquiry" WHERE id = ANY($1::uuid[]) AND status = \'ORDERED\'', [[words.id, sizeless.id, bare.id, prospect.id, ready.id]])).length).toBe(0)
  })

  it('a role that keeps requests but makes no orders: 403 in words; the action says it is not allowed', async () => {
    const ready = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 1 } }])
    expect((await ok('noOrders', 'GET', `/sales/inquiries/${ready.id}`)).inquiry.actions.order.allowed).toBe(false)
    expect((await no('noOrders', 'POST', `/sales/inquiries/${ready.id}/order`, { version: ready.version }, 403)).message).toContain('make orders')
  })

  it('W37: a rep limited to another customer finds neither P1’s request nor its order; the body cannot name a customer', async () => {
    await no('rep', 'POST', `/sales/inquiries/${inquiry.id}/order`, { version: 2 }, 404)
    await no('rep', 'GET', `/sales/orders/${made.order.id}`, undefined, 404)
    const ready = await request(P1, [{ styleId: jacket, colourwayId: black, sizes: { '50': 1 } }])
    // Strict input: a customer, a company or an address in the body is refused before anything is made.
    for (const extra of [{ partyId: P3 }, { companyId: companyA }, { shipToAddressId: newId() }]) {
      expect((await call('ada', 'POST', `/sales/inquiries/${ready.id}/order`, { version: ready.version, ...extra })).statusCode).toBe(400)
    }
    const fine = await ok('ada', 'POST', `/sales/inquiries/${ready.id}/order`, { version: ready.version, lines: [{ seq: 10, unitPrice: '120' }], customerRef: 'MADE-UP-PO-79' }, 201)
    expect((await one('SELECT "partyId" FROM "SalesOrder" WHERE id = $1', [fine.order.id])).partyId).toBe(P1)
  })
})
