/**
 * Keyword Harvest audit M1 (2026-10-11): every Export wrote the header and then rows of bare commas. `opts.valueOf` on an
 * options object that does not set it is `Object.prototype.valueOf`, so every cell became the options object and was
 * blanked. Reads one cell back through the real source, with and without a caller's own `valueOf`.
 */
import { describe, expect, it } from 'vitest'
import type { GridApi } from 'ag-grid-community'

import { gridCsvRows, gridCsvSourceFromApi } from './exportGrid'

interface Row { id: string; term: string; cents: number }
const ROWS: Row[] = [{ id: 'a', term: 'rain jacket', cents: 1250 }, { id: 'b', term: 'jacket men', cents: 40 }]
const col = (id: string, headerName: string) => ({ getColId: () => id, getColDef: () => ({ headerName }) })
const fakeApi = () => ({
  getAllDisplayedColumns: () => [col('ag-Grid-SelectionColumn', ''), col('term', 'Search term'), col('spend', 'Spend')],
  forEachNodeAfterFilterAndSort: (cb: (n: unknown, i: number) => void) => ROWS.forEach((data, i) => cb({ id: data.id, data }, i)),
  getGridOption: () => 'clientSide',
  isAnyFilterPresent: () => false,
  // The grid's own rendering: the formatter's text.
  getCellValue: ({ rowNode, colKey }: { rowNode: { data: Row }; colKey: string }) =>
    colKey === 'term' ? rowNode.data.term : colKey === 'spend' ? `${(rowNode.data.cents / 100).toFixed(1)} €` : null,
}) as unknown as GridApi<Row>

describe('gridCsvSourceFromApi — cells (M1)', () => {
  it('without a valueOf, every cell is the grid\'s own text (it was blank)', () => {
    for (const opts of [undefined, {}, { suffix: 'x' }]) {
      const out = gridCsvRows(gridCsvSourceFromApi(fakeApi(), opts), 'terms')
      expect(out.csv.split('\r\n')).toEqual(['Search term,Spend', 'rain jacket,12.5 €', 'jacket men,0.4 €'])
    }
  })

  it('a caller\'s own valueOf still decides its columns; undefined falls back to the grid\'s text', () => {
    const src = gridCsvSourceFromApi(fakeApi(), { valueOf: (colId, row) => (colId === 'spend' ? row.cents : undefined) })
    expect(gridCsvRows(src, 'terms').csv.split('\r\n')[1]).toBe('rain jacket,1250')
  })
})

describe('gridCsvRows — a column that carries nothing (M1)', () => {
  const base = { rowModelType: 'clientSide', narrowed: false, rows: [{ key: 'a', isData: true }] }
  it('drops a column with no header, no key and no value (the row-verbs column)', () => {
    const out = gridCsvRows({ ...base, columns: [{ colId: 'term', header: 'Search term' }, { colId: 'actions', header: '' }], cell: (_r, c) => (c === 'term' ? 'rain jacket' : null) }, 't')
    expect(out.csv).toBe('Search term\r\nrain jacket')
    expect(out.columns).toBe(1)
  })
  it('keeps a named column even when every cell is empty, and a header-less one that holds a value', () => {
    const out = gridCsvRows({ ...base, columns: [{ colId: 'note', header: 'Note' }, { colId: 'x', header: '' }], cell: (_r, c) => (c === 'x' ? 'v' : null) }, 't')
    expect(out.csv).toBe('Note,\r\n,v')
  })
})
