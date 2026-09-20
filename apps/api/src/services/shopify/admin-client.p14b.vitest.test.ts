/**
 * P1.4b — the admin client applies the listing publish mode to listing writes only. An order action
 * (refund, cancel, fulfilment) has its own switch at its caller (P0.1), the same rule the gateway
 * applies; reads are never gated. The account, token and transport are stood in; `sent` records every
 * operation that left.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ sent: [] as string[] }))
vi.mock('../connection-resolver.service.js', () => ({ resolveConnection: vi.fn(async () => ({ id: 'shop-B', channelType: 'SHOPIFY', region: 'x.myshopify.com' })) }))
vi.mock('../cx/token.service.js', () => ({ getAccessToken: vi.fn(async () => 'token-B'), assertWritable: vi.fn(async () => undefined) }))
vi.mock('../gateway/shopify.js', async (original) => ({
  ...(await original<object>()),
  shopifyTransport: () => async (_url: string, init: RequestInit) => {
    h.sent.push(String(JSON.parse(String(init.body)).query))
    return new Response(JSON.stringify({ data: { ok: true } }), { status: 200 })
  },
}))

import { shopifyAdmin } from './admin-client.js'

beforeEach(() => { h.sent = []; vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', ''); vi.stubEnv('SHOPIFY_PUBLISH_MODE', '') })
afterEach(() => vi.unstubAllEnvs())

describe('P1.4b — the listing publish mode governs listing writes, not order actions', () => {
  it('publish mode gated: an order action goes out', async () => {
    const { graphql } = await shopifyAdmin('shop-B')
    for (const op of ['refundCreate(input: $input)', 'orderCancel(orderId: $orderId)', 'fulfillmentCreate(fulfillment: $f)']) {
      await graphql(`mutation X($input: RefundInput, $orderId: ID, $f: FulfillmentInput) { ${op} { __typename } }`)
    }
    expect(h.sent).toHaveLength(3)
  })
  it('publish mode gated: a listing write is refused, nothing sent', async () => {
    const { graphql } = await shopifyAdmin('shop-B')
    await expect(graphql('mutation X($p: ProductUpdateInput!) { productUpdate(product: $p) { __typename } }')).rejects.toThrow(/Shopify writes are disabled/)
    await expect(graphql('mutation X($i: InventorySetQuantitiesInput!) { inventorySetQuantities(input: $i) { __typename } }')).rejects.toThrow(/Shopify writes are disabled/)
    expect(h.sent).toHaveLength(0)
  })
  it('a read is never gated', async () => {
    const { graphql } = await shopifyAdmin('shop-B')
    await graphql('query X { shop { id } }')
    expect(h.sent).toHaveLength(1)
  })
  it('publish mode live: a listing write goes out', async () => {
    vi.stubEnv('NEXUS_ENABLE_SHOPIFY_PUBLISH', 'true'); vi.stubEnv('SHOPIFY_PUBLISH_MODE', 'live')
    const { graphql } = await shopifyAdmin('shop-B')
    await graphql('mutation X($p: ProductUpdateInput!) { productUpdate(product: $p) { __typename } }')
    expect(h.sent).toHaveLength(1)
  })
})
