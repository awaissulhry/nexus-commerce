import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import { businessDate } from '@nexus/factory-domain/core/time'
import { addDays } from '@nexus/factory-domain/sales/quotes/quotes'
// The factory-db seeds are no package export: a test reads them where they live.
import { seed as seedCore } from '../../../../../../packages/factory-db/seed/_core'
import { seed as seedCompliance } from '../../../../../../packages/factory-db/seed/compliance'
import { seed as seedCosting } from '../../../../../../packages/factory-db/seed/costing'
import { seed as seedPricing, type PricingSeed } from '../../../../../../packages/factory-db/seed/pricing'
import { seedUuid } from '../../../../../../packages/factory-db/src/seeding'
import { useAbuseGuard } from '../../../platform/abuse/guard'
import { usePortalOptions } from '../../../platform/auth/portal/service'
import { freshGuard, mailedCode, portalBrowser, portalWorld } from '../../../platform/auth/portal/testing/portal'
import { applySystemRoleChanges, systemRoleChanges } from '../../../platform/auth/roles/system-roles'
import { addUser, Browser, enrolTotp, startHarness, type Answer, type Harness, type TestTenant } from '../../../platform/auth/sessions/testing/harness'
import { SLOW_TEST_TIMEOUT_MS } from '../../../testing/timeouts'

/**
 * Sales keeps no blind price writes (customer page lane B-CP-012; D1-c, review A6, A8; the money wall, Owner O1 of
 * 2026-11-19) on the local stack, through the real app, its sign-in and its grain filter, with the RAILS of the ready-made
 * roles (no hand-made grants): the Sales template sees no price, no margin and keeps no price list (B-CP-011).
 *
 *   - as Sales worker: a manual order WITHOUT a price key is priced from the customer's list (the answer shows no price;
 *     the line holds the list price); WITH a unit price, a size price or a discount % it is refused 403, nothing written;
 *     a style the customer's lists do not price asks for a price in words (a price holder types it);
 *   - as Sales worker: a quote and its lines without price keys take the list price (a style without one waits at 0 for a
 *     price holder, who sets it); a unit price or a discount % on a line, added or changed, is refused 403;
 *   - as Sales worker: a portal request accepted as an ORDER and as a QUOTE without price keys (the request's lines are
 *     priced again from the list); a typed unit price on the accept is refused 403 (test only: its fix, if one is
 *     needed, is B-CP-076);
 *   - as Sales worker: pasted cells with a Price column are refused 403 (B-CP-012 fix in quote-bulk/paste.ts), and a quote's
 *     approval rules hide the margin floor, the discount and the amount limits (money flags; quotes/views.ts forCaller);
 *   - as Production manager: no order or quote is made (no right), and the order it reads shows no price;
 *   - the Owner (the price persona) types prices as before.
 *
 * The factory-db seeds up to pricing (as sales/orders/daily): P1 buys from its list SEED-PL-P1 (SEED-JKT-01 420.00, its RED
 * 430.00) over the base list (SEED-JKT-02 410.00). Every name, number and price is made up. Run with
 * `node scripts/factory/run-pg-tests.mjs sales/orders/no-price-writers`.
 */

let h: Harness
let seeded: PricingSeed
const NS = 'cp012-no-price-writers'
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
const BUYER = 'bea.buyer@cp012.example'

type Json = Record<string, any>
const admin = async <R = Json>(sql: string, values: unknown[] = []): Promise<R[]> => (await h.db.admin.query(sql, values)).rows as R[]
const one = async <R = Json>(sql: string, values: unknown[] = []): Promise<R> => (await admin<R>(sql, values))[0]!
/** Every key of an answer, at any depth (the money wall: no price-looking key reaches a no-price reader). */
const keysOf = (value: unknown): string[] => (Array.isArray(value) ? value.flatMap(keysOf) : value && typeof value === 'object' ? Object.entries(value).flatMap(([name, item]) => [name, ...keysOf(item)]) : [])
const PRICE_KEYS = ['unitPrice', 'listUnitPrice', 'discountPct', 'netAmount', 'vatAmount', 'grossAmount', 'marginPct', 'marginAmount']

