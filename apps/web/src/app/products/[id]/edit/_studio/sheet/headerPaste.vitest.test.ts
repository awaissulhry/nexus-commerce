import { describe, expect, it, vi } from 'vitest'
import { createHeaderPaste, headerPasteNote, HEADER_PASTE_COPY, pasteTargets, planHeaderPaste, type HeaderPasteColumn } from './headerPaste'

/**
 * Wave 2 E14 — paste with a header row. A block whose first row names columns lands by NAME; the header row is never
 * written; a column the header does not name is SKIPPED (never written back: on a channel scope a write pins the cell,
 * and a list or measure cell does not round-trip through text).
 */
const COLUMNS: HeaderPasteColumn[] = [
  { colId: 'title', headerName: 'Title *' },
  { colId: 'bullets', headerName: 'Bullet points' },
  { colId: 'color', headerName: 'Colour' },
  { colId: 'size', headerName: 'Size' },
  { colId: 'material', headerName: 'Material' },
]
const ALL = COLUMNS.map((c) => c.colId!)

const col = (id: string) => ({ getColId: () => id })
function fakeApi(o: { focused?: string | null; range?: { columns: string[]; startRow: number; endRow: number } | null; columns?: string[] }) {
  return {
    getAllDisplayedColumns: () => (o.columns ?? ALL).map(col),
    getFocusedCell: () => (o.focused ? { column: col(o.focused), rowIndex: 0, rowPinned: null } : null),
    getCellRanges: () => (o.range ? [{ columns: o.range.columns.map(col), startRow: { rowIndex: o.range.startRow }, endRow: { rowIndex: o.range.endRow } }] : null),
  } as never
}

/**
 * AG's own paste from a focused cell (`pasteMultipleValues` + `updateCellValue`, ag-grid-enterprise 36.1): the block is
 * applied by POSITION from the focused column; a column whose `suppressPaste` answers true is skipped but still uses its
 * slot. Returns every write AG would make.
 */
function agPaste(props: ReturnType<typeof createHeaderPaste>, focused: string, clipboard: string[][]) {
  const api = fakeApi({ focused })
  const block = props.processDataFromClipboard({ data: clipboard, api, context: undefined } as never)
  const writes: Array<{ row: number; colId: string; value: string }> = []
  if (!block) return { block, writes }
  const into = ALL.slice(ALL.indexOf(focused))
  const suppress = props.defaultColDef.suppressPaste as (p: unknown) => boolean
  block.forEach((row, r) => row.forEach((value, j) => {
    const colId = into[j]
    if (!colId || suppress({ column: col(colId) })) return
    writes.push({ row: r, colId, value })
  }))
  return { block, writes }
}

