/**
 * ER1 — market list + date presets (split from _shared.tsx, C1). Presets
 * remain valid API inputs (digest/automation links); rebuilt pages use the
 * shared DateRangePicker (D1) instead.
 */
export const EBAY_MARKETS = [
  { id: 'all', label: 'All marketplaces' },
  { id: 'EBAY_IT', label: 'Italy (EBAY_IT)' },
  { id: 'EBAY_DE', label: 'Germany (EBAY_DE)' },
  { id: 'EBAY_FR', label: 'France (EBAY_FR)' },
  { id: 'EBAY_ES', label: 'Spain (EBAY_ES)' },
]
export const PRESETS = [
  { id: 'last7', label: 'Last 7 days' },
  { id: 'last14', label: 'Last 14 days' },
  { id: 'last30', label: 'Last 30 days' },
  { id: 'mtd', label: 'Month to date' },
  { id: 'last90', label: 'Last 90 days' },
]