const people = {} as Record<'owner' | 'sales' | 'production' | 'buyer', Browser>

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT'
const call = (who: keyof typeof people, method: Method, url: string, body?: unknown): Promise<Answer> => people[who].send(method, url, method === 'GET' ? undefined : (body ?? {}))
async function ok(who: keyof typeof people, method: Method, url: string, body?: unknown, status = 200): Promise<Json> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return answer.body as Json
}
/** A refusal's issue paths. */
async function refused(who: keyof typeof people, method: Method, url: string, body: unknown, status: number): Promise<string[]> {
  const answer = await call(who, method, url, body)
  expect(answer.status, `${who} ${method} ${url}: ${JSON.stringify(answer.body)}`).toBe(status)
  return ((answer.body?.error?.issues ?? []) as Json[]).map((issue) => String(issue.path))
}

async function office(email: string, role: string, twoFactor: boolean): Promise<Browser> {
  const user = await addUser(h, TENANT, { email, role })
  const browser = new Browser(h.app)
  const answer = await browser.signIn(NS, user.email, user.password)
  expect(answer.status, JSON.stringify(answer.body)).toBe(200)
  if (twoFactor) await enrolTotp(h, browser)
  return browser
}

async function partnerBuyer(email: string): Promise<Browser> {
  await h.database.withScope({ audience: 'office', tenantId: T, actorId: newId() }, async (client) => {
    const id = newId()
    await client.user.create({ data: { id, email, displayName: 'Bea Buyer', locale: 'en', status: 'ACTIVE', audience: 'PARTNER', partyId: P1, partnerKind: 'CUSTOMER' }, select: { id: true } })
    for (const key of ['customer-buyer', 'partner-comment', 'partner-upload', 'partner-approve']) {
      const role = await client.role.findUniqueOrThrow({ where: { tenantId_key: { tenantId: T, key } }, select: { id: true } })
      await client.roleAssignment.create({ data: { id: newId(), userId: id, roleId: role.id, allCompanies: true, partyIds: [P1], validFrom: new Date(h.clock.now().getTime() - 60_000) }, select: { id: true } })
    }
  })
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

const grid = (rows: [string, number][]) => rows.map(([size, quantity]) => ({ size, quantity }))
const listed = { styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 2]]) }
const manual = (ref: string, lines: Json[] = [listed]) => ({ companyId: companyA, partyId: P1, customerRef: ref, promiseDate: PROMISE, lines })
const orderLines = (orderId: string) => admin<{ seq: number; unitPrice: string; netAmount: number }>(`SELECT seq, "unitPrice"::text AS "unitPrice", "netAmount" FROM "SalesOrderLine" WHERE "orderId" = $1 ORDER BY seq`, [orderId])
const ordersOf = (ref: string) => admin(`SELECT id FROM "SalesOrder" WHERE "tenantId" = $1 AND "customerRef" = $2`, [T, ref])

