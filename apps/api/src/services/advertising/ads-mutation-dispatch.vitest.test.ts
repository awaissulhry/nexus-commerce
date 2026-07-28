/**
 * AX-ZD.1f — the typed rows and the JSON blob must dispatch IDENTICALLY.
 *
 * Dispatch now reads AdMutation rows instead of parsing the queue row's JSON
 * payload. Both are records of the same intent, so any divergence between them
 * is a wrong value reaching Amazon with nothing in the logs to explain it.
 * These tests pin the two places they could drift apart.
 */
import { describe, it, expect } from 'vitest'
import { dedupeFieldChanges } from './ads-mutation.service.js'

type FieldChange = { field: string; oldValue: string | null; newValue: string | null }

/** The JSON path's shape: build a plain object, so a repeat overwrites. */
function patchFromJsonPath(changes: FieldChange[]): Record<string, string | null> {
  const out: Record<string, string | null> = {}
  for (const c of changes) out[c.field] = c.newValue
  return out
}

/** The typed path: rows keyed per field, then read back in field order. */
function patchFromTypedPath(changes: FieldChange[]): Record<string, string | null> {
  const rows = dedupeFieldChanges(changes)
    .map((c) => ({ field: c.field, intendedValue: c.newValue }))
    .sort((a, b) => a.field.localeCompare(b.field)) // dispatchPayloadFromMutations orders by field
  const out: Record<string, string | null> = {}
  for (const r of rows) out[r.field] = r.intendedValue
  return out
}

describe('typed rows and JSON blob produce the same patch', () => {
  it('agree on an ordinary multi-field change', () => {
    const changes: FieldChange[] = [
      { field: 'dailyBudget', oldValue: '10', newValue: '12' },
      { field: 'status', oldValue: 'PAUSED', newValue: 'RUNNING' },
      { field: 'name', oldValue: 'Old', newValue: 'New' },
    ]
    expect(patchFromTypedPath(changes)).toEqual(patchFromJsonPath(changes))
  })

  it('agree when a field is cleared to null', () => {
    const changes: FieldChange[] = [{ field: 'portfolioId', oldValue: 'p1', newValue: null }]
    expect(patchFromTypedPath(changes)).toEqual(patchFromJsonPath(changes))
    expect(patchFromTypedPath(changes).portfolioId).toBeNull()
  })

  it('agree on a REPEATED field — both keep the last value', () => {
    // Without dedupe the typed path keeps the first (skipDuplicates on
    // `${queueId}:${field}`) while the JSON path keeps the last. That is the
    // silent divergence: the operator sees 12 applied when they asked for 15.
    const changes: FieldChange[] = [
      { field: 'dailyBudget', oldValue: '10', newValue: '12' },
      { field: 'dailyBudget', oldValue: '12', newValue: '15' },
    ]
    expect(patchFromTypedPath(changes)).toEqual(patchFromJsonPath(changes))
    expect(patchFromTypedPath(changes).dailyBudget).toBe('15')
  })

  it('field ordering cannot change the result', () => {
    // The typed path reads back ordered by field name, the JSON path in array
    // order. Distinct keys mean order is irrelevant — assert it, so a future
    // change that introduces same-key overwrite ordering gets caught.
    const changes: FieldChange[] = [
      { field: 'zeta', oldValue: null, newValue: '1' },
      { field: 'alpha', oldValue: null, newValue: '2' },
    ]
    expect(patchFromTypedPath(changes)).toEqual(patchFromJsonPath(changes))
  })
})

describe('dedupeFieldChanges', () => {
  it('keeps the last occurrence, matching object-build semantics', () => {
    const out = dedupeFieldChanges([
      { field: 'bid', oldValue: '1', newValue: '2' },
      { field: 'bid', oldValue: '2', newValue: '3' },
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.newValue).toBe('3')
  })

  it('leaves a duplicate-free list untouched', () => {
    const changes: FieldChange[] = [
      { field: 'a', oldValue: null, newValue: '1' },
      { field: 'b', oldValue: null, newValue: '2' },
    ]
    expect(dedupeFieldChanges(changes)).toEqual(changes)
  })
})
