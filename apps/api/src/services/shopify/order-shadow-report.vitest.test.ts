/**
 * Shopify orders shadow report — the read-only measurement taken before anyone builds order ingest
 * (review of PLAN-SHOPIFY-ORDERS.md, S5 moved first).
 *
 * Propositions:
 *   A. the switch: off unless NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT is exactly '1'; off sends nothing
 *      and reads nothing.
 *   B. the read: pages by cursor, stops at its page bound, waits for Shopify's cost bucket, and a
 *      throttle after the gateway's own retries ends the read with what it has.
 *   C. the counts: weeks, status mix, test / POS, fulfilment locations, SKU match by the order
 *      writer's rule (exact SKU in this business), near misses and unmatched shapes.
 *   D. no buyer data: nothing personal is asked for, and nothing personal comes out even when the
 *      answer carries it.
 *   E. no write path: every channel call is a `read` on the current GraphQL Admin API, a change
 *      document is refused before anything is sent, and the database is only read (Product SKUs).
 *
 * The gateway, the account and the token are stood in; nothing here calls Shopify.
 */
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SHOPIFY_API_VERSION } from './api-version.js'

type Row = { sku: string; deletedAt: Date | null }
const h = vi.hoisted(() => {
  const state = {
    pages: [] as unknown[],
    requests: [] as Array<{ channel: string; kind: string; method: string; url: string; operation: string; connectionId: string | null; body: unknown }>,
    dbCalls: [] as string[],
    products: [] as Array<{ sku: string; deletedAt: Date | null }>,
  }
  const call = (name: string, args: unknown) => {
    state.dbCalls.push(name)
    if (name !== 'product.findMany') throw new Error(`the shadow report may not call prisma.${name}`)
    const where = (args as { where?: { sku?: { in?: string[]; mode?: string } } })?.where?.sku
    const wanted = where?.in ?? []
    const insensitive = where?.mode === 'insensitive'
    return Promise.resolve(state.products.filter((row) => wanted.some((sku) => (insensitive ? sku.toLowerCase() === row.sku.toLowerCase() : sku === row.sku))))
  }
  // Every property is a model (or a $-method); every model property is a method. Each call is recorded.
  const prisma = new Proxy(function () {}, {
    get: (_t, model) => new Proxy(function () {}, {
      get: (_m, method) => (args: unknown) => call(`${String(model)}.${String(method)}`, args),
      apply: (_m, _this, args) => call(`${String(model)}()`, args[0]),
    }),
  })
  return { state, prisma }
})

vi.mock('../../db.js', () => ({ default: h.prisma }))
vi.mock('../connection-resolver.service.js', () => ({
  resolveConnection: vi.fn(async ({ accountId }: { accountId: string }) => ({ id: accountId, channelType: 'SHOPIFY', region: 'nexus-shadow.myshopify.com' })),
}))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'token-shadow'), assertWritable: vi.fn(async () => undefined) }))
vi.mock('../gateway/gateway.js', () => ({
  gatewayFetch: vi.fn(async (req: { channel: string; kind: string; method: string; url: string; operation: string; connectionId: string | null; body: unknown }) => {
    h.state.requests.push({ channel: req.channel, kind: req.kind, method: req.method, url: req.url, operation: req.operation, connectionId: req.connectionId, body: req.body })
    const next = h.state.pages.shift()
    if (next === undefined) throw new Error('the test ran out of Shopify pages')
    if (next instanceof Response) return next
    return new Response(JSON.stringify(next), { status: 200, headers: { 'content-type': 'application/json' } })
  }),
}))

import { shopifyAdminReader } from './admin-client.js'
import {
  SHADOW_ORDERS_QUERY,
  aggregateShadowReport,
  readShadowOrders,
  shopifyShadowReport,
  shopifyShadowReportEnabled,
  skuShape,
  type ShadowOrder,
} from './order-shadow-report.service.js'

const NOW = new Date('2026-09-26T12:00:00Z')
const LOC_MAIN = { id: 'gid://shopify/Location/111', name: 'IT-MAIN warehouse' }
const LOC_SHOP = { id: 'gid://shopify/Location/222', name: 'Shop counter' }

