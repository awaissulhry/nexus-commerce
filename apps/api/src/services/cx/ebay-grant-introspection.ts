/** OAuth-only transport. Credential loading and account authorization stay in token.service. */
import { TOKEN_REQUEST_TIMEOUT_MS } from './token-response.js'

type InspectionFailure = 'canonical_service_required' | 'account_unavailable' | 'credential_missing' | 'credential_unavailable'
  | 'configuration' | 'transport' | 'remote_error' | 'rate_limited' | 'invalid_response'

export class EbayGrantInspectionError extends Error {
  readonly code = 'EBAY_GRANT_INSPECTION_UNAVAILABLE'
  constructor(readonly reason: InspectionFailure, readonly retryAfterMs?: number) {
    super('The current eBay refresh grant could not be verified.')
    this.name = 'EbayGrantInspectionError'
  }
}

/** RFC9110 §10.2.3: seconds or HTTP-date. Prefer the provider's Date for clock skew. */
function retryAfterMs(headers: Headers): number | undefined {
  const value = headers.get('retry-after')?.trim()
  if (!value || value.length > 128) return undefined
  const httpDate = (text: string | null) => {
    if (!text || !/^[A-Za-z]{3,9}[, ]/.test(text)) return NaN
    // HTTP's obsolete asctime form has no zone; it still denotes UTC.
    return Date.parse(/GMT$/.test(text) ? text : `${text} GMT`)
  }
  const providerTime = httpDate(headers.get('date'))
  const delay = /^\d+$/.test(value) ? Number(value) * 1000 : httpDate(value) - (Number.isFinite(providerTime) ? providerTime : Date.now())
  return Number.isSafeInteger(delay) && Number.isFinite(new Date(Date.now() + Math.max(0, delay)).getTime()) ? Math.max(0, delay) : undefined
}

/**
 * eBay documents refresh_token introspection separately from access-token validity.
 * No refresh is attempted, and neither token nor response metadata leaves this helper.
 * https://developer.ebay.com/develop/guides/sell/authorization
 */
export async function introspectEbayRefreshToken(input: {
  url: string; clientId: string; clientSecret: string; refreshToken: string
}): Promise<boolean> {
  let response: Response
  try {
    // gateway-exempt: OAuth refresh-token introspection, authenticated with the app key.
    response = await fetch(input.url, {
      method: 'POST', redirect: 'error', signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json',
        Authorization: `Basic ${Buffer.from(`${input.clientId}:${input.clientSecret}`).toString('base64')}` },
      body: new URLSearchParams({ token: input.refreshToken, token_type_hint: 'refresh_token' }).toString(),
    })
  } catch { throw new EbayGrantInspectionError('transport') }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {})
    throw new EbayGrantInspectionError(response.status === 429 ? 'rate_limited' : 'remote_error',
      response.status === 429 || response.status === 503 ? retryAfterMs(response.headers) : undefined)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new EbayGrantInspectionError('invalid_response')
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > 16_384) throw new EbayGrantInspectionError('invalid_response')
      chunks.push(value)
    }
    const value: unknown = JSON.parse(Buffer.concat(chunks, bytes).toString('utf8'))
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new EbayGrantInspectionError('invalid_response')
    const data = value as Record<string, unknown>
    if (typeof data.active !== 'boolean' || (data.client_id !== undefined && data.client_id !== input.clientId)) {
      throw new EbayGrantInspectionError('invalid_response')
    }
    return data.active
  } catch { throw new EbayGrantInspectionError('invalid_response') }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}
