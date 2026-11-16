import { describe, expect, it } from 'vitest'
import { carryHeld, depositsOf } from './model'

// B-W2b-GB02 (G088): the deposits waiting to be carried onto an invoice, and why the carry is held.

const preview = { depositRequestId: 'r1', orderId: 'o1', orderNumber: 'SO-1', currency: 'EUR', problem: null, amount: 100, steps: [], invoices: [] }

describe('a deposit to carry', () => {
  it('is what the open items say waits for this invoice (none: nothing)', () => {
    const items = [
      { id: 'i1', depositToCarry: [{ depositRequestId: 'r1', amount: 30000 }] },
      { id: 'i2', depositToCarry: [] },
      { id: 'i3' },
    ]
    expect(depositsOf(items, 'i1')).toEqual([{ depositRequestId: 'r1', amount: 30000 }])
    expect(depositsOf(items, 'i2')).toEqual([])
    expect(depositsOf(items, 'i3')).toEqual([])
    expect(depositsOf([{ id: 'i1', depositToCarry: [{ depositRequestId: 'r1' }] }], 'i1')).toEqual([{ depositRequestId: 'r1' }])
  })

  it('is carried by who records payments, once its preview says it can be', () => {
    expect(carryHeld({ mayRecord: false, busy: false, preview })).toEqual({ key: 'held.noRecord' })
    expect(carryHeld({ mayRecord: true, busy: true, preview })).toEqual({ key: 'held.busy' })
    expect(carryHeld({ mayRecord: true, busy: false, preview: null })).toEqual({ key: 'held.reading' })
    expect(carryHeld({ mayRecord: true, busy: false, preview: { ...preview, problem: 'Open for less.' } })).toEqual({ key: 'held.cannot' })
    expect(carryHeld({ mayRecord: true, busy: false, preview })).toBeNull()
  })
})
