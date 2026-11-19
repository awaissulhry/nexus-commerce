import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { PPE_WORDS } from '@nexus/factory-domain/sales/portal-ordering/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { textOf } from '../../../adapters/ses/fake'
import { partyView } from '@nexus/factory-domain/parties/contracts'
import { systemContext } from '../../../platform/outbox/system'
import { partnerFanOut } from '../../../platform/portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../../../platform/portal/notifications/mail'
import { getParty } from '../../parties/parties'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
// B-CP-076: an office person of the ready-made roles through the app (the grain filter: M-CP-1).
import { addUser, Browser as OfficeBrowser, enrolTotp } from '../../../platform/auth/sessions/testing/harness'
import { readPriceCheck, takeOverBrandPrices } from '../brand-prices/prices' // B-CP-076: the take-over by the line map
import { processImporters } from '../../../platform/imports/registry'
import { SOURCES } from '../../insights/sources'
import { acceptRequest, listOfficeRequests, officeRequestView, refuseRequest } from './office'
import { approveAddress, listAddressChecks, refuseAddress } from './address-check'
import { previewManualOrder } from '../orders/manual'

/**
 * Portal ordering on the local stack (B-W2b-190; SAL-071, SAL-072, SAL-073, SAL-074, SAL-079), through the real app and
 * the real portal sign-in by code: the factory-db seeds up to pricing (the brand SEED-C1 = P1 with its own label
 * SEED-JKT-01 on its list SEED-PL-P1, SEED-JKT-02 on the base list, SEED-JKT-03 priced by no list; its orders
 * SEED-SO-0001/0002/0003), its portal and another customer's switched on; P1's buyer, viewer and admin, the other
 * customer's buyer. The office decides through the module's functions with an office caller. Every name, number and
 * price is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-ordering`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'portal-ordering-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const TODAY = businessDate(new Date())

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const styleId = (code: string) => one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, code]).then((row) => row.id)
const colourwayId = (style: string, code: string) => one<{ id: string }>('SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = $3', [T, style, code]).then((row) => row.id)
const orderId = (number: string) => one<{ id: string }>('SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND number = $2', [T, number]).then((row) => row.id)

const people = { buyer: 'bea.buyer@seed-racing.example', viewer: 'val.viewer@seed-racing.example', admin: 'ada.admin@seed-racing.example', other: 'olga.buyer@brand-alpha.example', /* B-CP-070 */ designer: 'dina.designer@seed-racing.example' }
const browsers = {} as Record<keyof typeof people, Browser>
const userIds = {} as Record<keyof typeof people, string>

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [partyId], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
  return id
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

const call = (browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' || method === 'DELETE' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

const officeId = newId()
const office = () =>
  callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions: ['orders.view', 'orders.manage', 'quotes.view', 'quotes.manage', 'money.price'], companies: 'all', sites: 'all', parties: 'all' }] })
const b64 = (text: string) => Buffer.from(text, 'utf8').toString('base64')

let jkt01: string, jkt02: string, jkt03: string, blk01: string, red02: string, blk02: string

beforeAll(async () => {
  h = await startHarness('portal_ordering')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedPricing({ db: h.database, namespace: NS })
  tenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  userIds.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve'])
  userIds.viewer = await partnerPerson(people.viewer, P1, ['customer-viewer'])
  userIds.admin = await partnerPerson(people.admin, P1, ['customer-admin'])
  userIds.other = await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  userIds.designer = await partnerPerson(people.designer, P1, ['customer-designer', 'partner-comment', 'partner-upload']) // B-CP-070
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  // The sign-ins moved the harness clock ahead of the real one; the office's commands (callerFor) run on the real clock: bring
  // the harness back just behind it, so a decision is never before the send (the database checks decidedAt >= sentAt).
  h.clock.set(new Date(Date.now() - 2_000))
  jkt01 = await styleId('SEED-JKT-01')
  jkt02 = await styleId('SEED-JKT-02')
  jkt03 = await styleId('SEED-JKT-03')
  blk01 = await colourwayId(jkt01, 'BLK')
  blk02 = await colourwayId(jkt02, 'BLK')
  red02 = await colourwayId(jkt02, 'RED')
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('the catalogue (SAL-071)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('offers the customer its own label priced by its list chain, never a draft style, with prices only for the buyer', async () => {
    const first = await ok(browsers.buyer, 'GET', '/portal/catalogue')
    // SEED-JKT-01 is still a DRAFT style: not sold. SEED-JKT-02 (P1's own label) is priced by the base list P1's list falls back to.
    expect(first.styles.map((style: Json) => style.code)).toEqual(['SEED-JKT-02'])
    expect(first.styles[0]).toMatchObject({ ownLabel: true, priceFrom: '410.00', range: '50–54' })
    // B-W2b-F17: the PPE category in words from the stored code (it was the raw code), for every code the database stores.
    expect(first.styles[0].ppe).toMatchObject({ category: 'CATEGORY_II', words: { it: 'DPI categoria II', en: 'PPE category II' } })
    const [stored] = await admin<{ codes: string }>(`SELECT enum_range(NULL::"PpeCategory")::text AS codes`)
    expect(stored!.codes.replace(/[{}]/g, '').split(',').filter((code) => !Object.hasOwn(PPE_WORDS, code))).toEqual([])
    // The office makes SEED-JKT-01 active: it is sold at P1's own list price (its red at its own price).
    await admin(`UPDATE "Style" SET status = 'ACTIVE', version = version + 1 WHERE id = $1`, [jkt01])
    const list = await ok(browsers.buyer, 'GET', '/portal/catalogue')
    const codes = list.styles.map((style: Json) => style.code)
    expect(codes).toContain('SEED-JKT-01')
    expect(codes).not.toContain('SEED-JKT-03')
    const own = list.styles.find((style: Json) => style.code === 'SEED-JKT-01')
    expect(own).toMatchObject({ ownLabel: true, priceFrom: '420.00' })
    expect(own.colours.map((colour: Json) => colour.code)).toEqual(expect.arrayContaining(['BLK', 'RED']))
    expect(list.seesPrices).toBe(true)
    const detail = await ok(browsers.buyer, 'GET', `/portal/catalogue/${jkt01}`)
    expect(detail.style.colourways.find((colourway: Json) => colourway.code === 'RED').price).toBe('430.00')
    // B-W2b-278 (FU4:04): the style's page says its PPE category in words looked up by the style's own code, never the code.
    expect(detail.style.ppe.words).toEqual(PPE_WORDS[detail.style.ppe.category as keyof typeof PPE_WORDS])
    expect(detail.style.ppe.words.en).not.toBe(detail.style.ppe.category)
    expect((await call(browsers.buyer, 'GET', `/portal/catalogue/${jkt03}`)).status).toBe(404)
    // The viewer: the same styles, no price field at all.
    const seen = await ok(browsers.viewer, 'GET', '/portal/catalogue')
    expect(seen.seesPrices).toBe(false)
    expect(seen.styles.find((style: Json) => style.code === 'SEED-JKT-01')).not.toHaveProperty('priceFrom')
    // Another customer never sees P1's own label (the base list prices it, the brand is P1).
    const other = await ok(browsers.other, 'GET', '/portal/catalogue')
    expect(other.styles.map((style: Json) => style.code)).not.toContain('SEED-JKT-01')
    expect((await call(browsers.other, 'GET', `/portal/catalogue/${jkt01}`)).status).toBe(404)
  })

  // B-W2b-227 (PRD-019, PRD-010): the style's names per language on the card and in the search; another customer finds the
  // brand's own style by none of them.
  it("shows the style's names per language and finds it by any of them, for its brand only", async () => {
    await admin(`INSERT INTO "StyleText" (id, "tenantId", "styleId", language, name, "longDescription") VALUES ($1, $2, $3, 'en', 'Seed racing jacket', 'Made-up long words'), ($4, $2, $3, 'de', 'Saat-Rennjacke', NULL)`, [newId(), T, jkt01, newId()])
    const card = (await ok(browsers.buyer, 'GET', '/portal/catalogue')).styles.find((style: Json) => style.code === 'SEED-JKT-01')
    expect(card.nameI18n.en).toBe('Seed racing jacket')
    expect((await ok(browsers.buyer, 'GET', '/portal/catalogue?q=rennjacke')).styles.map((style: Json) => style.code)).toEqual(['SEED-JKT-01'])
    expect((await ok(browsers.buyer, 'GET', `/portal/catalogue/${jkt01}`)).style.description).toBe('Made-up long words')
    expect((await ok(browsers.other, 'GET', '/portal/catalogue?q=rennjacke')).styles).toEqual([])
  })
})