beforeAll(async () => {
  h = await startHarness('cp012_no_price') // B-CP-022: test-database labels are at most 20 characters
  h.clock.set(new Date())
  usePortalOptions({ answerFloorMs: 0 })
  await seedCore({ db: h.database, namespace: NS })
  await seedCompliance({ db: h.database, namespace: NS })
  await seedCosting({ db: h.database, namespace: NS })
  seeded = await seedPricing({ db: h.database, namespace: NS })
  const actorId = newId()
  await h.database.withScope({ audience: 'office', tenantId: T, actorId }, async (client) => {
    // The ready-made roles as the templates say now (Sales: no grain, no pricelists.manage).
    await applySystemRoleChanges(client, await systemRoleChanges(client), { now: h.clock.now(), actorId })
    const accountId = newId()
    await client.integrationAccount.create({ data: { id: accountId, provider: 'SES', code: 'ses-cp012', label: 'Mail (fake)', mode: 'FAKE', rateLimitPerMinute: 6000, rateLimitBurst: 1000 } })
    const domain = `mail.${NS}.example.com`
    await client.emailIdentity.create({
      data: { id: newId(), companyId: companyA, kind: 'NOTIFICATION', domain, fromAddress: `noreply@${domain}`, displayName: 'Seed A', displayNamePolicy: 'COMPANY', replyDomain: `reply.${NS}.example.com`, accountId, verificationStatus: 'SUCCESS', dkimStatus: 'SUCCESS', isDefault: true },
    })
    if (!(await client.portalSettings.findUnique({ where: { id: P1 }, select: { id: true } }))) await client.portalSettings.create({ data: { id: P1, partyId: P1, portalOn: true }, select: { id: true } })
  })
  // The company's portal terms (and another customer, unused here).
  await portalWorld(h, TENANT)
  freshGuard(h)
  // The catalogue sells SEED-JKT-01 once it is active (as sales/portal-ordering).
  await admin(`UPDATE "Style" SET status = 'ACTIVE', version = version + 1 WHERE id = $1`, [JKT01])
  people.owner = await office('olga.owner@cp012.example', 'owner', true)
  people.sales = await office('sam.sales@cp012.example', 'sales', true)
  people.production = await office('pia.production@cp012.example', 'production_manager', false)
  people.buyer = await partnerBuyer(BUYER)
  // The sign-ins moved the harness clock ahead: bring it back just behind the real one (a decision never before its send).
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

describe('as Sales worker: an order without a price key is priced from the list; with one it is refused', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('the Sales template sees no money now (B-CP-011)', async () => {
    const me = await ok('sales', 'GET', '/auth/office/me')
    for (const grain of ['money.price', 'money.margin', 'money.cost']) expect(me.permissions).not.toContain(grain)
    expect(me.permissions).not.toContain('pricelists.manage')
    expect(me.permissions).toEqual(expect.arrayContaining(['orders.manage', 'quotes.manage', 'pricelists.view']))
  })

  it('a manual order without prices takes P1’s list price; the answer shows no price, the line holds it', async () => {
    const made = (await ok('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-1'), 201)).order
    expect(keysOf(made).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    // 4 jackets at P1's 420.00.
    expect(await orderLines(made.id)).toEqual([{ seq: 10, unitPrice: '420.000000', netAmount: 168_000 }])
    // The preview says the same, without a price either.
    const preview = await ok('sales', 'POST', '/sales/orders/manual/preview', manual('PO-CP012-1P'))
    expect(keysOf(preview).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    // The Owner reads the same order with its prices.
    const seen = (await ok('owner', 'GET', `/sales/orders/${made.id}`)).order
    expect(Number(seen.lines[0].unitPrice)).toBe(420)
    expect(seen.lines[0].netAmount).toBe(168_000)
  })

  it('a unit price, a size price or a discount % from Sales is refused 403 and nothing is written', async () => {
    expect(await refused('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-2', [{ ...listed, unitPrice: '399' }]), 403)).toEqual(['lines/0/unitPrice'])
    expect(await refused('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-2', [{ ...listed, discountPct: '10' }]), 403)).toEqual(['lines/0/discountPct'])
    expect(await refused('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-2', [{ ...listed, sizes: [{ size: '50', quantity: 2, unitPrice: '430' }] }]), 403)).toEqual(['lines/0/sizes/0/unitPrice'])
    expect(await refused('sales', 'POST', '/sales/orders/manual/preview', manual('PO-CP012-2', [{ ...listed, discountPct: '10' }]), 403)).toEqual(['lines/0/discountPct'])
    expect(await ordersOf('PO-CP012-2')).toEqual([])
    // The Owner types them.
    const typed = (await ok('owner', 'POST', '/sales/orders/manual', manual('PO-CP012-3', [{ ...listed, discountPct: '10' }]), 201)).order
    expect(await orderLines(typed.id)).toEqual([{ seq: 10, unitPrice: '378.000000', netAmount: 151_200 }])
  })

  it('a style no list of the customer prices asks for its price in words; a price holder types it', async () => {
    // SEED-JKT-02 is priced only by the base list P1's list falls back to: the Owner takes the fallback away.
    const list = (await ok('owner', 'GET', `/sales/price-lists/${seeded.customerListId}`)).list
    await ok('owner', 'PATCH', `/sales/price-lists/${seeded.customerListId}`, { version: list.version, baseListId: null })
    const unpriced = { styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 3]]) }
    const answer = await call('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-4', [listed, unpriced]))
    expect(answer.status, JSON.stringify(answer.body)).toBe(400)
    expect(answer.body.error.issues).toContainEqual(expect.objectContaining({ path: 'body/lines/1/unitPrice', message: 'No price list prices this style in this colourway for the customer: type its unit price.' }))
    expect(await ordersOf('PO-CP012-4')).toEqual([])
    // Sales cannot type it (the grain filter), the Owner does.
    expect(await refused('sales', 'POST', '/sales/orders/manual', manual('PO-CP012-4', [listed, { ...unpriced, unitPrice: '400' }]), 403)).toEqual(['lines/1/unitPrice'])
    const priced = (await ok('owner', 'POST', '/sales/orders/manual', manual('PO-CP012-4', [listed, { ...unpriced, unitPrice: '400' }]), 201)).order
    expect((await orderLines(priced.id)).map((line) => line.unitPrice)).toEqual(['420.000000', '400.000000'])
  })
})

