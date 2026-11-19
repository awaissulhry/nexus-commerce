import { describe, expect, it } from 'vitest'
import { applyRouteOf, chargeFeeOf, CHANGE_WORDS, changedSince, declineProblem, extraOf, planChanges, takesEveryCell, type WantedLine, type WorkCell } from './rules'

/** B-SA-041: the gap between an order and its work orders, as WorkOrderChange records (R1, P6'). */

const LINE = '00000000-0000-4000-8000-000000000001'
const cell = (over: Partial<WorkCell>): WorkCell => ({
  workOrderId: 'wo-1',
  number: 'WO-0001',
  status: 'RELEASED',
  kind: 'SIZE_GRID',
  styleId: 'style-1',
  siteId: 'site-1',
  cellId: 'cell-1',
  salesOrderLineId: LINE,
  size: 'M',
  quantity: 40,
  cut: 0,
  ...over,
})
const wanted = (sizes: Record<string, number>, over: Partial<WantedLine> = {}): WantedLine => ({ lineId: LINE, styleId: 'style-1', siteId: null, madeToMeasure: false, sizes: new Map(Object.entries(sizes)), ...over })

describe('the changes an accepted change asks of the work orders (B-SA-041)', () => {
  it('lowers a DRAFT and a released work order alike: one change per work order, never below cut, the rest extra pieces', () => {
    expect(planChanges([wanted({ M: 36 })], [cell({ status: 'DRAFT' })])).toEqual([
      { kind: 'LOWER_TO_ORDER', workOrderId: 'wo-1', number: 'WO-0001', styleId: 'style-1', siteId: 'site-1', cells: [{ salesOrderLineId: LINE, size: 'M', from: 40, to: 36, workOrderSizeId: 'cell-1' }], extra: [] },
    ])
    // In progress, 38 cut: the cell is lowered to 36 in the change; Lower to the order keeps it at 38 — 2 extra pieces.
    const [cutOver] = planChanges([wanted({ M: 36 })], [cell({ status: 'IN_PROGRESS', cut: 38 })])
    expect(cutOver).toMatchObject({ kind: 'LOWER_TO_ORDER', cells: [{ from: 40, to: 36 }], extra: [{ workOrderSizeId: 'cell-1', salesOrderLineId: LINE, size: 'M', count: 2 }] })
    expect(extraOf([cutOver!])).toEqual([{ workOrderSizeId: 'cell-1', salesOrderLineId: LINE, size: 'M', count: 2 }])
  })

  it('takes a decrease where nothing is cut first: a DRAFT, then the work order with the most left uncut', () => {
    const changes = planChanges([wanted({ M: 30 })], [cell({ workOrderId: 'wo-1', number: 'WO-0001', cellId: 'a', quantity: 20, cut: 20 }), cell({ workOrderId: 'wo-2', number: 'WO-0002', cellId: 'b', quantity: 20, cut: 5, status: 'IN_PROGRESS' })])
    expect(changes).toEqual([expect.objectContaining({ workOrderId: 'wo-2', cells: [{ salesOrderLineId: LINE, size: 'M', from: 20, to: 10, workOrderSizeId: 'b' }], extra: [] })])
  })

  it('makes more in an open DRAFT of the line (its cell, else a new cell), else in a new DRAFT; never for a released one', () => {
    expect(planChanges([wanted({ M: 44 })], [cell({ status: 'DRAFT' })])[0]).toMatchObject({ kind: 'MAKE_MORE', workOrderId: 'wo-1', cells: [{ from: 40, to: 44, workOrderSizeId: 'cell-1' }] })
    expect(planChanges([wanted({ M: 40, L: 4 })], [cell({ status: 'DRAFT' })])[0]).toMatchObject({ kind: 'MAKE_MORE', workOrderId: 'wo-1', cells: [{ size: 'L', from: 0, to: 4, workOrderSizeId: null }] })
    expect(planChanges([wanted({ M: 44 })], [cell({ status: 'RELEASED' })])[0]).toMatchObject({ kind: 'MAKE_MORE', workOrderId: null, number: null, styleId: 'style-1', cells: [{ size: 'M', from: 0, to: 4, workOrderSizeId: null }] })
    // What is cancelled makes nothing; what is completed counts as made and is never changed.
    expect(planChanges([wanted({ M: 40 })], [cell({ status: 'CANCELLED' })])[0]).toMatchObject({ kind: 'MAKE_MORE', cells: [{ from: 0, to: 40 }] })
    expect(planChanges([wanted({ M: 30 })], [cell({ status: 'COMPLETED' })])).toEqual([])
    // B-SA-042: a change raises by what it added, never the rest of a line not yet in work orders.
    expect(planChanges([wanted({ M: 44 })], [cell({ status: 'DRAFT', quantity: 20 })], new Map([[`${LINE}|M`, 4]]))[0]).toMatchObject({ cells: [{ from: 20, to: 24 }] })
    expect(planChanges([wanted({ M: 44 })], [cell({ status: 'DRAFT', quantity: 20 })], new Map())).toEqual([])
  })

  it('cancels a made-to-measure unit, never raises one; a cut unit is an extra piece', () => {
    const unit = cell({ kind: 'MADE_TO_MEASURE', quantity: 1, size: '52' })
    expect(planChanges([wanted({ '52': 0 }, { madeToMeasure: true })], [unit])[0]).toMatchObject({ kind: 'LOWER_TO_ORDER', cells: [{ from: 1, to: 0 }], extra: [] })
    expect(planChanges([wanted({ '52': 0 }, { madeToMeasure: true })], [{ ...unit, cut: 1 }])[0]).toMatchObject({ extra: [{ count: 1 }] })
    expect(planChanges([wanted({ '52': 2 }, { madeToMeasure: true })], [unit])).toEqual([])
  })

  it('routes the apply by the work order as it is now', () => {
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'DRAFT', kind: 'SIZE_GRID' })).toEqual({ route: 'SET_DRAFT_CELLS' })
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'RELEASED', kind: 'SIZE_GRID' })).toEqual({ route: 'LOWER_RELEASED' })
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'IN_PROGRESS', kind: 'SIZE_GRID' })).toEqual({ route: 'LOWER_RELEASED' })
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'RELEASED', kind: 'MADE_TO_MEASURE' })).toEqual({ route: 'CANCEL_WORK_ORDER' })
    // B-SA-042: every cell to 0 (a whole order or line cancelled) cancels the work order.
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'RELEASED', kind: 'SIZE_GRID' }, true)).toEqual({ route: 'CANCEL_WORK_ORDER' })
    expect(takesEveryCell([{ salesOrderLineId: LINE, size: 'M', from: 4, to: 0, workOrderSizeId: 'a' }], ['a'])).toBe(true)
    expect(takesEveryCell([{ salesOrderLineId: LINE, size: 'M', from: 4, to: 0, workOrderSizeId: 'a' }], ['a', 'b'])).toBe(false)
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'ON_HOLD', kind: 'SIZE_GRID' })).toEqual({ refusal: 'ON_HOLD' })
    expect(applyRouteOf({ kind: 'LOWER_TO_ORDER', workOrderId: 'w' }, { status: 'COMPLETED', kind: 'SIZE_GRID' })).toEqual({ refusal: 'WORK_ORDER_DONE' })
    expect(applyRouteOf({ kind: 'MAKE_MORE', workOrderId: 'w' }, { status: 'RELEASED', kind: 'SIZE_GRID' })).toEqual({ refusal: 'NOT_A_DRAFT' })
    expect(applyRouteOf({ kind: 'MAKE_MORE', workOrderId: null }, null)).toEqual({ route: 'NEW_DRAFT' })
  })

  it('knows a change proposed on another figure, and asks words to leave one as is', () => {
    const cells = [{ salesOrderLineId: LINE, size: 'M', from: 40, to: 36, workOrderSizeId: 'cell-1' }]
    expect(changedSince(cells, new Map([['cell-1', 40]]), new Map())).toEqual([])
    expect(changedSince(cells, new Map([['cell-1', 38]]), new Map())).toEqual(cells)
    expect(declineProblem('  ')).toBe('Say why it is left as is.')
    expect(declineProblem('x'.repeat(301))).toBe('At most 300 characters.')
    expect(declineProblem('The customer takes them as they are')).toBeNull()
    expect(CHANGE_WORDS.changedSince('WO-0042')).toEqual({ en: 'WO-0042 changed since — propose again', it: 'WO-0042 è cambiato nel frattempo: proponi di nuovo' })
    expect(CHANGE_WORDS.extra(2, 'M')).toEqual({ en: 'Extra pieces: 2 M already cut', it: 'Pezzi in più: 2 M già tagliati' })
    expect(CHANGE_WORDS.chooseExtra(2)).toEqual({ en: 'Choose what happens to the 2 extra pieces', it: 'Scegli cosa fare dei 2 pezzi in più' })
    // op-fx3: one extra piece is said in the singular, never "the 1 extra pieces" / "dei 1 pezzi in più".
    expect(CHANGE_WORDS.chooseExtra(1)).toEqual({ en: 'Choose what happens to the 1 extra piece', it: 'Scegli cosa fare del 1 pezzo in più' })
  })

  it('charges the customer for its extra pieces at their sizes\' prices (B-SA-042, CHARGE)', () => {
    const prices = [{ lineId: LINE, size: 'M', unitPrice: '100.005000' }, { lineId: LINE, size: 'L', unitPrice: '0' }]
    expect(chargeFeeOf([{ salesOrderLineId: LINE, size: 'M', count: 2 }], prices)).toBe('200.01')
    expect(chargeFeeOf([{ salesOrderLineId: LINE, size: 'L', count: 3 }], prices)).toBeNull()
    expect(chargeFeeOf([], prices)).toBeNull()
  })
})
