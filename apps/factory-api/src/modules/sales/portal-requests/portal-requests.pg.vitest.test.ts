import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { systemContext } from '../../../platform/outbox/system'
import { partnerFanOut } from '../../../platform/portal/notifications/fan-out'
import { unsubscribeKeyOf } from '../../../platform/portal/notifications/mail'
import { assignInquiry, askInfo, declineInquiry, updateInquiry } from '../inquiries/inquiries'
import { quoteInquiry } from '../inquiries/quote'
import { numberingMissingFindings } from './open'
// th-backend-g step 2: the receipt mail.
import { headerOf, textOf } from '../../../adapters/ses/fake'
import { sendRequestReceipt } from '../inquiries/receipt'

/**
 * The customer's request through the portal (threads plan TH-1b: B-TH-010 send, B-TH-103 reads, B-TH-011 states and news,
 * B-TH-105 its own numbers, B-TH-012 the door's numbering) on the local stack, through the real app and the real portal sign-in
 * by code: the seeds up to the sales intake (P1 = SEED-C1 with its own label SEED-JKT-01, the INQUIRY series of company A,
 * P1's request SEED-INQ-0004 that became a quote), P1's portal and another customer's ("Brand Alpha", portalWorld) switched on,
 * a buyer of each. The office acts through the module's functions with an office caller (a sales person of the tenant).
 *   W37 / T37   the other customer never lists, opens or finds P1's request, and cannot post into it
 *   W11 / T11   the request's company and party are the session's: a body naming another party is refused by the contract
 *   T09         the Inquiry partner view: 404 and no search hit for another customer
 *   W05 / §0    the other customer's requests never move P1's own numbers
 *   W06 / W07   the news of P1's request reach P1's people only
 * Every name, number and word is made up. Run with `node scripts/factory/run-pg-tests.mjs portal-requests`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'th1b-portal-requests'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const people = { buyer: 'bea.buyer@th1b-requests.example.com', other: 'olga.buyer@th1b-requests.example.net' }
const browsers = {} as Record<keyof typeof people, Browser>

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
let keySerial = 0
const call = (browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const ADA = newId()
const sales = templateOf('sales')!
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const officeKey = () => `th1b-office-${++keySerial}-${Date.now()}`
const version = async (id: string) => (await one<{ version: number }>('SELECT version FROM "Inquiry" WHERE id = $1', [id])).version

async function partnerPerson(email: string, partyId: string, roleKeys: string[]): Promise<void> {
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

/** The partner news of the events of a record since `since` (the worker's partner fan-out, run here). */
async function fanOutPartner(subject: string, since: Date): Promise<void> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND subject = $2 AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [T, subject, since])
  for (const row of rows) {
    await partnerFanOut(callerFor(h.database, systemContext(T, `test-${newId()}`)), { eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload } as never, { clock: h.clock, unsubscribeKey: unsubscribeKeyOf(h.auth.secrets) })
  }
}
const newsOf = (partyId: string, recordId: string) => admin<{ messageKey: string; params: Json }>(`SELECT "messageKey", params FROM "Notification" WHERE "partyId" = $1 AND "recordId" = $2 ORDER BY "createdAt", id`, [partyId, recordId])

let sent: Json
/** The office's own number of P1's request (INQ-…): the office reads it; the customer never does (th2-backend step 7). */
let officeNumber = ''
let otherSent: Json

beforeAll(async () => {
  h = await startHarness('th1b_portal_requests')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
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
    const salesRole = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.sales@th1b-requests.example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: ADA, roleId: salesRole.id, allCompanies: true, validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer', 'partner-comment'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  h.clock.set(new Date(Date.now() - 2_000))
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  await h?.close()
})