describe('planHeaderPaste — where a block with a header row lands', () => {
  it('re-orders by name, drops the header row, and names the header cells that land nowhere', () => {
    const plan = planHeaderPaste([['Size', 'SKU', 'Colour'], ['M', 'A-1', 'Black'], ['L', 'A-2', 'Red']], COLUMNS, ALL)!
    expect(plan.rows).toEqual([['', '', 'Black', 'M', ''], ['', '', 'Red', 'L', '']])
    expect([...plan.named]).toEqual(['color', 'size'])
    expect(plan.notPasted).toEqual(['SKU'])
  })

  it('drops a trailing " *" on both sides — a header copied from the Shared sheet, and a plain one from Excel', () => {
    const shared = planHeaderPaste([['Title *', 'Size'], ['Jacket', 'M']], [{ colId: 'title', headerName: 'Title' }, { colId: 'size', headerName: 'Size' }], ['title', 'size'])!
    expect(shared.rows).toEqual([['Jacket', 'M']])
    const excel = planHeaderPaste([['  Title ', 'Size'], ['Jacket', 'M']], COLUMNS, ALL)!
    expect([...excel.named]).toEqual(['title', 'size'])
    expect(excel.notPasted).toEqual([])
  })

  it('is not a header when fewer than two names match, or there is one row — the block pastes as it is', () => {
    expect(planHeaderPaste([['M', 'Black'], ['L', 'Red']], COLUMNS, ALL)).toBeNull()
    expect(planHeaderPaste([['Size', 'x'], ['M', 'y']], COLUMNS, ALL)).toBeNull()
    expect(planHeaderPaste([['Size', 'Colour']], COLUMNS, ALL)).toBeNull()
  })

  it('a named column LEFT of the selected cell is not pasted, and is named', () => {
    const plan = planHeaderPaste([['Title', 'Size', 'Colour'], ['Jacket', 'M', 'Black']], COLUMNS, ALL.slice(2))!
    expect(plan.rows).toEqual([['Black', 'M', '']])
    expect([...plan.named]).toEqual(['color', 'size'])
    expect(plan.notPasted).toEqual(['Title'])
  })

  it('a name two columns share (one field, two languages) matches neither; the column id still does', () => {
    const langs: HeaderPasteColumn[] = [{ colId: 'title@it', headerName: 'Title' }, { colId: 'title@en', headerName: 'Title' }, { colId: 'size', headerName: 'Size' }]
    const byName = planHeaderPaste([['Title', 'Size', 'Italian'], ['Giacca', 'M', 'x']], langs, ['title@it', 'title@en', 'size'])!
    expect([...byName.named]).toEqual(['size'])
    expect(byName.notPasted).toEqual(['Title', 'Italian'])
    const byId = planHeaderPaste([['title@en', 'Size'], ['Jacket', 'M']], langs, ['title@it', 'title@en', 'size'])!
    expect(byId.rows).toEqual([['', 'Jacket', 'M']])
  })

  // W3-6 — the sheet's naming table renamed columns ("Name" is "Title"); a file exported before still lands.
  it('a header a column had before lands on it: an old "Name" header on Title', () => {
    const sheet: HeaderPasteColumn[] = [{ colId: 'name', headerName: 'Title *' }, { colId: 'size', headerName: 'Size' }, { colId: 'basePrice', headerName: 'Price' }]
    const plan = planHeaderPaste([['Name', 'Size', 'Base price'], ['Giacca', 'M', '99']], sheet, ['name', 'size', 'basePrice'])!
    expect(plan.rows).toEqual([['Giacca', 'M', '99']])
    expect([...plan.named]).toEqual(['name', 'size', 'basePrice'])
    expect(plan.notPasted).toEqual([])
  })

  // W3-3 — a dictionary field now named in English keeps the header its content language gave it.
  it('an old Italian header lands on the English-named dictionary field ("Colore" on Color), and one two columns had on neither', () => {
    const sheet: HeaderPasteColumn[] = [{ colId: 'color', headerName: 'Color', formerNames: ['Colore'] }, { colId: 'size', headerName: 'Size', formerNames: ['Taglia'] }, { colId: 'fit', headerName: 'Fit' }]
    const plan = planHeaderPaste([['Colore', 'Taglia', 'Fit'], ['Nero', 'M', 'Slim']], sheet, ['color', 'size', 'fit'])!
    expect([...plan.named]).toEqual(['color', 'size', 'fit'])
    expect(plan.rows).toEqual([['Nero', 'M', 'Slim']])
    const shared: HeaderPasteColumn[] = [{ colId: 'color', headerName: 'Color', formerNames: ['Colore'] }, { colId: 'colour_name', headerName: 'Colour name', formerNames: ['Colore'] }, { colId: 'size', headerName: 'Size' }, { colId: 'fit', headerName: 'Fit' }]
    const ambiguous = planHeaderPaste([['Colore', 'Size', 'Fit'], ['Nero', 'M', 'Slim']], shared, ['color', 'colour_name', 'size', 'fit'])!
    expect([...ambiguous.named]).toEqual(['size', 'fit'])
    expect(ambiguous.notPasted).toEqual(['Colore'])
  })

  it('a current name wins over a former one, and a former name two columns had lands on neither', () => {
    // eBay: "Quantity" was the old name of Unit quantity (`quantita`) — and is another column's current name here.
    const current: HeaderPasteColumn[] = [{ colId: 'quantita', headerName: 'Unit quantity' }, { colId: 'other', headerName: 'Quantity' }, { colId: 'size', headerName: 'Size' }]
    expect([...planHeaderPaste([['Quantity', 'Size'], ['2', 'M']], current, ['quantita', 'other', 'size'])!.named]).toEqual(['other', 'size'])
    // Shopify's stock and eBay's/Etsy's were both "Available quantity" once (`availableQuantity`, `quantity`): neither is guessed.
    const both: HeaderPasteColumn[] = [{ colId: 'availableQuantity', headerName: 'Available' }, { colId: 'quantity', headerName: 'Qty' }, { colId: 'size', headerName: 'Size' }]
    const plan = planHeaderPaste([['Available quantity', 'Size', 'Qty'], ['2', 'M', '3']], both, ['availableQuantity', 'quantity', 'size'])!
    expect([...plan.named]).toEqual(['quantity', 'size'])
    expect(plan.notPasted).toEqual(['Available quantity'])
  })
})

