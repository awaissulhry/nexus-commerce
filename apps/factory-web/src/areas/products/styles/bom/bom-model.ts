import type { BomLine } from '../api'

/**
 * The BOM tab's rules, pure (SCR-042): where a line moves (its place is unique in the revision, so a move takes a free
 * place between its new neighbours) and what the leather of a size adds up to (every leather line's quantity with waste,
 * in its unit; unknown while any line lacks the size — never a partial sum).
 */

/** The place a line takes one step up (-1) or down (+1): a free whole number between the new neighbours, or null. */
export function moveSeq(lines: readonly Pick<BomLine, 'id' | 'seq'>[], lineId: string, delta: -1 | 1): number | null {
  const sorted = [...lines].sort((a, b) => a.seq - b.seq)
  const index = sorted.findIndex((line) => line.id === lineId)
  if (index < 0) return null
  const target = index + delta
  if (target < 0 || target >= sorted.length) return null
  // Moving up lands between the line two above and the one above; down between the one below and the one after it.
  const low = delta < 0 ? (sorted[target - 1]?.seq ?? 0) : sorted[target]!.seq
  const high = delta < 0 ? sorted[target]!.seq : (sorted[target + 1]?.seq ?? sorted[target]!.seq + 20)
  const seq = Math.floor((low + high) / 2)
  return seq > low && seq < high && seq >= 1 ? seq : null
}

/** Per size, the sum of the lines' gross quantity (null when a line has none for that size). */
export function sizeCells(lines: readonly Pick<BomLine, 'bySize'>[], sizes: readonly string[]): Array<{ size: string; total: string | null }> {
  return sizes.map((size) => {
    let total = 0
    for (const line of lines) {
      const gross = line.bySize.find((entry) => entry.size === size)?.gross ?? null
      if (gross === null) return { size, total: null }
      total += Number(gross)
    }
    return { size, total: total.toFixed(4) }
  })
}
