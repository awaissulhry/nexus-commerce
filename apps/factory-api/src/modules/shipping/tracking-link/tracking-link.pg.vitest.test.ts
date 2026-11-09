import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { TRACKING_NOTES } from '@nexus/factory-domain/shipping/tracking-link/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seed as seedFiles } from '../../../../../../packages/factory-db/seed/files'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { textOf } from '../../../adapters/ses/fake'
import { callerFor } from '../../../core/command'
import { systemContext } from '../../../platform/outbox/system'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, startHarness, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { trackingLinkHandler } from './handler'

/**
 * Track an order on the local stack (B-W2b-170; LOG-062; design links.tracking, SCR-194), through the real app, the real
 * link authenticator, a real portal sign-in by code and the FAKE mailbox: the factory-db seeds up to shipping (SEED-SH-0001
 * of SEED-SO-0002 — the customer's reference SEED-PO-78 — SHIPPED, two parcels, labels created then in transit, to
 * Seedville 00000), the customer P1's buyer contact (ORDERS, Italian), its portal on, a portal buyer of P1 and one of
 * another customer, an office person of the warehouse and a viewer. Every name, number and address is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs modules/shipping/tracking-link`.
 */

let h: Harness
const NS = 'tracking-link-a'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const SH1 = seedUuid(NS, 'shipping:shipment:SH-0001')
const tenant: TestTenant = { id: T, slug: NS, companies: [{ id: companyA, code: 'SCA' }] }
const BUYER_MAIL = 'buyer.p1@example.com'

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const events = async (type: string) => (await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = $2 ORDER BY "occurredAt", id`, [T, type])).map((row) => row.payload)
const trackingMails = (to: string) => h.ses.mails.filter((mail) => mail.templateKey === 'shipping.tracking_link' && mail.to.includes(to))
const tokenOfMail = (raw: string): string => decodeURIComponent(/#token=(\S+)/.exec(textOf(raw))![1]!)
const tokenOf = (url: string): string => decodeURIComponent(url.split('#token=')[1] ?? '')

let keyCount = 0
const key = () => `w2b170-${process.pid}-${++keyCount}-${Date.now()}`
const linkCall = (token: string, method: 'GET' | 'POST', url: string, payload?: unknown, idempotencyKey = key()) =>
  h.app.inject({ method, url, headers: { 'x-factory-link': token, 'user-agent': 'SeedPhone/1.0', ...(method === 'POST' ? { 'idempotency-key': idempotencyKey } : {}) }, ...(payload === undefined ? {} : { payload: payload as object }) })
const search = (body: Json, remoteAddress = '203.0.113.7') => h.app.inject({ method: 'POST', url: '/tracking/search', payload: body, remoteAddress })

let office: Browser
let viewer: Browser
const portal = {} as Record<'buyer' | 'other', Browser>
const MONEY_KEY = /"(price|unitPrice|amount|total|netValue|freightCharge|freightCost|value)"/

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<string> {
  const id = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    await client.user.create({ data: { id, email, displayName: email.split('@')[0]!, locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const roleKey of roleKeys) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: roleKey } }, select: { id: true } })
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

async function officeBrowser(email: string, role: string): Promise<Browser> {
  await addUser(h, tenant, { email, role })
  const browser = new Browser(h.app)
  const signed = await browser.signIn(NS, email, 'quiet-harbour-lantern-58')
  expect(signed.status, JSON.stringify(signed.body)).toBe(200)
  return browser
}

/** The worker's handler of the goods leaving, with an event like the one the ship command writes. */
async function shippedEvent(eventId = newId()) {
  await trackingLinkHandler({ clock: h.clock }).handle({ eventId, type: 'shipment.status_changed', version: 1, tenantId: T, payload: { shipmentId: SH1, number: 'SEED-SH-0001', from: 'PACKED', to: 'SHIPPED' } } as never, {
    caller: callerFor(h.database, systemContext(T, newId())),
    attempt: 1,
  } as never)
  return eventId
}

beforeAll(async () => {
  h = await startHarness('tracking_link')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
  await seedFiles({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-tracking', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    for (const kind of ['NOTIFICATION', 'CONVERSATION'] as const) {
      await client.emailIdentity.create({
        data: { id: newId(), companyId: companyA, kind, domain, fromAddress: `${kind.toLowerCase()}@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
      })
    }
    await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  await admin(`UPDATE "IntegrationAccount" SET "rateLimitPerMinute" = 6000, "rateLimitBurst" = 1000 WHERE "tenantId" = $1 AND provider = 'R2'`, [T])
  // The letterhead the packing list needs (c.c. art. 2250), made up.
  await admin(`UPDATE "Company" SET "vatNumber" = 'IT00000003038', "fiscalCode" = '00000003038', "reaOffice" = 'MI', "reaNumber" = '0000001' WHERE id = $1`, [companyA])
  const world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson('bianca.buyer.170@seed-racing.example', P1, ['customer-buyer'])
  await partnerPerson('otto.buyer.170@brand-alpha.example', world.partyId, ['customer-buyer'])
  portal.buyer = await signedIn('bianca.buyer.170@seed-racing.example')
  portal.other = await signedIn('otto.buyer.170@brand-alpha.example')
  await admin(`INSERT INTO "Role" (id, "tenantId", key, name, permissions, "requireMfa") VALUES ($1, $2, 'warehouse-170', 'Warehouse (test)', $3, false), ($4, $2, 'viewer-170', 'Viewer (test)', $5, false)`, [
    newId(),
    T,
    ['home.view', 'shipping.view', 'shipping.manage', 'shipping.pack', 'files.read'],
    newId(),
    ['home.view', 'shipping.view'],
  ])
  office = await officeBrowser('wanda.warehouse.170@example.com', 'warehouse-170')
  viewer = await officeBrowser('vera.viewer.170@example.com', 'viewer-170')
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
}, 60_000)

