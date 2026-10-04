import { afterEach, describe, expect, it, vi } from 'vitest'

import { channelResetOffer } from '../sheetReset'
import { provenanceLabel } from '@/design-system/grid/renderers/provenance'
import { describeValueSource } from './cellDetailsSource'
import { channelCellProvenance } from './channelCellProvenance'
import { adoptFamilyListings, commitChannelRow, familyListingsOf } from './useChannelSheet'
import type { ChannelSheetRow, StudioCellValue } from './types'

/**
 * P1 review (2, 3, 4) — eBay takes one value per listing for an item specific that is not a variation axis. The server
 * stores a variation row's edit on the parent listing and answers `familyListings[]`; it answers `warnings[]` for values
 * it stored with a problem; and it marks a variation row's cell `mapped.listingLevel.variation`.
 */
const mapped = (value: unknown, listingLevel?: object) => ({ value, status: 'mapped', provenance: 'override', appliedTransforms: [], warnings: [], errors: [],
  autoCorrected: null, requiredByRule: false, overLimit: null, ...(listingLevel ? { listingLevel } : {}) })
const cell = (value: unknown, over: Partial<StudioCellValue> = {}, listingLevel?: object): StudioCellValue => ({
  value, source: 'channelExplicit', inheritedFrom: null, inherited: false, layer: 'channel', pinned: true, follows: false, editable: true, linkGroupId: null,
  writeField: 'attr_paese_di_origine', writeTarget: 'channelListing', writeVerb: 'channel', affectsAllChannels: false, writable: true,
  mapped: mapped(value, listingLevel), ...over,
}) as unknown as StudioCellValue
const family = (): ChannelSheetRow[] => [
  { id: 'p', rowId: 'primary:p', sku: 'FAM', parentId: null, rowKind: 'parent', aliasId: null, listing: { id: 'lp', version: 5 },
    values: { paese_di_origine: cell('Pakistan', {}, { productId: 'p', sku: 'FAM' }), title: cell('T', { writeField: 'name' }) } },
  { id: 'a', rowId: 'primary:a', sku: 'FAM-A', parentId: 'p', rowKind: 'variant', aliasId: null, listing: { id: 'la', version: 9 },
    values: { paese_di_origine: cell('Pakistan', { layer: 'alias', inherited: true, pinned: false, resettable: false }, { productId: 'p', sku: 'FAM', variation: true, ownValue: 'Cina' }) } },
  { id: 'b', rowId: 'primary:b', sku: 'FAM-B', parentId: 'p', rowKind: 'variant', aliasId: null, listing: { id: 'lb', version: 3 },
    values: { paese_di_origine: cell('Pakistan', { layer: 'alias', inherited: true, pinned: false, resettable: false }, { productId: 'p', sku: 'FAM', variation: true }) } },
  { id: 'b', rowId: 'alias1:b', sku: 'FAM-B', parentId: 'p', rowKind: 'variant', aliasId: 'alias1', listing: { id: 'lb2', version: 1 },
    values: { paese_di_origine: cell('Albania', {}, { productId: 'p', sku: 'FAM', variation: true }) } },
] as unknown as ChannelSheetRow[]

afterEach(() => vi.unstubAllGlobals())

describe('(4) a variation row\'s listing-level value is the listing\'s', () => {
  it('its source says so, where it comes from, and that a set or a clear here sets it for every variation', () => {
    // Cell details words the member the cell's mark draws (2026-10-04): the listing-level mark, not 🔗.
    const cell = family()[1].values.paese_di_origine
    expect(channelCellProvenance(cell)).toBe('listingLevel')
    const source = describeValueSource(cell, channelCellProvenance(cell))
    // The mark's own label (2026-10-04): Cell details and the mark name it the same way.
    expect(source.label).toBe(provenanceLabel('listingLevel'))
    expect(source.description).toContain('comes from FAM')
    expect(source.description).toContain('Setting or clearing it here sets it for every variation of this listing')
    expect(source.description).toContain('This row also stores "Cina", which eBay does not receive')
  })
  it('no "Reset to inherited" on the variation row; the listing\'s own row keeps its reset', () => {
    const rows = family()
    expect(channelResetOffer(rows[1], 'paese_di_origine')).toBeNull()
    expect(channelResetOffer(rows[0], 'paese_di_origine')).not.toBeNull()
  })
  it('control: the parent row\'s source is its own value, not the variation wording', () => {
    expect(describeValueSource(family()[0].values.paese_di_origine, 'inherited').label).not.toBe(provenanceLabel('listingLevel'))
  })
})

