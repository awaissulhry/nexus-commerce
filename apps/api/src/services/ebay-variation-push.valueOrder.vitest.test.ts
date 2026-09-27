/**
 * EFX P3 — variation value-order resolution.
 *
 * Covers the push service's ordering contract without touching the DB:
 *   (a) only legacy `_axisSortOrder` present → values order by it.
 *   (b) both `_axisValueOrder` and legacy `_axisSortOrder` for the same
 *       dimension → the synonym-keyed `_axisValueOrder` wins.
 *
 * mergeStoredValueOrder is the exact resolution the push body runs (extracted so
 * it's unit-testable); sortAxisValues is the same sort the specifications build
 * applies, with the same synonym-first key lookup used at the call site.
 */
import { describe, it, expect } from 'vitest'
import {
  mergeStoredValueOrder,
  sortAxisValues,
  axisSynonymKey,
} from './ebay-variation-push.service.js'

/** Reproduce the push call-site lookup: synonym key first, then raw, then lower. */
function orderForAxis(
  values: string[],
  axisName: string,
  valueOrder: Record<string, string[]>,
): string[] {
  const custom =
    valueOrder[axisSynonymKey(axisName)] ??
    valueOrder[axisName] ??
    valueOrder[axisName.toLowerCase()]
  return sortAxisValues(values, axisName, custom)
}

describe('mergeStoredValueOrder — value order resolution', () => {
  it('(a) only legacy _axisSortOrder present → values order by it', () => {
    const pa = { _axisSortOrder: { Taglia: ['S', 'M', 'L', 'XL'] } }
    const valueOrder = mergeStoredValueOrder(pa)

    // The legacy raw-name entry is surfaced under its canonical synonym key.
    expect(valueOrder).toEqual({ __dim1__: ['S', 'M', 'L', 'XL'] })

    // And it drives the sort (unsorted input → legacy order), matched
    // case-insensitively and via the raw-name fallback at the call site.
    expect(orderForAxis(['XL', 'M', 'S', 'L'], 'Taglia', valueOrder)).toEqual([
      'S', 'M', 'L', 'XL',
    ])
  })

  it('(b) both present for the same dim → _axisValueOrder (synonym) wins', () => {
    const pa = {
      _axisValueOrder: { __dim1__: ['XL', 'L', 'M', 'S'] }, // buyer-chosen order
      _axisSortOrder: { Taglia: ['S', 'M', 'L', 'XL'] }, // legacy, superseded
    }
    const valueOrder = mergeStoredValueOrder(pa)

    // Legacy 'Taglia' is NOT merged because __dim1__ already covers the size dim.
    expect(valueOrder).toEqual({ __dim1__: ['XL', 'L', 'M', 'S'] })

    // The synonym-keyed order wins at the call site (Taglia → __dim1__).
    expect(orderForAxis(['S', 'M', 'L', 'XL'], 'Taglia', valueOrder)).toEqual([
      'XL', 'L', 'M', 'S',
    ])
  })

  it('(b2) legacy entry for a DIFFERENT dim is still merged in', () => {
    const pa = {
      _axisValueOrder: { __dim1__: ['XL', 'L', 'M', 'S'] },
      _axisSortOrder: { Colore: ['Rosso', 'Blu'], Taglia: ['S', 'M'] },
    }
    const valueOrder = mergeStoredValueOrder(pa)

    // Colore (__dim0__) isn't covered by the value order → merged; Taglia is.
    expect(valueOrder).toEqual({
      __dim1__: ['XL', 'L', 'M', 'S'],
      __dim0__: ['Rosso', 'Blu'],
    })
  })

  it('empty platformAttributes → empty order (no crash)', () => {
    expect(mergeStoredValueOrder({})).toEqual({})
  })
})
