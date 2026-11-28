import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
import { MONEY_WORDS, PLAN_STATES } from '@nexus/factory-domain/sales/portal-orders/money'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedShipping } from '../../../../../../packages/factory-db/seed/shipping'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld, type PortalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { startHarness, type Answer, type Browser, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { forgetProgress } from './progress'

/**
 * The customer's Money tab and "I paid" (owb- order workflow, S1 po2.2; design § 5m; the S1 Shape "MONEY") on the local stack,
 * through the real app and the real portal sign-in by code: the factory-db seeds up to shipping (the brand SEED-C1 = P1 with its
 * orders), P1's portal and another customer's on; P1's buyer, viewer and designer, the other customer's buyer. Every name is made up.
 * Run with `node scripts/factory/run-pg-tests.mjs portal-orders/portal-money`.
 *
 *   - MONEY: the buyer reads its order's money (totals, plan, invoices, notices); the viewer (no price grain) and the designer: 403
 *   - BRAND: another customer's order is not found (404) — read and notice alike
 *   - "I paid": a notice OPEN only, unanswered, amount marked price; nothing owed changes; refused above what is open, on a day
 *     ahead; 409 when nothing is still to pay; the event `payment_notice.sent` (ids only)
 */

let h: Harness
let tenant: TestTenant
let world: PortalWorld
const NS = 'owb-portal-money'
const T = seedUuid(NS, 'tenant')
const companyA = seedUuid(NS, 'company:A')
const P1 = seedUuid(NS, 'party:P1')

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
const people = { buyer: 'bruno.buyer@portal-money.example.com', viewer: 'vale.viewer@portal-money.example.com', designer: 'dafne.designer@portal-money.example.com', other: 'oreste.buyer@portal-money-two.example.com' }
const browsers = {} as Record<keyof typeof people, Browser>

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

const call = (browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown): Promise<Answer> => browser.send(method as 'POST', url, method === 'GET' ? undefined : (body ?? {}))
async function ok(browser: Browser, method: 'GET' | 'POST', url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(browser, method, url, body)
  expect(answer.status, `${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}

let orders: string[] = []
let theirs = ''

beforeAll(async () => {
  h = await startHarness('owb_portal_money')
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedShipping({ db: h.database, namespace: NS })
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
    const settings = await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true, version: true } })
    if (settings) await client.portalSettings.update({ where: { id: P1 }, data: { portalOn: true, version: settings.version + 1 }, select: { id: true } })
    else await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  world = await portalWorld(h, tenant)
  freshGuard(h)
  await partnerPerson(people.buyer, P1, ['customer-buyer'])
  await partnerPerson(people.viewer, P1, ['customer-viewer'])
  await partnerPerson(people.designer, P1, ['customer-designer'])
  await partnerPerson(people.other, world.partyId, ['customer-buyer'])
  for (const key of Object.keys(people) as (keyof typeof people)[]) browsers[key] = await signedIn(people[key])
  orders = (await admin<{ id: string }>(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "partyId" = $2 AND status NOT IN ('CANCELLED') ORDER BY number`, [T, P1])).map((row) => row.id)
  theirs = orders[0]!
}, 300_000)

beforeEach(() => {
  freshGuard(h)
})

afterAll(async () => {
  useAbuseGuard(undefined)
  usePortalOptions({})
  forgetProgress()
  await h?.close()
})

describe('the Money tab and "I paid" (owb- po2.2)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('MONEY: the buyer reads totals, plan, invoices and notices; the viewer and the designer: 403', async () => {
    const money = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${orders[0]}/money`)
    expect(Object.keys(money.totals).sort()).toEqual(['invoiced', 'order', 'paid', 'stillToPay'])
    expect(money.addsUp.map((entry: Json) => entry.key)).toEqual(['LINES', 'CHARGES', 'VAT', 'CREDIT_NOTES', 'PAID'])
    for (const step of money.plan as Json[]) expect(PLAN_STATES).toContain(step.state)
    expect(money.may.notify).toBe(money.totals.stillToPay > 0)
    // No cost, no margin, no office person, no office series in the answer.
    expect(JSON.stringify(money)).not.toMatch(/cost|margin|SEED-SO-\d|createdById|answeredById/i)
    const viewer = await call(browsers.viewer, 'GET', `/portal/sales-orders/${orders[0]}/money`)
    expect(viewer.status).toBe(403)
    expect(viewer.body.error.message).toBe(MONEY_WORDS.NO_PRICES.en)
    expect((await call(browsers.designer, 'GET', `/portal/sales-orders/${orders[0]}/money`)).status).toBe(403)
  })

  it('BRAND: another customer’s order is not found — read and notice alike', async () => {
    expect((await call(browsers.other, 'GET', `/portal/sales-orders/${theirs}/money`)).status).toBe(404)
    expect((await call(browsers.other, 'POST', `/portal/sales-orders/${theirs}/payment-notices`, { stepId: null, amount: 1, paidOn: businessDate(new Date()) })).status).toBe(404)
  })

  it('"I paid": OPEN only, nothing owed changes; above what is open, a day ahead: 400; nothing to pay: 409; the viewer may not', async () => {
    const today = businessDate(h.clock.now())
    for (const orderId of orders) {
      const before = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${orderId}/money`)
      const url = `/portal/sales-orders/${orderId}/payment-notices`
      if (before.totals.stillToPay <= 0) {
        const none = await call(browsers.buyer, 'POST', url, { stepId: null, amount: 1, paidOn: today })
        expect(none.status).toBe(409)
        expect(none.body.error.message).toBe(MONEY_WORDS.NOTHING_TO_PAY.en)
        continue
      }
      expect((await call(browsers.buyer, 'POST', url, { stepId: null, amount: before.totals.stillToPay + 1, paidOn: today })).status).toBe(400)
      expect((await call(browsers.buyer, 'POST', url, { stepId: null, amount: 1, paidOn: addDays(today, 2) })).status).toBe(400)
      expect((await call(browsers.buyer, 'POST', url, { stepId: newId(), amount: 1, paidOn: today })).status).toBe(400)
      expect((await call(browsers.viewer, 'POST', url, { stepId: null, amount: 1, paidOn: today })).status).toBe(403)
      const notice = await ok(browsers.buyer, 'POST', url, { stepId: null, amount: 1, paidOn: today, method: 'Bank transfer (made up)' })
      expect(notice).toMatchObject({ stepId: null, amount: 1, paidOn: today, state: 'OPEN' })
      expect(await one('SELECT state::text AS state, "answeredAt", amount FROM "PaymentNotice" WHERE id = $1', [notice.id])).toEqual({ state: 'OPEN', answeredAt: null, amount: 1 })
      const events = await admin<{ payload: Json }>('SELECT payload FROM "OutboxEvent" WHERE type = $1 AND subject = $2', ['payment_notice.sent', orderId])
      expect(events.map((row) => Object.keys(row.payload).sort())).toEqual([['noticeId', 'partyId', 'salesOrderId']])
      // Nothing owed changes: still to pay is as before; the notice is listed, the rest's step says one is open.
      const after = await ok(browsers.buyer, 'GET', `/portal/sales-orders/${orderId}/money`)
      expect(after.totals.stillToPay).toBe(before.totals.stillToPay)
      expect(after.notices.map((entry: Json) => entry.id)).toContain(notice.id)
      return
    }
  })
})
