vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Owner item 51 step 2 — recalculation, against
 * `docs/2026-09-02-formula-recalculation-design.md`. One describe per numbered
 * rule, so a rule that stops holding names itself in the failure.
 */

const productFindUnique = vi.fn()
const listingFindFirst = vi.fn()
const formulaFindMany = vi.fn()
const formulaUpdate = vi.fn()
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

vi.mock('../../../db.js', () => ({
  default: {
    marketplace: { findFirst: (...a: unknown[]) => marketplaceFindFirst(a[0]) },
    product: { findUnique: (...a: unknown[]) => productFindUnique(...a) },
    channelListing: { findFirst: (...a: unknown[]) => listingFindFirst(...a) },
    cellFormula: {
      findMany: (...a: unknown[]) => formulaFindMany(...a),
      update: (...a: unknown[]) => formulaUpdate(...a),
    },
  },
}))
vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map() }))
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: (...a: unknown[]) => auditWrite(...a) } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [] }) }))
const getStudioColumns = vi.fn()
vi.mock('../studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))

import { reevaluateDependents, setFormulaFieldWriter } from './cell-formula.service.js'

const PID = 'p1'
const writer = vi.fn()
let version = 3

/** A stored CellFormula row, with the coordinate columns the walk reads. */
const row = (over: Partial<Record<string, unknown>> = {}) => ({
  id: 'f-' + (over.fieldKey ?? 'x'),
  productId: PID,
  scope: 'master',
  channel: '',
  marketplace: '',
  locale: 'de',
  market: 'DE',
  fieldKey: 'manufacturer',
  expr: 'upper($brand)',
  dependsOn: ['brand'],
  lastError: null,
  ...over,
})

beforeEach(() => {
  for (const m of [productFindUnique, listingFindFirst, formulaFindMany, formulaUpdate, auditWrite]) m.mockReset()
  version = 3
  productFindUnique.mockImplementation(async (args: any) =>
    args?.select?.version
      ? { version }
      : {
          id: PID, parentId: null, sku: 'SKU', productType: 'OUTERWEAR', version,
          categoryAttributes: { brand: 'Xavia', manufacturer: 'OLD', colour: 'Black' },
          variantAttributes: {}, localizedContent: {},
        })
  listingFindFirst.mockResolvedValue(null)
  formulaUpdate.mockResolvedValue({})
  writer.mockReset()
  writer.mockImplementation(async (input: any) => { version += 1; return { ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []) } })
  setFormulaFieldWriter(writer as never)
  getStudioColumns.mockReset()
  getStudioColumns.mockResolvedValue({
    columns: [
      { key: 'manufacturer', writeField: 'manufacturer', label: 'Manufacturer', kind: 'text', storage: 'column' },
      { key: 'weave_type', writeField: 'attr_weave_type', label: 'Weave type', kind: 'text', storage: 'column' },
      { key: 'batteries_included', writeField: 'attr_batteries_included', label: 'Are batteries included?',
        kind: 'select', storage: 'attribute', options: ['true', 'false'] },
    ],
  })
})

const run = (changedFields: string[]) =>
  reevaluateDependents({ productId: PID, changedFields, updatedBy: 'u9', ip: '10.1.2.3' })

describe('rule 1 — a write to a source field triggers the dependants', () => {
  it('re-evaluates and WRITES a formula whose dependsOn names the changed field', async () => {
    formulaFindMany.mockResolvedValue([row()])
    const out = await run(['brand'])
    expect(writer).toHaveBeenCalledTimes(1)
    expect(writer.mock.calls[0][0]).toMatchObject({ productId: PID, writeField: 'manufacturer', value: 'XAVIA' })
    expect(out).toEqual([{ fieldKey: 'manufacturer', scope: 'master', value: 'XAVIA', error: null, sourceField: 'brand' }])
  })

  it('CONTROL — a formula that does not depend on the changed field is not touched', async () => {
    formulaFindMany.mockResolvedValue([row({ dependsOn: ['colour'] })])
    const out = await run(['brand'])
    expect(writer).not.toHaveBeenCalled()
    expect(auditWrite).not.toHaveBeenCalled()
    expect(out).toEqual([])
  })

  it('a changed field with NO formula behind it writes nothing (rule 3: a pinned cell has no row)', async () => {
    formulaFindMany.mockResolvedValue([])
    expect(await run(['brand'])).toEqual([])
    expect(writer).not.toHaveBeenCalled()
  })
})

