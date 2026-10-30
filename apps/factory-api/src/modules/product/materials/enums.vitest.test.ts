import { describe, expect, it } from 'vitest'
import { ItemKind, ItemSourcing, ItemTracking, MasterStatus, Tannage, Uom } from '@nexus/factory-db'
import { ITEM_KINDS, ITEM_SOURCINGS, ITEM_TRACKINGS, MATERIAL_STATUSES, TANNAGES } from '@nexus/factory-domain/product/materials/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'
import { IMPORTERS } from '../../../platform/imports/registry'

/** factory-domain is pure (no Prisma), so its closed lists are checked against the schema's enums here. */
describe('the material lists of factory-domain', () => {
  it('are the factory-db enums, value for value', () => {
    expect([...UOMS].sort()).toEqual(Object.values(Uom).sort())
    // W2a wave 5: FINISHED is a finished garment's item (one per SKU), never a material: the library leaves it out.
    expect([...ITEM_KINDS, 'FINISHED'].sort()).toEqual(Object.values(ItemKind).sort())
    expect([...ITEM_SOURCINGS].sort()).toEqual(Object.values(ItemSourcing).sort())
    expect([...ITEM_TRACKINGS].sort()).toEqual(Object.values(ItemTracking).sort())
    expect([...TANNAGES].sort()).toEqual(Object.values(Tannage).sort())
    expect([...MATERIAL_STATUSES].sort()).toEqual(Object.values(MasterStatus).sort())
  })

  it('register the material import with the process (PLT-176)', () => {
    expect(IMPORTERS.map((adapter) => adapter.importer.key)).toContain('product.materials')
  })
})
