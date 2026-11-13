import { fileURLToPath } from 'node:url'
import type { FastifyInstance } from 'fastify'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Grant, Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/planning/buy'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedNumbering } from '../../../../../../packages/factory-db/seed/numbering'
import { seed as seedProduction } from '../../../../../../packages/factory-db/seed/production'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { buildApp } from '../../../core/app'
import { testAuthenticator, type SessionContext } from '../../../core/context'
import { LOCAL_COOKIE_SECRET } from '../../../env'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'

/**
 * Purchase orders in depth (B-W2b-296; SCM-052, SCM-061, SCM-065, SCM-066, SCM-088, SCM-147) on the local stack: a
 * throwaway PostgreSQL 17 database from the migrations (row-level security and the …_buying_depth_w2b_guards triggers are
 * real), the real app with the real office sign-in (a buyer with two-factor), the FAKE SES mailbox (the only place a
 * confirm link's token exists), the supplier's browser that holds only the token, and a second app with test sessions (a
 * warehouse manager who posts receipts, a planner without the cost grain, a manager without the tolerance permission).
 * The factory-db seeds up to production; the workshop the orders ship to is made here. Every name, number and price is
 * made up. Run with `node scripts/factory/run-pg-tests.mjs modules/purchasing/po-depth`.
 */

let h: Harness
let walls: FastifyInstance
let buyer: Browser

const NS = 'po-depth'
const seedId = (key: string): string => seedUuid(NS, key)
const tenant = seedId('tenant')
const companyA = seedId('company:A')
const siteA1 = seedId('site:A1')
const P2 = seedId('party:P2')
const leather = seedId('product:item:leather')
const protector = seedId('product:item:protector')
const lining = seedId('product:item:lining')
const leatherBLK = seedId('product:item-colour:leather:BLK')
const liningGRY = seedId('product:item-colour:lining:GRY')
const workshop = newId()
const workshopAddress = newId()
const workshopPlace = newId()
const FAKE_VAT = '12345670009'
const today = () => businessDate(new Date())

type Json = Record<string, any>
type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
const admin = async <T = Json>(sql: string, values: unknown[] = []): Promise<T[]> => (await h.db.admin.query(sql, values)).rows as T[]
let counter = 0
const key = (label = 'k'): string => `podepth-${label}-${++counter}-${newId()}`

async function as(method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await buyer.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}), { headers: method === 'GET' ? {} : { 'idempotency-key': key() } })
  expect(answer.status, JSON.stringify(answer.body)).toBe(status)
  return answer.body as Json
}

const grant = (permissions: Permission[]): Grant => ({ permissions, companies: 'all', sites: 'all', parties: 'all' })
const SESSIONS: Record<string, () => SessionContext> = {
  manager: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['inventory.receive', 'inventory.stock.view', 'money.cost', 'files.read', 'files.upload'])] }),
  planner: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view'])] }),
  manageOnly: () => ({ audience: 'office', tenantId: tenant, actorId: newId(), grants: [grant(['purchasing.view', 'purchasing.manage', 'money.cost'])] }),
}
const wall = async (session: string, method: Method, url: string, payload?: unknown, status = 200): Promise<Json> => {
  const answer = await walls.inject({ method, url, headers: { 'x-test-session': session, 'idempotency-key': key('wall') }, ...(payload === undefined ? {} : { payload: payload as object }) })
  expect(answer.statusCode, answer.body).toBe(status)
  return answer.json()
}

