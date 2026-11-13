import type { SizeGridColour } from '@nexus/ui/grid/size-grid/index'
import type { QuoteLine } from '../../api'

/**
 * The W1 style block's rows, one per colourway (B-W2b-382; follow-up XF7:05, B-W2b-340's note). A style block holds every line
 * of its style — the size-grid lines and, since B-W2b-280, a fee line (development, sample, tooling) or a made-to-measure
 * unit, which have no size rows and may share a goods line's colourway. The size grid and the price table key their rows by
 * colourway (the grid's value is colourway → size → pieces), so:
 *
 *   colourRowsOf   while the style is read (no style yet), one row per colourway, its sizes those of the lines that hold it —
 *                  never two rows with one key (React's "two children with the same key" on SEED-Q-0003)
 *   gridLinesOf    the lines the grid's numbers come from: the size-grid lines only (a fee line's empty sizes never blank the
 *                  goods line's numbers of the same colourway)
 *   lineOfColour   a colour row's line in the price table: its size-grid line, else the first line of that colourway
 *
 * PURE.
 */

export const isGridLine = (line: Pick<QuoteLine, 'kind'>): boolean => line.kind === 'SIZE_GRID'

export const gridLinesOf = (lines: readonly QuoteLine[]): QuoteLine[] => lines.filter(isGridLine)

export function colourRowsOf(lines: readonly QuoteLine[]): SizeGridColour[] {
  const rows = new Map<string, SizeGridColour & { offered: string[] }>()
  for (const line of lines) {
    const row = rows.get(line.colourwayId) ?? { key: line.colourwayId, label: `${line.colourway.code} · ${line.colourway.name}`, offered: [] }
    for (const entry of line.sizes) if (!row.offered.includes(entry.size)) row.offered.push(entry.size)
    rows.set(line.colourwayId, row)
  }
  return [...rows.values()]
}

export const lineOfColour = (lines: readonly QuoteLine[], colourwayId: string): QuoteLine | undefined =>
  lines.find((line) => line.colourwayId === colourwayId && isGridLine(line)) ?? lines.find((line) => line.colourwayId === colourwayId)