let requestA: Json

describe('a draft and its send (SAL-074)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('keeps a draft with its lines at the price shown, and refuses what the catalogue does not offer', async () => {
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'PICKER', customerRef: 'PO-T-0001' }, 201)
    requestA = made.request
    expect(requestA).toMatchObject({ status: 'DRAFT', number: null, customerRef: 'PO-T-0001', problems: [expect.objectContaining({ code: 'NO_LINES' })] })
    const url = `/portal/order-requests/${requestA.id}`
    const added = await ok(browsers.buyer, 'POST', `${url}/lines`, { version: requestA.version, lines: [{ styleId: jkt01, colourwayId: blk01, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 3 }] }] })
    expect(added.request.lines[0]).toMatchObject({ unitPriceShown: '420.00', priceNow: '420.00', amount: '2100.00', pieces: 5 })
    expect(added.request.summary).toEqual({ lines: 1, pieces: 5, net: '2100.00' })
    expect(added.request.problems).toEqual([])
    // Refused: a size not offered, a style not in the catalogue, the same style and colour twice, a past date.
    const v = added.request.version
    expect((await call(browsers.buyer, 'POST', `${url}/lines`, { version: v, lines: [{ styleId: jkt01, colourwayId: blk01, sizes: [{ size: '62', quantity: 1 }] }] })).status).toBe(400)
    expect((await call(browsers.buyer, 'POST', `${url}/lines`, { version: v, lines: [{ styleId: jkt03, colourwayId: blk01, sizes: [{ size: '50', quantity: 1 }] }] })).status).toBe(400)
    expect((await call(browsers.buyer, 'POST', `${url}/lines`, { version: v, lines: [{ styleId: jkt01, colourwayId: blk01, sizes: [{ size: '54', quantity: 1 }] }] })).status).toBe(400)
    expect((await call(browsers.buyer, 'PATCH', url, { version: v, requestedDate: addDays(TODAY, -1) })).status).toBe(400)
    // A stale version is a conflict.
    expect((await call(browsers.buyer, 'PATCH', url, { version: v - 1, note: 'late' })).status).toBe(409)
    const header = await ok(browsers.buyer, 'PATCH', url, { version: v, requestedDate: addDays(TODAY, 30), note: 'Spring restock' })
    const line = header.request.lines[0]
    const changed = await ok(browsers.buyer, 'PUT', `${url}/lines/${line.id}`, { version: header.request.version, sizes: [{ size: '50', quantity: 4 }, { size: '52', quantity: 3 }] })
    expect(changed.request.summary).toEqual({ lines: 1, pieces: 7, net: '2940.00' })
    requestA = changed.request
    // The viewer and the other customer cannot reach it.
    expect((await call(browsers.viewer, 'GET', url)).status).toBe(403)
    expect((await call(browsers.other, 'GET', url)).status).toBe(404)
  })

  it('holds the send while a price changed since it was shown, until the customer takes today\'s price', async () => {
    const url = `/portal/order-requests/${requestA.id}`
    await admin('UPDATE "PortalOrderRequestLine" SET "unitPriceShown" = 400 WHERE "requestId" = $1', [requestA.id])
    const read = await ok(browsers.buyer, 'GET', url)
    expect(read.request.pricesChanged).toBe(1)
    expect(read.request.problems).toEqual([expect.objectContaining({ code: 'PRICE_CHANGED', words: expect.objectContaining({ en: 'Price now 420.00 (was 400.00).' }) })])
    expect(read.request.held).toEqual({ it: '1 problema da risolvere', en: '1 problem to fix' })
    const refused = await call(browsers.buyer, 'POST', `${url}/send`, { version: read.request.version })
    expect(refused.status, JSON.stringify(refused.body)).toBe(409)
    const taken = await ok(browsers.buyer, 'POST', `${url}/prices`, { version: read.request.version })
    expect(taken.request.problems).toEqual([])
    requestA = taken.request
  })

  it('sends it as a numbered request in the office scope, then freezes it; it waits in Home › Approvals', async () => {
    const url = `/portal/order-requests/${requestA.id}`
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version: requestA.version })
    expect(sent.request).toMatchObject({ status: 'SENT', number: expect.stringMatching(/^RQ-\d{4}$/) })
    expect(sent.sent.words.en).toContain(`your PO PO-T-0001, our request ${sent.request.number}`)
    const row = await one('SELECT "sentById", status FROM "PortalOrderRequest" WHERE id = $1', [requestA.id])
    expect(row).toEqual({ sentById: userIds.buyer, status: 'SENT' })
    expect((await admin('SELECT 1 FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['portal_order_request.sent', requestA.id])).length).toBe(1)
    // Frozen: no line, no second send.
    expect((await call(browsers.buyer, 'POST', `${url}/lines`, { version: sent.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] })).status).toBe(409)
    expect((await call(browsers.buyer, 'POST', `${url}/send`, { version: sent.request.version })).status).toBe(409)
    requestA = sent.request
    // Home › Approvals: the office's source lists it (orders.manage acts).
    const caller = office()
    const answer = await SOURCES.PORTAL_ORDER_REQUEST({ caller, viewer: { actor: actorOf(caller.factoryContext!), personId: officeId, today: TODAY, now: h.clock.now() } })
    expect(answer.candidates.map((candidate) => candidate.record.label)).toContain(requestA.number)
    const listed = await listOfficeRequests(office(), { status: 'OPEN' })
    expect(listed.requests.map((entry) => entry.number)).toContain(requestA.number)
  })

  it('the office makes the order from it (prices again) and the customer reads ACCEPTED with the order', async () => {
    const view = await officeRequestView(office(), requestA.id)
    expect(view.may).toEqual({ order: true, quote: true, refuse: true })
    expect(view.request.lines[0]).toMatchObject({ unitPriceShown: '420.00', listPriceNow: '420.00', pieces: 7 })
    const accepted = await acceptRequest(office(), requestA.id, { version: view.request.version, as: 'ORDER' })
    expect(accepted.request.status).toBe('ACCEPTED')
    const order = await one('SELECT number, status, "customerRef", "netAmount" FROM "SalesOrder" WHERE id = $1', [accepted.made.salesOrderId])
    expect(order).toMatchObject({ status: 'CONFIRMED', customerRef: 'PO-T-0001', netAmount: 294000 })
    const read = await ok(browsers.buyer, 'GET', `/portal/order-requests/${requestA.id}`)
    expect(read.request).toMatchObject({ status: 'ACCEPTED', salesOrder: { id: accepted.made.salesOrderId, number: order.number } })
    // Decided once.
    await expect(refuseRequest(office(), requestA.id, { version: accepted.request.version, reason: 'Too late' })).rejects.toThrow(/already accepted/)
  })
})

