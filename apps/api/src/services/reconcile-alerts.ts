/** Phase 5 — pure alert predicates for the reconciliation/drift crons. */
export function reconcileDriftExceeds(driftPct: number | null, thresholdPct: number): boolean {
  return typeof driftPct === 'number' && Math.abs(driftPct) > thresholdPct
}
export function cumulativeDriftBreaches(absDriftUnits: number, thresholdUnits: number): boolean {
  return absDriftUnits > thresholdUnits
}
export function staleConflictCutoff(nowMs: number, days: number): Date {
  return new Date(nowMs - days * 86_400_000)
}