describe('rule 5 — a FAILED recalculation keeps the last value', () => {
  it('an option refusal writes NOTHING and stores lastError', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-b', fieldKey: 'batteries_included', expr: '"maybe"', dependsOn: ['brand'] }),
    ])
    const out = await run(['brand'])
    // The cell keeps whatever it held: no write at all, rather than a write of null.
    expect(writer).not.toHaveBeenCalled()
    expect(String(out[0].error)).toContain('not an allowed value')
    expect(formulaUpdate.mock.calls[0][0].data.lastError).toBe(out[0].error)
  })

  it('an evaluation error writes NOTHING and stores lastError', async () => {
    formulaFindMany.mockResolvedValue([row({ expr: 'upper($athlete_typo)' })])
    const out = await run(['brand'])
    expect(writer).not.toHaveBeenCalled()
    expect(String(out[0].error)).toContain('athlete_typo')
    expect(formulaUpdate.mock.calls[0][0].data.lastError).toBe(out[0].error)
  })

  it('a refusal marks dependent formulas without writing an invalid value', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-b', fieldKey: 'batteries_included', expr: '"maybe"', dependsOn: ['brand'] }),
      row({ id: 'f-w', fieldKey: 'weave_type', expr: 'lower($brand)', dependsOn: ['batteries_included'] }),
    ])
    const out = await run(['brand'])
    expect(out.map((r) => r.fieldKey)).toEqual(['batteries_included', 'weave_type'])
    expect(out[1].error).toContain('batteries_included has a formula error')
    expect(writer).not.toHaveBeenCalled()
  })
})

describe('rule 7 — topological order within the row', () => {
  it('a chain evaluates in order and each step SEES the previous result', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-w', fieldKey: 'weave_type', expr: 'lower($manufacturer)', dependsOn: ['manufacturer'] }),
      row({ id: 'f-m', fieldKey: 'manufacturer', expr: 'upper($brand)', dependsOn: ['brand'] }),
    ])
    const out = await run(['brand'])
    expect(out.map((r) => r.fieldKey)).toEqual(['manufacturer', 'weave_type'])
    // 'xavia' proves the OVERLAY was read. The stored value is 'OLD'; a walk
    // that re-read the row instead of carrying the new value writes 'old'.
    expect(out[1].value).toBe('xavia')
    expect(writer.mock.calls[1][0]).toMatchObject({ writeField: 'attr_weave_type', value: 'xavia' })
  })
})

describe('OWNER RULING 2026-09-03 — synchronous always, no queue fallback', () => {
  it('NO CAP: 60 dependants (past the refused 50 threshold) all recalculate in ONE call', async () => {
    // The design draft recommended deferring above 50 dependants; the Owner
    // refused it. This pins that: re-introduce any threshold, cap or deferral
    // and this fails at the count. 60 is chosen to sit clearly past the 50 the
    // draft named, so an off-by-one cap cannot pass either.
    const many = Array.from({ length: 60 }, (_, i) =>
      row({ id: `f-${i}`, fieldKey: `attr_f${String(i).padStart(2, '0')}`, expr: 'upper($brand)', dependsOn: ['brand'] }))
    getStudioColumns.mockResolvedValue({ columns: [
      ...many.map(row => ({ key: row.fieldKey, writeField: row.fieldKey, label: row.fieldKey, kind: 'text', storage: 'attribute' })),
    ] })
    formulaFindMany.mockResolvedValue(many)
    const out = await run(['brand'])
    expect(out).toHaveLength(60)
    expect(writer).toHaveBeenCalledTimes(60)
    expect(auditWrite).toHaveBeenCalledTimes(60)
    // Every one of them actually produced a value — a cap that "succeeded" by
    // recording 60 errors would otherwise read as a pass.
    expect(out.every((r) => r.error === null && r.value === 'XAVIA')).toBe(true)
  })
})

describe('rule 8 — every cascaded write records a formula.recalc audit row', () => {
  it('carries the ORIGINAL actor and ip, the source field, expr, value and versions', async () => {
    formulaFindMany.mockResolvedValue([row()])
    await run(['brand'])
    expect(auditWrite).toHaveBeenCalledTimes(1)
    const a = auditWrite.mock.calls[0][0]
    expect(a.action).toBe('formula.recalc')
    expect(a.userId).toBe('u9')
    expect(a.ip).toBe('10.1.2.3')
    expect(a.entityId).toBe(PID)
    expect(a.before).toEqual({ version: 3 })
    expect(a.after).toEqual({ version: 4 })
    expect(a.metadata).toMatchObject({
      scope: 'master', fieldKey: 'manufacturer', sourceField: 'brand',
      expr: 'upper($brand)', value: 'XAVIA', refused: false, versionOf: 'product',
    })
  })

  it('SENSITIVITY: the version pair is READ BACK, not computed', async () => {
    formulaFindMany.mockResolvedValue([row()])
    writer.mockImplementation(async () => { version += 2; return { ok: true } })
    await run(['brand'])
    const a = auditWrite.mock.calls[0][0]
    expect(a.before).toEqual({ version: 3 })
    expect(a.after).toEqual({ version: 5 })
  })

  it('a REFUSED recalculation still records a row, marked refused with no value', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-b', fieldKey: 'batteries_included', expr: '"maybe"', dependsOn: ['brand'] }),
    ])
    await run(['brand'])
    const a = auditWrite.mock.calls[0][0]
    expect(a.metadata.refused).toBe(true)
    expect(a.metadata.value).toBeNull()
    expect(a.metadata.allowedOptions).toEqual(['true', 'false'])
    // Nothing was written, so the version cannot have moved.
    expect(a.after).toEqual({ version: 3 })
  })

  it('names the field that TRIGGERED it, not merely the first dependency', async () => {
    // Every other fixture here gives a formula ONE dependency, which pins the
    // dimension this assertion is about: with one entry, `trigger` and
    // `dependsOn[0]` are the same string and `sourceField: row.dependsOn[0]`
    // passes the whole suite. Two dependencies, and only the SECOND changed.
    formulaFindMany.mockResolvedValue([row({ dependsOn: ['colour', 'brand'] })])
    await run(['brand'])
    expect(auditWrite.mock.calls[0][0].metadata.sourceField).toBe('brand')
  })

  it('the value recorded is the one WRITTEN', async () => {
    formulaFindMany.mockResolvedValue([row()])
    await run(['brand'])
    expect(auditWrite.mock.calls[0][0].metadata.value).toBe(writer.mock.calls[0][0].value)
  })
})

