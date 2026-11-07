import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { processImporters } from '../../../platform/imports/registry'
import { SOURCES } from '../../insights/sources'
import { acceptRequest, listOfficeRequests, officeRequestView, refuseRequest } from './office'

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

const people = { buyer: 'bea.buyer@seed-racing.example', viewer: 'val.viewer@seed-racing.example', admin: 'ada.admin@seed-racing.example', other: 'olga.buyer@brand-alpha.example' }
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
    // A draft is the customer's: the office does not see it.
    const kept = await ok(browsers.buyer, 'POST', '/portal/order-requests', {}, 201)
    await expect(officeRequestView(office(), kept.request.id)).rejects.toThrow(/not found/)
  })
})

describe('delivery addresses (SAL-079)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the admin adds, makes default and archives; the office sees who did; a draft names an archived one as a problem', async () => {
    const seen = await ok(browsers.viewer, 'GET', '/portal/addresses')
    expect(seen.canManage).toBe(false)
    const body = { name: 'Seed warehouse two', line1: 'Via Esempio 12', postalCode: '40100', city: 'Bologna', province: 'BO', country: 'IT', contactName: 'Ufficio ricevimento' }
    expect((await call(browsers.viewer, 'POST', '/portal/addresses', body)).status).toBe(403)
    expect((await call(browsers.buyer, 'POST', '/portal/addresses', body)).status).toBe(403)
    const made = await ok(browsers.admin, 'POST', '/portal/addresses', body, 201)
    expect(made.address).toMatchObject({ name: 'Seed warehouse two', isDefault: false, status: 'ACTIVE', addedBy: { kind: 'COLLEAGUE', you: true } })
    expect(await one('SELECT "createdById", kinds::text FROM "PartyAddress" WHERE id = $1', [made.address.id])).toEqual({ createdById: userIds.admin, kinds: '{SHIP_TO}' })
    const audit = await admin('SELECT "actorId", after FROM "AuditLog" WHERE "recordType" = $1 AND "recordId" = $2', ['Party', P1])
    expect(audit.some((row) => row.actorId === userIds.admin && row.after?.byPartner === true)).toBe(true)
    // The buyer asks for the new address on a draft; the admin archives it: the draft names it.
    const draft = await ok(browsers.buyer, 'POST', '/portal/order-requests', { shipToAddressId: made.address.id }, 201)
    const listed = await ok(browsers.admin, 'POST', `/portal/addresses/${made.address.id}/default`, { version: made.address.version })
    const fresh = listed.addresses.find((address: Json) => address.id === made.address.id)
    expect(fresh.isDefault).toBe(true)
    const archived = await ok(browsers.admin, 'POST', `/portal/addresses/${made.address.id}/archive`, { version: fresh.version })
    expect(archived.addresses.find((address: Json) => address.id === made.address.id)).toMatchObject({ status: 'ARCHIVED', isDefault: false })
    const read = await ok(browsers.buyer, 'GET', `/portal/order-requests/${draft.request.id}`)
    expect(read.request.problems.map((problem: Json) => problem.code)).toEqual(['NO_LINES', 'SHIP_TO_ARCHIVED'])
    // Another customer never sees P1's addresses.
    expect((await ok(browsers.other, 'GET', '/portal/addresses')).addresses.map((address: Json) => address.id)).not.toContain(made.address.id)
  })
})