describe('(2) the family listings a save moved', () => {
  it('reads `familyListings[]`, leaving anything malformed out', () => {
    expect(familyListingsOf({ familyListings: [{ productId: 'p', listingId: 'lp', version: 6 }, { productId: 'x' }, null] })).toEqual([{ productId: 'p', listingId: 'lp', version: 6 }])
    expect(familyListingsOf({})).toEqual([])
  })
  it('adopts the new versions and shows the listing\'s new value on every row of the family on this alias', () => {
    const rows = family()
    const changed = adoptFamilyListings(rows, [{ productId: 'p', listingId: 'lp', version: 6 }], rows[1], [{ colId: 'paese_di_origine', value: 'Italia' }])
    expect(rows[0].listing?.version).toBe(6)
    expect(rows.slice(0, 3).map(row => row.values.paese_di_origine.value)).toEqual(['Italia', 'Pakistan', 'Italia'])
    expect(rows[3].values.paese_di_origine.value).toBe('Albania')
    expect(changed.map(row => row.rowId).sort()).toEqual(['primary:b', 'primary:p'])
  })
  it('a save answers `familyListings`: the parent row\'s token moves, so its next save is not a conflict', async () => {
    const rows = family()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ updated: 1, currentVersion: 10, versionOf: 'channelListing',
      familyListings: [{ productId: 'p', listingId: 'lp', version: 6 }] }) }) as unknown as Response))
    const moved: ChannelSheetRow[][] = []
    const result = await commitChannelRow({ rowId: 'primary:a', row: rows[1], cells: [{ colId: 'paese_di_origine', value: 'Italia', intent: 'set' }] } as never,
      { channel: 'EBAY', marketplace: 'IT', familyRows: () => rows, onFamilyChanged: changed => moved.push(changed) })
    expect(result.ok).toBe(true)
    expect(rows[1].listing?.version).toBe(10)
    expect(rows[0].listing?.version).toBe(6)
    expect(moved.flat().map(row => row.rowId).sort()).toEqual(['primary:b', 'primary:p'])
  })
})

describe('(2b) a refused cell never travels to the family (review 2026-09-30)', () => {
  it('a 200 that refuses the cell leaves the siblings and the parent showing the stored value', async () => {
    const rows = family()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ updated: 0, currentVersion: 9, versionOf: 'channelListing',
      familyListings: [{ productId: 'p', listingId: 'lp', version: 5 }],
      errors: [{ id: 'a', field: 'attr_paese_di_origine', error: 'No EBAY listing on IT yet' }] }) }) as unknown as Response))
    const moved: ChannelSheetRow[][] = []
    await commitChannelRow({ rowId: 'primary:a', row: rows[1], cells: [{ colId: 'paese_di_origine', value: 'Italia', intent: 'set' }] } as never,
      { channel: 'EBAY', marketplace: 'IT', familyRows: () => rows, onFamilyChanged: changed => moved.push(changed) })
    expect(rows[0].values.paese_di_origine.value).toBe('Pakistan')
    expect(rows[2].values.paese_di_origine.value).toBe('Pakistan')
  })
})

describe('(3) a value stored with a warning', () => {
  it('the cell carries the server\'s sentence; a cell with none is plainly saved', async () => {
    const rows = family()
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ updated: 2, currentVersion: 6, versionOf: 'channelListing',
      warnings: [{ id: 'p', field: 'attr_paese_di_origine', warning: 'Country of origin contains an unaccepted value. Allowed values: Italia.' }, { id: 'other', field: 'name', warning: 'not mine' }] }) }) as unknown as Response))
    const result = await commitChannelRow({ rowId: 'primary:p', row: rows[0], cells: [
      { colId: 'paese_di_origine', value: 'Narnia', intent: 'set' }, { colId: 'title', value: 'T2', intent: 'set' },
    ] } as never, { channel: 'EBAY', marketplace: 'IT', familyRows: () => rows })
    expect(result).toMatchObject({ ok: true, cells: {
      paese_di_origine: { ok: true, warning: 'Country of origin contains an unaccepted value. Allowed values: Italia.' },
      title: { ok: true },
    } })
    expect(result.cells?.title).not.toHaveProperty('warning')
  })
})
