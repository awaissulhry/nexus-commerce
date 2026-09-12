/**
 * Which columns readiness has flagged on a row in view — rule 4 of the approved default view (#173).
 *
 * 🔴 ONE implementation for both scopes (#467/D11). Master and channel each had their own, and they
 * did not agree about what "flagged" reads from: this one asks the **server's readiness verdict**,
 * while the channel's asked the row's delivered CELLS. That difference was invisible until PES.5
 * served a cell for every declared column and Amazon·IT's default view jumped 1,404 → 1,934px while
 * master's did not move at all. Same rule, two implementations, and only one of them had a
 * dependency on what happened to be delivered.
 *
 * Readiness is the right source: it is a verdict the server has already reached about the row, and
 * it is complete whether or not a cell for that column came down with it.
 */
/**
 * Rule 4's input: every column key readiness has flagged on at least one row in view.
 *
 * Separate and pure so the default view can be tested without a grid, and so the "which rows" part
 * stays the caller's decision — a filtered sheet flags what is on screen, not what exists.
 */
export function flaggedColumnKeys(rows: readonly { readiness?: { issues?: readonly { key: string }[] } | null }[] | undefined): string[] {
  if (!rows?.length) return []
  const keys = new Set<string>()
  for (const r of rows) for (const i of r.readiness?.issues ?? []) if (i?.key) keys.add(i.key)
  return [...keys]
}
