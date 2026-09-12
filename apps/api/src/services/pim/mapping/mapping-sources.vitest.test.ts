import { describe, expect, it, vi } from 'vitest'
vi.mock('../../../db.js', () => ({ default: {} }))
import { mappingSources } from './mapping-sources.service.js'
import { suggestKnownSource } from '../mapping-suggest.service.js'

describe('mapping source inventory', () => {
  it('retains definitions without sample values and treats false and zero as values', () => {
    const product = { id: 'p', parentId: null, localizedContent: {}, variantAttributes: {}, categoryAttributes: { enabled: false, count: 0, empty: [] } }
    const sources = mappingSources(product, null, 'en', ['unpopulated'])
    const byPath = new Map(sources.map(s => [s.path, s]))
    expect(byPath.get('unpopulated')).toMatchObject({ hasValue: false, sampleValue: null })
    expect(byPath.get('enabled')).toMatchObject({ hasValue: true, sampleValue: 'false' })
    expect(byPath.get('count')).toMatchObject({ hasValue: true, sampleValue: '0' })
    expect(byPath.get('empty')).toMatchObject({ hasValue: false })
    expect(new Set(sources.map(s => s.path)).size).toBe(sources.length)
  })
  it('samples inherited and structured paths through the rule reader', () => {
    const parent = { id: 'p', parentId: null, localizedContent: {}, variantAttributes: {}, categoryAttributes: { material: 'Cotton', measure: { value: 2, unit: 'kg' } } }
    const child = { ...parent, id: 'c', parentId: 'p', categoryAttributes: {} }
    const sources = mappingSources(child, parent, 'it', [])
    expect(sources.find(s => s.path === 'categoryAttributes.material')?.sampleValue).toBe('Cotton')
    expect(sources.find(s => s.path === 'categoryAttributes.measure.value')?.sampleValue).toBe('2')
  })
  it('works without products and refuses source guesses outside the inventory', () => {
    expect(mappingSources(null, null, 'en', ['fabric']).find(s => s.path === 'fabric')).toMatchObject({ hasValue: false })
    expect(suggestKnownSource('sleeve_type', 'Sleeve', new Set(['brand']))).toBeNull()
    expect(suggestKnownSource('pattern', 'Pattern', new Set(['pattern']))).toMatchObject({ source: 'pattern', confidence: 'high' })
    expect(suggestKnownSource('color_name', 'Color', new Set(['color']))).toMatchObject({ source: 'color' })
    expect(suggestKnownSource('color_name', 'Color', new Set(['brand']))).toBeNull()
  })
})
