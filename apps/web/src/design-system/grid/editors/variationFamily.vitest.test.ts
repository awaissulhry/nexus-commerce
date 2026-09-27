import { describe, expect, it } from 'vitest'
import { axisRemovalRefusal, axisValueCount, familyAxisFor, filterVariants, orderValues, valueOrderAfterDrag, type VariationFamilyView } from './variationFamily'

/* Made-up family: Colore × Taglia; one colour value is not in the dictionary. */
const view: VariationFamilyView = {
  axes: [
    { code: 'color', label: 'Colore', dictionary: true, values: [
      { key: 'color:black', option: 'black', label: 'Nero', count: 3, photo: 'https://x/nero.png' },
      { key: 'color:yellow', option: 'yellow', label: 'Giallo', count: 2, photo: null },
      { key: 'color:text:camo', option: null, label: 'Camo', count: 1, photo: null },
    ] },
    { code: 'size', label: 'Taglia', dictionary: true, values: [
      { key: 'size:s', option: 's', label: 'S', count: 3, photo: null }, { key: 'size:m', option: 'm', label: 'M', count: 3, photo: null },
    ] },
  ],
  variants: [
    { id: 'v1', sku: 'SAMPLE-BLACK-S', label: 'Nero · S', photo: null },
    { id: 'v2', sku: 'SAMPLE-YELLOW-M', label: 'Giallo · M', photo: null },
  ],
}

describe('matching a cell axis to the family', () => {
  it('matches by spelling or code, blind to case and accents', () => {
    expect(familyAxisFor(view, { axisKey: 'color', label: 'Color' })?.label).toBe('Colore')
    expect(familyAxisFor(view, { axisKey: 'x', familyKey: 'COLORE', label: 'x' })?.code).toBe('color')
    expect(familyAxisFor(view, { axisKey: 'material', label: 'Material' })).toBeUndefined()
    expect(familyAxisFor(null, { axisKey: 'color', label: 'Color' })).toBeUndefined()
  })
})

describe('removing an axis', () => {
  it('is refused while variants carry its values, with the count', () => {
    const colore = familyAxisFor(view, { axisKey: 'color', label: 'Colore' })
    expect(axisValueCount(colore)).toBe(6)
    expect(axisRemovalRefusal('Colore', colore)).toBe('Colore has values on 6 variants — clear them first, then remove Colore.')
  })
  it('is allowed for an axis nothing carries, and falls back to the cell count while loading', () => {
    expect(axisRemovalRefusal('Fit', { code: 'fit', label: 'Fit', dictionary: true, values: [] })).toBeNull()
    expect(axisRemovalRefusal('Taglia', undefined, 1)).toBe('Taglia has values on 1 variant — clear them first, then remove Taglia.')
    expect(axisRemovalRefusal('Taglia', undefined, 0)).toBeNull()
  })
})

describe('value order', () => {
  const colore = view.axes[0]
  it('saves the dragged order by option code, leaving out values the dictionary lacks', () => {
    expect(valueOrderAfterDrag(colore, ['color:yellow', 'color:text:camo', 'color:black'])).toEqual(['yellow', 'black'])
  })
  it('answers null when the dictionary order did not change', () => {
    expect(valueOrderAfterDrag(colore, ['color:black', 'color:text:camo', 'color:yellow'])).toBeNull()
  })
  it('shows a draft order, keeping values outside it after', () => {
    expect(orderValues(colore, ['yellow', 'black']).map(v => v.label)).toEqual(['Giallo', 'Nero', 'Camo'])
    expect(orderValues(colore, undefined)).toBe(colore.values)
  })
})

describe('variants', () => {
  it('filters by values and SKU', () => {
    expect(filterVariants(view.variants, 'giallo').map(v => v.id)).toEqual(['v2'])
    expect(filterVariants(view.variants, 'black-s').map(v => v.id)).toEqual(['v1'])
    expect(filterVariants(view.variants, '')).toHaveLength(2)
  })
})
