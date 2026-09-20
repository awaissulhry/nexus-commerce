/**
 * P1.8 — the nightly contract run. What matters is what it CANNOT do: it never writes, it never leaves a
 * sandbox host, and it never reports green when nothing could run. The gateway is stood in and records
 * every call it was asked to make.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const h = vi.hoisted(() => ({
  calls: [] as Array<{ channel: string; kind: string; url: string; method: string; connectionId: string | null; operation: string }>,
  answer: (_url: string) => ({ status: 200, text: '', body: null as unknown }),
  throwFor: null as string | null,
}))
vi.mock('../gateway/gateway.js', async (original) => ({
  ...(await original<object>()),
  gatewayCall: vi.fn(async (request: any) => {
    h.calls.push({ channel: request.channel, kind: request.kind, url: request.url, method: request.method, connectionId: request.connectionId, operation: request.operation })
    if (h.throwFor && request.operation.includes(h.throwFor)) throw new Error('the account needs to be reconnected')
    const answer = h.answer(request.url)
    return { outcome: 'sent', ok: true, status: answer.status, text: answer.text, url: request.url, attempts: 1, verdict: null, rate: { remaining: null, limit: null }, json: () => answer.body }
  }),
}))

import { runChannelContracts, contractAccountOf, isContractRunEnabled } from './contract-run.service.js'

/** What each channel answers when its contract still holds. */
const healthy = (url: string) => url.includes('api.dll')
  ? { status: 200, text: '<Ack>Success</Ack><Fees/>', body: null as unknown }
  : url.includes('/v2/profiles') ? { status: 200, text: '[]', body: [] as unknown }
  : url.includes('marketplaceParticipations') ? { status: 200, text: '{}', body: { payload: [] } as unknown }
  : { status: 200, text: '{}', body: { inventoryItems: [] } as unknown }

const configureEveryChannel = () => {
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'amazon-sandbox')
  vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'ads-test')
}

beforeEach(() => {
  h.calls = []; h.throwFor = null
  h.answer = healthy
  for (const key of ['NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'NEXUS_CONTRACT_ACCOUNT_EBAY', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_SP', 'NEXUS_CONTRACT_ACCOUNT_AMAZON_ADS', 'NEXUS_CONTRACT_ACCOUNT_SHOPIFY', 'NEXUS_CONTRACT_ACCOUNT_ETSY']) vi.stubEnv(key, '')
})
afterEach(() => vi.unstubAllEnvs())

describe('P1.8 — what the contract run cannot do', () => {
  it('DONE-WHEN: every call is a read, on a sandbox host, as the named sandbox account', async () => {
    configureEveryChannel()
    const summary = await runChannelContracts()
    expect(h.calls.length).toBeGreaterThan(0)
    for (const call of h.calls) {
      expect(call.kind).toBe('read')
      expect(new URL(call.url).hostname).toMatch(/sandbox|-test\./)
      expect(call.operation.startsWith('contract.')).toBe(true)
    }
    expect(h.calls.map((c) => c.connectionId)).toEqual(h.calls.map((c) => (c.channel === 'EBAY' ? 'ebay-sandbox' : c.channel === 'AMAZON_SP' ? 'amazon-sandbox' : 'ads-test')))
    expect(summary.results.filter((r) => r.status === 'failed').map((r) => `${r.name}: ${r.detail}`)).toEqual([])
    expect(summary.status).toBe('green')
    expect(summary.failed).toBe(0)
  })
  it('no account named for a channel: that channel is NOT CONFIGURED and nothing is sent for it', async () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', 'ebay-sandbox')
    const summary = await runChannelContracts()
    expect(h.calls.every((call) => call.channel === 'EBAY')).toBe(true)
    expect(summary.results.filter((r) => r.channel === 'AMAZON_SP').every((r) => r.status === 'not-configured')).toBe(true)
    expect(summary.results.find((r) => r.channel === 'AMAZON_SP')?.detail).toMatch(/NEXUS_CONTRACT_ACCOUNT_AMAZON_SP/)
  })
  it('nothing configured at all: not-configured, never green, and no call', async () => {
    const summary = await runChannelContracts()
    expect(h.calls).toHaveLength(0)
    expect(summary.status).toBe('not-configured')
    expect(summary.passed).toBe(0)
    expect(summary.sentence).toMatch(/No channel contract check could run/)
  })
  it('Shopify and Etsy are reported with their reason, not silently missing', async () => {
    const summary = await runChannelContracts()
    const shopify = summary.results.find((r) => r.channel === 'SHOPIFY')
    const etsy = summary.results.find((r) => r.channel === 'ETSY')
    expect(shopify).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('development-store') })
    expect(etsy).toMatchObject({ status: 'not-configured', detail: expect.stringContaining('no sandbox') })
  })
})

describe('P1.8 — a channel change turns it red', () => {
  it('a renamed field in the answer fails the check and the whole run', async () => {
    configureEveryChannel()
    h.answer = (url) => url.includes('inventory_item')
      ? { status: 200, text: '{}', body: { items: [] } }  // eBay renamed inventoryItems → items
      : healthy(url)
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.find((r) => r.name === 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('inventoryItems') })
    expect(summary.sentence).toMatch(/ebay.getInventoryItems/)
  })
  it('an HTTP error fails the check with the status', async () => {
    configureEveryChannel()
    h.answer = () => ({ status: 503, text: '', body: null })
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.filter((r) => r.status === 'failed').length).toBeGreaterThan(2)
    expect(summary.results.find((r) => r.status === 'failed')?.detail).toMatch(/503/)
  })
  it('the gateway itself refuses (account needs sign-in): a failed check, never a quiet pass', async () => {
    configureEveryChannel()
    h.throwFor = 'ebay.getInventoryItems'
    const summary = await runChannelContracts()
    expect(summary.status).toBe('red')
    expect(summary.results.find((r) => r.name === 'ebay.getInventoryItems')).toMatchObject({ status: 'failed', detail: expect.stringContaining('reconnected') })
  })
  it('an eBay dry-run answer with no Ack is a contract change', async () => {
    configureEveryChannel()
    h.answer = (url) => url.includes('api.dll')
      ? { status: 200, text: '<VerifyAddFixedPriceItemResponse/>', body: null }
      : healthy(url)
    const summary = await runChannelContracts()
    expect(summary.results.find((r) => r.name === 'ebay.verifyAddFixedPriceItem')).toMatchObject({ status: 'failed', detail: expect.stringContaining('<Ack>') })
  })
})

describe('P1.8 — the switch', () => {
  it('is off unless the Owner turns it on', () => {
    expect(isContractRunEnabled()).toBe(false)
    vi.stubEnv('NEXUS_ENABLE_CHANNEL_CONTRACT_RUN', 'true')
    expect(isContractRunEnabled()).toBe(true)
  })
  it('reads one account per channel', () => {
    vi.stubEnv('NEXUS_CONTRACT_ACCOUNT_EBAY', ' ebay-sandbox ')
    expect(contractAccountOf('EBAY')).toBe('ebay-sandbox')
    expect(contractAccountOf('SHOPIFY')).toBeNull()
  })
})
