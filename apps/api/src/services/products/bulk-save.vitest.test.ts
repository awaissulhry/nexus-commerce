/**
 * The bulk save's request shape (`parseBulkSaveInput`). What each unit MEANS is judged by the row writer; this pins only
 * what makes a request a bulk save at all, and the bounds that keep one operation a sheet operation.
 * The transaction, the savepoints and row-level security are proven on a real server: `bulk-save-postgres.vitest.test.ts`.
 */
vi.mock('../../db.js', () => ({ default: {} }))
import { describe, expect, it, vi } from 'vitest'
import { BULK_SAVE_MAX_CHANGES, BULK_SAVE_MAX_UNITS, BulkSaveError, parseBulkSaveInput } from './bulk-save.service.js'

const change = { id: 'p1', field: 'attr_descriptionThemeId', value: 't1', target: 'channel' }
const refusal = (body: unknown) => { try { parseBulkSaveInput(body); return null } catch (error) { return error instanceof BulkSaveError ? [error.statusCode, error.details.error] : error } }

describe('parseBulkSaveInput', () => {
  it('accepts units that each carry a key and changes, and keeps the operation id', () => {
    const input = parseBulkSaveInput({ operationId: 'op-1', units: [{ key: 'EBAY:IT::p1', changes: [change], expectedVersion: 3 }] })
    expect(input.operationId).toBe('op-1')
    expect(input.units).toEqual([{ key: 'EBAY:IT::p1', changes: [change], expectedVersion: 3 }])
  })

  it('refuses a request that is not a list of keyed units, naming the unit', () => {
    expect(refusal(null)?.[0]).toBe(400)
    expect(refusal({ units: [] })?.[0]).toBe(400)
    expect(refusal({ units: [{ changes: [change] }] })).toEqual([400, 'units[0].key must be a non-empty string.'])
    expect(refusal({ units: [{ key: 'a', changes: [] }] })).toEqual([400, 'units[0].changes must be a non-empty array.'])
    expect(refusal({ units: [{ key: 'a', changes: [change] }, { key: 'a', changes: [change] }] })).toEqual([400, 'units[1].key "a" is used twice.'])
    expect(refusal({ operationId: '', units: [{ key: 'a', changes: [change] }] })?.[0]).toBe(400)
  })

  it('refuses an operation larger than a sheet operation with 413', () => {
    const units = (n: number, perUnit = 1) => Array.from({ length: n }, (_, i) => ({ key: `k${i}`, changes: Array.from({ length: perUnit }, () => change) }))
    expect(refusal({ units: units(BULK_SAVE_MAX_UNITS) })).toBeNull()
    expect(refusal({ units: units(BULK_SAVE_MAX_UNITS + 1) })?.[0]).toBe(413)
    expect(refusal({ units: units(BULK_SAVE_MAX_UNITS, Math.ceil((BULK_SAVE_MAX_CHANGES + 1) / BULK_SAVE_MAX_UNITS)) })?.[0]).toBe(413)
  })
})
