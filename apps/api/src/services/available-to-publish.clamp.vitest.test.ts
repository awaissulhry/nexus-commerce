import { describe, expect, it } from 'vitest'
import { planFollowingQtyClamp, type FollowingClampInfo } from './available-to-publish.service.js'

const info = (over: Partial<FollowingClampInfo> = {}): FollowingClampInfo => ({
  followMasterQuantity: true,
  fulfillmentMethod: 'FBM',
  stockBuffer: 0,
  warehouseAvailable: 7,
  ...over,
})

describe('planFollowingQtyClamp (FFT-I3 GAP 1)', () => {
  it('replaces a typed qty on a Following FBM row with pool truth', () => {
    const rows = [{ item_sku: 'A', fulfillment_availability__quantity: '99' }]
    const changes = planFollowingQtyClamp(rows, new Map([['A', info()]]))
    expect(changes).toEqual([{ sku: 'A', from: '99', to: '7' }])
    expect(rows[0].fulfillment_availability__quantity).toBe('7')
  })

  it('applies the buffer and floors at zero', () => {
    const rows = [{ item_sku: 'A', fulfillment_availability__quantity: '5' }]
    planFollowingQtyClamp(rows, new Map([['A', info({ warehouseAvailable: 3, stockBuffer: 5 })]]))
    expect(rows[0].fulfillment_availability__quantity).toBe('0')
  })

  it('never touches Pinned, FBA, unknown, or qty-less rows', () => {
    const rows = [
      { item_sku: 'PINNED', fulfillment_availability__quantity: '42' },
      { item_sku: 'FBA', fulfillment_availability__quantity: '42' },
      { item_sku: 'UNKNOWN', fulfillment_availability__quantity: '42' },
      { item_sku: 'NOQTY' },
    ]
    const changes = planFollowingQtyClamp(rows, new Map([
      ['PINNED', info({ followMasterQuantity: false })],
      ['FBA', info({ fulfillmentMethod: 'FBA' })],
      ['NOQTY', info()],
    ]))
    expect(changes).toEqual([])
    expect(rows[0].fulfillment_availability__quantity).toBe('42')
    expect(rows[1].fulfillment_availability__quantity).toBe('42')
  })

  it('no change entry when the cell already equals pool truth', () => {
    const rows = [{ item_sku: 'A', fulfillment_availability__quantity: '7' }]
    expect(planFollowingQtyClamp(rows, new Map([['A', info()]]))).toEqual([])
  })
})
