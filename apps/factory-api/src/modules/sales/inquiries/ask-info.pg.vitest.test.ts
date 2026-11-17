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
import { assignInquiry, askInfo } from './inquiries'
import { resumeOnReplyHandler } from './resume-on-reply'

/**
 * Ask for info sends the question, and the customer's answer takes the request up again (B-TH-013; threads plan G4, PR-21) on
 * the local stack, through the real app and the real portal sign-in by code (the seeds up to the sales intake; P1's portal and
 * another customer's switched on, a buyer of each who may comment). The office acts through the module's functions with an
 * office caller; the worker's handler (resume-on-reply) runs here on the outbox's thread.message_posted.
 *   - a portal request: the question is a reply the customer reads in its portal; its answer there moves NEED_INFO back to
 *     ASSIGNED (someone keeps it) or NEW (nobody), by itself, with an audit row of the system;
 *   - a phone request of P3: the question is a mail on the request's thread to its contact (the recipient rule, B-TH-004);
 *   - a prospect's request takes no question until it is made a customer (words);
 *   - W08: a reply on one customer's thread never takes another customer's request up again.
 * Every name and word is made up. Run with `node scripts/factory/run-pg-tests.mjs inquiries/ask-info`.
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'th1b-ask-info'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const people = { buyer: 'bea.buyer@th1b-ask.example.com', other: 'olga.buyer@th1b-ask.example.net' }
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



beforeAll(async () => {
  h = await startHarness('th1b_ask_info')
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
    // The mail of a request's thread goes from the company's conversation identity.
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'CONVERSATION', domain: `conv.${NS}.example.com`, fromAddress: `noreply@conv.${NS}.example.com`, displayName: 'Seed A', displayNamePolicy: 'PERSON_VIA_COMPANY', replyDomain: `reply.conv.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
    const salesRole = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.sales@th1b-ask.example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
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


/** The worker's resume handler on the newest thread.message_posted of a record's thread since `since`. */
async function resumeOn(inquiryId: string, since: Date): Promise<void> {
  const rows = await admin(`SELECT * FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'thread.message_posted' AND subject = $2 AND "occurredAt" >= $3 ORDER BY "occurredAt", id`, [T, inquiryId, since])
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    await resumeOnReplyHandler().handle({ eventId: row.id, type: row.type, version: row.version, context: row.context, tenantId: row.tenantId, companyId: row.companyId, siteId: row.siteId, subject: row.subject, correlationId: row.correlationId, causationId: row.causationId, source: row.source, occurredAt: new Date(row.occurredAt).toISOString(), payload: row.payload } as never, { caller: callerFor(h.database, systemContext(T, `test-${newId()}`)), attempt: 1 })
  }
}
const statusOf = async (id: string) => (await one<{ status: string }>('SELECT status::text AS status FROM "Inquiry" WHERE id = $1', [id])).status

describe('Ask for info sends the question; the answer takes the request up again (B-TH-013)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('a portal request: the question is a portal reply; the customer’s answer moves it back to ASSIGNED by itself', async () => {
    const sent = await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: 12 jackets, which lining?' }, 201)
    const id = sent.request.id
    await assignInquiry(office(), id, { version: await version(id), assigneeId: ADA }, officeKey())
    await askInfo(office(), id, { version: await version(id), message: { body: 'Made-up: winter or summer lining?' } }, officeKey())
    expect(await statusOf(id)).toBe('NEED_INFO')
    const ours = await admin(`SELECT m.direction::text AS direction, m.channel::text AS channel, m."authorKind"::text AS "authorKind", m."partyId" FROM "Message" m JOIN "Thread" t ON t.id = m."threadId" WHERE t."recordId" = $1 AND m.direction = 'OUTBOUND'`, [id])
    expect(ours).toEqual([{ direction: 'OUTBOUND', channel: 'PORTAL', authorKind: 'USER', partyId: P1 }])
    expect(JSON.stringify(await ok(browsers.buyer, 'GET', `/portal/threads/Inquiry/${id}`))).toContain('winter or summer lining?')
    // An internal note or our own message takes nothing up; the customer's answer does.
    const since = new Date(Date.now() - 1_000)
    await ok(browsers.buyer, 'POST', `/portal/threads/Inquiry/${id}/messages`, { body: 'Made-up: winter, please.' }, 201)
    await resumeOn(id, since)
    expect(await statusOf(id)).toBe('ASSIGNED')
    const audit = await one(`SELECT "actorId", after FROM "AuditLog" WHERE "recordId" = $1 AND action = 'sales.inquiries.resumeOnReply'`, [id])
    expect(audit.after).toMatchObject({ status: 'ASSIGNED' })
    expect((await ok(browsers.buyer, 'GET', `/portal/inquiries/${id}`)).request.state.code).toBe('BEING_REVIEWED')
    // Answered again while it no longer waits: nothing moves.
    await ok(browsers.buyer, 'POST', `/portal/threads/Inquiry/${id}/messages`, { body: 'Made-up: and red zips.' }, 201)
    await resumeOn(id, since)
    expect(await statusOf(id)).toBe('ASSIGNED')
  })

  it('nobody keeps it: back to NEW; a reply on another customer’s thread never takes it up (W08)', async () => {
    const mine = (await ok(browsers.buyer, 'POST', '/portal/inquiries', { message: 'Made-up: a sample first?' }, 201)).request.id
    const theirs = (await ok(browsers.other, 'POST', '/portal/inquiries', { message: 'Made-up: our own question.' }, 201)).request.id
    for (const id of [mine, theirs]) await askInfo(office(), id, { version: await version(id), message: { body: 'Made-up: how many pieces?' } }, officeKey())
    const since = new Date(Date.now() - 1_000)
    // The other customer cannot write into P1's request.
    expect((await call(browsers.other, 'POST', `/portal/threads/Inquiry/${mine}/messages`, { body: 'Made-up: hello' })).status).toBe(404)
    await ok(browsers.other, 'POST', `/portal/threads/Inquiry/${theirs}/messages`, { body: 'Made-up: fifty.' }, 201)
    await resumeOn(theirs, since)
    expect(await statusOf(theirs)).toBe('NEW')
    expect(await statusOf(mine)).toBe('NEED_INFO')
  })

  it('a phone request: the question is a mail to its contact; a prospect’s request takes no question until it is a customer', async () => {
    const phone = await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0002'`, [T])
    await askInfo(office(), phone.id, { version: await version(phone.id), message: { body: 'Made-up: which two colours?', subject: 'Your reorder' } }, officeKey())
    expect(await statusOf(phone.id)).toBe('NEED_INFO')
    const mail = await one(`SELECT "to", subject, status::text AS status FROM "EmailOutbound" WHERE "recordType" = 'Inquiry' AND "recordId" = $1`, [phone.id])
    expect(mail).toEqual({ to: ['buyer.p3@example.com'], subject: 'Your reorder', status: 'QUEUED' })
    const prospect = await one<{ id: string }>(`SELECT id FROM "Inquiry" WHERE "tenantId" = $1 AND number = 'SEED-INQ-0001'`, [T])
    await expect(askInfo(office(), prospect.id, { version: await version(prospect.id), message: { body: 'Made-up: hello?' } }, officeKey())).rejects.toThrow(/Make the customer first/)
    expect(await statusOf(prospect.id)).toBe('NEW')
    // Without a question it only waits, as before.
    await askInfo(office(), prospect.id, { version: await version(prospect.id) }, officeKey())
    expect(await statusOf(prospect.id)).toBe('NEED_INFO')
  })
})