describe('the note after a header paste', () => {
  it('says what was not pasted, in the words of the plan', () => {
    expect(headerPasteNote({ named: new Set(['size']), notPasted: ['Italian', 'SKU'] }))
      .toBe('Pasted by column name. Not pasted: Italian, SKU. No matching column to the right of the selected cell.')
    expect(headerPasteNote({ named: new Set(['size']), notPasted: [] })).toBe(HEADER_PASTE_COPY.pasted)
  })
  it('does not claim a paste when nothing landed', () => {
    expect(headerPasteNote({ named: new Set(), notPasted: ['Title', 'Size'] }))
      .toBe('Not pasted: Title, Size. No matching column to the right of the selected cell.')
  })
})

describe('createHeaderPaste — the grid props both sheet scopes use', () => {
  const setup = () => {
    const announce = vi.fn()
    const queued: Array<() => void> = []
    const props = createHeaderPaste({ columns: () => COLUMNS, announce }, (run) => { queued.push(run) })
    return { props, announce, flush: () => queued.splice(0).forEach((run) => run()) }
  }

  it('writes ONLY the named columns: the header row is not data, and every other cell is skipped, not rewritten', () => {
    const { props, flush } = setup()
    const { writes } = agPaste(props, 'title', [['Colour', 'Size', 'SKU'], ['Black', 'M', 'A-1'], ['Red', 'L', 'A-2']])
    expect(writes).toEqual([
      { row: 0, colId: 'color', value: 'Black' }, { row: 0, colId: 'size', value: 'M' },
      { row: 1, colId: 'color', value: 'Red' }, { row: 1, colId: 'size', value: 'L' },
    ])
    // `title`, `bullets` (a list cell) and `material` are never written — not even with their own value.
    expect(writes.some((w) => ['title', 'bullets', 'material'].includes(w.colId))).toBe(false)
    expect(writes.some((w) => w.value === 'Colour' || w.value === 'Size')).toBe(false)
    flush()
  })

  it('the skip lasts for that one paste: cleared after it, then the note is said', () => {
    const { props, announce, flush } = setup()
    const suppress = props.defaultColDef.suppressPaste as (p: unknown) => boolean
    agPaste(props, 'title', [['Colour', 'SKU', 'Size'], ['Black', 'A-1', 'M']])
    expect(suppress({ column: col('title') })).toBe(true)
    expect(suppress({ column: col('color') })).toBe(false)
    expect(announce).not.toHaveBeenCalled()
    flush()
    expect(suppress({ column: col('title') })).toBe(false)
    expect(announce).toHaveBeenCalledWith('Pasted by column name. Not pasted: SKU. No matching column to the right of the selected cell.', 'warning')
  })

  it('a block with no header pastes as it is, with no skip and no note', () => {
    const { props, announce, flush } = setup()
    const data = [['M', 'Black'], ['L', 'Red']]
    const { block, writes } = agPaste(props, 'size', data)
    expect(block).toBe(data)
    expect(writes).toEqual([
      { row: 0, colId: 'size', value: 'M' }, { row: 0, colId: 'material', value: 'Black' },
      { row: 1, colId: 'size', value: 'L' }, { row: 1, colId: 'material', value: 'Red' },
    ])
    flush()
    expect(announce).not.toHaveBeenCalled()
  })

  it('pastes NOTHING when no named column is to the right of the selected cell (never the block by position)', () => {
    const { props, announce, flush } = setup()
    const { block, writes } = agPaste(props, 'material', [['Title', 'Colour'], ['Jacket', 'Black']])
    expect(block).toBeNull()
    expect(writes).toEqual([])
    flush()
    expect(announce).toHaveBeenCalledWith('Not pasted: Title, Colour. No matching column to the right of the selected cell.', 'warning')
  })

  it('a clean header paste says so as information', () => {
    const { props, announce, flush } = setup()
    agPaste(props, 'title', [['Size', 'Colour'], ['M', 'Black']])
    flush()
    expect(announce).toHaveBeenCalledWith('Pasted by column name.', 'info')
  })
})

describe('pasteTargets — where AG starts the paste', () => {
  it('from the focused cell', () => {
    expect(pasteTargets(fakeApi({ focused: 'size' }))).toEqual(['size', 'material'])
  })
  it('from the LEFT edge of a selection of more than one cell, wherever the focus is (AG pastes into the selection)', () => {
    expect(pasteTargets(fakeApi({ focused: 'size', range: { columns: ['color', 'size'], startRow: 0, endRow: 0 } }))).toEqual(['color', 'size', 'material'])
    // A one-cell range is the focused cell.
    expect(pasteTargets(fakeApi({ focused: 'size', range: { columns: ['size'], startRow: 2, endRow: 2 } }))).toEqual(['size', 'material'])
  })
  it('skips AG’s selection column at the start, as AG does', () => {
    expect(pasteTargets(fakeApi({ focused: 'ag-Grid-SelectionColumn', columns: ['ag-Grid-SelectionColumn', ...ALL] }))).toEqual(ALL)
  })
})
