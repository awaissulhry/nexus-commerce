import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Answer, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
// B-CP-021: the alert's fan-out, as the worker runs it.
import type { EventEnvelope } from '@nexus/factory-domain/events/envelope'
import { MESSAGE_TEMPLATES } from '@nexus/factory-domain/notifications/rules'
import { callerFor } from '../../../core/command'
import { fanOut, fanOutEvents } from '../../../platform/notifications/fan-out'
import { systemContext } from '../../../platform/outbox/system'

/**
 * The customer's own price check in its portal (customer page lane B-CP-019; design customer-page 11 §1.2, §3.4; Owner O4;
 * review B2, C3) on the local stack, through the real app, the real office sign-in (the Owner, two-factor) and the real portal
 * sign-in by code, with the ready-made roles (B-CP-011: Sales holds no price grain). The seeds' customer P1 stands for Brand
 * Alpha (its Buyer, Finance, Viewer, Designer and Production people); the portal world's other customer is renamed Brand Beta
 * (its Buyer).
 *
 *   - as Alpha Buyer: the check of its order (No customer price yet, never Equal); its own unit price with a note reads Equal,
 *     source PORTAL, no office person (enteredById null), audited under OrderBrandPrice and announced (ids only)
 *   - review C3: a row the Owner typed from the customer's PO reads "From your PO" — no office note, no name, no file name
 *   - the factory's row is replaced (delete + insert), never only removed; a cent off reads Not equal (ours − the customer's);
 *     its own row changed at its version (409 on a stale one), and taken away
 *   - as Alpha Finance: reads only (mayWrite held in words; the PUT 403)
 *   - money M-CP-2: as Alpha Designer / Production / Viewer: no field (403 in words or by right), a body with a price refused
 *   - brand: as Beta Buyer on Alpha's order: 404 "Order not found.", nothing written
 *   - not on a closed order; 400 by place (currency, not a line of this order, both or none of unit price and line total)
 *   - B-CP-021: a portal change makes ONE alert "Customer's price changed on order {record}" for the Owner; the order's maker
 *     (a Sales worker) and a Production manager get no row; the words and params hold no amount; never a thread line; a change
 *     the office types makes no alert
 *
 * Every name, number and price is made up. Run with `node scripts/factory/run-pg-tests.mjs sales/brand-prices/portal-price-check`.
 */

let h: Harness
let world: PortalWorld
const NS = 'cp019-portal-price-check'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const JKT01 = seedUuid(NS, 'product:style:JKT-01')
const JKT01_BLK = seedUuid(NS, 'product:colourway:JKT-01:BLK')
const JKT02 = seedUuid(NS, 'production:style:JKT-02')
const JKT02_RED = seedUuid(NS, 'production:colourway:JKT-02:RED')
const TENANT: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const TODAY = businessDate(new Date())
const PROMISE = addDays(TODAY, 40)
const OFFICE_NOTE = 'Owner note: PO 4471 says 410 but we agreed 400 on the phone'

type Json = Record<string, any>
type Method = 'GET' | 'PUT' | 'POST'
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
async function force(sql: string, values: unknown[] = []): Promise<void> {
  await admin('SET session_replication_role = replica')
  try {
    await admin(sql, values)
  } finally {
    await admin('SET session_replication_role = DEFAULT')
  }
}
/** Every key of an answer, at any depth. */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])

const EMAILS = {
  buyer: 'bea.buyer@cp019-alpha.example',
  finance: 'fio.finance@cp019-alpha.example',
  viewer: 'vic.viewer@cp019-alpha.example',
  designer: 'dee.designer@cp019-alpha.example',
  production: 'pat.production@cp019-alpha.example',
  beta: 'bob.buyer@cp019-beta.example',
} as const
type Portal = keyof typeof EMAILS
const portal = {} as Record<Portal, Browser>
let owner: Browser

