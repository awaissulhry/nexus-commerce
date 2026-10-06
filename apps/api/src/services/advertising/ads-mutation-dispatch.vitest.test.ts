/**
 * AX-ZD.1f — the typed rows and the JSON blob must dispatch IDENTICALLY.
 *
 * Dispatch now reads AdMutation rows instead of parsing the queue row's JSON
 * payload. Both are records of the same intent, so any divergence between them
 * is a wrong value reaching Amazon with nothing in the logs to explain it.
 * These tests pin the two places they could drift apart.
 */
import { describe, it, expect } from 'vitest'
import { dedupeFieldChanges, isLetGoWrite, isSuppressionWrite } from './ads-mutation.service.js'

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

/**
 * 2.2 — the gate exempts a suppression from the halt, the min bid bound and the bids pin.
 * `force` is set by suppressions AND by restores / base-bid deltas, which raise bids, so
 * only a forced write whose every value goes down may be called a suppression.
 */
describe('isSuppressionWrite — forced AND lowering-only', () => {
  const ch = (field: string, oldValue: string | null, newValue: string | null): FieldChange => ({ field, oldValue, newValue })

  it('a forced floor is a suppression: night floor 35→2¢, an ad-group default, a refloor down', () => {
    expect(isSuppressionWrite(true, [ch('bid', '35', '2')])).toBe(true)
    expect(isSuppressionWrite(true, [ch('defaultBid', '80', '2')])).toBe(true)
    expect(isSuppressionWrite(true, [ch('bid', '5', '3')])).toBe(true)
  })

  it('without force nothing is a suppression, however far it lowers', () => {
    expect(isSuppressionWrite(false, [ch('bid', '35', '2')])).toBe(false)
  })

  it('a forced RAISE is not — the morning restore 2→35¢ and a +% base-bid delta', () => {
    expect(isSuppressionWrite(true, [ch('bid', '2', '35')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('defaultBid', '40', '48')])).toBe(false)
  })

  it('an unchanged value is not — a forced re-sync may still move Amazon up', () => {
    expect(isSuppressionWrite(true, [ch('bid', '2', '2')])).toBe(false)
  })

  it('an unknown old or new value is not (fail closed)', () => {
    expect(isSuppressionWrite(true, [ch('bid', null, '2')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('bid', '', '2')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('bid', 'abc', '2')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('bid', '35', null)])).toBe(false)
    expect(isSuppressionWrite(true, [ch('bid', '35', '')])).toBe(false)
  })

  it('one rising value spoils the write, and so does a field without a direction', () => {
    expect(isSuppressionWrite(true, [ch('defaultBid', '40', '2'), ch('dailyBudget', '10', '12')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('bid', '40', '2'), ch('status', 'ENABLED', 'PAUSED')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('status', 'ENABLED', 'PAUSED')])).toBe(false)
    expect(isSuppressionWrite(true, [ch('dailyBudget', '10', '5'), ch('dailyBudgetCurrency', 'EUR', 'GBP')])).toBe(false)
  })

  it('a lowered budget or placement % counts; an empty write does not', () => {
    expect(isSuppressionWrite(true, [ch('dailyBudget', '10.00', '1.00')])).toBe(true)
    expect(isSuppressionWrite(true, [ch('PLACEMENT_TOP', '50', '0')])).toBe(true)
    expect(isSuppressionWrite(true, [ch('defaultBid', '40', '2'), ch('dailyBudget', '10', '5')])).toBe(true)
    expect(isSuppressionWrite(true, [])).toBe(false)
  })
})

/**
 * AA-W2-12 — a deliberate pause (pause-ads marks it `letsGo`) lets go of spend: the gate treats it as a suppression, so a
 * halt never holds it. Only with the mark, and only ENABLED → PAUSED: an enable starts spend, and an unmarked pause (a
 * rule's, an engine's) is judged as before.
 */
describe('isLetGoWrite — a marked pause, and nothing else', () => {
  const ch = (field: string, oldValue: string | null, newValue: string | null): FieldChange => ({ field, oldValue, newValue })

  it('a marked ENABLED → PAUSED lets go', () => {
    expect(isLetGoWrite(true, [ch('status', 'ENABLED', 'PAUSED')])).toBe(true)
  })

  it('without the mark it does not, nor does an enable, an archive, an unknown status or a write with any other field', () => {
    expect(isLetGoWrite(false, [ch('status', 'ENABLED', 'PAUSED')])).toBe(false)
    expect(isLetGoWrite(true, [ch('status', 'PAUSED', 'ENABLED')])).toBe(false)
    expect(isLetGoWrite(true, [ch('status', 'PAUSED', 'PAUSED')])).toBe(false)
    expect(isLetGoWrite(true, [ch('status', null, 'PAUSED')])).toBe(false)
    expect(isLetGoWrite(true, [ch('status', 'ENABLED', 'PAUSED'), ch('dailyBudget', '10', '12')])).toBe(false)
    expect(isLetGoWrite(true, [ch('bid', '40', '2')])).toBe(false)
    expect(isLetGoWrite(true, [])).toBe(false)
  })

  it('the suppression rule is unchanged by it: a forced status write is still no suppression', () => {
    expect(isSuppressionWrite(true, [ch('status', 'ENABLED', 'PAUSED')])).toBe(false)
  })
})
