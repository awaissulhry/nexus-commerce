import { describe, expect, it } from 'vitest'

import { sameValue, writeGate } from './writeGate'

describe('writeGate — what counts as an operator edit', () => {
  it('an ordinary edit writes', () => {
    expect(writeGate({ colId: 'brand', source: 'edit' })).toEqual({ write: true })
  })

  /**
   * 🔴 Deny-list, not allow-list. AG types `source` as `string | undefined` and documents only
   * examples, so an unknown source must WRITE — an edit that shows on screen and never reaches the
   * server is the failure this whole path exists to prevent. Dropping a real edit is worse than
   * saving one more source than strictly necessary.
   */
  it('every known edit source writes, and so does an unknown one', () => {
    for (const source of ['edit', 'paste', 'undo', 'redo', 'fill', 'rangeService', 'somethingAgAddsIn2027', undefined]) {
      expect(writeGate({ colId: 'brand', source })).toEqual({ write: true })
    }
  })

  it('the grid setting its own data does not write', () => {
    expect(writeGate({ colId: 'brand', source: 'data' })).toEqual({ write: false, reason: 'grid-data' })
  })

  /**
   * 🔴 The case no source check can catch: `setDataValue` re-fires `cellValueChanged` WITHOUT
   * `source: 'data'`, so a component reverting a refused cell re-enters its own handler. Only the
   * component knows the change is its own undo, so it says so.
   */
  it('a change the component caused itself does not write, whatever the source says', () => {
    expect(writeGate({ colId: 'brand', source: 'edit', selfInflicted: true })).toEqual({ write: false, reason: 'self-inflicted' })
    expect(writeGate({ colId: 'brand', selfInflicted: true })).toEqual({ write: false, reason: 'self-inflicted' })
  })

  it('a change with no column has nothing to address', () => {
    expect(writeGate({ source: 'edit' })).toEqual({ write: false, reason: 'no-column' })
    expect(writeGate({ colId: '', source: 'edit' })).toEqual({ write: false, reason: 'no-column' })
    expect(writeGate({ colId: null, source: 'edit' })).toEqual({ write: false, reason: 'no-column' })
  })

  it('always says WHY it refused — a dropped write must be explainable, never silent', () => {
    for (const input of [{ source: 'edit' }, { colId: 'a', source: 'data' }, { colId: 'a', selfInflicted: true }]) {
      const v = writeGate(input)
      expect(v.write).toBe(false)
      expect(v.reason).toBeTruthy()
    }
  })

  it('self-inflicted outranks the source check, so a self-revert is never mistaken for grid data', () => {
    // Both would refuse; the REASON must name the real one, or a debugging session chases the wrong
    // rule for a change the component itself caused.
    expect(writeGate({ colId: 'a', source: 'data', selfInflicted: true }).reason).toBe('self-inflicted')
  })

  /**
   * Rule 4 — the value did not move. AG's FILL fires `cellValueChanged` for every cell in the range
   * regardless (its PASTE path equality-checks; the fill path does not). Measured on the wire: a
   * fill down three rows already holding "Xavia" issued 2 PATCHes for 0 changes.
   */
  describe('a change that changed nothing', () => {
    it('refuses a write whose value is identical, and says why', () => {
      expect(writeGate({ colId: 'brand', source: 'edit', oldValue: 'Xavia', newValue: 'Xavia' }))
        .toEqual({ write: false, reason: 'unchanged' })
      expect(writeGate({ colId: 'n', source: 'edit', oldValue: 7, newValue: 7 }).write).toBe(false)
    })

    it('treats null and undefined as the same absence — which one a row carries is an artefact', () => {
      expect(writeGate({ colId: 'a', oldValue: null, newValue: undefined }).write).toBe(false)
      expect(writeGate({ colId: 'a', oldValue: undefined, newValue: null }).write).toBe(false)
    })

    it("🔴 does NOT fold '' in with null — clearing a field is a real edit and must still write", () => {
      expect(writeGate({ colId: 'a', oldValue: 'Xavia', newValue: '' })).toEqual({ write: true })
      expect(writeGate({ colId: 'a', oldValue: null, newValue: '' })).toEqual({ write: true })
      expect(writeGate({ colId: 'a', oldValue: '', newValue: null })).toEqual({ write: true })
    })

    it('writes when the value genuinely moved, including a type change', () => {
      expect(writeGate({ colId: 'a', oldValue: 'Xavia', newValue: 'Xavio' })).toEqual({ write: true })
      // '7' and 7 are different on the wire; erring toward writing keeps the gate's standing bias.
      expect(writeGate({ colId: 'a', oldValue: 7, newValue: '7' })).toEqual({ write: true })
    })

    it('a structurally identical non-primitive is unchanged (AM.1: list and measure cells hold arrays and objects)', () => {
      expect(writeGate({ colId: 'a', oldValue: ['a', 'b'], newValue: ['a', 'b'] })).toEqual({ write: false, reason: 'unchanged' })
      expect(writeGate({ colId: 'a', oldValue: { value: 1, unit: 'g' }, newValue: { unit: 'g', value: 1 } })).toEqual({ write: false, reason: 'unchanged' })
    })
    it('still errs toward WRITING for a non-primitive it cannot compare, never silently dropping one', () => {
      const cyclic: Record<string, unknown> = { state: 'ready' }
      cyclic.self = cyclic
      expect(writeGate({ colId: 'a', oldValue: cyclic, newValue: { ...cyclic } })).toEqual({ write: true })
    })

    it('🔴 is opt-in by KEY PRESENCE, so every existing caller is unaffected', () => {
      // No value keys at all — the three original rules decide, exactly as before.
      expect(writeGate({ colId: 'a', source: 'edit' })).toEqual({ write: true })
      // `undefined` is a legitimate cell value, so presence — not truthiness — has to be the test.
      // Only ONE key present must NOT trigger the rule.
      expect(writeGate({ colId: 'a', oldValue: undefined })).toEqual({ write: true })
      expect(writeGate({ colId: 'a', newValue: undefined })).toEqual({ write: true })
      // Both present and both undefined DOES trigger it.
      expect(writeGate({ colId: 'a', oldValue: undefined, newValue: undefined }).reason).toBe('unchanged')
    })

    it('the three provenance rules still outrank it — the reason names the real cause', () => {
      expect(writeGate({ colId: 'a', source: 'data', oldValue: 'x', newValue: 'x' }).reason).toBe('grid-data')
      expect(writeGate({ colId: 'a', selfInflicted: true, oldValue: 'x', newValue: 'x' }).reason).toBe('self-inflicted')
      expect(writeGate({ oldValue: 'x', newValue: 'x' }).reason).toBe('no-column')
    })
  })
})

