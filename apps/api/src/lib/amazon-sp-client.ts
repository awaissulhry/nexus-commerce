/**
 * Shared Amazon SP-API client factory.
 *
 * Seller grants belong to ChannelConnection rows. The legacy environment
 * refresh token remains a narrow migration fallback until an account completes
 * Seller Central authorization.
 */

import type { ConnectionRow } from '../services/connection-resolver.service.js'

type AmazonAccount = Pick<ConnectionRow, 'id' | 'channelType' | 'externalAccountId' | 'region' | 'managedBy' | 'isActive' | 'authStatus' | 'isPrimary'>

export async function amazonAccount(accountId?: string): Promise<AmazonAccount | null> {
  const { chooseConnection, listActiveConnections, resolveConnection } = await import('../services/connection-resolver.service.js')
  let account: ConnectionRow
  if (accountId) {
    account = await resolveConnection({ accountId })
  } else {
    const candidates = await listActiveConnections('AMAZON')
    if (candidates.length === 0) return null
    const selected = chooseConnection(candidates, { channel: 'AMAZON', wantPrimary: true })
    account = candidates.find((candidate) => candidate.id === selected.id)!
  }
  if (account.channelType !== 'AMAZON' || !account.isActive || !account.externalAccountId || ['disconnected', 'revoked', 'needs_reauth'].includes(account.authStatus)) {
    throw new Error('Reconnect the selected Amazon seller account.')
  }
  return account
}

export async function getAmazonSellerId(accountId?: string): Promise<string> {
  const account = await amazonAccount(accountId)
  return account?.externalAccountId ?? process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
}

export async function amazonCredsConfigured(): Promise<boolean> {
  try {
    const account = await amazonAccount()
    if (account?.managedBy === 'oauth') return true
    return Boolean(process.env.AMAZON_LWA_CLIENT_ID && process.env.AMAZON_LWA_CLIENT_SECRET && process.env.AMAZON_REFRESH_TOKEN)
  } catch {
    return false
  }
}

const legacyTokens = new Map<string, { token: string; expiresAt: number }>()

export async function getAmazonAccessToken(accountId?: string): Promise<string> {
  const account = await amazonAccount(accountId)
  if (account?.managedBy === 'oauth') {
    return (await import('../services/cx/token.service.js')).getAccessToken(account.id)
  }

  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  if (!refreshToken) throw new Error('Reconnect the Amazon account to configure its credentials.')
  const cacheKey = account?.id ?? 'legacy'
  const cached = legacyTokens.get(cacheKey)
  if (cached && cached.expiresAt > Date.now() + 300_000) return cached.token

  const app = await (await import('../services/cx/apps.service.js')).getChannelApp('AMAZON_SP')
  const response = await fetch('https://api.amazon.com/auth/o2/token', {
    method: 'POST',
    signal: AbortSignal.timeout(25_000),
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: app.clientId,
      client_secret: app.clientSecret,
    }),
  })
  if (!response.ok) throw new Error(`Amazon token exchange failed (${response.status}).`)
  const result = await response.json() as { access_token?: string; expires_in?: number }
  if (!result.access_token || !Number.isFinite(result.expires_in) || result.expires_in! <= 0) {
    throw new Error('Amazon returned an invalid access token.')
  }
  legacyTokens.set(cacheKey, { token: result.access_token, expiresAt: Date.now() + result.expires_in! * 1000 })
  return result.access_token
}

export async function getAmazonRegion(accountId?: string): Promise<'eu' | 'na' | 'fe'> {
  const account = await amazonAccount(accountId)
  const region = (account?.region ?? process.env.AMAZON_REGION ?? 'eu').toLowerCase()
  if (region === 'eu' || region.startsWith('eu-')) return 'eu'
  if (region === 'na' || /^(us|ca)-/.test(region)) return 'na'
  if (region === 'fe' || region.startsWith('ap-')) return 'fe'
  throw new Error('Choose a supported Amazon region.')
}

export async function getAmazonSpClient(accountId?: string): Promise<any> {
  const account = await amazonAccount(accountId)
  const token = await getAmazonAccessToken(account?.id)
  const app = await (await import('../services/cx/apps.service.js')).getChannelApp('AMAZON_SP')
  const { SellingPartner } = await import('amazon-sp-api')
  return new (SellingPartner as any)({
    region: await getAmazonRegion(account?.id),
    access_token: token,
    credentials: {
      SELLING_PARTNER_APP_CLIENT_ID: app.clientId,
      SELLING_PARTNER_APP_CLIENT_SECRET: app.clientSecret,
    },
    options: { auto_request_tokens: false, auto_request_throttled: true },
  })
}