const send = (browser: Browser, method: Method, url: string, body?: unknown): Promise<Answer> => browser.send(method, url, method === 'GET' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await send(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
async function no(browser: Browser, method: Method, url: string, body: unknown, status: number): Promise<Json> {
  const answer = await send(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return (answer.body as Json).error ?? {}
}
const paths = (error: Json): string[] => (error.issues ?? []).map((issue: Json) => String(issue.path))

async function partnerPerson(email: string, partyId: string, roleKeys: readonly string[]): Promise<void> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
}

async function signedIn(email: string): Promise<Browser> {
  const browser = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await browser.post('/portal/signin/start', { tenant: NS, company: 'SCA', email })).status).toBe(200)
  await h.auth.settled()
  const answer = await browser.post('/portal/signin/code', { tenant: NS, company: 'SCA', email, code: mailedCode(h, email)!.code })
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  const terms = await browser.get('/portal/terms?locale=en')
  expect((await browser.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
  return browser
}

async function officePerson(email: string, role: string, twoFactor: boolean): Promise<Browser> {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(NS, user.email, user.password)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  if (twoFactor) await enrolTotp(h, browser)
  return browser
}

const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
/** A manual order of Brand Alpha typed by the Owner: 4 jackets JKT-01 BLK at P1's list (420.00) and 3 JKT-02 RED at the base list (410.00). */
async function alphaOrder(ref: string): Promise<{ id: string; lines: { id: string; seq: number; netAmount: number }[] }> {
  const body = {
    companyId: companyA,
    partyId: P1,
    customerRef: ref,
    promiseDate: PROMISE,
    lines: [
      { styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 2]]) },
      { styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 3]]) },
    ],
  }
  const order = (await ok(owner, 'POST', '/sales/orders/manual', body, 201)).order
  return { id: order.id, lines: await admin<{ id: string; seq: number; netAmount: number }>(`SELECT id, seq, "netAmount" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [order.id]) }
}

const rowsOf = (orderId: string) =>
  admin<Json>(`SELECT id, "salesOrderLineId" AS "lineId", "unitPrice"::text AS "unitPrice", "netAmount", source::text AS source, note, "enteredById", version FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY "salesOrderLineId" NULLS LAST, id`, [orderId])
const audits = (orderId: string) => admin<Json>(`SELECT id, action, before, after FROM "AuditLog" WHERE "tenantId" = $1 AND "recordType" = 'OrderBrandPrice' AND "recordId" = $2 ORDER BY at, id`, [T, orderId])
const announced = (orderId: string) => admin<Json>(`SELECT id, type, payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'sales_order.brand_price_changed' AND subject = $2 ORDER BY "occurredAt", id`, [T, orderId])
/** B-CP-019 (fix wave cp-fx8): the rows a step wrote, by id — never by time order: the portal writes on the harness clock (set a little
 *  behind the system clock in beforeAll), the office on the system clock, so the office's earlier row can sort after the portal's.
 *  Production has one clock. */
const writtenSince = (before: readonly Json[], now: readonly Json[]): Json[] => now.filter((row) => !before.some((old) => old.id === row.id))

beforeAll(async () => {
  h = await startHarness('cp019_portal_check') // B-CP-022: test-database labels are at most 20 characters
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  await seedPricing({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-cp019', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, TENANT)
  await admin(`UPDATE "Party" SET "legalName" = 'Brand Beta S.p.A.', "tradeName" = 'Brand Beta', version = version + 1 WHERE id = $1`, [world.partyId])
  freshGuard(h)
  await admin(`UPDATE "Style" SET status = 'ACTIVE', version = version + 1 WHERE id = $1`, [JKT01])
  owner = await officePerson('olga.owner@cp019.example', 'owner', true)
  await partnerPerson(EMAILS.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  await partnerPerson(EMAILS.finance, P1, ['customer-finance'])
  await partnerPerson(EMAILS.viewer, P1, ['customer-viewer'])
  await partnerPerson(EMAILS.designer, P1, ['customer-designer'])
  await partnerPerson(EMAILS.production, P1, ['customer-production'])
  await partnerPerson(EMAILS.beta, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(EMAILS) as Portal[]) portal[key] = await signedIn(EMAILS[key])
  h.clock.set(new Date(Date.now() - 2_000))
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

describe('B-CP-019 the customer’s own price check in its portal', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  let order: { id: string; lines: { id: string; seq: number; netAmount: number }[] }
  let officeRow: Json

  beforeAll(async () => {
    order = await alphaOrder('PO-CP019-1')
    // The Owner types the customer's price of line 20 from its PO, with an office note (never shown to the customer).
    const check = await ok(owner, 'PUT', `/sales/orders/${order.id}/brand-prices`, { currency: 'EUR', rows: [{ lineId: order.lines[1]!.id, unitPrice: '410', source: 'CUSTOMER_PO', note: OFFICE_NOTE }] })
    officeRow = check.lines[1].row
    expect(officeRow).toMatchObject({ source: 'CUSTOMER_PO', note: OFFICE_NOTE, enteredBy: { name: expect.any(String) }, version: 1 })
  })

  it('as Alpha Buyer: reads its order’s check — no customer price yet on line 10 (never Equal), our prices beside', async () => {
    const check = await ok(portal.buyer, 'GET', `/portal/sales-orders/${order.id}/price-check`)
    expect(check).toMatchObject({ orderId: order.id, currency: 'EUR', mayWrite: { allowed: true, why: null } })
    expect(check.lines.map((line: Json) => [line.seq, line.pieces, line.ourAmount, line.priceMatch])).toEqual([
      [10, 4, order.lines[0]!.netAmount, 'NO_BRAND_PRICE'],
      [20, 3, order.lines[1]!.netAmount, 'EQUAL'],
    ])
    expect(check.lines[0].row).toBeNull()
    expect(check.total).toMatchObject({ ourPrice: order.lines[0]!.netAmount + order.lines[1]!.netAmount, brandPrice: null, priceMatch: 'NO_BRAND_PRICE', priceMissingLines: 1, row: null })
  })

  it('review C3: the row the Owner typed reads "From your PO" — no office note, no name, no file, no office number', async () => {
    const check = await ok(portal.buyer, 'GET', `/portal/sales-orders/${order.id}/price-check`)
    expect(check.lines[1].row).toEqual({ id: officeRow.id, unitPrice: '410', netAmount: null, currency: 'EUR', source: 'CUSTOMER_PO', sourceWords: { it: "Dal vostro ordine d'acquisto", en: 'From your PO' }, note: null, enteredAt: expect.any(String), version: 1 })
    const keys = keysOf(check)
    for (const key of ['enteredBy', 'enteredById', 'sourceFile', 'sourceFileId', 'number', 'fromRequest']) expect(keys, key).not.toContain(key)
    const office = await one<{ number: string; name: string }>(`SELECT o.number, u."displayName" AS name FROM "SalesOrder" o, "User" u WHERE o.id = $1 AND u.email = 'olga.owner@cp019.example'`, [order.id])
    const text = JSON.stringify(check)
    expect(text).not.toContain(OFFICE_NOTE)
    expect(text).not.toContain(office.number)
    expect(text).not.toContain(office.name)
  })

  it('as Alpha Buyer: its own unit price with a note reads Equal — source PORTAL, no office person, audited and announced', async () => {
    const auditsBefore = await audits(order.id)
    const eventsBefore = await announced(order.id)
    const check = await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { currency: 'EUR', rows: [{ lineId: order.lines[0]!.id, unitPrice: '420', note: 'Our PO 88, page 1' }] })
    expect(check.lines[0]).toMatchObject({ brandAmount: order.lines[0]!.netAmount, priceMatch: 'EQUAL', priceDiff: 0 })
    expect(check.lines[0].row).toMatchObject({ unitPrice: '420', source: 'PORTAL', sourceWords: { en: 'Typed by you', it: 'Inserito da voi' }, note: 'Our PO 88, page 1', version: 1 })
    expect(check.total).toMatchObject({ priceMatch: 'EQUAL', priceDiff: 0, priceMissingLines: 0 })
    const stored = (await rowsOf(order.id)).find((row) => row.lineId === order.lines[0]!.id)!
    expect(stored).toMatchObject({ unitPrice: '420.000000', source: 'PORTAL', note: 'Our PO 88, page 1', enteredById: null, version: 1 })
    const written = writtenSince(auditsBefore, await audits(order.id))
    expect(written.map((row) => row.action)).toEqual(['brandPrices.portalSet'])
    expect(written[0]!.after).toMatchObject({ rowId: stored.id, source: 'PORTAL', enteredById: null, unitPrice: { $money: 'price', value: '420' }, note: { $money: 'price', value: 'Our PO 88, page 1' } })
    const events = writtenSince(eventsBefore, await announced(order.id))
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['orderId', 'partyId'])
    // The same body again changes nothing (no audit, no event).
    await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '420', note: 'Our PO 88, page 1', version: 1 }] })
    expect((await audits(order.id)).length).toBe(auditsBefore.length + 1)
    expect((await announced(order.id)).length).toBe(eventsBefore.length + 1)
  })

  it('the factory’s row is replaced (delete + insert), never only taken away; a cent off reads Not equal', async () => {
    const refused = await no(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { remove: [{ id: officeRow.id, version: 1 }] }, 400)
    expect(refused.issues).toEqual([{ path: 'body/remove/0/id', message: 'The factory typed this price: give your own for the line instead.' }])
    const ours = order.lines[1]!.netAmount
    const check = await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[1]!.id, netAmount: ours - 1, version: 1 }] })
    expect(check.lines[1]).toMatchObject({ brandAmount: ours - 1, priceMatch: 'NOT_EQUAL', priceDiff: 1 })
    expect(check.lines[1].row).toMatchObject({ unitPrice: null, netAmount: ours - 1, source: 'PORTAL', note: null, version: 1 })
    expect(check.lines[1].row.id).not.toBe(officeRow.id)
    expect(check.total).toMatchObject({ priceMatch: 'NOT_EQUAL', priceDiff: 1, priceNotEqualLines: 1 })
    const stored = await rowsOf(order.id)
    expect(stored.some((row) => row.id === officeRow.id)).toBe(false)
    expect(stored.find((row) => row.lineId === order.lines[1]!.id)).toMatchObject({ source: 'PORTAL', enteredById: null })
    const replaced = (await audits(order.id)).filter((row) => row.action === 'brandPrices.portalReplace')
    expect(replaced).toHaveLength(1)
    expect(replaced[0]!.before).toMatchObject({ rowId: officeRow.id, source: 'CUSTOMER_PO' })
    // The Owner reads the customer's price as the customer's own (no office person on it).
    const office = await ok(owner, 'GET', `/sales/orders/${order.id}/price-check`)
    expect(office.lines[1].row).toMatchObject({ source: 'PORTAL', enteredBy: null, netAmount: ours - 1 })
  })

  it('its own row changes at the version read (409 on a stale one) and is taken away', async () => {
    const before = await ok(portal.buyer, 'GET', `/portal/sales-orders/${order.id}/price-check`)
    const row = before.lines[0].row
    const stale = await no(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '419', version: row.version + 4 }] }, 409)
    expect(paths(stale)).toEqual(['body/rows/0/version'])
    const typedMeanwhile = await no(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '419' }] }, 409)
    expect(paths(typedMeanwhile)).toEqual(['body/rows/0/version'])
    const changed = await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '419', note: 'Our PO 88, page 1 (corrected)', version: row.version }] })
    expect(changed.lines[0]).toMatchObject({ priceMatch: 'NOT_EQUAL', row: { unitPrice: '419', note: 'Our PO 88, page 1 (corrected)', version: row.version + 1 } })
    const gone = await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { remove: [{ id: row.id, version: row.version + 1 }] })
    expect(gone.lines[0]).toMatchObject({ priceMatch: 'NO_BRAND_PRICE', row: null })
    expect((await audits(order.id)).map((entry) => entry.action)).toEqual(expect.arrayContaining(['brandPrices.portalChange', 'brandPrices.portalRemove']))
  })

  it('400 by place: the currency, not a line of this order, both or none of unit price and line total, a line named twice', async () => {
    const url = `/portal/sales-orders/${order.id}/brand-prices`
    const line = order.lines[0]!.id
    expect(paths(await no(portal.buyer, 'PUT', url, { currency: 'USD', rows: [] }, 400))).toEqual(['body/currency'])
    expect(paths(await no(portal.buyer, 'PUT', url, { rows: [{ lineId: newId(), unitPrice: '1' }] }, 400))).toEqual(['body/rows/0/lineId'])
    expect(paths(await no(portal.buyer, 'PUT', url, { rows: [{ lineId: line, unitPrice: '1', netAmount: 100 }] }, 400))).toEqual(['body/rows/0/unitPrice'])
    expect(paths(await no(portal.buyer, 'PUT', url, { rows: [{ lineId: line }] }, 400))).toEqual(['body/rows/0/unitPrice'])
    expect(paths(await no(portal.buyer, 'PUT', url, { rows: [{ lineId: line, unitPrice: '1' }, { lineId: line, unitPrice: '2' }] }, 400))).toEqual(['body/rows/1/lineId'])
    // The order's total row is the factory's: the body has no place for one (a line is always named).
    expect((await send(portal.buyer, 'PUT', url, { rows: [{ lineId: null, netAmount: 100 }] })).status).toBe(400)
  })

  it('as Alpha Finance: reads only — mayWrite held in words, the PUT refused', async () => {
    const check = await ok(portal.finance, 'GET', `/portal/sales-orders/${order.id}/price-check`)
    expect(check.mayWrite).toEqual({ allowed: false, why: { it: 'Il vostro prezzo lo indica un collega che ordina per voi (un Buyer o il vostro Admin).', en: 'Your price is given by a colleague who orders for you (a Buyer or your Admin).' } })
    expect(check.lines).toHaveLength(2)
    const before = await rowsOf(order.id)
    await no(portal.finance, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '1' }] }, 403)
    expect(await rowsOf(order.id)).toEqual(before)
  })

  it('money M-CP-2: as Alpha Designer / Production / Viewer — no field, a body with a price refused, nothing written', async () => {
    const before = await rowsOf(order.id)
    for (const who of ['designer', 'production', 'viewer'] as const) {
      const read = await send(portal[who], 'GET', `/portal/sales-orders/${order.id}/price-check`)
      expect(read.status, `${who}: ${JSON.stringify(read.body)}`).toBe(403)
      expect(keysOf(read.body).filter((key) => /price|amount|match|diff/i.test(key)), who).toEqual([])
      const write = await send(portal[who], 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '1' }] })
      expect(write.status, `${who}: ${JSON.stringify(write.body)}`).toBe(403)
    }
    // A role that reaches the order but not its prices reads the words of the portal catalogue (portal-orders.json prices.none).
    expect((await no(portal.viewer, 'GET', `/portal/sales-orders/${order.id}/price-check`, undefined, 403)).message).toBe('Prices are not part of your access.')
    expect(await rowsOf(order.id)).toEqual(before)
  })

  it('brand: as Beta Buyer on Alpha’s order — 404 "Order not found.", the same as an unknown id; nothing written', async () => {
    const before = await rowsOf(order.id)
    for (const id of [order.id, newId()]) {
      expect((await no(portal.beta, 'GET', `/portal/sales-orders/${id}/price-check`, undefined, 404)).message).toBe('Order not found.')
      expect((await no(portal.beta, 'PUT', `/portal/sales-orders/${id}/brand-prices`, { rows: [{ lineId: order.lines[0]!.id, unitPrice: '1' }] }, 404)).message).toBe('Order not found.')
    }
    expect(await rowsOf(order.id)).toEqual(before)
  })

  it('not on a closed order: the check reads, mayWrite is held in words, the PUT is refused', async () => {
    const closed = await alphaOrder('PO-CP019-CLOSED')
    await force(`UPDATE "SalesOrder" SET status = 'CLOSED', "closedAt" = now(), version = version + 1 WHERE id = $1`, [closed.id])
    const check = await ok(portal.buyer, 'GET', `/portal/sales-orders/${closed.id}/price-check`)
    expect(check.mayWrite).toEqual({ allowed: false, why: { it: 'Un ordine chiuso o annullato non cambia più i prezzi.', en: 'A closed or cancelled order keeps its prices.' } })
    expect(paths(await no(portal.buyer, 'PUT', `/portal/sales-orders/${closed.id}/brand-prices`, { rows: [{ lineId: closed.lines[0]!.id, unitPrice: '420' }] }, 400))).toEqual(['body'])
    expect(await rowsOf(closed.id)).toEqual([])
  })
})

// ── B-CP-021 ──
describe('B-CP-021 one alert when the customer changes its price in the portal — price holders of the order only', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const KEY = 'notifications.priceCheck.customerChanged'
  let sales: Browser
  let order: { id: string; number: string; lineId: string }
  const ids = {} as Record<'owner' | 'sales' | 'production', string>
  const idOf = async (email: string) => (await one<{ id: string }>(`SELECT id FROM "User" WHERE "tenantId" = $1 AND email = $2`, [T, email])).id
  const customerEvents = (orderId: string) =>
    admin<Json>(`SELECT id, type, version, "companyId", "siteId", subject, payload, "occurredAt" FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'sales_order.brand_price_changed_by_customer' AND subject = $2 ORDER BY "occurredAt", id`, [T, orderId])
  /** The worker's fan-out of one outbox row, as the system of the tenant. */
  async function fanOutRow(row: Json): Promise<void> {
    const envelope = { eventId: row.id, type: row.type, version: row.version, context: 'brand-prices', tenantId: T, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: newId(), causationId: null, source: 'portalBrandPrices.save', occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload } as EventEnvelope
    await fanOut(callerFor(h.database, systemContext(T, newId())), envelope)
  }
  const told = (eventId: string) => admin<Json>(`SELECT "userId", category::text AS category, "messageKey", params, "recordType", "recordId", "recordLabel" FROM "Notification" WHERE "tenantId" = $1 AND "eventId" = $2 ORDER BY "userId"`, [T, eventId])
  const threadLines = (orderId: string) => one<{ count: number }>(`SELECT count(*)::int AS count FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'SalesOrder' AND t."recordId" = $1`, [orderId])

  beforeAll(async () => {
    sales = await officePerson('sam.sales@cp019.example', 'sales', true)
    await officePerson('pia.production@cp019.example', 'production_manager', false)
    ids.owner = await idOf('olga.owner@cp019.example')
    ids.sales = await idOf('sam.sales@cp019.example')
    ids.production = await idOf('pia.production@cp019.example')
    // The Sales worker makes the order (its maker) without a price key: P1's list prices it.
    const made = (await ok(sales, 'POST', '/sales/orders/manual', { companyId: companyA, partyId: P1, customerRef: 'PO-CP021-1', promiseDate: PROMISE, lines: [{ styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2]]) }] }, 201)).order
    const row = await one<{ number: string; createdById: string; lineId: string }>(`SELECT o.number, o."createdById", l.id AS "lineId" FROM "SalesOrder" o JOIN "SalesOrderLine" l ON l."orderId" = o.id WHERE o.id = $1`, [made.id])
    expect(row.createdById).toBe(ids.sales)
    order = { id: made.id, number: row.number, lineId: row.lineId }
    h.clock.set(new Date(Date.now() - 2_000))
  })

  it('the fan-out handles the event; the office’s own change of the customer’s price makes no alert', async () => {
    expect(fanOutEvents()).toContain('sales_order.brand_price_changed_by_customer')
    await ok(owner, 'PUT', `/sales/orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lineId, unitPrice: '420', source: 'OFFICE' }] })
    expect(await customerEvents(order.id)).toEqual([])
  })

  it('a portal change: ONE alert for the Owner; the order’s maker (Sales) and a Production manager get no row; no amount; no thread line', async () => {
    const lines = (await threadLines(order.id)).count
    const before = await ok(portal.buyer, 'GET', `/portal/sales-orders/${order.id}/price-check`)
    await ok(portal.buyer, 'PUT', `/portal/sales-orders/${order.id}/brand-prices`, { rows: [{ lineId: order.lineId, unitPrice: '399', version: before.lines[0].row.version }] })
    const events = await customerEvents(order.id)
    expect(events).toHaveLength(1)
    expect(Object.keys(events[0]!.payload).sort()).toEqual(['orderId', 'partyId'])
    await fanOutRow(events[0]!)
    const rows = await told(events[0]!.id)
    expect(rows).toEqual([{ userId: ids.owner, category: 'ALERT', messageKey: KEY, params: { orderId: order.id }, recordType: 'SalesOrder', recordId: order.id, recordLabel: order.number }])
    expect(rows.map((row) => row.userId)).not.toContain(ids.sales)
    expect(rows.map((row) => row.userId)).not.toContain(ids.production)
    // The words hold no amount and no "not equal"; the params name the order only.
    for (const words of Object.values(MESSAGE_TEMPLATES[KEY])) {
      expect(words).not.toMatch(/\{figure\}|\{count\}|≠|\d/)
      expect(words).toContain('{record}')
    }
    expect(JSON.stringify(rows)).not.toMatch(/399|420/)
    // Never a thread line.
    expect((await threadLines(order.id)).count).toBe(lines)
    // A replayed event makes no second alert.
    await fanOutRow(events[0]!)
    expect(await told(events[0]!.id)).toHaveLength(1)
  })

  it('the order’s maker WITH the price grain is told too: the Owner made this one (one row, not two)', async () => {
    const made = await alphaOrder('PO-CP021-2')
    await ok(portal.buyer, 'PUT', `/portal/sales-orders/${made.id}/brand-prices`, { rows: [{ lineId: made.lines[0]!.id, unitPrice: '420' }] })
    const events = await customerEvents(made.id)
    expect(events).toHaveLength(1)
    await fanOutRow(events[0]!)
    expect((await told(events[0]!.id)).map((row) => row.userId)).toEqual([ids.owner])
  })
})
// ── end B-CP-021 ──
