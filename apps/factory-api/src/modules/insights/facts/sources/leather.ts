import type { Prisma } from '@nexus/factory-db'
import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate, businessDayRange, type BusinessDate } from '@nexus/factory-domain/core/time'
import { addAreas, areaText, cutAreas, type CutAreas } from '@nexus/factory-domain/insights/kpis/leather-yield'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import type { Uom } from '@nexus/factory-domain/product/units/units'
import { liveEntries, yieldEntries, type EntryRow } from '../../../production/yield/views'
import { numberOf, type DayFact, type Reader, type Source } from '../rows'

/**
 * The leather source (B-W2b-429; ANA-020; measures leather.area_cut and leather.area_pattern; rules factory-domain
 * insights/kpis/leather-yield.ts): the live cut log entries of each site (B-W2a-13's yield of each: its area used and the net
 * area of the pieces it cut), by the day they were cut on the site's clock, in square metres. One row per measure, site and
 * day, zeros included. `readLeatherCuts` is also the drill's read (kpis/drills/leather-yield.ts).
 */

export interface LeatherCut extends CutAreas {
  readonly entry: EntryRow
  readonly day: BusinessDate
  readonly siteId: string
}

/** The live cuts matching `where` (a site and a span of instants at least), each with its day and areas in square metres. */
export async function readLeatherCuts(db: Reader, where: Prisma.CutLogWhereInput, timeZoneOf: (siteId: string) => string): Promise<LeatherCut[]> {
  const entries = await liveEntries(db, where)
  if (entries.length === 0) return []
  const figures = await yieldEntries(db, entries)
  const sites = new Map((await db.cutLog.findMany({ where: { id: { in: entries.map((entry) => entry.id) } }, select: { id: true, siteId: true } })).map((row) => [row.id, row.siteId]))
  const hides = new Map((await db.hide.findMany({ where: { id: { in: [...new Set(entries.map((entry) => entry.hideId))] } }, select: { id: true, itemId: true } })).map((row) => [row.id, row.itemId]))
  const units = new Map((await db.item.findMany({ where: { id: { in: [...new Set(hides.values())] } }, select: { id: true, baseUom: true } })).map((row) => [row.id, row.baseUom as Uom]))
  return entries.map((entry) => {
    const siteId = sites.get(entry.id)!
    const areas = cutAreas(figures.get(entry.id)!, units.get(hides.get(entry.hideId) ?? '') ?? 'M2')
    return { entry, siteId, day: businessDate(entry.serverTime, timeZoneOf(siteId)), ...areas }
  })
}

export const leatherSource: Source = async (db, { company, from, to, now }) => {
  const daily: DayFact[] = []
  const cutKey = measureOf('leather.area_cut')!
  const patternKey = measureOf('leather.area_pattern')!
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    const cuts = await readLeatherCuts(db, { siteId: site.id, serverTime: { gte: businessDayRange(from, site.timezone).start, lt: businessDayRange(last, site.timezone).end } }, () => site.timezone)
    for (const day of eachDay(from, last)) {
      const sums = addAreas(cuts.filter((cut) => cut.day === day))
      daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: cutKey.key, number: numberOf(cutKey, areaText(sums.cut)) })
      daily.push({ companyId: company.id, siteId: site.id, lineId: null, day, measureKey: patternKey.key, number: numberOf(patternKey, areaText(sums.pattern)) })
    }
  }
  return { daily, hourly: [] }
}
