import { rootOf, type DailyFacts } from '../../production/reports/daily'

/**
 * One hour of a site's day for the floor measures (B-W2b-428; ANA-069 hourly facts), pure: the day's inputs of the daily
 * production report (production/reports/daily dailyReport) kept to what belongs to one hour — a scan in the hour of the
 * REPORT it stands for (a correction or an undo counts with the report it corrects), a rework in the hour it happened — so
 * that the same calculation over each hour gives hours that add up to the day. A line with nothing reported shows only on
 * the day (its planned people), never as an empty hour.
 */
export function factsOfHour(facts: DailyFacts, start: Date, end: Date): DailyFacts {
  const byId = new Map(facts.scans.map((scan) => [scan.id, scan]))
  const inHour = (instant: Date | undefined) => instant !== undefined && instant >= start && instant < end
  return {
    ...facts,
    scans: facts.scans.filter((scan) => inHour(rootOf(scan, byId).at)),
    extras: facts.extras.filter((extra) => inHour(extra.at)),
    available: new Map(),
  }
}
