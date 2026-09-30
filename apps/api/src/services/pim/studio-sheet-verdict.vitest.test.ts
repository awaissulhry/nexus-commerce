/**
 * Audit 2026-09-30 A20 — readiness and the cell's mark take the publish verdict (`value-verdict.ts`): a finding blocks
 * the row (severity 'error') only when publish would block it. An eBay off-list value, a deprecated option or a
 * requirement only a mapping rule's flag claims warns, as the publish review does.
 *
 * Run: npx vitest run src/services/pim/studio-sheet-verdict.vitest.test.ts
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const productFindFirst = vi.fn()
const productFindMany = vi.fn()
const channelListingFindMany = vi.fn()
const getStudioColumns = vi.fn()
const resolveChannelValues = vi.fn()

vi.mock('../../db.js', () => ({
  default: {
    $transaction: async (work: (tx: unknown) => Promise<unknown>) => work({ $executeRaw: async () => 0 }),
    product: { findFirst: (...a: unknown[]) => productFindFirst(...a), findMany: (...a: unknown[]) => productFindMany(...a) },
    channelListing: { findMany: (...a: unknown[]) => channelListingFindMany(...a) },
    productMediaPlan: { findMany: async () => [] },
    productListingAlias: { findMany: async () => [] },
    fieldLinkGroup: { findMany: async () => [] },
    cellFormula: { findMany: async () => [] },
    marketplace: { findUnique: async () => ({ schemaMapping: null }), findMany: async () => [{ channel: 'EBAY', code: 'IT', languages: ['it'], language: 'it' }, { channel: 'AMAZON', code: 'IT', languages: ['it'], language: 'it' }] },
  },
}))
vi.mock('./studio-columns.js', () => ({ getStudioColumns: (...a: unknown[]) => getStudioColumns(...a) }))
vi.mock('./product-category-context.js', () => ({ productCategoryContext: async () => ({ connectionId: 'account', categories: ['177104'], defaults: {} }) }))
vi.mock('./mapping/index.js', () => ({ resolveChannelValues: (...a: unknown[]) => resolveChannelValues(...a) }))
vi.mock('./variation-excluded.js', () => ({ readExcludedListingIds: async () => new Set() }))

import { getStudioSheet } from './studio-sheet.service.js'

const PRODUCT = 'p_solo'
const coordinate = (channel: string) => ({ channel, marketplace: 'IT', label: `${channel === 'EBAY' ? 'eBay' : 'Amazon'} · IT`, inMarket: true, languages: ['it'] })
const OFF_LIST = 'Stagione contains an unaccepted value. Allowed values: Tutte le stagione.'
const mappedCell = (value: unknown, findings: Array<{ rule: string; message: string }>) => ({ fieldKey: 'stagione', label: 'Stagione', value, status: 'mapped', provenance: 'override',
  appliedTransforms: [], warnings: [], errors: findings.map(f => f.message), findings, mappingErrors: [], autoCorrected: null, required: false, overLimit: null })

const setUp = (channel: string, cell: ReturnType<typeof mappedCell>) => {
  productFindFirst.mockResolvedValue({ id: PRODUCT, parentId: null })
  productFindMany.mockResolvedValue([{ id: PRODUCT, sku: 'SOLO', isParent: false, parentId: null, productType: '177104',
    name: 'Giacca', description: 'Descrizione', variationAxes: [], variantAttributes: {}, categoryAttributes: {}, translations: [] }])
  channelListingFindMany.mockResolvedValue([{ id: 'l1', productId: PRODUCT, channel, marketplace: 'IT', channelConnectionId: 'account',
    platformAttributes: { itemSpecifics: { Stagione: cell.value } }, translations: [], aliasKey: null }])
  getStudioColumns.mockResolvedValue({ coordinates: [coordinate(channel)], columns: [{
    key: 'stagione', writeField: 'stagione', label: 'Stagione', group: 'Item specifics', kind: 'select', storage: 'listing',
    scope: 'per_variant', requiredBy: [], editable: true, defaultVisible: true,
  }] })
  resolveChannelValues.mockResolvedValue({ byProduct: { [PRODUCT]: { stagione: cell } }, categoryByProduct: {}, missingProductIds: [], meta: {} })
}
const read = async (channel: string) => {
  const sheet = await getStudioSheet({ productId: PRODUCT, scope: 'channel', channel, market: 'IT', locale: 'it' })
  const row = sheet.rows[0]
  // The harness has no category schema, so the row carries that error too: the claim is about Stagione's own issues.
  return { issues: row.readiness.issues.filter(issue => issue.key === 'stagione'), mapped: row.values.stagione?.mapped }
}

beforeEach(() => { for (const m of [productFindFirst, productFindMany, channelListingFindMany, getStudioColumns, resolveChannelValues]) m.mockReset() })

describe('A20 — the sheet readiness takes the publish verdict', () => {
  it('eBay off-list: a warning on the row, not a block; the cell says the finding does not block', async () => {
    setUp('EBAY', mappedCell('Tutte le stagioni', [{ rule: 'offList', message: OFF_LIST }]))
    const { issues, mapped } = await read('EBAY')
    expect(issues).toEqual([expect.objectContaining({ severity: 'warn', message: OFF_LIST })])
    expect(mapped?.errors).toEqual([OFF_LIST])
    expect(mapped?.blocking).toEqual([])
  })

  it('a deprecated option and a requirement only a mapping rule claims warn too', async () => {
    setUp('EBAY', mappedCell('Estate', [{ rule: 'deprecated', message: 'Stagione: "Estate" is deprecated by the channel.' }, { rule: 'nexus', message: "Field 'Stagione' is required." }]))
    const { issues } = await read('EBAY')
    expect(issues.map(issue => issue.severity)).toEqual(['warn', 'warn'])
  })

  it('POSITIVE CONTROL — the same off-list value on Amazon blocks (a closed enum), as publish does', async () => {
    setUp('AMAZON', mappedCell('Tutte le stagioni', [{ rule: 'offList', message: OFF_LIST }]))
    const { issues, mapped } = await read('AMAZON')
    expect(issues).toEqual([expect.objectContaining({ severity: 'error', message: OFF_LIST })])
    expect(mapped?.blocking).toEqual([OFF_LIST])
  })

  it('an error with no finding keeps blocking (the old meaning)', async () => {
    setUp('EBAY', { ...mappedCell('x', []), errors: ['A sentence with no finding'] })
    const { issues, mapped } = await read('EBAY')
    expect(issues).toEqual([expect.objectContaining({ severity: 'error', message: 'A sentence with no finding' })])
    expect(mapped?.blocking).toEqual(['A sentence with no finding'])
  })
})

/**
 * Audit A21 — on an eBay family, a listing-level item specific (not an axis) has one value per listing. A variation row
 * shows the listing's value, so its readiness and completeness are judged the way publish judges it: only the row the
 * value comes from reports its problems (`reporterOf` in `studio-publication-plan.ts`).
 */
