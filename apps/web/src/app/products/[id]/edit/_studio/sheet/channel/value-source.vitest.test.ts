import { describe, expect, it } from 'vitest'
import { channelResetLabel, resetActionWords, resetSourceLabel } from './value-source'
import { channelResetOffer } from '../sheetReset'
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
  it('does not promise the Shared product after reset without a declared source', () => {
    expect(resetSourceLabel(cell())).toBe('follow the Shared product')
    expect(resetSourceLabel(cell({ mapped: mapping({ sourcePath: null }) }))).toContain('may become empty')
    expect(resetSourceLabel(cell({ mapped: mapping({ usesExpression: true }) }))).toContain('configured mapping')
  })
})

describe('reset words (P1)', () => {
  const subject = { sku: 'REGAL-JACKET-L-BLACK-MEN', listing: 'Primary' }
  it('calls the reset of an old listing text "Follow Shared"', () => {
    const words = resetActionWords(cell({ source: 'channelSnapshot', writeField: 'ebay_title', mapped: mapping({ sourcePath: 'title' }) }), subject)
    expect(words.label).toBe('Follow Shared')
    expect(words.description).toBe('Stop using this listing’s own text for REGAL-JACKET-L-BLACK-MEN · Primary and follow the Shared product.')
  })
  it('names the reset of an override and of a whole list with the cell menu’s one word', () => {
    expect(resetActionWords(cell({ layer: 'channel', pinned: true }), subject).label).toBe('Reset to inherited')
    expect(resetActionWords(cell({ writeField: 'imageUrls[2]' }), subject).label).toBe('Reset list to inherited…')
    expect(resetActionWords(cell({ layer: 'channel', pinned: true }), subject).description).toBe('Remove this listing override and follow the Shared product.')
  })
  it('the cell menu and Cell details say the same word for the same pinned channel cell (one function)', () => {
    for (const over of [{ layer: 'channel' as const, pinned: true }, { layer: 'channel' as const, pinned: true, writeField: 'imageUrls[2]' },
      { layer: 'channel' as const, pinned: true, source: 'channelSnapshot' as const }]) {
      const pinned = cell(over)
      const row = { rowId: 'r', rowKind: 'variant', values: { brand: pinned } } as never
      expect(channelResetOffer(row, 'brand')?.label).toBe(channelResetLabel(pinned))
      expect(resetActionWords(pinned, subject).label).toBe(channelResetLabel(pinned))
    }
  })
})
