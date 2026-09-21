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
import { getChannelApp, storeSigningKey, recordSigningKeyExpiry } from '../../apps.service.js'
import { recordConnectionEvent } from '../../events.service.js'
import { getAccessToken } from '../../token.service.js'
import { createEbaySigningKey, getEbaySigningKey } from './key-management.js'
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
  /** Stable name for the call ledger; default: method + path without ids. */
  operation?: string
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

/**
 * P6.2 — how long before expiry a signing key is replaced.
 *
 * A key replaced the moment it expires is a key that has already failed at least one
 * call: eBay rejects with 215xxx, which is not retryable into a success. The buffer is
 * generous because creating a key is additive at eBay (the old one keeps working until
 * its own expiry), so replacing early costs nothing and replacing late costs a refund.
 */
const SIGNING_KEY_RENEW_BEFORE_MS = 7 * 24 * 60 * 60 * 1000

/** A stored key we should stop using: dated, and that date is near or past. */
function signingKeyIsDue(expiresAt: Date | null | undefined, now = Date.now()): boolean {
  if (!expiresAt) return false // no date is not evidence of expiry — P6.2 records why
  return expiresAt.getTime() - now <= SIGNING_KEY_RENEW_BEFORE_MS
}

/**
 * Obtain the app's eBay signing key, creating one when there is none **or when the one
 * we hold is at the end of its life**.
 *
 * 🔴 Before P6.2 this returned the stored key forever. eBay returns an
 * `expirationTime` on create; it went into a log line and was dropped, so nothing knew
 * when the key died — and when it did, every signed eBay call (refunds, finances)
 * would start failing with 215xxx. A key with no recorded date is still used, because
 * "we never asked" is not "it expired"; `recoverEbaySigningKeyExpiry` is what fills it.
 */
async function signingKeyFor(environment: 'production' | 'sandbox', appToken: () => Promise<string>) {
  const app = await getChannelApp('EBAY', environment)
  const due = signingKeyIsDue(app.signingKeyExpiresAt)
  if (app.signingKey?.privateKey && app.signingKey.jwe && !due) return app.signingKey
  if (due) {
    logger.warn('[cx-ebay] signing key is at the end of its life — creating a replacement', {
      signingKeyId: app.signingKeyId, expiresAt: app.signingKeyExpiresAt?.toISOString() ?? null,
    })
  }
  const created = await createEbaySigningKey({ appAccessToken: await appToken(), apiBase: EBAY_HOSTS[environment].apiz, cipher: 'ED25519' })
  await storeSigningKey('EBAY', environment, {
    signingKeyId: created.signingKeyId,
    jwe: created.jwe,
    privateKey: created.privateKey,
    cipher: created.signingKeyCipher,
  }, created.expirationTime ? new Date(created.expirationTime) : null)
  await recordConnectionEvent({ channelKey: 'EBAY', type: 'signing_key_created', detail: { signingKeyId: created.signingKeyId, cipher: created.signingKeyCipher, expirationTime: created.expirationTime ?? null } })
  logger.info('[cx-ebay] signing key created', { signingKeyId: created.signingKeyId })
  return { signingKeyId: created.signingKeyId, jwe: created.jwe, privateKey: created.privateKey, cipher: created.signingKeyCipher }
}

/**
 * P6.2 — ask eBay when the key we already hold expires, and record the answer.
 *
 * The production signing key was created before the expiry was stored, so its date is
 * recoverable only by asking. `getEbaySigningKey` is a **read**, has existed with a
 * passing test and **zero callers** since it was written, and this is what finally
 * calls it.
 *
 * Returns what it learned rather than throwing: a key-metadata read failing is not a
 * reason to take eBay signing down, and the caller reports it.
 */
export async function recoverEbaySigningKeyExpiry(
  environment: 'production' | 'sandbox' = 'production',
): Promise<{ checked: boolean; signingKeyId: string | null; expiresAt: string | null; error?: string }> {
  const app = await getChannelApp('EBAY', environment)
  const signingKeyId = app.signingKeyId ?? app.signingKey?.signingKeyId ?? null
  if (!signingKeyId) return { checked: false, signingKeyId: null, expiresAt: null, error: 'no signing key stored' }
  try {
    const meta = await getEbaySigningKey(signingKeyId, {
      appAccessToken: await ebayAppToken(environment),
      apiBase: EBAY_HOSTS[environment].apiz,
    })
    const expiresAt = meta.expirationTime ? new Date(meta.expirationTime) : null
    await recordSigningKeyExpiry('EBAY', environment, expiresAt)
    logger.info('[cx-ebay] recorded the signing key expiry', { signingKeyId, expiresAt: expiresAt?.toISOString() ?? null })
    return { checked: true, signingKeyId, expiresAt: expiresAt?.toISOString() ?? null }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err)
    logger.warn('[cx-ebay] could not read the signing key expiry', { signingKeyId, error })
    return { checked: false, signingKeyId, expiresAt: null, error }
  }
}

/**
 * P1.1 — the RFC 9421 signature headers for one eBay request, made with the app's Key Management key
 * (created on first use). The gateway calls this for every path on eBay's must-sign list.
 */
export async function ebaySigningHeaders(input: { environment: 'production' | 'sandbox'; method: string; url: string; body: string | null }): Promise<Record<string, string>> {
  const key = await signingKeyFor(input.environment, () => ebayAppToken(input.environment))
  return signEbayRequest({ method: input.method, url: input.url, body: input.body, jwe: key.jwe, privateKeyPem: key.privateKey })
}

/** Application (client-credentials) token — used only for Key Management and Notification public keys. */
export async function ebayAppToken(environment: 'production' | 'sandbox' = 'production', scope = 'https://api.ebay.com/oauth/api_scope'): Promise<string> {
  const app = await getChannelApp('EBAY', environment)
  // gateway-exempt: OAuth token exchange (client_credentials) — the gateway's own app-token source
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
  const body = opts.body === undefined ? undefined : typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)
  const headers: Record<string, string> = {
    Accept: 'application/json',
    ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    ...(opts.marketplaceId ? { 'X-EBAY-C-MARKETPLACE-ID': opts.marketplaceId } : {}),
    ...(opts.headers ?? {}),
  }
  // P1.2 — through the channel gateway: the account's token and state, the publish mode for writes, the
  // eBay signature on its must-sign paths (or when `sign` asks), the rate bucket and the call ledger.
  const { ebayGatewayFetch } = await import('../../../gateway/ebay.js')
  const res = await ebayGatewayFetch({ connectionId, url: absolute, method, headers, body: body ?? null, sign: opts.sign, operation: opts.operation })
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