let mailedToken = ''

describe('the tracking link when the goods leave (B-W2b-170)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('mails the customer\'s orders contact its own link once, in its language, never storing the link', async () => {
    const eventId = await shippedEvent()
    const mails = trackingMails(BUYER_MAIL)
    expect(mails).toHaveLength(1)
    const text = textOf(mails[0]!.raw)
    expect(text).toContain('il suo ordine SEED-PO-78 è in viaggio (spedizione SEED-SH-0001).')
    expect(text).toContain('Corriere: Seed Express.')
    mailedToken = tokenOfMail(mails[0]!.raw)
    const link = await one(`SELECT purpose::text, email, "maxUses", uses, note, "createdById", "expiresAt" FROM "OneOffLink" WHERE "recordId" = $1 AND purpose = 'SHIPMENT_TRACK'`, [SH1])
    expect(link).toMatchObject({ purpose: 'SHIPMENT_TRACK', email: BUYER_MAIL, maxUses: 1, uses: 0, note: TRACKING_NOTES.SHIPPED })
    expect(new Date(link.expiresAt).getTime() - h.clock.now().getTime()).toBe(180 * 24 * 60 * 60 * 1000)
    // The outbound row keeps the subject only; no row anywhere holds the token.
    const outbound = await one(`SELECT subject, "templateKey", "recordType" FROM "EmailOutbound" WHERE "templateKey" = 'shipping.tracking_link'`)
    expect(outbound).toEqual({ subject: 'Il suo ordine SEED-PO-78 — Seed A', templateKey: 'shipping.tracking_link', recordType: 'OneOffLink' })
    const secret = mailedToken.split('.').at(-1)!
    for (const table of ['AuditLog', 'OutboxEvent', 'EmailOutbound', 'IdempotencyReceipt', 'OneOffLink']) {
      expect((await one<{ n: number }>(`SELECT count(*)::int AS n FROM "${table}" WHERE row_to_json("${table}")::text LIKE $1`, [`%${secret}%`])).n, table).toBe(0)
    }
    expect((await events('shipment.tracking_link_made')).at(-1)).toEqual({ shipmentId: SH1, number: 'SEED-SH-0001', links: 1, via: 'SHIPPED', mailed: 1 })
    // A repeated job answers from its receipt; another event of the same move mails nothing (the address has its link).
    await shippedEvent(eventId)
    await shippedEvent()
    expect(trackingMails(BUYER_MAIL)).toHaveLength(1)
  })
})

