import { beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
import { informationRegistry, informationStoredValue } from '@nexus/shared/shopify-information'
import { LAB_CATEGORIES, LAB_ENTRIES, LAB_FILES, LAB_PAGES, LAB_PRODUCTS, LAB_SCHEMA, LAB_STORE_FIELDS, LAB_TAXONOMY_VALUES, labReferences, labTypeField } from '@nexus/shared/shopify-lab-store'
import { shopifyCellToken } from './channel-sheet-projection.js'

/*
 * Lane B slice B1 (docs/shopify-metafields/PLAN-2026-09-28.md §6.1, §7 L4, decision LB-D2): the draft save of the 11 types
 * a real store uses, on the made-up store. A good value lands in the Nexus draft exactly as given; a bad one is refused
 * with the rule's plain sentence; a pasted entry of another kind, or one the store no longer has, is refused HERE — not
 * first at publish. No Shopify write happens on this path.
 */
const s = vi.hoisted(() => ({ workspace: null as any, snapshot: null as any, schema: null as any, writes: [] as any[], nameReads: [] as string[][], refs: [] as any[], namesDown: false }))
vi.mock('../../db.js', () => ({ default: { channelListing: { findMany: async () => [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: {} }] } } }))
vi.mock('../pim/studio-sheet.service.js', () => ({ getStudioSheet: async () => { throw new Error('not used') } }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => s.schema }))
vi.mock('./content-workspace.service.js', () => ({ PUBLISH_KEY: '_nexusContentPublish', object: (v: unknown) => v ?? {},
  contentDestination: async (productId: string) => ({ productId, familyId: 'family', accountId: 'store-a', aliasKey: 'alias-a', marketplace: 'GLOBAL' }) }))
const graphql = vi.hoisted(() => vi.fn(async () => { throw new Error('No Shopify call is expected on the draft save') }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql }) }))
vi.mock('./information-gateway.js', () => ({ readInformation: async () => s.snapshot }))
vi.mock('./linked-products-gateway.js', () => ({ resolveLinkedReferenceNames: async (_gql: unknown, _account: string, ids: string[]) => {
  s.nameReads.push(ids)
  if (s.namesDown) throw new Error('Shopify request failed (HTTP 429).')
  return ids.map(id => s.refs.find((r: any) => r.id === id) ?? { id, label: 'Unavailable reference', image: null, available: false })
}, readTaxonomyAttributeValues: async (_gql: unknown, handle: string, categories: string[]) => categories.length
  ? { attribute: { id: `gid://shopify/TaxonomyAttribute/${handle}`, name: handle }, values: LAB_TAXONOMY_VALUES.filter(v => v.attribute === handle) }
  : { attribute: null, values: [] } }))
vi.mock('./linked-products.service.js', () => ({ LINKED_KEY: '_nexusLinkedProducts', AUTOMATION_KEY: '_nexusLinkedAutomation',
  getLinkedWorkspace: async () => structuredClone(s.workspace),
  linkedState: async () => ({ workspace: structuredClone(s.workspace), draft: structuredClone(s.workspace.draft), listing: { id: 'listing-a', version: 1 } }),
  linkedTransaction: async (fn: any) => fn({ auditLog: { create: async () => ({}) }, channelListing: { findMany: async () => [] } }),
  writeLinkedState: async (_tx: any, _destination: any, _current: any, patch: any) => { s.writes.push(patch); s.workspace.draft = patch._nexusLinkedProducts; s.workspace.revision += '1' },
}))
import { saveShopifySheetCells } from './channel-sheet.service.js'

