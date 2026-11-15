import { costBreakdown, type CostCell } from '../../quotes/record/price-depth/model'

/**
 * "Cost changed since priced" on the quote and order lines (B-W2b-380, XF6:02; design quote.price.lines "Cost changed since
 * priced · Re-price line"; B-W2b-343 showed it only in the line drawer): each size-grid line keeps the cost it was priced at
 * (`unitCost`, frozen); its revision's cost sheet today, weighted by the line's pieces per size (B-W2b-343's costBreakdown,
 * the same figures as the drawer), says how far that cost moved. Read once per style revision, never per line. The cost grain
 * only; nothing shown when the sheet is incomplete, missing or not readable. Pure.
 */

/** One line as this part reads it (a quote's or an order's). */
export interface CostLine {
  id: string
  kind: string
  styleId: string
  styleRevisionId: string | null
  colourwayId: string
  quantity: number
  /** The cost per piece kept when it was priced (the cost grain; absent without it). */
  unitCost?: string | null | undefined
  sizes: readonly { size: string | null; quantity: number }[]
}

export interface CostSheetCells {
  readonly cells: readonly CostCell[]
}

/** The cost sheets to read: one per style revision that a priced size-grid line names. */
export function sheetKeysOf(lines: readonly CostLine[]): { key: string; styleId: string; revisionId: string }[] {
  const seen = new Map<string, { key: string; styleId: string; revisionId: string }>()
  for (const line of lines) {
    if (line.kind !== 'SIZE_GRID' || !line.styleRevisionId || line.unitCost === null || line.unitCost === undefined) continue
    const key = `${line.styleId}:${line.styleRevisionId}`
    if (!seen.has(key)) seen.set(key, { key, styleId: line.styleId, revisionId: line.styleRevisionId })
  }
  return [...seen.values()]
}

/** How far each line's cost moved since it was priced (+ dearer, − cheaper, 0 the same); null: not known. */
export function costChangesOf(lines: readonly CostLine[], sheets: ReadonlyMap<string, CostSheetCells>): Map<string, number | null> {
  const changes = new Map<string, number | null>()
  for (const line of lines) {
    const sheet = line.styleRevisionId ? sheets.get(`${line.styleId}:${line.styleRevisionId}`) : undefined
    if (!sheet || line.kind !== 'SIZE_GRID') {
      changes.set(line.id, null)
      continue
    }
    const breakdown = costBreakdown(sheet, {
      colourwayId: line.colourwayId,
      quantity: line.quantity,
      unitCost: line.unitCost ?? null,
      sizes: line.sizes.flatMap((row) => (row.size === null ? [] : [{ size: row.size, quantity: row.quantity }])),
    } as Parameters<typeof costBreakdown>[1])
    changes.set(line.id, breakdown?.changed ?? null)
  }
  return changes
}

/** The mark's words (`prices-followups`): dearer or cheaper by the amount; null when nothing moved or it is not known. */
export function costChangeWords(change: number | null | undefined): { key: 'cost.up' | 'cost.down'; amount: number } | null {
  if (change === null || change === undefined || change === 0) return null
  return { key: change > 0 ? 'cost.up' : 'cost.down', amount: Math.abs(change) }
}
