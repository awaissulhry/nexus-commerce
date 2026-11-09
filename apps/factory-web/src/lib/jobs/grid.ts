import type { SizeGridColour, SizeGridCopy, SizeGridSize, SizeGridValue } from '@nexus/ui/grid/size-grid/index'

/**
 * A subcontract job's pieces per size as the DS size grid draws them (B-W2b-181): shared by the workshop's portal pages
 * (portal/supplier/jobs) and the job link (links/job), which may not import each other (check-view-boundaries). Pure.
 * The colourways are the rows (the stacked editor's tabs on a phone), the sizes the columns in the order the job gives.
 */

export interface JobCell {
  readonly colourway: string
  readonly size: string
  readonly pieces: number
  /** Finished so far (the portal's job; the link has none). */
  readonly finished?: number
}

export interface GridShape {
  colours: SizeGridColour[]
  sizes: SizeGridSize[]
  /** Pieces per cell. */
  pieces: SizeGridValue
  /** Finished so far per cell. */
  finished: SizeGridValue
  /** Still to finish per cell (pieces less finished). */
  left: SizeGridValue
}

export function gridOf(cells: readonly JobCell[]): GridShape {
  const colours: SizeGridColour[] = []
  const sizes: SizeGridSize[] = []
  const pieces: Record<string, Record<string, number>> = {}
  const finished: Record<string, Record<string, number>> = {}
  const left: Record<string, Record<string, number>> = {}
  const offered = new Map<string, string[]>()
  for (const cell of cells) {
    if (!colours.some((colour) => colour.key === cell.colourway)) colours.push({ key: cell.colourway, label: cell.colourway })
    if (!sizes.some((size) => size.key === cell.size)) sizes.push({ key: cell.size, label: cell.size })
    offered.set(cell.colourway, [...(offered.get(cell.colourway) ?? []), cell.size])
    const done = cell.finished ?? 0
    pieces[cell.colourway] = { ...pieces[cell.colourway], [cell.size]: cell.pieces }
    finished[cell.colourway] = { ...finished[cell.colourway], [cell.size]: done }
    left[cell.colourway] = { ...left[cell.colourway], [cell.size]: Math.max(0, cell.pieces - done) }
  }
  return { colours: colours.map((colour) => ({ ...colour, offered: offered.get(colour.key) ?? [] })), sizes, pieces, finished, left }
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string

/** The size grid's words from a catalogue's `grid.*` keys (both pages keep them in `portal-jobs`). */
export function gridCopyOf(t: Translate): Partial<SizeGridCopy> {
  return {
    caption: t('grid.caption'),
    colourHeader: t('grid.colour'),
    totalHeader: t('grid.total'),
    cellName: (colour, size) => t('grid.cellName', { colour, size }),
    notOffered: t('grid.notOffered'),
    empty: t('grid.empty'),
    totalsAnnouncement: ({ colour, rowTotal, size, columnTotal, grand }) => t('grid.totals', { colour, rowTotal, size, columnTotal, grand }),
    notWhole: (cell, max) => t('grid.notWhole', { cell, max }),
    cutToMax: (cell, max) => t('grid.cutToMax', { cell, max }),
    pasteResult: ({ applied, notOffered, outside, invalid, clamped }) => t('grid.pasted', { applied, skipped: notOffered + outside + invalid + clamped }),
    issuesHeading: t('grid.issues'),
  }
}
