/**
 * The Dashboard's percent readings, with the unit of every field it reads written down — never guessed.
 *
 * Each endpoint sends ONE unit per field (documented next to its type in the API too):
 *  · `/advertising/summary`  `trueProfitMargin30dPct`        PERCENT POINTS (31.2 = 31.2 %), negative on a loss
 *  · `/advertising/trends`   `rows[].acos`, `summary.acos`   PERCENT POINTS (38.02 = 38.02 %), null with no sales
 *  · `/advertising/momentum` `campaigns|keywords|asins[].acos` FRACTION (0.38 = 38 %), null with no sales
 *  · `/advertising/momentum` `placements[].sharePct`         FRACTION (0.62 = 62 %) despite its name
 *
 * 🔴 AM-2 / AM-3 / AM-7 / AM-19 — the Dashboard used to guess the unit from the size of the number:
 * `> 1.5 ⇒ already a percent` printed a 150 %+ ACoS as "2 %"; `<= 1 ⇒ a fraction` printed a −5 %
 * margin as "−500 %"; the placement share was printed raw (0.62 → "1 %"); and a day with spend and
 * no sales was drawn as ACoS 0 %, the best possible value on the worst day. All of it goes through
 * the console's one fraction formatter (`pct`) now, with points divided by 100 here, where the unit
 * is named.
 */
import { pct } from '../campaigns/_grid/format'

/** "True margin (30d)": PERCENT POINTS in → "31%" / "-5%" / "1%". */
export const marginText = (points: number | null | undefined): string =>
  points == null || !Number.isFinite(points) ? '—' : pct(points / 100, 0)

/**
 * An ACoS FRACTION → "38.02%" — AM-30: the Ad Manager's 2 decimals (this read "38%" beside the grid's "38.02%").
 * With no ACoS, a row that spent says "no sales" (never "0%"), and a row that spent nothing says "—".
 */
export const acosText = (fraction: number | null | undefined, spendCents?: number | null): string => {
  if (fraction != null && Number.isFinite(fraction)) return pct(fraction)
  return (spendCents ?? 0) > 0 ? 'no sales' : '—'
}

/** A placement's share of sales: FRACTION in → whole percent points out (0.62 → 62), for the bar and its label. */
export const placementSharePoints = (fraction: number | null | undefined): number =>
  fraction == null || !Number.isFinite(fraction) ? 0 : Math.round(fraction * 100)

export interface TrendRowIn { date?: string; adSpendCents?: number | null; acos?: number | null }
export interface ChartPoint { date: string | undefined; spend: number; acos: number | null; noSales: boolean }

/**
 * One "Spend & ACoS" chart point. `acos` stays null when there is no ACoS, so the line breaks
 * there instead of dropping to 0 %; `noSales` marks the days that spent money and sold nothing.
 */
export function chartPoint(r: TrendRowIn): ChartPoint {
  const spendCents = r.adSpendCents != null && Number.isFinite(Number(r.adSpendCents)) ? Number(r.adSpendCents) : 0
  // AM-30 — kept to the 2 decimals trends sends (it was rounded to whole points, so the tooltip read "38%").
  const acosPoints = r.acos != null && Number.isFinite(Number(r.acos)) ? Math.round(Number(r.acos) * 100) / 100 : null
  return { date: r.date?.slice(5), spend: spendCents / 100, acos: acosPoints, noSales: acosPoints == null && spendCents > 0 }
}

/** The chart tooltip's ACoS line: "38.02%" (AM-30), "no sales", or "—" for a day with no spend. */
export const chartAcosText = (points: number | null | undefined, noSales: boolean): string =>
  points == null ? (noSales ? 'no sales' : '—') : pct(points / 100)
