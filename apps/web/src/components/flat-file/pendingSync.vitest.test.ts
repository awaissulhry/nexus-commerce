import { describe, expect, it } from 'vitest'
import { computePendingSyncSummary } from './pendingSync.pure'

describe('computePendingSyncSummary (FFT.4)', () => {
  it('counts pending and failed rows with their SKUs, once per row', () => {
    const s = computePendingSyncSummary([
      { item_sku: 'A', _pendingSync: [{ type: 'PRICE_UPDATE', status: 'PENDING' }, { type: 'QUANTITY_UPDATE', status: 'IN_PROGRESS' }] },
      { sku: 'B', _pendingSync: [{ type: 'QUANTITY_UPDATE', status: 'FAILED' }] },
      { item_sku: 'C' },
      { item_sku: 'D', _pendingSync: [] },
    ])
    expect(s).toEqual({ pending: 1, failed: 1, pendingSkus: ['A'], failedSkus: ['B'] })
  })

  it('a row can be both pending and failed (different queue entries)', () => {
    const s = computePendingSyncSummary([
      { item_sku: 'X', _pendingSync: [{ status: 'PENDING' }, { status: 'FAILED' }] },
    ])
    expect(s.pending).toBe(1)
    expect(s.failed).toBe(1)
  })

  it('empty rows → zeros', () => {
    expect(computePendingSyncSummary([])).toEqual({ pending: 0, failed: 0, pendingSkus: [], failedSkus: [] })
  })
})