describe('reorder (SAL-072)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('copies a past order at today\'s prices, naming the differences, and the office refuses it in words', async () => {
    const past = await ok(browsers.buyer, 'GET', '/portal/reorder/orders')
    expect(past.orders.map((order: Json) => order.number)).toContain('SEED-SO-0001')
    const so1 = await orderId('SEED-SO-0001')
    const plan = await ok(browsers.buyer, 'GET', `/portal/reorder/orders/${so1}`)
    expect(plan.lines.length).toBeGreaterThan(0)
    for (const line of plan.lines) expect(line).toHaveProperty('unitPriceThen')
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'REORDER', customerRef: 'PO-T-0002' }, 201)
    const copied = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/reorder`, { version: draft.request.version, orderId: so1 })
    expect(copied.added).toBe(plan.lines.filter((line: Json) => line.addable).length)
    expect(copied.request.lines.every((line: Json) => line.source?.orderNumber === 'SEED-SO-0001')).toBe(true)
    // ---- B-TH-304 (pick A, plan §0.5): the catalogue door names the customer's OWN order number ("Your order N"), the same on the
    // list, the order's lines and every copied line's source — so the portal never needs the office's series.
    const own = (await ok(browsers.buyer, 'GET', '/portal/sales-orders?chip=ALL')).items.find((row: Json) => row.id === so1)?.yourNumber ?? null
    const listed = past.orders.find((order: Json) => order.id === so1)
    expect(listed.yourNumber).toEqual(own)
    expect(plan.order.yourNumber).toEqual(own)
    expect(copied.request.lines.every((line: Json) => JSON.stringify(line.source?.yourNumber ?? null) === JSON.stringify(own))).toBe(true)
    for (const order of past.orders) if (order.yourNumber) expect(order.yourNumber.words.en).toBe(`Your order ${order.yourNumber.seq}`)
    // ---- end B-TH-304
    const sent = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/send`, { version: copied.request.version })
    const view = await officeRequestView(office(), draft.request.id)
    await expect(refuseRequest(office(), draft.request.id, { version: view.request.version, reason: '   ' })).rejects.toThrow(/Say why/)
    await refuseRequest(office(), draft.request.id, { version: view.request.version, reason: 'This season is closed: we send the new range next week.' })
    const read = await ok(browsers.buyer, 'GET', `/portal/order-requests/${sent.request.id}`)
    expect(read.request).toMatchObject({ status: 'REFUSED', refuseReason: 'This season is closed: we send the new range next week.' })
    // The office's decider is never shown to the customer.
    expect(read.request).not.toHaveProperty('decidedById')
  })
})

describe('upload with a dry run (SAL-073)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('gives the template, a verdict per row before anything lands, then adds the ready rows; the office makes a quote of it', async () => {
    expect(processImporters().get('sales.portalOrderLines')).toBeDefined()
    const template = await call(browsers.buyer, 'GET', '/portal/order-template?format=csv&numberFormat=en')
    expect(template.status).toBe(200)
    expect(String(template.body).split('\r\n')[0]).toBe('Style;Colour;Size;Quantity;Your code')
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { source: 'UPLOAD', customerRef: 'PO-T-0003' }, 201)
    const url = `/portal/order-requests/${draft.request.id}/upload`
    const sheet = 'Style;Colour;Size;Quantity;Your code\r\nSEED-JKT-01;BLK;50;4;R-1\r\nSEED-JKT-01;BLK;62;1;\r\nSEED-JKT-99;BLK;50;1;\r\nSEED-JKT-02;RED;52;2;\r\n'
    const dry = await ok(browsers.buyer, 'POST', url, { fileName: 'order.csv', contentType: 'text/csv', content: b64(sheet), numberFormat: 'en' })
    expect(dry).toMatchObject({ applied: false, record: null, dryRun: { rows: 4, ready: 2, refused: 2 } })
    expect(dry.dryRun.verdicts.map((verdict: Json) => verdict.status)).toEqual(['READY', 'REFUSED', 'REFUSED', 'READY'])
    expect(dry.dryRun.verdicts[1].reasons[0].en).toBe('Size 62 not offered for SEED-JKT-01 BLK.')
    expect(dry.dryRun.refusedCsv).toContain('SEED-JKT-99')
    // Nothing landed.
    expect((await admin('SELECT 1 FROM "PortalOrderRequestLine" WHERE "requestId" = $1', [draft.request.id])).length).toBe(0)
    expect((await call(browsers.buyer, 'POST', url, { fileName: 'order.csv', contentType: 'text/csv', content: b64('Colour;Size\r\nBLK;50\r\n') })).status).toBe(400)
    const applied = await ok(browsers.buyer, 'POST', url, { fileName: 'order.csv', contentType: 'text/csv', content: b64(sheet), numberFormat: 'en', apply: true, version: draft.request.version })
    expect(applied).toMatchObject({ applied: true, added: 2 })
    expect(applied.record.request.lines.map((line: Json) => [line.style.code, line.colourway.code, line.pieces])).toEqual([
      ['SEED-JKT-01', 'BLK', 4],
      ['SEED-JKT-02', 'RED', 2],
    ])
    expect(applied.record.request.lines[0].note).toBe('R-1')
    const sent = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/send`, { version: applied.record.request.version })
    const view = await officeRequestView(office(), sent.request.id)
    const quoted = await acceptRequest(office(), sent.request.id, { version: view.request.version, as: 'QUOTE' })
    expect(quoted.made).toMatchObject({ as: 'QUOTE', salesOrderId: null })
    expect((await one('SELECT "partyId", status FROM "Quote" WHERE id = $1', [quoted.made.quoteId])).partyId).toBe(P1)
    expect((await ok(browsers.buyer, 'GET', `/portal/order-requests/${sent.request.id}`)).request.quote.id).toBe(quoted.made.quoteId)
  })
})

describe('withdraw and discard', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('withdraws a sent request before the office decides, and discards a draft', async () => {
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', {}, 201)
    const added = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/lines`, { version: draft.request.version, lines: [{ styleId: jkt02, colourwayId: red02, sizes: [{ size: '50', quantity: 1 }] }] })
    const sent = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/send`, { version: added.request.version })
    const withdrawn = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/withdraw`, { version: sent.request.version })
    expect(withdrawn.request.status).toBe('WITHDRAWN')
    await expect(acceptRequest(office(), draft.request.id, { version: withdrawn.request.version, as: 'ORDER' })).rejects.toThrow(/withdrew/)
    const other = await ok(browsers.buyer, 'POST', '/portal/order-requests', {}, 201)
    expect(await ok(browsers.buyer, 'DELETE', `/portal/order-requests/${other.request.id}?version=${other.request.version}`)).toEqual({ discarded: true })
    expect((await call(browsers.buyer, 'GET', `/portal/order-requests/${other.request.id}`)).status).toBe(404)
    // B-CP-071 (D10, K9 reversed): the office READS a draft from its first save, read-only — it decides it only once sent.
    const kept = await ok(browsers.buyer, 'POST', '/portal/order-requests', {}, 201)
    const read = await officeRequestView(office(), kept.request.id)
    expect(read.request).toMatchObject({ status: 'DRAFT', draft: expect.objectContaining({ readiness: expect.objectContaining({ of: 7 }) }) })
    expect(read.may).toEqual({ order: false, quote: false, refuse: false })
    await expect(acceptRequest(office(), kept.request.id, { version: read.request.version, as: 'ORDER' })).rejects.toThrow(/still the customer's draft/)
  })
})

