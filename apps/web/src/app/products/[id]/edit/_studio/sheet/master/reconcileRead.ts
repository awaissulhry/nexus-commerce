/**
 * PES.2 — reading a row back to settle an `unknown` write.
 *
 * The writer paints `unknown` when a write dies on the wire, because the request may or may not
 * have applied and nothing local can tell which. Only the database can, so the sheet re-reads the
 * row and compares. This is the parse in the middle of that, hoisted out of `useMasterSheet` for
 * the same reason `commitMasterRow` was: inside the hook it is unreachable by this suite, and it
 * decides something too load-bearing to leave untested.
 *
 * 🔴 THE DISTINCTION IT EXISTS TO KEEP: `null` means **the read did not answer** — keep asking.
 * `{}` would mean "the row holds nothing", which resolves every pending cell to `refused` and
 * tells the operator to retype work that may well be saved. A read that failed and a row that is
 * empty are the same shape in JSON and opposite facts about the world; conflating them turns an
 * outage into a page full of confident wrong answers.
 */

/** The shape this endpoint returns. Deliberately `unknown`-in: it is wire data, not our type. */
export interface SheetReadBody {
  rows?: { id?: string; values?: Record<string, { value?: unknown } | null> | null }[] | null
}

/**
 * The row's current values, keyed by column, or `null` if this body cannot answer for that row.
 *
 * Returns `null` — never `{}` — when the body is malformed, the row is absent, or the row carries
 * no values, because in every one of those cases we did not learn what the database holds.
 */
export function readRowValues(body: unknown, rowId: string): Record<string, unknown> | null {
  const rows = (body as SheetReadBody | null)?.rows
  if (!Array.isArray(rows)) return null
  const row = rows.find((r) => r?.id === rowId)
  if (!row?.values || typeof row.values !== 'object') return null
  const entries = Object.entries(row.values)
  // A row that came back with an empty `values` object told us nothing about any column we asked
  // about — the same as no answer. Only a populated row is an answer.
  if (entries.length === 0) return null
  return Object.fromEntries(entries.map(([k, v]) => [k, v?.value]))
}
