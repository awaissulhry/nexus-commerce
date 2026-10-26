/**
 * Negative Targeting page — how each of its tables starts (Wasting, Stopped, Words), pure and tested in Node
 * (`gridStart.vitest.test.ts`).
 *
 *   saved     a person's layout for this table (each table keeps its own: grid audit B7 / #572) wins whole
 *   default   else the table's own default: the columns hidden by default are named in it — a start state with a sort
 *             and no column slice makes AG show every hidden column (it resets the slices a state leaves out;
 *             products/next ProductsNextClient, measured 2026-09-05)
 *   sort      the address's `?sort=` on top, when the table is ordered by the server
 *   phone     its three columns only: no saved desktop layout, nothing hidden
 */
export interface GridStart {
  columnVisibility?: { hiddenColIds: string[] }
  sort?: { sortModel: Array<{ colId: string; sort: 'asc' | 'desc' }> }
  [slice: string]: unknown
}

export function gridStartState<S extends object>(a: {
  /** The person's saved layout for this table (its last-used state, or the default view), if any. */
  saved: S | null | undefined
  /** The columns its registry hides by default (their keys). */
  hidden: readonly string[]
  sort: { colId: string; dir: 'asc' | 'desc' } | null
  phone: boolean
}): GridStart {
  const base: GridStart = a.phone ? {} : a.saved ? { ...(a.saved as Record<string, unknown>) } : { columnVisibility: { hiddenColIds: [...a.hidden] } }
  return { ...base, ...(a.sort ? { sort: { sortModel: [{ colId: a.sort.colId, sort: a.sort.dir }] } } : {}) }
}