describe('delivery addresses (SAL-079) and our check of them (B-W2b-F13b, wave 23)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const body = { name: 'Seed warehouse two', line1: 'Via Esempio 12', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', contactName: 'Ufficio ricevimento' }
  const officeViewer = () => {
    const caller = office()
    return { caller, viewer: { actor: actorOf(caller.factoryContext!), personId: officeId, today: TODAY, now: h.clock.now() } }
  }

  it('the admin adds an address that waits for our check: never the default, in Approvals; approved, it may be the default; archived, a draft names it', async () => {
    const seen = await ok(browsers.viewer, 'GET', '/portal/addresses')
    expect(seen.canManage).toBe(false)
    expect((await call(browsers.viewer, 'POST', '/portal/addresses', body)).status).toBe(403)
    expect((await call(browsers.buyer, 'POST', '/portal/addresses', body)).status).toBe(403)
    // REFUSED: a new address is never the default (it waits for our check).
    const asDefault = await call(browsers.admin, 'POST', '/portal/addresses', { ...body, isDefault: true })
    expect(asDefault.status, JSON.stringify(asDefault.body)).toBe(400)
    expect(asDefault.body.error.issues[0].message).toMatch(/waits for our check/)
    const made = await ok(browsers.admin, 'POST', '/portal/addresses', body, 201)
    expect(made.address).toMatchObject({ name: 'Seed warehouse two', isDefault: false, status: 'ACTIVE', addedBy: { kind: 'COLLEAGUE', you: true }, approval: { status: 'WAITING', refuseReason: null }, requestedAt: expect.any(String), decidedAt: null })
    const row = await one('SELECT "createdById", "requestedByUserId", "approvalStatus"::text AS approval, kinds::text FROM "PartyAddress" WHERE id = $1', [made.address.id])
    expect(row).toEqual({ createdById: userIds.admin, requestedByUserId: userIds.admin, approval: 'WAITING', kinds: '{SHIP_TO}' })
    const audit = await admin('SELECT "actorId", after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['Party', P1])
    expect(audit.some((entry) => entry.actorId === userIds.admin && entry.after?.byPartner === true && entry.after?.address?.approvalStatus === 'WAITING')).toBe(true)
    // REFUSED: the default before our check (409 in words).
    const early = await call(browsers.admin, 'POST', `/portal/addresses/${made.address.id}/default`, { version: made.address.version })
    expect(early.status, JSON.stringify(early.body)).toBe(409)
    expect(early.body.error.message).toMatch(/waits for our check/)
    // REFUSED: an order typed by the office with it (the words, before the database's refusal).
    const preview = await previewManualOrder(office(), { companyId: companyA, partyId: P1, shipToAddressId: made.address.id, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] })
    expect(preview.problems).toEqual(expect.arrayContaining([{ path: 'body/shipToAddressId', message: expect.stringMatching(/waits for our check: approve it first/) }]))
    // Home › Approvals: whoever takes the customer's orders sees it; the office's list too.
    const { caller, viewer } = officeViewer()
    const approvals = await SOURCES.DELIVERY_ADDRESS({ caller, viewer })
    const candidate = approvals.candidates.find((entry) => entry.subKey === made.address.id)
    expect(candidate).toMatchObject({ kind: 'DELIVERY_ADDRESS', record: { type: 'Party', id: P1 }, state: 'WAITING' })
    const listed = await listAddressChecks(office(), { state: 'WAITING' })
    const waiting = listed.addresses.find((entry) => entry.id === made.address.id)!
    expect(waiting).toMatchObject({ party: { id: P1 }, approval: { status: 'WAITING', requestedBy: 'ada.admin' }, may: { decide: true } })
    // REFUSED: a stale version (409); then approved.
    await expect(approveAddress(office(), made.address.id, { version: waiting.version + 1 })).rejects.toThrow(/changed since you read it/)
    const approved = await approveAddress(office(), made.address.id, { version: waiting.version })
    expect(approved.address).toMatchObject({ approval: { status: 'APPROVED', decidedAt: expect.any(String) }, may: { decide: false } })
    await expect(approveAddress(office(), made.address.id, { version: approved.address.version })).rejects.toThrow(/approved already/)
    expect((await SOURCES.DELIVERY_ADDRESS(officeViewer())).candidates.some((entry) => entry.subKey === made.address.id)).toBe(false)
    // The customer reads it checked (never who decided); now it may be the default and an order may use it.
    const after = (await ok(browsers.admin, 'GET', '/portal/addresses')).addresses.find((address: Json) => address.id === made.address.id)
    expect(after).toMatchObject({ approval: { status: 'APPROVED' }, decidedAt: expect.any(String) })
    expect(JSON.stringify(after)).not.toContain(officeId)
    expect((await previewManualOrder(office(), { companyId: companyA, partyId: P1, shipToAddressId: made.address.id, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] })).problems.filter((problem: Json) => problem.path === 'body/shipToAddressId')).toEqual([])
    // The buyer asks for it on a draft; the admin makes it the default, then archives it: the draft names it.
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { shipToAddressId: made.address.id }, 201)
    const defaulted = await ok(browsers.admin, 'POST', `/portal/addresses/${made.address.id}/default`, { version: after.version })
    const fresh = defaulted.addresses.find((address: Json) => address.id === made.address.id)
    expect(fresh.isDefault).toBe(true)
    const archived = await ok(browsers.admin, 'POST', `/portal/addresses/${made.address.id}/archive`, { version: fresh.version })
    expect(archived.addresses.find((address: Json) => address.id === made.address.id)).toMatchObject({ status: 'ARCHIVED', isDefault: false })
    const read = await ok(browsers.buyer, 'GET', `/portal/order-requests/${draft.request.id}`)
    expect(read.request.problems.map((problem: Json) => problem.code)).toEqual(['NO_LINES', 'SHIP_TO_ARCHIVED'])
    // Another customer never sees P1's addresses.
    expect((await ok(browsers.other, 'GET', '/portal/addresses')).addresses.map((address: Json) => address.id)).not.toContain(made.address.id)
  })

  it('a request naming a waiting address: the office accepting it approves the address in the same command', async () => {
    const made = await ok(browsers.admin, 'POST', '/portal/addresses', { ...body, name: 'Seed pop-up store', line1: 'Via Esempio 30' }, 201)
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { shipToAddressId: made.address.id, customerRef: 'PO-T-ADDR' }, 201)
    expect(draft.request.problems.map((problem: Json) => problem.code)).toEqual(['NO_LINES'])
    expect(draft.addresses.find((address: Json) => address.id === made.address.id)).toMatchObject({ approval: { status: 'WAITING' } })
    const added = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/lines`, { version: draft.request.version, lines: [{ styleId: jkt02, colourwayId: red02, sizes: [{ size: '52', quantity: 2 }] }] })
    const sent = await ok(browsers.buyer, 'POST', `/portal/order-requests/${draft.request.id}/send`, { version: added.request.version })
    const view = await officeRequestView(office(), sent.request.id)
    expect(view.request.shipTo).toMatchObject({ id: made.address.id, approvalStatus: 'WAITING' })
    const accepted = await acceptRequest(office(), sent.request.id, { version: view.request.version, as: 'ORDER' })
    expect(accepted.request.shipTo).toMatchObject({ id: made.address.id, approvalStatus: 'APPROVED' })
    const address = await one('SELECT "approvalStatus"::text AS approval, "decidedById", "decidedAt" IS NOT NULL AS decided FROM "PartyAddress" WHERE id = $1', [made.address.id])
    expect(address).toEqual({ approval: 'APPROVED', decidedById: officeId, decided: true })
    const order = await one<{ shipTo: Json }>('SELECT "shipTo" FROM "SalesOrder" WHERE id = $1', [accepted.made.salesOrderId])
    expect(order.shipTo).toMatchObject({ line1: 'Via Esempio 30', city: 'Bologna' })
    const audit = await one('SELECT after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2 AND after->>\'approvalStatus\' = $3', ['PartyAddress', made.address.id, 'APPROVED'])
    expect(audit.after.with).toMatchObject({ type: 'PortalOrderRequest', id: sent.request.id })
  })

  it('the office refuses an address with the reason the customer reads: archived for good, never used for an order', async () => {
    const made = await ok(browsers.admin, 'POST', '/portal/addresses', { ...body, name: 'Seed garage', line1: 'Via Esempio 99' }, 201)
    const { version } = (await listAddressChecks(office(), { state: 'WAITING', partyId: P1 })).addresses.find((entry) => entry.id === made.address.id)!
    // REFUSED: a refusal without its reason (words at the field).
    await expect(refuseAddress(office(), made.address.id, { version, reason: ' ' })).rejects.toThrow(/Say why the address is not accepted/)
    const refused = await refuseAddress(office(), made.address.id, { version, reason: 'We do not deliver to private garages.' })
    expect(refused.address).toMatchObject({ status: 'ARCHIVED', approval: { status: 'REFUSED', refuseReason: 'We do not deliver to private garages.' } })
    const seen = (await ok(browsers.admin, 'GET', '/portal/addresses')).addresses.find((address: Json) => address.id === made.address.id)
    expect(seen).toMatchObject({ status: 'ARCHIVED', approval: { status: 'REFUSED', refuseReason: 'We do not deliver to private garages.', words: { en: 'Not accepted' } } })
    expect((await listAddressChecks(office(), { state: 'REFUSED', partyId: P1 })).addresses.map((entry) => entry.id)).toContain(made.address.id)
    await expect(approveAddress(office(), made.address.id, { version: refused.address.version })).rejects.toThrow(/refused already/)
    const preview = await previewManualOrder(office(), { companyId: companyA, partyId: P1, shipToAddressId: made.address.id, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] })
    expect(preview.problems.map((problem: Json) => problem.path)).toContain('body/shipToAddressId')
    // REFUSED: the database keeps a refused address archived for good (its guard; the API's words came first above).
    await expect(admin('UPDATE "PartyAddress" SET status = \'ACTIVE\' WHERE id = $1', [made.address.id])).rejects.toThrow(/refused/)
  })

  it('B-W2b-F15: the office party record shows the check of each address (who asked, who decided, why), never to a partner', async () => {
    // The office person of these tests gets a user row, so the record can name who decided.
    await admin('INSERT INTO "User" (id, "tenantId", email, "displayName", locale, status, audience) VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT DO NOTHING', [officeId, T, 'otto.office@seed-factory.example', 'Otto Office', 'en', 'ACTIVE', 'OFFICE'])
    const waiting = await ok(browsers.admin, 'POST', '/portal/addresses', { ...body, name: 'Seed outlet', line1: 'Via Esempio 41' }, 201)
    const reader = callerFor(h.database, { audience: 'office', tenantId: T, actorId: officeId, requestId: newId(), grants: [{ permissions: ['parties.view'], companies: 'all', sites: 'all', parties: 'all' }] })
    // Read through the route's contract (unknown keys are stripped there): the check is part of what GET /parties/:id answers.
    const record = partyView.parse(await getParty(reader, P1))
    const byName = (name: string) => record.addresses.find((address) => address.name === name)!
    expect(byName('Seed outlet')).toMatchObject({ id: waiting.address.id, isDefaultShipTo: false })
    expect(byName('Seed outlet').approval).toEqual({ status: 'WAITING', requestedAt: expect.any(String), requestedBy: 'ada.admin', decidedAt: null, decidedBy: null, refuseReason: null })
    expect(byName('Seed warehouse two').approval).toMatchObject({ status: 'APPROVED', requestedBy: 'ada.admin', decidedAt: expect.any(String), decidedBy: 'Otto Office', refuseReason: null })
    expect(byName('Seed pop-up store').approval).toMatchObject({ status: 'APPROVED', requestedBy: 'ada.admin', decidedBy: 'Otto Office' })
    expect(byName('Seed garage')).toMatchObject({ status: 'ARCHIVED', approval: { status: 'REFUSED', requestedBy: 'ada.admin', decidedBy: 'Otto Office', refuseReason: 'We do not deliver to private garages.' } })
    // The office's own addresses (the seed's): none, never checked.
    const ownIds = (await admin<{ id: string }>('SELECT id FROM "PartyAddress" WHERE "partyId" = $1 AND "approvalStatus" IS NULL', [P1])).map((row) => row.id)
    expect(ownIds.length).toBeGreaterThan(0)
    expect(record.addresses.filter((address) => ownIds.includes(address.id)).map((address) => address.approval)).toEqual(ownIds.map(() => null))
    expect(record.addresses.filter((address) => !ownIds.includes(address.id)).every((address) => address.approval !== null)).toBe(true)
    // Never to a partner: the office route refuses a portal session, and the portal's own list never names who decided.
    const refused = await call(browsers.admin, 'GET', `/parties/${P1}`)
    expect([401, 403, 404]).toContain(refused.status)
    expect(JSON.stringify(refused.body)).not.toContain('Otto Office')
    const portal = await ok(browsers.admin, 'GET', '/portal/addresses')
    expect(JSON.stringify(portal)).not.toMatch(/Otto Office|decidedBy/)
    expect(JSON.stringify(portal)).not.toContain(officeId)
  })

  it('B-W2b-F15: the person who asked hears the decision, in their language, with the reason of a refusal; nobody else, never for our own addresses', async () => {
    const events = await admin<{ id: string; type: string; payload: Json; companyId: string | null; subject: string }>('SELECT id, type, payload, "companyId", subject FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id', [T, 'delivery_address.checked'])
    // The three decisions of the tests above: approved by hand, approved by accepting a request, refused. Ids and the decision only.
    expect(events.map((event) => event.payload.decision)).toEqual(['APPROVED', 'APPROVED', 'REFUSED'])
    for (const event of events) expect(Object.keys(event.payload).sort()).toEqual(['addressId', 'decision', 'partyId'])
    // The asker reads Italian (their own setting) for this run.
    await admin('UPDATE "User" SET locale = $1 WHERE id = $2', ['it', userIds.admin])
    const system = () => callerFor(h.database, systemContext(T, `test-${newId()}`))
    const fanOut = (event: { id: string; type: string; payload: Json; companyId: string | null }) =>
      partnerFanOut(system(), { eventId: event.id, type: event.type, tenantId: T, companyId: event.companyId, siteId: null, payload: event.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
    const before = h.ses.mails.length
    let made = 0
    for (const event of events) made += await fanOut(event)
    expect(made).toBe(3)
    const rows = await admin<{ userId: string; messageKey: string; recordType: string; recordLabel: string; params: Json }>('SELECT "userId", "messageKey", "recordType", "recordLabel", params FROM "Notification" WHERE "eventType" = $1 ORDER BY "createdAt", id', ['delivery_address.checked'])
    // Only the admin who added the addresses: not the buyer, the viewer, nor another customer's buyer.
    expect(rows.map((row) => row.userId)).toEqual([userIds.admin, userIds.admin, userIds.admin])
    expect(rows.map((row) => row.messageKey)).toEqual(['portal.address.approved', 'portal.address.approved', 'portal.address.refused'])
    expect(rows.map((row) => row.recordLabel)).toEqual(['Seed warehouse two, Via Esempio 12, 40100 Bologna', 'Seed pop-up store, Via Esempio 30, 40100 Bologna', 'Seed garage, Via Esempio 99, 40100 Bologna'])
    expect(rows.every((row) => row.recordType === 'PartyAddress')).toBe(true)
    expect(rows[2]!.params).toEqual({ reason: 'We do not deliver to private garages.' })
    expect(rows[0]!.params).toEqual({})
    // Mailed at once (orders: transactional), in the asker's language, to the asker only.
    const mails = h.ses.mails.slice(before).filter((mail) => mail.templateKey === 'portal.notification')
    expect(mails.map((mail) => mail.to[0])).toEqual([people.admin, people.admin, people.admin])
    expect(textOf(mails[2]!.raw)).toContain('Il vostro indirizzo di consegna Seed garage, Via Esempio 99, 40100 Bologna non è stato accettato: We do not deliver to private garages.')
    expect(textOf(mails[0]!.raw)).toContain('è stato verificato: i vostri ordini possono usarlo')
    // The bell says it in both languages; a replayed event makes nothing more.
    const bell = await ok(browsers.admin, 'GET', '/portal/notifications')
    expect(bell.items.find((item: Json) => item.messageKey === 'portal.address.refused').sentence.en).toBe('Your delivery address Seed garage, Via Esempio 99, 40100 Bologna was not accepted: We do not deliver to private garages.')
    expect((await ok(browsers.buyer, 'GET', '/portal/notifications')).items.filter((item: Json) => item.messageKey.startsWith('portal.address.'))).toEqual([])
    expect(await fanOut(events[2]!)).toBe(0)
    // Never for the office's own addresses: they are never checked (no event), and an event naming one tells nobody.
    const ownId = (await one<{ id: string }>('SELECT id FROM "PartyAddress" WHERE "partyId" = $1 AND "approvalStatus" IS NULL ORDER BY "createdAt", id LIMIT 1', [P1])).id
    await expect(approveAddress(office(), ownId, { version: 1 })).rejects.toThrow(/not found/i)
    expect(await fanOut({ id: newId(), type: 'delivery_address.checked', payload: { addressId: ownId, partyId: P1, decision: 'APPROVED' }, companyId: null })).toBe(0)
    await admin('UPDATE "User" SET locale = $1 WHERE id = $2', ['en', userIds.admin])
  })
})

// ---- B-CP-070 (customer page plan D11; wall tests W-CP-1, M-CP-2): the brand's Designer keeps drafts without prices ---------------
describe('B-CP-070: the Designer starts, fills and discards its own drafts; never sends one, never sees a price', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  const noPrice = (body: Json) => {
    // The grain filter drops every price field for a role without the price grain (never null-but-present: the key is gone).
    for (const line of body.request.lines as Json[]) for (const key of ['unitPriceShown', 'priceNow', 'amount']) expect(line, key).not.toHaveProperty(key)
    expect(body.request.summary).not.toHaveProperty('net')
    expect(body.seesPrices).toBe(false)
  }

  it('starts and fills a draft: lines and header kept, no price in any answer; held from sending and withdrawing (403)', async () => {
    const made = await ok(browsers.designer, 'POST', '/portal/order-requests', { source: 'PICKER', note: 'Made-up: the team kit for spring' }, 201)
    expect(made.request).toMatchObject({ status: 'DRAFT', may: { send: false, withdraw: false, discard: true } })
    const url = `/portal/order-requests/${made.request.id}`
    const filled = await ok(browsers.designer, 'POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 3 }] }] })
    noPrice(filled)
    expect(filled.request.summary).toEqual({ lines: 1, pieces: 3 })
    // Stored without a price shown (it never had one to see): the buyer accepts today's price before sending.
    expect((await one('SELECT "unitPriceShown" FROM "PortalOrderRequestLine" WHERE "requestId" = $1', [made.request.id])).unitPriceShown).toBeNull()
    const header = await ok(browsers.designer, 'PATCH', url, { version: filled.request.version, requestedDate: addDays(TODAY, 40) })
    noPrice(header)
    noPrice(await ok(browsers.designer, 'GET', url))
    const listed = await ok(browsers.designer, 'GET', '/portal/order-requests')
    expect(listed.seesPrices).toBe(false)
    for (const row of listed.requests as Json[]) expect(row).not.toHaveProperty('net')
    // Never a send or a withdraw (the route's permission), never today's prices (no price to take), never a reorder (no orders).
    expect((await call(browsers.designer, 'POST', `${url}/send`, { version: header.request.version })).status).toBe(403)
    expect((await call(browsers.designer, 'POST', `${url}/prices`, { version: header.request.version })).status).toBe(409)
    expect((await call(browsers.designer, 'GET', '/portal/reorder/orders')).status).toBe(403)
    // The Buyer reads the Designer's draft (the party's), takes today's price and sends it; the Designer cannot withdraw it.
    const read = await ok(browsers.buyer, 'GET', url)
    expect(read.request).toMatchObject({ may: { send: true, discard: true }, pricesChanged: 1 })
    const priced = await ok(browsers.buyer, 'POST', `${url}/prices`, { version: read.request.version })
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version: priced.request.version })
    expect(sent.request.status).toBe('SENT')
    expect((await call(browsers.designer, 'POST', `${url}/withdraw`, { version: sent.request.version })).status).toBe(403)
    expect((await ok(browsers.designer, 'GET', url)).request.may).toEqual({ send: false, withdraw: false, discard: false })
  })

  it('discards a draft it started; never a colleague\'s; a Buyer discards any draft of the party', async () => {
    const own = await ok(browsers.designer, 'POST', '/portal/order-requests', {}, 201)
    expect(await ok(browsers.designer, 'DELETE', `/portal/order-requests/${own.request.id}?version=${own.request.version}`)).toEqual({ discarded: true })
    const buyers = await ok(browsers.buyer, 'POST', '/portal/order-requests', {}, 201)
    expect((await ok(browsers.designer, 'GET', `/portal/order-requests/${buyers.request.id}`)).request.may.discard).toBe(false)
    const held = await call(browsers.designer, 'DELETE', `/portal/order-requests/${buyers.request.id}?version=${buyers.request.version}`)
    expect(held.status).toBe(403)
    expect(held.body.error.message).toBe('Only the colleague who started this draft, or one who may send orders, discards it.')
    const theirs = await ok(browsers.designer, 'POST', '/portal/order-requests', {}, 201)
    expect(await ok(browsers.buyer, 'DELETE', `/portal/order-requests/${theirs.request.id}?version=${theirs.request.version}`)).toEqual({ discarded: true })
    expect(await ok(browsers.buyer, 'DELETE', `/portal/order-requests/${buyers.request.id}?version=${buyers.request.version}`)).toEqual({ discarded: true })
  })

  it('W-CP-1: another customer lists, reads, edits and discards none of these drafts (404, as if absent); a Viewer keeps none (403)', async () => {
    const draft = await ok(browsers.designer, 'POST', '/portal/order-requests', { customerRef: 'PO-T-W1' }, 201)
    const url = `/portal/order-requests/${draft.request.id}`
    const theirs = await ok(browsers.other, 'GET', '/portal/order-requests')
    expect(theirs.requests.map((row: Json) => row.id)).not.toContain(draft.request.id)
    expect(JSON.stringify(theirs)).not.toContain('PO-T-W1')
    for (const [method, path, body] of [
      ['GET', url, undefined],
      ['PATCH', url, { version: draft.request.version, note: 'not mine' }],
      ['POST', `${url}/lines`, { version: draft.request.version, lines: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] }],
      ['DELETE', `${url}?version=${draft.request.version}`, undefined],
    ] as const) {
      const answer = await call(browsers.other, method, path, body)
      expect(answer.status, `${method} ${path}`).toBe(404)
      expect(JSON.stringify(answer.body)).not.toMatch(/PO-T-W1|another customer|belongs/i)
    }
    expect((await call(browsers.viewer, 'GET', '/portal/order-requests')).status).toBe(403)
    expect((await one('SELECT version FROM "PortalOrderRequest" WHERE id = $1', [draft.request.id])).version).toBe(draft.request.version)
  })
})
// ---- end B-CP-070

// ---- B-CP-076 (customer page plan 11 §1.3 D3; review E3, B4; walls M-CP-1, M-CP-2, W-CP-1): "Your price" and its carry -------------
describe('B-CP-076: "Your price" in the draft, frozen at Send, carried onto the order by the accept’s line map', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  // A Sales worker of the ready-made roles (no price grain since B-CP-011), signed in through the app (its grain filter).
  let salesDesk: OfficeBrowser
  const CUSTOMER_PRICE_KEYS = /"(brandUnitPrice|draftValueAmount|brandPrices)":/
  const priceOf = async (lineId: string) => (await one<{ price: string | null }>('SELECT "brandUnitPrice"::text AS price FROM "PortalOrderRequestLine" WHERE id = $1', [lineId])).price

  beforeAll(async () => {
    const user = await addUser(h, tenant, { email: 'sam.sales.cp076@example.com', role: 'sales' })
    salesDesk = new OfficeBrowser(h.app)
    expect((await salesDesk.signIn(NS, user.email, user.password)).status).toBe(200)
    await enrolTotp(h, salesDesk)
    h.clock.set(new Date(Date.now() - 2_000))
  }, 120_000)

  /** A draft of P1: a black line (Your price `black`), a red line (Your price `red`), a described line of 4 pieces at 395.50; sent or not. */
  async function pricedRequest(ref: string, prices: { black: string | null; red: string | null }, send: boolean): Promise<Json> {
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { customerRef: ref }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const lines = await ok(browsers.buyer, 'POST', `${url}/lines`, {
      version: made.request.version,
      lines: [
        { styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 2 }, { size: '52', quantity: 1 }], brandUnitPrice: prices.black },
        { styleId: jkt02, colourwayId: red02, sizes: [{ size: '54', quantity: 1 }], brandUnitPrice: prices.red },
      ],
    })
    const described = await ok(browsers.buyer, 'POST', `${url}/custom-lines`, { version: lines.request.version, line: { kind: 'DESCRIBED', description: 'Made-up team jackets, our logo on the back', quantity: 4, brandUnitPrice: '395.5' } })
    const black = lines.request.lines.find((line: Json) => line.colourway.id === blk02).id
    const red = lines.request.lines.find((line: Json) => line.colourway.id === red02).id
    const out = { id: made.request.id, url, black, red, described: described.request.customLines[0].id, version: described.request.version }
    if (!send) return out
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version: described.request.version })
    return { ...out, version: sent.request.version, number: sent.request.number }
  }
  const map = (request: Json) => [{ lineId: request.described, into: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 2 }] }, { styleId: jkt02, colourwayId: red02, sizes: [{ size: '52', quantity: 2 }] }] }]

  it('a Buyer types Your price with the line; the Designer sends none (403) and reads none (M-CP-2); frozen once sent', async () => {
    const draft = await pricedRequest('PO-T-076A', { black: '400', red: null }, false)
    const read = await ok(browsers.buyer, 'GET', draft.url)
    expect(read.request.lines.find((line: Json) => line.id === draft.black)).toMatchObject({ brandUnitPrice: '400.00', unitPriceShown: '410.00' })
    expect(read.request.lines.find((line: Json) => line.id === draft.red).brandUnitPrice).toBeNull()
    expect(read.request.customLines[0]).toMatchObject({ id: draft.described, brandUnitPrice: '395.50' })
    const changed = await ok(browsers.buyer, 'PUT', `${draft.url}/lines/${draft.black}`, { version: read.request.version, brandUnitPrice: '401' })
    expect(changed.request.lines.find((line: Json) => line.id === draft.black).brandUnitPrice).toBe('401.00')
    expect(await priceOf(draft.black)).toBe('401.000000')
    // At least 0 (400 in words).
    expect((await call(browsers.buyer, 'PUT', `${draft.url}/lines/${draft.black}`, { version: changed.request.version, brandUnitPrice: '-1' })).status).toBe(400)
    // M-CP-2: the Designer fills the same draft: a body with Your price is refused by its path (403), even null; no answer has it.
    const added = await call(browsers.designer, 'POST', `${draft.url}/lines`, { version: changed.request.version, lines: [{ styleId: jkt01, colourwayId: blk01, sizes: [{ size: '50', quantity: 1 }], brandUnitPrice: '1' }] })
    expect(added.status, JSON.stringify(added.body)).toBe(403)
    expect((added.body.error.issues as Json[]).map((issue) => issue.path)).toEqual(['lines/0/brandUnitPrice'])
    const cleared = await call(browsers.designer, 'PUT', `${draft.url}/custom-lines/${draft.described}`, { version: changed.request.version, brandUnitPrice: null })
    expect(cleared.status).toBe(403)
    expect(JSON.stringify(await ok(browsers.designer, 'GET', draft.url))).not.toMatch(CUSTOMER_PRICE_KEYS)
    // The Designer's own change of the line keeps the customer's price (absent keeps it).
    const noted = await ok(browsers.designer, 'PUT', `${draft.url}/custom-lines/${draft.described}`, { version: changed.request.version, note: 'Made-up: the sizes follow' })
    expect(JSON.stringify(noted)).not.toMatch(CUSTOMER_PRICE_KEYS)
    expect(await priceOf(draft.described)).toBe('395.500000')
    // Frozen at Send, with the line.
    const sent = await ok(browsers.buyer, 'POST', `${draft.url}/send`, { version: noted.request.version })
    expect((await call(browsers.buyer, 'PUT', `${draft.url}/lines/${draft.black}`, { version: sent.request.version, brandUnitPrice: '1' })).status).toBe(409)
    expect(await priceOf(draft.black)).toBe('401.000000')
    // W-CP-1: another customer reads none of it.
    expect((await call(browsers.other, 'GET', draft.url)).status).toBe(404)
  })

  it('M-CP-1: the office reads Your price and the draft’s value as a price holder; as Sales worker neither, and part 6 is not counted', async () => {
    const draft = await pricedRequest('PO-T-076M', { black: '400', red: '405' }, false)
    const holder = (await listOfficeRequests(office(), { status: 'DRAFT', partyId: P1 })).requests.find((row) => row.id === draft.id)!
    // 410.00 × 3 and 410.00 × 1 at the price shown, the described line at its own 395.50 × 4: 1230.00 + 410.00 + 1582.00.
    expect(holder.draft).toMatchObject({ draftValueAmount: 322_200, readiness: { of: 7 } })
    expect(holder.draft!.readiness.parts.find((part) => part.part === 'PRICE')?.state).toBe('READY')
    const record = await officeRequestView(office(), draft.id)
    expect(record.request.lines.map((line) => line.brandUnitPrice)).toEqual(['400.00', '405.00'])
    expect(record.request.draft).toMatchObject({ draftValueAmount: 322_200 })
    const list = await salesDesk.send('GET', `/sales/order-requests?status=DRAFT&partyId=${P1}`)
    expect(list.status, JSON.stringify(list.body)).toBe(200)
    expect(JSON.stringify(list.body)).not.toMatch(CUSTOMER_PRICE_KEYS)
    expect((list.body.requests as Json[]).find((row) => row.id === draft.id).draft.readiness.of).toBe(6)
    const one076 = await salesDesk.send('GET', `/sales/order-requests/${draft.id}`)
    expect(one076.status).toBe(200)
    expect(JSON.stringify(one076.body)).not.toMatch(CUSTOMER_PRICE_KEYS)
  })

  it('accepted as an ORDER, the customer’s prices land by the line map: 1 → 1 a unit row, 1 → 2 a line total on the first; audited; as a QUOTE none', async () => {
    const sent = await pricedRequest('PO-T-076O', { black: '401', red: null }, true)
    const accepted = await acceptRequest(office(), sent.id, { version: sent.version, as: 'ORDER', map: map(sent) })
    const orderId = accepted.made.salesOrderId!
    expect(accepted.made.brandPrices).toBe(2)
    const lines = await admin<{ id: string; seq: number }>('SELECT id, seq FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq', [orderId])
    expect(lines.map((line) => line.seq)).toEqual([10, 20, 30, 40])
    const rows = await admin<{ line: string | null; unitPrice: string | null; netAmount: number | null; source: string; enteredById: string | null; currency: string }>(
      `SELECT "salesOrderLineId" AS line, "unitPrice"::text AS "unitPrice", "netAmount", source::text, "enteredById", currency FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY "netAmount" NULLS FIRST`,
      [orderId],
    )
    // The black line (request line 1 → order line 10): its unit price. The red one had none. The described line (request line 3 → order
    // lines 30 and 40): 395.50 × 4 as a line total on the first, never a unit price spread by place.
    expect(rows).toEqual([
      { line: lines[0]!.id, unitPrice: '401.000000', netAmount: null, source: 'PORTAL', enteredById: null, currency: 'EUR' },
      { line: lines[2]!.id, unitPrice: null, netAmount: 158_200, source: 'PORTAL', enteredById: null, currency: 'EUR' },
    ])
    // Audited under OrderBrandPrice with the order as its record (never on the order's own timeline); one event, ids only.
    const audits = await admin<{ after: Json }>(`SELECT after FROM "AuditLog" WHERE "recordType" = 'OrderBrandPrice' AND "recordId" = $1 AND action = 'brandPrices.fromRequest'`, [orderId])
    expect(audits).toHaveLength(2)
    for (const audit of audits) expect(audit.after).toMatchObject({ source: 'PORTAL', requestId: sent.id })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE type = 'sales_order.brand_price_changed' AND subject = $1`, [orderId])
    expect(events.map((event) => Object.keys(event.payload).sort())).toEqual([['orderId', 'partyId']])
    // Every line priced: the 1 → 1 lines keep their unit price, and the whole order one total (the check reads the order as a whole).
    const all = await pricedRequest('PO-T-076T', { black: '401', red: '402' }, true)
    const whole = await acceptRequest(office(), all.id, { version: all.version, as: 'ORDER', map: map(all) })
    const totals = await admin<{ line: string | null; unitPrice: string | null; netAmount: number | null }>(`SELECT "salesOrderLineId" AS line, "unitPrice"::text AS "unitPrice", "netAmount" FROM "OrderBrandPrice" WHERE "salesOrderId" = $1 ORDER BY "unitPrice" NULLS LAST`, [whole.made.salesOrderId])
    expect(totals.map((row) => [row.line === null, row.unitPrice, row.netAmount])).toEqual([
      [false, '401.000000', null],
      [false, '402.000000', null],
      [true, null, 120_300 + 40_200 + 158_200],
    ])
    // A QUOTE takes nothing (the order made from it later offers the take-over).
    const before = (await admin('SELECT id FROM "OrderBrandPrice" WHERE "partyId" = $1', [P1])).length
    const quoted = await pricedRequest('PO-T-076Q', { black: '401', red: '402' }, true)
    const quote = await acceptRequest(office(), quoted.id, { version: quoted.version, as: 'QUOTE', map: map(quoted) })
    expect(quote.made).toMatchObject({ as: 'QUOTE', brandPrices: 0 })
    expect((await admin('SELECT id FROM "OrderBrandPrice" WHERE "partyId" = $1', [P1])).length).toBe(before)
  })

  it('the accept needs no price key: a Sales worker accepts through the app at the list prices, and the customer’s prices still land', async () => {
    const sent = await pricedRequest('PO-T-076S', { black: '401', red: null }, true)
    const accepted = await salesDesk.send('POST', `/sales/order-requests/${sent.id}/accept`, { version: sent.version, as: 'ORDER', map: map(sent) })
    expect(accepted.status, JSON.stringify(accepted.body)).toBe(200)
    expect(JSON.stringify(accepted.body)).not.toMatch(CUSTOMER_PRICE_KEYS)
    expect((await admin('SELECT id FROM "OrderBrandPrice" WHERE "salesOrderId" = $1', [accepted.body.made.salesOrderId])).length).toBe(2)
  })

  // ---- B-CP-076 (lead, 11-19): the take-over pairs by the accept's line map only — never by place ----------------------------------
  it('a request of 12 lines accepted as a QUOTE, its order made later: the take-over gives each line its own price (line 10 never gets line 1’s)', async () => {
    // Triggers off for one statement (as orders-depth): the quote's acceptance is written as it stands (the link page is not this test's).
    const force = async (sql: string, values: unknown[] = []) => {
      await admin('SET session_replication_role = replica')
      try {
        await admin(sql, values)
      } finally {
        await admin('SET session_replication_role = DEFAULT')
      }
    }
    // Twelve described lines, each of one piece, the customer's own price 101.00 … 112.00 (its place + 100).
    const made = await ok(browsers.buyer, 'POST', '/portal/order-requests', { customerRef: 'PO-T-076-12' }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    let version = made.request.version as number
    for (let place = 1; place <= 12; place++) {
      const added = await ok(browsers.buyer, 'POST', `${url}/custom-lines`, { version, line: { kind: 'DESCRIBED', description: `Made-up team item ${place}`, quantity: 1, brandUnitPrice: String(100 + place) } })
      version = added.request.version
    }
    const read = await ok(browsers.buyer, 'GET', url)
    const lines = (read.request.customLines as Json[]).sort((a, b) => a.seq - b.seq)
    expect(lines.map((line) => line.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
    const sent = await ok(browsers.buyer, 'POST', `${url}/send`, { version })
    const quoted = await acceptRequest(office(), made.request.id, { version: sent.request.version, as: 'QUOTE', map: lines.map((line) => ({ lineId: line.id, into: [{ styleId: jkt02, colourwayId: blk02, sizes: [{ size: '50', quantity: 1 }] }] })) })
    expect(quoted.made.brandPrices).toBe(0)
    // The quote accepted (as the customer's link would) and the office makes its order: lines 10, 20 … 120 of the quote.
    const versionId = (await one<{ id: string }>('SELECT id FROM "QuoteVersion" WHERE "quoteId" = $1 ORDER BY revision DESC LIMIT 1', [quoted.made.quoteId])).id
    const snapshot = await one<{ billTo: Json; shipTo: Json }>('SELECT "billTo", "shipTo" FROM "SalesOrder" WHERE id = $1', [await orderId('SEED-SO-0001')])
    await force(`UPDATE "QuoteVersion" SET status = 'ACCEPTED', "billTo" = $2, "shipTo" = $3 WHERE id = $1`, [versionId, snapshot.billTo, snapshot.shipTo])
    await force(`UPDATE "Quote" SET status = 'ACCEPTED' WHERE id = $1`, [quoted.made.quoteId])
    const ordered = await salesDesk.send('POST', '/sales/orders', { quoteVersionId: versionId })
    expect(ordered.status, JSON.stringify(ordered.body)).toBe(201)
    const order = ordered.body.order.id as string
    // The check offers the take-over of all twelve; the take-over pairs through the quote lines, by the accept's map.
    expect((await readPriceCheck(office(), order)).fromRequest).toMatchObject({ requestId: made.request.id, lines: 12 })
    await takeOverBrandPrices(office(), order, { requestId: made.request.id })
    const rows = await admin<{ orderSeq: number; quoteSeq: number; unitPrice: string }>(
      `SELECT l.seq AS "orderSeq", q.seq AS "quoteSeq", b."unitPrice"::text AS "unitPrice" FROM "OrderBrandPrice" b JOIN "SalesOrderLine" l ON l.id = b."salesOrderLineId" JOIN "QuoteLine" q ON q.id = l."quoteLineId" WHERE b."salesOrderId" = $1 ORDER BY q.seq`,
      [order],
    )
    expect(rows).toHaveLength(12)
    // Quote line 10 × k was made from request line k: its own price 100 + k — never the price of the request line whose place is 10.
    for (const row of rows) expect(row.unitPrice, `quote line ${row.quoteSeq}`).toBe(`${100 + row.quoteSeq / 10}.000000`)
    const first = rows.find((row) => row.quoteSeq === 10)!
    expect(first.unitPrice).toBe('101.000000')
    expect(first.unitPrice).not.toBe('110.000000')
    // Nothing left to take over.
    expect((await readPriceCheck(office(), order)).fromRequest).toBeNull()
  })
})
// ---- end B-CP-076
