/**
 * P1 (issue #15, #14) — every attribute of a product's family and where it lives, for the sheet's Customise dialog.
 * Run: npx vitest run src/services/pim/family-attribute-places.vitest.test.ts
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const productFindFirst = vi.fn(), familyFindUnique = vi.fn(), attributeFindMany = vi.fn(), connectionFindMany = vi.fn(), effective = vi.fn()
vi.mock('../../db.js', () => ({ default: {
  product: { findFirst: (...a: unknown[]) => productFindFirst(...a) },
  productFamily: { findUnique: (...a: unknown[]) => familyFindUnique(...a) },
  customAttribute: { findMany: (...a: unknown[]) => attributeFindMany(...a) },
  channelConnection: { findMany: (...a: unknown[]) => connectionFindMany(...a) },
} }))
vi.mock('../family-hierarchy.service.js', () => ({ familyHierarchyService: { resolveEffectiveAttributes: (...a: unknown[]) => effective(...a) } }))

import { familyAttributePlaces } from './family-attribute-places.service.js'

beforeEach(() => {
  for (const m of [productFindFirst, familyFindUnique, attributeFindMany, connectionFindMany, effective]) m.mockReset()
  connectionFindMany.mockResolvedValue([{ channelType: 'EBAY' }, { channelType: 'shopify' }])
  familyFindUnique.mockResolvedValue({ id: 'jackets', label: 'Jackets' })
  effective.mockResolvedValue([{ attributeId: 'a1' }, { attributeId: 'a2' }, { attributeId: 'a3' }])
  attributeFindMany.mockResolvedValue([
    { code: 'neckline', label: 'Neckline', placement: 'shared', placementChannels: [], archivedAt: null },
    { code: 'dg', label: 'Dangerous goods', placement: 'channel', placementChannels: ['AMAZON'], archivedAt: null },
    { code: 'old_fit', label: 'Old fit', placement: 'shared', placementChannels: [], archivedAt: new Date('2026-09-20') },
  ])
})

describe('familyAttributePlaces', () => {
  it('reads a variation’s family through its parent, with placement, archive and the channels that have an account', async () => {
    productFindFirst.mockResolvedValue({ familyId: null, parent: { familyId: 'jackets' } })
    expect(await familyAttributePlaces('child')).toEqual({
      family: { id: 'jackets', label: 'Jackets' },
      attributes: [
        { code: 'neckline', label: 'Neckline', placement: 'shared', channels: [], archived: false },
        { code: 'dg', label: 'Dangerous goods', placement: 'channel', channels: ['AMAZON'], archived: false },
        { code: 'old_fit', label: 'Old fit', placement: 'shared', channels: [], archived: true },
      ],
      channelsWithAccount: ['EBAY', 'SHOPIFY'],
    })
    expect(effective).toHaveBeenCalledWith('jackets')
  })
  it('answers "no family" for a product without one, and 404s an unknown product', async () => {
    productFindFirst.mockResolvedValue({ familyId: null, parent: null })
    expect(await familyAttributePlaces('solo')).toMatchObject({ family: null, attributes: [] })
    productFindFirst.mockResolvedValue(null)
    await expect(familyAttributePlaces('missing')).rejects.toMatchObject({ name: 'UnknownProductError' })
  })
})