describe('the tracking page by link (links.tracking)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('opens without using the link, and says where it is in codes: no street, no name, no money, no carrier text', async () => {
    expect((await linkCall(mailedToken, 'POST', '/link/open', {})).statusCode).toBe(200)
    const read = await linkCall(mailedToken, 'GET', '/link/tracking')
    expect(read.statusCode, read.body).toBe(200)
    const page = read.json()
    expect(page.shipment).toMatchObject({ number: 'SEED-SH-0001', status: 'SHIPPED', transportBy: 'CARRIER', carrierName: 'Seed Express' })
    expect(page.order).toEqual({ customerRef: 'SEED-PO-78', number: 'SEED-SO-0002' })
    expect(page.pill).toBe('IN_TRANSIT')
    expect(page.steps.map((step: Json) => [step.code, step.state])).toEqual([
      ['PACKED', 'DONE'],
      ['COLLECTED', 'DONE'],
      ['IN_TRANSIT', 'CURRENT'],
      ['OUT_FOR_DELIVERY', 'TODO'],
      ['DELIVERED', 'TODO'],
    ])
    expect(page.parcels).toHaveLength(2)
    expect(page.events.length).toBeGreaterThan(0)
    expect(Object.keys(page.events[0]).sort()).toEqual(['id', 'occurredAt', 'parcelSeq', 'place', 'status'])
    expect(page.delivery).toEqual({ city: 'Seedville', postcode: '00000', country: 'IT' })
    expect(page.claim).toEqual({ held: null })
    expect(page.link.via).toBe('SHIPPED')
    expect(page.papers.shown).toBe(true)
    expect(read.body).not.toMatch(/Via Esempio|Seed Racing workshop|description/)
    expect(read.body).not.toMatch(MONEY_KEY)
    expect((await one(`SELECT uses FROM "OneOffLink" WHERE "recordId" = $1 AND email = $2`, [SH1, BUYER_MAIL])).uses).toBe(0)
  })

  it('lists the packing list as a paper and downloads it as evidence, never a use; nothing else of the shipment', async () => {
    const printed = await office.post(`/shipping/shipments/${SH1}/packing-list`, {}, { headers: { 'idempotency-key': key() } })
    expect(printed.status, JSON.stringify(printed.body)).toBe(201)
    const papers = (await linkCall(mailedToken, 'GET', '/link/tracking')).json().papers
    expect(papers.files.map((file: Json) => file.kind)).toEqual(['PACKING_LIST'])
    const fileId = papers.files[0].fileId
    const download = await linkCall(mailedToken, 'POST', `/link/tracking/papers/${fileId}/download`, {})
    expect(download.statusCode, download.body).toBe(200)
    expect(download.json().download.url).toBeTruthy()
    const actions = await admin<{ action: string }>(`SELECT action::text FROM "LinkEvidence" WHERE "linkId" = (SELECT id FROM "OneOffLink" WHERE "recordId" = $1 AND email = $2)`, [SH1, BUYER_MAIL])
    expect(actions.map((row) => row.action).sort()).toEqual(['DOWNLOADED', 'OPENED'])
    expect((await one(`SELECT uses FROM "OneOffLink" WHERE "recordId" = $1 AND email = $2`, [SH1, BUYER_MAIL])).uses).toBe(0)
    // REFUSED: a file of the shipment that is no paper of the page (a carrier label of a parcel), and a made-up id.
    const label = await admin(`SELECT id FROM "StoredFile" WHERE "recordType" = 'Parcel' LIMIT 1`)
    for (const other of [...label.map((row) => row.id as string), newId()]) expect((await linkCall(mailedToken, 'POST', `/link/tracking/papers/${other}/download`, {})).statusCode).toBe(404)
  })
})

let copied = ''

