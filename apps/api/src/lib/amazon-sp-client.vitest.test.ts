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
// P1.2 — SDK calls go through the channel gateway: its account check reads the row, its ledger writes one.
const ledger = vi.hoisted(() => [] as Array<Record<string, unknown>>)
vi.mock('../services/outbound-api-call-log.service.js', () => ({ recordGatewayCall: vi.fn(async (row: Record<string, unknown>) => { ledger.push(row) }) }))
vi.mock('../db.js', () => ({ default: { channelConnection: { findUnique: vi.fn(async () => ({ authStatus: 'connected', isActive: true, displayName: 'Amazon' })) } } }))

const { amazonAccount, getAmazonAccessToken, getAmazonSellerId, getAmazonSpClient } = await import('./amazon-sp-client.js')

describe('Amazon seller grant resolution outside workspace mode', () => {
  beforeEach(() => {
    vi.stubEnv('NEXUS_WORKSPACES_ENABLED', '0')
    workspace.id = null
    oauthAccount.managedBy = 'oauth'
    vi.clearAllMocks()
    getAccessToken.mockResolvedValue('database-access-token')
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

  it('loads product type definitions through the real SDK — sent by the gateway with the refreshed token', async () => {
    const client = await getAmazonSpClient(oauthAccount.id)
    const definition = { schema: { link: { resource: 'https://schema.test/outerwear' } } }
    const execute = vi.spyOn(client._request, 'execute')
    const sent: Array<{ url: string; headers: Record<string, string> }> = []
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      sent.push({ url: String(url), headers: init.headers as Record<string, string> })
      return new Response(JSON.stringify(definition), { status: 200 })
    }))
    getAccessToken.mockResolvedValue('refreshed-access-token')
    ledger.length = 0

    await expect(client.callAPI({
      operation: 'getDefinitionsProductType', endpoint: 'productTypeDefinitions',
      path: { productType: 'OUTERWEAR' }, query: { marketplaceIds: ['APJ6JRA9NG5V4'] },
    })).resolves.toEqual(definition)

    expect(execute).not.toHaveBeenCalled()
    expect(sent).toEqual([{ url: 'https://sellingpartnerapi-eu.amazon.com/definitions/2020-09-01/productTypes/OUTERWEAR?marketplaceIds=APJ6JRA9NG5V4', headers: expect.objectContaining({ 'x-amz-access-token': 'refreshed-access-token' }) }])
    expect(ledger).toEqual([expect.objectContaining({ channel: 'AMAZON', connectionId: oauthAccount.id, operation: 'getDefinitionsProductType', marketplace: 'APJ6JRA9NG5V4', outcome: 'sent', success: true })])
    expect(client.access_token).toBe('refreshed-access-token')
    expect(client._options.auto_request_tokens).toBe(false)
    vi.unstubAllGlobals()
  })

  it('requires the selected seller refresh grant even if an environment grant exists', async () => {
    vi.stubEnv('AMAZON_REFRESH_TOKEN', 'another-seller-grant')
    readRefreshToken.mockResolvedValue(null)
    await expect(getAmazonSpClient(oauthAccount.id)).rejects.toThrow('restore its refresh token')
  })
})
