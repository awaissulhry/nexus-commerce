/**
 * P1.4 — DONE-WHEN "0 REST 2024-01 writes", enforced where every Shopify call passes: the gateway lets
 * a Shopify change (write, order action, setup) out only on the current GraphQL Admin API with a named
 * account. REST, an older version and the env credential are refused with nothing sent and one ledger
 * row; reads are not changes and still go out. Publish mode is `live`, so only this rule can refuse.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('./account.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.accountModule))
vi.mock('./ledger.js', () => import('../../test-support/gateway-stubs.js').then((m) => m.ledgerModule))

import { gatewayLedger } from '../../test-support/gateway-stubs.js'
import { __rateTest } from './rate.js'
import { shopifyTransport } from './shopify.js'
import { SHOPIFY_API_VERSION } from '../shopify/api-version.js'

const SHOP = 'https://x.myshopify.com/admin/api'
const gql = (query: string) => JSON.stringify({ query, variables: {} })
const STOCK = gql('mutation S($i: InventorySetQuantitiesInput!, $k: String!) { inventorySetQuantities(input: $i) @idempotent(key: $k) { userErrors { message } } }')
const refusalOf = (p: Promise<unknown>) => p.then(() => null, (e) => e)

beforeEach(() => {
  __rateTest.useMemory()
  h.calls = []; gatewayLedger.length = 0
  vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'true'); vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'live')
  vi.stubEnv('SHOPIFY_ACCESS_TOKEN', 'env-shpat')
  vi.stubGlobal('fetch', vi.fn(async (url: string) => { h.calls.push(String(url)); return new Response(JSON.stringify({ data: {} }), { status: 200 }) }))
})
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); __rateTest.reset() })

describe('P1.4 — a Shopify change leaves only on the current GraphQL API with a named account', () => {
  it('the version is the one the admin client speaks', () => {
    expect(SHOPIFY_API_VERSION).toBe('2026-07')
  })
  it('positive control: a 2026-07 GraphQL write with an account goes out', async () => {
    await shopifyTransport('shop-B')(`${SHOP}/2026-07/graphql.json`, { method: 'POST', headers: { 'X-Shopify-Access-Token': 'tok' }, body: STOCK })
    expect(h.calls).toEqual([`${SHOP}/2026-07/graphql.json`])
  })
  it.each([
    ['a REST 2024-01 write with an account', 'shop-B', 'PUT', `${SHOP}/2024-01/variants/1.json`, JSON.stringify({ variant: { price: '1.00' } })],
    ['a REST 2024-01 inventory set with the env credential', null, 'POST', `${SHOP}/2024-01/inventory_levels/set.json`, JSON.stringify({ available: 1 })],
    ['a REST 2026-07 write (REST at the current version)', 'shop-B', 'POST', `${SHOP}/2026-07/products.json`, JSON.stringify({ product: {} })],
    ['a GraphQL 2024-01 mutation with an account', 'shop-B', 'POST', `${SHOP}/2024-01/graphql.json`, STOCK],
    ['a GraphQL 2026-07 mutation with the env credential', null, 'POST', `${SHOP}/2026-07/graphql.json`, STOCK],
    ['a REST 2024-01 webhook registration (setup)', null, 'POST', `${SHOP}/2024-01/webhooks.json`, JSON.stringify({ webhook: {} })],
    ['a GraphQL 2024-01 order action (refund)', 'shop-B', 'POST', `${SHOP}/2024-01/graphql.json`, gql('mutation R($i: RefundInput!) { refundCreate(input: $i) { userErrors { message } } }')],
  ])('%s: refused, nothing sent, one ledger row', async (_name, account, method, url, body) => {
    const token = account ? 'tok' : 'env-shpat'
    const err = await refusalOf(shopifyTransport(account)(url, { method, headers: { 'X-Shopify-Access-Token': token }, body }))
    expect(err).toMatchObject({ code: 'SHOPIFY_LEGACY_WRITE' })
    expect(String((err as Error).message)).toMatch(/only on the 2026-07 GraphQL Admin API with a connected account/)
    expect(h.calls).toHaveLength(0)
    expect(gatewayLedger).toHaveLength(1)
    expect(gatewayLedger[0]).toMatchObject({ outcome: 'refused', errorCode: 'SHOPIFY_LEGACY_WRITE' })
  })
  it('reads are not changes: a REST 2024-01 GET with the env credential still goes out (its version moves in P5.3)', async () => {
    await shopifyTransport(null)(`${SHOP}/2024-01/locations.json`, { headers: { 'X-Shopify-Access-Token': 'env-shpat' } })
    expect(h.calls).toHaveLength(1)
  })
})
