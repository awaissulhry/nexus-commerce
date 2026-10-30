import type { BusinessDate } from '../core/time'
import { plusDays } from './dates'

/**
 * Public holiday lists a calendar can load in one go (design admin.org "Load Italian holidays 2027"; PLT-103). A loaded
 * holiday is a HOLIDAY day with `holidaySet` = the list's code, so the screen can tell it from a day a person set.
 *
 *   IT   Italy's national holidays (giorni festivi, L. 260/1949 and its amendments): 1 and 6 January, Easter Monday,
 *        25 April, 1 May, 2 June, 15 August, 1 November, 8, 25 and 26 December; 4 October (San Francesco d'Assisi,
 *        patron saint of Italy) again from 2026. A town's patron saint is not on the list: each company adds its own.
 *
 * Check the list against the law before relying on it (the 4 October change in particular); it is data, not advice.
 */

export const HOLIDAY_SETS = ['IT'] as const
export type HolidaySet = (typeof HOLIDAY_SETS)[number]

/** The years a list can be loaded for. */
export const HOLIDAY_YEARS = Object.freeze({ from: 2000, to: 2100 })

export interface PublicHoliday {
  readonly date: BusinessDate
  readonly name: string
}

const pad = (value: number): string => String(value).padStart(2, '0')

/** Easter Sunday of a Gregorian year (the anonymous Gregorian computus, Meeus/Jones/Butcher). */
export function easterSunday(year: number): BusinessDate {
  if (!Number.isInteger(year) || year < 1583) throw new RangeError(`not a Gregorian year: ${String(year)}`)
  const a = year % 19
  const b = Math.floor(year / 100)
  const c = year % 100
  const d = Math.floor(b / 4)
  const e = b % 4
  const f = Math.floor((b + 8) / 25)
  const g = Math.floor((b - f + 1) / 3)
  const h = (19 * a + b - d - g + 15) % 30
  const i = Math.floor(c / 4)
  const k = c % 4
  const l = (32 + 2 * e + 2 * i - h - k) % 7
  const m = Math.floor((a + 11 * h + 22 * l) / 451)
  const month = Math.floor((h + l - 7 * m + 114) / 31)
  const day = ((h + l - 7 * m + 114) % 31) + 1
  return `${year}-${pad(month)}-${pad(day)}`
}

/** The public holidays of a list in a year, by date. */
export function publicHolidays(set: HolidaySet, year: number): PublicHoliday[] {
  if (!Number.isInteger(year) || year < HOLIDAY_YEARS.from || year > HOLIDAY_YEARS.to) throw new RangeError(`holidays are listed for ${HOLIDAY_YEARS.from}-${HOLIDAY_YEARS.to}, not ${String(year)}`)
  if (set !== 'IT') throw new RangeError(`unknown holiday list: ${String(set)}`)
  const days: PublicHoliday[] = [
    { date: `${year}-01-01`, name: 'Capodanno' },
    { date: `${year}-01-06`, name: 'Epifania' },
    { date: plusDays(easterSunday(year), 1), name: "Lunedì dell'Angelo (Pasquetta)" },
    { date: `${year}-04-25`, name: 'Festa della Liberazione' },
    { date: `${year}-05-01`, name: 'Festa del Lavoro' },
    { date: `${year}-06-02`, name: 'Festa della Repubblica' },
    { date: `${year}-08-15`, name: 'Ferragosto (Assunzione)' },
    ...(year >= 2026 ? [{ date: `${year}-10-04`, name: "San Francesco d'Assisi, patrono d'Italia" }] : []),
    { date: `${year}-11-01`, name: 'Ognissanti' },
    { date: `${year}-12-08`, name: 'Immacolata Concezione' },
    { date: `${year}-12-25`, name: 'Natale' },
    { date: `${year}-12-26`, name: 'Santo Stefano' },
  ]
  return days.sort((x, y) => (x.date < y.date ? -1 : x.date > y.date ? 1 : 0))
}