function order(over: Partial<ShadowOrder> & Record<string, unknown> = {}): ShadowOrder {
  return {
    createdAt: '2026-09-21T10:00:00Z',
    cancelledAt: null,
    test: false,
    sourceName: 'web',
    displayFinancialStatus: 'PAID',
    displayFulfillmentStatus: 'FULFILLED',
    lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'SKU-1', quantity: 1 }] },
    fulfillments: [{ status: 'SUCCESS', location: LOC_MAIN }],
    ...over,
  } as ShadowOrder
}

const plentyCost = { requestedQueryCost: 300, actualQueryCost: 40, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 1960, restoreRate: 100 } }
function page(nodes: unknown[], next: string | null = null, cost: unknown = plentyCost, extra: Record<string, unknown> = {}) {
  return { data: { orders: { pageInfo: { hasNextPage: next !== null, endCursor: next }, nodes } }, extensions: { cost }, ...extra }
}
const throttledAnswer = { errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }], extensions: { cost: plentyCost } }

beforeEach(() => {
  h.state.pages = []
  h.state.requests = []
  h.state.dbCalls = []
  h.state.products = []
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT', '1')
})
afterEach(() => vi.unstubAllEnvs())

const noSleep = async () => undefined

// ── A. the switch ────────────────────────────────────────────────────────────
describe('A. the switch — off by default, exactly "1" turns it on', () => {
  it.each([[undefined], [''], ['0'], ['true'], ['yes'], [' 1']])('value %j is OFF: nothing is sent to Shopify and nothing is read', async (value) => {
    if (value === undefined) vi.stubEnv('NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT', undefined as unknown as string)
    else vi.stubEnv('NEXUS_ENABLE_SHOPIFY_SHADOW_REPORT', value)
    expect(shopifyShadowReportEnabled()).toBe(false)
    await expect(shopifyShadowReport('acct-1', { now: NOW, sleep: noSleep })).rejects.toMatchObject({ code: 'SHOPIFY_SHADOW_REPORT_OFF', statusCode: 404 })
    expect(h.state.requests).toHaveLength(0)
    expect(h.state.dbCalls).toHaveLength(0)
  })

  it('"1" is ON', () => {
    expect(shopifyShadowReportEnabled()).toBe(true)
  })

  it('the window is bounded: 1 to 90 days, default 60', async () => {
    for (const days of [0, 91, 2.5, Number.NaN]) {
      await expect(shopifyShadowReport('acct-1', { days, now: NOW, sleep: noSleep })).rejects.toMatchObject({ code: 'SHOPIFY_SHADOW_REPORT_WINDOW', statusCode: 400 })
    }
    expect(h.state.requests).toHaveLength(0)
    h.state.pages = [page([])]
    const report = await shopifyShadowReport('acct-1', { now: NOW, sleep: noSleep })
    expect(report.window.days).toBe(60)
    expect(report.window.since).toBe('2026-07-28T12:00:00.000Z')
  })
})

