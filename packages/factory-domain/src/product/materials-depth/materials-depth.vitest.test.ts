import { describe, expect, it } from 'vitest'
import { lineWeight, weightOf, type LineFacts, type MaterialFacts } from '../../compliance/textile-rules/composition'
import { EVENT_DEFINITIONS } from '../../events/catalogue'
import { FACTORY_PERMISSIONS } from '../../auth/permissions/catalogue'
import { templateOf } from '../../auth/roles/templates'
import {
  approvalConsequences,
  approvalProblems,
  changedProperties,
  fibreReadings,
  kindChangeProblem,
  normaliseProperties,
  noteOf,
  propertiesProblems,
  shapeOf,
  typedWeight,
  whereUsedOrder,
} from './rules'

/** Materials in depth (B-W2b-238): the typed properties per kind, the fibres as the label reads them, the approval, where used. */

describe('the properties of its kind (PRD-029)', () => {
  it('takes only its kind’s fields, decimals as strings above 0, the EN 1621 level, nickel free as yes or no', () => {
    expect(shapeOf('LINING')).toBe('TEXTILE')
    expect(shapeOf('HARDWARE')).toBe('TRIM')
    expect(shapeOf('LEATHER')).toBeNull()
    expect(propertiesProblems('TEXTILE', { weightGsm: '180', widthCm: '150.5', construction: 'woven' })).toEqual([])
    expect(propertiesProblems('PROTECTOR', { standard: 'EN 1621-1:2012', type: 'shoulder', level: '2', size: 'A' })).toEqual([])
    expect(propertiesProblems('TRIM', { material: 'brass', finish: 'matte', size: '5', nickelFree: true })).toEqual([])
    expect(propertiesProblems('LEATHER', null)).toEqual([])
    expect(propertiesProblems('TEXTILE', { weightGsm: '0' })).toEqual([{ path: 'properties/weightGsm', message: expect.stringContaining('above 0') }])
    expect(propertiesProblems('TEXTILE', { widthCm: '1.23456' })[0]!.path).toBe('properties/widthCm')
    expect(propertiesProblems('TEXTILE', { level: '2' })[0]!.message).toMatch(/textile material has no "level"/)
    expect(propertiesProblems('PROTECTOR', { level: '3' })).toEqual([{ path: 'properties/level', message: 'The EN 1621 level is 1 or 2.' }])
    expect(propertiesProblems('TRIM', { nickelFree: 'yes' })).toEqual([{ path: 'properties/nickelFree', message: 'Nickel free is yes or no.' }])
    expect(propertiesProblems('PROTECTOR', { type: 'x'.repeat(101) })[0]!.path).toBe('properties/type')
    expect(propertiesProblems('PROTECTOR', { type: 'two\nlines' })[0]!.path).toBe('properties/type')
    expect(propertiesProblems('LEATHER', { weightGsm: '1' })[0]!.message).toMatch(/Other attributes/)
  })

  it('keeps what was typed in its plain form, drops what was left empty, and names what changed', () => {
    expect(normaliseProperties({ weightGsm: ' 180.50 ', widthCm: '', construction: ' woven ', level: null })).toEqual({ weightGsm: '180.5', construction: 'woven' })
    expect(normaliseProperties({ widthCm: '  ' })).toBeNull()
    expect(normaliseProperties(null)).toBeNull()
    expect(changedProperties({ weightGsm: '180', construction: 'woven' }, { weightGsm: '200', construction: 'woven', widthCm: '150' })).toEqual(['weightGsm', 'widthCm'])
    expect(changedProperties(null, null)).toEqual([])
  })

  it('refuses a kind change that would drop typed properties, in words', () => {
    expect(kindChangeProblem('DEMO-1', { weightGsm: '180' }, 'LINING')).toBeNull()
    expect(kindChangeProblem('DEMO-1', { weightGsm: '180' }, 'LEATHER')).toMatch(/clear them on Properties & grades before it becomes a leather material/)
    expect(kindChangeProblem('DEMO-1', null, 'LEATHER')).toBeNull()
  })
})

describe('the fibres as the label reads them (PRD-033)', () => {
  it('reads each fibre against Annex I: official, another word, a trade mark, leather, unknown', () => {
    const [official, word, mark, leather, unknown] = fibreReadings([
      { fibre: 'poliammide', percent: '60' },
      { fibre: 'nylon', percent: '20' },
      { fibre: 'Cordura', percent: '10' },
      { fibre: 'pelle', percent: '5' },
      { fibre: 'moonfibre', percent: '5' },
    ])
    expect(official).toMatchObject({ annexFibre: 'polyamide', official: { it: 'poliammide', en: 'polyamide' }, finding: null })
    expect(word).toMatchObject({ annexFibre: 'polyamide', finding: 'NOT_OFFICIAL', message: expect.stringContaining('the label says polyamide') })
    expect(mark).toMatchObject({ finding: 'TRADE_MARK' })
    expect(leather).toMatchObject({ finding: 'NOT_TEXTILE', official: null })
    expect(unknown).toMatchObject({ finding: 'UNKNOWN' })
    expect(fibreReadings(null)).toEqual([])
  })
})

