import { describe, expect, it } from 'vitest'
import { holdsReleasedGarments, sizeBackorder } from './backorder'

/**
 * B-OS-002 (order shipments tab; H1-B8): which shipments hold the released garments they carry, and so what is ready now. The
 * order read's `planned` (on DRAFT and PACKED shipments) and `readyNow` come from this same rule as Warehouse's backorder.
 */
const size = (overrides: Partial<Parameters<typeof sizeBackorder>[0]> = {}) =>
  sizeBackorder({ size: '52', ordered: 10, closedShort: false, shipped: 0, open: 0, thisShipment: 0, netReleased: 0, onShipments: 0, ...overrides })

describe('which shipments hold their garments (B-OS-002, H1-B8)', () => {
  it('every shipment but a cancelled one, and one that came back only until its garments are received back', () => {
    const at = new Date('2026-11-20T10:00:00.000Z')
    expect(['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED'].map((status) => holdsReleasedGarments({ status, carrierReturnReceivedAt: null }))).toEqual([true, true, true, true])
    expect(holdsReleasedGarments({ status: 'CANCELLED', carrierReturnReceivedAt: null })).toBe(false)
    expect(holdsReleasedGarments({ status: 'RETURNED', carrierReturnReceivedAt: null })).toBe(true)
    expect(holdsReleasedGarments({ status: 'RETURNED', carrierReturnReceivedAt: at })).toBe(false)
  })

  it('a received carrier return frees its garments: they are ready now again, what is planned and to ship stays', () => {
    // 10 released: 3 left on a shipment that came back, 4 on a DRAFT (planned), the other 3 on no shipment.
    const waiting = size({ shipped: 0, open: 4, netReleased: 10, onShipments: 3 + 4 })
    expect(waiting).toMatchObject({ open: 4, backorder: 6, readyNow: 3 })
    // Received back: the 3 no longer count as held, so 6 are ready now (never more than what is still to ship).
    const received = size({ shipped: 0, open: 4, netReleased: 10, onShipments: 4 })
    expect(received).toMatchObject({ open: 4, backorder: 6, readyNow: 6 })
  })

  it('10 released, 4 on a DRAFT, 3 shipped: planned 4, ready now 3, still to ship 7', () => {
    const row = size({ shipped: 3, open: 4, netReleased: 10, onShipments: 3 + 4 })
    expect({ planned: row.open, readyNow: row.readyNow, toShip: row.ordered - row.shipped }).toEqual({ planned: 4, readyNow: 3, toShip: 7 })
  })
})
