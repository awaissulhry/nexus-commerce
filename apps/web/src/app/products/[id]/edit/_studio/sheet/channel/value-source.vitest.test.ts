import { describe, expect, it } from 'vitest'
import { resetSourceLabel } from './value-source'
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
