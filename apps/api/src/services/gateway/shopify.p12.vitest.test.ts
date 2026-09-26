/**
 * P1.2 — Shopify on the gateway: the read / write / action / setup rule (REST and GraphQL), the sender's
 * account rule (account token / env credential / unknown), ledger names, the GraphQL vs REST buckets,
 * and the gateway's refusal to follow a redirect with a token header.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as Array<{ url: string; init: RequestInit }>, answers: [] as Array<() => Response> }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest, takeToken } from './rate.js'
import { bucketGroupOf } from './channels.js'
import { gatewayFetch } from './gateway.js'
import { graphqlRootField, shopifyKind, shopifyTransport } from './shopify.js'
import { __tokenAccountsTest, rememberTokenAccount } from './token-accounts.js'

const GQL = 'https://x.myshopify.com/admin/api/2026-07/graphql.json'
const gql = (query: string) => JSON.stringify({ query, variables: {} })
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

beforeEach(() => {
  __rateTest.useMemory(); __tokenAccountsTest.clear()
  h.calls = []; h.answers = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'true'); vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'live')
  vi.stubEnv('SHOPIFY_ACCESS_TOKEN', 'env-shpat')
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    h.calls.push({ url: String(url), init })
    return h.answers.shift()?.() ?? new Response(JSON.stringify({ data: {} }), { status: 200 })
  }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('read / write / action / setup', () => {
  it.each([
    ['POST', GQL, gql('query { shop { name } }'), 'read'],
    ['POST', GQL, gql('mutation M($i: ProductSetInput!) { productSet(input: $i) { product { id } } }'), 'write'],
    ['POST', GQL, gql('mutation { inventorySetQuantities(input: {}) { userErrors { message } } }'), 'write'],
    ['POST', GQL, gql('mutation { stagedUploadsCreate(input: []) { stagedTargets { url } } }'), 'read'],
    ['POST', GQL, gql('mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE) { userErrors { message } } }'), 'setup'],
    ['POST', GQL, gql('mutation { fulfillmentCreate(fulfillment: {}) { userErrors { message } } }'), 'action'],
    ['POST', GQL, gql('mutation { orderCancel(orderId: "1") { userErrors { message } } }'), 'action'],
    ['GET', 'https://x.myshopify.com/admin/api/2024-01/products/1.json', null, 'read'],
    ['PUT', 'https://x.myshopify.com/admin/api/2024-01/variants/1.json', '{}', 'write'],
    ['POST', 'https://x.myshopify.com/admin/api/2024-01/inventory_levels/set.json', '{}', 'write'],
    ['POST', 'https://x.myshopify.com/admin/api/2024-01/orders/1/refunds.json', '{}', 'action'],
    ['POST', 'https://x.myshopify.com/admin/api/2024-01/webhooks.json', '{}', 'setup'],
  ])('%s %s → %s', (method, url, body, kind) => {
    expect(shopifyKind(method, url, body)).toBe(kind)
  })
  it('the root field of a named mutation with variables; comments do not confuse it', () => {
    expect(graphqlRootField('# nexus\nmutation Save($a: [String!]) {\n  alias: productUpdate(input: $a) { id }\n}')).toEqual({ mutation: true, field: 'productUpdate' })
  })
})

/**
 * Review of PR #54 — the classifier read the document as text: it cut from `#` to the end of the line even
 * inside a string, looked only at the FIRST definition and the FIRST root field. So a mutation hidden behind
 * a fragment, a leading query, a `#` in a string or a harmless first field was sent as a `read`, past the
 * publish mode. It now parses the document (graphql-js) and judges every operation and every root field.
 */
const BYPASS = 'fragment F on Mutation { productDelete(input:{id:"x#"}){deletedProductId} } mutation { ...F }'
describe('the classifier parses the document — no mutation passes as a read', () => {
  it.each([
    ['the review document: a fragment on Mutation, `#` inside a string', BYPASS, 'write', 'productDelete'],
    ['a query first, then a mutation', 'query A { shop { id } } mutation B { productDelete(input: {id: "x"}) { deletedProductId } }', 'write', 'productDelete'],
    ['`#` inside a string of the query, then a mutation', 'query A { orders(first: 1, query: "tag:a#b") { nodes { id } } } mutation B { productDelete(input: {id: "x"}) { deletedProductId } }', 'write', 'productDelete'],
    ['a comment line before the mutation', '# mutation-free, honest\nquery A { shop { id } }\n# and yet\nmutation B { productSet(input: {}) { product { id } } }', 'write', 'productSet'],
    ['an alias named like a read mutation', 'mutation { stagedUploadsCreate: productDelete(input: {id: "x"}) { deletedProductId } }', 'write', 'productDelete'],
    ['a read mutation first, a listing write second', 'mutation { stagedUploadsCreate(input: []) { stagedTargets { url } } productDelete(input: {id: "x"}) { deletedProductId } }', 'write', 'stagedUploadsCreate'],
    ['a setup mutation first, a listing write second', 'mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE) { userErrors { message } } productSet(input: {}) { product { id } } }', 'write', 'webhookSubscriptionCreate'],
    ['a setup mutation first, an order action second', 'mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE) { userErrors { message } } orderCancel(orderId: "1") { userErrors { message } } }', 'action', 'webhookSubscriptionCreate'],
    ['a query that spreads a fragment on Mutation', 'fragment F on Mutation { productDelete(input: {id: "x"}) { deletedProductId } } query { ...F }', 'write', 'productDelete'],
    ['an inline fragment at the root', 'mutation { ... on Mutation { productDelete(input: {id: "x"}) { deletedProductId } } }', 'write', 'productDelete'],
    ['a subscription', 'subscription { productsUpdated { id } }', 'write', 'productsUpdated'],
    ['a document that does not parse (fail closed)', 'mutation { productDelete(input: {id: "x"}) { deletedProductId }', 'write', null],
  ])('%s → %s', (_name, query, kind, field) => {
    expect(shopifyKind('POST', GQL, gql(query))).toBe(kind)
    expect(graphqlRootField(query)).toEqual({ mutation: true, field })
  })
  it.each([
    ['the word mutation inside a string', 'query Q { orders(first: 1, query: "tag:mutation") { nodes { id } } }', 'orders'],
    ['a `#` inside a string', 'query Q { orders(first: 1, query: "name:#1001") { nodes { id } } }', 'orders'],
    ['a fragment on the query root', 'fragment S on QueryRoot { shop { id } } query { ...S }', 'shop'],
    ['an aliased query field', 'query { store: shop { name } }', 'shop'],
  ])('a real query stays a read: %s', (_name, query, field) => {
    expect(shopifyKind('POST', GQL, gql(query))).toBe('read')
    expect(graphqlRootField(query)).toEqual({ mutation: false, field })
  })
  it('the review document through the gateway while publishing is gated: refused, nothing sent', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', '')
    rememberTokenAccount('shpat-A', 'shop-A')
    const refusal = await refusalOf(shopifyTransport(null)(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'shpat-A' }, body: gql(BYPASS) }))
    expect(refusal).toMatchObject({ code: 'PUBLISH_GATED' })
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger.at(-1)).toMatchObject({ operation: 'graphql.productDelete', outcome: 'gated' })
  })
})