describe('the approval (PRD-035)', () => {
  it('needs why for a condition and a block, on one line', () => {
    expect(approvalProblems('APPROVED', null)).toEqual([])
    expect(approvalProblems('PENDING', 'Sent back: new supplier')).toEqual([])
    expect(approvalProblems('BLOCKED', null)[0]).toMatchObject({ path: 'body/note', message: expect.stringContaining('blocked') })
    expect(approvalProblems('CONDITIONAL', null)[0]!.message).toMatch(/condition/)
    expect(approvalProblems('BLOCKED', 'a\nb')[0]!.path).toBe('body/note')
    expect(approvalProblems('BLOCKED', 'x'.repeat(1001))[0]!.path).toBe('body/note')
    expect(noteOf('  ')).toBeNull()
    expect(noteOf(' Nickel ')).toBe('Nickel')
  })

  it('says what a block reaches', () => {
    expect(approvalConsequences('APPROVED', { draftRevisions: 2, releasedRevisions: 1, openWorkOrders: 3 })).toEqual([])
    const words = approvalConsequences('BLOCKED', { draftRevisions: 2, releasedRevisions: 1, openWorkOrders: 3 })
    expect(words).toEqual(['No new BOM line takes it.', expect.stringContaining('2 draft revision(s)'), expect.stringContaining('their 3 open work order(s) go on')])
  })

  it('is declared: the permission (production manager and quality), the event', () => {
    expect(FACTORY_PERMISSIONS.isDeclared('product.materials.approve')).toBe(true)
    expect(templateOf('production_manager')?.permissions).toContain('product.materials.approve')
    expect(templateOf('quality_inspector')?.permissions).toContain('product.materials.approve')
    expect(templateOf('sales')?.permissions ?? []).not.toContain('product.materials.approve')
    expect(EVENT_DEFINITIONS.some((event) => event.type === 'material.approval_changed')).toBe(true)
  })
})

describe('where used (PRD-036)', () => {
  it('reads current revisions first, then by style, newest revision, line, the line before its alternates', () => {
    const row = (code: string, revision: number, status: string, seq: number, role: 'LINE' | 'ALTERNATE' = 'LINE') => ({ style: { code }, revision: { revision, status }, seq, role })
    const ordered = whereUsedOrder([row('B', 1, 'OBSOLETE', 10), row('B', 2, 'RELEASED', 10), row('A', 3, 'DRAFT', 20, 'ALTERNATE'), row('A', 3, 'DRAFT', 20), row('A', 3, 'DRAFT', 10)])
    expect(ordered.map((entry) => `${entry.style.code}${entry.revision.revision}:${entry.seq}${entry.role[0]}`)).toEqual(['A3:10L', 'A3:20L', 'A3:20A', 'B2:10L', 'B1:10L'])
  })
})

describe('the typed weight feeds the textile composition (B-W2b-208)', () => {
  const units = { baseUom: 'M' as const, purchaseUom: 'M' as const, purchaseFactor: '1', consumptionUom: 'M' as const, consumptionFactor: '1' }
  const fabric = (over: Partial<MaterialFacts> = {}): MaterialFacts => ({ id: 'f', code: 'DEMO-TXT', name: 'Demo fabric', kind: 'TEXTILE', composition: [{ fibre: 'polyamide', percent: '100' }], animalOrigin: false, attributes: null, units, ...over })
  const line = (material: MaterialFacts, qty: string, uom: LineFacts['uom'] = 'M'): LineFacts => ({ seq: 10, placement: null, qty, uom, material })

  it('reads the typed g/m² first, the attribute after, and weighs a length by the typed width', () => {
    expect(typedWeight({ weightGsm: '200', widthCm: '150' })).toEqual({ gsm: '200', widthCm: '150' })
    expect(typedWeight({ construction: 'woven' })).toBeNull()
    expect(weightOf(fabric({ properties: { weightGsm: '200' }, attributes: { weight: '180 g/m2' } }))).toMatchObject({ per: 'M2', text: '200 g/m2' })
    expect(weightOf(fabric({ attributes: { weight: '180 g/m2' } }))).toMatchObject({ text: '180 g/m2' })
    // 1.5 m of a 150 cm wide 200 g/m² fabric = 1.5 × 1.5 × 200 = 450 g.
    const weighed = lineWeight(line(fabric({ properties: { weightGsm: '200', widthCm: '150' } }), '1.5'))
    expect(weighed.grams?.toString()).toBe('450')
    // Without the width a length cannot be weighed per m²: said, never guessed.
    expect(lineWeight(line(fabric({ properties: { weightGsm: '200' } }), '1.5'))).toMatchObject({ grams: null })
    expect(lineWeight(line(fabric(), '1.5'))).toMatchObject({ grams: null, why: expect.stringContaining('Properties & grades') })
  })
})
