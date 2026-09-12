import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../db.js', () => ({ default: { product: { findMany: vi.fn() }, productFamily: { findMany: vi.fn(), findUnique: vi.fn() }, channelListing: { findMany: vi.fn() } } }))
vi.mock('./catalog-transfer-plan.js', () => ({
  MANAGED_FIELDS: new Set(),
  managedChannelField: () => false,
  masterTransferState: (product: { name: string }) => ({ state: 'stored', value: product.name }),
  transferContracts: () => ({ master: async () => [{ key: 'name', label: 'Name', kind: 'text', group: 'Identity', storage: 'column', editable: true, requiredBy: [] }],
    channel: async (channel: string) => {
      const { shopifyProductSpec, etsyProductSpec } = await import('./channel-specs/store.js')
      return { fields: (channel === 'SHOPIFY' ? shopifyProductSpec() : etsyProductSpec()).fields.map(f => ({ ...f, fieldKey: f.key, sheetKey: f.masterKey ?? f.key })) }
    },
  }),
}))
vi.mock('./mapping/category-mapping.service.js', () => ({ resolveCategoriesForProducts: vi.fn() }))
vi.mock('./catalog-transfer-download.js', () => ({ writeTransferDownload: vi.fn(async (groups: AsyncIterable<unknown[]>) => {
  const rows = []
  for await (const group of groups) rows.push(...group)
  return rows
}) }))
import prisma from '../../db.js'
import { exportCatalogTransfer, catalogTransferTemplate } from './catalog-transfer-export.js'
import ExcelJS from 'exceljs'
import { readTransferFile } from './catalog-transfer-file.js'
import { TRANSFER_COLUMNS, transferFileRow, type TransferRow } from '@nexus/shared/catalog-transfer'
import { writeTransferDownload } from './catalog-transfer-download.js'

const selection = Array.from({ length: 601 }, (_, i) => ({ id: `id-${i}`, sku: `SKU-${i}`, name: `Name ${i}`, version: i, familyId: 'jackets', parent: null, categories: [], localizedContent: {} }))
beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prisma.productFamily.findMany).mockResolvedValue([{ id: 'jackets', code: 'jackets' }] as never)
  vi.mocked(prisma.channelListing.findMany).mockResolvedValue([])
  vi.mocked(prisma.product.findMany).mockImplementation(async (args: any) => args.select ? selection : selection.filter(p => args.where.id.in.includes(p.id)) as any)
})

describe('catalog export selection', () => {
  it('generates a usable Parent SKU template and reads relationships back without guessing', async () => {
    vi.mocked(prisma.productFamily.findUnique).mockResolvedValue({ code: 'jackets' } as never)
    const file = await catalogTransferTemplate('IT', 'jackets')
    const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(file as never)
    const products = workbook.getWorksheet('Products')!
    const field = TRANSFER_COLUMNS.indexOf('field') + 1, action = TRANSFER_COLUMNS.indexOf('action') + 1
    const parentRows = products.getRows(2, products.rowCount - 1)!.filter(r => r.getCell(field).value === 'parentSku')
    expect(parentRows).toHaveLength(1)
    expect(parentRows[0].getCell(action).value || '').toBe('')
    expect(JSON.stringify(workbook.getWorksheet('Dictionary')!.getSheetValues())).toContain('Parent SKU')
    expect(JSON.stringify(workbook.getWorksheet('Instructions')!.getSheetValues())).toContain('GALE-JACKET')
    const record: TransferRow = { row: 2, entity: 'Products', sku: '001-JACKET-M', channel: '', accountId: '', marketplace: '', aliasKey: '', locale: '', field: 'parentSku', action: 'SET', value: '001-JACKET' }
    // Remove the unfilled template actions, then enter one relationship exactly as a user would.
    products.eachRow((r, index) => { if (index > 1) { r.getCell(action).value = ''; r.getCell(TRANSFER_COLUMNS.indexOf('value') + 1).value = '' } })
    const values = transferFileRow(record)
    parentRows[0].values = TRANSFER_COLUMNS.map(key => values[key])
    const parsed = await readTransferFile(Buffer.from(await workbook.xlsx.writeBuffer()), 'relationships.xlsx')
    expect(parsed.issues).toEqual([])
    expect(parsed.rows).toEqual([{ ...record, row: parentRows[0].number }])
  })
  it('reads every selected product beyond 500 in bounded pages, exactly once', async () => {
    const result = await exportCatalogTransfer({ market: 'IT', familyId: 'jackets' }) as unknown as { sku: string; field: string; value: string }[]
    expect(result.filter(r => r.field === 'name').map(r => r.value)).toEqual(selection.map(p => p.name))
    expect(new Set(result.map(r => r.sku)).size).toBe(601)
    const pages = vi.mocked(prisma.product.findMany).mock.calls.filter(([args]) => args?.include)
    expect(pages).toHaveLength(7)
    expect(pages.every(([args]) => (args!.where!.id as { in: string[] }).in.length <= 100)).toBe(true)
  })

  it('accepts more than 500 explicitly requested SKUs', async () => {
    await exportCatalogTransfer({ market: 'IT', skus: selection.map(p => p.sku) })
    expect(writeTransferDownload).toHaveBeenCalledOnce()
  })

  it('refuses an unknown requested SKU instead of returning an incomplete selection', async () => {
    await expect(exportCatalogTransfer({ market: 'IT', skus: ['SKU-0', 'missing'] })).rejects.toThrow('missing or archived')
    expect(writeTransferDownload).not.toHaveBeenCalled()
  })

  it('refuses products removed during generation instead of silently skipping them', async () => {
    vi.mocked(prisma.product.findMany).mockResolvedValueOnce(selection as never).mockResolvedValueOnce([])
    await expect(exportCatalogTransfer({ market: 'IT', familyId: 'jackets' })).rejects.toThrow('catalog changed')
  })
})


it.each(['SHOPIFY', 'ETSY'])('exports %s drafts and preserves explicit empty categories', async channel => {
  vi.mocked(prisma.product.findMany).mockResolvedValue([selection[0]] as never)
  vi.mocked(prisma.channelListing.findMany).mockResolvedValue([{ id: 'store-listing', productId: selection[0].id, channel, channelConnectionId: 'store-account', marketplace: 'GLOBAL', aliasKey: 'outlet', version: 9,
    titleOverride: 'Store title', followMasterTitle: false, overrideData: {}, platformAttributes: { [channel === 'SHOPIFY' ? 'category' : 'taxonomy_id']: null } }] as never)
  const rows = await exportCatalogTransfer({ market: 'GLOBAL', marketplaces: ['GLOBAL'], skus: [selection[0].sku] }) as unknown as TransferRow[]
  expect(rows.find(r => r.channel === channel && r.field === 'title')).toMatchObject({ value: 'Store title', accountId: 'store-account', marketplace: 'GLOBAL', aliasKey: 'outlet', version: 9 })
  expect(rows.find(r => r.entity === 'Listings')).toMatchObject({ field: channel === 'SHOPIFY' ? 'category' : 'taxonomy_id', action: 'CLEAR' })
  expect(vi.mocked(prisma.channelListing.findMany).mock.calls[0][0]?.where?.channel).toEqual({ in: ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] })
})
