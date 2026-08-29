/**
 * CX.1 — the eBay HTTP client every eBay call should go through.
 *
 * Injects the bearer from the token service (never a row's column), adds the
 * marketplace header when asked, signs the calls eBay requires EU/UK sellers to
 * sign (RFC 9421 via the app's Key Management signing key — created on first use
 * and stored encrypted on the ChannelApp row), parses rate-limit signals and
 * classifies errors so the token service can react to a revoked grant.
 */

import { logger } from '../../../../utils/logger.js'
import { getChannelApp, storeSigningKey } from '../../apps.service.js'
import { recordConnectionEvent } from '../../events.service.js'
import { getAccessToken } from '../../token.service.js'
import { createEbaySigningKey } from './key-management.js'
import { ebaySignatureAppliesTo, signEbayRequest } from './signing.js'
import { EBAY_HOSTS } from './spec.js'

export interface EbayRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  body?: unknown
  marketplaceId?: string
  headers?: Record<string, string>
  environment?: 'production' | 'sandbox'
  /** Force signing even when the path is not in the catalogue's list. */
  sign?: boolean
}

export class EbayApiError extends Error {
  constructor(readonly status: number, readonly body: string, readonly url: string) {
    super(`eBay ${status} on ${url}: ${body.slice(0, 300)}`)
    this.name = 'EbayApiError'
  }
  get errorIds(): number[] {
    try {
      const j = JSON.parse(this.body) as { errors?: { errorId?: number }[] }
      return (j.errors ?? []).map((e) => Number(e.errorId)).filter(Number.isFinite)
    } catch {
      return []
    }
  }
  /** 215000–215122 = digital-signature family (research R2 §H). */
  get isSignatureError(): boolean {
    return this.errorIds.some((id) => id >= 215000 && id <= 215122)
  }
}

/** Obtain (creating once) the app's eBay signing key. */
async function signingKeyFor(environment: 'production' | 'sandbox', appToken: () => Promise<string>) {
  const app = await getChannelApp('EBAY', environment)
  if (app.signingKey?.privateKey && app.signingKey.jwe) return app.signingKey
  const created = await createEbaySigningKey({ appAccessToken: await appToken(), apiBase: EBAY_HOSTS[environment].apiz, cipher: 'ED25519' })
  await storeSigningKey('EBAY', environment, {
    signingKeyId: created.signingKeyId,
    jwe: created.jwe,
    privateKey: created.privateKey,
    cipher: created.signingKeyCipher,
  })
  await recordConnectionEvent({ channelKey: 'EBAY', type: 'signing_key_created', detail: { signingKeyId: created.signingKeyId, cipher: created.signingKeyCipher, expirationTime: created.expirationTime ?? null } })
  logger.info('[cx-ebay] signing key created', { signingKeyId: created.signingKeyId })
  return { signingKeyId: created.signingKeyId, jwe: created.jwe, privateKey: created.privateKey, cipher: created.signingKeyCipher }
}

/** Application (client-credentials) token — used only for Key Management and Notification public keys. */
export async function ebayAppToken(environment: 'production' | 'sandbox' = 'production', scope = 'https://api.ebay.com/oauth/api_scope'): Promise<string> {
  const app = await getChannelApp('EBAY', environment)
  const res = await fetch(`${EBAY_HOSTS[environment].api}/identity/v1/oauth2/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: `Basic ${Buffer.from(`${app.clientId}:${app.clientSecret}`).toString('base64')}`,
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope }).toString(),
  })
  const text = await res.text()
  if (!res.ok) throw new EbayApiError(res.status, text, 'identity/v1/oauth2/token (client_credentials)')
  return String((JSON.parse(text) as { access_token: string }).access_token)
}

/**
 * Perform an eBay REST call for a connection. `url` may be absolute or a path on
 * the api host (`/sell/finances/v1/transaction`).
 */
export async function ebayFetch(connectionId: string, url: string, opts: EbayRequestOptions = {}): Promise<Response> {
  const environment = opts.environment ?? 'production'
  const method = opts.method ?? 'GET'
  const absolute = url.startsWith('http') ? url : `${EBAY_HOSTS[environment].api}${url}`
  const token = await getAccessToken(connectionId)
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.marketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': opts.marketplaceId } : {}),
    ...(opts.headers ?? {}),
  }
  if (opts.sign ?? ebaySignatureAppliesTo(absolute, method)) {
    const key = await signingKeyFor(environment, () => ebayAppToken(environment))
    Object.assign(headers, signEbayRequest({ method, url: absolute, body: body ?? null, jwe: key.jwe, privateKeyPem: key.privateKey }))
  }
  const res = await fetch(absolute, { method, headers, body })
  if (!res.ok) {
    const text = await res.clone().text().catch(() => '')
    const err = new EbayApiError(res.status, text, absolute)
    if (err.isSignatureError) {
      logger.error('[cx-ebay] eBay rejected the request signature', { url: absolute, errorIds: err.errorIds })
    }
  }
  return res
}

export async function ebayJson<T>(connectionId: string, url: string, opts: EbayRequestOptions = {}): Promise<T> {
  const res = await ebayFetch(connectionId, url, opts)
  const text = await res.text()
  if (!res.ok) throw new EbayApiError(res.status, text, url)
  return (text ? JSON.parse(text) : {}) as T
}
