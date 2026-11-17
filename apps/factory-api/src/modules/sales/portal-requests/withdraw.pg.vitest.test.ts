import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { WITHDRAW_WORDS } from '@nexus/factory-domain/sales/portal-requests/state'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedSalesIntake } from '../../../../../../packages/factory-db/seed/sales-intake'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { callerFor } from '../../../core/command'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness } from '../../../platform/auth/sessions/testing/harness'
import { declineInquiry, readInquiry } from '../inquiries/inquiries'

/**
 * B-TH-095 (threads plan TH-9, N20; X-P-CUS-REQ.state-F03; wall W37 / T37; Owner rule 2026-11-16: "One brand must not be able to see
 * anything related to any other brand") — POST /portal/inquiries/:inquiryId/withdraw, on the local stack through the real app and
 * the real portal sign-in by code: the seeds up to the sales intake (P1 = SEED-C1 and the INQUIRY series of company A; P3 =
 * SEED-C2), each customer's portal on, a buyer of each and a viewer of P1 (no order requests).
 *
 *   - P1's buyer withdraws its own request before the office decided: WITHDRAWN, closed by that portal person, "Withdrawn" under
 *     Closed, inquiry.closed WITHDRAWN (the office's followers, Incoming's live rows), its audit row; the office reads it withdrawn
 *     and decides nothing more on it;
 *   - T37: P3's buyer cannot withdraw (nor read) P1's request: not found, nothing changes;
 *   - refused in words: withdrawn already, already decided by the office, a stale version; a viewer has no Withdraw (403) and its
 *     request page says so (`withdraw.allowed` false).
 * Every name, number and word is made up. Run with `node scripts/factory/run-pg-tests.mjs modules/sales/portal-requests/withdraw`.
 */

let h: Harness
const NS = 'th9-withdraw'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const P3 = seedUuid(NS, 'party:P3')
const people = { buyer: 'bea.buyer.th095@brand-alpha.example', viewer: 'vera.viewer.th095@brand-alpha.example', other: 'olga.buyer.th095@brand-beta.example' }
const ids = {} as Record<keyof typeof people, string>
const browsers = {} as Record<keyof typeof people, Browser>

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
let serial = 0
const call = (who: keyof typeof people, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Answer> =>
  browsers[who].send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}), method === 'GET' ? {} : { headers: { 'idempotency-key': `th095-${++serial}` } })