const product = 'gid://shopify/Product/10', variant = 'gid://shopify/ProductVariant/11'
const scope = { accountId: 'store-a', listingId: 'listing-a', market: 'GLOBAL' as const, locale: 'en' }
const limitedFile = labTypeField('file_reference')
/* A category-bound taxonomy field (made up), so the draft save can check its attribute (B2, G12). */
const baseColors = { ...labTypeField('list.product_taxonomy_value_reference'), name: 'Base colors', key: 'base_colors', constraints: { key: 'category', values: LAB_CATEGORIES } }
beforeEach(() => {
  s.writes = []; s.nameReads = []; s.refs = labReferences(); s.namesDown = false; graphql.mockClear()
  s.schema = { ...LAB_SCHEMA, definitions: [...LAB_STORE_FIELDS, limitedFile, baseColors] }
  s.workspace = { productId: 'family', familyId: 'family', revision: '1', destination: { accountId: 'store-a', listingId: 'listing-a', market: 'GLOBAL' }, suggestedProductIds: [product], operation: null,
    draft: { ...emptyShopifyLinkedDraft(), informationOnly: true, members: [{ id: product, title: 'Listed title', handle: 'listed', image: null }] } }
  s.snapshot = { currency: 'EUR', timezone: 'Europe/Rome', rows: [
    { id: product, productId: product, kind: 'PRODUCT', title: 'Listed title', handle: 'listed', image: null, media: [], fields: [], values: { title: 'Listed title', category: `gid://shopify/TaxonomyCategory/${LAB_CATEGORIES[0]}` } },
    { id: variant, productId: product, kind: 'PRODUCTVARIANT', title: 'Small', handle: 'listed', image: null, media: [], fields: [], values: { sku: 'S', category: null } },
  ] }
})
const fieldFor = (key: string) => {
  const def = key === 'limited_file' ? limitedFile : key === 'base_colors' ? baseColors : LAB_STORE_FIELDS.find(d => d.key === key)!
  return informationRegistry(s.schema).find(f => f.definition?.id === def.id)!
}
function cell(key: string, value: string | null) {
  const field = fieldFor(key), owner = field.owner === 'PRODUCT' ? product : variant
  const row = s.snapshot.rows.find((r: any) => r.id === owner)
  return { colId: field.id, ownerId: owner, fieldId: field.id, value, token: shopifyCellToken(s.workspace, owner, field, row.locale), baseline: informationStoredValue(row, field), intent: 'set' as const }
}
const save = (key: string, value: string | null) => saveShopifySheetCells('family', scope, { cells: [cell(key, value)] }, 'user-1')
const drafted = (key: string) => s.workspace.draft.edits.find((e: any) => e.key === (key === 'limited_file' ? limitedFile.key : key))?.nextValue
const tax = (label: string) => LAB_TAXONOMY_VALUES.find(v => v.label === label)!.id
const entry = (kind: string, n = 0) => LAB_ENTRIES.filter(e => e.type === kind)[n].id

describe('B1 · draft save of the 11 store types (no Shopify write)', () => {
  it.each([
    ['related_items_display', 'only manual'],
    ['variation_label', 'Black'],
    ['search_words', JSON.stringify(['rain jacket', 'touring'])],
    ['icons_with_text', JSON.stringify([entry('lab_icon_text', 0), entry('lab_icon_text', 1)])],
    ['short_summary', entry('lab_summary')],
    ['related_items', JSON.stringify([LAB_PRODUCTS[1].id, LAB_PRODUCTS[2].id])],
    ['average_rating', '{"value":"4.5","scale_min":"1.0","scale_max":"5.0"}'],
    ['rating_count', '0'],
    ['feed_custom_product', 'false'],
    ['size_guide_page', LAB_PAGES[1].id],
    ['swatch_picture', LAB_FILES[4].id],
    ['swatch_colour', '#1a2b3c'],
    ['sort_position', '3'],
  ])('%s: a good value lands in the draft exactly as given', async (key, value) => {
    const result = await save(key, value)
    expect(result.cells[fieldFor(key).id]).toMatchObject({ ok: true })
    expect(drafted(key)).toBe(value)
    expect(graphql).not.toHaveBeenCalled()
  })
  it.each([
    ['related_items_display', 'maybe', 'Choose one of these values: ahead, only manual.'],
    ['search_words', JSON.stringify(Array.from({ length: 11 }, (_, i) => `w${i}`)), 'Use 10 values or fewer. Remove 1.'],
    ['related_items', JSON.stringify([LAB_PAGES[0].id]), 'Value 1: This field takes products only.'],
    ['average_rating', '{"value":"6","scale_min":"1.0","scale_max":"5.0"}', 'Choose a rating from 1 to 5.'],
    ['rating_count', '-1', 'Enter 0 or more.'],
    ['feed_custom_product', 'yes', 'Choose Yes or No.'],
    ['size_guide_page', LAB_PRODUCTS[0].id, 'This field takes pages only.'],
    ['swatch_picture', LAB_PRODUCTS[0].id, 'This field takes files only.'],
    ['swatch_colour', '#12345', 'Enter a colour as # and six characters, for example #1A2B3C.'],
    ['limited_file', LAB_FILES[4].id, 'This field takes images only.'],
  ])('%s refuses %j with the plain sentence, and writes nothing', async (key, value, sentence) => {
    const result = await save(key, value)
    const field = fieldFor(key)
    const owner = field.owner === 'PRODUCT' ? 'Listed title' : 'Listed title / Small'
    expect(result.cells[field.id]).toEqual({ ok: false, reason: `${owner} / ${field.label}: ${sentence}` })
    expect(s.writes).toEqual([])
  })
})

