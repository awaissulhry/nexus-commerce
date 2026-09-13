import { describe, expect, it } from 'vitest'
import { sheetReadFailure } from './sheetReadFailure'
describe('studio 404 classification', () => {
  it.each(['code', 'error'])('unknown_product in %s never falls back to the legacy sheet', key => {
    expect(sheetReadFailure(404, { [key]: 'unknown_product' })).toEqual({ fallback: false, message: 'This product is unavailable. It may have been moved to the bin.' })
  })
  it('retains the genuinely missing-route fallback and refuses permission errors', () => {
    expect(sheetReadFailure(404, { error: 'Not Found', message: 'Route GET:/studio/sheet not found' }).fallback).toBe(true)
    expect(sheetReadFailure(403, { message: 'Permission refused.' })).toEqual({ fallback: false, message: 'Permission refused.' })
    expect(sheetReadFailure(404, { code: 'coordinate_missing' }).fallback).toBe(false)
  })
})
