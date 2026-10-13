vi.mock('../workspace-destination.js', () => ({ resolveWorkspaceDestination: async (input: any) => ({ accountId: input.accountId }) }))
vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], defaults: { p1: { channelCategoryId: 'OUTERWEAR' } }, byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map([['AMAZON', 'account-a']]) }))
/**
 * G4 (2026-10-13) — a formula write answers the row version it left, so the product sheet's writer goes on from it.
 *
 * The defect: `PUT /pim/formulas/product/:id` (and `/value`) moved `Product.version` (or the listing's) through the bulk
 * writer and answered no version at all. The sheet kept the version from before the formula, and its next cell save of
 * the row came back 409 "Another change landed first" — the other change being its own formula.
 *
 * The answer names the row the way the bulk route does (`versionOf`), the version the write's compare-and-set was made
 * over (`versionBefore`), and the version READ BACK after the write and its cascade (`currentVersion`).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

let productVersion = 3
let listingVersion = 7
const listingRow = { id: 'listing-1', productId: 'p1', channel: 'AMAZON', marketplace: 'IT', aliasKey: '', channelConnectionId: 'account-a', translations: [] as unknown[] }
const productFindUnique = vi.fn()
const listingFindFirst = vi.fn()
const listingFindUnique = vi.fn()
const formulaUpsert = vi.fn()
const formulaFindMany = vi.fn()
const formulaDeleteMany = vi.fn()
const getStudioColumns = vi.fn()
const writer = vi.fn()

vi.mock('../../../db.js', () => ({
  default: {
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a), update: async () => ({}) },
    channelListing: { findFirst: (...a: unknown[]) => listingFindFirst(...a), findUnique: (...a: unknown[]) => listingFindUnique(...a), update: async () => ({}) },
    cellFormula: { upsert: (...a: unknown[]) => formulaUpsert(...a), findMany: (...a: unknown[]) => formulaFindMany(...a), deleteMany: (...a: unknown[]) => formulaDeleteMany(...a) },
    auditLog: { create: async () => ({}) },
    marketplace: { findFirst: async () => ({ languages: ['it'], language: 'it' }) },
  },
}))
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: async () => {} } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [] }) }))
vi.mock('../studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))

import { setCellFormula, setCellLiteral, setFormulaFieldWriter } from './cell-formula.service.js'

const master = { productId: 'p1', scope: 'master' as const, locale: 'it', market: 'IT', fieldKey: 'basePrice' }
const channel = { productId: 'p1', scope: 'channel' as const, channel: 'AMAZON', marketplace: 'IT', market: 'IT', locale: 'it', fieldKey: 'list_price' }

beforeEach(() => {
  for (const m of [productFindUnique, listingFindFirst, listingFindUnique, formulaUpsert, formulaFindMany, formulaDeleteMany, getStudioColumns, writer]) m.mockReset()
  productVersion = 3
  listingVersion = 7
  productFindUnique.mockImplementation(async (args: any) => args?.select?.version
    ? { version: productVersion }
    : { id: 'p1', parentId: null, sku: 'SKU-X', productType: 'OUTERWEAR', version: productVersion, variationAxes: [],
        categoryAttributes: {}, variantAttributes: {}, localizedContent: {} })
  listingFindFirst.mockImplementation(async () => ({ ...listingRow, version: listingVersion }))
  listingFindUnique.mockImplementation(async () => ({ version: listingVersion }))
  formulaFindMany.mockResolvedValue([])
  formulaUpsert.mockImplementation(async (a: any) => ({ id: 'f1', productId: 'p1', scope: 'master', channel: '', marketplace: '', locale: 'it', market: 'IT',
    fieldKey: a?.create?.fieldKey ?? 'basePrice', expr: 'e', dependsOn: [], lastError: a?.create?.lastError ?? null, evaluatedAt: new Date(), version: 1, updatedBy: null }))
  getStudioColumns.mockResolvedValue({ columns: [
    { key: 'basePrice', writeField: 'basePrice', label: 'Base price', kind: 'number', storage: 'column' },
    { key: 'list_price', writeField: 'attr_list_price', label: 'List price', kind: 'number', storage: 'categoryAttributes', scope: 'global', editable: true },
  ] })
  // The ordinary cell writer moves the row it writes: the product, or for a channel column the listing.
  writer.mockImplementation(async (input: any) => {
    if (input.scope === 'channel') listingVersion += 1
    else productVersion += 1
    return { ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) }
  })
  setFormulaFieldWriter(writer as never)
})

describe('G4 — the formula routes answer the row version they left', () => {
  it('a Shared formula save answers the product version it was made over and the one it holds now', async () => {
    const saved = await setCellFormula({ ...master, expr: '10 * 1.2' })
    expect(saved).toMatchObject({ error: null, versionOf: 'product', versionBefore: 3, currentVersion: 4 })
    expect(saved).not.toHaveProperty('listingId')
  })

  it('SENSITIVITY: the version is READ BACK after the write, never computed as before + 1', async () => {
    writer.mockImplementation(async (input: any) => { productVersion += 2; return { ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) } })
    expect(await setCellFormula({ ...master, expr: '10 * 1.2' })).toMatchObject({ versionBefore: 3, currentVersion: 5 })
  })

  it('a value replacing a formula answers it too', async () => {
    formulaFindMany.mockResolvedValue([{ id: 'f1', locale: 'it', expr: '12', dependsOn: [] }])
    expect(await setCellLiteral({ ...master, value: 20 })).toMatchObject({ ok: true, versionOf: 'product', versionBefore: 3, currentVersion: 4 })
  })

  it('a formula stored without a value (it did not evaluate) answers the version unchanged', async () => {
    const saved = await setCellFormula({ ...master, expr: '$athlete_typo' })
    expect(writer).not.toHaveBeenCalled()
    expect(saved).toMatchObject({ versionOf: 'product', versionBefore: 3, currentVersion: 3 })
  })

  it('a channel column answers the LISTING\'s version and names the listing — never the product\'s', async () => {
    const saved = await setCellFormula({ ...channel, expr: '12' })
    expect(saved).toMatchObject({ versionOf: 'channelListing', versionBefore: 7, currentVersion: 8, listingId: 'listing-1' })
    expect(listingFindUnique).toHaveBeenCalledWith({ where: { id: 'listing-1' }, select: { version: true } })
  })

  it('a read-back that fails answers no version, and the save still stands', async () => {
    listingFindUnique.mockRejectedValue(new Error('connection reset'))
    const saved = await setCellFormula({ ...channel, expr: '12' })
    expect(saved.formula).toBeTruthy()
    expect(saved).not.toHaveProperty('currentVersion')
    expect(saved).not.toHaveProperty('versionBefore')
  })
})
