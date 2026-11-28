import { describe, expect, it } from 'vitest'
import { basketsAtPrint, isSmallPartsType, MAX_BASKETS_AT_PRINT, type PrintWorkOrderFacts } from './at-print'
import { MAX_BUNDLES_PER_MAKE } from '../bundles/rules'

/** owb- (order workflow, b2.3): one garment = one basket, made at "Print and start the work" behind the site's switch. */
const workOrder = (id: string, cells: Array<[string, number, number?]>, more: Partial<PrintWorkOrderFacts> = {}): PrintWorkOrderFacts => ({
  workOrderId: id,
  status: 'RELEASED',
  kind: 'SIZE_GRID',
  smallParts: false,
  cells: cells.map(([workOrderSizeId, quantity, activeBundles]) => ({ workOrderSizeId, quantity, activeBundles: activeBundles ?? 0 })),
  ...more,
})

describe('basketsAtPrint', () => {
  it('a 114-piece order makes 114 baskets of one garment each — over the cutting bench\'s 100', () => {
    const answer = basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', 40], ['s50', 50], ['s52', 24]])] })
    expect(answer.ok).toBe(true)
    if (!answer.ok) return
    expect(answer.baskets).toHaveLength(114)
    expect(answer.baskets.length).toBeGreaterThan(MAX_BUNDLES_PER_MAKE)
    expect(answer.baskets.every((basket) => basket.quantity === 1 && basket.workOrderId === 'wo-1')).toBe(true)
    expect(answer.baskets.filter((basket) => basket.workOrderSizeId === 's50')).toHaveLength(50)
  })

  it('a small-parts line makes ONE basket with its pieces (per cell); a made-to-measure one is always one garment a basket', () => {
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-gloves', [['one-size', 30]], { smallParts: true })] })).toEqual({ ok: true, baskets: [{ workOrderId: 'wo-gloves', workOrderSizeId: 'one-size', quantity: 30 }] })
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-mtm', [['rider', 1]], { kind: 'MADE_TO_MEASURE', smallParts: true })] })).toEqual({ ok: true, baskets: [{ workOrderId: 'wo-mtm', workOrderSizeId: 'rider', quantity: 1 }] })
    expect(isSmallPartsType('GLOVES')).toBe(true)
    expect(isSmallPartsType('JACKET')).toBe(false)
    expect(isSmallPartsType(null)).toBe(false)
  })

  it('the switch off: nothing is made (the site\'s cutting makes the bundles, as today)', () => {
    expect(basketsAtPrint({ switchOn: false, workOrders: [workOrder('wo-1', [['s48', 2]])] })).toEqual({ ok: false, refusal: { code: 'SWITCH_OFF', workOrderId: null, workOrderSizeId: null, count: null, limit: null } })
  })

  it('refuses a work order not released, a cell that has its bundles, and a print over its own limit', () => {
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', 2]], { status: 'DRAFT' })] })).toMatchObject({ ok: false, refusal: { code: 'NOT_RELEASED', workOrderId: 'wo-1' } })
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', 2]], { status: 'ON_HOLD' })] })).toMatchObject({ ok: false, refusal: { code: 'NOT_RELEASED' } })
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', 2], ['s50', 3, 1]])] })).toMatchObject({ ok: false, refusal: { code: 'ALREADY_MADE', workOrderId: 'wo-1', workOrderSizeId: 's50' } })
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', MAX_BASKETS_AT_PRINT + 1]])] })).toEqual({ ok: false, refusal: { code: 'TOO_MANY', workOrderId: null, workOrderSizeId: null, count: MAX_BASKETS_AT_PRINT + 1, limit: 2000 } })
    expect(basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', MAX_BASKETS_AT_PRINT]], { status: 'IN_PROGRESS' })] }).ok).toBe(true)
  })

  it('a cell of 0 makes nothing; the order of baskets is work order then cell', () => {
    const answer = basketsAtPrint({ switchOn: true, workOrders: [workOrder('wo-1', [['s48', 0], ['s50', 1]]), workOrder('wo-2', [['s52', 1]], { smallParts: true })] })
    expect(answer).toEqual({ ok: true, baskets: [{ workOrderId: 'wo-1', workOrderSizeId: 's50', quantity: 1 }, { workOrderId: 'wo-2', workOrderSizeId: 's52', quantity: 1 }] })
  })
})