describe('B1 · LB-D2: a pasted entry is checked against the store at the draft save', () => {
  it('refuses an entry of another kind, naming the kind the field takes', async () => {
    const result = await save('icons_with_text', JSON.stringify([entry('lab_icon_text'), entry('lab_faq')]))
    expect(result.cells[fieldFor('icons_with_text').id]).toEqual({ ok: false, reason: 'Listed title / Icons with text: This field takes Icon with text entries only.' })
    expect(s.writes).toEqual([])
  })
  it('refuses an entry or a product the store no longer has', async () => {
    const gone = 'gid://shopify/Metaobject/9999'
    expect((await save('short_summary', gone)).cells[fieldFor('short_summary').id].reason).toBe('Listed title / Short summary: A chosen entry is no longer in the store. Remove it or choose another.')
    expect((await save('related_items', JSON.stringify(['gid://shopify/Product/9999']))).cells[fieldFor('related_items').id].reason).toBe('Listed title / Related items: A chosen product is no longer in the store. Remove it or choose another.')
  })
  it('reads each id once through the names cache, and not at all for a value that already fails its rules', async () => {
    await saveShopifySheetCells('family', scope, { cells: [cell('icons_with_text', JSON.stringify([entry('lab_icon_text')])), cell('related_items', JSON.stringify([LAB_PAGES[0].id]))] }, 'user-1')
    expect(s.nameReads).toEqual([[entry('lab_icon_text')]])
  })
  it('when Shopify cannot be reached, refuses only the reference cell and still saves the others', async () => {
    s.namesDown = true
    const result = await saveShopifySheetCells('family', scope, { cells: [cell('short_summary', entry('lab_summary')), cell('variation_label', 'Navy')] }, 'user-1')
    expect(result.cells[fieldFor('short_summary').id]).toEqual({ ok: false, reason: 'Listed title / Short summary: Shopify could not be reached to check this value. Try again.' })
    expect(result.cells[fieldFor('variation_label').id]).toMatchObject({ ok: true })
    expect(drafted('variation_label')).toBe('Navy')
    expect(drafted('short_summary')).toBeUndefined()
  })
  it('a taxonomy value must be a value of the field’s attribute (B2)', async () => {
    const good = await save('base_colors', JSON.stringify([tax('Black'), tax('Navy')]))
    expect(good.cells[fieldFor('base_colors').id]).toMatchObject({ ok: true })
    const bad = await save('base_colors', JSON.stringify([tax('Solid')]))
    expect(bad.cells[fieldFor('base_colors').id]).toEqual({ ok: false, reason: 'Listed title / Base colors: Choose a Base colors value from Shopify’s list.' })
  })
  it('lets a clear through without a read', async () => {
    s.workspace.draft.edits = []
    const result = await save('short_summary', null)
    expect(result.cells[fieldFor('short_summary').id]).toMatchObject({ ok: true })
    expect(s.nameReads).toEqual([])
  })
})
