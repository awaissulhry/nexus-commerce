import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { localInstant, plusDays } from '@nexus/factory-domain/calendars/dates'
import { dayOf, nextWorkingDay } from '@nexus/factory-domain/calendars/working-time'
import { BUSINESS_TIME_ZONE, businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { cutOffFor, minuteOf, minutesTo, weekdayOf, type CutOffRow, type CutOffSource, type IsoWeekday } from '@nexus/factory-domain/shipping/queue/cutoff'
import type { CommandTx } from '../../../core/command'
import { ownerKey, workingCalendarsFor } from '../../../platform/calendars/service'

/**
 * A site's shipping day (B-W2b-386; LOG-018, LOG-110): its day now in its own zone, whether it works today (its calendar,
 * through THE working-time service: holidays and closures included), and each carrier's cut-off today on the site's wall
 * clock (factory-db CarrierCutOff per carrier and weekday, else ShippingSettings.cutOffTime). Read with the caller's
 * client: the office's scoped one (the site's rows the reader's grants reach) or the system's.
 */

type Reader = FactoryClient | CommandTx

export interface SiteDay {
  readonly siteId: string
  readonly companyId: string
  readonly code: string
  readonly name: string
  readonly timeZone: string
  readonly today: BusinessDate
  readonly weekday: IsoWeekday
  /** The site works today (open with working time). */
  readonly open: boolean
  /** Why it is closed today (the calendar's reason: WEEK, DAY_OFF, HOLIDAY, CLOSURE) and the day's name; null when open. */
  readonly closed: { readonly reason: string; readonly name: string | null } | null
  /** Its next working day after today (null: none within the window read). */
  readonly nextWorkingDay: BusinessDate | null
  /** The end of the site's day (the next day's start), the deadline when no cut-off is known. */
  readonly dayEnd: Date
  readonly defaultCutOff: string | null
  readonly defaultCarrierCode: string | null
  readonly cutOffs: readonly CutOffRow[]
}

export interface CutOffToday {
  readonly time: string
  readonly at: Date
  readonly source: CutOffSource
  readonly minutesLeft: number
  readonly passed: boolean
}

/** The days of these sites now (sites the reader cannot see are left out). */
export async function siteDaysOf(db: Reader, siteIds: readonly string[], now: Date): Promise<Map<string, SiteDay>> {
  const ids = [...new Set(siteIds)]
  const out = new Map<string, SiteDay>()
  if (ids.length === 0) return out
  // One query after another: a command's client has one connection.
  const sites = await db.site.findMany({ where: { id: { in: ids } }, select: { id: true, companyId: true, code: true, name: true, timezone: true } })
  if (sites.length === 0) return out
  const settings = await db.shippingSettings.findMany({ where: { siteId: { in: sites.map((site) => site.id) } }, select: { siteId: true, cutOffTime: true, defaultCarrierCode: true } })
  const rows = await db.carrierCutOff.findMany({ where: { siteId: { in: sites.map((site) => site.id) } }, select: { siteId: true, carrierCode: true, weekday: true, cutOffTime: true } })
  const todays = sites.map((site) => businessDate(now, site.timezone || BUSINESS_TIME_ZONE)).sort()
  const window = { from: plusDays(todays[0]!, -1), to: plusDays(todays[todays.length - 1]!, 31) }
  const calendars = await workingCalendarsFor(db as Prisma.TransactionClient, sites.map((site) => ({ scope: 'SITE' as const, id: site.id })), window)
  for (const site of sites) {
    const loaded = calendars.get(ownerKey({ scope: 'SITE', id: site.id }))
    const timeZone = loaded?.owner.timeZone ?? (site.timezone || BUSINESS_TIME_ZONE)
    const today = businessDate(now, timeZone)
    const day = loaded ? dayOf(loaded.calendar, today) : null
    const open = day ? day.working : true
    const next = loaded ? nextWorkingDay(loaded.calendar, today) : null
    const setting = settings.find((row) => row.siteId === site.id)
    out.set(site.id, {
      siteId: site.id,
      companyId: site.companyId,
      code: site.code,
      name: site.name,
      timeZone,
      today,
      weekday: weekdayOf(today),
      open,
      closed: open || !day ? null : { reason: day.reason, name: day.name },
      nextWorkingDay: next?.date ?? null,
      dayEnd: businessDayRange(today, timeZone).end,
      defaultCutOff: setting?.cutOffTime ?? null,
      defaultCarrierCode: setting?.defaultCarrierCode ?? null,
      cutOffs: rows.filter((row) => row.siteId === site.id).map((row) => ({ carrierCode: row.carrierCode, weekday: row.weekday as IsoWeekday, cutOffTime: row.cutOffTime })),
    })
  }
  return out
}

/** A carrier key's cut-off today at the site (null: none known, or the customer collects). */
export function cutOffToday(day: SiteDay, key: string, now: Date): CutOffToday | null {
  const found = cutOffFor(day.cutOffs, key, day.weekday, day.defaultCutOff)
  if (!found) return null
  const at = localInstant(day.today, minuteOf(found.time)!, day.timeZone)
  const minutesLeft = minutesTo(at, now)
  return { time: found.time, at, source: found.source, minutesLeft, passed: minutesLeft < 0 }
}
