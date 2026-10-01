import { describe, expect, it } from 'vitest'
import { resetActionWords, resetSourceLabel } from './value-source'
import type { MappedCell, StudioCellValue } from './types'

const mapping = (over: Partial<MappedCell> = {}): MappedCell => ({
  value: 'Xavia', status: 'mapped', provenance: 'catalogRule', sourcePath: 'brand',
  appliedTransforms: [], warnings: [], errors: [], autoCorrected: null, requiredByRule: false, overLimit: null, ...over,
})
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Xavia', source: 'master', inheritedFrom: null, inherited: false,
  layer: 'master', pinned: false, follows: null, editable: true, linkGroupId: null,
  mapped: mapping(), writeField: 'attr_brand', writeTarget: 'channelListing',
  writeVerb: 'channel', affectsAllChannels: false, writable: true, ...over,
})
describe('channel reset destination', () => {
  it('does not promise Master after reset without a declared source', () => {
    expect(resetSourceLabel(cell())).toBe('follow Master')
    expect(resetSourceLabel(cell({ mapped: mapping({ sourcePath: null }) }))).toContain('may become empty')
    expect(resetSourceLabel(cell({ mapped: mapping({ usesExpression: true }) }))).toContain('configured mapping')
  })
})

describe('reset words (P1)', () => {
  const subject = { sku: 'REGAL-JACKET-L-BLACK-MEN', listing: 'Primary' }
  it('calls the reset of an old listing text "Follow Shared"', () => {
    const words = resetActionWords(cell({ source: 'channelSnapshot', writeField: 'ebay_title', mapped: mapping({ sourcePath: 'title' }) }), subject)
    expect(words.label).toBe('Follow Shared')
    expect(words.description).toBe('Stop using this listing’s own text for REGAL-JACKET-L-BLACK-MEN · Primary and follow Master.')
  })
  it('keeps the override words for an override and for a whole list', () => {
    expect(resetActionWords(cell({ layer: 'channel', pinned: true }), subject).label).toBe('Remove listing override')
    expect(resetActionWords(cell({ writeField: 'imageUrls[2]' }), subject).label).toBe('Review removing list override…')
  })
})