// ── B. the read ──────────────────────────────────────────────────────────────
describe('B. the read — paginated, bounded, rate-limit aware', () => {
  it('follows the cursor until Shopify says there is no next page', async () => {
    h.state.pages = [page([order()], 'c1'), page([order()], 'c2'), page([order()])]
    const { read } = await shopifyAdminReader('acct-1')
    const result = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })
    expect(result.orders).toHaveLength(3)
    expect(result.pages).toBe(3)
    expect(result.stoppedBecause).toBe('complete')
    const variables = h.state.requests.map((r) => JSON.parse(String(r.body)).variables)
    expect(variables.map((v) => v.after)).toEqual([null, 'c1', 'c2'])
    // One day earlier than the window, as a date: the exact boundary is applied to createdAt afterwards.
    expect(variables[0].query).toBe('created_at:>=2026-07-27')
    expect(variables[0].first).toBeLessThanOrEqual(25)
  })

  it('stops at its page bound and says the read is incomplete', async () => {
    h.state.pages = [page([order()], 'c1'), page([order()], 'c2'), page([order()], 'c3')]
    const { read } = await shopifyAdminReader('acct-1')
    const result = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep, maxPages: 2 })
    expect(result.pages).toBe(2)
    expect(result.stoppedBecause).toBe('max_pages')
    expect(h.state.requests).toHaveLength(2)
  })

  it('waits for the cost bucket to refill before the next page', async () => {
    const low = { requestedQueryCost: 600, actualQueryCost: 80, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } }
    h.state.pages = [page([order()], 'c1', low), page([order()])]
    const waits: number[] = []
    const { read } = await shopifyAdminReader('acct-1')
    const result = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: async (ms) => { waits.push(ms) } })
    // (600 needed − 100 available) / 100 per second = 5 s.
    expect(waits).toEqual([5000])
    expect(result.throttleWaits).toBe(1)
    expect(result.waitedMs).toBe(5000)
    expect(result.stoppedBecause).toBe('complete')
  })

  it('does not wait after the last page, nor when the bucket has room', async () => {
    const low = { requestedQueryCost: 600, actualQueryCost: 80, throttleStatus: { maximumAvailable: 2000, currentlyAvailable: 100, restoreRate: 100 } }
    h.state.pages = [page([order()], 'c1'), page([order()], null, low)]
    const waits: number[] = []
    const { read } = await shopifyAdminReader('acct-1')
    await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: async (ms) => { waits.push(ms) } })
    expect(waits).toEqual([])
  })

  it('a wait beyond the budget ends the read as throttled, with what was read', async () => {
    const empty = { requestedQueryCost: 900, actualQueryCost: 80, throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 0, restoreRate: 10 } }
    h.state.pages = [page([order(), order()], 'c1', empty)]
    const { read } = await shopifyAdminReader('acct-1')
    const result = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep, maxWaitMs: 20_000 })
    expect(result.stoppedBecause).toBe('throttled')
    expect(result.orders).toHaveLength(2)
    expect(h.state.requests).toHaveLength(1)
  })

  it('THROTTLED after the gateway retries: later pages end the read; on the first page it is an error', async () => {
    h.state.pages = [page([order()], 'c1'), throttledAnswer]
    const { read } = await shopifyAdminReader('acct-1')
    const partial = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })
    expect(partial.stoppedBecause).toBe('throttled')
    expect(partial.orders).toHaveLength(1)

    h.state.pages = [throttledAnswer]
    await expect(readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })).rejects.toMatchObject({ code: 'SHOPIFY_THROTTLED', statusCode: 429 })
  })

  it('a location Shopify will not show (ACCESS_DENIED) keeps the orders and says locations were unreadable', async () => {
    const denied = page([order({ fulfillments: [{ status: 'SUCCESS', location: null }] })], null, plentyCost, {
      errors: [{ message: 'Access denied for location field.', path: ['orders', 'nodes', 0, 'fulfillments', 0, 'location'], extensions: { code: 'ACCESS_DENIED' } }],
    })
    h.state.pages = [denied]
    const { read } = await shopifyAdminReader('acct-1')
    const result = await readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })
    expect(result.locationsReadable).toBe(false)
    expect(result.orders).toHaveLength(1)
  })

  it('any other GraphQL error, or an HTTP failure, is an error — never an empty report', async () => {
    h.state.pages = [{ errors: [{ message: 'Field "foo" does not exist', extensions: { code: 'undefinedField' } }] }]
    const { read } = await shopifyAdminReader('acct-1')
    await expect(readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })).rejects.toMatchObject({ code: 'SHOPIFY_QUERY_FAILED', statusCode: 502 })
    h.state.pages = [new Response('{"errors":"Invalid API key or access token"}', { status: 401 })]
    await expect(readShadowOrders(read, { since: new Date('2026-07-28T12:00:00Z'), sleep: noSleep })).rejects.toThrow(/HTTP 401/)
  })
})

