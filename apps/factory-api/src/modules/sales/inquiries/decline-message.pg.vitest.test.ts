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
import { REQUEST_NEWS_RULES } from '../../../platform/portal/notifications/rules/requests'
import { declineInquiries, declineInquiry, readInquiry } from './inquiries'

/**
 * Decline with one message, and Not an order (B-TH-043; threads plan G6, N13; O-SAL-INQ-LIST.pane-actions-F06/F11; wall W20) on
 * the local stack, through the real app and the real portal sign-in by code (the seeds up to the sales intake; P1's portal and
 * another customer's switched on, a buyer of each). The office acts through the module's functions with an office caller.
 *   - the record names where a message goes before anything is sent (portal, or the contact's address; none for a prospect);
 *   - a portal request: the decline's ONE message is a reply the customer reads in its portal, beside "Declined";
 *   - a phone request: the message is a mail on the request's thread; W20: an address of another customer is refused without
 *     "Send outside this customer" (nothing changes), and goes with the tick;
 *   - "Not an order": it takes no message (words), sends nothing, gives no "declined" notice, and the customer reads "Closed";
 *   - a decline of several never sends; a prospect's request takes no message.
 * Every name and word is made up. Run with `node scripts/factory/run-pg-tests.mjs inquiries/decline-message`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'th3-decline-msg'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const people = { buyer: 'bea.buyer@th3-decline.example.com', other: 'olga.buyer@th3-decline.example.net' }
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
const officeKey = () => `th3-decline-${++keySerial}-${Date.now()}`
const version = async (id: string) => (await one<{ version: number }>('SELECT version FROM "Inquiry" WHERE id = $1', [id])).version
const statusOf = async (id: string) => one<{ status: string; reason: string | null }>('SELECT status::text AS status, "declineReason"::text AS reason FROM "Inquiry" WHERE id = $1', [id])
const outbound = (id: string) => admin(`SELECT m.channel::text AS channel, m."bodyText", m."partyId" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordType" = 'Inquiry' AND t."recordId" = $1 AND m.direction = 'OUTBOUND' ORDER BY m.at`, [id])
const mails = (id: string) => admin(`SELECT "to", subject FROM "EmailOutbound" WHERE "recordType" = 'Inquiry' AND "recordId" = $1 ORDER BY "queuedAt"`, [id])
const seeded = async (number: string) => (await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = $2`, [T, number])).id

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

beforeAll(async () => {
  h = await startHarness('th3_decline_msg')
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
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'CONVERSATION', domain: `conv.${NS}.example.com`, fromAddress: `noreply@conv.${NS}.example.com`, displayName: 'Seed A', displayNamePolicy: 'PERSON_VIA_COMPANY', replyDomain: `reply.conv.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
    const salesRole = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.sales@th3-decline.example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
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

describe('Decline with one message (B-TH-043)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a portal request: the record names the portal first; the ONE message is a reply the customer reads beside “Declined”', async () => {
    const id = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: 300 vests by Friday?' }, 201)).request.id
    expect((await readInquiry(office(), id)).messageTo).toMatchObject({ via: 'PORTAL', to: [], refusal: null })
    await declineInquiry(office(), id, { version: await version(id), reason: 'CAPACITY', message: { body: 'Made-up: we are full until spring, sorry.' } }, officeKey())
    expect(await statusOf(id)).toEqual({ status: 'DECLINED', reason: 'CAPACITY' })
    expect(await outbound(id)).toEqual([{ channel: 'PORTAL', bodyText: 'Made-up: we are full until spring, sorry.', partyId: P1 }])
    expect(await mails(id)).toEqual([])
    const audit = await one(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'sales.inquiries.decline'`, [id])
    expect(audit.after).toMatchObject({ status: 'DECLINED', sent: 'PORTAL' })
    expect((await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)).request.state.code).toBe('DECLINED')
    expect(JSON.stringify(await ok(browsers.buyer, 'GET', `/portal/threads/Inquiry/${id}`))).toContain('full until spring')
    // W37 / W08: another customer finds neither the request nor its message.
    expect((await call(browsers.other, 'GET', `/portal/inquiries/${id}`)).status).toBe(404)
    expect((await call(browsers.other, 'GET', `/portal/threads/Inquiry/${id}`)).status).toBe(404)
  })

  it('a phone request: a mail to its contact; W20 — another customer’s address is refused without the tick, goes with it', async () => {
    const id = await seeded('SEED-INQ-0002')
    expect((await readInquiry(office(), id)).messageTo).toMatchObject({ via: 'MAIL', to: ['buyer.p3@example.com'], refusal: null })
    // P1's portal buyer is another customer's person on P3's request: refused in words, and nothing changes (both or neither).
    await expect(declineInquiry(office(), id, { version: await version(id), reason: 'LEAD_TIME', message: { body: 'Made-up: not before May.', to: [people.buyer] } }, officeKey())).rejects.toThrow()
    expect(await statusOf(id)).toEqual({ status: 'ASSIGNED', reason: null })
    expect(await mails(id)).toEqual([])
    await declineInquiry(office(), id, { version: await version(id), reason: 'LEAD_TIME', message: { body: 'Made-up: not before May.', subject: 'Your reorder', to: [people.buyer], sendOutside: true } }, officeKey())
    expect(await statusOf(id)).toEqual({ status: 'DECLINED', reason: 'LEAD_TIME' })
    expect(await mails(id)).toEqual([{ to: [people.buyer], subject: 'Your reorder' }])
    expect((await one(`SELECT after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'sales.inquiries.decline'`, [id])).after).toMatchObject({ sent: 'MAIL' })
  })

  it('“Not an order”: no message (words), nothing sent, no “declined” notice, the customer reads “Closed”', async () => {
    const id = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: do you have a catalogue?' }, 201)).request.id
    await expect(declineInquiry(office(), id, { version: await version(id), reason: 'NOT_AN_ORDER', message: { body: 'Made-up: hello' } }, officeKey())).rejects.toThrow(/Not an order/)
    expect((await statusOf(id)).status).toBe('NEW')
    await declineInquiry(office(), id, { version: await version(id), reason: 'NOT_AN_ORDER' }, officeKey())
    expect(await statusOf(id)).toEqual({ status: 'DECLINED', reason: 'NOT_AN_ORDER' })
    expect(await outbound(id)).toEqual([])
    expect(await mails(id)).toEqual([])
    const page = await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)
    expect(page.request.state).toMatchObject({ code: 'CLOSED', words: { en: 'Closed' }, open: false })
    // The reason itself never reaches the customer.
    expect(JSON.stringify(page)).not.toContain('NOT_AN_ORDER')
    const list = await ok(browsers.buyer, 'GET', '/portal/inquiries?state=ALL')
    expect(list.rows.find((row: Json) => row.id === id).state.code).toBe('CLOSED')
    // The portal news rule gives no "declined" notice for it (nothing is sent), and still does for a real decline.
    const real = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: 40 jackets at half price?' }, 201)).request.id
    await declineInquiry(office(), real, { version: await version(real), reason: 'PRICE' }, officeKey())
    const rule = REQUEST_NEWS_RULES.find((entry) => entry.name === 'portalNews.requestDeclined')!
    const event = (inquiryId: string, declineReason: string) => ({ inquiryId, number: 'INQ-X', status: 'DECLINED', previousStatus: 'NEW', quoteId: null, salesOrderId: null, declineReason, partyId: P1 })
    const drafts = (inquiryId: string, declineReason: string) => h.database.withScope({ audience: 'office', tenantId: T, actorId: ADA }, (client) => rule.drafts({ tx: client } as never, event(inquiryId, declineReason)))
    expect(await drafts(id, 'NOT_AN_ORDER')).toEqual([])
    expect((await drafts(real, 'PRICE')).map((draft) => [draft.partyId, draft.messageKey])).toEqual([[P1, 'portal.request.declined']])
    expect((await ok(browsers.buyer, 'GET', `/portal/inquiries/${real}`)).request.state.code).toBe('DECLINED')
  })

  it('a decline of several never sends; a prospect’s request takes no message', async () => {
    const first = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: first bulk request.' }, 201)).request.id
    const second = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: second bulk request.' }, 201)).request.id
    await declineInquiries(office(), { items: [{ inquiryId: first, version: await version(first) }, { inquiryId: second, version: await version(second) }], reason: 'PRICE' }, officeKey())
    for (const id of [first, second]) {
      expect(await statusOf(id)).toEqual({ status: 'DECLINED', reason: 'PRICE' })
      expect(await outbound(id)).toEqual([])
      expect(await mails(id)).toEqual([])
    }
    const prospect = await seeded('SEED-INQ-0001')
    expect((await readInquiry(office(), prospect)).messageTo).toMatchObject({ via: null, to: [], refusal: { code: 'NEEDS_CUSTOMER' } })
    await expect(declineInquiry(office(), prospect, { version: await version(prospect), reason: 'NOT_OUR_PRODUCT', message: { body: 'Made-up: not for us.' } }, officeKey())).rejects.toThrow(/make the customer first/)
    expect((await statusOf(prospect)).status).toBe('NEW')
  })
})
