import { describe, it, expect } from 'vitest'
import { outboundEnqueuePriority } from './sync-priority.js'

describe('outboundEnqueuePriority', () => {
  it('prioritises order-driven reasons (highest = 1)', () => {
    for (const r of ['ORDER_PLACED', 'ORDER_CANCELLED', 'ORDER_REFUNDED', 'RETURN_RESTOCKED']) {
      expect(outboundEnqueuePriority(r)).toBe(1)
    }
  })
  it('leaves manual/other reasons unprioritised (undefined)', () => {
    expect(outboundEnqueuePriority('MANUAL_ADJUSTMENT')).toBeUndefined()
    expect(outboundEnqueuePriority('SYNC_RECONCILIATION')).toBeUndefined()
  })
})
