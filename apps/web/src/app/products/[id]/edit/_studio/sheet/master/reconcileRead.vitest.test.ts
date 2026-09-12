import { describe, expect, it } from 'vitest'

import { readRowValues } from './reconcileRead'

/**
 * 🔴 The one distinction: a read that did not answer (`null`) vs a row that holds nothing (`{}`).
 *
 * The writer resolves every `unknown` cell by comparing the typed value against what comes back.
 * If a failed or unrecognisable read returned `{}`, every comparison would fail and every pending
 * cell would resolve to "not saved; retype to try again" — a page of confident wrong answers
 * produced by an outage, which is precisely what `unknown` was introduced to stop.
 */
describe('readRowValues', () => {
  const body = (rows: unknown) => ({ rows })

  it('returns the row values, unwrapped from their cell envelopes', () => {
    const v = readRowValues(body([{ id: 'p1', values: { name: { value: 'Merino Throw' }, qty: { value: 12 } } }]), 'p1')
    expect(v).toEqual({ name: 'Merino Throw', qty: 12 })
  })

  it('picks the row it was asked for, not the first one', () => {
    const v = readRowValues(body([{ id: 'p0', values: { name: { value: 'wrong' } } }, { id: 'p1', values: { name: { value: 'right' } } }]), 'p1')
    expect(v).toEqual({ name: 'right' })
  })

  it('🔴 null — never {} — when the row is absent', () => {
    // The row we wrote is not in the response: we did not learn what the database holds.
    expect(readRowValues(body([{ id: 'p9', values: { name: { value: 'x' } } }]), 'p1')).toBeNull()
  })

  it('🔴 null for a body that cannot answer at all', () => {
    for (const b of [null, undefined, {}, { rows: null }, { rows: 'nope' }, 'a string', 42]) {
      expect(readRowValues(b, 'p1')).toBeNull()
    }
  })

  it('🔴 null for a row with no values, and for an EMPTY values object', () => {
    // An empty `values` is the trap: it is a legal object, it destructures fine, and it answers
    // "not saved" for every column while telling us nothing about any of them.
    expect(readRowValues(body([{ id: 'p1' }]), 'p1')).toBeNull()
    expect(readRowValues(body([{ id: 'p1', values: null }]), 'p1')).toBeNull()
    expect(readRowValues(body([{ id: 'p1', values: {} }]), 'p1')).toBeNull()
  })

  it('a column present but empty IS an answer — the cell is genuinely blank', () => {
    // Distinct from the case above: the row answered, and what it holds for `name` is nothing.
    // That resolves a write of '' to `saved` and a write of 'x' to `refused`, both correctly.
    expect(readRowValues(body([{ id: 'p1', values: { name: { value: null }, qty: { value: 3 } } }]), 'p1')).toEqual({ name: null, qty: 3 })
    expect(readRowValues(body([{ id: 'p1', values: { name: null, qty: { value: 3 } } }]), 'p1')).toEqual({ name: undefined, qty: 3 })
  })
})
