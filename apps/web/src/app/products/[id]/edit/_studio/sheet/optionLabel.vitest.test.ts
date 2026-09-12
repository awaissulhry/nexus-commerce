import { describe, expect, it } from 'vitest'

import { optionLabel } from './optionLabel'

const LABELS = { PK: 'Pakistan', IT: 'Italia' }

describe('optionLabel — one way to show a coded value (#501)', () => {
  it('maps a code to its label', () => {
    expect(optionLabel('PK', LABELS)).toBe('Pakistan')
  })

  it('🔴 an UNMAPPED code falls back to the code, never to blank', () => {
    // A missing label is a gap in the schema. Blanking would present a cell that HAS data as empty,
    // and on an import diff it would read as a value being removed.
    expect(optionLabel('ZZ', LABELS)).toBe('ZZ')
    expect(optionLabel('PK')).toBe('PK')
    expect(optionLabel('PK', null)).toBe('PK')
  })

  it('empty is empty — and is never looked up', () => {
    // A lookup of '' would return a label if the schema ever carried one for it, which would put a
    // country name in a cell that has no value.
    for (const v of [null, undefined, '']) expect(optionLabel(v, { ...LABELS, '': 'Nothing' })).toBe('')
  })

  it('coerces a non-string code rather than dropping it', () => {
    // Amazon serves numeric-looking codes as numbers on some fields.
    expect(optionLabel(1, { '1': 'One' })).toBe('One')
    expect(optionLabel(2, { '1': 'One' })).toBe('2')
    expect(optionLabel(false, {})).toBe('false')
  })

  it('🔴 zero is a VALUE, not an absence', () => {
    // `0` is falsy, so a `!value` guard would blank it — and `0` is a real code on more than one
    // Amazon enum.
    expect(optionLabel(0, { '0': 'Zero' })).toBe('Zero')
    expect(optionLabel(0, {})).toBe('0')
  })
})