const viaLink = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedBrowser/1.0', ...(method === 'POST' ? { 'idempotency-key': key('link') } : {}) }, ...(method === 'POST' ? { payload: (payload ?? {}) as object } : {}) })
const orderUrl = (id: string) => `/purchasing/orders/${id}`
const tokenOf = (outboundId: string): string => {
  const mail = h.ses.mails.find((entry) => entry.outboundId === outboundId)
  return mail ? decodeURIComponent(/#token=(\S+)/.exec(textOf(mail.raw))?.[1] ?? '') : ''
}
const eventsOf = async (subject: string) => (await admin<{ type: string }>('SELECT type FROM "OutboxEvent" WHERE subject = $1 ORDER BY "occurredAt", id', [subject])).map((row) => row.type)

async function draft(lines: readonly { itemId: string; colourId?: string; quantity: string; uom: string; days: number }[], header: Json = {}): Promise<Json> {
  let order = (await as('POST', '/purchasing/orders', { companyId: companyA, siteId: siteA1, partyId: P2, ...header }, 201)).order
  for (const line of lines) {
    order = (await as('POST', `${orderUrl(order.id)}/lines`, { version: order.version, itemId: line.itemId, ...(line.colourId ? { itemColourId: line.colourId } : {}), quantity: line.quantity, uom: line.uom, needDate: addDays(today(), line.days), unitPrice: '2.500000' }, 201)).order
  }
  return order
}
const depth = async (orderId: string): Promise<Json> => (await as('GET', `${orderUrl(orderId)}/depth`)).depth
async function send(orderId: string): Promise<{ order: Json; token: string }> {
  const order = (await as('GET', orderUrl(orderId))).order
  const answer = await as('POST', `${orderUrl(orderId)}/send`, { version: order.version })
  return { order: answer.order, token: tokenOf(answer.sent.emailId) }
}
const confirmAll = async (token: string, version: number) => {
  const answer = await viaLink(token, 'POST', '/link/purchase-order/confirm', { version, mode: 'ALL_AS_ASKED', typedName: 'Mario Rossi', supplierRef: 'OC-9' })
  expect(answer.statusCode, answer.body).toBe(200)
  return answer.json()
}

beforeAll(async () => {
  h = await startHarness('po_depth')
  h.clock.set(new Date())
  await seedCore({ db: h.database, namespace: NS })
  await seedProduction({ db: h.database, namespace: NS })
  await seedNumbering({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: tenant, actorId }, async (client) => applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId }))
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'R2', 'files', 'Files', 'FAKE', 6000, 1000)`, [newId(), tenant])
  const ses = newId()
  await admin(`INSERT INTO "IntegrationAccount" (id, "tenantId", provider, code, label, mode, "rateLimitPerMinute", "rateLimitBurst") VALUES ($1, $2, 'SES', 'ses', 'Mail', 'FAKE', 6000, 1000)`, [ses, tenant])
  await admin(
    `INSERT INTO "EmailIdentity" (id, "tenantId", "companyId", kind, domain, "fromAddress", "displayName", "displayNamePolicy", "replyDomain", "accountId", "verificationStatus", "dkimStatus", "isDefault")
     VALUES ($1, $2, $3, 'CONVERSATION', 'mail.seed-a.example.com', 'acquisti@mail.seed-a.example.com', 'Seed A', 'COMPANY', 'reply.seed-a.example.com', $4, 'SUCCESS', 'SUCCESS', true)`,
    [newId(), tenant, companyA, ses],
  )
  await admin(`UPDATE "Company" SET "vatNumber" = $2, "fiscalCode" = $3, "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA, `IT${FAKE_VAT}`, FAKE_VAT])
  // A made-up workshop with a delivery address and its place of ours on plant A1 (SCM-147).
  await admin(
    `INSERT INTO "Party" (id, "tenantId", "companyId", code, kind, "legalName", roles, status, country, currency, language, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, 'SEED-W9', 'ORGANISATION', 'Seed Workshop Nine S.r.l.', ARRAY['SUBCONTRACTOR']::"PartyRole"[], 'ACTIVE', 'IT', 'EUR', 'it', now(), now())`,
    [workshop, tenant, companyA],
  )
  await admin(
    `INSERT INTO "PartyAddress" (id, "tenantId", "partyId", kinds, name, line1, "postalCode", city, province, country, status, "isDefaultShipTo", "createdAt", "updatedAt")
     VALUES ($1, $2, $3, ARRAY['SHIP_TO']::"PartyAddressKind"[], 'Laboratorio', 'Via Esempio 99', '00000', 'Seedville', 'MI', 'IT', 'ACTIVE', true, now(), now())`,
    [workshopAddress, tenant, workshop],
  )
  await admin(
    `INSERT INTO "Location" (id, "tenantId", "companyId", "siteId", code, name, kind, "partyId", status, "createdAt", "updatedAt")
     VALUES ($1, $2, $3, $4, 'A1-TERZ-W9', 'Seed workshop W9 (our stock there)', 'SUBCONTRACTOR', $5, 'ACTIVE', now(), now())`,
    [workshopPlace, tenant, companyA, siteA1, workshop],
  )
  const seedTenant: TestTenant = { id: tenant, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const buyerUser = await addUser(h, seedTenant, { email: 'bianca.buyer@seed-a.example.com', role: 'buyer' })
  buyer = new Browser(h.app)
  expect((await buyer.signIn(NS, buyerUser.email, buyerUser.password)).status).toBe(200)
  await enrolTotp(h, buyer)
  walls = await buildApp(
    { environment: 'test', trustProxyHops: 0, cookieSecret: LOCAL_COOKIE_SECRET },
    { database: h.database, routesRoot: fileURLToPath(new URL('../../..', import.meta.url)), authenticate: testAuthenticator((request) => SESSIONS[String(request.headers['x-test-session'])]?.() ?? null) },
  )
}, 180_000)

