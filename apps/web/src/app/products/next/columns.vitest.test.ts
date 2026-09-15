import { describe, expect, it } from 'vitest'
import type { ProductRow } from '../_types'
import { buildPageColumns, columnLabel, pageColumnExportValue, pageColumnValue } from './columns'

const columns = buildPageColumns({ activeChannels: [], onDuplicate: () => {}, onOpenInventory: () => {}, navigate: () => {} })
const column = (key: string) => columns.find(c => c.key === key)!
const row: ProductRow = {
  createdAt: '2026-09-01T08:00:00Z', id: 'one', name: 'Jacket', sku: 'JACKET-M', brand: 'Brand', productType: 'Jacket', status: 'ACTIVE',
  lowStockThreshold: 5, syncChannels: ['AMAZON'], imageUrl: null, amazonAsin: null, isParent: false, parentId: null,
  fulfillmentMethod: 'FBM', family: null, workflowStage: null, photoCount: 0, channelCount: 1, variantCount: 0,
  basePrice: 12.34, totalStock: 7, fbaStock: 2, fbmStock: 5, updatedAt: '2026-09-15T08:00:00Z',
  sales: { units: 3, revenueCents: 2468, days: 7 }, tags: [{ id: 'tag', name: 'Winter', color: null }],
  coverage: { AMAZON: { total: 1, live: 1, draft: 0, error: 0 } },
}

describe('product column and export parity', () => {
  it('exports the displayed identity and measures in their displayed units', () => {
    for (const [key, expected] of Object.entries({ product: 'Jacket', brand: 'Brand', productType: 'Jacket', status: 'ACTIVE', price: 12.34, available: 7, sales: 24.68, units: 3, tags: 'Winter', channels: '1 live', updated: row.updatedAt })) {
      expect(pageColumnExportValue(column(key), row), key).toEqual(expected)
    }
    expect(columnLabel(column('sales'))).toBe('Sales (7d)')
    expect(columnLabel(column('units'))).toBe('Units (7d)')
  })
  it('retains known listings when the connection roster is unavailable', () => {
    expect(pageColumnValue(column('channels'), row)).toEqual([{ channel: 'AMAZON', state: 'live', detail: '1 live' }])
  })
  it('keeps an unknown euro total distinct from measured zero in the grid and CSV', () => {
    const unknown = { ...row, sales: { units: 3, revenueCents: null, days: 7 } }
    expect(pageColumnValue(column('sales'), unknown)).toBeNull()
    expect(pageColumnExportValue(column('sales'), unknown)).toBeNull()
    expect(pageColumnExportValue(column('sales'), { ...row, sales: { units: 0, revenueCents: 0, days: 7 } })).toBe(0)
  })
})
