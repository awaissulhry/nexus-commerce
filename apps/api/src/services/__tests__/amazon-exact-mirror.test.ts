/**
 * M3 verifier — exact-mirror plan (delete-set, compaction, skip-no-MAIN safety).
 */

import { describe, it, expect } from 'vitest'
import { computeExactMirror, compactSlots, type TaxonomySlotLite } from '../images/amazon-exact-mirror.js'
import { buildJsonListingsFeedBody } from '../channel-batch/amazon-batch-feed.service.js'

const TAX: TaxonomySlotLite[] = [
  { slot: 'MAIN', kind: 'MAIN', writable: true },
  ...Array.from({ length: 8 }, (_, i): TaxonomySlotLite => ({ slot: `PT${String(i + 1).padStart(2, '0')}`, kind: 'OTHER', writable: true })),
  { slot: 'PS01', kind: 'SAFETY', writable: true },
  { slot: 'PS02', kind: 'SAFETY', writable: true },
  { slot: 'SWCH', kind: 'SWATCH', writable: true },
]

describe('computeExactMirror', () => {
  it('SAFETY: skips an ASIN with no MAIN (never wipes)', () => {
    const r = computeExactMirror([{ slot: 'PT01', url: 'a' }], TAX)
    expect(r.skip).toBe(true)
    expect(r.deleteSlots).toEqual([])
    expect(r.slots).toEqual([])
  })

  it('deletes every unfilled writable slot but keeps MAIN', () => {
    const r = computeExactMirror(
      [{ slot: 'MAIN', url: 'm' }, { slot: 'PT01', url: 'a' }, { slot: 'PT02', url: 'b' }],
      TAX,
    )
    expect(r.skip).toBe(false)
    expect(r.slots.map((s) => s.slot)).toEqual(['MAIN', 'PT01', 'PT02'])
    expect(r.deleteSlots).toContain('PT03')
    expect(r.deleteSlots).toContain('PS01')
    expect(r.deleteSlots).toContain('SWCH')
    expect(r.deleteSlots).not.toContain('MAIN')
    expect(r.deleteSlots).not.toContain('PT01')
  })

  it('compacts PT gaps to contiguous order (PT03 → PT02)', () => {
    const r = computeExactMirror(
      [{ slot: 'MAIN', url: 'm' }, { slot: 'PT01', url: 'a' }, { slot: 'PT03', url: 'c' }],
      TAX,
    )
    expect(r.slots.map((s) => s.slot)).toEqual(['MAIN', 'PT01', 'PT02'])
    expect(r.slots.find((s) => s.slot === 'PT02')?.url).toBe('c')
  })

  it('compacts the PS family independently (PS02 → PS01)', () => {
    const r = computeExactMirror([{ slot: 'MAIN', url: 'm' }, { slot: 'PS02', url: 'x' }], TAX)
    expect(r.slots.map((s) => s.slot)).toEqual(['MAIN', 'PS01'])
    expect(r.slots.find((s) => s.slot === 'PS01')?.url).toBe('x')
  })

  it('never deletes a non-writable slot', () => {
    const tax: TaxonomySlotLite[] = [
      { slot: 'MAIN', kind: 'MAIN', writable: true },
      { slot: 'PT01', kind: 'OTHER', writable: true },
      { slot: 'PS01', kind: 'SAFETY', writable: false },
    ]
    const r = computeExactMirror([{ slot: 'MAIN', url: 'm' }], tax)
    expect(r.deleteSlots).toContain('PT01')
    expect(r.deleteSlots).not.toContain('PS01')
  })

  it('compactSlots keeps MAIN and SWCH codes', () => {
    const out = compactSlots([{ slot: 'SWCH', url: 's' }, { slot: 'MAIN', url: 'm' }, { slot: 'PT05', url: 'p' }], TAX)
    expect(out.map((s) => s.slot)).toEqual(['MAIN', 'PT01', 'SWCH'])
  })
})

describe('buildJsonListingsFeedBody (image op)', () => {
  const map = {
    MAIN: 'main_product_image_locator',
    PT01: 'other_product_image_locator_1',
    PT02: 'other_product_image_locator_2',
    PS01: 'image_locator_ps01',
    SWCH: 'swatch_product_image_locator',
  }

  it('emits replace for filled slots and delete (no value) for empty ones', () => {
    const body = buildJsonListingsFeedBody({
      marketplaceIds: ['APJ6JRA9NG5V4'],
      sellerId: 'SELLER',
      operations: [
        {
          type: 'image',
          sku: 'SKU1',
          productType: 'OUTERWEAR',
          slots: [{ slot: 'MAIN', url: 'm' }, { slot: 'PT01', url: 'a' }],
          deleteSlots: ['PT02', 'PS01', 'SWCH'],
          slotToAttribute: map,
        },
      ],
    })
    const msg = JSON.parse(body).messages[0]
    expect(msg.operationType).toBe('PATCH')
    const replaces = msg.patches.filter((p: { op: string }) => p.op === 'replace')
    const deletes = msg.patches.filter((p: { op: string }) => p.op === 'delete')
    expect(replaces.map((p: { path: string }) => p.path)).toEqual([
      '/attributes/main_product_image_locator',
      '/attributes/other_product_image_locator_1',
    ])
    expect(deletes.map((p: { path: string }) => p.path).sort()).toEqual([
      '/attributes/image_locator_ps01',
      '/attributes/other_product_image_locator_2',
      '/attributes/swatch_product_image_locator',
    ])
    expect(deletes.every((p: object) => !('value' in p))).toBe(true)
  })

  it('throws rather than delete MAIN', () => {
    expect(() =>
      buildJsonListingsFeedBody({
        marketplaceIds: ['X'],
        sellerId: 'X',
        operations: [{ type: 'image', sku: 'S', productType: 'P', slots: [], deleteSlots: ['MAIN'], slotToAttribute: map }],
      }),
    ).toThrow(/MAIN/)
  })
})
