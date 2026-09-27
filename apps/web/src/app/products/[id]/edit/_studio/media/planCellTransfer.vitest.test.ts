import { describe, expect, it } from 'vitest'

import { mediaClipboardValue, readMediaClipboard } from './mediaCellTransfer'
import { pasteOps, planAddress, planCellSnapshot, planClipboardValue, readPlanClipboard } from './planCellTransfer'

const nero = { id: 'row-nm', productId: 'nm', productMediaSet: { ref: 'value:color:black', label: 'Nero', sharedBy: 3 },
  productMedia: [{ id: 'cover' }, { id: 'n1' }, { id: 'chart', muted: true }] }
const giallo = { id: 'row-gm', productId: 'gm', productMediaSet: { ref: 'value:color:yellow', label: 'Giallo', sharedBy: 3 },
  productMedia: [{ id: 'g1' }, { id: 'chart', muted: true }] }

describe('Product media cell on the photo plan — copy, paste, fill', () => {
  it('a cell copies its own set only: a variant\'s Common photos are context, not part of it', () => {
    expect(planCellSnapshot(nero)).toEqual({ productId: 'nm', set: 'value:color:black', label: 'Nero', items: ['cover', 'n1'] })
    expect(planCellSnapshot({ id: 'old', productMedia: [{ id: 'x' }] })).toBeNull()
  })
  it('the two clipboards never read each other: their photo ids live in different stores', () => {
    const plan = planClipboardValue(planCellSnapshot(nero)!)
    expect(readPlanClipboard(plan)).toEqual(planCellSnapshot(nero))
    expect(readMediaClipboard(plan)).toBeNull()
    const older = mediaClipboardValue({ productId: 'p', context: { scope: 'MASTER', market: 'GLOBAL', locale: 'it' }, items: [] })
    expect(readPlanClipboard(older)).toBeNull()
    expect(readPlanClipboard(`${plan.slice(0, 30)}{broken`)).toBeNull()
  })
  it('paste gives the target row\'s set exactly the copied photos, and does nothing when it has them', () => {
    expect(pasteOps(planCellSnapshot(nero)!, planCellSnapshot(giallo)!)).toEqual([{ op: 'replace', set: 'value:color:yellow', assetIds: ['cover', 'n1'] }])
    expect(pasteOps(planCellSnapshot(nero)!, planCellSnapshot(nero)!)).toEqual([])
  })
  it('writes Shared on the product sheet and the listing\'s own layer on a channel sheet', () => {
    expect(planAddress({ scope: 'MASTER', market: 'GLOBAL', locale: 'it' })).toEqual({ layer: 'SHARED' })
    expect(planAddress({ scope: 'EBAY', market: 'IT', locale: 'it', accountId: 'acc', aliasKey: 'winter' }))
      .toEqual({ layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: 'acc', aliasKey: 'winter' })
    // No account: the listing has no layer of its own, so nothing is written.
    expect(planAddress({ scope: 'EBAY', market: 'IT', locale: 'it' })).toBeNull()
  })
})
