/**
 * The channel gateway's "Not sent yet: the Amazon rate limit for this account needs N s more. Retry
 * later." — sent again instead of lost.
 *
 * The gateway keeps one rate bucket per account and operation family (`bucketGroupOf`), so every
 * `createReport` of an Amazon account shares one bucket: Amazon allows about one a minute
 * (0.0167/s). The gateway waits at most 30 s for a slot; when the slot is further away it refuses
 * WITHOUT SENDING (`GatewayRefusal`, code `RATE_LIMITED_LOCAL`, `retryAfterMs` = the wait it needs).
 * Nothing reached Amazon, so the same request can simply be sent again after that wait.
 *
 * 🔴 Measured 2026-10-01..10-05 on the nightly SQP pass: `created=6 failed=24` every night, because
 * the refusal was counted as a failure (#483). Every other `createReport` caller met the same refusal
 * the moment it ran beside that pass, with no retry at all — so this lives here, outside the SQP
 * service, and both use it.
 *
 * Duck-typed on purpose (`name` + `code`): importing the gateway module here would load the whole
 * gateway (ledger, database) into every report helper at import time.
 */
import type { GatewayRefusal } from './gateway/gateway.js'

/** One Amazon createReport slot (one per 60 s) plus a second of margin: the wait when the gateway names none. */
export const RATE_RETRY_FALLBACK_WAIT_MS = 61_000
/** The longest one retry waits, whatever the gateway names. */
export const RATE_RETRY_MAX_WAIT_MS = 120_000
/** How many times one request is sent again after the gateway's rate refusal. */
export const RATE_RETRY_DEFAULT_RETRIES = 3

/** The gateway refused for its own rate limit: nothing reached Amazon, so the same request can be sent later. */
export function isGatewayRateRefusal(err: unknown): err is GatewayRefusal {
  return err instanceof Error && err.name === 'GatewayRefusal' && (err as { code?: unknown }).code === 'RATE_LIMITED_LOCAL'
}

/** How long to wait before sending again: the wait the gateway named plus a second, else one slot. */
export function rateRetryWaitMs(err: GatewayRefusal): number {
  const named = err.retryAfterMs
  const ms = named != null && named > 0 ? named + 1_000 : RATE_RETRY_FALLBACK_WAIT_MS
  return Math.min(ms, RATE_RETRY_MAX_WAIT_MS)
}

/** The caller's time budget ran out before this request could be sent. Nothing was sent. */
export class RateRetryOutOfTime extends Error {
  constructor() { super('not sent: the request pass reached its time budget'); this.name = 'RateRetryOutOfTime' }
}

/**
 * Send one request; on the gateway's rate refusal wait the time it names and send the SAME request
 * again, at most `retries` times and never past `deadlineAt`. Any other error, or the last refusal,
 * is thrown unchanged.
 *
 * `pace` (optional) is awaited before every send: it answers false when the next slot falls after
 * `deadlineAt`, and then `RateRetryOutOfTime` is thrown without sending.
 */
export async function sendWithRateRetry<T>(
  send: () => Promise<T>,
  opts: {
    pace?: (deadlineAt?: number) => Promise<boolean>
    retries?: number
    deadlineAt?: number
    /** Told before each wait, so the caller can log it. */
    onRetry?: (info: { attempt: number; waitMs: number; error: GatewayRefusal }) => void
  } = {},
): Promise<T> {
  const retries = opts.retries ?? RATE_RETRY_DEFAULT_RETRIES
  for (let attempt = 0; ; attempt++) {
    if (opts.pace && !(await opts.pace(opts.deadlineAt))) throw new RateRetryOutOfTime()
    try {
      return await send()
    } catch (err) {
      if (!isGatewayRateRefusal(err) || attempt >= retries) throw err
      const waitMs = rateRetryWaitMs(err)
      if (opts.deadlineAt != null && Date.now() + waitMs > opts.deadlineAt) throw err
      opts.onRetry?.({ attempt: attempt + 1, waitMs, error: err })
      await new Promise((r) => setTimeout(r, waitMs))
    }
  }
}