describe('dependency graph regressions', () => {
  it.each([true, false])('resolves multiple dependencies regardless of stored order (reverse=%s)', async reverse => {
    const rows = [
      row({ id: 'f-m', fieldKey: 'manufacturer', expr: 'upper($brand)', dependsOn: ['brand'] }),
      row({ id: 'f-w', fieldKey: 'weave_type', expr: '$brand & " / " & $manufacturer', dependsOn: ['brand', 'manufacturer'] }),
    ]
    formulaFindMany.mockResolvedValue(reverse ? rows.reverse() : rows)
    const out = await run(['brand'])
    expect(out.find(r => r.fieldKey === 'weave_type')?.value).toBe('Xavia / XAVIA')
  })
  it('recalculates the same field in each locale', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-de', locale: 'de', expr: 'upper($brand)' }),
      row({ id: 'f-en', locale: 'en', expr: 'lower($brand)' }),
    ])
    await run(['brand'])
    expect(formulaUpdate.mock.calls.map(c => c[0].where.id)).toEqual(['f-de', 'f-en'])
  })
  it('keeps reference results separate across locales', async () => {
    formulaFindMany.mockResolvedValue([
      row({ id: 'f-de', locale: 'de', expr: 'upper($brand)' }),
      row({ id: 'f-en', locale: 'en', fieldKey: 'weave_type', expr: '$manufacturer', dependsOn: ['brand', 'manufacturer'] }),
    ])
    const out = await run(['brand'])
    expect(out[1].value).not.toBe('XAVIA')
  })
  it('reports pre-existing cycles and preserves their values', async () => {
    formulaFindMany.mockResolvedValue([
      row({ fieldKey: 'manufacturer', expr: '$weave_type', dependsOn: ['brand', 'weave_type'] }),
      row({ fieldKey: 'weave_type', expr: '$manufacturer', dependsOn: ['manufacturer'] }),
    ])
    const out = await run(['brand'])
    expect(out.some(r => r.error?.includes('Circular reference'))).toBe(true)
    expect(writer).not.toHaveBeenCalled()
  })
})


it('recalculates variant formulas after an inherited parent field changes, even when the parent has no formulas', async () => {
  const child = row({ productId: 'child', fieldKey: 'manufacturer' })
  formulaFindMany.mockImplementation(async ({ where }: any) => where.product ? [{ productId: 'child' }] : where.productId === 'child' ? [child] : [])
  productFindUnique.mockImplementation(async ({ where, select }: any) => select?.version ? { version } : {
    id: where.id, parentId: where.id === 'child' ? PID : null, sku: where.id, productType: 'OUTERWEAR', version,
    categoryAttributes: where.id === 'child' ? {} : { brand: 'New brand' }, variantAttributes: {}, localizedContent: {},
  })
  const out = await run(['brand'])
  expect(writer).toHaveBeenCalledWith(expect.objectContaining({ productId: 'child', writeField: 'manufacturer', value: 'NEW BRAND' }))
  expect(out).toContainEqual(expect.objectContaining({ productId: 'child', value: 'NEW BRAND' }))
})

it('keeps a channel change within its marketplace', async () => {
  getStudioColumns.mockResolvedValue({ columns: [{ key: 'subtitle', writeField: 'attr_subtitle', label: 'Subtitle', kind: 'text', storage: 'platformAttributes', writeTarget: 'channelListing' }] })
  formulaFindMany.mockResolvedValue([
    row({ scope: 'channel', channel: 'EBAY', marketplace: 'IT', fieldKey: 'subtitle' }),
    row({ scope: 'channel', channel: 'EBAY', marketplace: 'DE', fieldKey: 'subtitle' }),
  ])
  await reevaluateDependents({ productId: PID, changedFields: ['brand'], coordinate: { channel: 'EBAY', marketplace: 'IT' } })
  expect(writer).toHaveBeenCalledTimes(1)
  expect(writer).toHaveBeenCalledWith(expect.objectContaining({ marketplace: 'IT' }))
})

it('keeps the canonical value when a historical channel formula targets a Shared product field', async () => {
  formulaFindMany.mockResolvedValue([row({ scope: 'channel', channel: 'EBAY', marketplace: 'IT' })])
  const out = await run(['brand'])
  expect(writer).not.toHaveBeenCalled()
  expect(out[0].error).toContain('belongs to Shared product')
  expect(formulaUpdate).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ lastError: expect.stringContaining('previous value is kept') }) }))
})
