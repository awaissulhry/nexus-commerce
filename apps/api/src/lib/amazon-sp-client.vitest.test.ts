import { beforeEach, describe, expect, it, vi } from 'vitest'

const oauthAccount = {
  id: 'amazon-oauth-1',
  channelType: 'AMAZON',
  externalAccountId: 'SELLERONE',
  region: 'EU',
  managedBy: 'oauth',
  isActive: true,
  isPrimary: true,
  authStatus: 'connected',
}

const listActiveConnections = vi.fn(async () => [oauthAccount])
vi.mock('../services/connection-resolver.service.js', () => ({
  listActiveConnections,
  chooseConnection: (rows: typeof oauthAccount[]) => rows[0],
  resolveConnection: async () => oauthAccount,
}))
const getAccessToken = vi.fn(async () => 'database-access-token')
vi.mock('../services/cx/token.service.js', () => ({ getAccessToken }))

const { amazonAccount, getAmazonAccessToken, getAmazonSellerId } = await import('./amazon-sp-client.js')

describe('Amazon seller grant resolution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('makes an active OAuth row authoritative over the legacy environment grant', async () => {
    expect(await amazonAccount()).toMatchObject({ id: oauthAccount.id, managedBy: 'oauth' })
    expect(await getAmazonSellerId()).toBe('SELLERONE')
    expect(await getAmazonAccessToken()).toBe('database-access-token')
    expect(getAccessToken).toHaveBeenCalledWith(oauthAccount.id)
    expect(listActiveConnections).toHaveBeenCalledWith('AMAZON')
  })
})
