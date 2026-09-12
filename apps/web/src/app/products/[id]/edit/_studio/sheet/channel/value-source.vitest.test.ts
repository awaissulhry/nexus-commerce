import { describe, expect, it } from 'vitest'
import { classifyProvenance } from '@/design-system/grid/renderers/provenance'
import { describeValueSource, resetSourceLabel } from './value-source'
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
const describeCell = (c: StudioCellValue) => describeValueSource(c, classifyProvenance(c, 'channel'))

describe('channel value sources', () => {
  it('explains a supplying presentation rule instead of the superseded shared source path', () => {
    const mapped = mapping({ supplyingRule: { id: 'jackets', name: 'Jackets presentation', version: 4, href: '/channels/ebay/variation-order-rules?rule=jackets' } })
    const inherited = cell({ mapped })
    expect(describeCell(inherited)).toMatchObject({ kind: 'rule', label: 'Shared rule' })
    expect(describeCell(inherited).description).toContain('Jackets presentation')
    expect(describeCell(inherited).description).toContain('v4')
    expect(resetSourceLabel(inherited)).toContain('configured mapping or default')
    expect(describeCell(cell({ mapped: { ...mapped, provenance: 'override' } })).kind).toBe('override')
  })
  it('shows Master for a mapped input, even when Master stores a variant override', () => {
    expect(describeCell(cell()).kind).toBe('master')
    expect(describeCell(cell({ layer: 'variant', pinned: true })).kind).toBe('master')
  })
  it('names fallback and channel adjustments without claiming the untransformed value is used', () => {
    const result = describeCell(cell({ mapped: mapping({ legacySource: 'fallback', fallbackPath: 'name', appliedTransforms: ['truncate'] }) }))
    expect(result.kind).toBe('master')
    expect(result.description).toContain('name fallback')
    expect(result.description).toContain('truncate')
  })
  it.each([null, '', false, 0, []])('keeps a stored override for %j distinct from inheritance', value => {
    expect(describeCell(cell({ value, layer: 'channel', pinned: true, mapped: mapping({ provenance: 'override', value }) })).kind).toBe('override')
  })
  it('distinguishes a missing Master value from a missing mapping', () => {
    const emptyMaster = describeCell(cell({ value: null, mapped: mapping({ value: null, provenance: 'missing' }) }))
    expect(emptyMaster.kind).toBe('master')
    expect(emptyMaster.description).toContain('currently produces no value')
    expect(describeCell(cell({ mapped: mapping({ status: 'unmapped', sourcePath: null, provenance: null }) })).label).toBe('No mapping')
  })
  it('does not label constants, category defaults, expressions or shared links as Master', () => {
    expect(describeCell(cell({ mapped: mapping({ provenance: 'default' }) })).kind).toBe('default')
    expect(describeCell(cell({ mapped: mapping({ sourcePath: '' }) })).kind).toBe('rule')
    expect(describeCell(cell({ mapped: mapping({ usesExpression: true }) })).kind).toBe('rule')
    expect(describeCell(cell({ mapped: mapping({ provenance: 'linked' }) })).kind).toBe('linked')
  })
  it('uses a conservative label when an older server omits source details', () => {
    expect(describeCell(cell({ mapped: mapping({ sourcePath: undefined }) })).kind).toBe('rule')
  })
  it('keeps formula and draft states above stored mapping metadata', () => {
    expect(describeValueSource(cell(), 'formula').kind).toBe('formula')
    expect(describeValueSource(cell(), 'refused', 'Invalid option').description).toBe('Invalid option')
    expect(describeValueSource(cell(), 'aiStale').label).toBe('Outdated AI draft')
  })
  it('does not promise Master after reset without a declared source', () => {
    expect(resetSourceLabel(cell())).toBe('follow Master')
    expect(resetSourceLabel(cell({ mapped: mapping({ sourcePath: null }) }))).toContain('may become empty')
    expect(resetSourceLabel(cell({ mapped: mapping({ usesExpression: true }) }))).toContain('configured mapping')
  })
  it('identifies shared Master edits and channel-owned values separately', () => {
    const shared = describeCell(cell({ mapped: null, writeTarget: 'master', affectsAllChannels: true }))
    expect(shared.label).toBe('Master value')
    expect(shared.description).toContain('every channel')
    expect(describeCell(cell({ mapped: null, layer: 'default' })).kind).toBe('channel')
  })
})

it('explains a store-owned empty field without claiming that its Master mapping is missing', () => {
  const owned = cell({ value: null, mapped: mapping({ value: null, status: 'unmapped', sourcePath: null,
    sourceOwner: { kind: 'listing', label: 'Listing settings', path: 'listing.platformAttributes.metafields.PRODUCT.custom.features' } }) })
  expect(describeCell(owned)).toMatchObject({ kind: 'channel', label: 'Listing settings' })
  expect(describeCell(owned).description).toContain('A Master mapping is not required')
})