describe('sameValue — the "unchanged" rule for list and measure cells (AM.1)', () => {
  it('an identical list is unchanged; a reordered or extended one is a change', () => {
    expect(sameValue(['a', 'b'], ['a', 'b'])).toBe(true)
    expect(sameValue(['a', 'b'], ['b', 'a'])).toBe(false)
    expect(sameValue(['a'], ['a', 'b'])).toBe(false)
    expect(sameValue([], [])).toBe(true)
  })
  it('a measure is one value whatever its key order; a different unit or value is a change', () => {
    expect(sameValue({ value: 1.2, unit: 'kilograms' }, { unit: 'kilograms', value: 1.2 })).toBe(true)
    expect(sameValue({ value: 1.2, unit: 'kilograms' }, { value: 1.2, unit: 'grams' })).toBe(false)
    expect(sameValue({ value: 1.2, unit: 'kilograms' }, { value: 1200, unit: 'kilograms' })).toBe(false)
  })
  it('a list against a scalar, or an object against an array, is never unchanged', () => {
    expect(sameValue(['a'], 'a')).toBe(false)
    expect(sameValue({ value: 1, unit: 'g' }, [1, 'g'])).toBe(false)
    expect(sameValue(null, [])).toBe(false)
  })
  it('scalars keep the identity rule', () => {
    expect(sameValue('x', 'x')).toBe(true)
    expect(sameValue(1, '1')).toBe(false)
    expect(sameValue(null, undefined)).toBe(true)
  })
})
