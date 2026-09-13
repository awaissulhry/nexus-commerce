vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindUnique = vi.fn()
const productUpdate = vi.fn()
const listingFindFirst = vi.fn()
const listingUpdate = vi.fn()
const formulaUpsert = vi.fn()
const formulaFindMany = vi.fn()
const formulaFindUnique = vi.fn()
const formulaDeleteMany = vi.fn()
const auditCreate = vi.fn()
const auditWrite = vi.fn()

/**
 * CLOSE.1 (the 20 attributed API reds) — `Marketplace.languages` IS the contract `market-languages.ts` reads,
 * so the mock has to carry it. Without this model the service died on
 * `prisma.marketplace.findFirst` with `Cannot read properties of undefined (reading 'findFirst')`:
 * LX made the market's languages an authority every coordinate consults (`loadContext` →
 * `marketLanguages(channel, marketplace)`), and this fixture predated it. Rows, not a code→language
 * rule, because rows are what the table holds.
 */
const MARKETPLACE_ROWS = [
  { channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' },
  { channel: 'EBAY', code: 'DE', languages: ['de'], language: 'de' },
  { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' },
  { channel: 'AMAZON', code: 'DE', languages: ['de'], language: 'de' },
]
const marketplaceFindFirst = async (args: any) => MARKETPLACE_ROWS.find(row =>
  (!args?.where?.channel || row.channel === args.where.channel) && (!args?.where?.code || row.code === args.where.code)) ?? null

vi.mock('../../../db.js', () => {
  const client: Record<string, unknown> = {
    /* CLOSE.1 — `restoreFormulaSnapshot` runs inside `inDatabaseTransaction`
       (`lib/database-context.ts:53`), which calls `client.$transaction`. The mock had no such
       function, so the restore test died with `client.$transaction is not a function` rather than
       asserting anything. The interactive form is the one the service uses: it hands the callback a
       client, and that client is THIS mock — the same rows the assertions read. */
    $transaction: (fn: any) => (typeof fn === 'function' ? fn(client) : Promise.all(fn)),
    marketplace: { findFirst: (...a: unknown[]) => marketplaceFindFirst(a[0]) },
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a), findUniqueOrThrow: (...a: unknown[]) => productFindUnique(...a), update: (...a: unknown[]) => productUpdate(...a) },
    channelListing: { findFirst: (...a: unknown[]) => listingFindFirst(...a), update: (...a: unknown[]) => listingUpdate(...a) },
    auditLog: { create: (...a: unknown[]) => auditCreate(...a) },
    cellFormula: { findUnique: (...a: unknown[]) => formulaFindUnique(...a), deleteMany: (...a: unknown[]) => formulaDeleteMany(...a), upsert: (...a: unknown[]) => formulaUpsert(...a), findMany: (...a: unknown[]) => formulaFindMany(...a) },
  }
  return { default: client }
})
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: (...a: unknown[]) => auditWrite(...a) } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [] }) }))
// #775 — the column set resolves `writeField` and any option list.
const getStudioColumns = vi.fn()
vi.mock('../studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))

import { setCellFormula, previewCellFormula, setCellLiteral, readFormulaCell, restoreFormulaSnapshot, setFormulaFieldWriter } from './cell-formula.service.js'

const PID = 'p1'
const writer = vi.fn()
let version = 3
beforeEach(() => {
  for (const m of [productFindUnique, productUpdate, listingFindFirst, listingUpdate, formulaUpsert, formulaFindMany, formulaFindUnique, formulaDeleteMany, auditCreate, auditWrite]) m.mockReset()
  version = 3
  productFindUnique.mockImplementation(async (args: any) =>
    args?.select?.version
      ? { version }                                   // the read-BACK after the write
      : { id: PID, parentId: null, sku: 'SKU', productType: 'OUTERWEAR', version,
          categoryAttributes: { brand: 'XAVIA' }, variantAttributes: {}, localizedContent: {} })
  // #775 — the write goes through the injected writer now; it is what moves the
  // version, so the read-back assertions still exercise a real change.
  writer.mockReset()
  writer.mockImplementation(async (input: any) => { version += 1; return { ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) } })
  setFormulaFieldWriter(writer as never)
  getStudioColumns.mockReset()
  getStudioColumns.mockResolvedValue({
    columns: [{ key: 'basePrice', writeField: 'basePrice', label: 'Base price', kind: 'number', storage: 'column' }],
  })
  productUpdate.mockImplementation(async () => { version += 1; return {} })
  formulaFindMany.mockResolvedValue([])
  formulaUpsert.mockResolvedValue({
    id: 'f1', productId: PID, scope: 'master', channel: '', marketplace: '', locale: 'de',
    market: 'DE', fieldKey: 'basePrice', expr: 'e', dependsOn: [], lastError: null,
    evaluatedAt: new Date(), version: 1, updatedBy: null,
  })
})

const save = (expr: string) => setCellFormula({
  productId: PID, scope: 'master', locale: 'de', market: 'DE',
  fieldKey: 'basePrice', expr, updatedBy: 'u9', ip: '10.1.2.3',
})

