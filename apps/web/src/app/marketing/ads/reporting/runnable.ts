/**
 * RPT.3 — which catalogue entries the runner can execute.
 *
 * Mirrors the server's REPORT_SPECS keys. Kept as a tiny explicit list rather
 * than inferred, so adding a spec server-side without a matching entry here
 * fails visibly (the card simply does not become a link) instead of producing a
 * route that 404s on open.
 */
export const RUNNABLE_REPORT_IDS: string[] = [
  'campaign',
  'advertised-product',
  'sb-sd',
  'search-term',
  'placement',
  'hourly',
  'sqp',
  'brand-metrics',
  'economics',
]
