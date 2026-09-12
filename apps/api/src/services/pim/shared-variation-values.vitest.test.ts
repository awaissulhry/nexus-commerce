import { describe, expect, it } from 'vitest'
import { completeAxisValueOrder, variationAttributePatch } from './shared-variation-values.js'

describe('shared variation mutation', () => {
  const product = { categoryAttributes: { material: 'Leather', variations: { Color: 'Nero', Size: 'S' } }, variantAttributes: { Colore: 'Nero', Size: 'S' } }
  it('updates declared and existing aliases in both push/read bags without changing another axis', () => {
    expect(variationAttributePatch(product, ['Colore', 'Taglia'], { color: 'Giallo' }, [])).toEqual({ changed: true, set: { Colore: 'Giallo', Color: 'Giallo' }, unset: [] })
    expect(product.categoryAttributes.variations.Size).toBe('S')
  })
  it('resets all aliases of the selected axis and leaves unrelated attributes outside this path', () => {
    expect(variationAttributePatch(product, ['Colore', 'Taglia'], {}, ['size'])).toEqual({ changed: true, set: {}, unset: ['Taglia', 'Size'] })
    expect(variationAttributePatch(product, ['Colore', 'Taglia'], { material: 'Mesh' }, [])).toEqual({ changed: false, set: {}, unset: [] })
  })
  it('preserves explicit blank values instead of mistaking them for a reset', () => {
    expect(variationAttributePatch(product, ['Colore'], { color: null }, []).set).toEqual({ Colore: null, Color: null })
  })
})

describe('shared axis order', () => {
  it('retains stored buyer order and appends unseen sizes in canonical order', () => {
    expect(completeAxisValueOrder('Taglia', ['M', 'S', 'M'], ['4XL', 'XXS', 'S', 'XS', '3XL'])).toEqual(['M', 'S', 'XXS', 'XS', '3XL', '4XL'])
  })
  it('appends colours deterministically without dropping values', () => {
    expect(completeAxisValueOrder('Colore', ['Nero'], ['Verde', 'Nero', 'Giallo'])).toEqual(['Nero', 'Giallo', 'Verde'])
  })
})
