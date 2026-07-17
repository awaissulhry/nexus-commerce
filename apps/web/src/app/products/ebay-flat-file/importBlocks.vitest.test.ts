/**
 * EI.2 — block detection + decisions tests (GALE-shaped fixtures).
 * Run: npx vitest run apps/web/src/app/products/ebay-flat-file/importBlocks.vitest.test.ts
 */
import { describe, it, expect } from 'vitest'
import { detectImportBlocks, markAllPooledShared, applyBlockDecisions } from './importBlocks.pure'

const parent = (sku: string, itemId: string, shared: unknown = 'TRUE') => ({
  sku, parentage: 'parent', title: `${sku} title`, variation_theme: 'Taglia,Colore',
  it_item_id: itemId, shared_sku_listing: shared,
})
const child = (sku: string, parentSku: string, itemId: string) => ({
  sku, parentage: 'child', parent_sku: parentSku, it_item_id: itemId,
})

/** 3-listing GALE-shaped file: identical child SKUs across all blocks. */
function galeRows(shared: unknown = 'TRUE'): Record<string, unknown>[] {
  return [
    parent('GALE-JACKET', '257584954808', shared),
    child('GALE-BLACK-M', 'GALE-JACKET', '257584954808'),
    child('GALE-BLACK-L', 'GALE-JACKET', '257584954808'),
    parent('GALE-ALT1', '256566101420', shared),
    child('GALE-BLACK-M', 'GALE-ALT1', '256566101420'),
    child('GALE-BLACK-L', 'GALE-ALT1', '256566101420'),
    parent('GALE-NEW', '', shared),
    child('GALE-BLACK-M', 'GALE-NEW', ''),
  ]
}

describe('detectImportBlocks', () => {
  it('groups blocks by parent, defaults adopt-with-ItemID / create-without', () => {
    const a = detectImportBlocks(galeRows())
    expect(a.blocks.map((b) => [b.key, b.decision])).toEqual([
      ['GALE-JACKET', 'adopt'],
      ['GALE-ALT1', 'adopt'],
      ['GALE-NEW', 'create'],
    ])
    expect(a.blocks[0].itemId).toBe('257584954808')
    expect(a.blocks[0].childSkus).toEqual(['GALE-BLACK-M', 'GALE-BLACK-L'])
    expect(a.flat).toBe(false)
  })

  it('pools SKUs across blocks; all-shared → no fix needed', () => {
    const a = detectImportBlocks(galeRows('TRUE'))
    expect([...a.pooledSkus.keys()].sort()).toEqual(['GALE-BLACK-L', 'GALE-BLACK-M'])
    expect(a.pooledSkus.get('GALE-BLACK-M')).toEqual(['GALE-JACKET', 'GALE-ALT1', 'GALE-NEW'])
    expect(a.needsSharedFix).toBe(false)
    expect(a.blocks.every((b) => b.shared)).toBe(true)
  })

  it('pooled SKUs WITHOUT shared flag → per-block error + needsSharedFix', () => {
    const a = detectImportBlocks(galeRows(''))
    expect(a.needsSharedFix).toBe(true)
    for (const b of a.blocks) {
      expect(b.shared).toBe(false)
      expect(b.issues.some((i) => i.level === 'error' && i.message.includes('Shared-SKU'))).toBe(true)
    }
  })

  it('markAllPooledShared flags parents AND children, clears the error', () => {
    const rows = galeRows('')
    const a = detectImportBlocks(rows)
    const { rows: fixed, blocks } = markAllPooledShared(rows, a)
    expect(blocks.every((b) => b.shared)).toBe(true)
    expect(blocks.every((b) => !b.issues.some((i) => i.message.includes('Shared-SKU')))).toBe(true)
    expect(fixed[0].shared_sku_listing).toBe(true)  // parent
    expect(fixed[1].shared_sku_listing).toBe(true)  // child kept consistent
    expect(rows[0].shared_sku_listing).toBe('')     // original untouched
  })

  it('applyBlockDecisions filters skipped blocks in original order', () => {
    const rows = galeRows()
    const a = detectImportBlocks(rows)
    a.blocks[1].decision = 'skip' // GALE-ALT1
    const kept = applyBlockDecisions(rows, a.blocks)
    expect(kept).toHaveLength(5)
    expect(kept.map((r) => r.sku)).toEqual(['GALE-JACKET', 'GALE-BLACK-M', 'GALE-BLACK-L', 'GALE-NEW', 'GALE-BLACK-M'])
  })

  it('orphan children (parent not in file) form a labeled block', () => {
    const a = detectImportBlocks([child('GALE-BLACK-XL', 'GALE-JACKET', '257584954808')])
    expect(a.blocks).toHaveLength(1)
    expect(a.blocks[0].key).toBe('GALE-JACKET')
    expect(a.blocks[0].issues.some((i) => i.message.includes('not in this file'))).toBe(true)
    expect(a.blocks[0].decision).toBe('adopt') // itemId from the child row
  })

  it('flat files (no parentage, unique SKUs) skip the review step', () => {
    const a = detectImportBlocks([
      { sku: 'SOLO-1', title: 'One' },
      { sku: 'SOLO-2', title: 'Two' },
    ])
    expect(a.flat).toBe(true)
    expect(a.blocks.every((b) => b.standalone)).toBe(true)
  })

  it('standalone rows sharing a SKU with a block still pool', () => {
    const a = detectImportBlocks([
      parent('FAM', '111', 'TRUE'),
      child('SHARED-SKU', 'FAM', '111'),
      { sku: 'SHARED-SKU', title: 'standalone twin', it_item_id: '222' },
    ])
    expect(a.pooledSkus.has('SHARED-SKU')).toBe(true)
    expect(a.flat).toBe(false)
  })
})
