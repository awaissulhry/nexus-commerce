/**
 * CM-30 — the Budget Manager's "Campaign Budget Limits" drawer reads and writes each campaign's OWN Min/Max Budget
 * (`Campaign.minBudgetCents` / `maxBudgetCents`): the same numbers the Campaigns grid's Min/Max Budget cell shows and
 * the write gate enforces. It used to keep a separate per-month copy that the grid never saw.
 *
 * A limit the older Budget Manager saved only on a month's plan (`oldMonthLimit`) is not in use. It is filled into the
 * boxes, so the row counts as a change and the drawer says so: one Save keeps it, clearing the boxes drops it. Pure.
 */

export interface LimitRow {
  id: string
  minCents: number | null
  maxCents: number | null
  oldMonthLimit?: { minCents: number | null; maxCents: number | null } | null
}

export type LimitEdits = Record<string, { min: string; max: string }>

const box = (c: number | null | undefined): string => (c != null ? (c / 100).toFixed(2) : '')

/** The boxes as the drawer opens: the campaign's own limits, or the old month's limit where it has none. */
export function initialLimitEdits(rows: LimitRow[]): { edits: LimitEdits; oldCount: number } {
  let oldCount = 0
  const edits: LimitEdits = {}
  for (const r of rows) {
    const old = r.minCents == null && r.maxCents == null ? r.oldMonthLimit ?? null : null
    if (old && (old.minCents != null || old.maxCents != null)) {
      oldCount++
      edits[r.id] = { min: box(old.minCents), max: box(old.maxCents) }
    } else {
      edits[r.id] = { min: box(r.minCents), max: box(r.maxCents) }
    }
  }
  return { edits, oldCount }
}
