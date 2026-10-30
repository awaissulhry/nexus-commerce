import { describe, expect, it } from 'vitest'
import {
  availabilityOf,
  consumption,
  giveBack,
  issueConflict,
  kindFor,
  openOf,
  releaseReasonProblem,
  releaseRefusal,
  reserveRefusals,
  type HeldReservation,
  type ReserveRequest,
  type StockPart,
} from './rules'

// Made-up stock of one black leather at one site: lot L1 released (hides H1 50, H2 40), lot L2 in quarantine (H3 30).
const STOCK: StockPart[] = [
  { lotId: 'L1', hideId: 'H1', onHand: '50.0000', held: false },
  { lotId: 'L1', hideId: 'H2', onHand: '40.0000', held: false },
  { lotId: 'L2', hideId: 'H3', onHand: '30.0000', held: true },
]

const reservation = (over: Partial<HeldReservation> & { id: string }): HeldReservation => ({
  kind: 'AREA',
  lotId: null,
  hideId: null,
  quantity: '10.0000',
  issuedQuantity: '0.0000',
  workOrderId: 'WO-A',
  salesOrderLineId: null,
  demandOpen: true,
  ...over,
})

const request = (over: Partial<ReserveRequest> & { index: number }): ReserveRequest => ({
  kind: 'AREA',
  lotId: null,
  hideId: null,
  baseQuantity: '10.0000',
  label: 'TEST-LEATHER BLK',
  lotCode: null,
  lotHeld: false,
  hideCode: null,
  baseUom: 'FT2',
  ...over,
})

const holder = (row: HeldReservation) => (row.workOrderId ? `work order ${row.workOrderId}` : 'an order line')

describe('kinds and open quantities', () => {
  it('reserves leather by area or hide, anything else by quantity', () => {
    expect(kindFor('HIDE', false)).toBe('AREA')
    expect(kindFor('HIDE', true)).toBe('HIDE')
    expect(kindFor('LOT', false)).toBe('QUANTITY')
    expect(kindFor('NONE', false)).toBe('QUANTITY')
    expect(kindFor('LOT', true)).toBeNull()
  })

  it('holds what is not issued yet, never below 0', () => {
    expect(openOf({ quantity: '10', issuedQuantity: '3.5' }).toFixed(4)).toBe('6.5000')
    expect(openOf({ quantity: '10', issuedQuantity: '10' }).toFixed(4)).toBe('0.0000')
  })
})

describe('available = on hand − held − reserved', () => {
  it('for the item and colour, and for one lot', () => {
    const held = [reservation({ id: 'R1', quantity: '20' }), reservation({ id: 'R2', lotId: 'L1', quantity: '15', issuedQuantity: '5' })]
    const whole = availabilityOf(STOCK, held)
    expect([whole.onHand, whole.held, whole.reserved, whole.available].map((value) => value.toFixed(4))).toEqual(['120.0000', '30.0000', '30.0000', '60.0000'])
    const lot = availabilityOf(STOCK, held, { lotId: 'L1' })
    expect([lot.onHand, lot.reserved, lot.available].map((value) => value.toFixed(4))).toEqual(['90.0000', '10.0000', '80.0000'])
  })

  it('counts nothing for a done demand, and says when a key is over-reserved', () => {
    expect(availabilityOf(STOCK, [reservation({ id: 'R1', quantity: '500', demandOpen: false })]).reserved.toFixed(4)).toBe('0.0000')
    const over = availabilityOf(STOCK, [reservation({ id: 'R1', quantity: '100' })])
    expect(over.available.toFixed(4)).toBe('-10.0000')
    expect(over.overReserved).toBe(true)
  })
})

describe('reserving', () => {
  it('gives what is available, line after line, and refuses the rest in words', () => {
    const refusals = reserveRefusals(STOCK, [reservation({ id: 'R1', quantity: '40' })], [request({ index: 0, baseQuantity: '30' }), request({ index: 1, baseQuantity: '30' })], holder)
    expect(refusals).toEqual([{ index: 1, code: 'NOT_AVAILABLE', message: expect.stringMatching(/20\.0000 FT2 available .* 30\.0000 FT2 asked/) }])
  })

  it('checks the lot too: any-lot reservations do not free a lot that others hold', () => {
    const refusals = reserveRefusals(STOCK, [reservation({ id: 'R1', lotId: 'L1', quantity: '80' })], [request({ index: 0, lotId: 'L1', lotCode: 'LOT-1', baseQuantity: '20' })], holder)
    expect(refusals).toMatchObject([{ index: 0, code: 'NOT_AVAILABLE' }])
    const fits = reserveRefusals(STOCK, [reservation({ id: 'R1', quantity: '10' })], [request({ index: 0, lotId: 'L1', lotCode: 'LOT-1', baseQuantity: '80' })], holder)
    expect(fits).toEqual([])
  })

  it('refuses a hide another reservation holds, a hide not in stock and held stock', () => {
    const held = [reservation({ id: 'R1', kind: 'HIDE', lotId: 'L1', hideId: 'H1', quantity: '50' })]
    const refusals = reserveRefusals(
      STOCK,
      held,
      [
        request({ index: 0, kind: 'HIDE', lotId: 'L1', hideId: 'H1', hideCode: 'HD-1', baseQuantity: '50' }),
        request({ index: 1, kind: 'HIDE', lotId: 'L1', hideId: 'H9', hideCode: 'HD-9', baseQuantity: '0' }),
        request({ index: 2, kind: 'HIDE', lotId: 'L2', hideId: 'H3', hideCode: 'HD-3', lotCode: 'LOT-2', lotHeld: true, baseQuantity: '30' }),
        request({ index: 3, kind: 'HIDE', lotId: 'L1', hideId: 'H2', hideCode: 'HD-2', baseQuantity: '40' }),
      ],
      holder,
    )
    expect(refusals.map((refusal) => [refusal.index, refusal.code])).toEqual([
      [0, 'HIDE_RESERVED'],
      [1, 'HIDE_NOT_IN_STOCK'],
      [2, 'LOT_HELD'],
    ])
    expect(refusals[0]!.message).toBe('Hide HD-1 is reserved already, for work order WO-A: release that reservation first.')
  })

  it('a hide reserved twice in one batch is refused the second time', () => {
    const twice = [request({ index: 0, kind: 'HIDE', lotId: 'L1', hideId: 'H2', hideCode: 'HD-2', baseQuantity: '40' }), request({ index: 1, kind: 'HIDE', lotId: 'L1', hideId: 'H2', hideCode: 'HD-2', baseQuantity: '40' })]
    expect(reserveRefusals(STOCK, [], twice, holder).map((refusal) => refusal.code)).toEqual(['HIDE_RESERVED'])
  })
})

