import { describe, expect, it } from 'vitest'
import { resolveAttributes } from '../attribute-resolver.js'
import { resolveChannelField } from '../resolve-channel-field.js'

const parent = { id: 'parent', parentId: null, localizedContent: {}, variantAttributes: {}, categoryAttributes: { size: 'Parent size', color: 'Parent color' } }
const child = (variantAttributes: Record<string, unknown>, categoryAttributes = {}) => ({ ...parent, id: 'child', parentId: parent.id, variantAttributes, categoryAttributes })
describe('canonical variation source mappings', () => {
  it('reads stored English and localized axes through flat and legacy dotted rules', () => {
    for (const bag of [{ Color: 'Nero', Size: 'M' }, { Colore: 'Nero', Taglia: 'M' }, { Farbe: 'Nero', Größe: 'M' }]) {
      const product = child(bag), resolvedAttrs = resolveAttributes({ product, parent, locale: 'it' })
      for (const source of ['color', 'categoryAttributes.color']) expect(resolveChannelField({ fieldKey: 'color', rule: { source }, resolvedAttrs, product, locale: 'it' }).value).toBe('Nero')
      expect(resolvedAttrs.size).toMatchObject({ value: 'M', source: 'variant', inheritedFrom: 'child' })
    }
  })
  it('preserves explicit canonical values and nulls over aliases and parent data', () => {
    expect(resolveAttributes({ product: child({ Color: 'Black', color: null }), parent }).color.value).toBeNull()
    expect(resolveAttributes({ product: child({ Size: 'L', size: 'S' }), parent }).size.value).toBe('S')
    expect(resolveAttributes({ product: child({ Size: 'L' }, { size: null }), parent }).size.value).toBeNull()
    const resolved = resolveAttributes({ product: child({ 'Style Name': 'Touring', 'Body Type': 'Uomo' }), parent })
    expect(resolved).toMatchObject({ style: { value: 'Touring' }, 'Body Type': { value: 'Uomo' } })
    expect(resolved.body_type).toBeUndefined()
  })
  it('reports conflicting aliases instead of choosing by insertion order or reviving a parent value', () => {
    const product = child({ Color: 'Black', Colore: 'Red' }), resolvedAttrs = resolveAttributes({ product, parent })
    const result = resolveChannelField({ fieldKey: 'color', rule: { source: 'categoryAttributes.color' }, resolvedAttrs, product, locale: 'en' })
    expect(result.value).toBeNull()
    expect(result.warnings.join(' ')).toContain('Conflicting variant attributes')
  })
})
