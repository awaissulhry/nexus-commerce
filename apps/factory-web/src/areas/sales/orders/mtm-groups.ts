/**
 * F-SA-232 / F-SA-234 (sales page plan N7, picks P12, R9; review C-3; 12-lists-board §6.2) — made to measure is grouped per STYLE ×
 * COLOURWAY everywhere on the order page: one made-to-measure line is one unit (one rider, one garment, one work order), so twelve
 * riders of one jacket in black are ONE row "JKT-01 · Black — Made to measure · 12 units", never twelve. The office's production
 * read groups its unit work orders the same way (`work.mtm`). Pure: no fetching, no React.
 */

export const MTM_KIND = 'MADE_TO_MEASURE'

interface Coded {
  readonly code: string
  readonly name?: string
}

/** The group a line or a unit work order belongs to (its style and colourway codes; an unknown one groups as "—"). */
export const mtmKeyOf = (style: Coded | null | undefined, colourway: Coded | null | undefined): string => `${style?.code ?? '—'}|${colourway?.code ?? '—'}`

/** One row of a list where the made-to-measure units of a style × colourway are one row and every other line is its own. */
export type Grouped<T> =
  | { readonly kind: 'line'; readonly key: string; readonly line: T }
  | { readonly kind: 'mtm'; readonly key: string; readonly style: Coded | null; readonly colourway: Coded | null; readonly lines: readonly T[] }

/**
 * The lines as the page lists them: a size-grid line (or a fee) as it is, the made-to-measure lines of one style × colourway as ONE
 * group in the place of its first line. The order of the list is kept.
 */
export function groupMadeToMeasure<T extends { readonly kind: string; readonly style: Coded | null; readonly colourway: Coded | null }>(lines: readonly T[], idOf: (line: T) => string): Grouped<T>[] {
  const out: Grouped<T>[] = []
  const groups = new Map<string, { style: Coded | null; colourway: Coded | null; lines: T[] }>()
  for (const line of lines) {
    if (line.kind !== MTM_KIND) {
      out.push({ kind: 'line', key: idOf(line), line })
      continue
    }
    const key = `mtm:${mtmKeyOf(line.style, line.colourway)}`
    const known = groups.get(key)
    if (known) {
      known.lines.push(line)
      continue
    }
    const group = { style: line.style, colourway: line.colourway, lines: [line] }
    groups.set(key, group)
    out.push({ kind: 'mtm', key, style: group.style, colourway: group.colourway, lines: group.lines })
  }
  return out
}

/** How many units a made-to-measure group holds (one line = one unit; a line closed short holds none). */
export const unitsOf = <T extends { readonly ordered?: number; readonly quantity?: number }>(lines: readonly T[]): number => lines.reduce((sum, line) => sum + Math.max(0, Math.min(1, line.ordered ?? line.quantity ?? 1)), 0)
