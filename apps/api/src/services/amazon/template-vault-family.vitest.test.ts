import { describe, expect, it, vi } from 'vitest'
import {
  deriveFamilyKeyFromGridRows,
  detectWorkbookFamilyKey,
  resolveExportBase,
} from './template-vault.service.js'

describe('FFT.5a family workbook base', () => {
  it('detects the single dominant parent SKU from template rows (attr-path headers)', () => {
    const headers = ['item_sku', 'child_parent_sku_relationship[marketplace_id]#1.parent_sku', 'item_name']
    const rows = [
      { item_sku: 'GALE-JACKET', 'child_parent_sku_relationship[marketplace_id]#1.parent_sku': '' },
      { item_sku: 'GALE-JACKET-BLACK-MEN-M', 'child_parent_sku_relationship[marketplace_id]#1.parent_sku': 'GALE-JACKET' },
      { item_sku: 'GALE-JACKET-BLACK-MEN-L', 'child_parent_sku_relationship[marketplace_id]#1.parent_sku': 'GALE-JACKET' },
    ]
    expect(detectWorkbookFamilyKey(headers, rows)).toBe('GALE-JACKET')
  })

  it('standalone one-product file → its lone SKU; multi-family → null', () => {
    expect(detectWorkbookFamilyKey(['item_sku'], [{ item_sku: 'SOLO-1' }, { item_sku: 'SOLO-1' }])).toBe('SOLO-1')
    const headers = ['item_sku', 'parent_sku']
    const rows = [
      { item_sku: 'A-1', parent_sku: 'A' },
      { item_sku: 'B-1', parent_sku: 'B' },
    ]
    expect(detectWorkbookFamilyKey(headers, rows)).toBeNull()
    expect(detectWorkbookFamilyKey(['item_sku'], [])).toBeNull()
  })

  it('derives the family from grid rows the same way', () => {
    expect(deriveFamilyKeyFromGridRows([
      { item_sku: 'AIREON', parent_sku: '' },
      { item_sku: 'AIREON-JACKET-NERO-NEO-MEN-M', parent_sku: 'AIREON' },
    ])).toBe('AIREON')
    expect(deriveFamilyKeyFromGridRows([
      { item_sku: 'A-1', parent_sku: 'A' }, { item_sku: 'B-1', parent_sku: 'B' },
    ])).toBeNull()
  })

  it('resolution order: explicit template id → family workbook → market template', async () => {
    const familyEntry = { templateIdentifier: 'tpl-1', filename: 'AIREON IT.xlsm', bytes: Buffer.from('f'), marketplace: 'IT' }
    const templateEntry = { templateIdentifier: 'tpl-blank', filename: 'blank.xlsm', bytes: Buffer.from('t'), marketplace: 'IT' }
    const prisma = {
      amazonTemplateVault: {
        findUnique: vi.fn(async ({ where }: any) => (where.templateIdentifier === 'tpl-blank' ? templateEntry : null)),
        findFirst: vi.fn(async () => templateEntry),
      },
      amazonFamilyWorkbook: {
        findUnique: vi.fn(async ({ where }: any) =>
          where.familyKey_marketplace.familyKey === 'AIREON' ? familyEntry : null),
      },
    }
    const explicit = await resolveExportBase(prisma as never, { marketplace: 'IT', templateIdentifier: 'tpl-blank', familyKey: 'AIREON' })
    expect(explicit?.source).toBe('template')
    expect(explicit?.entry.filename).toBe('blank.xlsm')

    const family = await resolveExportBase(prisma as never, { marketplace: 'IT', familyKey: 'AIREON' })
    expect(family?.source).toBe('family')
    expect(family?.entry.filename).toBe('AIREON IT.xlsm')

    const fallback = await resolveExportBase(prisma as never, { marketplace: 'IT', familyKey: 'UNKNOWN-FAM' })
    expect(fallback?.source).toBe('template')

    const none = await resolveExportBase(prisma as never, { marketplace: 'IT', templateIdentifier: 'missing' })
    expect(none).toBeNull()
  })
})
