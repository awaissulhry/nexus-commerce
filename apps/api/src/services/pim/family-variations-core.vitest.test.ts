/**
 * VTR step 1a — the pure rules of the one variation model (docs/variation-theme/STEP1-PLAN.md, D3 a).
 *
 *  · an axis label ("Colore") resolves to ONE dictionary attribute through its code, concept or label;
 *  · a value text resolves to ONE option through its code, default label, per-language labels (metadata.labels) or synonyms;
 *  · a new option code follows the attributes lane's rule (/^[a-z][a-z0-9_]{0,63}$/, never renamed);
 *  · the backfill planner reads the three value stores and REPORTS every conflict, empty slot and duplicate — it decides nothing.
 */
import { describe, expect, it } from 'vitest'
import { attributeForAxis, codeForNewOption, matchValue, newOptionCode, optionForValue, planFamilyVariations, type DictionaryAttribute } from './family-variations-core.js'

const option = (code: string, label: string, extra: Partial<DictionaryAttribute['options'][number]> = {}) =>
  ({ id: `o-${code}`, code, label, metadata: null, synonyms: [], sortOrder: 0, archivedAt: null, ...extra })
const COLOR: DictionaryAttribute = { id: 'a-color', code: 'color', label: 'Color', semanticKey: 'color', archivedAt: null, options: [
  option('black', 'Black', { metadata: { labels: { it: 'Nero', en: 'Black' } }, sortOrder: 1 }),
  option('orange', 'Orange', { metadata: { labels: { it: 'Arancione' } }, synonyms: ['Arancia'], sortOrder: 2 }),
  option('red', 'Red', { archivedAt: new Date('2026-09-01'), sortOrder: 3 }),
] }
const SIZE: DictionaryAttribute = { id: 'a-size', code: 'size', label: 'Size', semanticKey: 'size', archivedAt: null, options: [
  option('m', 'M'), option('l', 'L'), option('xxl', 'XXL'), option('xs', 'XS'),
] }
const FIT: DictionaryAttribute = { id: 'a-fit', code: 'fit_type', label: 'Fit Type', semanticKey: null, archivedAt: null, options: [] }

describe('attributeForAxis', () => {
  it('a family axis label reaches its attribute through the concept (Colore → color, Taglia → size)', () => {
    expect(attributeForAxis('Colore', [COLOR, SIZE, FIT])).toEqual({ attribute: COLOR })
    expect(attributeForAxis('Taglia', [COLOR, SIZE, FIT])).toEqual({ attribute: SIZE })
    expect(attributeForAxis('Size', [COLOR, SIZE, FIT])).toEqual({ attribute: SIZE })
  })

  it('an axis with no concept matches by code or label; nothing matching is reported, never guessed', () => {
    expect(attributeForAxis('Fit Type', [COLOR, SIZE, FIT])).toEqual({ attribute: FIT })
    expect(attributeForAxis('fit_type', [COLOR, SIZE, FIT])).toEqual({ attribute: FIT })
    expect(attributeForAxis('Materiale', [COLOR, SIZE, FIT])).toEqual({ attribute: null, reason: 'no-attribute' })
  })

  it('the concept attribute beats a business attribute that only shares the label', () => {
    const second = { ...FIT, id: 'a-colour-2', code: 'colour_shade', label: 'Colore', semanticKey: null }
    expect(attributeForAxis('Colore', [second, COLOR])).toEqual({ attribute: COLOR })
  })

  it('two attributes that claim the axis equally are ambiguous — reported, not picked', () => {
    const one = { ...FIT, id: 'a-m1', code: 'material_outer', label: 'Materiale', semanticKey: null }
    const two = { ...FIT, id: 'a-m2', code: 'material_lining', label: 'Materiale', semanticKey: null }
    expect(attributeForAxis('Materiale', [one, two])).toEqual({ attribute: null, reason: 'ambiguous', candidates: ['material_lining', 'material_outer'] })
  })

  it('an archived attribute is never chosen', () => {
    expect(attributeForAxis('Colore', [{ ...COLOR, archivedAt: new Date() }])).toEqual({ attribute: null, reason: 'no-attribute' })
  })
})

describe('optionForValue', () => {
  it('matches the code, the default label, a per-language label and a synonym, ignoring case and spacing', () => {
    expect(optionForValue('black', COLOR)?.code).toBe('black')
    expect(optionForValue(' Black ', COLOR)?.code).toBe('black')
    expect(optionForValue('NERO', COLOR)?.code).toBe('black')
    expect(optionForValue('Arancione', COLOR)?.code).toBe('orange')
    expect(optionForValue('arancia', COLOR)?.code).toBe('orange')
  })

  it('an archived option still matches (saved values stay valid); an unknown text matches nothing', () => {
    expect(optionForValue('Red', COLOR)?.code).toBe('red')
    expect(optionForValue('Verde', COLOR)).toBeNull()
    expect(optionForValue('', COLOR)).toBeNull()
  })
})

describe('matchValue — the value is saved as the dictionary spells the name it matched (never another language)', () => {
  it('keeps the language: "nero " → "Nero" (Italian label), "black" → "Black" (code → default label)', () => {
    expect(matchValue('nero ', COLOR)).toEqual({ option: 'black', spelled: 'Nero' })
    expect(matchValue('BLACK', COLOR)).toEqual({ option: 'black', spelled: 'Black' })
  })
  it('a synonym keeps its own dictionary spelling; an unknown text matches nothing', () => {
    expect(matchValue('arancia', COLOR)).toEqual({ option: 'orange', spelled: 'Arancia' })
    expect(matchValue('Verde', COLOR)).toBeNull()
  })
})