describe('the customer sends a request (B-TH-010, B-TH-012)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the door is open while the company has request numbering', async () => {
    expect(await ok(browsers.buyer, 'GET', '/portal/inquiries/open')).toEqual({ open: true, reason: null })
  })

  it("makes an Inquiry of the session's company and party, numbered INQ-…, its words the thread's first message, a receipt with its own number", async () => {
    const address = await one<{ id: string }>(`SELECT id FROM "PartyAddress" WHERE "partyId" = $1 AND 'SHIP_TO' = ANY(kinds) ORDER BY id LIMIT 1`, [P1])
    sent = await ok(browsers.buyer, 'POST', '/portal/inquiries', { subject: 'Team jackets for the spring', message: 'Made-up: 30 black jackets with our logo, sizes 50 to 54.\nSee you soon.', customerRef: 'BA-PO-4521', shipToAddressId: address.id }, 201)
    // th2-backend step 7 (§0.5, counts do not leak): the customer reads its own number only, never the office's INQ-… series.
    expect(sent.receipt).toMatchObject({ number: '#2', subject: 'Team jackets for the spring', yourNumber: { seq: 2, words: { en: 'Your request 2', it: 'La vostra richiesta 2' } } })
    expect(sent.receipt.words).toEqual({ en: 'Received — Your request 2.', it: 'Ricevuta — La vostra richiesta 2.' })
    expect(JSON.stringify(sent)).not.toMatch(/INQ-\d{4}-\d{4}/)
    officeNumber = (await one<{ number: string }>('SELECT number FROM "Inquiry" WHERE id = $1', [sent.request.id])).number
    expect(officeNumber).toMatch(/^INQ-\d{4}-\d{4}$/)
    expect(sent.request).toMatchObject({ number: sent.receipt.number, customerRef: 'BA-PO-4521', subject: 'Team jackets for the spring', source: 'PORTAL', state: { code: 'SENT', open: true, needsYou: false }, shipTo: { id: address.id, waiting: false }, lines: [], made: { quote: null, order: null } })
    const row = await one(`SELECT "companyId", "partyId", source::text AS source, status::text AS status, request, "createdById", "customerSeq" FROM "Inquiry" WHERE id = $1`, [sent.request.id])
    expect(row).toEqual({ companyId: companyA, partyId: P1, source: 'PORTAL', status: 'NEW', request: 'Team jackets for the spring\n\nMade-up: 30 black jackets with our logo, sizes 50 to 54.\nSee you soon.', createdById: null, customerSeq: 2 })
    // The first message: INBOUND, PORTAL, by the person's name, shared with P1 only.
    const [first] = await admin(`SELECT m.direction::text AS direction, m.channel::text AS channel, m."authorKind"::text AS "authorKind", m."authorName", m."partyId", m."bodyText" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Inquiry' AND t."recordId" = $1`, [sent.request.id])
    expect(first).toEqual({ direction: 'INBOUND', channel: 'PORTAL', authorKind: 'PARTY', authorName: 'bea.buyer', partyId: P1, bodyText: row.request })
    // The customer reads it in its thread.
    const thread = await ok(browsers.buyer, 'GET', `/portal/threads/Inquiry/${sent.request.id}`)
    expect(JSON.stringify(thread)).toContain('30 black jackets')
  })

  it("never takes a party, a company or another's address from the body (W11), nor words the guard refuses", async () => {
    expect((await call(browsers.buyer, 'POST', '/portal/inquiries', { message: 'x', partyId: world.partyId })).status).toBe(400)
    expect((await call(browsers.buyer, 'POST', '/portal/inquiries', { message: 'x', companyId: companyA })).status).toBe(400)
    expect((await call(browsers.buyer, 'POST', '/portal/inquiries', { message: '   ' })).status).toBe(400)
    const foreign = await one<{ id: string }>(`SELECT id FROM "PartyAddress" WHERE "partyId" <> $1 AND 'SHIP_TO' = ANY(kinds) ORDER BY id LIMIT 1`, [P1])
    const refused = await call(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: deliver there.', shipToAddressId: foreign.id })
    expect(refused.status).toBe(400)
    expect(JSON.stringify(refused.body)).toContain('Not one of your delivery addresses.')
    expect((await call(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up.', wantedDate: '2020-01-01' })).status).toBe(400)
  })

  it("the other customer's request is numbered its own way and never moves P1's numbers (plan §0 counts, W05)", async () => {
    otherSent = await ok(browsers.other, 'POST', '/portal/inquiries', { message: 'Made-up: ten rain covers.' }, 201)
    expect(otherSent.receipt.yourNumber).toMatchObject({ seq: 1 })
    expect(otherSent.receipt.subject).toBe('Made-up: ten rain covers.')
    const p1 = await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: and ten pairs of gloves.' }, 201)
    expect(p1.receipt.yourNumber).toMatchObject({ seq: 3 })
  })

  it("holds New order neutrally while the company has no request numbering, and the admins' alert names the company (B-TH-012)", async () => {
    await admin(`ALTER TABLE "NumberSeries" DISABLE TRIGGER USER`)
    await admin(`UPDATE "NumberSeries" SET status = 'CLOSED' WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INQUIRY'`, [T, companyA])
    await admin(`ALTER TABLE "NumberSeries" ENABLE TRIGGER USER`)
    try {
      const open = await ok(browsers.buyer, 'GET', '/portal/inquiries/open')
      expect(open.open).toBe(false)
      expect(open.reason.en).toMatch(/^Orders by portal are not open yet for .+ — please write to your contact\.$/)
      const held = await call(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: will this go?' })
      expect(held.status).toBe(409)
      expect(JSON.stringify(held.body)).toContain('not open yet')
      const findings = await h.database.withScope({ audience: 'office', tenantId: T, actorId: ADA }, (client) => numberingMissingFindings(client as never, { companyId: null, siteId: null }, new Date()))
      expect(findings).toEqual([expect.objectContaining({ recordType: 'Company', recordId: companyA, facts: { portalOn: true, inquiryAddresses: expect.any(Boolean) } })])
    } finally {
      await admin(`ALTER TABLE "NumberSeries" DISABLE TRIGGER USER`)
      await admin(`UPDATE "NumberSeries" SET status = 'ACTIVE' WHERE "tenantId" = $1 AND "companyId" = $2 AND kind = 'INQUIRY'`, [T, companyA])
      await admin(`ALTER TABLE "NumberSeries" ENABLE TRIGGER USER`)
    }
    const findings = await h.database.withScope({ audience: 'office', tenantId: T, actorId: ADA }, (client) => numberingMissingFindings(client as never, { companyId: null, siteId: null }, new Date()))
    expect(findings.map((finding) => finding.recordId)).not.toContain(companyA)
  })
})

describe("the customer's requests in the portal (B-TH-103, B-TH-105) and the brand wall", { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('lists its own requests, the office ones too, partner-first, with its own numbers and the tiles', async () => {
    const list = await ok(browsers.buyer, 'GET', '/portal/inquiries?state=ALL')
    const ids = list.rows.map((row: Json) => row.id)
    const seeded = (await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0004'`, [T])).id
    expect(ids).toContain(sent.request.id)
    expect(ids).toContain(seeded)
    expect(ids).not.toContain(otherSent.request.id)
    // th2-backend step 7: its own numbers only ("#1" for the office's SEED-INQ-0004), never the office's series.
    expect(list.rows.find((row: Json) => row.id === seeded)).toMatchObject({ number: '#1', yourNumber: { seq: 1 }, customerRef: 'SEED-BA-PO-12' })
    expect(JSON.stringify(list)).not.toMatch(/INQ-\d{4}-\d{4}|SEED-INQ/)
    expect(list.counts.open).toBeGreaterThanOrEqual(2)
    // Never an office column.
    expect(JSON.stringify(list)).not.toMatch(/assignee|closeNote|targetUnitPrice|prospect/)
  })

  it("the other customer never lists, opens, finds or posts into P1's request (T37, T09); a malformed id is not found", async () => {
    expect((await ok(browsers.other, 'GET', '/portal/inquiries?state=ALL')).rows.map((row: Json) => row.id)).toEqual([otherSent.request.id])
    expect((await call(browsers.other, 'GET', `/portal/inquiries/${sent.request.id}`)).status).toBe(404)
    expect((await call(browsers.other, 'GET', '/portal/inquiries/not-a-uuid')).status).toBe(400)
    expect((await call(browsers.other, 'GET', `/portal/threads/Inquiry/${sent.request.id}`)).status).toBe(404)
    expect((await call(browsers.other, 'POST', `/portal/threads/Inquiry/${sent.request.id}/messages`, { body: 'Made-up: hello' })).status).toBe(404)
    const search = await call(browsers.other, 'GET', `/portal/search?q=${encodeURIComponent(officeNumber)}`)
    expect(JSON.stringify(search.body)).not.toContain(sent.request.id)
    expect(JSON.stringify({ ...search.body, query: null, words: null })).not.toContain(officeNumber)
    // P1 finds its own by its PO; the hit names its own number ("#2"), never the office's (th2-backend step 7).
    const own = (await call(browsers.buyer, 'GET', `/portal/search?q=${encodeURIComponent('BA-PO-4521')}`)).body
    expect(JSON.stringify(own)).toContain(sent.request.id)
    expect(JSON.stringify(own)).toContain('"ourRef":"#2"')
    expect(JSON.stringify(own)).not.toMatch(/INQ-\d{4}-\d{4}/)
  })
})

describe('the real state of the request, its news and live (B-TH-011)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('Sent → Being reviewed → We need something from you → Quote being prepared; the news reach P1 only', async () => {
    const since = new Date(Date.now() - 600_000)
    await fanOutPartner(sent.request.id, since)
    expect((await newsOf(P1, sent.request.id)).map((row) => row.messageKey)).toEqual(['portal.request.received'])
    expect(await newsOf(world.partyId, sent.request.id)).toEqual([])
    const id = sent.request.id
    await assignInquiry(office(), id, { version: await version(id), assigneeId: ADA }, officeKey())
    expect((await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)).request.state).toMatchObject({ code: 'BEING_REVIEWED', words: { en: 'Being reviewed' } })
    const asked = new Date()
    await askInfo(office(), id, { version: await version(id), message: { body: 'Made-up: which colour for the logo?' } }, officeKey())
    const waiting = (await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)).request
    expect(waiting.state).toMatchObject({ code: 'NEED_INFO', needsYou: true, words: { en: 'We need something from you' } })
    expect((await ok(browsers.buyer, 'GET', '/portal/inquiries')).counts.needsYou).toBe(1)
    await fanOutPartner(id, asked)
    expect((await newsOf(P1, id)).map((row) => row.messageKey)).toContain('portal.request.need_info')
    expect(await newsOf(world.partyId, id)).toEqual([])
    // The office answers with a quote draft: "Quote being prepared", no quote number before it is sent.
    await updateInquiry(office(), id, { version: await version(id), lines: [{ styleId: seedUuid(NS, 'product:style:JKT-01'), colourwayId: seedUuid(NS, 'product:colourway:JKT-01:BLK'), sizes: { '50': 10, '52': 10 } }] }, officeKey())
    // The customer's words stay as sent (L2-G02).
    await expect(updateInquiry(office(), id, { version: await version(id), request: 'Changed by the office.' }, officeKey())).rejects.toThrow(/keeps the customer's words/)
    await quoteInquiry(office(), id, { version: await version(id) }, officeKey())
    const quoted = (await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)).request
    expect(quoted.state).toMatchObject({ code: 'QUOTE_BEING_PREPARED', words: { en: 'Quote being prepared' } })
    expect(quoted.made).toEqual({ quote: null, order: null })
  })

  it("the office cannot put another customer's private label on a request (PR-05); a decline is news to its own customer only", async () => {
    const other = otherSent.request.id
    await expect(updateInquiry(office(), other, { version: await version(other), lines: [{ styleId: seedUuid(NS, 'product:style:JKT-01') }] }, officeKey())).rejects.toThrow(/another customer's private-label style/)
    const since = new Date()
    await declineInquiry(office(), other, { version: await version(other), reason: 'CAPACITY' }, officeKey())
    expect((await ok(browsers.other, 'GET', `/portal/inquiries/${other}`)).request.state).toMatchObject({ code: 'DECLINED', open: false })
    await fanOutPartner(other, since)
    expect((await newsOf(world.partyId, other)).map((row) => row.messageKey)).toEqual(['portal.request.declined'])
    expect(await newsOf(P1, other)).toEqual([])
    // Closed requests stay findable under "Closed".
    expect((await ok(browsers.other, 'GET', '/portal/inquiries?state=CLOSED')).rows.map((row: Json) => row.id)).toEqual([other])
  })
})

