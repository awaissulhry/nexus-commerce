/**
 * GDS / PES.2 — a BAND row: one cell that runs the width of the grid.
 *
 * An alias band, a section header, a "no variations yet" note — a row whose content belongs to the
 * whole row rather than to a column. AG expresses this as `colSpan`, and the obvious spelling is a
 * literal: `colSpan: (p) => (p.data?.rowKind === 'parent' ? 8 : 1)`. That number is a guess about
 * how many columns are on screen, and it stops being true the moment a view shows a different set —
 * which, on a surface where views are the point, is immediately.
 *
 * ## The part that is not obvious
 *
 * 🔴 **A span cannot cross AG's pinned boundary.** Left-pinned, centre and right-pinned columns are
 * three separate containers; a cell in the pinned-left section spanning "everything" simply stops
 * at the edge of its own container, and a band that looks right on an unpinned grid quietly
 * truncates on a sheet whose identity block is pinned — which is every sheet in this programme.
 *
 * So the span is computed from the columns in the SAME container as the cell, counted from that
 * cell onward. That is the largest honest span, and it is derived rather than guessed.
 *
 * The counting rule is pure and tested; the AG adapter is four lines on top of it.
 */

/**
 * The minimum a column needs to expose — AG's own `Column` satisfies it, with no cast.
 *
 * 🔴 `getPinned()` takes AG's FULL `ColumnPinnedType` (`'left' | 'right' | boolean | null |
 * undefined`), and that is not a typing nicety — it was the bug. A narrower type forced every
 * caller into a cast, and behind the cast the normaliser treated `false` and `null` as DIFFERENT
 * sections, so a row whose columns disagreed about how to spell "unpinned" split into two sections
 * and every span collapsed to 1. `true` was worse: it means pinned LEFT, and was being filed as
 * unpinned. The symptom either way is a band that never spans, with nothing in the console.
 */
export interface SpanColumnLike {
  getColId(): string
  getPinned(): 'left' | 'right' | boolean | null | undefined
}

/**
 * AG's `ColumnPinnedType` is `'left' | 'right' | boolean | null | undefined`, and every one of those
 * five shapes has to be folded to a section or the filter below splits one row into several.
 *
 * 🔴 `true` means PINNED LEFT — AG's legacy shorthand — so folding it to "not pinned" would put a
 * genuinely pinned column in with the unpinned ones and compute a span across a boundary that
 * cannot be crossed. `false`/`null`/`undefined` are the three spellings of "not pinned".
 */
const sectionOf = (c: SpanColumnLike): 'left' | 'right' | null => {
  const p = c.getPinned()
  if (p === 'left' || p === 'right') return p
  return p === true ? 'left' : null
}

/**
 * How many columns a cell in `column` can span, given everything currently displayed.
 *
 * Returns 1 when the column is not in the list (a column being removed as the grid re-renders):
 * spanning a column the grid does not have is how a band ends up overlapping its neighbours.
 */
export function spanWithinSection(displayed: readonly SpanColumnLike[], column: SpanColumnLike): number {
  const section = sectionOf(column)
  const sameSection = displayed.filter((c) => sectionOf(c) === section)
  const index = sameSection.findIndex((c) => c.getColId() === column.getColId())
  if (index < 0) return 1
  return Math.max(1, sameSection.length - index)
}

export interface BandRowOptions<T> {
  /** Is THIS row a band? A row that is not spans one column, like any other. */
  isBand: (data: T | undefined) => boolean
}

/**
 * A `colSpan` for a column that carries band rows.
 *
 *   colSpan: bandColSpan<Row>({ isBand: (d) => d?.rowKind === 'alias' })
 *
 * Spreads into a `ColDef` as a stable function reference when the options object is memoised.
 */
/**
 * Typed loosely enough that AG's own `ColSpanParams` satisfies it structurally — the point being
 * that a caller spreads this straight into a `ColDef` with NO cast. A cast at a seam is where a
 * type stops being checked, which is exactly where this bug lived.
 */
export interface BandColSpanParams<T> {
  data?: T | null
  column?: SpanColumnLike
  api?: { getAllDisplayedColumns(): SpanColumnLike[] }
}

export function bandColSpan<T>(options: BandRowOptions<T>) {
  return (params: BandColSpanParams<T>): number => {
    if (!options.isBand(params.data ?? undefined)) return 1
    const displayed = params.api?.getAllDisplayedColumns?.()
    if (!displayed || !params.column) return 1
    return spanWithinSection(displayed, params.column)
  }
}
