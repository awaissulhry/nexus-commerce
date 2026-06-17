/** Shared supporting-metrics strip (the numbers that justify a row/rec).
 *  Renders only the fields provided. */

import { eur0, num, pct, x2 } from './format'

export interface RecMetrics {
  impressions?: number; clicks?: number; ctr?: number | null
  spendCents?: number; salesCents?: number; orders?: number
  acos?: number | null; roas?: number | null; cvr?: number | null
}

export function MetricStrip({ m }: { m: RecMetrics }) {
  const cells: Array<[string, string | null]> = [
    ['Impr', m.impressions == null ? null : num(m.impressions)],
    ['Clicks', m.clicks == null ? null : num(m.clicks)],
    ['CTR', m.ctr == null ? null : pct(m.ctr, 2)],
    ['Spend', m.spendCents == null ? null : eur0(m.spendCents)],
    ['Sales', m.salesCents == null ? null : eur0(m.salesCents)],
    ['Orders', m.orders == null ? null : num(m.orders)],
    ['ACOS', m.acos == null ? null : pct(m.acos)],
    ['ROAS', m.roas == null ? null : x2(m.roas)],
    ['CVR', m.cvr == null ? null : pct(m.cvr, 2)],
  ]
  const shown = cells.filter(([, v]) => v != null)
  if (!shown.length) return null
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 mt-1.5 text-[11px] text-slate-500 dark:text-slate-400">
      {shown.map(([k, v]) => (
        <span key={k}><span className="text-tertiary">{k}</span> <span className="tabular-nums text-slate-600 dark:text-slate-300">{v}</span></span>
      ))}
    </div>
  )
}
