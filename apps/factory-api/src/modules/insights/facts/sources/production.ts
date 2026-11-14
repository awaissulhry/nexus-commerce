import { eachDay } from '@nexus/factory-domain/calendars/dates'
import { businessDate } from '@nexus/factory-domain/core/time'
import { measureOf } from '@nexus/factory-domain/insights/kpis/measures'
import { hoursOfDay } from '@nexus/factory-domain/insights/periods/periods'
import { factsOfHour } from '@nexus/factory-domain/insights/kpis/hours'
import { dailyReport, type DailyReport } from '@nexus/factory-domain/production/reports/daily'
import { dailyFactsOf } from '../../../production/reports/daily'
import { numberOf, type DayFact, type HourFact, type Source } from '../rows'

/**
 * The production source (B-W2b-428; measures production.output_pieces, production.scrap_pieces): each site's days counted
 * by the daily production report's own calculation (factory-domain production/reports/dailyReport over the inputs
 * production/reports/daily.ts reads: the scans that stand, their corrections back to the report they correct, the rework
 * finished with scrap and the rework opened by hand). The day's facts are exactly that report's totals (site) and lanes
 * (lines); the hourly facts are the same calculation over each hour's part of the day — a scan in the hour of the report it
 * stands for, a rework in the hour it happened — so the hours of a day add up to the day. Never per person: the scans are
 * read without their worker.
 *
 * Rows: a site row per day (zeros included); a line row per day and per hour only when the line counted something; a site
 * row per hour only when the site counted something; nothing for an hour that has not begun.
 */

const OUTPUT = 'production.output_pieces'
const SCRAP = 'production.scrap_pieces'

function rowsOf(report: DailyReport, place: (lineId: string | null, measureKey: string, amount: number) => void, zeros: boolean): void {
  if (zeros || report.totals.good > 0) place(null, OUTPUT, report.totals.good)
  if (zeros || report.totals.scrap > 0) place(null, SCRAP, report.totals.scrap)
  for (const lane of report.lanes) {
    if (lane.lane.kind !== 'LINE') continue
    if (lane.good > 0) place(lane.lane.id, OUTPUT, lane.good)
    if (lane.scrap > 0) place(lane.lane.id, SCRAP, lane.scrap)
  }
}

export const productionSource: Source = async (db, { company, from, to, now }) => {
  const daily: DayFact[] = []
  const hourly: HourFact[] = []
  for (const site of company.sites) {
    const today = businessDate(now, site.timezone)
    const last = to < today ? to : today
    if (last < from) continue
    for (const day of eachDay(from, last)) {
      const built = await dailyFactsOf(db, site, day)
      rowsOf(dailyReport(built.facts, built.laneOrder), (lineId, measureKey, amount) => daily.push({ companyId: company.id, siteId: site.id, lineId, day, measureKey, number: numberOf(measureOf(measureKey)!, amount) }), true)
      if (built.facts.scans.length === 0 && built.facts.extras.length === 0) continue
      for (const hourStart of hoursOfDay(day, site.timezone)) {
        if (hourStart > now) break
        const report = dailyReport(factsOfHour(built.facts, hourStart, new Date(hourStart.getTime() + 3_600_000)), built.laneOrder)
        rowsOf(report, (lineId, measureKey, amount) => hourly.push({ companyId: company.id, siteId: site.id, lineId, day, hourStart, measureKey, number: numberOf(measureOf(measureKey)!, amount) }), false)
      }
    }
  }
  return { daily, hourly }
}