describe('as Sales worker: a quote and its lines without price keys take the list price', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes a quote and a line priced from the list; a unit price or a discount % on a line is refused 403', async () => {
    const made = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-CP012-1' }, 201)).quote
    const line = (await ok('sales', 'POST', `/sales/quotes/${made.id}/lines`, { version: made.version, styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 3]]) }, 201)).quote
    expect(keysOf(line).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    const [row] = await admin<{ id: string; unitPrice: string; listUnitPrice: string | null }>(`SELECT l.id, l."unitPrice"::text AS "unitPrice", l."listUnitPrice"::text AS "listUnitPrice" FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1`, [made.id])
    expect(row).toMatchObject({ unitPrice: '420.000000', listUnitPrice: '420.000000' })
    const base = { version: line.version, styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['52', 1]]) }
    expect(await refused('sales', 'POST', `/sales/quotes/${made.id}/lines`, { ...base, unitPrice: '399' }, 403)).toEqual(['unitPrice'])
    expect(await refused('sales', 'POST', `/sales/quotes/${made.id}/lines`, { ...base, discountPct: '5' }, 403)).toEqual(['discountPct'])
    expect(await refused('sales', 'PATCH', `/sales/quotes/${made.id}/lines/${row!.id}`, { version: line.version, discountPct: '5' }, 403)).toEqual(['discountPct'])
    expect(await refused('sales', 'PATCH', `/sales/quotes/${made.id}/lines/${row!.id}`, { version: line.version, unitPrice: '1' }, 403)).toEqual(['unitPrice'])
    // Nothing moved: the line keeps the list price, the quote its version.
    expect((await one<{ unitPrice: string }>(`SELECT "unitPrice"::text AS "unitPrice" FROM "QuoteLine" WHERE id = $1`, [row!.id])).unitPrice).toBe('420.000000')
    expect((await ok('sales', 'GET', `/sales/quotes/${made.id}`)).quote.version).toBe(line.version)
    // The Owner gives the discount.
    const discounted = (await ok('owner', 'PATCH', `/sales/quotes/${made.id}/lines/${row!.id}`, { version: line.version, discountPct: '5' })).quote
    expect(Number(discounted.lines[0].unitPrice)).toBe(399)
    expect(Number(discounted.lines[0].discountPct)).toBe(5)
  })

  it('a style without a list price waits at 0 for a price holder, who sets it; Sales never reads either price', async () => {
    // P1's list no longer falls back to the base list (the test above): SEED-JKT-02 has no list price for P1.
    const made = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-CP012-2' }, 201)).quote
    const added = (await ok('sales', 'POST', `/sales/quotes/${made.id}/lines`, { version: made.version, styleId: JKT02, colourwayId: JKT02_RED, sizes: grid([['52', 2]]) }, 201)).quote
    expect(keysOf(added).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    const [row] = await admin<{ id: string; unitPrice: string }>(`SELECT l.id, l."unitPrice"::text AS "unitPrice" FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1`, [made.id])
    expect(Number(row!.unitPrice)).toBe(0)
    const set = (await ok('owner', 'PATCH', `/sales/quotes/${made.id}/lines/${row!.id}`, { version: added.version, unitPrice: '405' })).quote
    expect(Number(set.lines[0].unitPrice)).toBe(405)
    const read = (await ok('sales', 'GET', `/sales/quotes/${made.id}`)).quote
    expect(keysOf(read).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
  })
})