afterAll(async () => {
  await walls?.close()
  await h?.close()
}, 60_000)

describe('a delivery schedule per line (SCM-052) and the confirmed days kept apart (SCM-088)', () => {
  let orderId = ''
  let lineId = ''

  it('splits a draft line into deliveries by day; the line takes the first day; the sum must be the line', async () => {
    const order = await draft([{ itemId: leather, colourId: leatherBLK, quantity: '100', uom: 'FT2', days: 40 }])
    orderId = order.id
    lineId = order.lines[0].id
    const wrong = await as('PUT', `${orderUrl(orderId)}/lines/${lineId}/deliveries`, { version: order.version, deliveries: [{ quantity: '40', needDate: addDays(today(), 30) }, { quantity: '50', needDate: addDays(today(), 45) }] }, 400)
    expect(wrong.error.message).toMatch(/The deliveries add up to 90; line 10 is 100/)
    const set = (await as('PUT', `${orderUrl(orderId)}/lines/${lineId}/deliveries`, { version: order.version, deliveries: [{ quantity: '60', needDate: addDays(today(), 45), note: 'Second half' }, { quantity: '40', needDate: addDays(today(), 30) }] })).depth
    expect(set.lines[0]).toMatchObject({ needDate: addDays(today(), 30), deliveries: [{ seq: 1, quantity: '40.0000', needDate: addDays(today(), 30), confirmedDate: null }, { seq: 2, quantity: '60.0000', needDate: addDays(today(), 45), note: 'Second half' }] })
    const base = set.lines[0].deliveries.reduce((sum: number, delivery: Json) => sum + Number(delivery.baseQuantity), 0)
    expect(base.toFixed(4)).toBe(Number(set.lines[0].baseQuantity).toFixed(4))
    expect(await eventsOf(orderId)).toContain('purchase_order.lines_changed')
    // The line's own quantity and need date come from its deliveries now.
    const record = (await as('GET', orderUrl(orderId))).order
    expect(record.lines[0].needDate).toBe(addDays(today(), 30))
    const edit = await as('PATCH', `${orderUrl(orderId)}/lines/${lineId}`, { version: record.version, quantity: '120' }, 409)
    expect(edit.error.message).toBe('Line 10 is split into 2 deliveries: its quantity, unit and need date are theirs. Change the delivery schedule, or clear it first.')
    expect((await as('GET', `${orderUrl(orderId)}/send-check`)).ready).toBe(true)
  })

  it('the supplier confirms as asked by its link: each delivery is confirmed on its own day', async () => {
    const { order, token } = await send(orderId)
    await confirmAll(token, order.version)
    const after = await depth(orderId)
    expect(after.status).toBe('CONFIRMED')
    expect(after.lines[0]).toMatchObject({ confirmedDate: addDays(today(), 30), deliveries: [{ confirmedDate: addDays(today(), 30), confirmedLaterBy: 0 }, { confirmedDate: addDays(today(), 45) }] })
  })

  it('a delivery re-dated by the supplier: one row, the asked day kept, later than needed by 7 days', async () => {
    let current = await depth(orderId)
    const second = current.lines[0].deliveries[1]
    const noReason = await buyer.send('POST', `${orderUrl(orderId)}/lines/${lineId}/supplier-date`, { version: current.version, deliveryId: second.id, date: addDays(today(), 52), source: 'SUPPLIER' }, { headers: { 'idempotency-key': key() } })
    expect(noReason.status).toBe(400)
    const moved = await as('POST', `${orderUrl(orderId)}/lines/${lineId}/supplier-date`, { version: current.version, deliveryId: second.id, date: addDays(today(), 52), source: 'SUPPLIER', supplierContactName: 'M. Rossi', reason: 'The tannery closes for a week.' })
    expect(moved).toMatchObject({ recorded: 'MOVED', dateChangeIds: [expect.any(String)] })
    current = moved.depth
    expect(current.lines[0].deliveries[1]).toMatchObject({ needDate: addDays(today(), 45), confirmedDate: addDays(today(), 52), confirmedLaterBy: 7 })
    expect(current.lines[0].confirmedDate).toBe(addDays(today(), 30))
    expect(current.dateChanges).toMatchObject([{ lineSeq: 10, deliverySeq: 2, seq: 1, fromDate: addDays(today(), 45), toDate: addDays(today(), 52), source: 'SUPPLIER', supplierContactName: 'M. Rossi', reason: 'The tannery closes for a week.' }])
    expect(current.dateChanges[0].words).toMatch(/Line 10, delivery 2: .* \(later\), by the supplier \(M\. Rossi\)/)
    expect(await eventsOf(orderId)).toContain('purchase_order.date_changed')
  })

  it('the first delivery moved by the buyer: the line follows its earliest delivery, with a row of its own', async () => {
    let current = await depth(orderId)
    const first = current.lines[0].deliveries[0]
    const lineOwn = await as('POST', `${orderUrl(orderId)}/lines/${lineId}/supplier-date`, { version: current.version, date: addDays(today(), 33), source: 'BUYER', reason: 'x' }, 409)
    expect(lineOwn.error.message).toMatch(/split into 2 deliveries: its confirmed day is its earliest delivery's/)
    const moved = await as('POST', `${orderUrl(orderId)}/lines/${lineId}/supplier-date`, { version: current.version, deliveryId: first.id, date: addDays(today(), 33), source: 'BUYER', reason: 'Agreed with the tannery: one truck less.' })
    expect(moved.dateChangeIds).toHaveLength(2)
    current = moved.depth
    expect(current.lines[0]).toMatchObject({ needDate: addDays(today(), 30), confirmedDate: addDays(today(), 33), confirmedLaterBy: 3 })
    expect(current.dateChanges.map((change: Json) => [change.deliverySeq, change.seq, change.toDate])).toEqual([
      [2, 1, addDays(today(), 52)],
      [1, 2, addDays(today(), 33)],
      [null, 3, addDays(today(), 33)],
    ])
    expect(current.dateChanges[2].reason).toBe('Follows its earliest delivery: Agreed with the tannery: one truck less.')
    // The database holds every row; none changes (append-only).
    expect((await admin(`SELECT count(*)::int AS n FROM "PoDateChange" WHERE "purchaseOrderLineId" = $1`, [lineId]))[0]!.n).toBe(3)
  })

  it('a change (revision 2) clears the supplier days of the deliveries; the schedule is sent again', async () => {
    const record = (await as('GET', orderUrl(orderId))).order
    await as('POST', `${orderUrl(orderId)}/change`, { version: record.version, note: 'One more delivery.' })
    const draftAgain = await depth(orderId)
    expect(draftAgain).toMatchObject({ status: 'DRAFT' })
    expect(draftAgain.lines[0].deliveries.map((delivery: Json) => delivery.confirmedDate)).toEqual([null, null])
    const { order } = await send(orderId)
    expect(order).toMatchObject({ status: 'SENT', revision: 2 })
  })

  it('removing a scheduled draft line removes its deliveries', async () => {
    const order = await draft([{ itemId: lining, colourId: liningGRY, quantity: '30', uom: 'M', days: 20 }])
    const set = (await as('PUT', `${orderUrl(order.id)}/lines/${order.lines[0].id}/deliveries`, { version: order.version, deliveries: [{ quantity: '10', needDate: addDays(today(), 20) }, { quantity: '20', needDate: addDays(today(), 27) }] })).depth
    const cleared = (await as('DELETE', `${orderUrl(order.id)}/lines/${order.lines[0].id}/deliveries?version=${set.version}`)).depth
    expect(cleared.lines[0].deliveries).toEqual([])
    const again = (await as('PUT', `${orderUrl(order.id)}/lines/${order.lines[0].id}/deliveries`, { version: cleared.version, deliveries: [{ quantity: '10', needDate: addDays(today(), 20) }, { quantity: '20', needDate: addDays(today(), 27) }] })).depth
    await as('DELETE', `${orderUrl(order.id)}/lines/${order.lines[0].id}?version=${again.version}`)
    expect(await admin(`SELECT id FROM "PurchaseOrderLineDelivery" WHERE "purchaseOrderLineId" = $1`, [order.lines[0].id])).toEqual([])
  })
})

describe('a purchase order in the supplier currency (SCM-065)', () => {
  it('asks the rate before the send, values the order at it, keeps it current, and hides the value without the cost grain', async () => {
    const order = await draft([{ itemId: lining, colourId: liningGRY, quantity: '100', uom: 'M', days: 20 }], { currency: 'USD' })
    let check = await as('GET', `${orderUrl(order.id)}/send-check`)
    expect(check.ready).toBe(false)
    expect(check.checks.map((entry: Json) => entry.code)).toContain('NO_RATE_AT_ORDER')
    // 100 m × 2.50 USD = 250.00 USD; at 1 EUR = 1.0850 USD: 230.41 EUR.
    let set = (await as('PUT', `${orderUrl(order.id)}/rate`, { version: order.version, rateAtOrder: '1.0850' })).depth
    expect(set.currency).toMatchObject({ order: 'USD', company: 'EUR', takesRate: true, rateAtOrder: '1.085', rateWords: '1 EUR = 1.085 USD', companyNetAmount: 23_041 })
    const record = (await as('GET', orderUrl(order.id))).order
    const added = (await as('POST', `${orderUrl(order.id)}/lines`, { version: record.version, itemId: lining, itemColourId: liningGRY, quantity: '100', uom: 'M', needDate: addDays(today(), 25), unitPrice: '2.500000' }, 201)).order
    set = await depth(order.id)
    expect(set.currency.companyNetAmount).toBe(46_083)
    expect((await wall('planner', 'GET', `${orderUrl(order.id)}/depth`)).depth.currency).not.toHaveProperty('companyNetAmount')
    check = await as('GET', `${orderUrl(order.id)}/send-check`)
    expect(check.checks.map((entry: Json) => entry.code)).not.toContain('NO_RATE_AT_ORDER')
    const bad = await as('PUT', `${orderUrl(order.id)}/rate`, { version: added.version, rateAtOrder: '0' }, 400)
    expect(bad.error.message).toBe('A rate is above 0.')
    const { order: sent } = await send(order.id)
    expect(sent.status).toBe('SENT')
    const frozen = await as('PUT', `${orderUrl(order.id)}/rate`, { version: sent.version, rateAtOrder: '1.2' }, 409)
    expect(frozen.error.message).toMatch(/only while it is a draft/)
    expect((await admin(`SELECT "rateAtOrder"::text AS rate, "companyNetAmount" AS value FROM "PurchaseOrder" WHERE id = $1`, [order.id]))[0]).toEqual({ rate: '1.08500000', value: 46_083 })
  })

  it('an order in the company currency takes no rate', async () => {
    const order = await draft([{ itemId: lining, colourId: liningGRY, quantity: '10', uom: 'M', days: 20 }])
    const refused = await as('PUT', `${orderUrl(order.id)}/rate`, { version: order.version, rateAtOrder: '1.1' }, 409)
    expect(refused.error.message).toBe("The order is in EUR, the company's own currency: it takes no rate at order.")
  })
})

describe('ship to a third party, straight to a workshop (SCM-066, SCM-147)', () => {
  it('ships to the workshop at its delivery address and its place; never to the supplier; the receipt lands on the workshop', async () => {
    const order = await draft([{ itemId: lining, colourId: liningGRY, quantity: '20', uom: 'M', days: 15 }])
    const supplier = await as('PUT', `${orderUrl(order.id)}/ship-to`, { version: order.version, partyId: P2 }, 400)
    expect(supplier.error.message).toMatch(/The supplier is who delivers/)
    const set = (await as('PUT', `${orderUrl(order.id)}/ship-to`, { version: order.version, partyId: workshop })).depth
    expect(set.shipTo).toMatchObject({ partyId: workshop, party: { code: 'SEED-W9' }, addressId: workshopAddress, address: { line1: 'Via Esempio 99', usable: true }, locationId: workshopPlace, location: { code: 'A1-TERZ-W9' }, receiptLandsAt: 'WORKSHOP' })
    expect((await as('GET', `${orderUrl(order.id)}/send-check`)).ready).toBe(true)
    const { order: sent, token } = await send(order.id)
    await confirmAll(token, sent.version)
    const confirmed = (await as('GET', orderUrl(order.id))).order
    const receipt = (await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, supplierDdtNumber: 'DDT-W9-1', supplierDdtDate: today(), lines: [{ purchaseOrderLineId: confirmed.lines[0].id, lots: [{ quantity: '20' }] }] }, 201)).receipt
    const moves = await admin<{ location: string }>(`SELECT "toLocationId"::text AS location FROM "StockMove" WHERE "receiptLineId" = ANY($1::uuid[])`, [receipt.lines.map((line: Json) => line.id)])
    expect(moves).toEqual([{ location: workshopPlace }])
  })

  it('the order goes back to its own site with null', async () => {
    const order = await draft([{ itemId: lining, colourId: liningGRY, quantity: '5', uom: 'M', days: 15 }])
    const set = (await as('PUT', `${orderUrl(order.id)}/ship-to`, { version: order.version, partyId: workshop, locationId: null })).depth
    expect(set.shipTo).toMatchObject({ locationId: null, receiptLandsAt: 'OFFICE_PICKS' })
    expect((await as('GET', `${orderUrl(order.id)}/send-check`)).checks.map((check: Json) => [check.code, check.severity])).toContainEqual(['SHIP_TO_NO_WORKSHOP_PLACE', 'WARNING'])
    expect((await as('PUT', `${orderUrl(order.id)}/ship-to`, { version: set.version, partyId: null })).depth.shipTo).toBeNull()
  })
})

