/**
 * P1.8 — the rule that a contract check may only leave for a SANDBOX host, proven on a channel that has
 * none. Shopify's sandbox is a development store, not a different hostname, so a check written against a
 * Shopify URL must be refused here rather than sent to the live shop. The contract list is stood in so
 * the rule is exercised, not the current list of checks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({ calls: [] as string[] }))
vi.mock('./channel-contracts.js', () => ({
  CHANNEL_CONTRACTS: [{
    channel: 'SHOPIFY',
    name: 'shopify.shop',
    covers: 'shopify.shop.read',
    what: 'read',
    url: () => 'https://live-shop.myshopify.com/admin/api/2026-07/graphql.json',
    method: 'POST',
    body: () => JSON.stringify({ query: '{ shop { id } }' }),
    assert: () => null,
  }],
  REQUIRED_OPERATIONS: {},
  ACCOUNT_ENVIRONMENT: {},
  NOT_APPLICABLE_CHANNELS: [],
  OUT_OF_SCOPE_CHANNELS: [],
}))
vi.mock('../gateway/gateway.js', async (original) => ({
  ...(await original<object>()),
  gatewayCall: vi.fn(async (request: any) => {
    h.calls.push(request.url)
    return { outcome: 'sent', ok: true, status: 200, text: '{}', url: request.url, attempts: 1, verdict: null, rate: {}, json: () => ({}) }
  }),
}))

import { runChannelContracts } from './contract-run.service.js'

beforeEach(() => { h.calls = []; vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_SHOPIFY', 'shop-dev') })
afterEach(() => vi.unstubAllEnvs())

describe('P1.8 — a channel with no sandbox host', () => {
  it('is refused with a reason and NOTHING is sent to the live host', async () => {
    const summary = await runChannelContracts()
    expect(h.calls).toEqual([])
    expect(summary.status).toBe('not-configured')
    expect(summary.results[0]).toMatchObject({ channel: 'SHOPIFY', status: 'not-configured', detail: expect.stringContaining('no sandbox host') })
  })
})
