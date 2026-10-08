import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { buildMatrixColumns, STOCK_COL, STOCK_EDIT_COPY } from './columns'
import type { MatrixRowRead } from './contract'

/**
 * The Stock column's door (Owner 2026-10-07, Matrix inventory step 1): the cell opens the Products page's inventory
 * editor — stock per location — for its row. No door in preview or without the right to adjust stock.
 */
const ROWS: Record<string, MatrixRowRead> = {
  v1: { id: 'v1', sku: 'V1', role: 'variant', stock: { available: 13, uncounted: false, locations: [{ code: 'IT-MAIN', available: 13 }] }, basePrice: 10, status: 'ACTIVE', cells: {} },
  v2: { id: 'v2', sku: 'V2', role: 'variant', stock: { available: null, uncounted: true, locations: [] }, basePrice: 10, status: 'ACTIVE', cells: {} },
}

type Def = Record<string, unknown>
function stockDef(onOpenStock?: (rowId: string) => void): Def {
  const defs = buildMatrixColumns({
    coordinates: [], cellsOf: () => null, rowOf: (id: string) => ROWS[id] ?? null, tracker: null, sheetColumns: [], locale: 'it', market: 'IT',
    axesRef: { current: [] }, rowMenuRef: { current: () => [] }, onPickFulfilment: () => undefined, rowsRef: { current: [] },
    onOpenStock,
  } as never) as Def[]
  return (defs.find((g) => g.groupId === 'grp-shared')!.children as Def[]).find((d) => d.colId === STOCK_COL)!
}
const render = (d: Def, id: string) => {
  const params = { ...(d.cellRendererParams as object), data: { id }, node: { rowIndex: 0 }, api: {}, column: { getColId: () => STOCK_COL } }
  return renderToStaticMarkup(createElement(d.cellRenderer as never, params as never))
}

describe('the Stock column opens the stock per location', () => {
  it('draws the cell action beside the number when the page gives a door', () => {
    const html = render(stockDef(() => undefined), 'v1')
    expect(html.match(/data-nds-cell-action/g)?.length).toBe(1)
    expect(html).toContain(`aria-label="${STOCK_EDIT_COPY.label}"`)
    expect(html).toContain('>13<')
  })

  it('an uncounted SKU keeps its door (that is where it gets counted)', () => {
    expect(render(stockDef(() => undefined), 'v2')).toContain('data-nds-cell-action')
  })

  it('no door (preview, or no right to adjust stock): the number alone, no action', () => {
    const html = render(stockDef(undefined), 'v1')
    expect(html).not.toContain('data-nds-cell-action')
    expect(html).toContain('>13<')
  })

  it('the action reveals on hover and a click on it never reaches the grid', () => {
    const d = stockDef(() => undefined)
    expect(d.cellClass).toContain('nds-reveal-row')
    const suppress = (d.cellRendererParams as { suppressMouseEventHandling: (p: { event: { target: unknown } }) => boolean }).suppressMouseEventHandling
    expect(typeof suppress).toBe('function')
  })
})
