/**
 * LX.F P1-4 — an untranslated REQUIRED field is ONE issue, not two.
 *
 * Two producers fire for the same cell: `readiness.service.ts:212` nulls a
 * source-language fallback before validating (so `findMissingRequired` raises
 * "<label> is required by <coordinate>") and the sheet's own loop raises
 * "<locale> content is missing; showing <language> fallback." for the same key.
 * The mapping push beside it already de-duplicates; this one did not, so the
 * alias summary's error count double-counted and `ReadinessIndex.missing` listed
 * the same field twice with two sentences.
 *
 * ⚠ Constructed family, legitimately: the claim is a DERIVATION of this function
 * (given a required, untranslated column, how many issues does the row carry),
 * not a claim about where anything is stored. The integration arm in
 * `content-write.vitest.test.ts` measures the same property on writer-produced
 * rows in a real PostgreSQL, where no column happens to be required.
 *
 * Run: npx vitest run src/services/pim/studio-sheet-language-issue.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const aliasFindMany = vi.fn()
const fieldLinkGroupFindMany = vi.fn()
const cellFormulaFindMany = vi.fn()
const getStudioColumns = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: (...a: unknown[]) => productFindFirst(...a), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    productListingAlias: { findMany: (...a: unknown[]) => aliasFindMany(...a) },
    fieldLinkGroup: { findMany: (...a: unknown[]) => fieldLinkGroupFindMany(...a) },
    cellFormula: { findMany: (...a: unknown[]) => cellFormulaFindMany(...a) },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [{ channel: 'AMAZON', code: 'DE', languages: ['de'], language: 'de' }, { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }] },
  },
}))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['OUTERWEAR'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: async () => ({ byProduct: {}, categoryByProduct: {}, missingProductIds: [], meta: {} }) }))

import { getStudioSheet } from './studio-sheet.service.js'

const PRODUCT = 'p_solo'
const COORD = { channel: 'AMAZON', marketplace: 'DE', label: 'Amazon · DE', inMarket: true, languages: ['de'] }

beforeEach(() => {
  for (const m of [productFindFirst, productFindMany, channelListingFindMany, aliasFindMany, fieldLinkGroupFindMany, cellFormulaFindMany, getStudioColumns]) m.mockReset()
  productFindFirst.mockResolvedValue({ id: PRODUCT, parentId: null })
  // Italian source text, no German translation — the catalogue's default state.
  productFindMany.mockResolvedValue([{ id: PRODUCT, sku: 'SOLO', isParent: false, parentId: null, productType: 'OUTERWEAR',
    name: 'Giacca', description: 'Descrizione', variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [] }])
  channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: PRODUCT, channel: 'AMAZON', marketplace: 'DE', channelConnectionId: 'account',
    platformAttributes: { productType: 'OUTERWEAR' }, translations: [], aliasKey: null }])
  aliasFindMany.mockResolvedValue([])
  fieldLinkGroupFindMany.mockResolvedValue([])
  cellFormulaFindMany.mockResolvedValue([])
  getStudioColumns.mockResolvedValue({ coordinates: [COORD], columns: [{
    key: 'name', writeField: 'name', label: 'Product title', group: 'Content', kind: 'text', storage: 'column',
    scope: 'per_variant', requiredBy: ['Amazon · DE'], editable: true, defaultVisible: true,
  }] })
})

describe('an untranslated required content field', () => {
  it('raises exactly ONE error naming both facts, with the language-fallback kind', async () => {
    const sheet = await getStudioSheet({ productId: PRODUCT, scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de' })
    const forTitle = sheet.rows[0].readiness.issues.filter(issue => issue.key === 'name')
    expect(forTitle).toHaveLength(1)
    expect(forTitle[0].severity).toBe('error')
    expect(forTitle[0].kind).toBe('language-fallback')
    // Both producers' facts survive in one sentence and one next click.
    expect(forTitle[0].message).toBe('Product title is required by Amazon · DE — de content is missing; showing it fallback.')
    // The count every summary and ReadinessIndex.missing reads is 1, not 2.
    expect(sheet.rows[0].readiness.issues.filter(issue => issue.severity === 'error' && issue.key === 'name')).toHaveLength(1)
  })

  it('POSITIVE CONTROL — the required producer fires ALONE when there is no fallback to merge', async () => {
    // Primary language, no text at all: the required verdict is the only issue,
    // unmerged and with no `kind` — the exact sentence the merged message above
    // starts with, so the merge is provably joining two live producers.
    productFindMany.mockResolvedValue([{ id: PRODUCT, sku: 'SOLO', isParent: false, parentId: null, productType: 'OUTERWEAR',
      name: null, description: null, variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [] }])
    const sheet = await getStudioSheet({ productId: PRODUCT, scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'it' })
    const forTitle = sheet.rows[0].readiness.issues.filter(issue => issue.key === 'name')
    expect(forTitle.map(issue => [issue.message, issue.kind])).toEqual([['Product title is required by Amazon · DE', undefined]])
  })

  it('an untranslated OPTIONAL field stays a single warning', async () => {
    getStudioColumns.mockResolvedValue({ coordinates: [COORD], columns: [{
      key: 'name', writeField: 'name', label: 'Product title', group: 'Content', kind: 'text', storage: 'column',
      scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true,
    }] })
    const sheet = await getStudioSheet({ productId: PRODUCT, scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de' })
    const forTitle = sheet.rows[0].readiness.issues.filter(issue => issue.key === 'name')
    expect(forTitle).toHaveLength(1)
    expect(forTitle[0]).toMatchObject({ severity: 'warn', kind: 'language-fallback', message: 'de content is missing; showing it fallback.' })
  })
})

/**
 * R-LX-10 — the Studio sheet read is cache-only BY CONSTRUCTION. Asserted where
 * the sheet actually calls the column builder: whatever that builder does, and
 * whatever it calls, runs with `cachedSchemasOnly()` true, so the SP-API fallback
 * at `channel-specs/index.ts:73` cannot fire on a page load.
 */
it('runs the whole read inside withCachedSchemas', async () => {
  const { cachedSchemasOnly } = await import('./cached-schema-context.js')
  // POSITIVE CONTROL: outside the read, the flag is false.
  expect(cachedSchemasOnly()).toBe(false)
  let insideTheRead: boolean | null = null
  getStudioColumns.mockImplementation(async () => {
    insideTheRead = cachedSchemasOnly()
    return { coordinates: [COORD], columns: [{ key: 'name', writeField: 'name', label: 'Product title', group: 'Content', kind: 'text', storage: 'column', scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true }] }
  })
  await getStudioSheet({ productId: PRODUCT, scope: 'channel', channel: 'AMAZON', market: 'DE', locale: 'de' })
  expect(insideTheRead).toBe(true)
  expect(cachedSchemasOnly()).toBe(false)
})
