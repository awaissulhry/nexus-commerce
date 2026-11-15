import { createHash } from 'node:crypto'
import { plusDays } from '../../calendars/dates'
import { businessDayRange, type BusinessDate } from '../../core/time'
import { parseDecimal, sum, ZERO } from '../../tax/decimal'

/**
 * The day's close (B-W2b-395; LOG-049 "end-of-day manifest"; factory-db DispatchManifest, Shipment.manifestId, B-W2b-367),
 * pure. Rule 1: the dock closes every day. Per site, carrier and day ONE sheet lists the shipments handed over to that
 * carrier (their parcels, weights and tracking numbers) for the driver to sign:
 *
 *   on the sheet   the site's CARRIER shipments of that carrier that LEFT (shipped, or delivered or back since) and are on no
 *                  sheet yet: those that left that day, and those that left in the days before after their own day's sheet
 *                  had closed (a late hand-over goes on the next sheet; DAY_SHEET_LOOKBACK_DAYS at most). A shipment still
 *                  packed is not handed over: it is never on a closed sheet (an open sheet that names one lets it go at
 *                  the close, said in words). A carrier booked by hand without a code has no sheet.
 *   close          ONE command per carrier: the sheet made when it has none, its shipments put on, its PDF (the manifest,
 *                  GeneratedDocument MANIFEST version 1 and the sheet's file), closed with when and by whom (null: the
 *                  system); from then on the sheet and its shipments are fixed (the database's guard). A person closes the
 *                  day (End of day); what is still open is closed by the system after the site's day ended
 *                  (`shipping.closeDays`). A day to come is never closed; a day older than the look-back is not either.
 *
 * Refusals are 409 with the issue path `refusal/<CODE>`; the screens word the code (`DAY_SHEET_WORDS`).
 */

export const MANIFEST_KIND = 'MANIFEST' as const

/** How many days back a late hand-over is still put on a sheet, and the oldest day closed. */
export const DAY_SHEET_LOOKBACK_DAYS = 7

/** Why a close is refused or a carrier skipped (409 `refusal/<CODE>`; in a close's answer per carrier). */
export const DAY_SHEET_REFUSALS = ['FUTURE_DAY', 'TOO_OLD', 'NOTHING_TO_CLOSE', 'ALREADY_CLOSED', 'DAY_CHANGED', 'NOT_CLOSED'] as const
export type DaySheetRefusalCode = (typeof DAY_SHEET_REFUSALS)[number]

export const daySheetRefusalPath = (code: DaySheetRefusalCode): string => `refusal/${code}`

/** The words of each refusal (English; the screens word the code themselves). */
export const DAY_SHEET_WORDS: Readonly<Record<DaySheetRefusalCode, string>> = Object.freeze({
  FUTURE_DAY: 'That day has not come yet: a day is closed once its goods were handed over.',
  TOO_OLD: `Only the last ${DAY_SHEET_LOOKBACK_DAYS} days are closed here; an older day's hand-overs went on later sheets.`,
  NOTHING_TO_CLOSE: 'Nothing was handed over to this carrier that day: there is no sheet to close.',
  ALREADY_CLOSED: "This carrier's sheet of that day is closed already: later hand-overs go on the next day's sheet.",
  DAY_CHANGED: 'A shipment left or came onto the sheet while it was being closed: close the day again.',
  NOT_CLOSED: 'The sheet is not closed yet: its PDF is made when the day closes (the preview shows it as it stands).',
})

/** The oldest day a close reaches, and the days to come it refuses (the site's today). */
export function closeDayRefusal(day: BusinessDate, today: BusinessDate): { code: DaySheetRefusalCode; message: string } | null {
  if (day > today) return { code: 'FUTURE_DAY', message: DAY_SHEET_WORDS.FUTURE_DAY }
  if (day < plusDays(today, -DAY_SHEET_LOOKBACK_DAYS)) return { code: 'TOO_OLD', message: DAY_SHEET_WORDS.TOO_OLD }
  return null
}

/** The shipments a day's sheet takes: left at or after `from` and before `until` (the site's zone). */
export function handOverWindow(day: BusinessDate, timeZone: string): { readonly from: Date; readonly until: Date } {
  return { from: businessDayRange(plusDays(day, -(DAY_SHEET_LOOKBACK_DAYS - 1)), timeZone).start, until: businessDayRange(day, timeZone).end }
}

/** The statuses of a shipment that left (handed over to the carrier). */
export const LEFT_STATUSES = ['SHIPPED', 'DELIVERED', 'RETURNED'] as const

/** One shipment as the sheet prints it. */
export interface SheetShipment {
  readonly id: string
  readonly number: string
  /** Who it goes to (the ship-to's name) and where (city, country). */
  readonly consignee: string
  readonly city: string
  readonly country: string
  readonly parcels: number
  /** Kilograms, a decimal string (3 places). */
  readonly weightKg: string
  readonly trackingNumbers: readonly string[]
  readonly ddtNumber: string | null
  readonly shippedAt: Date | null
}

/** A day's sheet as the PDF prints it. */
export interface ManifestSheet {
  readonly companyName: string
  readonly site: { readonly code: string; readonly name: string; readonly address: readonly string[] }
  readonly carrier: { readonly code: string; readonly name: string }
  readonly day: BusinessDate
  /** The sheet's id (its reference on the paper); null for a preview of a sheet not made yet. */
  readonly sheetId: string | null
  /** When it closed (on the site's clock, "YYYY-MM-DD HH:MM"); null: a preview. */
  readonly closedAt: string | null
  readonly closedBySystem: boolean
  readonly preview: boolean
  readonly shipments: readonly SheetShipment[]
}

/** The totals a sheet prints: shipments, parcels, weight (kilograms, 3 places). */
export function sheetTotals(shipments: readonly Pick<SheetShipment, 'parcels' | 'weightKg'>[]): { readonly shipments: number; readonly parcels: number; readonly weightKg: string } {
  const kilograms = sum(shipments.map((row) => parseDecimal(row.weightKg) ?? ZERO))
  return { shipments: shipments.length, parcels: shipments.reduce((total, row) => total + row.parcels, 0), weightKg: kilograms.toFixed(3) }
}

/** The shipments in the order the sheet prints them (by number). */
export const inSheetOrder = <Row extends Pick<SheetShipment, 'number'>>(rows: readonly Row[]): Row[] => [...rows].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true }))

/** What the sheet holds (its shipments' ids, sorted): the close re-reads it and refuses when it moved meanwhile. */
export const sheetFingerprint = (carrierCode: string, day: BusinessDate, shipmentIds: readonly string[]): string =>
  createHash('sha256').update(JSON.stringify([carrierCode, day, [...shipmentIds].sort()])).digest('hex')

/** The sheet's file name. */
export const sheetFileName = (siteCode: string, carrierCode: string, day: BusinessDate): string => `manifest-${siteCode}-${carrierCode}-${day}.pdf`.replace(/[^A-Za-z0-9._-]+/g, '-')
