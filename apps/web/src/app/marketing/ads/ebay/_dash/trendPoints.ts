/**
 * AM-19 (eBay) — one point of the eBay dashboard trend chart.
 *
 * `acosPct` is PERCENT POINTS and null on a day with no sales. That day has NO ACOS: the key is left
 * out, so the line breaks there (and the tooltip shows no ACOS) instead of dropping to 0 % — the best
 * possible value drawn on the worst day.
 */
import type { TrendPayload } from '../_lib'

type TrendIn = TrendPayload['points'][number]

export function trendPoint(p: TrendIn): Record<string, number | string> {
  return {
    date: p.date.slice(5),
    fees: p.adFeesCents / 100, sales: p.salesCents / 100,
    clicks: p.clicks, impressions: p.impressions,
    ...(p.acosPct != null ? { acos: p.acosPct } : {}),
  }
}
