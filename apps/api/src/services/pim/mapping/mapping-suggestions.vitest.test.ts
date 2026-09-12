import { beforeEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ catalogue: vi.fn(), sources: vi.fn() }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: mocks.catalogue }))
vi.mock('./mapping-sources.service.js', () => ({ getMappingSources: mocks.sources }))
import { suggestMappings } from '../mapping-suggest.service.js'

beforeEach(() => {
  mocks.catalogue.mockResolvedValue({ channel: 'AMAZON', productType: 'OUTERWEAR', fields: [
    { fieldKey: 'brand', label: 'Brand', status: 'mapped', ruleOrigin: 'master' },
    { fieldKey: 'pattern', label: 'Pattern', status: 'unmapped', priority: 'required' },
    { fieldKey: 'sleeve_type', label: 'Sleeve type', status: 'unmapped', priority: 'optional' },
    { fieldKey: 'legacy', label: 'Legacy', status: 'unmapped', schemaKnown: false },
  ] })
  mocks.sources.mockResolvedValue({ sources: [{ path: 'brand' }, { path: 'pattern' }] })
})
describe('canonical auto-map', () => {
  it('uses the same category fields, skips automatic inheritance, and binds the preview sample', async () => {
    const r = await suggestMappings({ channel: 'AMAZON', code: 'IT', productType: 'OUTERWEAR', productId: 'p' })
    expect(r.unmappedTotal).toBe(2)
    expect(r.suggestions).toEqual([{ fieldKey: 'pattern', label: 'Pattern', suggestedSource: 'pattern', confidence: 'high', reason: 'Matches an existing Master attribute code', required: true }])
    expect(mocks.sources).toHaveBeenCalledWith({ marketplace: 'IT', productId: 'p' })
    expect(mocks.catalogue).toHaveBeenCalledWith({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
  })
})
