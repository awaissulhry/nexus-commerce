import { describe, expect, it } from 'vitest'

import { GridExportRefused, gridCsvRows, type GridCsvSource } from './exportGrid'
import { AG_AUTO_COL, AG_SELECTION_COL } from '../columns/columnPrefs'

const source = (over: Partial<GridCsvSource> = {}): GridCsvSource => ({
  rowModelType: 'clientSide',
  columns: [
    { colId: AG_SELECTION_COL, header: '' },
    { colId: AG_AUTO_COL, header: '' },
    { colId: 'sku', header: 'SKU' },
    { colId: 'price', header: 'Price' },
  ],
  rows: [
    { key: 'r1', isData: true },
    { key: 'g1', isData: false },
    { key: 'r2', isData: true },
  ],
  cell: (rowKey, colId) => {
    const cells: Record<string, string> = { 'r1:sku': 'GALE-JACKET', 'r1:price': '€129', 'r2:sku': 'GALE-BLACK-L', 'r2:price': '€99' }
    return cells[`${rowKey}:${colId}`] ?? null
  },
  narrowed: false,
  ...over,
})

const lines = (csv: string) => csv.split('\r\n')

describe('gridCsvRows', () => {
  it('writes the displayed columns as headers, dropping AG’s own selection column', () => {
    expect(lines(gridCsvRows(source(), 'master').csv)[0]).toBe('SKU,Price')
  })

  it('writes one line per DATA row, in the order given, skipping layout rows', () => {
    const r = gridCsvRows(source(), 'master')
    expect(lines(r.csv)).toEqual(['SKU,Price', 'GALE-JACKET,€129', 'GALE-BLACK-L,€99'])
    // The group row is not exported as a row of blanks — it is not exported at all.
    expect(r.rows).toBe(2)
    expect(r.columns).toBe(2)
  })

  it('takes the cell as the GRID renders it, so money stays money and is not re-derived', () => {
    // `€129` reaches the file verbatim; nothing here knows the underlying value was cents.
    expect(gridCsvRows(source(), 'master').csv).toContain('€129')
  })

  /**
   * The rule `gridCsv.ts`'s header states: under a server-side row model the grid holds the loaded
   * blocks, not the result set, so an export from the grid is a silent subset of what the operator
   * filtered to. Refusing loudly is the whole point — a partial file that says nothing is worse
   * than no file.
   */
  it('REFUSES under a server-side row model rather than exporting a silent subset', () => {
    expect(() => gridCsvRows(source({ rowModelType: 'serverSide' }), 'products')).toThrow(GridExportRefused)
    expect(() => gridCsvRows(source({ rowModelType: 'infinite' }), 'products')).toThrow(GridExportRefused)
  })

  it('names the file by date, and marks it when the view is narrowed', () => {
    const d = new Date('2026-09-02T10:00:00Z')
    expect(gridCsvRows(source(), 'master', d).fileName).toBe('master-2026-09-02.csv')
    expect(gridCsvRows(source({ narrowed: true }), 'master', d).fileName).toBe('master-2026-09-02-filtered.csv')
  })

  it('exports an empty file with headers rather than throwing when nothing is on screen', () => {
    const r = gridCsvRows(source({ rows: [] }), 'master')
    expect(r.rows).toBe(0)
    expect(lines(r.csv)).toEqual(['SKU,Price'])
  })

  it('escapes a value holding a comma, a quote or a newline (RFC 4180)', () => {
    const r = gridCsvRows(
      source({ cell: (rowKey, colId) => (rowKey === 'r1' && colId === 'sku' ? 'Jacket, "Gale"\nblack' : 'x') }),
      'master',
    )
    expect(r.csv).toContain('"Jacket, ""Gale""\nblack"')
  })

  /**
   * The three defects the FIRST real export had. None was caught by a unit test, because each was a
   * wrong premise rather than wrong logic — they were found by exporting the sheet and reading the
   * file. These lock them shut.
   */
  describe('regressions found by exporting the real sheet', () => {
    it("drops AG's tree column, which carried an empty header and the row's internal id", () => {
      const r = gridCsvRows(source(), 'master')
      expect(lines(r.csv)[0]).toBe('SKU,Price')
      expect(lines(r.csv)[0].startsWith(',')).toBe(false)
      expect(r.csv).not.toContain('cmokmy')
    })

    it('exports a tree PARENT — a row with data is a record, even though AG marks it group', () => {
      // The family's parent holds every master attribute and the sheet edits it; AG still sets
      // `group: true` because it has children. Filtering on `group` lost it from every export.
      const withParent = source({
        rows: [{ key: 'parent', isData: true }, { key: 'r1', isData: true }, { key: 'agg', isData: false }],
        cell: (rowKey, colId) => (colId === 'sku' ? (rowKey === 'parent' ? 'GALE-JACKET' : 'GALE-BLACK-L') : 'x'),
      })
      const out = lines(gridCsvRows(withParent, 'master').csv)
      expect(out).toHaveLength(3)
      expect(out[1]).toContain('GALE-JACKET')
    })

    it('writes an empty field, never the literal "[object Object]", for a structured cell', () => {
      // A readiness verdict has no `valueFormatter`, so AG's `useFormatter` stringifies the object.
      // The adapter maps that to null; this asserts the CSV never shows it.
      const r = gridCsvRows(source({ cell: (_r, c) => (c === 'price' ? '[object Object]' : 'GALE') }), 'master')
      expect(r.csv).not.toContain('[object Object]')
      expect(lines(r.csv)[1]).toBe('GALE,')
    })
  })

  it('writes an empty field for a null, never the string "null"', () => {
    const r = gridCsvRows(source({ cell: () => null }), 'master')
    expect(lines(r.csv)[1]).toBe(',')
  })
})
