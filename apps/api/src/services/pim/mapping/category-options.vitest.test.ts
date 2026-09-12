import { describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ schemas: vi.fn(), mapping: vi.fn() }))
vi.mock('../../../db.js', () => ({ default: { categorySchema: { findMany: mocks.schemas } } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: mocks.mapping }))
import { listChannelCategories } from './category-mapping.service.js'

describe('mapping category options', () => {
  it('includes eBay cached categories and uncached authored overlays without duplicates', async () => {
    mocks.schemas.mockResolvedValue([{ productType: '177104' }])
    mocks.mapping.mockResolvedValue({ byProductType: { '177104': {}, '999': {} } })
    const result = await listChannelCategories({ channel: 'EBAY', marketplace: 'IT' })
    expect(result.options).toEqual([{ id: '177104', label: '177104', hasSchema: true }, { id: '999', label: '999', hasSchema: false }])
    expect(mocks.schemas).toHaveBeenCalledWith(expect.objectContaining({ where: { channel: 'EBAY', marketplace: { in: ['IT', 'EBAY_IT'] }, isActive: true } }))
  })
})