// ── C. the counts ────────────────────────────────────────────────────────────
describe('C. the counts', () => {
  const since = new Date('2026-09-01T00:00:00Z')
  const until = new Date('2026-09-26T12:00:00Z')

  it('orders per week (Monday, UTC), with empty weeks shown and orders before the window left out', () => {
    const report = aggregateShadowReport({
      orders: [
        order({ createdAt: '2026-09-01T08:00:00Z' }), // Tue → week of Mon 2026-08-31
        order({ createdAt: '2026-09-02T08:00:00Z', lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'SKU-1', quantity: 3 }] } }),
        order({ createdAt: '2026-09-21T00:00:00Z' }), // Mon → its own week
        order({ createdAt: '2026-08-31T23:59:59Z' }), // before `since`: read, not counted
      ],
      products: [{ sku: 'SKU-1', deletedAt: null }],
      since, until,
    })
    expect(report.orders.total).toBe(3)
    expect(report.orders.outsideWindow).toBe(1)
    expect(report.orders.perWeek).toEqual([
      { weekStart: '2026-08-31', orders: 2, units: 4 },
      { weekStart: '2026-09-07', orders: 0, units: 0 },
      { weekStart: '2026-09-14', orders: 0, units: 0 },
      { weekStart: '2026-09-21', orders: 1, units: 1 },
    ])
  })

  it('financial and fulfilment status mix, cancelled, test and POS shares', () => {
    const report = aggregateShadowReport({
      orders: [
        order({ displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'FULFILLED' }),
        order({ displayFinancialStatus: 'PAID', displayFulfillmentStatus: 'UNFULFILLED', fulfillments: [] }),
        order({ displayFinancialStatus: 'REFUNDED', displayFulfillmentStatus: 'UNFULFILLED', cancelledAt: '2026-09-22T00:00:00Z', fulfillments: [] }),
        order({ test: true, displayFinancialStatus: null }),
        order({ sourceName: 'pos', fulfillments: [{ status: 'SUCCESS', location: LOC_SHOP }] }),
        order({ sourceName: null }),
      ],
      products: [{ sku: 'SKU-1', deletedAt: null }],
      since, until,
    })
    expect(report.orders.total).toBe(6)
    expect(report.orders.cancelled).toBe(1)
    expect(report.orders.test).toBe(1)
    expect(report.orders.pos).toBe(1)
    expect(report.orders.financialStatus).toEqual([
      { value: 'PAID', orders: 4 },
      { value: 'REFUNDED', orders: 1 },
      { value: 'UNKNOWN', orders: 1 },
    ])
    expect(report.orders.fulfillmentStatus).toEqual([
      { value: 'FULFILLED', orders: 4 },
      { value: 'UNFULFILLED', orders: 2 },
    ])
    expect(report.orders.sources).toEqual([
      { value: 'web', orders: 4 },
      { value: 'pos', orders: 1 },
      { value: 'unknown', orders: 1 },
    ])
  })

  it('fulfilment locations by id, with orders and fulfilments counted, and fulfilments without one', () => {
    const report = aggregateShadowReport({
      orders: [
        order({ fulfillments: [{ status: 'SUCCESS', location: LOC_MAIN }, { status: 'SUCCESS', location: LOC_MAIN }] }),
        order({ fulfillments: [{ status: 'SUCCESS', location: LOC_MAIN }] }),
        order({ fulfillments: [{ status: 'CANCELLED', location: LOC_SHOP }] }),
        order({ fulfillments: [{ status: 'SUCCESS', location: null }] }),
        order({ fulfillments: [] }),
      ],
      products: [{ sku: 'SKU-1', deletedAt: null }],
      since, until,
    })
    expect(report.locations.used).toEqual([
      { id: LOC_MAIN.id, name: LOC_MAIN.name, orders: 2, fulfillments: 3, cancelledFulfillments: 0 },
      { id: LOC_SHOP.id, name: LOC_SHOP.name, orders: 1, fulfillments: 1, cancelledFulfillments: 1 },
    ])
    expect(report.locations.fulfillmentsWithoutLocation).toBe(1)
    expect(report.locations.ordersWithoutFulfillment).toBe(1)
  })

  it('SKU match by the order writer’s rule: exact SKU in this business; near misses and gaps named', () => {
    const lines = (...nodes: Array<{ sku: string | null; quantity: number }>) => ({ pageInfo: { hasNextPage: false }, nodes })
    const report = aggregateShadowReport({
      orders: [
        order({ lineItems: lines({ sku: 'SKU-1', quantity: 2 }, { sku: 'SKU-2', quantity: 1 }) }), // fully
        order({ lineItems: lines({ sku: 'SKU-1', quantity: 1 }, { sku: 'sku-2 ', quantity: 1 }) }), // partly (near miss)
        order({ lineItems: lines({ sku: 'GALE-XL-01', quantity: 1 }) }), // unmatched
        order({ lineItems: lines({ sku: 'GALE-XS-02', quantity: 4 }, { sku: null, quantity: 1 }) }), // unmatched + a line without SKU
        order({ lineItems: lines({ sku: 'OLD-9', quantity: 1 }) }), // matches a deleted product: counted, and flagged
        order({ lineItems: { pageInfo: { hasNextPage: true }, nodes: [{ sku: 'SKU-1', quantity: 1 }] } }), // more lines than read
      ],
      products: [{ sku: 'SKU-1', deletedAt: null }, { sku: 'SKU-2', deletedAt: null }, { sku: 'OLD-9', deletedAt: new Date('2026-01-01') }],
      since, until,
    })
    expect(report.skus).toMatchObject({
      lines: 9,
      units: 13,
      linesWithoutSku: 1,
      matchedLines: 5,
      matchedUnits: 6,
      // Unmatched = a SKU the writer would not find (3); a near match is one of them that differs only in case or spaces.
      unmatchedLines: 3,
      nearMatchLines: 1,
      deletedProductLines: 1,
      ordersFullyMatched: 3,
      ordersPartlyMatched: 1,
      ordersUnmatched: 2,
      ordersWithUnreadLines: 1,
      orderMatchRate: 0.5,
      lineMatchRate: 5 / 9,
    })
    // Most lines first, then most units, then the SKU.
    expect(report.skus.unmatched).toEqual([
      { sku: 'GALE-XS-02', lines: 1, units: 4, nearMatch: false },
      { sku: 'GALE-XL-01', lines: 1, units: 1, nearMatch: false },
      { sku: 'sku-2 ', lines: 1, units: 1, nearMatch: true },
    ])
    expect(report.skus.unmatchedShapes).toEqual([
      { shape: 'A-A-9', lines: 2 },
      { shape: 'a-9 ', lines: 1 },
    ])
  })

  it('SKU shape keeps separators and case class, never the value', () => {
    expect(skuShape('GALE-XL-01')).toBe('A-A-9')
    expect(skuShape('ab12cd')).toBe('a9a')
    expect(skuShape('X'.repeat(80)).length).toBeLessThanOrEqual(40)
  })

  it('an empty window is a report of zeros, not an error', () => {
    const report = aggregateShadowReport({ orders: [], products: [], since, until })
    expect(report.orders.total).toBe(0)
    expect(report.skus.orderMatchRate).toBeNull()
    expect(report.orders.perWeek.every((w) => w.orders === 0)).toBe(true)
  })
})

