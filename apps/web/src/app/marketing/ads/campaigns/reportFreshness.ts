/**
 * AM-14 + AM-5 — the Ad Manager's freshness line, from the list's own `freshness` and `intraday` fields.
 *
 * "Latest Report: <time>" was the newest `Campaign.lastSyncedAt`, which every settings sync and every write push
 * stamps — a time with nothing to do with the performance numbers, which run through yesterday at best. This says
 * what the numbers are: the last day Amazon's daily report covers per market, when Nexus received it, and, when the
 * range reaches today, how far the hourly stream has got.
 */

/** One market's daily report, as `GET /advertising/campaigns` (with a date range) returns it. */
export interface MarketFreshness { marketplace: string; dataThrough: string; receivedAt: string | null }
/** Present when the range reaches today: the UTC day of the hourly figures and the newest hour with data. */
export interface IntradayInfo { day: string; throughHour: number | null; unavailable: boolean }

const dayText = (ymd: string): string =>
  new Date(`${ymd}T00:00:00Z`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })

const receivedText = (iso: string): string =>
  new Date(iso).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })

/** "through 4 Oct 2026 (Amazon's daily report, received 5 Oct, 03:12)" — markets that differ are named. */
export function reportFreshnessText(markets: MarketFreshness[], intraday: IntradayInfo | null): string {
  let text: string
  if (!markets.length) {
    text = 'no daily report from Amazon in the last 60 days'
  } else {
    const byDay = new Map<string, string[]>()
    for (const m of markets) byDay.set(m.dataThrough, [...(byDay.get(m.dataThrough) ?? []), m.marketplace])
    const days = [...byDay.keys()].sort().reverse()
    const through = days.length === 1
      ? `through ${dayText(days[0]!)}`
      : days.map((d) => `${byDay.get(d)!.join(', ')} through ${dayText(d)}`).join('; ')
    const newest = markets.map((m) => m.receivedAt).filter((v): v is string => !!v).sort().pop()
    text = `${through} (Amazon's daily report${newest ? `, received ${receivedText(newest)}` : ''})`
  }
  if (intraday) {
    if (intraday.unavailable) text += " · today's hourly figures could not be read, so today shows no spend"
    else if (intraday.throughHour == null) text += ' · today: no hourly figures from Amazon yet'
    else text += ` · today so far from Amazon's hourly stream, to ${String(intraday.throughHour + 1).padStart(2, '0')}:00 UTC`
  }
  return text
}
