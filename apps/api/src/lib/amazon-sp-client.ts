import { workspaceContext, workspaceIdForQuery, requireWorkspace, LEGACY_WORKSPACE_ID, WorkspaceError } from './workspace-context.js'
import type { ConnectionRow } from '../services/connection-resolver.service.js'

type Account = Pick<ConnectionRow, 'id' | 'externalAccountId' | 'region' | 'managedBy' | 'connectionMetadata'>
export async function amazonAccount(input: { accountId?: string; sellerId?: string } = {}): Promise<Account | null> {
  const workspaceMode = process.env.NEXUS_WORKSPACES_ENABLED === '1'
  if (workspaceMode) requireWorkspace()
  const { listActiveConnections, chooseConnection, resolveConnection } = await import('../services/connection-resolver.service.js')
  let account: ConnectionRow
  if (input.accountId) account = await resolveConnection({ accountId: input.accountId })
  else {
    const candidates = (await listActiveConnections('AMAZON')).filter(row => !input.sellerId || row.externalAccountId === input.sellerId)
    // Before the connection core existed, a single-profile deployment could
    // legitimately have only env credentials and no row. Preserve that narrow
    // fallback; as soon as an active connection exists, it is authoritative.
    if (candidates.length === 0 && !workspaceMode && !workspaceContext()) return null
    const chosen = chooseConnection(candidates, { channel: 'AMAZON', wantPrimary: !input.sellerId })
    account = candidates.find(row => row.id === chosen.id)!
  }
  if (account.channelType !== 'AMAZON' || !account.isActive || !account.externalAccountId || ['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) throw new WorkspaceError('amazon_account_unavailable', 'Reconnect the selected Amazon seller account.', 409)
  if (input.sellerId && input.sellerId !== account.externalAccountId) throw new WorkspaceError('amazon_seller_mismatch', 'The Amazon seller does not match the selected account.', 409)
  if (account.managedBy === 'env' && (workspaceIdForQuery() !== LEGACY_WORKSPACE_ID || account.externalAccountId !== (process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID))) throw new WorkspaceError('amazon_credentials_mismatch', 'These Amazon credentials do not belong to this business profile.', 409)
  return account
}

export async function getAmazonSellerId(accountId?: string): Promise<string> {
  const account = await amazonAccount({ accountId })
  return account?.externalAccountId ?? process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
}
export async function amazonCredsConfigured(): Promise<boolean> {
  try {
    const account = await amazonAccount()
    if (account && account.managedBy !== 'env') return true
    return Boolean(process.env.AMAZON_LWA_CLIENT_ID && process.env.AMAZON_LWA_CLIENT_SECRET && process.env.AMAZON_REFRESH_TOKEN)
  } catch { return false }
}
const legacyTokens = new Map<string, { token: string; expiresAt: number }>()
export async function getAmazonAccessToken(accountId?: string): Promise<string> {
  const account = await amazonAccount({ accountId })
  if (account && account.managedBy !== 'env') return (await import('../services/cx/token.service.js')).getAccessToken(account.id)
  const key = account?.id ?? 'legacy'
  const hit = legacyTokens.get(key)
  if (hit && hit.expiresAt > Date.now() + 300_000) return hit.token
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!refreshToken) throw new Error('Reconnect the Amazon account to configure its credentials.')
  const { getChannelApp } = await import('../services/cx/apps.service.js')
  const app = await getChannelApp('AMAZON_SP')
  const response = await fetch('https://api.amazon.com/auth/o2/token', { method: 'POST', signal: AbortSignal.timeout(25_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: app.clientId, client_secret: app.clientSecret }) })
  if (!response.ok) throw new Error(`Amazon token exchange failed (${response.status}).`)
  const result = await response.json() as { access_token?: string; expires_in?: number }
  if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) throw new Error('Amazon returned an invalid access token.')
  if (legacyTokens.size >= 32) legacyTokens.delete(legacyTokens.keys().next().value!)
  legacyTokens.set(key, { token: result.access_token, expiresAt: Date.now() + result.expires_in! * 1000 })
  return result.access_token
}
export async function getAmazonRegion(accountId?: string): Promise<'eu' | 'na' | 'fe'> {
  const account = await amazonAccount({ accountId })
  const value = (account?.region ?? process.env.AMAZON_REGION ?? 'eu').toLowerCase()
  if (value === 'eu' || value.startsWith('eu-')) return 'eu'
  if (value === 'na' || /^(us|ca)-/.test(value)) return 'na'
  if (value === 'fe' || value.startsWith('ap-')) return 'fe'
  throw new WorkspaceError('amazon_region_invalid', 'Choose a supported Amazon region.', 409)
}
/** A fresh instance is bound to one verified account; token refresh stays in CX. */
export async function getAmazonSpClient(accountId?: string): Promise<any> {
  const account = await amazonAccount({ accountId })
  const id = account?.id
  const environment = (account?.connectionMetadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production'
  const token = await getAmazonAccessToken(id)
  // The SDK validates refresh_token even when access_token is supplied and automatic
  // renewal is disabled. Keep that token bound to the same verified seller as CX.
  const refreshToken = account && account.managedBy !== 'env'
    ? await (await import('../services/cx/token.service.js')).readRefreshToken(account.id)
    : process.env.AMAZON_REFRESH_TOKEN
  if (!refreshToken) throw new WorkspaceError('amazon_refresh_token_missing', 'Reconnect the Amazon seller account to restore its refresh token.', 409)
  const { getChannelApp } = await import('../services/cx/apps.service.js')
  const app = await getChannelApp('AMAZON_SP', environment)
  const { SellingPartner } = await import('amazon-sp-api')
  const client = new SellingPartner({ region: await getAmazonRegion(id), access_token: token, refresh_token: refreshToken, credentials: { SELLING_PARTNER_APP_CLIENT_ID: app.clientId, SELLING_PARTNER_APP_CLIENT_SECRET: app.clientSecret }, options: { auto_request_tokens: false, auto_request_throttled: true, use_sandbox: environment === 'sandbox' } } as any)
  const { instrumentSellingPartner } = await import('../services/outbound-api-call-log.service.js')
  instrumentSellingPartner(client as never, { channel: 'AMAZON' })
  return client
}
/** Used by synchronous SDK factories; no process-wide seller or token state. */
export function amazonSpClient(): any {
  const scope = workspaceContext()
  let pinnedAccountId: string | undefined
  return new Proxy({}, { get(_target, method) {
    if (method === 'then') return undefined
    return async (...args: any[]) => {
      if (workspaceContext()?.workspaceId !== scope?.workspaceId) throw new WorkspaceError('amazon_context_changed', 'An Amazon operation cannot change business profile.')
      const sellerId = args[0]?.path?.sellerId ?? args[0]?.query?.sellerId
      const account = await amazonAccount({ accountId: pinnedAccountId, sellerId: typeof sellerId === 'string' ? sellerId : undefined })
      pinnedAccountId = account?.id
      const client = await getAmazonSpClient(pinnedAccountId)
      const operation = Reflect.get(client, method)
      if (typeof operation !== 'function') throw new Error(`Unsupported Amazon client operation: ${String(method)}`)
      return operation.apply(client, args)
    }
  } })
}
