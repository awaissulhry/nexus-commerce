/**
 * PES.5 — `GET /products/:id/state` reconstruction.
 *
 * The bug this pins: `AuditLog.before` carries TWO shapes and the fold handled
 * only one. Spreading a DESCRIPTOR (`{field:'brand', value:'Old'}`) as a
 * field-map set `state.field = 'brand'` and `state.value = 'Old'` — two invented
 * keys — while `brand` itself was never rolled back. Measured on real data
 * before the fix: `reconstructed: ["field","value"]`.
 *
 * Both shapes are live in the table simultaneously (4 / 5 / 74 rows of the three
 * combinations on one product), so a test that pins only one shape would have
 * passed throughout the bug. Every case below is written from the RULE, not by
 * running the function and recording its output.
 */
import { describe, it, expect } from 'vitest'
import { asDescriptor, reconstructState } from './audit-state.js'

const current = { brand: 'NEW', name: 'New name', manufacturer: 'NewCo' }

describe('asDescriptor', () => {
  it('recognises exactly {field, value}', () => {
    expect(asDescriptor({ field: 'brand', value: 'Old' })).toEqual({ field: 'brand', value: 'Old' })
  })

  it('accepts a null value — "it was empty" is a real prior value', () => {
    expect(asDescriptor({ field: 'brand', value: null })).toEqual({ field: 'brand', value: null })
  })

  it('rejects a field-map, even one that happens to contain a `field` key', () => {
    // Three keys, so not a descriptor — this must fold as a map or a real
    // product field called `field` would be silently swallowed.
    expect(asDescriptor({ field: 'x', value: 'y', brand: 'Old' })).toBeNull()
  })

  it('rejects arrays and non-objects', () => {
    for (const v of [null, undefined, 'str', 42, [{ field: 'a', value: 'b' }]]) {
      expect(asDescriptor(v)).toBeNull()
    }
  })
})

describe('descriptor shape — what every studio edit writes', () => {
  it('rolls the NAMED field back and invents no keys', () => {
    const { state, coverage } = reconstructState(current, [
      { before: { field: 'brand', value: 'Old' }, after: { field: 'brand', value: 'NEW' } },
    ])
    expect(state.brand).toBe('Old')
    expect(coverage.brand).toBe('reconstructed')
    // The regression itself: these must not exist.
    expect('field' in state).toBe(false)
    expect('value' in state).toBe(false)
    expect(coverage.field).toBeUndefined()
    expect(coverage.value).toBeUndefined()
  })
})

describe('map shape — what the older row-level writers write', () => {
  it('rolls every key back', () => {
    const { state, coverage } = reconstructState(current, [
      { before: { brand: 'Old', name: 'Old name' } },
    ])
    expect(state.brand).toBe('Old')
    expect(state.name).toBe('Old name')
    expect(coverage.brand).toBe('reconstructed')
    expect(coverage.name).toBe('reconstructed')
  })
})

describe('both shapes in one history — the real table', () => {
  it('handles them together without either corrupting the other', () => {
    const { state, coverage } = reconstructState(current, [
      { before: { field: 'brand', value: 'Old' }, after: { field: 'brand', value: 'NEW' } },
      { before: { name: 'Old name' } },
      { before: null, after: { field: 'manufacturer', value: 'NewCo' } },
    ])
    expect(state.brand).toBe('Old')
    expect(state.name).toBe('Old name')
    // Changed, but nothing recorded what it changed FROM.
    expect(coverage.manufacturer).toBe('uncertain')
    expect(state.manufacturer).toBe('NewCo')
    expect('field' in state).toBe(false)
  })
})

describe('order is load-bearing — oldest first wins', () => {
  it('keeps the OLDEST prior value, not the most recent one', () => {
    // The first entry after the target instant holds the value AS AT that
    // instant. A later entry's `before` is a LATER state and must not win.
    const { state } = reconstructState(current, [
      { before: { field: 'brand', value: 'Oldest' } },
      { before: { field: 'brand', value: 'Middle' } },
    ])
    expect(state.brand).toBe('Oldest')
  })

  it('an early uncertain is not later upgraded to reconstructed', () => {
    // Measured on prod: manufacturer's oldest post-`at` row has before=NULL,
    // and later rows DO carry one. Uncertain is the correct answer — the later
    // value is not the value at the target instant.
    const { state, coverage } = reconstructState(current, [
      { before: null, after: { field: 'manufacturer', value: 'X' } },
      { before: { field: 'manufacturer', value: 'Later' } },
    ])
    expect(coverage.manufacturer).toBe('uncertain')
    expect(state.manufacturer).toBe('NewCo')
  })
})

describe('rows that say nothing', () => {
  it('leaves the field untouched and uncovered', () => {
    const { state, coverage } = reconstructState(current, [{ before: null, after: null }])
    expect(state).toEqual(current)
    expect(Object.keys(coverage)).toEqual([])
  })
})
