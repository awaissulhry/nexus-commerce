/**
 * The WIP heat map (B-W2b-50; MES-162; design production.floor "WIP by operation": "W2b: Heatmap across lines (where
 * bundles pile up)", "a pile above the line's usual size is marked with a word, not only colour"; floor.display "Work in
 * progress": bundles per operation, stuck bundles count), pure.
 *
 *   waiting   an ACTIVE bundle of an open work order waits at the next scanned operation it has no standing report at
 *             (factory-domain production/bundles/where.ts: places CUTTING and LINE). Bundles on hold, in rework, at a
 *             subcontractor or finished wait at no operation (each has its own list).
 *   line      the line of the station of its last scan; a bundle never scanned on a line (made at the cutting table,
 *             reported only at a station alone) is on its work order's allocated line, else on no line (its own row).
 *   cell      a line × an operation code (the routing's code: the same code across the work orders' routings is one
 *             column), with its bundles, pieces and stuck bundles.
 *   level     the cell's bundles against the map's biggest cell: NONE (0), LOW (up to a third), MEDIUM (up to two
 *             thirds), HIGH (above): the colour.
 *   pile      the word: at least PILE.minBundles bundles and at least PILE.times the line's usual cell (the mean of its
 *             other cells with bundles); a line with one cell only: at least PILE.minBundles × PILE.times bundles.
 *
 * Bundles and pieces only: never a person, never a station's own output.
 */

export const HEAT_LEVELS = ['NONE', 'LOW', 'MEDIUM', 'HIGH'] as const
export type HeatLevel = (typeof HEAT_LEVELS)[number]

export const PILE = Object.freeze({ minBundles: 3, times: 2 })

export interface WaitingBundle {
  readonly lineId: string | null
  readonly operation: { readonly code: string; readonly name: string; readonly seq: number }
  readonly pieces: number
  readonly stuck: boolean
}

export interface HeatCell {
  readonly code: string
  readonly bundles: number
  readonly pieces: number
  readonly stuck: number
  readonly level: HeatLevel
  readonly pile: boolean
}

export interface HeatRow {
  /** null: the bundles on no line yet. */
  readonly lineId: string | null
  readonly bundles: number
  readonly pieces: number
  readonly stuck: number
  /** One cell per column, in the columns' order. */
  readonly cells: readonly HeatCell[]
}

export interface HeatMap {
  /** The operations, in routing order (the lowest seq a code has), then by code. */
  readonly columns: readonly { readonly code: string; readonly name: string }[]
  /** The lines in the order given, then the row of no line (only when it has bundles). */
  readonly rows: readonly HeatRow[]
  /** The biggest cell's bundles (0: nothing waits). */
  readonly max: number
}

export function levelOf(bundles: number, max: number): HeatLevel {
  if (bundles <= 0 || max <= 0) return 'NONE'
  const share = bundles / max
  if (share <= 1 / 3) return 'LOW'
  if (share <= 2 / 3) return 'MEDIUM'
  return 'HIGH'
}

/** A pile above the line's usual size (see the module comment). */
export function isPile(bundles: number, others: readonly number[]): boolean {
  if (bundles < PILE.minBundles) return false
  const filled = others.filter((count) => count > 0)
  if (filled.length === 0) return bundles >= PILE.minBundles * PILE.times
  const usual = filled.reduce((sum, count) => sum + count, 0) / filled.length
  return bundles >= usual * PILE.times
}

/** The map of the bundles waiting, over these lines (in this order). */
export function heatMap(waiting: readonly WaitingBundle[], lineOrder: readonly string[]): HeatMap {
  const columns = new Map<string, { code: string; name: string; seq: number }>()
  for (const bundle of waiting) {
    const seen = columns.get(bundle.operation.code)
    if (!seen) columns.set(bundle.operation.code, { ...bundle.operation })
    else if (bundle.operation.seq < seen.seq) columns.set(bundle.operation.code, { ...seen, seq: bundle.operation.seq })
  }
  const ordered = [...columns.values()].sort((a, b) => a.seq - b.seq || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0))
  const counts = new Map<string, { bundles: number; pieces: number; stuck: number }>()
  const keyOf = (lineId: string | null, code: string) => `${lineId ?? '-'}|${code}`
  for (const bundle of waiting) {
    const key = keyOf(bundle.lineId, bundle.operation.code)
    const cell = counts.get(key) ?? { bundles: 0, pieces: 0, stuck: 0 }
    cell.bundles += 1
    cell.pieces += Math.max(0, bundle.pieces)
    if (bundle.stuck) cell.stuck += 1
    counts.set(key, cell)
  }
  const max = Math.max(0, ...[...counts.values()].map((cell) => cell.bundles))
  // A bundle on a line not in the order (an archived line) keeps its own row after the others; the row of no line last.
  const extra = [...new Set(waiting.flatMap((bundle) => (bundle.lineId !== null && !lineOrder.includes(bundle.lineId) ? [bundle.lineId] : [])))].sort()
  const lineIds: (string | null)[] = [...lineOrder, ...extra, ...(waiting.some((bundle) => bundle.lineId === null) ? [null] : [])]
  const rows = lineIds.map((lineId) => {
    const raw = ordered.map((column) => counts.get(keyOf(lineId, column.code)) ?? { bundles: 0, pieces: 0, stuck: 0 })
    const cells = raw.map((cell, index) => ({
      code: ordered[index]!.code,
      bundles: cell.bundles,
      pieces: cell.pieces,
      stuck: cell.stuck,
      level: levelOf(cell.bundles, max),
      pile: isPile(cell.bundles, raw.filter((_, other) => other !== index).map((entry) => entry.bundles)),
    }))
    return { lineId, bundles: sum(raw, 'bundles'), pieces: sum(raw, 'pieces'), stuck: sum(raw, 'stuck'), cells }
  })
  return { columns: ordered.map(({ code, name }) => ({ code, name })), rows, max }
}

const sum = (cells: readonly { bundles: number; pieces: number; stuck: number }[], key: 'bundles' | 'pieces' | 'stuck') => cells.reduce((total, cell) => total + cell[key], 0)
