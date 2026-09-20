/**
 * P3.5 — one alert per deprecated endpoint, not one per call.
 *
 * A deprecated endpoint is deprecated on **every** answer it gives. The Amazon Ads
 * `PUT /sp/keywords` in this ledger alone has 26,838 calls; if each one raised an alert
 * the bell would hold 26,838 copies of the same sentence, and P3.4's own note applies —
 * an operator who learns to dismiss the bell stops reading it.
 *
 * Two guards, doing different jobs:
 *
 *  1. **P3.4's dedupe** is the correctness one: one unread notice per endpoint per
 *     person, and a recurrence after it is read is new information. That is in
 *     `raiseChannelAlert` and is not repeated here.
 *  2. **An in-process seen-set** is the cheapness one: without it every single gateway
 *     answer on a deprecated endpoint would do a `Notification.findFirst` per owner.
 *     It has a TTL so it can only ever delay a re-alert, never suppress one — the
 *     database remains the authority on whether anybody has been told.
 */

import { logger } from '../../utils/logger.js'
import { deprecationOf, type DeprecationNotice } from './deprecation-readings.js'
import { raiseChannelAlert, deprecationAlert } from './channel-alerts.service.js'

/**
 * How long one endpoint stays quiet in THIS process after an attempt to alert.
 *
 * An hour: long enough that a hot endpoint costs one check an hour instead of thousands,
 * short enough that a restart or a read notice is reflected within a working session.
 */
const QUIET_MS = 60 * 60 * 1000

/** endpoint key → when we last tried to alert about it. */
const lastSeen = new Map<string, number>()

/** Bounded, so a channel that deprecates a path per SKU cannot grow this without limit. */
const MAX_TRACKED = 500

const keyOf = (channel: string, endpoint: string, sunsetAt: string | null): string =>
  `${channel}|${endpoint}|${sunsetAt ?? ''}`

/** Testing seam: the watch is process-level state, so a test must be able to clear it. */
export function resetDeprecationWatch(): void {
  lastSeen.clear()
}

/** Visible for the record: how many endpoints this process is holding quiet. */
export function deprecationWatchSize(): number {
  return lastSeen.size
}

export interface DeprecationWatchResult {
  notice: DeprecationNotice | null
  /** True when this call actually attempted to raise the alert. */
  raised: boolean
  /** True when an alert was suppressed because this process raised one recently. */
  quiet: boolean
}

/**
 * Look at one channel answer and, if the channel says the endpoint is going away, tell
 * the owning profile's owners — once.
 *
 * Never throws and never awaits anything on the hot path when there is no notice, which
 * is every call but a handful.
 */
export async function watchForDeprecation(args: {
  channel: string
  endpoint: string
  headers: Headers
  now?: number
}): Promise<DeprecationWatchResult> {
  let notice: DeprecationNotice | null = null
  try {
    notice = deprecationOf(args.headers)
  } catch {
    // A malformed header is the channel's problem, not a reason to fail its call.
    return { notice: null, raised: false, quiet: false }
  }
  if (!notice) return { notice: null, raised: false, quiet: false }

  const now = args.now ?? Date.now()
  // The sunset date is part of the key: a channel that MOVES its shutdown date has said
  // something new, and an operator who planned around the old one needs to hear it.
  const key = keyOf(args.channel, args.endpoint, notice.sunsetAt)
  const seen = lastSeen.get(key)
  if (seen !== undefined && now - seen < QUIET_MS) return { notice, raised: false, quiet: true }

  if (lastSeen.size >= MAX_TRACKED) {
    // Drop the oldest rather than stop tracking: a full map that refuses new keys would
    // silence a channel that started deprecating things today.
    const oldest = [...lastSeen.entries()].sort((a, b) => a[1] - b[1])[0]
    if (oldest) lastSeen.delete(oldest[0])
  }
  lastSeen.set(key, now)

  try {
    const alert = deprecationAlert(args.channel, args.endpoint, notice.sunsetAt)
    // Shopify explains itself; the standard headers do not. Carry the reason when there
    // is one rather than replacing the channel's words with ours.
    if (notice.reason) {
      alert.body = `${alert.body} ${args.channel} says: ${notice.reason}`
      alert.meta = { ...(alert.meta ?? {}), reason: notice.reason }
    }
    alert.meta = { ...(alert.meta ?? {}), via: notice.via }
    await raiseChannelAlert(alert)
  } catch (err: any) {
    logger.warn('[deprecation-watch] could not alert', { channel: args.channel, endpoint: args.endpoint, error: err?.message })
  }
  logger.info('[deprecation-watch] channel says an endpoint is going away', {
    channel: args.channel, endpoint: args.endpoint, sunsetAt: notice.sunsetAt, via: notice.via,
  })
  return { notice, raised: true, quiet: false }
}
