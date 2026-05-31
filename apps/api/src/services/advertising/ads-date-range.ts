/**
 * Date-range engine for the advertising console (DR.1).
 *
 * The console was built on a single rolling `windowDays`. This resolves rich
 * presets (Today, Yesterday, Last 7/14/30/90, WTD, MTD, Last month, QTD, YTD,
 * Last year, Lifetime) + custom start/end into a concrete [since, until] date
 * window, anchored to Europe/Rome (the selling timezone) so "Today"/"Yesterday"
 * line up with Seller Central rather than UTC.
 *
 * AmazonAdsDailyPerformance.date is a pure @db.Date (UTC-midnight). We compute
 * the Rome calendar dates for the preset, then express them as UTC-midnight
 * Date objects for gte/lte filtering on that column. Back-compatible: with no
 * preset/dates, falls back to windowDays (default 7).
 */

const TZ = 'Europe/Rome'

export type RangePreset =
  | 'today' | 'yesterday'
  | 'last7' | 'last14' | 'last30' | 'last90'
  | 'wtd' | 'mtd' | 'last_month' | 'qtd' | 'ytd' | 'last_year'
  | 'lifetime' | 'custom' | 'window'

export interface ResolvedRange {
  since: Date        // UTC-midnight of the first Rome calendar day (inclusive)
  until: Date        // UTC-midnight of the last Rome calendar day (inclusive)
  sinceStr: string   // 'YYYY-MM-DD'
  untilStr: string   // 'YYYY-MM-DD'
  preset: RangePreset
  days: number       // inclusive day count (for adaptive bucketing)
  /** True when the range includes today → daily data is T+1-incomplete; the
   *  caller should overlay intraday (hourly stream) + flag "partial". */
  includesToday: boolean
}

/** 'YYYY-MM-DD' for a Date in Rome wall-clock. */
function romeDateStr(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
}
function atUtcMidnight(ymd: string): Date { return new Date(`${ymd}T00:00:00.000Z`) }
function addDaysStr(ymd: string, n: number): string {
  const d = atUtcMidnight(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10)
}
function daysBetween(a: string, b: string): number {
  return Math.round((atUtcMidnight(b).getTime() - atUtcMidnight(a).getTime()) / 86_400_000) + 1
}

const LIFETIME_START = '2018-01-01'

export function resolveRange(
  q: { preset?: string; startDate?: string; endDate?: string; windowDays?: string | number },
  now: Date = new Date(),
): ResolvedRange {
  const today = romeDateStr(now)
  let sinceStr = today
  let untilStr = today
  let preset = (q.preset ?? '') as RangePreset

  // Explicit custom range wins.
  if ((preset === 'custom' || !preset) && q.startDate && q.endDate) {
    sinceStr = String(q.startDate).slice(0, 10)
    untilStr = String(q.endDate).slice(0, 10)
    if (sinceStr > untilStr) [sinceStr, untilStr] = [untilStr, sinceStr]
    preset = 'custom'
  } else {
    switch (preset) {
      case 'today': sinceStr = today; untilStr = today; break
      case 'yesterday': sinceStr = addDaysStr(today, -1); untilStr = sinceStr; break
      case 'last7': sinceStr = addDaysStr(today, -6); untilStr = today; break
      case 'last14': sinceStr = addDaysStr(today, -13); untilStr = today; break
      case 'last30': sinceStr = addDaysStr(today, -29); untilStr = today; break
      case 'last90': sinceStr = addDaysStr(today, -89); untilStr = today; break
      case 'wtd': { // week starts Monday (ISO)
        const dow = (atUtcMidnight(today).getUTCDay() + 6) % 7 // Mon=0
        sinceStr = addDaysStr(today, -dow); untilStr = today; break
      }
      case 'mtd': sinceStr = `${today.slice(0, 8)}01`; untilStr = today; break
      case 'last_month': {
        const first = `${today.slice(0, 8)}01`
        untilStr = addDaysStr(first, -1)
        sinceStr = `${untilStr.slice(0, 8)}01`
        break
      }
      case 'qtd': {
        const m = Number(today.slice(5, 7))
        const qStartMonth = Math.floor((m - 1) / 3) * 3 + 1
        sinceStr = `${today.slice(0, 4)}-${String(qStartMonth).padStart(2, '0')}-01`
        untilStr = today; break
      }
      case 'ytd': sinceStr = `${today.slice(0, 4)}-01-01`; untilStr = today; break
      case 'last_year': {
        const y = Number(today.slice(0, 4)) - 1
        sinceStr = `${y}-01-01`; untilStr = `${y}-12-31`; break
      }
      case 'lifetime': sinceStr = LIFETIME_START; untilStr = today; break
      default: { // windowDays fallback (back-compat)
        const wd = Math.max(1, Math.min(730, Number(q.windowDays) || 7))
        sinceStr = addDaysStr(today, -(wd - 1)); untilStr = today
        preset = 'window'
      }
    }
  }

  return {
    since: atUtcMidnight(sinceStr),
    until: atUtcMidnight(untilStr),
    sinceStr,
    untilStr,
    preset,
    days: daysBetween(sinceStr, untilStr),
    includesToday: untilStr >= today,
  }
}

/** Adaptive chart bucket for a range — daily for short, weekly/monthly for long,
 *  so YTD/Lifetime stay readable + cheap to render. */
export function bucketFor(days: number): 'day' | 'week' | 'month' {
  if (days <= 92) return 'day'
  if (days <= 400) return 'week'
  return 'month'
}
