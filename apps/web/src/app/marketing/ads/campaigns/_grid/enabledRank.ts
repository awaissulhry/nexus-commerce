/**
 * SF.1 — how live a row is, for the "enabled first" default ordering. Lower sorts higher.
 *
 * Accepts the two shapes the console actually uses: a boolean (rule / rank-schedule toggles) and a
 * status string (campaigns, ad groups, targets, ads — Amazon's ENABLED/PAUSED/ARCHIVED, eBay's
 * RUNNING/PAUSED/ENDED).
 *
 * Anything unrecognised ranks WITH PAUSED rather than below archived: if Amazon or eBay introduces
 * a new status, those rows must not silently sink to the bottom of every grid where nobody looks.
 *
 * Its own module (not AdsDataGrid.tsx) so it stays unit-testable — vitest cannot parse the JSX in
 * the component file.
 */
export function enabledRank(v: unknown): number {
  if (typeof v === 'boolean') return v ? 0 : 1
  const s = String(v ?? '').toUpperCase()
  if (s === 'ENABLED' || s === 'RUNNING' || s === 'ACTIVE') return 0
  if (s === 'ARCHIVED' || s === 'ENDED') return 2
  return 1
}
