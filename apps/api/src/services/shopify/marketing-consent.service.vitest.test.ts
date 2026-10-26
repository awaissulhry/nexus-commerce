/**
 * Shopify marketing consent → Nexus (2026-10-26), on a real PostgreSQL with the production schema and every business
 * policy (PGlite), business profiles ON. Shopify is stubbed at the read-only admin reader (the gateway path itself is
 * proven in gateway/* and admin-client tests); the connection lookup is stubbed so no account table is needed.
 *
 * Proven here: only a hash of the e-mail is ever stored (Meta's normalisation: trim, lower case, SHA-256); a newer
 * consent is never overwritten by an older one; the webhook keeps buyers only (a row Nexus has, or a buyer Nexus knows);
 * a buyer's first order reads that one customer's consent once; customers/redact deletes the row, of its own account and
 * business only; the backfill keeps buyers only, pages, paces, resumes, answers counts only and refuses in words; and one
 * business never sees another's rows. Made-up ids and addresses (public repo).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { formulaDatabase } from '../../test-support/formula-database.js'
import { withWorkspace } from '../../lib/workspace-context.js'

type Read = (query: string, variables?: Record<string, unknown>) => Promise<{ data: any; errors: any[]; cost: any }>
const h = vi.hoisted(() => ({
  read: null as unknown as Read,
  reads: [] as Array<{ connectionId: string; query: string; variables: Record<string, unknown> }>,
  scopes: ['read_customers'] as string[],
  connections: {} as Record<string, { id: string; channelType: string; authStatus: string }>,
}))

vi.mock('./admin-client.js', () => ({
  shopifyAdminReader: vi.fn(async (connectionId: string) => ({
    domain: 'store-a.myshopify.com',
    grantedScopes: h.scopes,
    read: async (query: string, variables: Record<string, unknown> = {}) => {
      h.reads.push({ connectionId, query, variables })
      return h.read(query, variables)
    },
  })),
}))
vi.mock('../connection-resolver.service.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../connection-resolver.service.js')>()
  return {
    ...real,
    resolveConnection: vi.fn(async ({ accountId }: { accountId: string }) => {
      const c = h.connections[accountId]
      if (!c) throw new real.NoConnectionError('No such account.')
      return c
    }),
  }
})
vi.mock('../../utils/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }))

let database: Awaited<ReturnType<typeof formulaDatabase>>
vi.mock('../../db.js', () => ({ default: new Proxy({}, { get: (_target, property) => Reflect.get(database.client, property) }) }))

import { emailSha256, normalisedEmail, sha256Hex } from '../../lib/customer-email-hash.js'
import { sha256Hex as audienceSha256Hex, normalisedEmail as audienceNormalisedEmail } from '../marketing/meta-ads/audience-members.js'
import {
  backfillShopifyMarketingConsent, BUYER_CONSENT_QUERY, captureBuyerConsentAtOrder, captureBuyerConsentQuietly, CONSENT_CUSTOMERS_QUERY,
  CONSENT_PAGE_SIZE, consentStateOf, handleEmailConsentWebhook, MarketingConsentError, optInLevelOf, redactShopifyMarketingConsent,
  shopifyCustomerIdOf, writeConsent,
} from './marketing-consent.service.js'
import { logger } from '../../utils/logger.js'

const A = 'consent_alpha'
const B = 'consent_bravo'
const CONN_A = 'conn-shopify-a'
const CONN_A2 = 'conn-shopify-a2'
const CONN_B = 'conn-shopify-b'
const scope = (workspaceId: string) => ({ workspaceId, actorUserId: null, membershipId: null, roleKeys: [] })
const inA = <T>(work: () => Promise<T>) => withWorkspace(scope(A), work)
const inB = <T>(work: () => Promise<T>) => withWorkspace(scope(B), work)
const db = () => database.client
const rowsOf = (ws: string) => withWorkspace(scope(ws), () => db().shopifyMarketingConsent.findMany({ orderBy: [{ connectionId: 'asc' }, { shopifyCustomerId: 'asc' }] }))
const HEX64 = /\b[0-9a-f]{64}\b/
const gid = (id: string | number) => `gid://shopify/Customer/${id}`
const node = (id: number, orders: string, email: string | null, state = 'SUBSCRIBED', updatedAt: string | null = '2026-09-01T10:00:00Z', level: string | null = 'SINGLE_OPT_IN') => ({
  id: gid(id), numberOfOrders: orders,
  defaultEmailAddress: email === null ? null : { emailAddress: email, marketingState: state, marketingOptInLevel: level, marketingUpdatedAt: updatedAt },
})
const page = (nodes: unknown[], endCursor: string | null, cost: unknown = null) =>
  ({ data: { customers: { pageInfo: { hasNextPage: endCursor !== null, endCursor }, nodes } }, errors: [], cost })

let order = 0
async function shopifyBuyer(ws: string, email: string, channel: 'SHOPIFY' | 'AMAZON' = 'SHOPIFY') {
  await withWorkspace(scope(ws), async () => {
    const customer = await db().customer.upsert({ where: { workspace_email: { workspaceId: ws, email } }, create: { id: `cust_${ws}_${++order}`, email }, update: {} })
    await db().order.create({ data: {
      channel, channelOrderId: `ord-${ws}-${order}`, totalPrice: 10, customerName: 'Test Buyer', customerEmail: email, shippingAddress: {}, customerId: customer.id,
    } })
  })
}

beforeAll(async () => {
  database = await formulaDatabase()
  vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
  for (const id of [A, B]) {
    await database.db.query(`INSERT INTO "Workspace" (id, name, status, "createdByUserId", "creationKey", "updatedAt") VALUES ($1, $1, 'active', 'test', $1, CURRENT_TIMESTAMP)`, [id])
  }
}, 120_000)
afterAll(async () => {
  vi.unstubAllEnvs()
  await database?.close()
})
beforeEach(async () => {
  await database.db.query('DELETE FROM "ShopifyMarketingConsent"')
  await database.db.query('DELETE FROM "Order"')
  await database.db.query('DELETE FROM "Customer"')
  h.reads.length = 0
  h.scopes = ['read_customers']
  h.read = async () => { throw new Error('Shopify was not expected to be read here') }
  h.connections = {
    [CONN_A]: { id: CONN_A, channelType: 'SHOPIFY', authStatus: 'connected' },
    'conn-meta': { id: 'conn-meta', channelType: 'META', authStatus: 'connected' },
    'conn-revoked': { id: 'conn-revoked', channelType: 'SHOPIFY', authStatus: 'revoked' },
  }
  vi.mocked(logger.warn).mockClear()
})

describe('the e-mail hash is the one Meta customer lists need, and the only form an e-mail is kept in', () => {
  it('trims and lower-cases, then SHA-256 in lowercase hex; no address, no hash', () => {
    expect(emailSha256('  Mary@Example.COM ')).toBe(sha256Hex('mary@example.com'))
    expect(emailSha256('mary@example.com')).toBe('f1904cf1a9d73a55fa5de0ac823c4403ded71afd4c3248d00bdcd0866552bb79')
    expect(emailSha256('not an address')).toBeNull()
    expect(emailSha256(undefined)).toBeNull()
  })

  it('step 31 uses the very same normaliser (one implementation, re-exported)', () => {
    expect(audienceSha256Hex).toBe(sha256Hex)
    expect(audienceNormalisedEmail).toBe(normalisedEmail)
  })
})

describe("reading Shopify's values", () => {
  it('a customer id is digits from a number, digits or a Customer GID; a number past 2^53 or anything else is refused', () => {
    expect(shopifyCustomerIdOf(7012345678901)).toBe('7012345678901')
    expect(shopifyCustomerIdOf('7012345678901')).toBe('7012345678901')
    expect(shopifyCustomerIdOf(gid(7012345678901))).toBe('7012345678901')
    for (const bad of [706405506930370084, 0, -1, 1.5, '0', '', 'abc', 'gid://shopify/Order/1', null, undefined, {}]) expect(shopifyCustomerIdOf(bad), String(bad)).toBeNull()
  })

  it('states and opt-in levels are taken from an allow-list, in upper case', () => {
    expect(consentStateOf('subscribed')).toBe('SUBSCRIBED')
    expect(consentStateOf(' not_subscribed ')).toBe('NOT_SUBSCRIBED')
    expect(consentStateOf('redacted')).toBe('REDACTED')
    expect(consentStateOf('maybe')).toBeNull()
    expect(optInLevelOf('confirmed_opt_in')).toBe('CONFIRMED_OPT_IN')
    expect(optInLevelOf(null)).toBeNull()
  })
})

describe('the one write rule: never an older consent over a newer one', () => {
  const write = (over: Partial<Parameters<typeof writeConsent>[0]> = {}) => writeConsent({
    connectionId: CONN_A, shopifyCustomerId: '101', emailSha256: sha256Hex('a@example.com'), emailState: 'SUBSCRIBED',
    emailOptInLevel: 'SINGLE_OPT_IN', emailConsentAt: new Date('2026-10-01T10:00:00Z'), source: 'webhook', ...over,
  })

  it('creates, then changes for a newer or equal time, and keeps the row against an older one', async () => {
    await inA(async () => {
      expect(await write()).toBe('created')
      expect(await write({ emailState: 'UNSUBSCRIBED', emailConsentAt: new Date('2026-10-02T10:00:00Z') })).toBe('updated')
      expect(await write({ emailState: 'SUBSCRIBED', emailConsentAt: new Date('2026-10-01T23:00:00Z'), source: 'backfill' })).toBe('kept')
      expect(await write({ emailState: 'UNSUBSCRIBED', emailConsentAt: new Date('2026-10-02T10:00:00Z'), source: 'backfill' })).toBe('updated')
    })
    const [row] = await rowsOf(A)
    expect(row).toMatchObject({ connectionId: CONN_A, shopifyCustomerId: '101', emailState: 'UNSUBSCRIBED', source: 'backfill' })
  })

  it('a write without a time changes only a row without one', async () => {
    await inA(async () => {
      expect(await write({ shopifyCustomerId: '102', emailConsentAt: null })).toBe('created')
      expect(await write({ shopifyCustomerId: '102', emailConsentAt: null, emailState: 'PENDING' })).toBe('updated')
      expect(await write({ shopifyCustomerId: '102', emailState: 'UNSUBSCRIBED' })).toBe('updated')
      expect(await write({ shopifyCustomerId: '102', emailConsentAt: null, emailState: 'SUBSCRIBED' })).toBe('kept')
    })
    expect((await rowsOf(A))[0].emailState).toBe('UNSUBSCRIBED')
  })
})

describe('the customers_email_marketing_consent/update webhook keeps buyers only', () => {
  const delivery = (over: Record<string, unknown> = {}, consent: Record<string, unknown> = {}) => ({
    customer_id: 7012345678901, email_address: ' Buyer.One@Example.com ',
    email_marketing_consent: { state: 'subscribed', opt_in_level: 'single_opt_in', consent_updated_at: '2026-10-20T08:00:00Z', ...consent }, ...over,
  })

  it('a buyer Nexus knows (a Shopify order with that e-mail) gets a row: the hash, the state and the time, never the address', async () => {
    await shopifyBuyer(A, 'buyer.one@example.com')
    expect(await inA(() => handleEmailConsentWebhook(delivery(), { connectionId: CONN_A }))).toEqual({ written: 'created' })
    const rows = await rowsOf(A)
    expect(rows).toEqual([expect.objectContaining({
      connectionId: CONN_A, shopifyCustomerId: '7012345678901', emailSha256: sha256Hex('buyer.one@example.com'), emailState: 'SUBSCRIBED',
      emailOptInLevel: 'SINGLE_OPT_IN', emailConsentAt: new Date('2026-10-20T08:00:00Z'), source: 'webhook',
    })])
    expect(JSON.stringify(rows)).not.toMatch(/@/)
  })

  it('someone with no Shopify order in Nexus is ignored and nothing of them is kept (an Amazon order does not count)', async () => {
    await shopifyBuyer(A, 'buyer.one@example.com', 'AMAZON')
    expect(await inA(() => handleEmailConsentWebhook(delivery(), { connectionId: CONN_A }))).toEqual({ ignored: 'not_a_known_buyer' })
    expect(await rowsOf(A)).toEqual([])
  })

  it('a customer who already has a row is updated by a newer change and not by an older, late one', async () => {
    await inA(() => writeConsent({ connectionId: CONN_A, shopifyCustomerId: '7012345678901', emailSha256: sha256Hex('buyer.one@example.com'), emailState: 'SUBSCRIBED', emailOptInLevel: null, emailConsentAt: new Date('2026-10-01T00:00:00Z'), source: 'backfill' }))
    expect(await inA(() => handleEmailConsentWebhook(delivery({}, { state: 'unsubscribed', consent_updated_at: '2026-10-21T09:00:00Z' }), { connectionId: CONN_A }))).toEqual({ written: 'updated' })
    expect(await inA(() => handleEmailConsentWebhook(delivery({}, { state: 'subscribed', consent_updated_at: '2026-10-20T09:00:00Z' }), { connectionId: CONN_A }))).toEqual({ written: 'kept' })
    expect((await rowsOf(A))[0]).toMatchObject({ emailState: 'UNSUBSCRIBED', source: 'webhook' })
  })

  it('a delivery without a usable id, e-mail or state, or without an account, writes nothing', async () => {
    await shopifyBuyer(A, 'buyer.one@example.com')
    await inA(async () => {
      expect(await handleEmailConsentWebhook(delivery({ customer_id: 706405506930370084 }), { connectionId: CONN_A })).toEqual({ ignored: 'unreadable' })
      expect(await handleEmailConsentWebhook(delivery({ email_address: 'nobody' }), { connectionId: CONN_A })).toEqual({ ignored: 'unreadable' })
      expect(await handleEmailConsentWebhook(delivery({}, { state: 'unknown_state' }), { connectionId: CONN_A })).toEqual({ ignored: 'unreadable' })
      expect(await handleEmailConsentWebhook(delivery(), { connectionId: null })).toEqual({ ignored: 'no_account' })
    })
    expect(await rowsOf(A)).toEqual([])
    // The log line names what was missing, never the address.
    expect(JSON.stringify(vi.mocked(logger.warn).mock.calls)).not.toMatch(/example\.com/i)
  })

  it("a buyer of one business is not a buyer of another, and one business never sees the other's rows", async () => {
    await shopifyBuyer(A, 'buyer.one@example.com')
    expect(await inB(() => handleEmailConsentWebhook(delivery(), { connectionId: CONN_B }))).toEqual({ ignored: 'not_a_known_buyer' })
    await inA(() => handleEmailConsentWebhook(delivery(), { connectionId: CONN_A }))
    expect(await rowsOf(A)).toHaveLength(1)
    expect(await rowsOf(B)).toEqual([])
  })
})

describe("a buyer's first Shopify order reads that one customer's consent", () => {
  const shopifyOrder = { id: 820001, customer: { id: 7012345678902, email: 'buyer.two@example.com' } }

  it('no row yet: one read of that customer (its default e-mail consent only), then the row', async () => {
    h.read = async () => ({ data: { customer: { id: gid(7012345678902), defaultEmailAddress: { emailAddress: 'Buyer.Two@example.com', marketingState: 'SUBSCRIBED', marketingOptInLevel: 'CONFIRMED_OPT_IN', marketingUpdatedAt: '2026-10-25T12:00:00Z' } } }, errors: [], cost: null })
    expect(await inA(() => captureBuyerConsentAtOrder(CONN_A, shopifyOrder))).toBe('created')
    expect(h.reads).toEqual([{ connectionId: CONN_A, query: BUYER_CONSENT_QUERY, variables: { id: gid(7012345678902) } }])
    expect(BUYER_CONSENT_QUERY).not.toMatch(/\b(firstName|lastName|phone|addresses|note|tags|orders)\b/)
    expect((await rowsOf(A))[0]).toMatchObject({ shopifyCustomerId: '7012345678902', emailSha256: sha256Hex('buyer.two@example.com'), emailState: 'SUBSCRIBED', emailOptInLevel: 'CONFIRMED_OPT_IN', source: 'order' })
  })

  it('a customer who already has a row, or an order with no customer, reads nothing', async () => {
    await inA(() => writeConsent({ connectionId: CONN_A, shopifyCustomerId: '7012345678902', emailSha256: sha256Hex('buyer.two@example.com'), emailState: 'NOT_SUBSCRIBED', emailOptInLevel: null, emailConsentAt: null, source: 'backfill' }))
    expect(await inA(() => captureBuyerConsentAtOrder(CONN_A, shopifyOrder))).toBe('already_known')
    expect(await inA(() => captureBuyerConsentAtOrder(CONN_A, { id: 820002 }))).toBe('no_customer')
    expect(await inA(() => captureBuyerConsentAtOrder(null, shopifyOrder))).toBe('no_customer')
    expect(h.reads).toEqual([])
  })

  it('a buyer without an e-mail gets no row; a refused read throws, and the order path only logs it', async () => {
    h.read = async () => ({ data: { customer: { id: gid(7012345678902), defaultEmailAddress: null } }, errors: [], cost: null })
    expect(await inA(() => captureBuyerConsentAtOrder(CONN_A, shopifyOrder))).toBe('no_email')
    h.read = async () => ({ data: null, errors: [{ message: 'Access denied', extensions: { code: 'ACCESS_DENIED' } }], cost: null })
    await expect(inA(() => captureBuyerConsentAtOrder(CONN_A, shopifyOrder))).rejects.toThrow(/refused the customer consent read: Access denied/)
    await expect(inA(() => captureBuyerConsentQuietly(CONN_A, shopifyOrder))).resolves.toBeUndefined()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(expect.stringContaining('a later order or a run of the backfill fills it'), expect.objectContaining({ connectionId: CONN_A }))
    expect(await rowsOf(A)).toEqual([])
  })
})

describe('customers/redact deletes the customer\'s consent row, of its own account and business only', () => {
  const seed = async () => {
    const one = { emailState: 'SUBSCRIBED' as const, emailOptInLevel: null, emailConsentAt: null, source: 'backfill' as const }
    await inA(async () => {
      await writeConsent({ ...one, connectionId: CONN_A, shopifyCustomerId: '201', emailSha256: sha256Hex('redact.me@example.com') })
      await writeConsent({ ...one, connectionId: CONN_A, shopifyCustomerId: '202', emailSha256: sha256Hex('keep.me@example.com') })
      await writeConsent({ ...one, connectionId: CONN_A2, shopifyCustomerId: '201', emailSha256: sha256Hex('other.shop@example.com') })
    })
    await inB(() => writeConsent({ ...one, connectionId: CONN_B, shopifyCustomerId: '201', emailSha256: sha256Hex('redact.me@example.com') }))
  }

  it('by the Shopify id (and the e-mail hash), on the account the notice came through', async () => {
    await seed()
    const notice = { shop_id: 954889, shop_domain: 'store-a.myshopify.com', customer: { id: 201, email: 'Redact.Me@example.com', phone: '555-0100' }, orders_to_redact: [1, 2] }
    expect(await inA(() => redactShopifyMarketingConsent(notice, { connectionId: CONN_A }))).toBe(1)
    expect((await rowsOf(A)).map((r) => `${r.connectionId}/${r.shopifyCustomerId}`)).toEqual([`${CONN_A}/202`, `${CONN_A2}/201`])
    expect(await rowsOf(B)).toHaveLength(1)
  })

  it('by the e-mail hash when the row names another id; nothing without an account or a customer', async () => {
    await seed()
    expect(await inA(() => redactShopifyMarketingConsent({ customer: { id: 999, email: 'keep.me@example.com' } }, { connectionId: CONN_A }))).toBe(1)
    expect(await inA(() => redactShopifyMarketingConsent({ customer: { id: 202 } }, { connectionId: null }))).toBe(0)
    expect(await inA(() => redactShopifyMarketingConsent({}, { connectionId: CONN_A }))).toBe(0)
    expect(await rowsOf(A)).toHaveLength(2)
  })
})

describe('the backfill a person runs: buyers only, page by page, counts only', () => {
  it('keeps buyers with an e-mail, skips the rest in memory, and answers counts only', async () => {
    const pages = [
      page([node(301, '2', ' First@Example.com '), node(302, '0', 'subscriber.only@example.com'), node(303, '1', null), node(304, '5', 'second@example.com', 'UNSUBSCRIBED', null, null)], 'cursor-1'),
      page([node(305, '1', 'third@example.com', 'SOMETHING_NEW'), { id: 'gid://shopify/Order/1', numberOfOrders: '1', defaultEmailAddress: null }, node(306, 'x', 'a@example.com'), node(307, '3', 'fourth@example.com', 'PENDING')], null),
    ]
    h.read = async () => pages.shift()!
    const result = await inA(() => backfillShopifyMarketingConsent(CONN_A))
    expect(result).toEqual({
      accountId: CONN_A, customersRead: 8, created: 3, updated: 0, keptNewer: 0, skippedNotBuyers: 1, skippedNoEmail: 1, skippedUnreadable: 3,
      pages: 2, stoppedBecause: 'complete', complete: true, resumeAfter: null, throttleWaits: 0, waitedMs: 0,
    })
    expect(h.reads.map((r) => r.variables)).toEqual([{ first: CONSENT_PAGE_SIZE, after: null }, { first: CONSENT_PAGE_SIZE, after: 'cursor-1' }])
    expect(h.reads.every((r) => r.query === CONSENT_CUSTOMERS_QUERY)).toBe(true)
    expect(CONSENT_CUSTOMERS_QUERY).not.toMatch(/\b(firstName|lastName|phone|addresses|note|tags)\b/)
    const rows = await rowsOf(A)
    expect(rows.map((r) => [r.shopifyCustomerId, r.emailState, r.emailSha256 === sha256Hex(['first', 'second', 'fourth'][rows.indexOf(r)] + '@example.com'), r.source]))
      .toEqual([['301', 'SUBSCRIBED', true, 'backfill'], ['304', 'UNSUBSCRIBED', true, 'backfill'], ['307', 'PENDING', true, 'backfill']])
    expect(JSON.stringify(result)).not.toMatch(HEX64)
    expect(JSON.stringify(result)).not.toMatch(/@/)
  })

  it('running it again changes nothing, and a newer webhook consent stays', async () => {
    const one = () => page([node(301, '2', 'first@example.com', 'SUBSCRIBED', '2026-09-01T10:00:00Z')], null)
    h.read = async () => one()
    await inA(() => backfillShopifyMarketingConsent(CONN_A))
    await inA(() => writeConsent({ connectionId: CONN_A, shopifyCustomerId: '301', emailSha256: sha256Hex('first@example.com'), emailState: 'UNSUBSCRIBED', emailOptInLevel: null, emailConsentAt: new Date('2026-10-20T10:00:00Z'), source: 'webhook' }))
    const again = await inA(() => backfillShopifyMarketingConsent(CONN_A))
    expect(again).toMatchObject({ created: 0, updated: 0, keptNewer: 1 })
    expect((await rowsOf(A))[0]).toMatchObject({ emailState: 'UNSUBSCRIBED', source: 'webhook' })
  })

  it('stops at its page bound with where to resume, and the next run starts there', async () => {
    h.read = async (_q, vars) => vars?.after === 'cursor-2' ? page([node(402, '1', 'b@example.com')], null) : page([node(401, '1', 'a@example.com')], 'cursor-2')
    const first = await inA(() => backfillShopifyMarketingConsent(CONN_A, { maxPages: 1 }))
    expect(first).toMatchObject({ pages: 1, stoppedBecause: 'max_pages', complete: false, resumeAfter: 'cursor-2', created: 1 })
    const second = await inA(() => backfillShopifyMarketingConsent(CONN_A, { after: first.resumeAfter }))
    expect(second).toMatchObject({ pages: 1, stoppedBecause: 'complete', complete: true, resumeAfter: null, created: 1 })
    expect(h.reads.map((r) => r.variables.after)).toEqual([null, 'cursor-2'])
  })

  it("paces itself by Shopify's cost bucket, and stops as throttled (resumable) once the waits would pass the bound", async () => {
    const tight = { requestedQueryCost: 502, actualQueryCost: 500, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 2, restoreRate: 100 } }
    const pages = [page([node(501, '1', 'a@example.com')], 'c1', tight), page([node(502, '1', 'b@example.com')], 'c2', tight), page([node(503, '1', 'c@example.com')], null)]
    h.read = async () => pages.shift()!
    const sleep = vi.fn(async () => undefined)
    const paced = await inA(() => backfillShopifyMarketingConsent(CONN_A, { sleep, maxWaitMs: 60_000 }))
    expect(sleep.mock.calls).toEqual([[5000], [5000]])
    expect(paced).toMatchObject({ complete: true, throttleWaits: 2, waitedMs: 10_000, created: 3 })

    h.read = async () => page([node(601, '1', 'd@example.com')], 'c9', tight)
    const cut = await inA(() => backfillShopifyMarketingConsent(CONN_A, { sleep, maxWaitMs: 1000 }))
    expect(cut).toMatchObject({ pages: 1, stoppedBecause: 'throttled', complete: false, resumeAfter: 'c9' })
  })

  it('a THROTTLED answer: refused before any page, a resumable stop after one', async () => {
    h.read = async () => ({ data: null, errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], cost: null })
    await expect(inA(() => backfillShopifyMarketingConsent(CONN_A))).rejects.toMatchObject({ code: 'SHOPIFY_THROTTLED', statusCode: 429 })
    const pages = [page([node(701, '1', 'a@example.com')], 'c1'), { data: null, errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], cost: null }]
    h.read = async () => pages.shift()!
    expect(await inA(() => backfillShopifyMarketingConsent(CONN_A))).toMatchObject({ pages: 1, stoppedBecause: 'throttled', resumeAfter: 'c1', created: 1 })
  })

  it('refuses in words: another channel, an account to sign in again, a missing scope (before any read), access denied, a bad cursor', async () => {
    const refusal = (accountId: string, opts = {}) => inA(() => backfillShopifyMarketingConsent(accountId, opts)).then(() => null, (e: MarketingConsentError) => ({ code: e.code, status: e.statusCode, message: e.message }))
    expect(await refusal('conn-missing')).toMatchObject({ code: 'ACCOUNT_NOT_FOUND', status: 404 })
    expect(await refusal('conn-meta')).toMatchObject({ code: 'NOT_SHOPIFY', status: 400 })
    expect(await refusal('conn-revoked')).toMatchObject({ code: 'ACCOUNT_NEEDS_SIGNIN', status: 409 })
    expect(await refusal(CONN_A, { after: '' })).toMatchObject({ code: 'BAD_CURSOR', status: 400 })
    h.scopes = ['read_orders']
    expect(await refusal(CONN_A)).toMatchObject({ code: 'SCOPE_MISSING', status: 409, message: expect.stringContaining('read_customers') })
    expect(h.reads).toEqual([])
    h.scopes = ['read_customers']
    h.read = async () => ({ data: null, errors: [{ message: 'Access denied for customers field.', extensions: { code: 'ACCESS_DENIED' } }], cost: null })
    expect(await refusal(CONN_A)).toMatchObject({ code: 'SHOPIFY_ACCESS_DENIED', status: 403 })
    expect(await rowsOf(A)).toEqual([])
  })

  it("writes only into the business it runs in", async () => {
    h.read = async () => page([node(801, '1', 'a@example.com')], null)
    await inA(() => backfillShopifyMarketingConsent(CONN_A))
    expect(await rowsOf(A)).toHaveLength(1)
    expect(await rowsOf(B)).toEqual([])
  })
})