describe('as Sales worker: no pasted price, no money flag in the approval rules', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('pasted cells with a Price column are refused 403 (the list prices them without it)', async () => {
    const made = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-CP012-P' }, 201)).quote
    const priced = ['Style\tColourway\t50\t52\tPrice', 'SEED-JKT-01\tBLK\t2\t1\t399.00'].join('\n')
    // The sheet's row 2 (its first row is the header).
    expect(await refused('sales', 'POST', `/sales/quotes/${made.id}/lines/paste`, { version: made.version, text: priced, preview: true }, 403)).toEqual(['rows/2/unitPrice'])
    expect(await refused('sales', 'POST', `/sales/quotes/${made.id}/lines/paste`, { version: made.version, text: priced }, 403)).toEqual(['rows/2/unitPrice'])
    expect(await refused('sales', 'POST', `/sales/quotes/${made.id}/lines/paste`, { version: made.version, rows: [{ style: 'SEED-JKT-01', colourway: 'BLK', sizes: { '50': 2 }, unitPrice: '399' }] }, 403)).toEqual(['rows/0/unitPrice'])
    const plain = ['Style\tColourway\t50\t52', 'SEED-JKT-01\tBLK\t2\t1'].join('\n')
    await ok('sales', 'POST', `/sales/quotes/${made.id}/lines/paste`, { version: made.version, text: plain })
    const [row] = await admin<{ unitPrice: string }>(`SELECT l."unitPrice"::text AS "unitPrice" FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1`, [made.id])
    expect(row!.unitPrice).toBe('420.000000')
  })

  it('a discount over the limit: the Owner reads the broken rule, Sales reads only that an approval is needed', async () => {
    const made = (await ok('sales', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1, customerRef: 'RFQ-CP012-A' }, 201)).quote
    const line = (await ok('sales', 'POST', `/sales/quotes/${made.id}/lines`, { version: made.version, styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2]]) }, 201)).quote
    const lineId = (await one<{ id: string }>(`SELECT l.id FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1`, [made.id])).id
    // 20 % off the list is over the default 15 % limit.
    await ok('owner', 'PATCH', `/sales/quotes/${made.id}/lines/${lineId}`, { version: line.version, discountPct: '20' })
    const seen = (await ok('owner', 'GET', `/sales/quotes/${made.id}`)).quote
    expect(seen.approval.needed).toBe(true)
    expect(seen.approval.rules).toContainEqual(expect.objectContaining({ reason: 'DISCOUNT_LIMIT', broken: true }))
    const blind = (await ok('sales', 'GET', `/sales/quotes/${made.id}`)).quote
    expect(blind.approval.needed).toBe(true)
    expect(blind.approval.rules.map((rule: Json) => rule.reason).filter((reason: string) => ['MARGIN_FLOOR', 'DISCOUNT_LIMIT', 'AMOUNT_LIMIT'].includes(reason))).toEqual([])
    expect(keysOf(blind).filter((name) => PRICE_KEYS.includes(name) || name === 'belowFloor' || name === 'marginFloorPct')).toEqual([])
  })
})

