import { describe, expect, it } from 'vitest'

import { bandColSpan, spanWithinSection, type SpanColumnLike } from './spanRow'

const col = (id: string, pinned: 'left' | 'right' | null = null): SpanColumnLike => ({
  getColId: () => id,
  getPinned: () => pinned,
})

/** The shape of a studio sheet: a pinned identity block, then everything else. */
const DISPLAYED = [
  col('ag-Grid-SelectionColumn', 'left'),
  col('product', 'left'),
  col('sku', 'left'),
  col('name'),
  col('status'),
  col('colour'),
  col('price'),
]

describe('spanWithinSection', () => {
  it('spans the rest of the centre section from the cell onward', () => {
    expect(spanWithinSection(DISPLAYED, col('name'))).toBe(4)
    expect(spanWithinSection(DISPLAYED, col('colour'))).toBe(2)
    expect(spanWithinSection(DISPLAYED, col('price'))).toBe(1)
  })

  /**
   * 🔴 The rule the literal `colSpan: 8` gets wrong twice over. Left-pinned, centre and right-pinned
   * are three separate AG containers, and a span cannot cross between them — so a band in the
   * pinned identity block spans the PINNED columns, not the whole grid. Every sheet in this
   * programme pins its identity block, so this is the normal case, not the edge one.
   */
  it('never crosses the pinned boundary', () => {
    expect(spanWithinSection(DISPLAYED, col('product', 'left'))).toBe(2)
    expect(spanWithinSection(DISPLAYED, col('ag-Grid-SelectionColumn', 'left'))).toBe(3)
    // …and a centre cell does not count the pinned ones that precede it.
    expect(spanWithinSection(DISPLAYED, col('name'))).toBe(4)
  })

  it('follows the columns actually displayed, so a view change cannot leave it stale', () => {
    const narrow = [col('product', 'left'), col('name'), col('status')]
    expect(spanWithinSection(narrow, col('name'))).toBe(2)
    const wide = [...DISPLAYED, col('brand'), col('ean')]
    expect(spanWithinSection(wide, col('name'))).toBe(6)
  })

  /** Spanning a column the grid no longer has is how a band overlaps its neighbours. */
  it('spans ONE when the column is not displayed', () => {
    expect(spanWithinSection(DISPLAYED, col('deleted'))).toBe(1)
    expect(spanWithinSection([], col('name'))).toBe(1)
  })

  /**
   * 🔴 The bug that made a band never span. AG's `ColumnPinnedType` is
   * `'left' | 'right' | boolean | null | undefined` — FIVE spellings for three states. When the
   * normaliser compared them raw, columns disagreeing about how to spell "unpinned" landed in
   * different sections and every span collapsed to 1, with nothing in the console to say why.
   */
  it('folds all three spellings of UNPINNED into one section', () => {
    const mixed = [
      { getColId: () => 'a', getPinned: () => undefined },
      { getColId: () => 'b', getPinned: () => null },
      { getColId: () => 'c', getPinned: () => false },
    ] as SpanColumnLike[]
    expect(spanWithinSection(mixed, mixed[0])).toBe(3)
    expect(spanWithinSection(mixed, mixed[2])).toBe(1)
  })

  /** `pinned: true` is AG's legacy shorthand for pinned LEFT — not for "unpinned". */
  it('treats `true` as pinned left, not as unpinned', () => {
    const cols = [
      { getColId: () => 'p1', getPinned: () => true },
      col('p2', 'left'),
      col('c1'),
      col('c2'),
    ] as SpanColumnLike[]
    // The two pinned columns are one section; the centre pair is another.
    expect(spanWithinSection(cols, cols[0])).toBe(2)
    expect(spanWithinSection(cols, cols[2])).toBe(2)
  })
})

describe('bandColSpan', () => {
  interface Row { kind: 'alias' | 'variant' }
  const span = bandColSpan<Row>({ isBand: (d) => d?.kind === 'alias' })
  const api = { getAllDisplayedColumns: () => DISPLAYED }

  it('spans a band row and leaves an ordinary row alone', () => {
    expect(span({ data: { kind: 'alias' }, column: col('name'), api })).toBe(4)
    expect(span({ data: { kind: 'variant' }, column: col('name'), api })).toBe(1)
  })

  it('spans ONE rather than throwing when the grid is not ready', () => {
    expect(span({ data: { kind: 'alias' }, column: col('name') })).toBe(1)
    expect(span({ data: { kind: 'alias' }, api })).toBe(1)
    expect(span({ column: col('name'), api })).toBe(1)
  })
})
