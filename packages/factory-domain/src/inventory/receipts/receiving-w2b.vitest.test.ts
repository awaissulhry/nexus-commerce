import { describe, expect, it } from 'vitest'
import { ddtCorrectionProblems, ddtCorrectionStateProblem, ddtCorrectionValues } from './ddt-correction'
import { discrepancyReasonOf } from './discrepancies'

/**
 * Receiving follow-ups (B-W2b-14; B-W2a-31's gaps), the pure parts: the discrepancy's reason code read from its own
 * column (and from the W2a note prefix for one recorded before W2b), and the correction of a posted receipt's supplier
 * DDT number and date.
 */

const STANDARD = new Set(['SHORT', 'OVER', 'WRONG_ITEM', 'DAMAGED'])

describe('a discrepancy reason code as data (Z1:01)', () => {
  it('reads the column first; the note is the receiver words only', () => {
    expect(discrepancyReasonOf({ reasonCode: 'DAMAGED', note: ' two hides with holes ' }, STANDARD)).toEqual({ reasonCode: 'DAMAGED', note: 'two hides with holes' })
    expect(discrepancyReasonOf({ reasonCode: 'STAINS', note: null }, STANDARD)).toEqual({ reasonCode: 'STAINS', note: null })
    // A column value is never parsed again from the note, even when the note starts like a code.
    expect(discrepancyReasonOf({ reasonCode: 'SHORT', note: 'OVER: words' }, STANDARD)).toEqual({ reasonCode: 'SHORT', note: 'OVER: words' })
  })

  it('a discrepancy recorded before W2b (no column value): the code at the head of its note', () => {
    expect(discrepancyReasonOf({ reasonCode: null, note: 'DAMAGED: two hides with holes' }, STANDARD)).toEqual({ reasonCode: 'DAMAGED', note: 'two hides with holes' })
    expect(discrepancyReasonOf({ reasonCode: null, note: 'NOTE: the box was open' }, STANDARD)).toEqual({ reasonCode: null, note: 'NOTE: the box was open' })
    expect(discrepancyReasonOf({ reasonCode: null, note: null }, STANDARD)).toEqual({ reasonCode: null, note: null })
  })
})

describe("a posted receipt's supplier DDT corrected (Z1:02)", () => {
  const posted = { number: 'GR-2026-0004', status: 'POSTED', supplierDdtNumber: '123', supplierDdtDate: '2026-10-20' } as const

  it('only a POSTED receipt; an open one sets it when posted, a reversed or cancelled one never', () => {
    expect(ddtCorrectionStateProblem(posted)).toBeNull()
    expect(ddtCorrectionStateProblem({ ...posted, status: 'OPEN' })).toContain('still open')
    expect(ddtCorrectionStateProblem({ ...posted, status: 'REVERSED' })).toBe('Receipt GR-2026-0004 is reversed: its supplier DDT no longer changes.')
    expect(ddtCorrectionStateProblem({ ...posted, status: 'CANCELLED' })).toContain('cancelled')
  })

  it('a reason, a real change, a date not after today and with its number', () => {
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: '132', supplierDdtDate: '2026-10-20', reason: 'Digits swapped at the dock' }, '2026-10-31')).toEqual([])
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: '132', supplierDdtDate: '2026-10-20', reason: ' ' }, '2026-10-31')).toEqual([expect.objectContaining({ path: 'body/reason' })])
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: ' 123 ', supplierDdtDate: '2026-10-20', reason: 'Nothing changes' }, '2026-10-31')).toEqual([expect.objectContaining({ path: 'body/supplierDdtNumber', message: expect.stringContaining('names this DDT already') })])
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: '123', supplierDdtDate: '2026-11-02', reason: 'The date typed was wrong' }, '2026-10-31')).toEqual([expect.objectContaining({ path: 'body/supplierDdtDate' })])
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: null, supplierDdtDate: '2026-10-19', reason: 'Only the date' }, '2026-10-31')).toEqual([expect.objectContaining({ path: 'body/supplierDdtNumber', message: 'A DDT date goes with its number.' })])
    // Only the date changes: allowed.
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: '123', supplierDdtDate: '2026-10-19', reason: 'The date of the order was typed' }, '2026-10-31')).toEqual([])
    expect(ddtCorrectionProblems(posted, { supplierDdtNumber: 'x'.repeat(61), supplierDdtDate: null, reason: 'Too long' }, '2026-10-31')).toEqual([expect.objectContaining({ path: 'body/supplierDdtNumber', message: 'At most 60 characters.' })])
  })

  it('the values written: trimmed, blank number none', () => {
    expect(ddtCorrectionValues({ supplierDdtNumber: ' 132 ', supplierDdtDate: '2026-10-20', reason: ' Digits swapped ' })).toEqual({ supplierDdtNumber: '132', supplierDdtDate: '2026-10-20', reason: 'Digits swapped' })
    expect(ddtCorrectionValues({ supplierDdtNumber: '  ', supplierDdtDate: null, reason: 'No DDT came' }).supplierDdtNumber).toBeNull()
  })
})
