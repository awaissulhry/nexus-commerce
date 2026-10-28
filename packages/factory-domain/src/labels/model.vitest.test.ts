import { describe, expect, it } from 'vitest'
import { ValidationError } from '../core/errors'
import { formatScanId, tenantTag } from '../numbering/scan-id'
import { composeLabel, labelProblems, labelText, type LabelInput } from './model'

const TAG = tenantTag('0199f0a0-0000-7000-8000-000000000001')
const OTHER_TAG = tenantTag('0199f0a0-0000-7000-8000-0000000000ff')
const lot = formatScanId({ type: 'LOT', tenantTag: TAG, ref: 501 })
const input = (fields: Partial<LabelInput> = {}): LabelInput => ({ kind: 'LOT', language: 'it', scanId: lot, maker: 'Seed A', title: 'Vacchetta 1.4', fields: { supplier: 'Conceria Esempio', quantity: '120 m²' }, ...fields })

describe('composeLabel', () => {
  it('words the label in its language, in the kind\'s field order, and prints the scannable id canonically', () => {
    const typed = lot.toLowerCase().replace(/-/g, '').replace(/0/g, 'o')
    const label = composeLabel(input({ scanId: typed, fields: { quantity: '120 m²', supplier: 'Conceria Esempio', supplierLot: '  L-77  ' } }))
    expect(label).toEqual({
      kind: 'LOT',
      language: 'it',
      scanId: lot,
      heading: 'Lotto · Seed A',
      title: 'Vacchetta 1.4',
      fields: [
        { key: 'supplier', label: 'Fornitore', value: 'Conceria Esempio' },
        { key: 'supplierLot', label: 'Lotto fornitore', value: 'L-77' },
        { key: 'quantity', label: 'Quantità', value: '120 m²' },
      ],
    })
    expect(composeLabel(input({ language: 'en', maker: null })).heading).toBe('Lot')
    expect(composeLabel(input({ language: 'en' })).fields.map((field) => field.label)).toEqual(['Supplier', 'Quantity'])
  })

  it('refuses another kind\'s code, another factory\'s code, a typo, a field the kind does not print and an empty title', () => {
    const bundle = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 501 })
    expect(labelProblems(input({ scanId: bundle })).map((problem) => problem.path)).toEqual(['label/scanId'])
    expect(labelProblems(input(), { tenantTag: OTHER_TAG })[0]?.message).toMatch(/another factory/)
    expect(labelProblems(input({ scanId: `${lot.slice(0, -1)}${lot.endsWith('A') ? 'B' : 'A'}` }))[0]?.message).toMatch(/typo/)
    expect(labelProblems(input({ fields: { pieces: '12' } as LabelInput['fields'] })).map((problem) => problem.path)).toEqual(['label/fields/pieces'])
    expect(labelProblems(input({ title: '   ' })).map((problem) => problem.path)).toEqual(['label/title'])
    expect(() => composeLabel(input({ scanId: bundle }))).toThrow(ValidationError)
    expect(labelProblems(input(), { tenantTag: TAG })).toEqual([])
  })

  it('keeps label text to one clean line', () => {
    expect(labelText(' a\tb\n\u0007c  ')).toBe('a b c')
    expect([...labelText('x'.repeat(200))]).toHaveLength(80)
  })
})
