import { beforeEach, describe, expect, it, vi } from 'vitest'

const row = {
  id: 'amazon-env',
  channelType: 'AMAZON',
  managedBy: 'env',
  region: 'EU',
  externalAccountId: 'SELLERONE',
  isActive: true,
  authStatus: 'connected',
}
const upsert = vi.fn(async () => ({}))
const updateMany = vi.fn(async () => ({ count: 0 }))
const findMany = vi.fn(async () => [{ externalId: 'MARKETONE', metadata: { operatorNote: 'keep' } }])
const tx = { connectionScope: { updateMany, upsert, findMany } }
vi.mock('../../../../db.js', () => ({
  default: {
    channelConnection: { findUnique: vi.fn(async () => row) },
    $transaction: vi.fn(async (fn: (tx: unknown) => unknown) => fn(tx)),
  },
}))
vi.mock('../../apps.service.js', () => ({
  getChannelApp: vi.fn(async () => ({ clientId: 'client-id', clientSecret: 'client-secret' })),
}))
const storeGrant = vi.fn(async (...args: unknown[]) => (args[4] as (tx: unknown) => Promise<void>)(tx))
const getAccessToken = vi.fn(async () => 'stored-access-token')
vi.mock('../../token.service.js', () => ({ storeGrant, getAccessToken }))
vi.mock('../../events.service.js', () => ({ recordConnectionEvent: vi.fn(async () => undefined) }))
const amazonParticipations = vi.fn(async () => [{
  marketplace: { id: 'MARKETONE', name: 'Amazon Italy', countryCode: 'IT', defaultCurrencyCode: 'EUR' },
  participation: { isParticipating: true },
}])
vi.mock('./spec.js', () => ({ amazonParticipations }))

const { importAmazonEnvironmentAuthorization } = await import('./self-authorization.js')

describe('private Amazon authorization import', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    row.managedBy = 'env'
    row.isActive = true
    vi.stubEnv('AMAZON_REFRESH_TOKEN', 'private-refresh-token')
    vi.stubEnv('AMAZON_SELLER_ID', 'SELLERONE')
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      access_token: 'verified-access-token',
      expires_in: 3600,
    })))
  })

  it('verifies first, then encrypts through the shared grant store and refreshes participation', async () => {
    const result = await importAmazonEnvironmentAuthorization({
      connectionId: row.id,
      actor: { kind: 'operator', userId: 'user-one' },
    })
    expect(result).toEqual({ connectionId: row.id, sellerId: 'SELLERONE', placement: 'adopt' })
    expect(storeGrant).toHaveBeenCalledWith(
      row.id,
      expect.objectContaining({
        accessToken: 'verified-access-token',
        refreshToken: 'private-refresh-token',
        identity: { userId: 'SELLERONE' },
        region: 'EU',
      }),
      { kind: 'operator', userId: 'user-one' },
      'adopt',
      expect.any(Function),
    )
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { connectionId_kind_externalId: { connectionId: row.id, kind: 'marketplace', externalId: 'MARKETONE' } },
    }))
    expect(updateMany).toHaveBeenCalledWith({
      where: { connectionId: row.id, kind: 'marketplace', externalId: { notIn: ['MARKETONE'] }, OR: [{ region: 'EU' }, { region: null }] },
      data: { isActive: false },
    })
  })

  it('refuses a token configured for a different seller before calling Amazon', async () => {
    vi.stubEnv('AMAZON_SELLER_ID', 'SELLERTWO')
    await expect(importAmazonEnvironmentAuthorization({
      connectionId: row.id,
      actor: { kind: 'operator' },
    })).rejects.toThrow('different seller account')
    expect(fetch).not.toHaveBeenCalled()
    expect(storeGrant).not.toHaveBeenCalled()
  })

  it('does not convert the account when Amazon rejects the authorization', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 400 }))
    await expect(importAmazonEnvironmentAuthorization({
      connectionId: row.id,
      actor: { kind: 'operator' },
    })).rejects.toThrow('Amazon rejected the private Seller Central authorization (400)')
    expect(amazonParticipations).not.toHaveBeenCalled()
    expect(storeGrant).not.toHaveBeenCalled()
  })

  it('does not convert the account when marketplace persistence fails', async () => {
    upsert.mockRejectedValueOnce(new Error('database unavailable'))
    await expect(importAmazonEnvironmentAuthorization({
      connectionId: row.id,
      actor: { kind: 'operator' },
    })).rejects.toThrow('database unavailable')
    expect(storeGrant).toHaveBeenCalled()
  })

  it('preserves operational metadata while updating participation', async () => {
    await importAmazonEnvironmentAuthorization({ connectionId: row.id, actor: { kind: 'operator' } })
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ metadata: { operatorNote: 'keep', countryCode: 'IT', currency: 'EUR' } }) }))
  })

  it('verifies an existing managed account without environment credentials or new consent', async () => {
    row.managedBy = 'oauth'
    vi.stubEnv('AMAZON_REFRESH_TOKEN', '')
    vi.stubEnv('AMAZON_SELLER_ID', '')
    const result = await importAmazonEnvironmentAuthorization({ connectionId: row.id, actor: { kind: 'operator' } })
    expect(result.placement).toBe('verified')
    expect(getAccessToken).toHaveBeenCalledWith(row.id, { forceRefresh: true })
    expect(fetch).not.toHaveBeenCalled()
    expect(storeGrant).not.toHaveBeenCalled()
  })

  it('refuses a region change before touching authorization', async () => {
    await expect(importAmazonEnvironmentAuthorization({ connectionId: row.id, region: 'NA', actor: { kind: 'operator' } })).rejects.toThrow('existing account region')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('does not restore a disconnected managed account from the environment', async () => {
    row.managedBy = 'oauth'
    row.isActive = false
    await expect(importAmazonEnvironmentAuthorization({ connectionId: row.id, actor: { kind: 'operator' } })).rejects.toThrow('new private authorization')
    expect(getAccessToken).not.toHaveBeenCalled()
    expect(fetch).not.toHaveBeenCalled()
  })
})
