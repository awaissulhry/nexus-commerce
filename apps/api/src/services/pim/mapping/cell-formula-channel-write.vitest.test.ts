vi.mock('../workspace-destination.js', () => ({ resolveWorkspaceDestination: async (input: any) => ({ accountId: input.accountId }) }))
vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], defaults: { p1: { channelCategoryId: 'OUTERWEAR' } }, byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
/**
 * #758 → #775 — where a CHANNEL formula write is SENT.
 *
 * This suite used to assert the prisma statements directly: a mapped key landing
 * on the listing column, an `attr_*` key merging into the override bag. Those
 * assertions have moved, not disappeared — #775 routes a formula through the
 * ordinary cell writer (the bulk PATCH), so the routing is now that path's
 * business and its own suite covers it.
 *
 * What is this layer's business, and what these cases assert, is the HAND-OFF:
 * the formula path resolves the column to its `writeField` and sends THAT.
 * Getting it wrong is not hypothetical — #758 gated on the raw key here while
 * the sheet contract gated on the routed name, so the UI offered columns the
 * writer refused.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindUnique = vi.fn()
const listingFindFirst = vi.fn(async (_args: unknown) => null)
const formulaUpsert = vi.fn()
const formulaFindMany = vi.fn()
const getStudioColumns = vi.fn()
const writer = vi.fn()

vi.mock('../../../db.js', () => ({
  default: {
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a), update: async () => ({}) },
    channelListing: { findFirst: (args: unknown) => listingFindFirst(args), update: async () => ({}) },
    cellFormula: { upsert: (...a: unknown[]) => formulaUpsert(...a), findMany: (...a: unknown[]) => formulaFindMany(...a) },
  },
}))
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: async () => {} } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [] }) }))
vi.mock('../studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))

import { setCellFormula, setFormulaFieldWriter, pinOverFormula } from './cell-formula.service.js'

const PID = 'p1'
const col = (key: string, writeField: string) => ({
  key, writeField, label: key, group: 'g', kind: 'number', storage: 'categoryAttributes',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
})

const save = (fieldKey: string) => setCellFormula({
  productId: PID, scope: 'channel', channel: fieldKey === 'price' ? 'EBAY' : 'AMAZON', marketplace: 'IT',
  locale: 'it', market: 'IT', fieldKey, expr: '12 * 1.08',
})

beforeEach(() => {
  for (const m of [productFindUnique, formulaUpsert, formulaFindMany, getStudioColumns, writer]) m.mockReset()
  productFindUnique.mockResolvedValue({
    id: PID, parentId: null, sku: 'SKU', productType: 'OUTERWEAR', version: 1, variationAxes: [],
    categoryAttributes: {}, variantAttributes: {}, localizedContent: {},
  })
  formulaFindMany.mockResolvedValue([])
  formulaUpsert.mockImplementation(async (a: any) => ({
    id: 'f1', productId: PID, scope: 'channel', channel: 'AMAZON', marketplace: 'IT',
    locale: 'it', market: 'IT', fieldKey: a?.create?.fieldKey ?? 'x', expr: 'e',
    dependsOn: [], lastError: a?.create?.lastError ?? null, evaluatedAt: new Date(), version: 1, updatedBy: null,
  }))
  getStudioColumns.mockResolvedValue({
    columns: [col('price', 'ebay_price'), col('list_price', 'attr_list_price')],
  })
  writer.mockImplementation(async (input: any) => ({ ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) }))
  setFormulaFieldWriter(writer as never)
})

describe('#775 the formula path hands the writer the ROUTED name', () => {
  it('a mapped channel column is sent as its prefixed write field', async () => {
    await save('price')
    expect(writer).toHaveBeenCalledTimes(1)
    // NOT `price` — the writer would reject a name it does not route.
    expect(writer.mock.calls[0][0]).toMatchObject({
      writeField: 'ebay_price', scope: 'channel', channel: 'EBAY', marketplace: 'IT',
    })
  })

  it('an attr_* column is sent with its prefix, and the channel coordinate', async () => {
    await save('list_price')
    expect(writer.mock.calls[0][0]).toMatchObject({
      writeField: 'attr_list_price', scope: 'channel', marketplace: 'IT',
    })
  })

  it('SENSITIVITY: the two take different routed names, not one shared default', async () => {
    // Without this, both cases above would pass on a writer that always received
    // the raw fieldKey, or always the same string.
    await save('price')
    const mapped = writer.mock.calls[0][0].writeField
    writer.mockClear()
    await save('list_price')
    const bagged = writer.mock.calls[0][0].writeField
    expect(mapped).toBe('ebay_price')
    expect(bagged).toBe('attr_list_price')
    expect(mapped).not.toBe(bagged)
  })

  it('a column the writer does not accept is refused before anything is sent', async () => {
    getStudioColumns.mockResolvedValue({ columns: [col('weave_type', 'weave_type')] })
    await expect(save('weave_type')).rejects.toThrow(/weave_type/)
    expect(writer).not.toHaveBeenCalled()
  })
})

vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map([['AMAZON', 'account-a'], ['EBAY', 'account-b']]) }))


describe('formula listing identity', () => {
  it.each(['', 'alias-b', 'alias-c'])('writes the selected additional account and listing %s', async aliasKey => {
    const coordinate = { productId: PID, scope: 'channel' as const, channel: 'AMAZON', marketplace: 'IT', market: 'IT', locale: 'it', fieldKey: 'list_price', channelConnectionId: 'account-b', aliasKey }
    await setCellFormula({ ...coordinate, expr: '12' })
    expect(writer.mock.calls[0][0]).toMatchObject({ channelConnectionId: 'account-b', aliasKey })
    expect(formulaUpsert.mock.calls[0][0].where.productId_scope_channel_marketplace_locale_fieldKey).toMatchObject({ channelConnectionId: 'account-b', aliasKey })
    expect(listingFindFirst).toHaveBeenCalledWith({ where: { productId: PID, channel: 'AMAZON', marketplace: 'IT', channelConnectionId: 'account-b', aliasKey } })
  })
  it('reads the same primary account and alias targeted by its bulk writer', async () => {
    listingFindFirst.mockClear()
    await save('list_price')
    expect(listingFindFirst).toHaveBeenCalledWith({ where: {
      productId: PID, channel: 'AMAZON', marketplace: 'IT', aliasKey: '', channelConnectionId: 'account-a',
    } })
  })

  it('refuses an ambiguous named alias before saving or deleting', async () => {
    const extra = { aliasKey: 'alias-b' }
    const coordinate = { productId: PID, scope: 'channel' as const, channel: 'AMAZON', marketplace: 'IT', fieldKey: 'list_price', ...extra }
    await expect(setCellFormula({ ...coordinate, expr: '12' })).rejects.toThrow('requires its account')
    await expect(pinOverFormula(coordinate)).rejects.toThrow('requires its account')
    expect(formulaUpsert).not.toHaveBeenCalled()
    expect(writer).not.toHaveBeenCalled()
  })
})
