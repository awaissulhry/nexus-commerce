import type { Issue } from '../../core/errors'
import { isoWeekday } from '../../calendars/dates'
import type { BusinessDate } from '../../core/time'

/**
 * Carrier cut-offs (B-W2b-386; LOG-018; design warehouse.shipments "Carrier cut-offs today": "one card per carrier: name ·
 * cut-off countdown ('1 h 12 min to 17:00') · parcels ready / still to pack"), pure. A site keeps a cut-off per carrier and
 * weekday (factory-db CarrierCutOff, B-W2b-364: HH:MM in the site's zone); a carrier without one takes the site's default
 * (ShippingSettings.cutOffTime). Our own van takes the site's default; a customer who collects has none (they come when
 * they come). The instant of a cut-off is the site's wall clock on the site's day (the API asks the calendars service for
 * the site's zone and whether it works that day).
 */

export const ISO_WEEKDAYS = ['MONDAY', 'TUESDAY', 'WEDNESDAY', 'THURSDAY', 'FRIDAY', 'SATURDAY', 'SUNDAY'] as const
export type IsoWeekday = (typeof ISO_WEEKDAYS)[number]

/** The ISO weekday of a day as the enum names it. */
export const weekdayOf = (date: BusinessDate): IsoWeekday => ISO_WEEKDAYS[isoWeekday(date) - 1]!

export const CUT_OFF_TIME = /^([01][0-9]|2[0-3]):[0-5][0-9]$/
export const CARRIER_CODE = /^[^\s\p{Cc}]{1,40}$/u

/** The minute of the day of an HH:MM time (null for anything else). */
export function minuteOf(time: string | null | undefined): number | null {
  if (typeof time !== 'string' || !CUT_OFF_TIME.test(time)) return null
  return Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5))
}

/** How a shipment travels, for its cut-off: a carrier by its code (null: none chosen yet), our own van, or the customer. */
export interface CarrierOf {
  readonly transportBy: 'CARRIER' | 'SENDER' | 'RECIPIENT'
  readonly carrierCode: string | null
}

/** A shipment's card on the day's strip: the carrier's code, `SENDER` (own van), `RECIPIENT` (the customer collects) or `none`. */
export const carrierKeyOf = (shipment: CarrierOf): string => (shipment.transportBy !== 'CARRIER' ? shipment.transportBy : (shipment.carrierCode ?? 'none'))

export interface CutOffRow {
  readonly carrierCode: string
  readonly weekday: IsoWeekday
  readonly cutOffTime: string
}

export const CUT_OFF_SOURCES = ['CARRIER', 'SITE'] as const
export type CutOffSource = (typeof CUT_OFF_SOURCES)[number]

/** The cut-off of a carrier key on a weekday: the carrier's own, else the site's default (none for the customer collecting). */
export function cutOffFor(rows: readonly CutOffRow[], key: string, weekday: IsoWeekday, siteDefault: string | null): { time: string; source: CutOffSource } | null {
  if (key === 'RECIPIENT') return null
  const own = rows.find((row) => row.carrierCode === key && row.weekday === weekday && minuteOf(row.cutOffTime) !== null)
  if (own) return { time: own.cutOffTime, source: 'CARRIER' }
  return minuteOf(siteDefault) !== null ? { time: siteDefault!, source: 'SITE' } : null
}

/** "1 h 12 min to 17:00" as numbers: whole minutes from now to the cut-off (below 0: passed). */
export const minutesTo = (cutOffAt: Date, now: Date): number => Math.floor((cutOffAt.getTime() - now.getTime()) / 60_000)

export const CUT_OFF_LIMITS = Object.freeze({ rows: 7 * 40 })

/** A site's cut-off table as the office types it: each carrier and weekday once, an HH:MM time (paths under `cutOffs/<i>`). */
export function cutOffProblems(rows: readonly { readonly carrierCode: string; readonly weekday: string; readonly time: string }[]): Issue[] {
  const issues: Issue[] = []
  if (rows.length > CUT_OFF_LIMITS.rows) issues.push({ path: 'cutOffs', message: `At most ${CUT_OFF_LIMITS.rows} cut-offs.` })
  const seen = new Set<string>()
  rows.forEach((row, index) => {
    const at = `cutOffs/${index}`
    const code = row.carrierCode.trim()
    if (!CARRIER_CODE.test(code)) issues.push({ path: `${at}/carrierCode`, message: "The carrier's code: 1 to 40 characters, no spaces." })
    if (!(ISO_WEEKDAYS as readonly string[]).includes(row.weekday)) issues.push({ path: `${at}/weekday`, message: 'A weekday: MONDAY … SUNDAY.' })
    if (minuteOf(row.time) === null) issues.push({ path: `${at}/time`, message: 'A time of day, HH:MM (24 hours).' })
    const key = `${code}|${row.weekday}`
    if (seen.has(key)) issues.push({ path: `${at}/weekday`, message: `${code} has a cut-off on ${row.weekday} already.` })
    seen.add(key)
  })
  return issues
}
