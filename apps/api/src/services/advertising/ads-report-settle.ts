/**
 * BID BRAIN BB-13 (2026-10-08, design BRAIN-UPGRADES-DESIGN.md U1a) — which days a report pull must cover so every ad day
 * SETTLES, and which days have settled. Pure: no database, no clock of its own.
 *
 * Amazon attributes a purchase to the day of the click for 7 days (Sponsored Products) or 14 (Sponsored Brands and
 * Display). A report asked for a day the morning after holds only the purchases made by then. Until 2026-10-08 every
 * daily report asked for yesterday once and never again (`ads-sync.job.ts` `yesterday()`), so every stored day kept its
 * first, incomplete copy: too few ad sales and orders on every day, for every engine, rule and screen.
 *
 * Now each night re-reads a span that ends yesterday and starts where a day becomes complete:
 *   span(adProduct) = attribution window + 1   →  Sponsored Products 8 days, Brands and Display 15
 * A pull asked at 01:15 UTC on day T for day T − 8 comes 7 whole days after that day ended: its Sponsored Products copy is
 * complete. Reports Amazon answers only one day per request (targeting, advertised product) are asked for yesterday and
 * for the day that completes tonight (T − span), so each of their days is read twice: first and settled.
 *
 * A day is SETTLED when Nexus holds a pull of it asked at least the attribution window after the day ended
 * (`pullSettles`). `settledThrough` is the newest such day of one report; `unsettledDays` lists the older days still
 * waiting for a settling pull (the one-time catch-up of the last 60 days, `ads-report-settle.service.ts`).
 */
import { attributionWindowDays } from '@nexus/shared/data-vintage'

const DAY = 86_400_000

/** YYYY-MM-DD of a date in UTC. */
export const isoDay = (d: Date): string => d.toISOString().slice(0, 10)

/** Midnight UTC of the day `d` falls on (a YYYY-MM-DD string is read as that UTC day). */
export function utcDay(d: Date | string): Date {
  const iso = typeof d === 'string' ? d.slice(0, 10) : isoDay(d)
  return new Date(`${iso}T00:00:00.000Z`)
}

/** The UTC day `n` days before the day of `now`. */
export function daysBefore(now: Date, n: number): Date {
  return new Date(utcDay(now).getTime() - n * DAY)
}

/** Days a nightly pull covers, ending yesterday: the attribution window plus one (SP 8, SB/SD 15). */
export function settleSpanDays(adProduct: string | null | undefined): number {
  return attributionWindowDays(adProduct) + 1
}

/** The nightly re-pull of one ad product: [today − span, today − 1], as report dates. */
export function settleRange(adProduct: string | null | undefined, now: Date = new Date()): { startDate: string; endDate: string } {
  return { startDate: isoDay(daysBefore(now, settleSpanDays(adProduct))), endDate: isoDay(daysBefore(now, 1)) }
}

/**
 * The days a one-day-per-request report (targeting, advertised product) is asked for tonight: yesterday (its first
 * copy) and the day that completes tonight (today − span, its settled copy). Newest first, never the same day twice.
 */
export function perDaySettleDays(adProduct: string | null | undefined, now: Date = new Date()): string[] {
  return [...new Set([isoDay(daysBefore(now, 1)), isoDay(daysBefore(now, settleSpanDays(adProduct)))])]
}

/** Whole days from the END of `date` to `pulledAt` (0 = asked the morning after; never below 0). */
export function ageDays(date: Date | string, pulledAt: Date): number {
  const dayEnd = utcDay(date).getTime() + DAY
  return Math.max(0, Math.floor((pulledAt.getTime() - dayEnd) / DAY))
}

/** True when a pull asked at `pulledAt` holds the complete copy of `date` (its attribution window had closed). */
export function pullSettles(date: Date | string, pulledAt: Date, adProduct: string | null | undefined): boolean {
  return ageDays(date, pulledAt) >= attributionWindowDays(adProduct)
}

/** `[start, end]` (YYYY-MM-DD, inclusive) in chunks of at most `maxDays`, newest chunk first. Amazon refuses over 31. */
export function chunkRange(startDate: string, endDate: string, maxDays = 30): Array<{ startDate: string; endDate: string }> {
  const out: Array<{ startDate: string; endDate: string }> = []
  const start = utcDay(startDate).getTime()
  let end = utcDay(endDate).getTime()
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || maxDays < 1) return out
  while (end >= start) {
    const from = Math.max(start, end - (maxDays - 1) * DAY)
    out.push({ startDate: isoDay(new Date(from)), endDate: isoDay(new Date(end)) })
    end = from - DAY
  }
  return out
}

