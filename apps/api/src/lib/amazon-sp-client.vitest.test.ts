import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const oauthAccount = {
  id: 'amazon-oauth-1',
  channelType: 'AMAZON',
  externalAccountId: 'SELLERONE',
  region: 'EU',
  managedBy: 'oauth',
  connectionMetadata: { environment: 'production' },
  isActive: true,
  isPrimary: true,
  authStatus: 'connected',
}

const listActiveConnections = vi.fn(async () => [oauthAccount])
const workspace = vi.hoisted(() => ({ id: null as string | null }))
vi.mock('../services/connection-resolver.service.js', () => ({
  listActiveConnections,
  chooseConnection: (rows: typeof oauthAccount[]) => rows[0],
  resolveConnection: async () => oauthAccount,
}))
vi.mock('./workspace-context.js', () => ({
  workspaceContext: () => workspace.id ? { workspaceId: workspace.id } : null,
  workspaceIdForQuery: () => workspace.id ?? 'legacy',
  requireWorkspace: vi.fn(() => { if (!workspace.id) throw new Error('Select a business profile.'); return { workspaceId: workspace.id } }),
  LEGACY_WORKSPACE_ID: 'legacy',
  WorkspaceError: class extends Error { constructor(readonly code: string, message: string) { super(message) } },
}))
const getAccessToken = vi.fn(async () => 'database-access-token')
const readRefreshToken = vi.fn(async (): Promise<string | null> => 'database-refresh-token')
vi.mock('../services/cx/token.service.js', () => ({ getAccessToken, readRefreshToken }))
vi.mock('../services/cx/apps.service.js', () => ({ getChannelApp: async () => ({ clientId: 'test-client', clientSecret: 'test-secret' }) }))
vi.mock('../services/outbound-api-call-log.service.js', () => ({ instrumentSellingPartner: vi.fn() }))

const { amazonAccount, getAmazonAccessToken, getAmazonSellerId, getAmazonSpClient } = await import('./amazon-sp-client.js')

describe('Amazon seller grant resolution outside workspace mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    workspace.id = null
    oauthAccount.managedBy = 'oauth'
    vi.clearAllMocks()
    readRefreshToken.mockResolvedValue('database-refresh-token')
  })
  afterEach(() => vi.unstubAllEnvs())

  it('accepts the matching legacy seller in the existing single-profile development mode', async () => {
    oauthAccount.managedBy = 'env'
    vi.stubEnv('AMAZON_SELLER_ID', 'SELLERONE')
    expect(await amazonAccount({ accountId: oauthAccount.id })).toMatchObject({ id: oauthAccount.id })
  })

  it('still refuses legacy environment credentials in a different workspace', async () => {
    oauthAccount.managedBy = 'env'; workspace.id = 'another-workspace'
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1'); vi.stubEnv('AMAZON_SELLER_ID', 'SELLERONE')
    await expect(amazonAccount({ accountId: oauthAccount.id })).rejects.toThrow('do not belong')
  })

  it('still requires context in workspace mode and refuses a different seller in legacy mode', async () => {
    oauthAccount.managedBy = 'env'
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '1')
    await expect(amazonAccount({ accountId: oauthAccount.id })).rejects.toThrow('Select a business profile')
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0'); vi.stubEnv('AMAZON_SELLER_ID', 'OTHERSELLER')
    await expect(amazonAccount({ accountId: oauthAccount.id })).rejects.toThrow('do not belong')
  })

  it('makes an active OAuth row authoritative over the legacy environment grant', async () => {
    expect(await amazonAccount()).toMatchObject({ id: oauthAccount.id, managedBy: 'oauth' })
    expect(await getAmazonSellerId()).toBe('SELLERONE')
    expect(await getAmazonAccessToken()).toBe('database-access-token')
    expect(getAccessToken).toHaveBeenCalledWith(oauthAccount.id)
    expect(listActiveConnections).toHaveBeenCalledWith('AMAZON')
  })

  it('constructs the real SDK with credentials belonging to the verified seller', async () => {
    const client = await getAmazonSpClient(oauthAccount.id)
    expect(client.access_token).toBe('database-access-token')
    expect(readRefreshToken).toHaveBeenCalledWith(oauthAccount.id)
    expect(client._refresh_token).toBe('database-refresh-token')
    expect(client._options.auto_request_tokens).toBe(false)
  })

  it('requires the selected seller refresh grant even if an environment grant exists', async () => {
    vi.stubEnv('AMAZON_REFRESH_TOKEN', 'another-seller-grant')
    readRefreshToken.mockResolvedValue(null)
    await expect(getAmazonSpClient(oauthAccount.id)).rejects.toThrow('restore its refresh token')
  })
})
