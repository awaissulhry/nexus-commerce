import { describe, expect, it } from 'vitest'
import { describeValueSource, isRoutineSource, sourceHoverText } from './cellDetailsSource'
import type { StudioCellValue } from './types'

/** P1 — the words a cell's source mark and its Cell details say (report 2 I-3, I-4). */
const cell = (over: Partial<StudioCellValue> = {}): StudioCellValue => ({
  value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', source: 'channelSnapshot', inheritedFrom: 'listing', inherited: true,
  layer: 'channel', pinned: false, follows: true, editable: true, linkGroupId: null, writeField: 'name', writeTarget: 'channelListing',
  writeVerb: 'channel', affectsAllChannels: true, writable: true,
  // The capture on REGAL eBay IT: the mapping reads the old title through `title`, which is what said "Follows Shared".
  mapped: { value: 'Giacca Moto Uomo e Donna - Giubbotto Impermeabile', status: 'mapped', provenance: 'catalogRule', sourcePath: 'title',
    appliedTransforms: [], warnings: [], errors: [], autoCorrected: null, requiredByRule: true, overLimit: null },
  ...over,
})

describe('describeValueSource', () => {
  it('names an old listing text as the listing’s own value, never "Follows Shared"', () => {
    const source = describeValueSource(cell(), 'inherited')
    expect(source).toEqual({ kind: 'channel', label: 'Listing value',
      description: 'This listing still holds its own text, not the Shared product’s. The next change to the Shared product replaces it; Follow Shared uses the Shared product’s text now' })
  })
  it('still says "Follows Shared" for a value the mapping really takes from Master', () => {
    expect(describeValueSource(cell({ source: 'masterColumn', layer: 'master' }), 'inherited').label).toBe('Follows Shared')
  })
})

describe('the mark at rest', () => {
  it('draws only the sources that follow somewhere else quieter', () => {
    expect(['master', 'linked', 'default', 'rule', 'missing'].every(kind => isRoutineSource(kind as never))).toBe(true)
    expect(['override', 'channel', 'formula', 'ai', 'warning'].some(kind => isRoutineSource(kind as never))).toBe(false)
  })
  it('names the source on hover, and keeps a formula refusal in the server’s words', () => {
    const source = describeValueSource(cell(), 'inherited')
    expect(sourceHoverText(source, source.description)).toBe(`Listing value. ${source.description}`)
    expect(sourceHoverText(source, source.description, 'Brand must be one of the options.')).toBe('Brand must be one of the options.')
  })
})
