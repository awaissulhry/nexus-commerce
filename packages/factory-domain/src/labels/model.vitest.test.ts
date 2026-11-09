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

describe('B-W2b-219: the roll and remnant tags', () => {
  const roll = formatScanId({ type: 'ROLL', tenantTag: TAG, ref: 12 })
  const remnant = formatScanId({ type: 'REMNANT', tenantTag: TAG, ref: 7 })

  it('words a ROLL tag (RL code, length, width, shade, lot) and a REMNANT tag (RM code, area, grade, the hide)', () => {
    const tag = composeLabel({ kind: 'ROLL', language: 'it', scanId: roll, maker: 'Seed A', title: 'LIN-01 · Fodera', fields: { article: 'LIN-01', length: '25,40 m', width: '145,50 cm', shade: '1', lot: 'L-9' } })
    expect(tag).toMatchObject({ kind: 'ROLL', scanId: roll, heading: 'Rotolo · Seed A' })
    expect(tag.fields.map((field) => field.label)).toEqual(['Articolo', 'Lunghezza', 'Altezza', 'Tonalità', 'Lotto'])
    const piece = composeLabel({ kind: 'REMNANT', language: 'en', scanId: remnant, title: 'LEA-1 · Cowhide', fields: { article: 'LEA-1', area: '5.00 ft²', grade: 'A', hide: 'HD-1', lot: 'L-1' } })
    expect(piece).toMatchObject({ kind: 'REMNANT', heading: 'Remnant' })
    expect(piece.fields.map((field) => field.label)).toEqual(['Article', 'Area', 'Grade', 'Hide', 'Lot'])
  })

  it('refuses a tag that carries another kind\'s code (a hide code on a remnant tag), and a field the kind does not print', () => {
    const hide = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 3 })
    expect(labelProblems({ kind: 'REMNANT', language: 'it', scanId: hide, title: 'x' }).map((problem) => problem.path)).toEqual(['label/scanId'])
    expect(labelProblems({ kind: 'ROLL', language: 'it', scanId: roll, title: 'x', fields: { grossWeight: '1 kg' } as LabelInput['fields'] }).map((problem) => problem.path)).toEqual(['label/fields/grossWeight'])
  })
})

