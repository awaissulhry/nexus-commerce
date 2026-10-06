/**
 * AM-19 (eBay) — one point of the eBay dashboard trend chart.
 *
 * `acosPct` is PERCENT POINTS and null on a day with no sales. That day has NO ACOS: the key is left
 * out, so the line breaks there (and the tooltip shows no ACOS) instead of dropping to 0 % — the best
 * possible value drawn on the worst day.
 *
 * AM-21 — the same rule for money: a window that spans currencies carries no money per day (null), so `fees` and
 * `sales` are left out rather than drawn as 0 (the card says why instead of drawing those views).
 */
import type { TrendPayload } from '../_lib'

type TrendIn = TrendPayload['points'][number]

export function trendPoint(p: TrendIn): Record<string, number | string> {
  return {
    date: p.date.slice(5),
    ...(p.adFeesCents != null ? { fees: p.adFeesCents / 100 } : {}),
    ...(p.salesCents != null ? { sales: p.salesCents / 100 } : {}),
    clicks: p.clicks, impressions: p.impressions,
    ...(p.acosPct != null ? { acos: p.acosPct } : {}),
  }
}
