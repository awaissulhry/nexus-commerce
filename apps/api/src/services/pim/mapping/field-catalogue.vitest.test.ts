import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { amazonSpecFromDefinition } from '../channel-specs/amazon.js'
import { buildSheetColumns } from '../sheet-columns.service.js'

const mocks = vi.hoisted(() => ({
  schemaRows: vi.fn(), mapping: vi.fn(), amazon: vi.fn(), ebay: vi.fn(),
}))
vi.mock('../../../db.js', () => ({ default: { channelSchema: { findMany: mocks.schemaRows }, customAttribute: { findMany: async () => [{ code: 'material' }] } } }))
vi.mock('../schema-mapping.service.js', () => ({
  getMappingForMarketplace: mocks.mapping,
  // LX.F R-LX-13 (mock drift, another lane's export landed 08:43 today):
  // `field-catalogue.service.ts:224` now reads the warnings-carrying form.
  getMappingForMarketplaceWithWarnings: async (...args: unknown[]) => ({ mapping: await mocks.mapping(...args), warnings: [] }),
  getRulesFor: (m: any, pt: string) => ({ ...m.fields, ...m.byProductType?.[pt] }),
  MarketplaceNotFoundError: class extends Error {},
}))
vi.mock('../channel-specs/index.js', () => ({
  loadAmazonSpec: mocks.amazon, loadEbaySpec: mocks.ebay, clearChannelSpecCache: vi.fn(),
  loadAmazonEnglishLabels: async () => new Map(),
}))
import { getFieldCatalogue } from './field-catalogue.service.js'
import { validateChannelValue } from './validate-channel-value.js'
import { withEnglish } from '../channel-specs/amazon-english.js'

const definition = JSON.parse(readFileSync(new URL('../channel-specs/__tests__/fixtures/amazon-it-outerwear.trimmed.json', import.meta.url), 'utf8'))
const spec = amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: definition })
const coordinate = { channel: 'AMAZON' as const, marketplace: 'IT', label: 'Amazon · IT', inMarket: true }

beforeEach(() => {
  mocks.schemaRows.mockResolvedValue([])
  mocks.mapping.mockResolvedValue({ fields: {}, byProductType: {} })
  mocks.amazon.mockResolvedValue(spec)
})

describe('mapping catalogue and sheet field parity', () => {
  it('includes every channel field represented by every sheet column, including compound leaves', async () => {
    const catalogue = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
    const { columns } = buildSheetColumns({ fields: [], specs: [{ coordinate, spec }], coordinates: [coordinate], scopeKind: 'channel' })
    const fields = new Map(catalogue.fields.map((f) => [f.fieldKey, f]))
    for (const column of columns) {
      const facts = column.channels?.[coordinate.label]
      if (!facts) continue
      expect(fields.has(facts.key), column.key).toBe(true)
      expect(fields.get(facts.key)?.priority, column.key).toBe(facts.requirement)
    }
    expect(fields.has('item_weight')).toBe(true)
    expect(fields.has('fulfillment_availability__quantity')).toBe(true)
    expect(fields.get('bullet_point')?.sheetKey).toBe('bulletPoints')
    expect(new Set(catalogue.fields.map((f) => f.fieldKey)).size).toBe(catalogue.counts.total)
    expect(catalogue.counts.mapped + catalogue.counts.unmapped + catalogue.counts.owned).toBe(catalogue.counts.total)
    expect(fields.get('fulfillment_availability__quantity')).toMatchObject({ status: 'owned', sourceOwner: { label: 'Inventory' } })
  })

  it('preserves existing rules and category overlays alongside the full schema', async () => {
    mocks.mapping.mockResolvedValue({ fields: { legacy: { source: 'sku' }, brand: { source: 'brand' } }, byProductType: { OUTERWEAR: { brand: { source: 'manufacturer' } } } })
    const c = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
    expect(c.fields.find((f) => f.fieldKey === 'legacy')?.status).toBe('mapped')
    expect(c.fields.find((f) => f.fieldKey === 'brand')).toMatchObject({ overlay: true, rule: { source: 'manufacturer' } })
    expect(c.counts.mapped).toBeGreaterThanOrEqual(2)
  })

  it('uses the selected schema ahead of generic field definitions', async () => {
    mocks.schemaRows.mockResolvedValue([{ fieldKey: 'brand', label: 'Generic brand', required: false, marketplace: null }])
    const c = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
    expect(c.fields.find((f) => f.fieldKey === 'brand')).toMatchObject({ priority: 'required', prioritySource: 'amazonSchema' })
  })

  it('excludes obsolete roots and other-category fields, but retains authored rules for review', async () => {
    mocks.schemaRows.mockResolvedValue([
      { fieldKey: 'fulfillment_availability', label: 'Obsolete compound root', required: true, marketplace: 'IT' },
      { fieldKey: 'other_category_only', label: 'Foreign field', required: true, marketplace: 'IT' },
    ])
    mocks.mapping.mockResolvedValue({ fields: { legacy: { source: 'sku' } }, byProductType: {} })
    const c = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })
    expect(c.fields.some(f => f.fieldKey === 'fulfillment_availability')).toBe(false)
    expect(c.fields.some(f => f.fieldKey === 'other_category_only')).toBe(false)
    expect(c.fields.find(f => f.fieldKey === 'legacy')).toMatchObject({ schemaKnown: false, ruleOrigin: 'default' })
    expect(c.fields.find(f => f.fieldKey === 'item_name')).toMatchObject({ ruleOrigin: 'master', schemaKnown: true })
  })

  it('keeps stored definitions as a fallback when the category schema is missing', async () => {
    mocks.amazon.mockResolvedValue({ ...spec, fields: [], absent: true })
    mocks.schemaRows.mockResolvedValue([{ fieldKey: 'stored', label: 'Stored field', marketplace: 'IT', required: false }])
    const c = await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'UNCACHED' })
    expect(c.fields.find(f => f.fieldKey === 'stored')).toMatchObject({ schemaKnown: true })
    expect(c.schema.note).toContain('No cached')
  })

  it('reads eBay category aspects through the same adapter as the sheet', async () => {
    mocks.ebay.mockResolvedValue({ ...spec, channel: 'EBAY' })
    const c = await getFieldCatalogue({ channel: 'EBAY', marketplace: 'IT', productType: '177104' })
    expect(mocks.ebay).toHaveBeenCalledWith('IT', ['177104'])
    expect(c.fields).toHaveLength(spec.fields.length)
  })
})


