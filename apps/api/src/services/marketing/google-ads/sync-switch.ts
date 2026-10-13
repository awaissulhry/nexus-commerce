/**
 * Google Ads step 1a — the read's kill switch and its schedule, read from the environment (PLAN.md L9). No other
 * import, so the scheduler can read them at boot without loading the read itself.
 *
 *   NEXUS_GOOGLE_ADS_SYNC=off              no Google Ads read is scheduled, queued or run (0 / false / no / disabled too)
 *   NEXUS_GOOGLE_ADS_SYNC_SCHEDULE         the daily read's cron expression, in UTC (default 25 6 * * *: 06:25 UTC)
 */

export const GOOGLE_ADS_SYNC_SCHEDULE = '25 6 * * *'

export const SWITCHED_OFF_SENTENCE = 'Nexus does not read Google Ads right now: reading is switched off on the server.'

/** True when `NEXUS_GOOGLE_ADS_SYNC` says off; unset or anything else reads (ship live). */
export function googleAdsSyncSwitchedOff(): boolean {
  const value = process.env.NEXUS_GOOGLE_ADS_SYNC?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no' || value === 'disabled'
}

/** The daily read's expression: the env override when it has the five fields of a cron line, else 06:25 UTC. */
export function googleAdsSyncSchedule(): string {
  const value = process.env.NEXUS_GOOGLE_ADS_SYNC_SCHEDULE?.trim()
  return value && value.split(/\s+/).length === 5 ? value : GOOGLE_ADS_SYNC_SCHEDULE
}

/**
 * When the daily read next runs after `now`, for an expression of the plain form "M H * * *" (both numbers, UTC);
 * null for any other expression (the time cannot be stated honestly) or when reading is switched off.
 */
export function nextGoogleAdsReadAt(now: Date = new Date()): Date | null {
  if (googleAdsSyncSwitchedOff()) return null
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(googleAdsSyncSchedule())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (minute > 59 || hour > 23) return null
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next
}