// ── D. no buyer data ─────────────────────────────────────────────────────────
describe('D. no buyer data', () => {
  it('the query asks for no buyer field', () => {
    const body = SHADOW_ORDERS_QUERY.replace(/location\s*\{\s*id\s+name\s*\}/, 'location { id }')
    for (const field of ['customer', 'email', 'phone', 'Address', 'address', 'firstName', 'lastName', 'note', 'title', 'name', 'billing', 'shipping', 'clientIp', 'browserIp', 'customAttributes']) {
      expect(body, field).not.toContain(field)
    }
  })

  it('an answer that carries buyer data still gives a report without it', async () => {
    const pii = {
      email: 'mario.rossi@example.com',
      phone: '+39 3471234567',
      name: '#1001',
      customer: { firstName: 'Mario', lastName: 'Rossi', email: 'mario.rossi@example.com' },
      shippingAddress: { address1: 'Via Roma 1', city: 'Milano', zip: '20100', name: 'Mario Rossi' },
      note: 'Leave with the neighbour, Giulia Bianchi',
    }
    h.state.pages = [page([order({ ...pii, lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'SKU-1', quantity: 1, title: 'Engraved for Mario Rossi' } as never] } })])]
    h.state.products = [{ sku: 'SKU-1', deletedAt: null }]
    const report = await shopifyShadowReport('acct-1', { now: NOW, sleep: noSleep })
    const text = JSON.stringify(report)
    for (const value of ['mario', 'Mario', 'Rossi', 'example.com', '3471234567', 'Via Roma', 'Milano', '20100', 'Giulia', '#1001', 'Engraved']) {
      expect(text, value).not.toContain(value)
    }
    expect(report.orders.total).toBe(1)
  })
})

