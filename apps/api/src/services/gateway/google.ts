/**
 * Google on the gateway (2026-10-13, Google Ads step 1): the ONE way Nexus calls Google Ads, Merchant
 * Center, Analytics and the sign-in's userinfo. A `fetch`-shaped answer (`Response`), like `gatewayFetch`.
 *
 * - Read-only in step 1: `googleKind` says read for a GET or a POST to `…:search` / `…:searchStream`;
 *   the gateway refuses every other Google call (`GOOGLE_READ_ONLY`), with its ledger row.
 * - The account's own token as `Authorization: Bearer` (the gateway refreshes it under the lease).
 * - `login-customer-id` only when the caller names a manager account (digits only).
 * - `developer-token` only when env `GOOGLE_ADS_DEVELOPER_TOKEN` is set, and only to the Google Ads host:
 *   Google made the token optional (and ignored) in 2026-09 and will reject it in a later version.
 * - A body is sent as JSON.
 */
import { gatewayFetch } from './gateway.js'
import { googleCallKind } from './channels.js'

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

/** GET, or POST to `…:search` / `…:searchStream` = read; anything else is a change (refused in step 1). */
export function googleKind(method: string, url: string): 'read' | 'action' {
  return googleCallKind(method, url)
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
  return gatewayFetch({
    channel: 'GOOGLE',
    operation: req.operation,
    kind: googleKind(req.method, req.url),
    connectionId: req.connectionId,
    url: req.url,
    method: req.method,
    headers,
    body: req.body === undefined ? null : JSON.stringify(req.body),
    auth: 'account',
    maxTransientRetries: req.maxTransientRetries,
    max429Retries: req.max429Retries ?? 1,
    timeoutMs: req.timeoutMs ?? 60_000,
  })
}
