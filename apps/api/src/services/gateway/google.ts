/**
 * Google on the gateway (2026-10-13, Google Ads step 1): the ONE way Nexus calls Google Ads, Merchant
 * Center, Analytics and the sign-in's userinfo. A `fetch`-shaped answer (`Response`), like `gatewayFetch`.
 *
 * - Reads, and two kinds of change: `googleKind` says read for a GET or a POST to `…:search` / `…:searchStream`,
 *   and for a Google Ads `…:mutate` that only asks Google to check it (`validateOnly: true`); write for a real
 *   Google Ads mutate (2026-10-15: every one a change a person approved in Nexus) and for an apply or a dismiss of
 *   Google's recommendations (`…/recommendations:apply|:dismiss`, G5: Google cannot check those). The gateway refuses every other
 *   Google call (`GOOGLE_READ_ONLY`), with its ledger row, and holds real writes to the publish mode
 *   (`NEXUS_GOOGLE_ADS_WRITES=off` refuses them). A write is never retried by the gateway: it could apply twice.
 * - The account's own token as `Authorization: Bearer` (the gateway refreshes it under the lease).
 * - `login-customer-id` only when the caller names a manager account (digits only).
 * - `developer-token` only when env `GOOGLE_ADS_DEVELOPER_TOKEN` is set, and only to the Google Ads host:
 *   Google made the token optional (and ignored) in 2026-09 and will reject it in a later version.
 * - A body is sent as JSON.
 */
import { gatewayFetch } from './gateway.js'
import { googleAdsRecommendationCall, googleCallKind, isGoogleAdsMutate, isGoogleValidateOnly } from './channels.js'

export interface GoogleCallRequest {
  connectionId: string
  operation: string            // 'ads.search' | 'ads.listAccessibleCustomers' | 'merchant.accounts.list' | 'analytics.accountSummaries.list' | 'identity.userinfo' …
  method: 'GET' | 'POST'
  url: string                  // absolute production URL
  body?: unknown               // googleCall JSON-encodes it
  loginCustomerId?: string | null   // digits only; header sent only when set
  maxTransientRetries?: number
  max429Retries?: number
  timeoutMs?: number
}

/**
 * GET, a POST to `…:search` / `…:searchStream`, or a validate-only Google Ads mutate = read; a real Google Ads mutate =
 * write; anything else is a change the gateway refuses (`action`). `body` is the JSON the call sends.
 */
export function googleKind(method: string, url: string, body?: unknown): 'read' | 'write' | 'action' {
  if (googleCallKind(method, url) === 'read') return 'read'
  // G5: applying or dismissing Google's recommendations — Google has no check for it, so always a real write.
  if (googleAdsRecommendationCall(method, url)) return 'write'
  if (!isGoogleAdsMutate(method, url)) return 'action'
  return isGoogleValidateOnly(body === undefined ? undefined : JSON.stringify(body)) ? 'read' : 'write'
}

const GOOGLE_ADS_HOST = 'googleads.googleapis.com'

export async function googleCall(req: GoogleCallRequest): Promise<Response> {
  const headers: Record<string, string> = {}
  if (req.body !== undefined) headers['Content-Type'] = 'application/json'
  if (req.loginCustomerId !== undefined && req.loginCustomerId !== null && req.loginCustomerId !== '') {
    const login = String(req.loginCustomerId).replace(/-/g, '')
    // A malformed id would make Google answer for another account or not at all: refuse before sending.
    if (!/^\d{1,20}$/.test(login)) throw new Error('googleCall: loginCustomerId must be a Google Ads customer id (digits only). Nothing was sent.')
    headers['login-customer-id'] = login
  }
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN?.trim()
  if (developerToken && new URL(req.url).hostname === GOOGLE_ADS_HOST) headers['developer-token'] = developerToken
  const kind = googleKind(req.method, req.url, req.body)
  return gatewayFetch({
    channel: 'GOOGLE',
    operation: req.operation,
    kind,
    connectionId: req.connectionId,
    url: req.url,
    method: req.method,
    headers,
    body: req.body === undefined ? null : JSON.stringify(req.body),
    auth: 'account',
    // A real write could apply twice: never retried here (Google refuses a 429 before it changes anything, but the
    // write client decides that retry itself).
    maxTransientRetries: kind === 'write' ? 0 : req.maxTransientRetries,
    max429Retries: kind === 'write' ? 0 : req.max429Retries ?? 1,
    timeoutMs: req.timeoutMs ?? 60_000,
  })
}
