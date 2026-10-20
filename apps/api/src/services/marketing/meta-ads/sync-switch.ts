/**
 * Meta ads M1 — the read's kill switch and its schedule, read from the environment. No other import, so the scheduler
 * can read them at boot without loading the read itself.
 *
 *   NEXUS_META_ADS_SYNC=off              no Meta read is scheduled, queued or run (0 / false / no / disabled too)
 *   NEXUS_META_ADS_SYNC_SCHEDULE         the daily read's cron expression, in UTC (default 50 6 * * *: 06:50 UTC — a free
 *                                        minute: 06:25 is Google's read, 06:40 and 06:45 other jobs)
 */

export const META_ADS_SYNC_SCHEDULE = '50 6 * * *'

export const SWITCHED_OFF_SENTENCE = 'Nexus does not read Meta ads right now: reading is switched off on the server.'

/** True when `NEXUS_META_ADS_SYNC` says off; unset or anything else reads (ship live). */
export function metaAdsSyncSwitchedOff(): boolean {
  const value = process.env.NEXUS_META_ADS_SYNC?.trim().toLowerCase()
  return value === 'off' || value === '0' || value === 'false' || value === 'no' || value === 'disabled'
}

/** The daily read's expression: the env override when it has the five fields of a cron line, else 06:50 UTC. */
export function metaAdsSyncSchedule(): string {
  const value = process.env.NEXUS_META_ADS_SYNC_SCHEDULE?.trim()
  return value && value.split(/\s+/).length === 5 ? value : META_ADS_SYNC_SCHEDULE
}

/** When the daily read next runs after `now` (plain "M H * * *" only); null otherwise or when switched off. */
export function nextMetaAdsReadAt(now: Date = new Date()): Date | null {
  if (metaAdsSyncSwitchedOff()) return null
  const match = /^(\d{1,2}) (\d{1,2}) \* \* \*$/.exec(metaAdsSyncSchedule())
  if (!match) return null
  const minute = Number(match[1])
  const hour = Number(match[2])
  if (minute > 59 || hour > 23) return null
  const next = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, minute))
  if (next.getTime() <= now.getTime()) next.setUTCDate(next.getUTCDate() + 1)
  return next
}
