import { workspaceContext, workspaceIdForQuery, requireWorkspace, LEGACY_WORKSPACE_ID, WorkspaceError } from './workspace-context.js'
import type { ConnectionRow } from '../services/connection-resolver.service.js'
import { logger } from '../utils/logger.js'

type Account = Pick<ConnectionRow, 'id' | 'externalAccountId' | 'region' | 'managedBy' | 'connectionMetadata'>
export async function amazonAccount(input: { accountId?: string; sellerId?: string } | string = {}): Promise<Account> {
  if (typeof input === 'string') input = { accountId: input }
  const workspaceMode = process.env.NEXUS_WORKSPACES_ENABLED === '1'
  if (workspaceMode) requireWorkspace()
  const { listActiveConnections, chooseConnection, resolveConnection } = await import('../services/connection-resolver.service.js')
  let account: ConnectionRow
  if (input.accountId) account = await resolveConnection({ accountId: input.accountId })
  else {
    const candidates = (await listActiveConnections('AMAZON')).filter(row => !input.sellerId || row.externalAccountId === input.sellerId)
    if (candidates.length === 0) throw new WorkspaceError('amazon_account_unavailable', 'Connect an Amazon seller account in Channels before using Amazon.', 409)
    const chosen = chooseConnection(candidates, { channel: 'AMAZON' })
    account = candidates.find(row => row.id === chosen.id)!
  }
  if (account.channelType !== 'AMAZON' || !account.isActive || !account.externalAccountId || ['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) throw new WorkspaceError('amazon_account_unavailable', 'Reconnect the selected Amazon seller account.', 409)
  if (input.sellerId && input.sellerId !== account.externalAccountId) throw new WorkspaceError('amazon_seller_mismatch', 'The Amazon seller does not match the selected account.', 409)
  if (account.managedBy === 'env' && (workspaceIdForQuery() !== LEGACY_WORKSPACE_ID || account.externalAccountId !== (process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID))) throw new WorkspaceError('amazon_credentials_mismatch', 'These Amazon credentials do not belong to this business profile.', 409)
  return account
}

export async function getAmazonSellerId(accountId?: string): Promise<string> {
  const account = await amazonAccount({ accountId })
  return account.externalAccountId!
}
export async function amazonCredsConfigured(): Promise<boolean> {
  try {
    const account = await amazonAccount()
    if (account.managedBy === 'oauth') return true
    if (account.managedBy !== 'env') return false
    // P6.1 — the app credentials live in ChannelApp (they rotate); only the legacy refresh token is env.
    const app = await (await import('../services/cx/apps.service.js')).getChannelApp('AMAZON_SP').catch(() => null)
    return Boolean(app?.clientId && app?.clientSecret && process.env.AMAZON_REFRESH_TOKEN)
  } catch { return false }
}
const legacyTokens = new Map<string, { token: string; expiresAt: number }>()
export async function getAmazonAccessToken(accountId?: string): Promise<string> {
  const account = await amazonAccount({ accountId })
  if (account.managedBy === 'oauth') return (await import('../services/cx/token.service.js')).getAccessToken(account.id)
  if (account.managedBy !== 'env') throw new WorkspaceError('amazon_account_unavailable', 'Reconnect the selected Amazon seller account.', 409)
  const key = account?.id ?? 'legacy'
  const hit = legacyTokens.get(key)
  if (hit && hit.expiresAt > Date.now() + 300_000) return hit.token
  // P6.6 — the token-minting path. Same announcement and same retirement switch as
  // the client below; this is the one that actually exchanges it at LWA.
  const refreshToken = useAmazonEnvToken('getAmazonAccessToken')
  if (!refreshToken) throw new Error('Reconnect the Amazon account to configure its credentials.')
  const { getChannelApp } = await import('../services/cx/apps.service.js')
  const app = await getChannelApp('AMAZON_SP')
  // gateway-exempt: OAuth token exchange (LWA refresh) — the gateway's own token source
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
/**
 * P6.6 — the environment refresh token, on its way out.
 *
 * D1 = A (private app, self-authorized in Amazon's Solution Provider Portal) is
 * confirmed by R-2: Amazon's own limits page gives a private application **10
 * self-authorizations** and no OAuth flow, and the 2026 "Simplified Authorization"
 * change is for **SPN-listed** service providers approving other people's sellers —
 * which Nexus is not. So the destination is a stored, revocable grant, and
 * `importAmazonEnvironmentAuthorization` already moves the env token into one.
 *
 * ## Where it actually stands (measured 2026-09-21)
 *
 * - **Production is already off it.** `seedEnvManagedConnections: persisted Amazon
 *   authorization exists — skipping env synthesis {"existingId":"cmothu9bo…"}` in the
 *   production deploy log at 08:35 UTC — an `oauth`-managed Amazon row exists there.
 * - **Development is not.** Its one Amazon row is `managedBy: 'env'`, and (a second
 *   oddity) `isActive: true` with `authStatus: 'disconnected'` at the same time.
 *
 * ## Why this logs instead of deleting
 *
 * Deleting the fallback is a one-line change with the largest blast radius available:
 * if the stored grant is ever unusable, every Amazon SP-API call stops. The production
 * database cannot be read from this session, so "the stored grant works" is an
 * inference from the app functioning, not a measurement.
 *
 * So: the env token announces itself **once per process**, which makes *"is anything
 * still on the env path?"* answerable from production logs — the question that has to
 * be settled before the fallback goes. `NEXUS_AMAZON_ENV_TOKEN=off` is the retirement,
 * one variable, once the logs are quiet.
 */
let envTokenAnnounced = false
export function useAmazonEnvToken(caller: string): string | undefined {
  const token = process.env.AMAZON_REFRESH_TOKEN
  if (!token) return undefined
  if (process.env.NEXUS_AMAZON_ENV_TOKEN === 'off') {
    throw new WorkspaceError(
      'amazon_env_token_retired',
      'This Amazon account still uses the environment refresh token, which is retired. ' +
        'Import it as a revocable grant (Channels \u2192 Amazon \u2192 connect) before using it.',
      409,
    )
  }
  if (!envTokenAnnounced) {
    envTokenAnnounced = true
    // Once per process, not per call: this fires on the money path and a per-call line
    // would bury itself. The point is a yes/no answer in the logs, not a count.
    logger.warn('[amazon-sp] STILL USING the environment refresh token (P6.6 retires this)', {
      caller,
      retireWith: 'NEXUS_AMAZON_ENV_TOKEN=off',
    })
  }
  return token
}

/** Narrow seam for amazon-env-token.p66.vitest.test.ts. Never used by callers. */
export const __amazonEnvTokenTest = { reset: () => { envTokenAnnounced = false } }

/** A fresh instance is bound to one verified account; token refresh stays in CX. */
export async function getAmazonSpClient(accountId?: string, options: { auto_request_throttled?: boolean } = {}): Promise<any> {
  const account = await amazonAccount({ accountId })
  const scope = workspaceContext()
  const id = account?.id
  const environment = (account?.connectionMetadata as { environment?: string } | null)?.environment === 'sandbox' ? 'sandbox' : 'production'
  const token = await getAmazonAccessToken(id)
  // The SDK validates refresh_token even when access_token is supplied and automatic
  // renewal is disabled. Keep that token bound to the same verified seller as CX.
  const refreshToken = account && account.managedBy !== 'env'
    ? await (await import('../services/cx/token.service.js')).readRefreshToken(account.id)
    : useAmazonEnvToken('getAmazonSpClient')
  if (!refreshToken) throw new WorkspaceError('amazon_refresh_token_missing', 'Reconnect the Amazon seller account to restore its refresh token.', 409)
  const { getChannelApp } = await import('../services/cx/apps.service.js')
  const app = await getChannelApp('AMAZON_SP', environment)
  const { SellingPartner } = await import('amazon-sp-api')
  // gateway-exempt: routed: this SDK instance's sender is replaced by the gateway (services/gateway/amazon-sdk.ts), checked by its test
  const client: any = new SellingPartner({ region: await getAmazonRegion(id), access_token: token, refresh_token: refreshToken, credentials: { SELLING_PARTNER_APP_CLIENT_ID: app.clientId, SELLING_PARTNER_APP_CLIENT_SECRET: app.clientSecret }, options: { auto_request_tokens: false, auto_request_throttled: true, ...options, use_sandbox: environment === 'sandbox' } } as any)
  // Retained SDK instances remain bound to their business and seller. Recheck
  // authorization and refresh the access token before every API/document call.
  for (const method of ['callAPI', 'download', 'upload'] as const) {
    const original = client[method].bind(client)
    client[method] = async (...args: any[]) => {
      if (workspaceContext()?.workspaceId !== scope?.workspaceId) throw new WorkspaceError('amazon_context_changed', 'An Amazon operation cannot change business profile.')
      // amazon-sp-api exposes access_token as a getter only. Its requests read
      // _access_token; update that backing field while CX owns token refresh.
      client._access_token = await getAmazonAccessToken(id)
      return original(...args)
    }
  }
  // P1.2 — every API call of this instance goes through the channel gateway (status, publish mode,
  // rate bucket, error class, one ledger row). This replaces the old per-call ledger wrapper.
  const { routeSdkThroughGateway } = await import('../services/gateway/amazon-sdk.js')
  routeSdkThroughGateway(client, { connectionId: id ?? null })
  return client
}
/** Used by synchronous SDK factories; no process-wide seller or token state.
 *  An explicit account pins the client from its first call (CX A0): a caller that stamps
 *  or locks by an account must read through that same account, not the resolver's default. */
export function amazonSpClient(accountId?: string): any {
  const scope = workspaceContext()
  let pinnedAccountId: string | undefined = accountId
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
