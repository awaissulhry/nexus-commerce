/**
 * Meta on the gateway (Meta ads M1, 2026-10-20): the ONE way Nexus calls Meta (Graph and Marketing API at
 * graph.facebook.com). Read only in M1: every call is a GET, and the gateway refuses anything else (meta-calls.ts).
 *
 * - `path` is below the pinned version (services/meta/api-version.ts): `me`, `act_123/campaigns`, `debug_token`.
 * - `query` values are sent as Meta reads them: text as is, a list or an object as JSON (`fields` may be a list).
 * - Auth: the account's own system-user token ('account', the default — the token service holds it and its app
 *   secret, the gateway adds `access_token` + `appsecret_proof`); the account's Meta app token ('app', for
 *   `debug_token`); a token and app secret the caller holds (the connect-time check, before a connection holds them);
 *   or none (the token renewal, which carries the app's id and secret itself).
 * - Paging: follow `paging.cursors.after` with the same path and query (`after=`), never `paging.next` — Meta's next
 *   link carries the token, and the gateway refuses a URL that names one.
 * - A read is retried once after a network error or a 5xx (the gateway's rule for reads); a throttle is never retried
 *   here: Meta answers it with HTTP 400 and a code, and asks callers to stop (rate-readings.ts metaRateReading).
 */
import { gatewayCall, type GatewayResponse } from './gateway.js'
import { metaGraphBase } from '../meta/api-version.js'

export type MetaQueryValue = string | number | boolean | null | undefined | readonly unknown[] | Record<string, unknown>

export interface MetaCallRequest {
  /** The META connection the call is for; null only for the connect-time check (auth with a caller-held token). */
  connectionId: string | null
  /** Stable operation name for the ledger, e.g. 'adAccount.read', 'campaigns.list', 'insights.campaignDays'. */
  operation: string
  path: string
  query?: Record<string, MetaQueryValue>
  auth?: 'account' | 'app' | 'none' | { token: string; appSecret: string }
  timeoutMs?: number
  maxTransientRetries?: number
  triggeredBy?: 'cron' | 'manual' | 'api' | 'webhook'
}

/** The absolute Graph URL of a call (no credentials on it: the gateway adds them to the URL it sends). */
export function metaUrl(path: string, query: Record<string, MetaQueryValue> = {}): string {
  const clean = path.replace(/^\/+/, '')
  const url = new URL(`${metaGraphBase()}/${clean}`)
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null) continue
    url.searchParams.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value))
  }
  return url.toString()
}

/** One Meta read through the gateway. A refusal throws GatewayRefusal; an answer (ok or not) comes back with its verdict. */
export async function metaCall(req: MetaCallRequest): Promise<GatewayResponse> {
  const auth = req.auth ?? 'account'
  return gatewayCall({
    channel: 'META',
    operation: req.operation,
    kind: 'read',
    connectionId: req.connectionId,
    appLevel: req.connectionId === null,
    url: metaUrl(req.path, req.query),
    method: 'GET',
    auth,
    maxTransientRetries: req.maxTransientRetries,
    // Meta's throttle is a 400 with a code; a real 429 is not waited out either: Meta asks to stop, not to retry.
    max429Retries: 0,
    timeoutMs: req.timeoutMs ?? 60_000,
    ledger: req.triggeredBy ? { triggeredBy: req.triggeredBy } : undefined,
  })
}