it.each(['SHOPIFY', 'ETSY'])('uses the %s core field contract in mapping without importing Amazon classification', async channel => {
  const c = await getFieldCatalogue({ channel, marketplace: 'GLOBAL' })
  expect(c.schema).toMatchObject({ present: true, note: expect.stringContaining(channel === 'SHOPIFY' ? 'Native Shopify attributes' : 'Etsy listing fields') })
  expect(c.fields.find(f => f.fieldKey === 'title')).toMatchObject({ sheetKey: 'name', channelStore: { kind: 'listingColumn', column: 'title' } })
  if (channel === 'SHOPIFY') expect(c.fields.find(f => f.fieldKey === 'productType')).toMatchObject({ sheetKey: 'shopify_product_type' })
  else {
    expect(c.fields.some(f => f.fieldKey === 'productType')).toBe(false)
    expect(c.fields.find(f => f.fieldKey === 'taxonomy_id')?.validation).toMatchObject({ minimum: 1, multipleOf: 1 })
    expect(c.fields.find(f => f.fieldKey === 'image_ids')).toMatchObject({ sheetKey: 'productMedia', managedBy: 'productMedia', editable: false,
      status: 'owned', rule: null, sourceOwner: { label: 'Product media' } })
    expect(c.fields.find(f => f.fieldKey === 'tags')).toMatchObject({ sheetKey: 'keywords', rule: { source: 'keywords' } })
    expect(c.fields.find(f => f.fieldKey === 'item_weight')).toMatchObject({ sheetKey: 'weightValue', rule: { source: 'weightValue' } })
  }
})

/**
 * W3-2 — the mapping page shows Amazon's fields as the sheet does: English option names with the market's kept as
 * accepted spellings, English help; before the English copy exists, the market's words led by one line. The rule a
 * field gets is derived from the field as Amazon declares it, so it does not move.
 */
describe('Amazon in English on the mapping page (W3-2)', () => {
  const listLeaf = (node: any): any => !node || typeof node !== 'object' ? null : Array.isArray(node.enum) ? node
    : Object.values(node).reduce((found: any, child) => found ?? listLeaf(child), null)
  const market = structuredClone(definition)
  market.__schemaProvenance = { locale: 'it_IT' }
  const copy = structuredClone(market)
  copy.__schemaProvenance = { locale: 'en_GB' }
  const leaf = listLeaf(copy.properties.supplier_declared_dg_hz_regulation)
  leaf.enumNames = leaf.enum.map((code: string) => ({ other: 'Other', storage: 'Storage', not_applicable: 'Not applicable' } as Record<string, string>)[code] ?? code.toUpperCase())
  leaf.description = 'Select the regulations that apply.'
  const specOf = (def: unknown) => amazonSpecFromDefinition({ marketplace: 'IT', productType: 'OUTERWEAR', schemaDefinition: def })

  it('names options in English, accepts the market word, and derives the same rule as before', async () => {
    mocks.amazon.mockResolvedValue(specOf(market))
    const before = (await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })).fields
    mocks.amazon.mockResolvedValue(withEnglish(specOf(market), specOf(copy)))
    const after = (await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })).fields
    const field = after.find(f => f.fieldKey === 'supplier_declared_dg_hz_regulation')!
    expect(field).toMatchObject({ optionLabels: { other: 'Other', storage: 'Storage', not_applicable: 'Not applicable' }, helpText: 'Select the regulations that apply.' })
    expect(field.optionAliases).toMatchObject({ other: ['Altro'], storage: ['Conservazione'], not_applicable: ['Non applicabile'] })
    for (const typed of ['Altro', 'Other']) expect(validateChannelValue(field, typed).value).toBe('other')
    // An off-list value is named in the words the page shows (W3-7's one sentence): Amazon's English names.
    expect(validateChannelValue(field, 'Plutonio', 'AMAZON').errors[0]).toMatch(/Allowed: Other, Storage, .*Not applicable/)
    // Only names moved: the rules, options and modes are the ones the raw definition gives.
    expect(after.map(f => [f.fieldKey, f.rule, f.options, f.selectionOnly])).toEqual(before.map(f => [f.fieldKey, f.rule, f.options, f.selectionOnly]))
  })

  it('before the English copy: the market words, led by the line', async () => {
    mocks.amazon.mockResolvedValue(withEnglish(specOf(market), null))
    const field = (await getFieldCatalogue({ channel: 'AMAZON', marketplace: 'IT', productType: 'OUTERWEAR' })).fields.find(f => f.fieldKey === 'supplier_declared_dg_hz_regulation')!
    expect(field.optionLabels?.other).toBe('Altro')
    expect(field.helpText).toBe("Amazon's English names are not downloaded yet. This shows Amazon's Italian words.")
  })
})