async function ok(who: keyof typeof people, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
const refusalOf = (answer: Answer): Json | undefined => (answer.body?.error?.issues ?? []).find((issue: Json) => String(issue.path).startsWith('refusal/'))
const ADA = newId()
const sales = templateOf('sales')!
const office = () => callerFor(h.database, { audience: 'office', tenantId: T, actorId: ADA, requestId: newId(), grants: [{ permissions: [...sales.permissions, ...sales.grains.map((grain) => `money.${grain}`)] as Permission[], companies: 'all', sites: 'all', parties: 'all' }] })
const statusOf = async (id: string) => (await one<{ status: string }>('SELECT status::text AS status FROM "Inquiry" WHERE id = $1', [id])).status

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

beforeAll(async () => {
  h = await startHarness('th9_withdraw')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedSalesIntake({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-portal', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    for (const party of [P1, P3]) await client.portalSettings.upsert({ where: { id: party }, create: { id: party, partyId: party, portalOn: true }, update: { portalOn: true }, select: { id: true } })
    const salesRole = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'sales' } }, select: { id: true } })
    await client.user.create({ data: { id: ADA, email: 'ada.sales.th095@example.com', displayName: 'Made-up Ada', locale: 'en', status: 'ACTIVE' }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId: ADA, roleId: salesRole.id, allCompanies: true, validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  freshGuard(h)
  ids.buyer = await partnerPerson(people.buyer, P1, ['customer-buyer', 'partner-comment'])
  ids.viewer = await partnerPerson(people.viewer, P1, ['customer-viewer'])
  ids.other = await partnerPerson(people.other, P3, ['customer-buyer', 'partner-comment'])
  for (const who of Object.keys(people) as (keyof typeof people)[]) browsers[who] = await signedIn(people[who])
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

describe('B-TH-095 the customer withdraws a request', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('before the office decided: WITHDRAWN by the portal person, “Withdrawn” under Closed, inquiry.closed WITHDRAWN, its audit row', async () => {
    const sent = await ok('buyer', 'POST', '/portal/inquiries', { subject: 'Made-up: ten team vests', message: 'Made-up: ten vests, size L.' }, 201)
    const id = sent.request.id as string
    const page = (await ok('buyer', 'GET', `/portal/inquiries/${id}`)).request
    expect(page.withdraw).toEqual({ allowed: true, words: null })
    expect(page.version).toEqual(expect.any(Number))
    const withdrawn = (await ok('buyer', 'POST', `/portal/inquiries/${id}/withdraw`, { version: page.version })).request
    expect(withdrawn.state).toEqual({ code: 'WITHDRAWN', words: { en: 'Withdrawn', it: 'Ritirata' }, open: false, needsYou: false })
    expect(withdrawn.closedAt).toEqual(expect.any(String))
    expect(withdrawn.withdraw).toEqual({ allowed: false, words: WITHDRAW_WORDS.ALREADY_WITHDRAWN.en })
    expect(await one('SELECT status::text AS status, "closedById", "closedAt" IS NOT NULL AS closed, "closeNote" FROM "Inquiry" WHERE id = $1', [id])).toEqual({ status: 'WITHDRAWN', closedById: ids.buyer, closed: true, closeNote: null })
    const events = await admin<{ payload: Json }>(`SELECT payload FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'inquiry.closed' AND subject = $2`, [T, id])
    expect(events.map((event) => event.payload)).toEqual([expect.objectContaining({ inquiryId: id, status: 'WITHDRAWN', previousStatus: 'NEW', partyId: P1, quoteId: null, salesOrderId: null, declineReason: null })])
    expect(await admin(`SELECT "actorId" FROM "AuditLog" WHERE "tenantId" = $1 AND action = 'portalRequests.withdraw' AND "recordId" = $2`, [T, id])).toEqual([{ actorId: ids.buyer }])
    // The list: under Closed, not among the open ones.
    expect(((await ok('buyer', 'GET', '/portal/inquiries')).rows as Json[]).map((row) => row.id)).not.toContain(id)
    expect(((await ok('buyer', 'GET', '/portal/inquiries?state=CLOSED')).rows as Json[]).find((row) => row.id === id)?.state.code).toBe('WITHDRAWN')
    // The office reads it withdrawn and decides nothing more on it.
    const inquiry = await readInquiry(office(), id)
    expect(inquiry.status).toBe('WITHDRAWN')
    await expect(declineInquiry(office(), id, { version: inquiry.version, reason: 'CAPACITY' }, `th095-decline-${newId()}`)).rejects.toThrow()
    expect(await statusOf(id)).toBe('WITHDRAWN')
  })

  it('T37: the other customer cannot withdraw, nor read, the request — not found; nothing changes', async () => {
    const sent = await ok('buyer', 'POST', '/portal/inquiries', { message: 'Made-up: five rain covers.' }, 201)
    const id = sent.request.id as string
    const version = (await one<{ version: number }>('SELECT version FROM "Inquiry" WHERE id = $1', [id])).version
    const refused = await call('other', 'POST', `/portal/inquiries/${id}/withdraw`, { version })
    expect(refused.status).toBe(404)
    expect(JSON.stringify(refused.body)).not.toContain('rain covers')
    expect((await call('other', 'GET', `/portal/inquiries/${id}`)).status).toBe(404)
    expect(await statusOf(id)).toBe('NEW')
    expect(await admin(`SELECT id FROM "OutboxEvent" WHERE "tenantId" = $1 AND type = 'inquiry.closed' AND subject = $2`, [T, id])).toEqual([])
  })

  it('refused in words: withdrawn already, decided by the office, a stale version; a viewer has no Withdraw', async () => {
    const sent = await ok('buyer', 'POST', '/portal/inquiries', { message: 'Made-up: two pairs of gloves.' }, 201)
    const id = sent.request.id as string
    const version = (await ok('buyer', 'GET', `/portal/inquiries/${id}`)).request.version as number
    const stale = await call('buyer', 'POST', `/portal/inquiries/${id}/withdraw`, { version: version + 5 })
    expect(stale.status).toBe(409)
    expect(await statusOf(id)).toBe('NEW')
    // A viewer of the same customer reads the request, never withdraws it.
    expect((await ok('viewer', 'GET', `/portal/inquiries/${id}`)).request.withdraw).toEqual({ allowed: false, words: null })
    expect((await call('viewer', 'POST', `/portal/inquiries/${id}/withdraw`, { version })).status).toBe(403)
    // The office declines it: decided — the customer is told so.
    await declineInquiry(office(), id, { version, reason: 'CAPACITY' }, `th095-decline-${newId()}`)
    const decided = await call('buyer', 'POST', `/portal/inquiries/${id}/withdraw`, { version: version + 1 })
    expect(decided.status).toBe(409)
    expect(refusalOf(decided)).toEqual({ path: 'refusal/DECIDED', message: WITHDRAW_WORDS.DECIDED.en })
    expect((await ok('buyer', 'GET', `/portal/inquiries/${id}`)).request.withdraw).toEqual({ allowed: false, words: WITHDRAW_WORDS.DECIDED.en })
    // Withdrawn already.
    const again = await ok('buyer', 'POST', '/portal/inquiries', { message: 'Made-up: one sample jacket.' }, 201)
    const first = (await ok('buyer', 'GET', `/portal/inquiries/${again.request.id}`)).request.version as number
    await ok('buyer', 'POST', `/portal/inquiries/${again.request.id}/withdraw`, { version: first })
    const twice = await call('buyer', 'POST', `/portal/inquiries/${again.request.id}/withdraw`, { version: first + 1 })
    expect(twice.status).toBe(409)
    expect(refusalOf(twice)).toEqual({ path: 'refusal/ALREADY_WITHDRAWN', message: WITHDRAW_WORDS.ALREADY_WITHDRAWN.en })
  })
})
