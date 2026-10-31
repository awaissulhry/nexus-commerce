import { createElement as h, type ReactNode } from 'react'
import { renderToStaticMarkup as render } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ColDef } from 'ag-grid-community'
import { GridCardList } from './GridCardList'
import { cardFieldsOf, cardSelection, cardSortChoices, cardSortFrom, cardSortValue, cardToggleAll, columnText } from './cardListModel'

/** B-W2b-09 (D3) — the phone card list: the list's own columns, sort and selection as cards. */
interface Order { id: string; number: string; customer: { name: string }; due: string; total: number; status: string }
const ROWS: Order[] = [
  { id: 'o1', number: 'SO-0001', customer: { name: 'Demo Moto' }, due: '2026-11-04', total: 1200, status: 'OPEN' },
  { id: 'o2', number: 'SO-0002', customer: { name: 'Demo Racing' }, due: '2026-11-09', total: 640.5, status: 'SHIPPED' },
]
const Status = ({ data }: { data?: Order }) => h('span', { className: 'pill' }, data?.status === 'OPEN' ? 'Open' : 'Shipped')
const More = ({ data }: { data?: Order }) => h('button', { type: 'button', 'aria-label': `More for ${data?.number}` }, '⋯')
const COLUMNS: ColDef<Order>[] = [
  { colId: 'ag-Grid-SelectionColumn' },
  { colId: 'number', headerName: 'Order', field: 'number' },
  { colId: 'customer', headerName: 'Customer', valueGetter: ({ data }) => data?.customer.name ?? '' },
  { colId: 'total', headerName: 'Total', field: 'total', valueFormatter: ({ value }) => `€${Number(value).toFixed(2)}` },
  { colId: 'status', headerName: 'Status', field: 'status', cellRenderer: Status, sortable: false },
  { colId: 'secret', headerName: 'Hidden', field: 'id', hide: true },
  { colId: 'more', cellRenderer: More, sortable: false },
]
const Link = ({ href, children, ...rest }: { href: string; children?: ReactNode }) => h('a', { href, ...rest }, children)

describe('cardListModel', () => {
  it('draws the card from the columns: the title, fields, the actions; hidden and selection columns left out', () => {
    const fields = cardFieldsOf(COLUMNS)
    expect(fields.map((field) => [field.id, field.role])).toEqual([['number', 'title'], ['customer', 'field'], ['total', 'field'], ['status', 'field'], ['more', 'actions']])
    expect(columnText(COLUMNS[3]!, ROWS[1]!)).toBe('€640.50')
    expect(fields[1]!.text(ROWS[0]!)).toBe('Demo Moto')
    expect(render(h('div', null, fields[3]!.draw(ROWS[0]!)))).toContain('Open')
  })
  it('lets a host place a column elsewhere or leave it off the card', () => {
    const fields = cardFieldsOf(COLUMNS, { customer: { role: 'subtitle' }, total: { role: 'aside', draw: (row) => `${row.total}` }, status: { role: 'hidden' } })
    expect(fields.map((field) => [field.id, field.role])).toEqual([['number', 'title'], ['customer', 'subtitle'], ['total', 'aside'], ['more', 'actions']])
    expect(fields[2]!.draw(ROWS[0]!)).toBe('1200')
  })
  it('never throws on a column it cannot read', () => {
    const bad: ColDef<Order> = { colId: 'x', headerName: 'X', valueGetter: () => { throw new Error('needs the grid') } }
    expect(columnText(bad, ROWS[0]!)).toBe('')
  })
  it('offers the sortable columns up and down, after the list order', () => {
    const choices = cardSortChoices(cardFieldsOf(COLUMNS))
    expect(choices.map((choice) => choice.value)).toEqual(['', 'number:asc', 'number:desc', 'customer:asc', 'customer:desc', 'total:asc', 'total:desc'])
    expect(cardSortFrom('due:date:desc')).toEqual({ colId: 'due:date', dir: 'desc' })
    expect(cardSortFrom('')).toBeNull()
    expect(cardSortValue({ colId: 'total', dir: 'asc' })).toBe('total:asc')
  })
  it('selects every loaded row that may be selected, keeping rows not loaded', () => {
    const why = (row: Order) => (row.status === 'SHIPPED' ? 'Shipped orders cannot be cancelled' : null)
    const sel = cardSelection(ROWS, ['far-away'], (row) => row.id, why)
    expect(sel).toMatchObject({ selectable: ['o1'], all: false, some: false, count: 1 })
    const all = cardToggleAll(sel, ['far-away'])
    expect(all).toEqual(['far-away', 'o1'])
    expect(cardToggleAll(cardSelection(ROWS, all, (row) => row.id, why), all)).toEqual(['far-away'])
  })
})

describe('GridCardList', () => {
  it('draws one card per row with the title link, the fields and the row menu', () => {
    const html = render(h(GridCardList<Order>, { label: 'Orders', rows: ROWS, rowId: (row) => row.id, columns: COLUMNS, hrefOf: (row) => `/sales/orders/${row.id}`, count: '2 of 2', linkAs: Link }))
    expect(html).toContain('href="/sales/orders/o1"')
    expect(html).toContain('<dt>Customer</dt><dd>Demo Moto</dd>')
    expect(html).toContain('€1200.00')
    expect(html).toContain('aria-label="More for SO-0002"')
    expect(html).not.toContain('Hidden')
    expect(html).toContain('2 of 2')
  })
  it('in select mode draws the boxes, the mixed header box words, a held box with its reason, and the bulk actions', () => {
    const html = render(h(GridCardList<Order>, {
      label: 'Orders', rows: ROWS, rowId: (row) => row.id, columns: COLUMNS, selectMode: true, linkAs: Link,
      isRowSelectable: (row) => (row.status === 'SHIPPED' ? 'Shipped orders cannot be cancelled' : null),
      selection: { selected: ['o1'], onChange: () => {}, actions: h('button', { type: 'button' }, 'Cancel 1 order') },
    }))
    expect(html).toContain('aria-label="Select all"')
    expect(html).toContain('1 selected')
    expect(html).toContain('aria-label="Select SO-0001"')
    expect(html).toContain('aria-description="Shipped orders cannot be cancelled"')
    expect(html).toContain('Cancel 1 order')
    expect(html).toContain('Done')
  })
  it('reads with skeletons, draws the list state instead of cards, and a sort control with the words given', () => {
    expect(render(h(GridCardList<Order>, { label: 'Orders', rows: null, rowId: (row) => row.id, columns: COLUMNS, count: '…' }))).toContain('Reading…')
    expect(render(h(GridCardList<Order>, { label: 'Orders', rows: [], rowId: (row) => row.id, columns: COLUMNS, state: h('p', null, 'No orders match these filters') }))).toContain('No orders match these filters')
    const sorted = render(h(GridCardList<Order>, { label: 'Ordini', rows: ROWS, rowId: (row) => row.id, columns: COLUMNS, sort: { colId: 'total', dir: 'desc' }, onSortChange: () => {}, labels: { sortBy: 'Ordina per', listOrder: 'Ordine della lista' } }))
    expect(sorted).toContain('aria-label="Ordina per"')
    expect(sorted).toContain('Ordine della lista')
    expect(sorted).toMatch(/<option value="total:desc" selected="">Total ↓<\/option>/)
  })
})
