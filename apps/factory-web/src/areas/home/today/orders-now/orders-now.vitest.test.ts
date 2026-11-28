import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CONFIRMED_ROW, PRODUCTION_ROW, TILES, readRow } from '../../../sales/orders/list/office-sheet/fixtures'
import { lastChangedOf, piecesByDepartmentOf, rowHrefOf, sheetHrefOf, todayTilesOf } from './model'

describe('owb-of4 step 2 — Today’s six tiles are the Orders sheet’s, each a door to the sheet’s filter', () => {
  it('each tile’s door = the sheet filter id (the same six as the sheet, the same counts)', () => {
    const tiles = todayTilesOf(TILES, '/w/demo')
    expect(tiles.map((tile) => [tile.id, tile.count, tile.href])).toEqual([
      ['incoming', 3, '/w/demo/sales/orders?life=incoming'],
      ['waitingForPrint', 2, '/w/demo/sales/orders?life=confirmed'],
      ['inProduction', 7, '/w/demo/sales/orders?life=production'],
      ['problems', 1, '/w/demo/sales/orders?life=production'],
      ['late', 4, '/w/demo/sales/orders?life=production'],
      ['readyToShip', 5, '/w/demo/sales/orders?life=ready'],
    ])
    expect(sheetHrefOf('/w/demo', 'all')).toBe('/w/demo/sales/orders')
  })

  it('"The factory now": pieces of the orders in production by department (their stage); none in production → null, never a made-up number', () => {
    const rows = [PRODUCTION_ROW, readRow({ id: 'order-3', life: 'IN_PRODUCTION', where: { stage: 'SEWING', health: null, held: false }, pieces: 4 }), readRow({ id: 'order-4', life: 'IN_PRODUCTION', where: { stage: 'CUTTING', health: null, held: false }, pieces: 10 }), CONFIRMED_ROW]
    expect([...(piecesByDepartmentOf(rows) ?? new Map())]).toEqual([
      [4, PRODUCTION_ROW.pieces + 4],
      [2, 10],
    ])
    expect(piecesByDepartmentOf([CONFIRMED_ROW])).toBeNull()
  })

  it('"Last changes": the orders changed last, the read’s own order, five at most; each a door to its page', () => {
    const rows = Array.from({ length: 7 }, (_, index) => readRow({ id: `order-${index}` }))
    expect(lastChangedOf(rows).map((row) => row.id)).toEqual(['order-0', 'order-1', 'order-2', 'order-3', 'order-4'])
    expect(rowHrefOf('/w/demo', { kind: 'REQUEST', id: 'r 1' })).toBe('/w/demo/sales/orders/new?draft=r%201')
    expect(rowHrefOf('/w/demo', { kind: 'ORDER', id: 'o1' })).toBe('/w/demo/sales/orders/o1')
  })

  it('Today shows the orders part only to a reader of every order (the designer’s orders.view.own has none)', () => {
    const today = readFileSync(new URL('../Today.tsx', import.meta.url), 'utf8')
    expect(today).toContain("permissions.has('orders.view') ? <OrdersNow />")
  })
})
