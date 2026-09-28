/**
 * The known gaps per type, from docs/shopify-metafields/PLAN-2026-09-28.md §3 — shown on the lab's rows so what is not
 * right yet is on screen, never hidden. A slice that closes a gap removes its line here in the same change.
 * After B3 (G13–G18 closed) no known gap is left; a gap B4 finds on a real store is added here first.
 */
export interface LabGap { id: string; text: string; slice: string }

export function labGapsFor(_type: string): LabGap[] {
  return []
}
