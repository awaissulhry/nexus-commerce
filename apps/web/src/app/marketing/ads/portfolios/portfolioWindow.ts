/**
 * AM-6 / AM-35 — what the Portfolios numbers cover, said on the page.
 *
 * The overview's spend, sales and ACoS are summed from Amazon's daily reports for the date window
 * picked in the header (the Ad Manager's own source and default window), and its counts follow the
 * Ad Manager's default status filter: enabled + paused, archived not counted. The page prints both.
 */

/** `GET /advertising/portfolios/overview` → `range`: inclusive 'YYYY-MM-DD' days. */
export interface OverviewWindow { startDate: string; endDate: string; preset?: string; includesToday?: boolean }

/** A local calendar day as the API's 'YYYY-MM-DD' (the same conversion the Ad Manager sends). */
export const ymd = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

/** The header's default: the last 7 days ending today — the window the Ad Manager opens with. */
export function defaultPortfolioRange(now: Date = new Date()): { start: Date; end: Date } {
  const end = new Date(now); end.setHours(0, 0, 0, 0)
  const start = new Date(end); start.setDate(start.getDate() - 6)
  return { start, end }
}

const dayLabel = (iso: string): string => {
  const d = new Date(`${iso}T00:00:00Z`)
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}

/** "28 Sep 2026 – 4 Oct 2026", or one day when start = end. */
export const windowLabel = (w: OverviewWindow): string =>
  w.startDate === w.endDate ? dayLabel(w.startDate) : `${dayLabel(w.startDate)} – ${dayLabel(w.endDate)}`

/** The sentence under the tiles: the window, the source, and what is counted. */
export function portfolioWindowNote(w: OverviewWindow | null, archived: number): string {
  const counted = archived > 0
    ? `Counts, spend and sales cover enabled and paused campaigns, as the Ad Manager shows by default; ${archived} archived campaign${archived === 1 ? ' is' : 's are'} not counted.`
    : 'Counts, spend and sales cover enabled and paused campaigns, as the Ad Manager shows by default; archived campaigns are not counted.'
  if (!w) return counted
  const today = w.includesToday ? ' Amazon reports a day’s spend the next day, so today is not in these numbers yet.' : ''
  return `Spend, sales and ACoS for ${windowLabel(w)}, summed from Amazon’s daily reports, as in the Ad Manager.${today} ${counted}`
}