describe('the office: send, pass on, withdraw (warehouse.shipments › Tracking & delivery)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists who gets it and the links made, never a token', async () => {
    const read = await office.get(`/shipping/shipments/${SH1}/tracking-links`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    const tracking = read.body.tracking
    expect(tracking.recipients).toEqual([{ contactId: seedUuid(NS, 'party-contact:P1:buyer'), name: 'Seed Buyer One', email: BUYER_MAIL }])
    expect(tracking.links).toHaveLength(1)
    expect(tracking.links[0]).toMatchObject({ email: BUYER_MAIL, via: 'SHIPPED', state: 'LIVE', automatic: true })
    expect(tracking).toMatchObject({ held: null, mayManage: true, searches: { count: 0, lastAt: null } })
    expect(JSON.stringify(read.body)).not.toContain('token')
  })

  it('makes a link to pass on (its address once) and mails one to an address; a viewer may do neither', async () => {
    const made = await office.post(`/shipping/shipments/${SH1}/tracking-links`, { send: false }, { headers: { 'idempotency-key': key() } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    expect(made.body.links).toEqual([expect.objectContaining({ email: null, delivery: null })])
    copied = tokenOf(made.body.url)
    expect((await linkCall(copied, 'GET', '/link/tracking')).json().link.via).toBe('OFFICE')
    const mailed = await office.post(`/shipping/shipments/${SH1}/tracking-links`, { send: true, email: 'Shop.Front@brand-store.example', language: 'en' }, { headers: { 'idempotency-key': key() } })
    expect(mailed.status, JSON.stringify(mailed.body)).toBe(201)
    expect(mailed.body).toMatchObject({ url: null, links: [{ email: 'shop.front@brand-store.example', delivery: 'SENT' }] })
    expect(textOf(trackingMails('shop.front@brand-store.example')[0]!.raw)).toContain('your order SEED-PO-78 is on its way')
    expect(mailed.body.tracking.links.map((link: Json) => link.via)).toEqual(['OFFICE', 'OFFICE', 'SHIPPED'])
    // REFUSED: a viewer (shipping.view only).
    expect((await viewer.post(`/shipping/shipments/${SH1}/tracking-links`, { send: false }, { headers: { 'idempotency-key': key() } })).status).toBe(403)
    expect((await viewer.get(`/shipping/shipments/${SH1}/tracking-links`)).body.tracking.mayManage).toBe(false)
  })

  it('withdraws the link passed on: it opens nothing from now on (the one 404)', async () => {
    const linkId = (await one(`SELECT id FROM "OneOffLink" WHERE "recordId" = $1 AND email IS NULL AND note = $2`, [SH1, TRACKING_NOTES.OFFICE])).id
    const revoked = await office.post(`/shipping/shipments/${SH1}/tracking-links/${linkId}/revoke`, {}, { headers: { 'idempotency-key': key() } })
    expect(revoked.status, JSON.stringify(revoked.body)).toBe(200)
    expect(revoked.body.tracking.links.find((link: Json) => link.id === linkId).state).toBe('REVOKED')
    expect((await linkCall(copied, 'GET', '/link/tracking')).statusCode).toBe(404)
  })
})

describe('Copy tracking link in the portal (portal.customer.orders › Shipments)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('gives the customer a link to pass on; another customer finds nothing', async () => {
    const orderId = (await one(`SELECT "salesOrderId" FROM "Shipment" WHERE id = $1`, [SH1]))['salesOrderId']
    const url = `/portal/sales-orders/${orderId}/shipments/${SH1}/tracking-link`
    const made = await portal.buyer.post(url, {}, { headers: { 'idempotency-key': key() } })
    expect(made.status, JSON.stringify(made.body)).toBe(201)
    const page = await linkCall(tokenOf(made.body.url), 'GET', '/link/tracking')
    expect(page.json()).toMatchObject({ link: { via: 'PORTAL' }, papers: { shown: true } })
    expect((await portal.other.post(url, {}, { headers: { 'idempotency-key': key() } })).status).toBe(404)
  })
})