describe('shopifyTransport — whose call it is', () => {
  it('an account token → that account; the ledger names the GraphQL field', async () => {
    rememberTokenAccount('shpat-A', 'shop-A')
    await shopifyTransport(null)(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'shpat-A' }, body: gql('query { shop { name } }') })
    expect(gatewayLedger.at(-1)).toMatchObject({ connectionId: 'shop-A', operation: 'graphql.shop', outcome: 'sent' })
    expect(h.calls[0].init.headers).toMatchObject({ 'X-Shopify-Access-Token': 'shpat-A' })
  })
  it('exactly the env credential → an app-level call (the legacy env paths)', async () => {
    await shopifyTransport(null)('https://x.myshopify.com/admin/api/2024-01/products/1.json', { headers: { 'X-Shopify-Access-Token': 'env-shpat' } })
    expect(gatewayLedger.at(-1)).toMatchObject({ connectionId: null, outcome: 'sent' })
  })
  it('any other token → refused, nothing sent', async () => {
    expect(await refusalOf(shopifyTransport(null)(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'stolen' }, body: gql('query { shop { name } }') }))).toMatchObject({ code: 'ACCOUNT_REQUIRED' })
    expect(h.calls).toHaveLength(0)
  })
  it('a listing write while Shopify is gated → refused; a webhook subscription → sent', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', '')
    rememberTokenAccount('shpat-A', 'shop-A')
    const send = shopifyTransport(null)
    expect(await refusalOf(send(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'shpat-A' }, body: gql('mutation { productSet(input: {}) { product { id } } }') }))).toMatchObject({ code: 'PUBLISH_GATED' })
    await send(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'shpat-A' }, body: gql('mutation { webhookSubscriptionCreate(topic: ORDERS_CREATE) { userErrors { message } } }') })
    expect(h.calls).toHaveLength(1)
  })
})

describe('buckets and redirects', () => {
  it('GraphQL and REST have their own buckets; GraphQL allows more at once', async () => {
    expect(bucketGroupOf('SHOPIFY', 'POST', GQL)).toBe('graphql')
    expect(bucketGroupOf('SHOPIFY', 'GET', 'https://x.myshopify.com/admin/api/2024-01/products.json')).toBe('rest')
    const burst = async (key: string) => { let n = 0; while ((await takeToken('SHOPIFY', key, 0)).ok) n++; return n }
    expect(await burst('SHOPIFY:shop-A:graphql')).toBe(50)
    expect(await burst('SHOPIFY:shop-A:rest')).toBe(40)
  })
  it('a channel call never follows a redirect (a token header would travel to another host)', async () => {
    rememberTokenAccount('shpat-A', 'shop-A')
    await shopifyTransport(null)(GQL, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'shpat-A' }, body: gql('query { shop { name } }') })
    expect(h.calls[0].init.redirect).toBe('error')
  })
  it('the gateway itself: a redirect is an error, not a silent hop (real fetch against a local server)', async () => {
    vi.unstubAllGlobals()
    const { createServer } = await import('node:http')
    const seen: string[] = []
    const server = createServer((req, res) => {
      seen.push(`${req.url} ${req.headers['x-shopify-access-token'] ?? ''}`)
      if (req.url === '/start') { res.writeHead(302, { location: '/elsewhere' }); res.end(); return }
      res.writeHead(200); res.end('{}')
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as { port: number }).port
    try {
      await expect(gatewayFetch({ channel: 'SHOPIFY', operation: 't', kind: 'read', connectionId: null, appLevel: true, url: `http://127.0.0.1:${port}/start`, method: 'GET', auth: { token: 'shpat-secret' }, maxTransientRetries: 0 }))
        .rejects.toMatchObject({ name: 'GatewayNoAnswer' })
      expect(seen).toEqual(['/start shpat-secret'])
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