describe('newOptionCode', () => {
  it('follows the attributes lane rule and never collides', () => {
    expect(newOptionCode('Verde Scuro', [])).toBe('verde_scuro')
    expect(newOptionCode('3XL', [])).toBe('v_3xl')
    expect(newOptionCode('Verde', ['verde'])).toBe('verde_2')
    expect(newOptionCode('Ärmel/Ü', [])).toMatch(/^[a-z][a-z0-9_]{0,63}$/)
    expect(newOptionCode('x'.repeat(90), [])).toHaveLength(64)
  })
})

describe('codeForNewOption — one code set with the attributes lane (concept codes first)', () => {
  it('a value the concept list knows gets the concept code, converted by the starter rule ("Verde" → green, "3XL" → 3xl)', () => {
    expect(codeForNewOption('Verde', COLOR)).toBe('green')
    expect(codeForNewOption('3XL', SIZE)).toBe('3xl')
  })
  it('a value the concept does not know gets a code from its text; an attribute with no concept too', () => {
    expect(codeForNewOption('XXS', SIZE)).toBe('xxs')
    expect(codeForNewOption('Crema e Vino | Giacca', COLOR)).toBe('crema_e_vino_giacca')
    expect(codeForNewOption('Slim', FIT)).toBe('slim')
  })
  it('never reuses a code the attribute already has', () => {
    expect(codeForNewOption('Nero', COLOR)).toBe('black_2')
  })
})

describe('planFamilyVariations — the backfill report (decides nothing)', () => {
  const variant = (id: string, stores: { variations?: Record<string, unknown>; flat?: Record<string, unknown>; legacy?: Record<string, unknown> }, included = true) =>
    ({ id, sku: id.toUpperCase(), included, categoryAttributes: { ...(stores.flat ?? {}), ...(stores.variations ? { variations: stores.variations } : {}) }, variantAttributes: stores.legacy ?? null })

  it('resolves axes and values, and names every conflict, empty slot, unknown value and duplicate', () => {
    const plan = planFamilyVariations({
      familyId: 'f', sku: 'FAM', variationAxes: ['Colore', 'Taglia'], variationTheme: 'Colore,Taglia', attributes: [COLOR, SIZE],
      variants: [
        variant('a', { variations: { Color: 'Nero', Size: 'M' } }),
        variant('b', { variations: { Colore: 'Arancia' }, legacy: { Taglia: 'L' } }),        // size only in the legacy store
        variant('c', { variations: { Color: 'Nero', Size: 'XXL' }, flat: { Size: 'XS' } }),  // two stores disagree
        variant('d', { variations: { Color: 'Verde', Size: 'M' } }),                         // value not in the dictionary
        variant('e', { variations: { Color: 'Nero' } }),                                     // empty size
        variant('f', { variations: { Color: 'Black', Size: 'm' } }),                         // same option as 'a' → duplicate
      ],
    })
    expect(plan.axes).toEqual([{ label: 'Colore', attributeCode: 'color' }, { label: 'Taglia', attributeCode: 'size' }])
    const cell = (id: string, code: string) => plan.variants.find(v => v.id === id)!.values[code]
    expect(cell('a', 'color')).toMatchObject({ text: 'Nero', option: 'black', from: 'variations' })
    expect(cell('b', 'size')).toMatchObject({ text: 'L', option: 'l', from: 'legacy' })
    expect(cell('c', 'size')).toMatchObject({ text: 'XXL', option: 'xxl', from: 'variations', conflict: ['XS', 'XXL'] })
    expect(cell('d', 'color')).toMatchObject({ text: 'Verde', option: null, newOption: 'green' })
    expect(cell('e', 'size')).toMatchObject({ text: '', option: null, empty: true })
    expect(plan.issues.map(i => i.kind).sort()).toEqual(['duplicate', 'empty', 'new-option', 'store-conflict', 'store-legacy-only'])
    expect(plan.issues.find(i => i.kind === 'duplicate')).toMatchObject({ skus: ['A', 'F'] })
  })

  it('a family with a theme text and NO axes is reported, not invented', () => {
    const plan = planFamilyVariations({ familyId: 'x', sku: 'XRACING', variationAxes: [], variationTheme: 'Fit Type / Size Name / Color Name', attributes: [COLOR, SIZE], variants: [] })
    expect(plan.axes).toEqual([])
    expect(plan.issues).toEqual([{ kind: 'theme-without-axes', theme: 'Fit Type / Size Name / Color Name' }])
  })

  it('an axis with no dictionary attribute is reported and its values are left as they are', () => {
    const plan = planFamilyVariations({ familyId: 'f', sku: 'FAM', variationAxes: ['Materiale'], variationTheme: null, attributes: [COLOR],
      variants: [variant('a', { variations: { Materiale: 'Pelle' } })] })
    expect(plan.axes).toEqual([{ label: 'Materiale', attributeCode: null, reason: 'no-attribute' }])
    expect(plan.variants[0].values).toEqual({})
    expect(plan.issues).toEqual([{ kind: 'axis-without-attribute', axis: 'Materiale', reason: 'no-attribute' }])
  })

  it('an excluded variant still reports its gaps but never counts in a duplicate', () => {
    const plan = planFamilyVariations({ familyId: 'f', sku: 'FAM', variationAxes: ['Colore'], variationTheme: null, attributes: [COLOR],
      variants: [variant('a', { variations: { Color: 'Nero' } }), variant('b', { variations: { Color: 'Nero' } }, false)] })
    expect(plan.issues.filter(i => i.kind === 'duplicate')).toEqual([])
  })
})
