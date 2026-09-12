vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindUnique = vi.fn()
const formulaUpsert = vi.fn()
const formulaFindMany = vi.fn()
const auditWrite = vi.fn()
const getStudioColumns = vi.fn()

vi.mock('../../../db.js', () => ({
  default: {
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a), update: async () => ({}) },
    channelListing: { findFirst: async () => null, update: async () => ({}) },
    cellFormula: { upsert: (...a: unknown[]) => formulaUpsert(...a), findMany: (...a: unknown[]) => formulaFindMany(...a) },
  },
}))
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: (...a: unknown[]) => auditWrite(...a) } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [] }) }))
vi.mock('../studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))

import { setCellFormula, setFormulaFieldWriter, cellFormulasForProducts } from './cell-formula.service.js'

const PID = 'p1'
const writer = vi.fn()

const col = (key: string, writeField: string, extra: Record<string, unknown> = {}) => ({
  key, writeField, label: key, group: 'g', kind: 'text', storage: 'categoryAttributes',
  scope: 'global', requiredBy: [], editable: true, defaultVisible: true, ...extra,
})

beforeEach(() => {
  for (const m of [productFindUnique, formulaUpsert, formulaFindMany, auditWrite, getStudioColumns, writer]) m.mockReset()
  productFindUnique.mockResolvedValue({
    id: PID, parentId: null, sku: 'SKU', productType: 'OUTERWEAR', version: 3, variationAxes: [],
    categoryAttributes: { brand: 'XAVIA' }, variantAttributes: {}, localizedContent: {},
  })
  formulaFindMany.mockResolvedValue([])
  formulaUpsert.mockImplementation(async (a: any) => ({
    id: 'f1', productId: PID, scope: 'master', channel: '', marketplace: '', locale: 'it',
    market: 'IT', fieldKey: a?.create?.fieldKey ?? 'x', expr: 'e', dependsOn: [],
    lastError: a?.create?.lastError ?? null, evaluatedAt: new Date(), version: 1, updatedBy: null,
  }))
  getStudioColumns.mockResolvedValue({
    columns: [
      col('handmade_classification', 'attr_handmade_classification', { kind: 'select', options: ['handcrafted', 'hand_altered'] }),
      col('skip_offer', 'attr_skip_offer', { kind: 'select', options: ['false', 'true'] }),
      col('manufacturer', 'manufacturer', { storage: 'column' }),
      col('ghs', 'attr_ghs', { kind: 'select', options: Array.from({ length: 100 }, (_, i) => `H${200 + i}`) }),
    ],
  })
  writer.mockImplementation(async (input: any) => ({ ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) }))
  setFormulaFieldWriter(writer as never)
})

const save = (fieldKey: string, expr: string) =>
  setCellFormula({ productId: PID, scope: 'master', locale: 'it', market: 'IT', fieldKey, expr, updatedBy: 'u', ip: '127.0.0.1' })

describe('formula writes follow the ordinary field contract', () => {
  it.each([['manufacturer', '"Xavia"', 'Xavia'], ['handmade_classification', '"handcrafted"', 'handcrafted'],
    ['skip_offer', '"TRUE"', 'true'], ['ghs', '"H200"', 'H200']])(
    'saves %s through the field writer', async (field, expr, expected) => {
      const result = await save(field, expr)
      expect(result.error).toBeNull()
      expect(writer.mock.calls[0][0].value).toBe(expected)
      expect(formulaUpsert).toHaveBeenCalledTimes(1)
    },
  )

  it('rejects read-only fields before any write', async () => {
    getStudioColumns.mockResolvedValue({ columns: [col('manufacturer', 'manufacturer', { editable: false })] })
    await expect(save('manufacturer', '"x"')).rejects.toThrow(/read-only/)
    expect(writer).not.toHaveBeenCalled()
    expect(formulaUpsert).not.toHaveBeenCalled()
  })

  it('keeps option validation for text formulas', async () => {
    const result = await save('skip_offer', '"maybe"')
    expect(result.error).toContain('allowed')
    expect(writer).not.toHaveBeenCalled()
  })

  it('saves numeric prices through the ordinary writer and records the actual value', async () => {
    getStudioColumns.mockResolvedValue({ columns: [col('basePrice', 'basePrice', { kind: 'number', storage: 'column' })] })
    const result = await save('basePrice', '10 * 1.2')
    expect(result.error).toBeNull()
    expect(writer.mock.calls[0][0]).toMatchObject({ writeField: 'basePrice', value: 12, market: 'IT' })
    expect(auditWrite.mock.calls[0][0]).toMatchObject({ action: 'formula.set', after: { value: 12 }, metadata: { refused: false } })
  })

  it('requires the market before attempting a price write', async () => {
    await expect(setCellFormula({ productId: PID, scope: 'master', locale: 'it', fieldKey: 'basePrice', expr: '10' } as never))
      .rejects.toThrow(/market is required/)
    expect(writer).not.toHaveBeenCalled()
  })
})


it('evaluates text from a source field and persists the expression separately from its result', async () => {
  const result = await save('manufacturer', '$brand & " Factory"')
  expect(result.error).toBeNull()
  expect(writer).toHaveBeenCalledWith(expect.objectContaining({ writeField: 'manufacturer', value: 'XAVIA Factory' }))
  expect(formulaUpsert.mock.calls[0][0].create).toMatchObject({ fieldKey: 'manufacturer', expr: '$brand & " Factory"', dependsOn: ['brand'] })
})


it('loads formula candidates across languages so shared fields retain one owner', async () => {
  await cellFormulasForProducts({ productIds: [PID], scope: 'master', channel: null, marketplace: null, locale: 'it' })
  expect(formulaFindMany).toHaveBeenLastCalledWith({ where: { productId: { in: [PID] }, scope: 'master', channel: '', marketplace: '', channelConnectionId: '', aliasKey: '' } })
})