describe('as Sales worker: a portal request accepted without price keys (test only: B-CP-076 fixes it if needed)', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  async function sentRequest(ref: string): Promise<Json> {
    const made = (await ok('buyer', 'POST', '/portal/order-requests', { source: 'PICKER', customerRef: ref }, 201)).request
    const url = `/portal/order-requests/${made.id}`
    const added = (await ok('buyer', 'POST', `${url}/lines`, { version: made.version, lines: [{ styleId: JKT01, colourwayId: JKT01_BLK, sizes: grid([['50', 2], ['52', 3]]) }] })).request
    return (await ok('buyer', 'POST', `${url}/send`, { version: added.version })).request
  }

  it('as an ORDER: priced again from the list; a typed unit price from Sales is refused 403', async () => {
    const sent = await sentRequest('PO-CP012-R1')
    const view = (await ok('sales', 'GET', `/sales/order-requests/${sent.id}`)).request
    expect(keysOf(view).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    expect(await refused('sales', 'POST', `/sales/order-requests/${sent.id}/accept`, { version: view.version, as: 'ORDER', lines: [{ lineId: view.lines[0].id, unitPrice: '1' }] }, 403)).toEqual(['lines/0/unitPrice'])
    expect((await one(`SELECT status FROM "PortalOrderRequest" WHERE id = $1`, [sent.id])).status).toBe('SENT')
    const accepted = await ok('sales', 'POST', `/sales/order-requests/${sent.id}/accept`, { version: view.version, as: 'ORDER' })
    expect(accepted.made).toMatchObject({ as: 'ORDER', quoteId: null })
    expect(keysOf(accepted).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
    // 5 jackets at P1's 420.00.
    expect(await orderLines(accepted.made.salesOrderId)).toEqual([{ seq: 10, unitPrice: '420.000000', netAmount: 210_000 }])
  })

  it('as a QUOTE: the quote takes the list price, no price key sent', async () => {
    const sent = await sentRequest('PO-CP012-R2')
    const view = (await ok('sales', 'GET', `/sales/order-requests/${sent.id}`)).request
    const quoted = await ok('sales', 'POST', `/sales/order-requests/${sent.id}/accept`, { version: view.version, as: 'QUOTE' })
    expect(quoted.made).toMatchObject({ as: 'QUOTE', salesOrderId: null })
    const [row] = await admin<{ unitPrice: string }>(`SELECT l."unitPrice"::text AS "unitPrice" FROM "QuoteLine" l JOIN "QuoteVersion" v ON v.id = l."versionId" WHERE v."quoteId" = $1`, [quoted.made.quoteId])
    expect(row!.unitPrice).toBe('420.000000')
  })
})

describe('as Production manager: no order or quote, and no price on what it reads', { timeout: SLOW_TEST_TIMEOUT_MS }, () => {
  it('makes neither, sends no price, and reads an order without its money', async () => {
    expect((await call('production', 'POST', '/sales/orders/manual', manual('PO-CP012-PM'))).status).toBe(403)
    expect((await call('production', 'POST', '/sales/orders/manual', manual('PO-CP012-PM', [{ ...listed, unitPrice: '1' }]))).status).toBe(403)
    expect((await call('production', 'POST', '/sales/quotes', { companyId: companyA, partyId: P1 })).status).toBe(403)
    expect(await ordersOf('PO-CP012-PM')).toEqual([])
    const [made] = await ordersOf('PO-CP012-1')
    const read = await call('production', 'GET', `/sales/orders/${made!.id}`)
    expect(read.status, JSON.stringify(read.body)).toBe(200)
    expect(keysOf(read.body).filter((name) => PRICE_KEYS.includes(name))).toEqual([])
  })
})