describe('A21 — a variation row is not judged on a listing-level value eBay never receives from it', () => {
  const PARENT = 'p_gale'
  const CHILD = 'p_gale_a'
  const store = { kind: 'platformAttributes', path: ['itemSpecifics', 'Marca'] }
  const REQUIRED = "Field 'Marca' is required."
  const cell = (value: unknown, findings: Array<{ rule: string; message: string }> = []) => ({ ...mappedCell(value, findings), fieldKey: 'marca', label: 'Marca' })
  const family = (parentMarca: unknown) => {
    productFindFirst.mockResolvedValue({ id: PARENT, parentId: null })
    productFindMany.mockResolvedValue([
      { id: PARENT, sku: 'GALE', isParent: true, parentId: null, productType: '177104', name: 'Giacca', variationAxes: ['Colore'], variantAttributes: {}, categoryAttributes: {}, translations: [] },
      { id: CHILD, sku: 'GALE-A', isParent: false, parentId: PARENT, productType: '177104', name: 'Giacca A', variationAxes: [], variantAttributes: { Colore: 'Rosso' }, categoryAttributes: {}, translations: [] },
    ])
    channelListingFindMany.mockResolvedValue([
      { id: 'lp', productId: PARENT, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', platformAttributes: { itemSpecifics: parentMarca ? { Marca: parentMarca } : {} }, translations: [], aliasKey: null },
      { id: 'lc', productId: CHILD, channel: 'EBAY', marketplace: 'IT', channelConnectionId: 'account', platformAttributes: { itemSpecifics: {} }, translations: [], aliasKey: null },
    ])
    getStudioColumns.mockResolvedValue({ coordinates: [coordinate('EBAY')], columns: [{
      key: 'marca', writeField: 'marca', label: 'Marca', group: 'Item specifics', kind: 'text', storage: 'listing',
      scope: 'per_variant', requiredBy: ['eBay · IT'], editable: true, defaultVisible: true,
      channels: { 'eBay · IT': { key: 'marca', store } },
    }] })
    resolveChannelValues.mockResolvedValue({ byProduct: {
      [PARENT]: { marca: cell(parentMarca ?? null, parentMarca ? [] : [{ rule: 'required', message: REQUIRED }]) },
      [CHILD]: { marca: cell(null, [{ rule: 'required', message: REQUIRED }]) },
    }, categoryByProduct: {}, missingProductIds: [], meta: {} })
  }
  const rowsOf = async () => {
    const sheet = await getStudioSheet({ productId: PARENT, scope: 'channel', channel: 'EBAY', market: 'IT', locale: 'it' })
    return Object.fromEntries(sheet.rows.map(row => [row.sku, row]))
  }

  it('the parent supplies "Xavia": the variation row shows it and carries no Marca issue; its completeness counts it filled', async () => {
    family('Xavia')
    const rows = await rowsOf()
    expect(rows['GALE-A'].values.marca.value).toBe('Xavia')
    expect(rows['GALE-A'].readiness.issues.filter(issue => issue.key === 'marca')).toEqual([])
    expect(rows['GALE-A'].completeness.required.missing.map(m => m.key)).not.toContain('marca')
  })

  it('POSITIVE CONTROL — with no value on any row, the listing has none: the variation row still says Marca is required', async () => {
    family(null)
    const rows = await rowsOf()
    // The item-specific column is per variation, so the family row does not report it: the variation must.
    expect(rows['GALE-A'].readiness.issues.filter(issue => issue.key === 'marca' && issue.severity === 'error')).toHaveLength(1)
    expect(rows['GALE-A'].completeness.required.missing.map(m => m.key)).toContain('marca')
  })

  it('a problem on the listing\'s value is the variation row\'s too, with the publish verdict (an eBay off-list value warns)', async () => {
    family('Xavia')
    const OFF = 'Marca contains an unaccepted value. Allowed values: Xavia Racing.'
    const parentCell = cell('Xavia', [{ rule: 'offList', message: OFF }])
    resolveChannelValues.mockResolvedValue({ byProduct: { [PARENT]: { marca: parentCell }, [CHILD]: { marca: cell(null, [{ rule: 'required', message: REQUIRED }]) } },
      categoryByProduct: {}, missingProductIds: [], meta: {} })
    const rows = await rowsOf()
    expect(rows['GALE-A'].readiness.issues.filter(issue => issue.key === 'marca')).toEqual([expect.objectContaining({ severity: 'warn', message: OFF })])
  })
})
