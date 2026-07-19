import { describe, expect, it } from 'vitest'
import { computeAmazonImportFamilies, skippedRowIndexes } from './importFamiliesAmazon.pure'

const grid = [
  { item_sku: 'GALE-JACKET', parentage_level: 'parent', product_type: 'OUTERWEAR', variation_theme: 'SIZE_NAME-COLOR_NAME' },
  { item_sku: 'GALE-JACKET-M', parent_sku: 'GALE-JACKET', product_type: 'OUTERWEAR' },
  { item_sku: 'OTHER-PARENT', parentage_level: 'parent', product_type: 'OUTERWEAR' },
  { item_sku: 'OTHER-CHILD', parent_sku: 'OTHER-PARENT', product_type: 'OUTERWEAR' },
]

describe('computeAmazonImportFamilies (AMX.1)', () => {
  it('groups by parent, counts new vs update, no badges on a clean family', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'GALE-JACKET', parentage_level: 'parent', product_type: 'OUTERWEAR' },
      { item_sku: 'GALE-JACKET-M', parent_sku: 'GALE-JACKET', product_type: 'OUTERWEAR' },
      { item_sku: 'GALE-JACKET-L', parent_sku: 'GALE-JACKET', product_type: 'OUTERWEAR' },
    ], grid)
    expect(fams).toHaveLength(1)
    const f = fams[0]
    expect(f.key).toBe('GALE-JACKET')
    expect(f.rowCount).toBe(3)
    expect(f.newCount).toBe(1) // -L is new
    expect(f.updateCount).toBe(2)
    expect(f.isNewFamily).toBe(false)
    expect(f.badges).toEqual([])
  })

  it('badges a re-parented child with from → to', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'OTHER-CHILD', parent_sku: 'GALE-JACKET' },
    ], grid)
    expect(fams[0].badges.some((b) => b.kind === 'reparent' && /OTHER-PARENT → GALE-JACKET/.test(b.detail))).toBe(true)
  })

  it('badges an orphan family (parent in neither file nor grid)', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'X-1', parent_sku: 'GHOST-PARENT' },
    ], grid)
    expect(fams[0].badges.some((b) => b.kind === 'orphan')).toBe(true)
  })

  it('badges type and theme mismatches against the family', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'GALE-JACKET', parentage_level: 'parent', product_type: 'OUTERWEAR', variation_theme: 'SIZE_NAME-COLOR_NAME' },
      { item_sku: 'GALE-JACKET-P', parent_sku: 'GALE-JACKET', product_type: 'PANTS', variation_theme: 'SIZE_NAME' },
    ], grid)
    const kinds = fams[0].badges.map((b) => b.kind)
    expect(kinds).toContain('type-mismatch')
    expect(kinds).toContain('theme-mismatch')
  })

  it('badges an incomplete NEW family missing a theme axis value', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'NEW-FAM', parentage_level: 'parent', product_type: 'OUTERWEAR', variation_theme: 'SIZE_NAME-COLOR_NAME' },
      { item_sku: 'NEW-FAM-A', parent_sku: 'NEW-FAM', size_name: 'M', color_name: '' },
      { item_sku: 'NEW-FAM-B', parent_sku: 'NEW-FAM', size_name: 'L', color_name: 'Nero' },
    ], grid)
    const f = fams[0]
    expect(f.isNewFamily).toBe(true)
    expect(f.badges.some((b) => b.kind === 'incomplete' && /color_name/.test(b.detail))).toBe(true)
    expect(f.badges.some((b) => /size_name/.test(b.detail))).toBe(false)
  })

  it('standalone rows bucket last; skip decisions map to row indexes', () => {
    const fams = computeAmazonImportFamilies([
      { item_sku: 'LONE-1' },
      { item_sku: 'GALE-JACKET', parentage_level: 'parent' },
      { item_sku: 'GALE-JACKET-M', parent_sku: 'GALE-JACKET' },
    ], grid)
    expect(fams[fams.length - 1].key).toBe('(standalone)')
    const skipped = skippedRowIndexes(fams, new Set(['GALE-JACKET']))
    expect(skipped).toEqual(new Set([1, 2]))
  })
})
