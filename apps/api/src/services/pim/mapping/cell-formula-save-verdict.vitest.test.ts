vi.mock('../workspace-destination.js', () => ({ resolveWorkspaceDestination: async (input: any) => ({ accountId: input.accountId }) }))
vi.mock('../product-category-context.js', () => ({ productCategoryContext: async () => ({ categories: ['OUTERWEAR'], defaults: { p1: { channelCategoryId: 'OUTERWEAR' } }, byRow: new Map([['p1:', { channelCategoryId: 'OUTERWEAR' }]]) }) }))
/**
 * Audit A31 — a formula's result gets the verdict a typed value gets, in the same words. The formula writes through the
 * ordinary cell writer (the bulk PATCH); that writer's warnings are the save's verdict, and they replace the formula's
 * private checks (a raw-length sentence, "the channel may refuse it at publish").
 *
 * Harness: the one of `cell-formula-channel-write.vitest.test.ts` (#758 → #775 — where a CHANNEL formula write is SENT).
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
    // LX.F R-LX-13 — `prepareCellFormula` asks the ONE authority for the
    // coordinate's languages (`cell-formula.service.ts:369`) before resolving.
    marketplace: { findFirst: async () => ({ languages: ['it'], language: 'it' }) },
  },
}))
vi.mock('../../audit-log.service.js', () => ({ auditLogService: { write: async () => {} } }))
vi.mock('../schema-mapping.service.js', () => ({ getMappingForMarketplace: async () => ({ expressions: {} }) }))
vi.mock('./field-catalogue.service.js', () => ({ getFieldCatalogue: async () => ({ fields: [{ fieldKey: 'genere', label: 'Genere', kind: 'text', shape: 'scalar', maxLength: 65,
  channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Genere'] } },
  { fieldKey: 'stagione', label: 'Stagione', kind: 'select', shape: 'scalar', options: ['Tutte le stagione', 'Estate'], selectionOnly: true,
  channelStore: { kind: 'platformAttributes', path: ['itemSpecifics', 'Stagione'] } }] }) }))
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

vi.mock('../../connection-resolver.service.js', () => ({ primaryConnectionIds: async () => new Map([['AMAZON', 'account-a'], ['EBAY', 'account-b']]) }))

const JOINED = Array.from({ length: 10 }, (_, i) => `Valore ${i}`).join(', ') // 88 characters, 10 values
const VERDICT = `Genere: Genere takes one value; eBay would receive 10 (${JOINED.split(', ').map(v => JSON.stringify(v)).join(', ')}).`
const saveGenere = () => setCellFormula({ productId: PID, scope: 'channel', channel: 'EBAY', marketplace: 'IT', locale: 'it', market: 'IT', fieldKey: 'genere', expr: JSON.stringify(JOINED) })

describe('A31 — the formula answers with the save\'s verdict', () => {
  beforeEach(() => { getStudioColumns.mockResolvedValue({ columns: [{ ...col('genere', 'attr_genere'), kind: 'text' }] }) })

  it('the writer\'s warning replaces the formula\'s own raw-length sentence', async () => {
    const typed = 'Genere: a sentence only the save says'
    writer.mockImplementation(async (input: any) => ({ ok: true, atomicResults: await Promise.all(input.atomic?.() ?? []), warnings: [typed] }))
    const out = await saveGenere()
    expect(out.error).toBeNull()
    expect(out.warnings).toEqual([typed])
  })

  it('a writer that says nothing about the value leaves the formula\'s own check — now in the same words', async () => {
    const out = await saveGenere()
    // The formula's own check is the typed channel check, in its words: a joined list on a one-value eBay aspect is a count.
    expect(out.warnings).toEqual([VERDICT])
  })

  it('an off-list eBay value is not said to be refused at publish (eBay takes it; publish warns); Amazon still is', async () => {
    getStudioColumns.mockResolvedValue({ columns: [{ ...col('stagione', 'attr_stagione'), kind: 'select' }] })
    const saveSeason = (channel: string) => setCellFormula({ productId: PID, scope: 'channel', channel, marketplace: 'IT', locale: 'it', market: 'IT', fieldKey: 'stagione', expr: '"Tutte le stagioni"' })
    expect((await saveSeason('EBAY')).warnings.join(' ')).not.toContain('may refuse it at publish')
    expect((await saveSeason('AMAZON')).warnings.join(' ')).toContain('the channel may refuse it at publish')
  })
})