describe('Find your order: the public search by order reference and postcode (sec:search)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('finds the shipment by the customer\'s reference and the postcode as typed, with a one-day link that shows no papers and opens no claim', async () => {
    const found = await search({ tenant: NS, company: 'SCA', reference: ' seed-po-78 ', postcode: '000 00' })
    expect(found.statusCode, found.body).toBe(200)
    const [hit] = found.json().shipments
    expect(hit).toMatchObject({ number: 'SEED-SH-0001', status: 'SHIPPED' })
    const page = (await linkCall(hit.token, 'GET', '/link/tracking')).json()
    expect(page).toMatchObject({ link: { via: 'SEARCH' }, papers: { shown: false, files: [] }, claim: { held: 'SEARCH' } })
    const row = await one(`SELECT "expiresAt", "createdAt", email FROM "OneOffLink" WHERE note = $1 ORDER BY "createdAt" DESC LIMIT 1`, [TRACKING_NOTES.SEARCH])
    expect(new Date(row.expiresAt).getTime() - new Date(row.createdAt).getTime()).toBe(24 * 60 * 60 * 1000)
    expect(row.email).toBeNull()
    // Our order number finds it too; the office counts the search's links apart from its own.
    expect((await search({ tenant: NS, company: 'SCA', reference: 'SEED-SO-0002', postcode: '00000' })).json().shipments).toHaveLength(1)
    const tracking = (await office.get(`/shipping/shipments/${SH1}/tracking-links`)).body.tracking
    expect(tracking.searches.count).toBe(2)
    expect(tracking.links.every((link: Json) => link.via !== 'SEARCH')).toBe(true)
  })

  it('answers ONE thing for a miss, whatever was wrong, and asks a proof of work after repeated misses from one network', async () => {
    const misses = [
      { tenant: NS, company: 'SCA', reference: 'SEED-PO-78', postcode: '40100' },
      { tenant: NS, company: 'SCA', reference: 'NO-SUCH-ORDER', postcode: '00000' },
      { tenant: 'no-such-tenant', company: 'SCA', reference: 'SEED-PO-78', postcode: '00000' },
      // The tenant has two companies: without the company's code the search names none.
      { tenant: NS, reference: 'SEED-PO-78', postcode: '00000' },
      { tenant: NS, company: 'ZZZ', reference: 'SEED-PO-78', postcode: '00000' },
    ]
    for (const body of misses) {
      const answer = await search(body, '198.51.100.20')
      expect(answer.statusCode, answer.body).toBe(200)
      expect(answer.body).toBe('{"shipments":[]}')
    }
    // REFUSED in words at the field before anything is looked up.
    const empty = await search({ tenant: NS, company: 'SCA', reference: ' ', postcode: '' }, '198.51.100.20')
    expect(empty.statusCode).toBe(400)
    expect(empty.json().error.issues.map((issue: Json) => issue.path)).toEqual(['body/reference', 'body/postcode'])
    for (let i = 0; i < 5; i++) await search({ tenant: NS, company: 'SCA', reference: `GUESS-${i}`, postcode: '00000' }, '198.51.100.20')
    const challenged = await search({ tenant: NS, company: 'SCA', reference: 'GUESS-X', postcode: '00000' }, '198.51.100.20')
    expect(challenged.statusCode, challenged.body).toBe(429)
    expect(challenged.json().error.issues.map((issue: Json) => issue.path)).toContain('challenge')
    // Another network is not held.
    expect((await search({ tenant: NS, company: 'SCA', reference: 'SEED-PO-78', postcode: '00000' }, '192.0.2.44')).json().shipments).toHaveLength(1)
  })
})

describe('Ask for a new link on a dead tracking link', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('mails a new link to the address the dead one went to, once; a withdrawn one gets nothing', async () => {
    const before = trackingMails(BUYER_MAIL).length
    const all = () => h.ses.mails.filter((mail) => mail.templateKey === 'shipping.tracking_link').length
    const sentBefore = all()
    // REFUSED (silently): the withdrawn link passed on.
    expect((await linkCall(copied, 'POST', '/link/renew', {})).statusCode).toBe(202)
    await h.auth.settled()
    expect(all()).toBe(sentBefore)
    h.clock.advance(181 * 24 * 60 * 60 * 1000)
    expect((await linkCall(mailedToken, 'GET', '/link/tracking')).statusCode).toBe(404)
    expect((await linkCall(mailedToken, 'POST', '/link/renew', {})).statusCode).toBe(202)
    await h.auth.settled()
    const mails = trackingMails(BUYER_MAIL)
    expect(mails).toHaveLength(before + 1)
    expect(textOf(mails.at(-1)!.raw)).toContain('come richiesto, ecco un nuovo link per seguire il suo ordine SEED-PO-78')
    const renewed = await one(`SELECT "renewalOfId", note FROM "OneOffLink" WHERE "recordId" = $1 AND note = $2`, [SH1, TRACKING_NOTES.RENEWED])
    expect(renewed.renewalOfId).toBe((await one(`SELECT id FROM "OneOffLink" WHERE "recordId" = $1 AND note = $2`, [SH1, TRACKING_NOTES.SHIPPED])).id)
    expect((await linkCall(tokenOfMail(mails.at(-1)!.raw), 'GET', '/link/tracking')).statusCode).toBe(200)
  })
})
