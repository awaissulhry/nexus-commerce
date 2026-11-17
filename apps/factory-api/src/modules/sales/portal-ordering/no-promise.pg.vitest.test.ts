import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { REQUEST_NOTICE } from '@nexus/factory-domain/sales/portal-ordering/rules'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedPricing } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SOURCES } from '../../insights/sources'

/**
 * No answer-time promise on the catalogue door (B-TH-041; Owner decision 3, threads plan L2-G17), on the local stack through the
 * real app and the real portal sign-in by code: the customer P1's buyer starts a draft from the catalogue (SEED-JKT-02 on the
 * base list) and sends it. Neither the draft's notice nor the send's answer says when we confirm ("within 1 working day", "by
 * <day>"); `confirmBy` is null. The office's own reminder of a request that waits (Today's PORTAL_ORDER_REQUEST source) stays.
 * Made-up data only. Run with `node scripts/factory/run-pg-tests.mjs portal-ordering/no-promise`.
 */

let h: Harness
let tenant: TestTenant
const NS = 'th041-no-promise'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')
const BUYER = 'bea.buyer@th041.example.com'
const PROMISE = /working day|giorno lavorativ|confirm by|confermiamo entro|entro il|within/i

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
let buyer: Browser

async function ok(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer: Answer = await browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

beforeAll(async () => {
  h = await startHarness('th041_no_promise')
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
    const userId = newId()
    await client.user.create({ data: { id: userId, email: BUYER, displayName: 'bea.buyer', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: P1, partnerKind: 'CUSTOMER' }, select: { id: true } })
    const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key: 'customer-buyer' } }, select: { id: true } })
    await client.roleAssignment.create({ data: { id: newId(), userId, roleId: role.id, allCompanies: true, partyIds: [P1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
  })
  await portalWorld(h, tenant)
  freshGuard(h)
  buyer = await portalBrowser(h)
  h.clock.advance(61_000)
  expect((await buyer.post('/portal/signin/start', { tenant: NS, company: 'SCA', email: BUYER })).status).toBe(200)
  await h.auth.settled()
  expect((await buyer.post('/portal/signin/code', { tenant: NS, company: 'SCA', email: BUYER, code: mailedCode(h, BUYER)!.code })).status).toBe(200)
  const terms = await buyer.get('/portal/terms?locale=en')
  expect((await buyer.post('/portal/first-visit', { noticeId: terms.body.notice.id, noticeLocale: terms.body.notice.locale, sha256: terms.body.notice.sha256 })).status).toBe(200)
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

describe('no answer-time promise on the catalogue door (B-TH-041)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the domain words promise no time, in either language', () => {
    expect(REQUEST_NOTICE.en).not.toMatch(PROMISE)
    expect(REQUEST_NOTICE.it).not.toMatch(PROMISE)
  })

  it('neither the draft nor the send says by when we confirm; confirmBy is null; the office keeps its own reminder', async () => {
    const style = await one<{ id: string }>('SELECT id FROM "Style" WHERE "tenantId" = $1 AND code = $2', [T, 'SEED-JKT-02'])
    const colourway = await one<{ id: string }>('SELECT id FROM "Colourway" WHERE "tenantId" = $1 AND "styleId" = $2 AND code = $3', [T, style.id, 'BLK'])
    const made = await ok(buyer, 'POST', '/portal/order-requests', { source: 'PICKER', customerRef: 'PO-T-041' }, 201)
    const url = `/portal/order-requests/${made.request.id}`
    const added = await ok(buyer, 'POST', `${url}/lines`, { version: made.request.version, lines: [{ styleId: style.id, colourwayId: colourway.id, sizes: [{ size: '50', quantity: 2 }] }] })
    expect(added.request.notice).toEqual(REQUEST_NOTICE)
    const sent = await ok(buyer, 'POST', `${url}/send`, { version: added.request.version })
    expect(sent.sent.confirmBy).toBeNull()
    expect(sent.sent.words.en).toContain(`your PO PO-T-041, our request ${sent.request.number}`)
    for (const words of [sent.sent.words.en, sent.sent.words.it, sent.request.notice.en, sent.request.notice.it]) expect(words).not.toMatch(PROMISE)
    // The office's own reminder of a request that waits stays (Today's source of portal order requests).
    expect(Object.keys(SOURCES)).toContain('PORTAL_ORDER_REQUEST')
  })
})