// ── E. no write path ─────────────────────────────────────────────────────────
describe('E. no write path', () => {
  it('a whole run: every channel call is a Shopify READ on the current GraphQL Admin API, for the named account', async () => {
    h.state.pages = [page([order()], 'c1'), page([order({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'NOPE', quantity: 1 }] } })])]
    h.state.products = [{ sku: 'SKU-1', deletedAt: null }]
    const report = await shopifyShadowReport('acct-1', { now: NOW, sleep: noSleep })
    expect(report.readOnly).toBe(true)
    expect(h.state.requests).toHaveLength(2)
    for (const request of h.state.requests) {
      expect(request).toMatchObject({ channel: 'SHOPIFY', kind: 'read', method: 'POST', connectionId: 'acct-1', operation: 'graphql.orders' })
      expect(request.url).toBe(`https://nexus-shadow.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`)
    }
    // The database is only READ, and only for Product SKUs.
    expect(new Set(h.state.dbCalls)).toEqual(new Set(['product.findMany']))
  })

  it('a near miss is found by the database read itself (case-insensitive), not only by the counts', async () => {
    h.state.pages = [page([order({ lineItems: { pageInfo: { hasNextPage: false }, nodes: [{ sku: 'sku-9 ', quantity: 2 }] } })])]
    h.state.products = [{ sku: 'SKU-9', deletedAt: null }]
    const report = await shopifyShadowReport('acct-1', { now: NOW, sleep: noSleep })
    expect(report.skus).toMatchObject({ matchedLines: 0, unmatchedLines: 1, nearMatchLines: 1 })
    expect(report.skus.unmatched).toEqual([{ sku: 'sku-9 ', lines: 1, units: 2, nearMatch: true }])
  })

  it('the reader refuses a change document before anything is sent', async () => {
    const { read } = await shopifyAdminReader('acct-1')
    for (const document of [
      'mutation { orderCancel(orderId: "gid://shopify/Order/1") { userErrors { message } } }',
      '  mutation X { productUpdate(product: {}) { product { id } } }',
      'query A { shop { id } } mutation B { tagsAdd(id: "x", tags: ["y"]) { node { id } } }',
      '# comment\nmutation { fulfillmentCreate(fulfillment: {}) { fulfillment { id } } }',
      'subscription { orders { id } }',
    ]) {
      await expect(read(document), document).rejects.toThrow(/only reads/)
    }
    expect(h.state.requests).toHaveLength(0)
  })

  it('the query document the report sends is a read by the gateway’s own rule', async () => {
    const { shopifyKind } = await import('../gateway/shopify.js')
    expect(shopifyKind('POST', `https://x.myshopify.com/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, JSON.stringify({ query: SHADOW_ORDERS_QUERY }))).toBe('read')
  })

  it('the service has no write call and no stock / order writer import', () => {
    const source = readFileSync(new URL('./order-shadow-report.service.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\s*\(/)
    expect(source).not.toMatch(/\$(executeRaw|executeRawUnsafe|queryRaw|queryRawUnsafe|transaction)/)
    expect(source).not.toMatch(/stock-level|order-writer|order-fulfilments|order-actions|listing-write|outbound-rows|recordInbound/)
    expect(source).not.toMatch(/shopifyAdmin\(/) // the read-only reader, never the client that can send mutations
  })
})