// ---- follow-up th-backend-d (Not an order → Closed): the customer's own search reads the word its request page reads. A request
// declined as "Not an order" is CLOSED in the portal search too (the decline reason is an office column the partner role never reads:
// the view reads it through the person's reader in the tenant, B-TH-073's way); a request declined for another reason stays DECLINED; nothing leaks.
describe('follow-up th-backend-d: the portal search says Closed for a "Not an order" request', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('Not an order → CLOSED in the search and on the request page; a capacity decline stays DECLINED; another customer finds neither', async () => {
    const notAnOrder = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: please add us to your newsletter.', customerRef: 'BA-PO-NAO-9' }, 201)).request.id as string
    const capacity = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: 900 racing suits by next week.', customerRef: 'BA-PO-CAP-8' }, 201)).request.id as string
    await declineInquiry(office(), notAnOrder, { version: await version(notAnOrder), reason: 'NOT_AN_ORDER' }, officeKey())
    await declineInquiry(office(), capacity, { version: await version(capacity), reason: 'CAPACITY' }, officeKey())
    expect((await ok(browsers.buyer, 'GET', `/portal/inquiries/${notAnOrder}`)).request.state).toMatchObject({ code: 'CLOSED', words: { en: 'Closed' } })

    const hit = async (ref: string) => {
      const answer = await ok(browsers.buyer, 'GET', `/portal/search?q=${encodeURIComponent(ref)}`)
      return (answer.groups as Json[]).flatMap((group) => group.results as Json[]).find((result) => result.theirRef === ref)
    }
    expect(await hit('BA-PO-NAO-9')).toMatchObject({ recordType: 'Inquiry', recordId: notAnOrder, status: 'CLOSED', ourRef: expect.stringMatching(/^#\d+$/) })
    expect(await hit('BA-PO-CAP-8')).toMatchObject({ recordType: 'Inquiry', recordId: capacity, status: 'DECLINED' })
    // The office's reason never reaches the customer's answer.
    const answer = await ok(browsers.buyer, 'GET', `/portal/search?q=${encodeURIComponent('BA-PO-NAO-9')}`)
    expect(JSON.stringify(answer)).not.toMatch(/NOT_AN_ORDER|declineReason/)
    // The other customer finds neither by their references.
    for (const ref of ['BA-PO-NAO-9', 'BA-PO-CAP-8']) expect(JSON.stringify((await call(browsers.other, 'GET', `/portal/search?q=${encodeURIComponent(ref)}`)).body)).not.toContain(ref === 'BA-PO-NAO-9' ? notAnOrder : capacity)
  })
})
// ---- end follow-up th-backend-d

// ---- th-backend-g step 2 (threads plan B-TH-279 "request received — the receipt with its number"; P-CUS-NEW.receipt-F02 "a 'request
// received' mail in their language; the page says so if it could not be sent"): the receipt goes to the ONE person who sent the request,
// at once, once per request, in the customer's language, with the customer's own number (never the office's INQ-…); the reply lands on
// the request's thread; the portal's own notice of the request is not mailed to that person as well.
describe('th-backend-g step 2: the receipt mail goes to the person who sent the request — them only, once', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('one receipt per portal request, to its sender only; its own number, never the office series; the answer said it went', async () => {
    expect(sent.receipt.mailed).toBe(true)
    expect(otherSent.receipt.mailed).toBe(true)
    const receipts = await admin<{ id: string; recordId: string; to: string[]; subject: string }>(`SELECT id, "recordId", "to", subject FROM "EmailOutbound" WHERE "tenantId" = $1 AND "templateKey" = 'request.received' ORDER BY "createdAt", id`, [T])
    const ofBuyer = await admin<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND "partyId" = $2 AND source = 'PORTAL'`, [T, P1])
    expect(ofBuyer.length).toBeGreaterThanOrEqual(2)
    for (const request of ofBuyer) expect(receipts.filter((row) => row.recordId === request.id).map((row) => row.to)).toEqual([[people.buyer]])
    expect(receipts.filter((row) => row.recordId === otherSent.request.id).map((row) => row.to)).toEqual([[people.other]])
    // Never to anyone else: every receipt went to the one person who sent its request.
    expect(new Set(receipts.flatMap((row) => row.to))).toEqual(new Set([people.buyer, people.other]))
    const first = receipts.find((row) => row.recordId === sent.request.id)!
    expect(first.subject).toMatch(/^(We received your request 2|Abbiamo ricevuto la vostra richiesta 2)$/)
    const mail = h.ses.mails.find((one) => one.outboundId === first.id)!
    expect(mail.to).toEqual([people.buyer])
    const text = textOf(mail.raw)
    expect(text).toContain('Team jackets for the spring')
    expect(text).not.toMatch(/INQ-\d{4}-\d{4}/)
    expect(text).not.toContain(officeNumber)
    expect(text).not.toContain('ten rain covers') // the other customer's words
    const thread = await one<{ replyToken: string }>(`SELECT "replyToken" FROM "Thread" WHERE "recordType" = 'Inquiry' AND "recordId" = $1`, [sent.request.id])
    expect(headerOf(mail.raw, 'Reply-To')).toContain(`r-${thread.replyToken}@`)
    expect(headerOf(mail.raw, 'Auto-Submitted')).toBe('auto-generated')
  })

  it('the portal notice of the request is not mailed to its sender as well (said in the delivery log); a second send finds the first receipt', async () => {
    const notice = await one<{ id: string }>(`SELECT n.id FROM "Notification" n JOIN "User" u ON u.id = n."userId" WHERE n."recordId" = $1 AND n."messageKey" = 'portal.request.received' AND u.email = $2`, [sent.request.id, people.buyer])
    expect(await admin(`SELECT outcome::text AS outcome, detail FROM "NotificationDelivery" WHERE "notificationId" = $1`, [notice.id])).toEqual([{ outcome: 'SKIPPED', detail: 'the person who sent the request gets its receipt mail' }])
    const again = await sendRequestReceipt(callerFor(h.database, systemContext(T, `test-${newId()}`)), h.email, { inquiryId: sent.request.id, to: { email: people.buyer, name: 'bea.buyer', language: null }, clock: h.clock })
    expect(again.sent).toBe(true)
    expect((await admin(`SELECT id FROM "EmailOutbound" WHERE "recordId" = $1 AND "templateKey" = 'request.received'`, [sent.request.id])).length).toBe(1)
  })
})
// ---- end th-backend-g step 2