describe('issuing against reservations', () => {
  const words = { label: 'TEST-LEATHER BLK', baseUom: 'FT2', lotCode: 'LOT-1', hideCode: 'HD-1', holderOf: holder }
  const mine = (row: HeldReservation) => row.workOrderId === 'WO-A'

  it('refuses a hide another work order holds, and more than the others leave free', () => {
    const others = [reservation({ id: 'R9', workOrderId: 'WO-B', kind: 'HIDE', lotId: 'L1', hideId: 'H1', quantity: '50' })]
    expect(issueConflict(STOCK, others, mine, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' }, words)).toMatch(/^Hide HD-1 is reserved for work order WO-B/)
    expect(issueConflict(STOCK, others, mine, { lotId: 'L1', hideId: 'H2', baseQuantity: '40' }, words)).toBeNull()
    const lotHeld = [reservation({ id: 'R8', workOrderId: 'WO-B', lotId: 'L1', quantity: '60' })]
    // The site as a whole has the area (another released lot), lot L1 does not: the lot's words.
    const more = [...STOCK, { lotId: 'L4', hideId: 'H4', onHand: '100.0000', held: false }]
    expect(issueConflict(more, lotHeld, mine, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' }, words)).toMatch(/^Lot LOT-1: only 30\.0000 FT2 is free; the rest is reserved for work order WO-B/)
    // Short at the site: the material's words.
    expect(issueConflict(STOCK, lotHeld, mine, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' }, words)).toMatch(/^TEST-LEATHER BLK: only 30\.0000 FT2 is free at this site/)
  })

  it('takes its own reserved stock, and stock of a done demand', () => {
    const own = [reservation({ id: 'R1', lotId: 'L1', quantity: '90' })]
    expect(issueConflict(STOCK, own, mine, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' }, words)).toBeNull()
    const stale = [reservation({ id: 'R2', workOrderId: 'WO-DONE', lotId: 'L1', quantity: '90', demandOpen: false })]
    expect(issueConflict(STOCK, stale, mine, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' }, words)).toBeNull()
  })

  it('counts an issue against the hide first, then the lot, then any lot', () => {
    const own = [
      reservation({ id: 'ANY', quantity: '30' }),
      reservation({ id: 'LOT', lotId: 'L1', quantity: '20' }),
      reservation({ id: 'HIDE', kind: 'HIDE', lotId: 'L1', hideId: 'H1', quantity: '50' }),
    ]
    expect(consumption(own, { lotId: 'L1', hideId: 'H1', baseQuantity: '50' })).toEqual([{ id: 'HIDE', issuedQuantity: '50.0000', issued: true }])
    expect(consumption(own, { lotId: 'L1', hideId: 'H2', baseQuantity: '40' })).toEqual([
      { id: 'LOT', issuedQuantity: '20.0000', issued: true },
      { id: 'ANY', issuedQuantity: '20.0000', issued: false },
    ])
    expect(consumption(own, { lotId: 'L2', hideId: null, baseQuantity: '45' })).toEqual([{ id: 'ANY', issuedQuantity: '30.0000', issued: true }])
  })

  it('gives an undone issue back to the reservations still active, any lot first', () => {
    const own = [reservation({ id: 'LOT', lotId: 'L1', quantity: '20', issuedQuantity: '15' }), reservation({ id: 'ANY', quantity: '30', issuedQuantity: '10' })]
    expect(giveBack(own, { lotId: 'L1', hideId: null, baseQuantity: '18' })).toEqual([
      { id: 'ANY', issuedQuantity: '0.0000', issued: false },
      { id: 'LOT', issuedQuantity: '7.0000', issued: false },
    ])
  })
})

describe('releasing', () => {
  it('needs a reason and an ACTIVE reservation', () => {
    expect(releaseReasonProblem('  ')).toBe('A release says why.')
    expect(releaseReasonProblem('Order cancelled by the customer')).toBeNull()
    expect(releaseRefusal({ status: 'ACTIVE' }, 'Reservation 1')).toBeNull()
    expect(releaseRefusal({ status: 'ISSUED' }, 'Reservation 1')).toMatch(/fully issued/)
    expect(releaseRefusal({ status: 'RELEASED' }, 'Reservation 1')).toMatch(/released already/)
  })
})
