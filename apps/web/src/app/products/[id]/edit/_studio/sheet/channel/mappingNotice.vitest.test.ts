import { describe, expect, it } from 'vitest'

import { mappingNotice, type MappingMeta } from './mappingNotice'

const meta = (over: Partial<MappingMeta> = {}): MappingMeta =>
  ({ productLevelOnly: false, missingProductIds: [], skippedReason: null, ...over })

describe('the 🔗 column explains itself (hub #295)', () => {
  it('says nothing when the mapping run fully answered', () => {
    expect(mappingNotice(meta())).toBeNull()
  })

  it('says nothing when there is no mapping block at all', () => {
    // A scope that derives nothing has nothing to report. Inventing a warning here would be the
    // false positive that costs more than the silence it replaces.
    expect(mappingNotice(null)).toBeNull()
    expect(mappingNotice(undefined)).toBeNull()
  })

  it('🔴 names the empty column as UNAVAILABLE and RETRYING, not lost', () => {
    const n = mappingNotice(meta({ skippedReason: 'mapping enrichment exceeded 8s budget' }))
    expect(n).not.toBeNull()
    expect(n!.kind).toBe('slow')
    expect(n!.note).toBe('Derived values unavailable — retrying')
    expect(n!.headerSuffix).toBe('unavailable')
    // The contract's own words, carried rather than paraphrased into a diagnosis this lane cannot make.
    expect(n!.detail).toBe('mapping enrichment exceeded 8s budget')
  })

  it('the skipped run outranks everything else — an empty column is the loudest fact', () => {
    // A skipped run with 41 missing ids and product grain is still, first and foremost, empty.
    const n = mappingNotice(meta({ skippedReason: 'queue not ready', missingProductIds: ['a', 'b'], productLevelOnly: true }))
    expect(n!.headerSuffix).toBe('unavailable')
  })

  it('reports a PARTIAL run with its count, singular and plural', () => {
    expect(mappingNotice(meta({ missingProductIds: Array.from({ length: 41 }, (_, i) => `p${i}`) }))!.note)
      .toBe('Derived values missing for 41 products — retrying')
    expect(mappingNotice(meta({ missingProductIds: ['p1'] }))!.note)
      .toBe('Derived values missing for 1 product — retrying')
  })

  it('🔴 says when a SUCCESSFUL run was only at product grain', () => {
    // Not a failure: the values are real. What is not real is the impression that each alias was
    // resolved independently — four aliases of one product share one mapped value.
    const n = mappingNotice(meta({ productLevelOnly: true }))
    expect(n!.kind).toBe('provenance')
    expect(n!.note).toBe('Derived per product — aliases of one product share this value')
    expect(n!.detail).toBeUndefined()
  })
})