/** Contiguous runs of `days` (YYYY-MM-DD, any order), each at most `maxDays` long, newest run first. */
export function contiguousRuns(days: readonly string[], maxDays = 30): Array<{ startDate: string; endDate: string }> {
  const sorted = [...new Set(days)].sort().reverse()
  const runs: Array<{ startDate: string; endDate: string }> = []
  for (const day of sorted) {
    const last = runs[runs.length - 1]
    const t = utcDay(day).getTime()
    if (last && utcDay(last.startDate).getTime() - DAY === t && (utcDay(last.endDate).getTime() - t) / DAY + 1 <= maxDays) last.startDate = day
    else runs.push({ startDate: day, endDate: day })
  }
  return runs
}

/** One report job as the settle logic reads it (AmazonAdsReportJob). */
export interface PullJob {
  profileId: string
  adProduct: string
  reportTypeId: string
  startDate: Date
  endDate: Date
  /** When the report was asked of Amazon: what a day's age counts to. */
  createdAt: Date
  status: string
  ingestedAt: Date | null
}

const IN_FLIGHT = new Set(['PENDING', 'IN_PROGRESS'])
const DEAD = new Set(['FAILED', 'EXPIRED'])

/** A job that holds `day` and was asked late enough to hold its settled copy. */
function settlingCover(job: PullJob, day: number): boolean {
  return job.startDate.getTime() <= day && day <= job.endDate.getTime() && pullSettles(new Date(day), job.createdAt, job.adProduct)
}

/**
 * The newest day of one report (one profile, ad product and report type) whose settled copy Nexus has INGESTED, among
 * `jobs` (any mix; the others are ignored). Null when no settling pull has been ingested yet.
 */
export function settledThrough(jobs: readonly PullJob[], key: { profileId: string; adProduct: string; reportTypeId: string }): Date | null {
  let best: number | null = null
  for (const j of jobs) {
    if (j.profileId !== key.profileId || j.adProduct !== key.adProduct || j.reportTypeId !== key.reportTypeId) continue
    if (j.status !== 'COMPLETED' || !j.ingestedAt) continue
    // The newest day this job settles: its end, or the newest day old enough at the time it was asked.
    const newestOld = utcDay(j.createdAt).getTime() - (attributionWindowDays(j.adProduct) + 1) * DAY
    const top = Math.min(utcDay(j.endDate).getTime(), newestOld)
    if (top < utcDay(j.startDate).getTime()) continue
    if (best == null || top > best) best = top
  }
  return best == null ? null : new Date(best)
}

/** Settling attempts that failed before a day is given up on (it stays unsettled; the health check names it). */
export const MAX_FAILED_SETTLE_ATTEMPTS = 2

/** A finished report not ingested within this long lost its download link (the ingest cron counts it as stranded). */
const STRANDED_AFTER_MS = DAY

/**
 * The days in `[from, to]` of one report that still wait for a settling pull, newest first: no settling pull of them
 * has been ingested and none is in flight. A day whose settling pulls failed `MAX_FAILED_SETTLE_ATTEMPTS` times is
 * given up on, so a day Amazon cannot answer is not asked for every night. A finished pull that was never ingested
 * within a day (its download link expired) counts as failed.
 */
export function unsettledDays(
  jobs: readonly PullJob[],
  key: { profileId: string; adProduct: string; reportTypeId: string },
  from: Date,
  to: Date,
  now: Date = new Date(),
): { days: string[]; givenUp: string[] } {
  const mine = jobs.filter((j) => j.profileId === key.profileId && j.adProduct === key.adProduct && j.reportTypeId === key.reportTypeId)
  const stranded = (j: PullJob) => j.status === 'COMPLETED' && !j.ingestedAt && now.getTime() - j.createdAt.getTime() > STRANDED_AFTER_MS
  const days: string[] = []
  const givenUp: string[] = []
  for (let t = utcDay(to).getTime(); t >= utcDay(from).getTime(); t -= DAY) {
    const covering = mine.filter((j) => settlingCover(j, t))
    if (covering.some((j) => (j.status === 'COMPLETED' && !stranded(j)) || IN_FLIGHT.has(j.status))) continue
    const failed = covering.filter((j) => DEAD.has(j.status) || stranded(j)).length
    if (failed >= MAX_FAILED_SETTLE_ATTEMPTS) givenUp.push(isoDay(new Date(t)))
    else days.push(isoDay(new Date(t)))
  }
  return { days, givenUp }
}
