/**
 * CBN.3 — shared metric-filter catalog. ONE definition per metric range filter (label · unit ·
 * verbatim H10 (i) tip from METRIC_TIPS). Every console grid picks the metrics it needs via
 * pickMetricFilters(...) instead of hand-rolling its own array — so the labels/units/tips stay
 * identical across Ad Groups / Search Terms / Ads (and update everywhere from one place).
 *
 * A range filter matches its tab's same-key column for the value to filter on (column.filterValue),
 * so a tab only includes a metric it actually renders a column for. `orders` and `ppcOrders` are
 * both "PPC Orders" — two keys because Ad Groups keys the column `ppcOrders` while Search Terms /
 * Ads key it `orders`.
 */
import type { GridRangeFilter } from './AdsDataGrid'
import { METRIC_TIPS } from './format'

export const METRIC_FILTERS: Record<string, GridRangeFilter> = {
  acos: { key: 'acos', label: 'ACoS', kind: 'range', unit: '%', tip: METRIC_TIPS.acos },
  roas: { key: 'roas', label: 'ROAS', kind: 'range', unit: '', tip: METRIC_TIPS.roas },
  spend: { key: 'spend', label: 'Spend', kind: 'range', unit: '€', tip: METRIC_TIPS.spend },
  sales: { key: 'sales', label: 'Sales', kind: 'range', unit: '€', tip: METRIC_TIPS.sales },
  clicks: { key: 'clicks', label: 'Clicks', kind: 'range', unit: '', tip: METRIC_TIPS.clicks },
  ppcOrders: { key: 'ppcOrders', label: 'PPC Orders', kind: 'range', unit: '', tip: METRIC_TIPS.ppcOrders },
  orders: { key: 'orders', label: 'PPC Orders', kind: 'range', unit: '', tip: METRIC_TIPS.ppcOrders },
  cpc: { key: 'cpc', label: 'CPC', kind: 'range', unit: '€', tip: METRIC_TIPS.cpc },
  ctr: { key: 'ctr', label: 'CTR', kind: 'range', unit: '%', tip: METRIC_TIPS.ctr },
  cvr: { key: 'cvr', label: 'CVR', kind: 'range', unit: '%', tip: METRIC_TIPS.cvr },
  impressions: { key: 'impressions', label: 'Impressions', kind: 'range', unit: '', tip: METRIC_TIPS.impressions },
  bid: { key: 'bid', label: 'Bid', kind: 'range', unit: '€', tip: 'Filter targets by their current bid.' },
}

/** Pick metric range filters by key, in the given order. */
export const pickMetricFilters = (...keys: Array<keyof typeof METRIC_FILTERS>): GridRangeFilter[] => keys.map((k) => METRIC_FILTERS[k])
