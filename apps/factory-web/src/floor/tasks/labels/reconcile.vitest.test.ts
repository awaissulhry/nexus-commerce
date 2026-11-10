import { describe, expect, it } from 'vitest'
import type { Reconciliation } from './api'
import { reconcileModel, spoilAsk, spoilCount } from './reconcile'

const row = (size: string, printed: number, used: number, spoiled: number, returned: number) => ({ workOrderSizeId: `c${size}`, colourwayCode: 'BLK', size, printed, used, spoiled, returned, difference: printed - used - spoiled - returned, balanced: printed === used + spoiled + returned })
const answer = (rows: ReturnType<typeof row>[], holdsRelease = false): Reconciliation => ({
  workOrder: { id: 'wo', number: 'WO-1', batchNumber: 'B-1', status: 'IN_PROGRESS' },
  tracking: 'BATCH',
  cells: rows,
  total: { printed: 0, used: 0, spoiled: 0, returned: 0, difference: rows.reduce((total, entry) => total + entry.difference, 0) },
  balanced: rows.every((entry) => entry.balanced),
  entries: [],
  holdsRelease,
})

describe('the label reconciliation on the floor (B-W2b-259, MES-140)', () => {
  it("shows the picked size's figures and holds Log spoiled with the reason", () => {
    const rec = answer([row('52', 8, 6, 0, 0), row('54', 3, 0, 2, 1), row('56', 0, 0, 0, 0)], true)
    expect(reconcileModel(rec, 'c52', { online: true, busy: false })).toMatchObject({ size: { label: 'BLK 52', difference: 2 }, room: 8, held: null, holdsRelease: true, balanced: false })
    expect(reconcileModel(rec, 'c54', { online: true, busy: false })!.held).toBe('noneLeft')
    expect(reconcileModel(rec, 'c56', { online: true, busy: false })!.held).toBe('nothingPrinted')
    expect(reconcileModel(rec, 'c52', { online: false, busy: false })!.held).toBe('offline')
    expect(reconcileModel(rec, 'c52', { online: true, busy: true })!.held).toBe('busy')
    expect(reconcileModel(null, 'c52', { online: true, busy: false })).toBeNull()
  })

  it('sends a spoiled reason in fixed words, or the labels handed back, with a count from 1 to what is left', () => {
    expect(spoilAsk('JAMMED', 'c52', 2)).toEqual({ workOrderSizeId: 'c52', kind: 'SPOILED', quantity: 2, reason: 'Printer jammed' })
    expect(spoilAsk('RETURNED', 'c52', 1)).toEqual({ workOrderSizeId: 'c52', kind: 'RETURNED', quantity: 1, reason: null })
    expect(spoilCount(null, 5)).toBe(1)
    expect(spoilCount(9, 5)).toBe(5)
    expect(spoilCount(0, 5)).toBe(1)
  })
})
