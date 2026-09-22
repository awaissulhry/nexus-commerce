import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('../outbound-api-call-log.service.js', () => ({ instrumentSellingPartner: vi.fn() }))

// 🔴 2026-09-22 (PLAN amendment A-8). This arm was written when `isConfigured()` read the three LWA
// variables straight out of the environment. P6.1 moved the app credentials into the `ChannelApp`
// TABLE, so the check is now database-backed: `amazonCredsConfigured()` → `amazonAccount()` →
// `getChannelApp('AMAZON_SP')` (amazon-sp-client.ts:29-37). Stubbing env alone stopped deciding
// anything, and `amazonAccount()` throws outright when the local `ChannelConnection` row carries
// `authStatus: 'disconnected'` — the state of this repo's dev database — so the function returned
// false and the arm failed on a machine, not on a defect.
//
// 🔴 The two DATA-ACCESS collaborators are pinned, and `amazonCredsConfigured` itself is NOT.
// Re-deriving an "equivalent" rule inside the test would mean asserting the test's own copy of the
// logic, which diverges the moment the real one changes. The real function runs here.
const db = vi.hoisted(() => ({
  connections: vi.fn(),
  app: vi.fn(),
}))
vi.mock('../connection-resolver.service.js', async importOriginal => ({
  ...(await importOriginal<typeof import('../connection-resolver.service.js')>()),
  listActiveConnections: db.connections,
  resolveConnection: async () => (await db.connections())[0],
}))
vi.mock('../cx/apps.service.js', () => ({ getChannelApp: db.app }))

const connection = (over: Record<string, unknown> = {}) => ({
  id: 'acct', channelType: 'AMAZON', isActive: true, authStatus: 'connected',
  externalAccountId: 'seller', region: 'eu', managedBy: 'env', connectionMetadata: null, ...over,
})

import { AmazonService, extractClassifications } from './amazon.service.js'

const market = 'APJ6JRA9NG5V4'
const jacket = { classificationId: '2420941031', displayName: 'Giacche', parent: { classificationId: '100', displayName: 'Abbigliamento', parent: { classificationId: '1', displayName: 'Auto e Moto' } } }
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('accepts the LWA credentials actually used by SP-API without unrelated AWS signing keys', async () => {
  db.connections.mockResolvedValue([connection()])
  db.app.mockResolvedValue({ clientId: 'lwa-client', clientSecret: 'lwa-secret' })
  vi.stubEnv('AMAZON_SELLER_ID', 'seller')
  vi.stubEnv('AMAZON_REFRESH_TOKEN', 'test-value')
  // The two AWS signing keys stay empty throughout. That is what the name claims, so it is asserted
  // by never setting them, not by a comment.
  for (const key of ['AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_ROLE_ARN']) vi.stubEnv(key, '')
  const service = new AmazonService()
  expect(await service.isConfigured()).toBe(true)
  // Negative control: the refresh token is what decides, so removing it must flip the answer.
  vi.stubEnv('AMAZON_REFRESH_TOKEN', '')
  expect(await service.isConfigured()).toBe(false)
})

it('the app credentials come from ChannelApp, not from the environment', async () => {
  db.connections.mockResolvedValue([connection()])
  vi.stubEnv('AMAZON_SELLER_ID', 'seller')
  vi.stubEnv('AMAZON_REFRESH_TOKEN', 'test-value')
  // P6.1 — no ChannelApp row means not configured, however complete the environment looks.
  for (const key of ['AMAZON_LWA_CLIENT_ID', 'AMAZON_LWA_CLIENT_SECRET']) vi.stubEnv(key, 'test-value')
  db.app.mockRejectedValue(new Error('no ChannelApp row'))
  expect(await new AmazonService().isConfigured()).toBe(false)
  db.app.mockResolvedValue({ clientId: 'lwa-client', clientSecret: 'lwa-secret' })
  expect(await new AmazonService().isConfigured()).toBe(true)
})

it('an oauth-managed account needs no environment refresh token at all', async () => {
  vi.stubEnv('AMAZON_REFRESH_TOKEN', '')
  db.app.mockRejectedValue(new Error('no ChannelApp row'))
  db.connections.mockResolvedValue([connection({ managedBy: 'oauth' })])
  expect(await new AmazonService().isConfigured()).toBe(true)
  // Negative control: a disconnected account is refused whatever its credentials say.
  db.connections.mockResolvedValue([connection({ managedBy: 'oauth', authStatus: 'disconnected' })])
  expect(await new AmazonService().isConfigured()).toBe(false)
})

describe('Amazon catalog classifications', () => {
  it('reads the market wrapper and returns assigned nodes with an ordered breadcrumb', () => {
    expect(extractClassifications([
      { marketplaceId: 'OTHER', classifications: [{ classificationId: '99', displayName: 'Foreign category' }] },
      { marketplaceId: market, classifications: [jacket] },
    ], market)).toEqual({ browseNodes: [2420941031], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
  })
  it('does not concatenate separate branches or return ancestor IDs as selected categories', () => {
    expect(extractClassifications([{ marketplaceId: market, classifications: [jacket, jacket, { classificationId: '200', displayName: 'Sport', parent: { classificationId: '2', displayName: 'Outdoors' } }] }], market))
      .toEqual({ browseNodes: [2420941031, 200], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
  })
  it('refuses unscoped, foreign, malformed and unsafe numeric IDs', () => {
    for (const value of [null, [jacket], [{ marketplaceId: 'OTHER', classifications: [jacket] }], [{ marketplaceId: market, classifications: [null, { classificationId: '12x' }, { classificationId: '9007199254740993' }] }]]) {
      expect(extractClassifications(value, market)).toEqual({ browseNodes: null, categoryPath: null })
    }
  })
  it('does not hang or invent a full breadcrumb when the parent chain cycles', () => {
    const cyclic: any = { classificationId: '10', displayName: 'Cycle' }; cyclic.parent = cyclic
    expect(extractClassifications([{ marketplaceId: market, classifications: [cyclic] }], market)).toEqual({ browseNodes: [10], categoryPath: null })
  })
  it('requests product types and reads only the requested ASIN and market', async () => {
    const service = new AmazonService()
    const callAPI = vi.fn().mockResolvedValue({ items: [
      { asin: 'WRONG', summaries: [{ marketplaceId: market, itemName: 'Wrong product' }] },
      { asin: 'B012345678', productTypes: [{ marketplaceId: 'OTHER', productType: 'SHOES' }, { marketplaceId: market, productType: 'COAT' }], summaries: [{ marketplaceId: 'OTHER', itemName: 'Wrong title' }, { marketplaceId: market, itemName: 'Jacket' }], classifications: [{ marketplaceId: market, classifications: [jacket] }] },
    ] })
    vi.spyOn(service as any, 'getClient').mockResolvedValue({ callAPI })
    expect(await service.detectProductTypeFromAsin('B012345678', market)).toMatchObject({ productType: 'COAT', title: 'Jacket', browseNodes: [2420941031], categoryPath: 'Auto e Moto › Abbigliamento › Giacche' })
    expect(callAPI).toHaveBeenCalledWith(expect.objectContaining({ query: expect.objectContaining({ marketplaceIds: [market], identifiers: ['B012345678'], includedData: ['summaries', 'classifications', 'productTypes'] }) }))
    expect(await service.detectProductTypeFromAsin('MISSING', market)).toMatchObject({ productType: null, title: null, browseNodes: null, categoryPath: null })
  })
})
