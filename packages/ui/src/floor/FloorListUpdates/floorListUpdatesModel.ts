/**
 * FloorList's updates slot, its rules (B-W2b-28, design part "FloorList updates slot", the floor form of D11): rows
 * never move under a gloved finger. A list that changed on the server keeps the rows on screen and shows a big
 * "List changed · Show" button; Show puts the new rows in.
 *
 * - **What counts**: a row added, a row removed, a row whose version changed (its status, its count), a row that moved
 *   — each row once, however many of those happened to it.
 * - **When the new rows go in at once**: nothing on screen yet (first load, or an empty list: nothing can move), or
 *   nothing visible changed. Otherwise they wait for Show.
 */

/** The rows that changed between what is on screen and what came in, each counted once. */
export function floorListChanges<T>(shown: readonly T[], incoming: readonly T[], key: (row: T) => string, version?: (row: T) => string): number {
  const before = new Map(shown.map((r) => [key(r), r]))
  const after = new Map(incoming.map((r) => [key(r), r]))
  const changed = new Set<string>()
  for (const k of after.keys()) if (!before.has(k)) changed.add(k)
  for (const k of before.keys()) if (!after.has(k)) changed.add(k)
  if (version) {
    for (const [k, row] of after) {
      const old = before.get(k)
      if (old !== undefined && version(old) !== version(row)) changed.add(k)
    }
  }
  // A move: the rows both lists hold, in a different order.
  const commonBefore = shown.map(key).filter((k) => after.has(k))
  const commonAfter = incoming.map(key).filter((k) => before.has(k))
  commonBefore.forEach((k, i) => {
    if (commonAfter[i] !== k) changed.add(k)
  })
  return changed.size
}

/** Whether new rows may replace the shown ones at once (nothing on screen, or nothing visible changed). */
export function floorListTakesAtOnce(shownCount: number, changes: number): boolean {
  return shownCount === 0 || changes === 0
}