describe('#765 a formula SAVE writes exactly one audit row', () => {
  it('a good save records actor, ip, coordinate, expr, the VALUE written and version before/after', async () => {
    await save('10 * 1.2')
    expect(auditWrite).toHaveBeenCalledTimes(1)
    const row = auditWrite.mock.calls[0][0]
    expect(row.action).toBe('formula.set')
    expect(row.userId).toBe('u9')
    expect(row.ip).toBe('10.1.2.3')
    expect(row.entityId).toBe(PID)
    expect(row.before).toEqual({ field: 'basePrice', value: null, version: 3 })
    expect(row.after).toMatchObject({ field: 'basePrice', value: 12, version: 4 })
    expect(row.metadata).toMatchObject({
      scope: 'master', locale: 'de', market: 'DE', fieldKey: 'basePrice',
      expr: '10 * 1.2', refused: false, versionOf: 'product',
    })
  })

  it('a REFUSED save writes a refusal row: lastError set, no value', async () => {
    // "No row" is the state that made three unattributed writes unanswerable.
    await save('$athlete_typo')
    expect(auditWrite).toHaveBeenCalledTimes(1)
    const row = auditWrite.mock.calls[0][0]
    expect(row.action).toBe('formula.set')
    expect(row.after.value).toBeNull()
    expect(row.metadata.refused).toBe(true)
    expect(String(row.metadata.lastError)).toContain('athlete_typo')
  })

  it('SENSITIVITY: the version pair is READ, not computed', async () => {
    // If `after` were `before + 1` this passes anyway; make the row move by
    // TWO behind the writer's back and the read-back must report it.
    writer.mockImplementation(async (input: any) => { version += 2; return { ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) } })
    await save('10 * 1.2')
    const row = auditWrite.mock.calls[0][0]
    expect(row.before).toEqual({ field: 'basePrice', value: null, version: 3 })
    expect(row.after.version).toBe(5)
  })

  it('the value recorded is the one WRITTEN, not the expression', async () => {
    await save('10 * 1.2')
    const written = writer.mock.calls[0][0].value
    expect(auditWrite.mock.calls[0][0].after.value).toBe(written)
  })
})

describe('safe formula persistence', () => {
  it('keeps the current value when the expression is invalid', async () => {
    await save('$athlete_typo')
    expect(writer).not.toHaveBeenCalled()
    expect(formulaUpsert.mock.calls[0][0].update.lastError).toContain('athlete_typo')
  })
  it('does not store an expression when its value write is refused', async () => {
    writer.mockResolvedValue({ ok: false, error: 'Another change landed first' })
    await expect(save('12')).rejects.toThrow('Another change landed first')
    expect(formulaUpsert).not.toHaveBeenCalled()
  })
  it('rejects a loop between stored cell formulas before any write', async () => {
    formulaFindMany.mockResolvedValue([{ productId: PID, scope: 'master', channel: '', marketplace: '', locale: 'de', fieldKey: 'brand', dependsOn: ['basePrice'] }])
    await expect(save('$brand')).rejects.toThrow('Circular reference')
    expect(writer).not.toHaveBeenCalled()
    expect(formulaUpsert).not.toHaveBeenCalled()
  })
})


describe('atomic literal replacement and undo', () => {
  const coord = { productId: PID, scope: 'master' as const, locale: 'de', market: 'DE', fieldKey: 'basePrice' }
  it('removes the previous formula inside the value transaction, including a same-value edit', async () => {
    formulaFindMany.mockResolvedValue([{ locale: 'de', expr: '12', dependsOn: [] }])
    await setCellLiteral({ ...coord, value: 12 })
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ value: 12, atomic: expect.any(Function), expectedVersion: 3 }))
    expect(formulaDeleteMany).toHaveBeenCalledTimes(1)
    expect(auditCreate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ action: 'formula.pinned' }) }))
  })
  it('keeps the previous formula when the literal write is refused', async () => {
    formulaFindMany.mockResolvedValue([{ locale: 'de', expr: '12', dependsOn: [] }])
    writer.mockResolvedValue({ ok: false, error: 'Version conflict' })
    await expect(setCellLiteral({ ...coord, value: 20 })).rejects.toThrow('Version conflict')
    expect(formulaDeleteMany).not.toHaveBeenCalled()
  })
  it('detects a changed formula even when its last good value stayed the same', async () => {
    formulaFindMany.mockResolvedValue([{ locale: 'de', expr: '12', version: 1, lastError: null }])
    const before = await readFormulaCell(coord)
    formulaFindMany.mockResolvedValue([{ locale: 'de', expr: '$missing', version: 2, lastError: 'Unknown field' }])
    await expect(setCellLiteral({ ...coord, value: 20, expectedState: before.expectedState })).rejects.toThrow('changed after the preview')
    expect(writer).not.toHaveBeenCalled()
  })
  it('restores the last valid value and original error without evaluating the broken expression', async () => {
    const current = await readFormulaCell(coord)
    await restoreFormulaSnapshot({ ...coord, expectedState: current.expectedState, snapshot: {
      ...current, value: 42, expr: '$missing', formula: { expr: '$missing', lastError: 'Unknown field', dependsOn: ['missing'], market: 'DE' },
    } })
    expect(writer).toHaveBeenCalledWith(expect.objectContaining({ value: 42, atomic: expect.any(Function) }))
    expect(formulaUpsert).toHaveBeenCalledWith(expect.objectContaining({ update: expect.objectContaining({ expr: '$missing', lastError: 'Unknown field' }) }))
  })
})


it('allows a one-time transform to read its own field while linked formulas reject it', async () => {
  const coord = { productId: PID, scope: 'master' as const, market: 'DE', locale: 'de', fieldKey: 'basePrice', expr: '$basePrice' }
  await expect(previewCellFormula(coord)).rejects.toThrow('cannot depend on itself')
  expect((await previewCellFormula({ ...coord, allowSelfReference: true })).ok).toBe(true)
  expect(writer).toHaveBeenCalledWith(expect.objectContaining({ dryRun: true }))
  expect(formulaUpsert).not.toHaveBeenCalled()
})
