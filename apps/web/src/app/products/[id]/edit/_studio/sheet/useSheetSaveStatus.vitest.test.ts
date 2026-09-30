/**
 * P2 (2026-09-30, I4-4) — a writer event that changes no count keeps the sheet's status object: every new object
 * re-rendered the whole sheet (about 60 components) with nothing to show.
 */
import { describe, expect, it } from 'vitest'
import { sameStatus } from './useSheetSaveStatus'

describe('sameStatus', () => {
  const base = { pending: 1, refused: 0, warned: 0, retryable: 0, refusedRowIds: new Set<string>(), offline: false, saving: true }
  it('equal counts and refused rows are the same status', () => {
    expect(sameStatus(base, { ...base, refusedRowIds: new Set() })).toBe(true)
  })
  it('any count, flag or refused row that moves is a new status', () => {
    for (const change of [{ pending: 0 }, { saving: false }, { refused: 1 }, { warned: 1 }, { retryable: 1 }, { offline: true }, { refusedRowIds: new Set(['r1']) }]) {
      expect(sameStatus(base, { ...base, ...change }), JSON.stringify(change)).toBe(false)
    }
  })
})