describe('delivery tolerances read at receipt (SCM-061)', () => {
  it('a protector rule of exactly as ordered refuses one more; a tenant rule +10 / −5 % counts 23 of 24 received and refuses beyond 10 %', async () => {
    const forbidden = await walls.inject({ method: 'POST', url: '/purchasing/tolerances', headers: { 'x-test-session': 'manageOnly', 'idempotency-key': key() }, payload: { companyId: companyA, supplierId: P2, itemId: protector, itemKind: null, overPct: '0', underPct: '0', whenBeyond: 'BLOCK' } })
    expect(forbidden.statusCode).toBe(403)
    const exact = (await as('POST', '/purchasing/tolerances', { companyId: companyA, supplierId: P2, itemId: protector, itemKind: null, overPct: '0', underPct: '0', whenBeyond: 'BLOCK', note: 'Certified protectors: exactly as ordered.' }, 201)).tolerance
    expect(exact).toMatchObject({ scope: expect.stringContaining('Seed Leather Supplier S.p.A.'), overPct: '0', whenBeyond: 'BLOCK', status: 'ACTIVE', mayChange: true })
    const twice = await as('POST', '/purchasing/tolerances', { companyId: companyA, supplierId: P2, itemId: protector, itemKind: null, overPct: '1', underPct: '1', whenBeyond: 'BLOCK' }, 409)
    expect(twice.error.message).toMatch(/already exists/)

    const order = await draft([{ itemId: protector, quantity: '24', uom: 'PCS', days: 15 }])
    const { order: sent, token } = await send(order.id)
    await confirmAll(token, sent.version)
    const lineId = order.lines[0].id
    expect((await depth(order.id)).lines[0].tolerance).toMatchObject({ overPct: '0', underPct: '0', whenBeyond: 'BLOCK', source: 'RULE', toleranceId: exact.id })
    const over = await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: lineId, lots: [{ quantity: '25' }] }], }, 409)
    expect(over.error.message).toMatch(/Beyond the delivery tolerance \(\+0 %\) the extra is refused: receive at most 24 pz in all/)
    // With the reason W1 asked, still refused: the rule says no.
    await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: lineId, differenceReason: 'One spare', lots: [{ quantity: '25' }] }] }, 409)

    const archived = (await as('POST', `/purchasing/tolerances/${exact.id}/archive`, { version: exact.version })).tolerance
    expect(archived.status).toBe('ARCHIVED')
    const tenantRule = (await as('POST', '/purchasing/tolerances', { companyId: null, supplierId: null, itemId: null, itemKind: null, overPct: '10', underPct: '5', whenBeyond: 'APPROVAL' }, 201)).tolerance
    expect((await depth(order.id)).lines[0].tolerance).toMatchObject({ overPct: '10', underPct: '5', whenBeyond: 'APPROVAL', toleranceId: tenantRule.id })
    // 23 of 24 is 4.2 % under: received (W1 would leave 1 open).
    const within = (await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: order.id, lines: [{ purchaseOrderLineId: lineId, lots: [{ quantity: '23' }] }] }, 201)).receipt
    expect(within.purchaseOrder.status).toBe('RECEIVED')

    const second = await draft([{ itemId: protector, quantity: '10', uom: 'PCS', days: 15 }])
    const { order: sent2, token: token2 } = await send(second.id)
    await confirmAll(token2, sent2.version)
    // B-W2b-377: beyond a tolerance that needs a yes, the receipt waits OPEN for its RECEIPT_OVER_TOLERANCE request (202);
    // cancelled here, the goods are received within the tolerance.
    const beyond = await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: second.id, lines: [{ purchaseOrderLineId: second.lines[0].id, differenceReason: 'Spares', lots: [{ quantity: '12' }] }] }, 202)
    expect(beyond).toMatchObject({ receipt: { status: 'OPEN' }, moves: [], held: [{ taskId: expect.any(String) }] })
    expect((await wall('manager', 'POST', `/inventory/receipts/${beyond.receipt.id}/cancel`, { reason: 'Received within the tolerance instead.' })).receipt.status).toBe('CANCELLED')
    const upTo = (await wall('manager', 'POST', '/inventory/receipts', { purchaseOrderId: second.id, lines: [{ purchaseOrderLineId: second.lines[0].id, differenceReason: 'One spare', lots: [{ quantity: '11' }] }] }, 201)).receipt
    expect(upTo.purchaseOrder.status).toBe('RECEIVED')

    const changed = (await as('PATCH', `/purchasing/tolerances/${tenantRule.id}`, { version: tenantRule.version, overPct: '5' })).tolerance
    expect(changed).toMatchObject({ overPct: '5', underPct: '5', version: tenantRule.version + 1 })
    expect((await as('GET', '/purchasing/tolerances?status=ACTIVE')).tolerances.map((row: Json) => row.id)).toEqual([tenantRule.id])
    // The rule ends here so the other files' receipts stay as W1's.
    await as('POST', `/purchasing/tolerances/${tenantRule.id}/archive`, { version: changed.version })
    expect(await eventsOf(tenantRule.id)).toEqual(['delivery_tolerance.changed', 'delivery_tolerance.changed', 'delivery_tolerance.changed'])
  })
})
