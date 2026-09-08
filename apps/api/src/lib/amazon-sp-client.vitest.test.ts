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
const resolveConnection = vi.fn(async (_scope: unknown) => oauthAccount)
vi.mock('../services/connection-resolver.service.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/connection-resolver.service.js')>(),
  listActiveConnections,
  resolveConnection,
}))
vi.mock('../db.js', () => ({ default: {} }))
vi.mock('../services/cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'app', clientSecret: 'secret' }) }))
const requests = vi.fn(async (_config: unknown, _args: unknown[]) => ({ ok: true }))
const downloads = vi.fn(async () => 'document')
vi.mock('amazon-sp-api', () => ({ SellingPartner: class {
  constructor(readonly config: unknown) {}
  callAPI(...args: unknown[]) { return requests(this.config, args) }
  download() { return downloads() }
  upload() { return downloads() }
} }))
const getAccessToken = vi.fn(async () => 'database-access-token')
vi.mock('../services/cx/token.service.js', () => ({ getAccessToken }))

const { amazonAccount, getAmazonAccessToken, getAmazonSellerId, getAmazonSpClient, amazonCredsConfigured } = await import('./amazon-sp-client.js')

describe('Amazon seller grant resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listActiveConnections.mockResolvedValue([oauthAccount])
    resolveConnection.mockResolvedValue(oauthAccount)
    getAccessToken.mockResolvedValue('database-access-token')
  })

  it('does not restore environment authorization when the last account is disconnected', async () => {
    vi.stubEnv('AMAZON_REFRESH_TOKEN', 'still-present')
    listActiveConnections.mockResolvedValue([])
    expect(await amazonCredsConfigured()).toBe(false)
    await expect(getAmazonAccessToken()).rejects.toThrow('Connect an Amazon seller')
    expect(getAccessToken).not.toHaveBeenCalled()
  })

  it('refuses implicit account selection even when one of two accounts is primary', async () => {
    listActiveConnections.mockResolvedValue([oauthAccount, { ...oauthAccount, id: 'second', isPrimary: false }])
    await expect(amazonAccount()).rejects.toThrow('Ambiguous AMAZON')
  })

  it('rejects environment credentials for a different seller', async () => {
    vi.stubEnv('AMAZON_SELLER_ID', 'OTHERSELLER')
    resolveConnection.mockResolvedValue({ ...oauthAccount, managedBy: 'env' })
    await expect(getAmazonAccessToken(oauthAccount.id)).rejects.toThrow('different seller')
  })

  it('pins a cached SDK to its account and reads fresh tokens for each request', async () => {
    const client = await getAmazonSpClient(oauthAccount.id)
    getAccessToken.mockResolvedValue('refreshed-access-token')
    listActiveConnections.mockResolvedValue([{ ...oauthAccount, id: 'different-primary' }])
    await client.callAPI({ operation: 'getOrders' })
    expect(requests).toHaveBeenCalledWith(expect.objectContaining({ access_token: 'refreshed-access-token', region: 'eu' }), [{ operation: 'getOrders' }])
    expect(resolveConnection).toHaveBeenLastCalledWith({ accountId: oauthAccount.id })
  })

  it('blocks API and document operations on an SDK retained after disconnect', async () => {
    const client = await getAmazonSpClient(oauthAccount.id)
    resolveConnection.mockResolvedValue({ ...oauthAccount, isActive: false, authStatus: 'disconnected' })
    await expect(client.callAPI({ operation: 'createFeed' })).rejects.toThrow('Reconnect')
    await expect(client.download({ url: 'https://document.test' })).rejects.toThrow('Reconnect')
    await expect(client.upload({ url: 'https://document.test' })).rejects.toThrow('Reconnect')
    expect(requests).not.toHaveBeenCalled()
    expect(downloads).not.toHaveBeenCalled()
  })

  it('makes an active OAuth row authoritative over the legacy environment grant', async () => {
    expect(await amazonAccount()).toMatchObject({ id: oauthAccount.id, managedBy: 'oauth' })
    expect(await getAmazonSellerId()).toBe('SELLERONE')
    expect(await getAmazonAccessToken()).toBe('database-access-token')
    expect(getAccessToken).toHaveBeenCalledWith(oauthAccount.id)
    expect(listActiveConnections).toHaveBeenCalledWith('AMAZON')
  })
})
