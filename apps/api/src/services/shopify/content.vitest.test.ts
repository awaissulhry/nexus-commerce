import { describe, it, expect, vi } from 'vitest'
import { parse } from 'graphql'
import { emptyShopifyContent, inspectShopifyContent, resolveShopifyContent, shopifyContentSchema, collectionCards, type ContentVariant, type ShopifyContent } from '@nexus/shared/shopify-content'
vi.mock('./admin-client.js', () => ({ assertShopifyResult: (payload: any, operation: string) => { if (!payload || payload.userErrors?.length) throw new Error(`${operation}: ${payload?.userErrors?.[0]?.message ?? 'missing result'}`); return payload } }))
import { ensureContentDefinitions, mapRemoteVariants, newVariantFacts, publishContent, publishMetaobjects, readRemoteProduct, SHOPIFY_IDENTITY_NOT_ID, SHOPIFY_OPTION_VALUE_MAX, shopifyOptionValueProblems, shopifySkuRenames, type PublishContentInput } from './content-publisher.js'
// P3b A4 — the workspace's pure pieces (option order, variant options) are imported below; no database is used here.
vi.mock('../../db.js', () => ({ default: {} }))
vi.mock('../../lib/queue.js', () => ({ outboundSyncQueue: null, redis: null, searchIndexQueue: null, readCacheQueue: null, readinessQueue: null, addJobSafely: vi.fn() }))
import { applyShopifyVariationProjection, withShopifyOwnOptions } from './content-workspace.service.js'
import { syncFailure } from './content-sync.service.js'
import { resolveVariationProjection } from '../pim/variation-rules.service.js'
import { limitsFor, vocabularyFor } from '../pim/family-projection-limits.js'
import { ownAxisValuesFor } from '../pim/variation-own-axes.js'

export const variants: ContentVariant[] = [
  { id: 'rs', sku: 'RED-S', options: { Colour: 'Red', Size: 'S' }, price: '99.00', stock: 4 },
  { id: 'rl', sku: 'RED-L', options: { Colour: 'Red', Size: 'L' }, price: '109.00', stock: 0 },
  { id: 'bs', sku: 'BLUE-S', options: { Colour: 'Blue', Size: 'S' }, price: '89.00', stock: 8 },
  { id: 'bl', sku: 'BLUE-L', options: { Colour: 'Blue', Size: 'L' }, price: '119.00', stock: 2 },
]
function content() {
  const c = emptyShopifyContent(['Colour', 'Size'])
  c.assets = ['shared', 'red', 'blue', 'detail'].map(id => ({ id, url: `https://example.com/${id}.jpg`, alt: `${id} descriptive image`, translations: { en: `${id} image` } }))
  c.groups = c.assets.map(a => ({ id: a.id, name: a.id, assetIds: [a.id], featuredId: a.id }))
  c.fields = [{ namespace: 'custom', key: 'caption', label: 'Caption', type: 'single_line_text_field' }]
  c.assignments[0].gallery = { mode: 'replace', groupIds: ['shared'], featuredId: null }
  c.assignments[0].values['custom.caption'] = { value: 'Famiglia', translations: { en: 'Family' } }
  c.assignments.push({ id: 'red', name: 'Red', target: { kind: 'options', values: { Colour: 'Red' } }, priority: 0, gallery: { mode: 'replace', groupIds: ['red', 'shared'], featuredId: null }, values: { 'custom.caption': { value: 'Rosso', translations: { en: 'Red' } } } })
  return c
}
describe('scoped family content', () => {
  it('resolves family, axis, combination and exact variant with provenance', () => {
    const c = content()
    c.assignments.push({ id: 'combo', name: 'Red large', target: { kind: 'options', values: { Colour: 'Red', Size: 'L' } }, priority: -100, gallery: { mode: 'append', groupIds: ['detail', 'shared'], featuredId: 'detail' }, values: {} })
    c.assignments.push({ id: 'exact', name: 'Exact red large', target: { kind: 'variant', variantId: 'rl' }, priority: -100, values: { 'custom.caption': { value: null, translations: {} } } })
    expect(inspectShopifyContent(c, variants)).toEqual([])
    expect(resolveShopifyContent(c, variants[2]).assetIds).toEqual(['shared'])
    const resolved = resolveShopifyContent(c, variants[1], 'en')
    expect(resolved.assetIds).toEqual(['detail', 'red', 'shared'])
    expect(resolved.sources.gallery).toEqual(['red', 'combo'])
    expect(resolved.fields['custom.caption']).toBeNull()
    expect(resolved.sources['custom.caption']).toEqual(['exact'])
  })
  it('blocks conflicting intersecting axes until priority is explicit', () => {
    const c = content()
    c.assignments.push({ id: 'size', name: 'Small', target: { kind: 'options', values: { Size: 'S' } }, priority: 0, values: { 'custom.caption': { value: 'Small', translations: {} } } })
    expect(inspectShopifyContent(c, variants).join(' ')).toContain('RED-S: Conflicting custom.caption')
    c.assignments.at(-1)!.priority = 1
    expect(resolveShopifyContent(c, variants[0]).fields['custom.caption']).toBe('Small')
  })
  it('ignores object key insertion order when equivalent translations compete', () => {
    const c = content(); c.locales.push('fr')
    c.assignments[1].values['custom.caption'].translations = { en: 'Red', fr: 'Rouge' }
    c.assignments.push({ ...structuredClone(c.assignments[1]), id: 'same', values: { 'custom.caption': { translations: { fr: 'Rouge', en: 'Red' }, value: 'Rosso' } } })
    expect(inspectShopifyContent(c, variants)).toEqual([])
  })
  it('keeps selection independent of descriptive alt text and language', () => {
    const c = content(), before = resolveShopifyContent(c, variants[0], 'en-GB')
    c.assets[1].alt = 'Helmet photographed from the left #Colour_Anything @expand'
    const after = resolveShopifyContent(c, variants[0], 'it')
    expect(before.assetIds).toEqual(after.assetIds)
    expect(before.fields['custom.caption']).toBe('Red')
    expect(after.fields['custom.caption']).toBe('Rosso')
  })
  it('supports an explicitly empty gallery and rejects an out-of-gallery featured image', () => {
    const c = content(); c.assignments[1].gallery = { mode: 'replace', groupIds: [], featuredId: null }
    expect(resolveShopifyContent(c, variants[0]).assetIds).toEqual([])
    c.assignments[1].gallery.featuredId = 'detail'
    expect(inspectShopifyContent(c, variants).join(' ')).toContain('featured image must belong')
  })
  it('rejects duplicate SKUs, absent axes, unused scopes and unknown image references', () => {
    const c = content(); c.fields.push({ namespace: 'custom', key: 'photo', label: 'Photo', type: 'file_reference' }); c.assignments[0].values['custom.photo'] = { value: '@image:missing', translations: {} }
    const invalid = variants.map(v => ({ ...v, options: {} }))
    invalid[1].sku = invalid[0].sku
    expect(inspectShopifyContent(c, invalid).join(' ')).toMatch(/Duplicate variant SKUs/)
    expect(inspectShopifyContent(c, invalid).join(' ')).toMatch(/missing Colour/)
    expect(inspectShopifyContent(c, invalid).join(' ')).toMatch(/selected image is missing/)
  })
  it('blocks cycles and invalid structural translations before remote writes', async () => {
    const c = content()
    c.metaobjectDefinitions = [{ type: 'cycle', name: 'Cycle', fields: [{ key: 'ref', label: 'Reference', type: 'metaobject_reference', metaobjectType: 'cycle' }] }]
    const gql = vi.fn()
    await expect(publishContent(gql, input(c), async () => {})).rejects.toThrow('cycle')
    expect(gql).not.toHaveBeenCalled()
  })
  it('preserves invalid drafts for correction while refusing non-HTTPS image schema', () => {
    const c = content(); c.assets[0].url = 'http://example.com/image.jpg'
    expect(shopifyContentSchema.safeParse(c).success).toBe(false)
  })
})

const input = (c: ShopifyContent): PublishContentInput => ({ identity: 'workspace:family', title: 'Family', description: 'Description', vendor: 'Xavia', productType: 'Helmet', tags: ['nexus'], content: c, variants, remote: null, locationId: 'gid://shopify/Location/1' })
function fakeShopify(c: ShopifyContent) {
  const calls: { name: string; variables: any }[] = [], owners = new Map<string, any[]>(), translated = new Map<string, any[]>()
  let product: any = null
  const collection = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false } })
  const gql: any = async (query: string, variables: any = {}) => {
    parse(query)
    const name = query.match(/(?:mutation|query)\s+(\w+)/)![1]; calls.push({ name, variables })
    if (name === 'NexusInventoryLocation') return { location: { id: variables.id, isActive: true } }
    if (name === 'NexusDefinitions') return { metafieldDefinitions: collection([...c.fields, { namespace: 'nexus', key: 'resolved', type: 'json' }, { namespace: 'nexus', key: 'family_id', type: 'id' }].map((f, i) => ({ ...f, id: `def-${i}`, type: { name: f.type }, access: { storefront: 'PUBLIC_READ' }, validations: [], capabilities: { uniqueValues: { enabled: true } } }))) }
    if (name === 'NexusImage') return { files: { nodes: [{ id: `gid://shopify/MediaImage/${100 + calls.filter(c => c.name === name).length}`, fileStatus: 'READY' }] } }
    if (name === 'NexusProductSet') {
      product = { id: 'gid://shopify/Product/1', handle: 'family', status: 'DRAFT', updatedAt: '2026-09-08T10:00:00Z', media: collection(variables.input.files.map((f: any) => ({ id: f.id, status: 'READY' }))), metafields: collection([]), variants: collection(variables.input.variants.map((v: any, i: number) => ({ id: v.id ?? `gid://shopify/ProductVariant/${i + 1}`, sku: v.sku, price: v.price, selectedOptions: v.optionValues.map((o: any) => ({ name: o.optionName, value: o.name })), inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}` }, media: collection(v.file ? [v.file] : []), stock: v.inventoryQuantities?.[0]?.quantity ?? product?.variants.nodes[i]?.stock }))) }
      return { productSet: { product, userErrors: [] } }
    }
    if (name === 'NexusProduct') return { product }
    if (name === 'NexusOwnerFields' || name === 'NexusContentReadback') return { node: { metafields: collection(owners.get(variables.id) ?? []) } }
    if (name === 'NexusFields' || name === 'NexusManifest') {
      const saved = variables.metafields.map((f: any) => { const fields = owners.get(f.ownerId) ?? []; const next = { ...f, id: `${f.ownerId}/${f.namespace}/${f.key}` }; owners.set(f.ownerId, [...fields.filter((old: any) => old.namespace !== f.namespace || old.key !== f.key), next]); return next })
      return { metafieldsSet: { metafields: saved, userErrors: [] } }
    }
    if (name === 'NexusTranslationSource') return { translatableResource: { translatableContent: [{ key: 'value', digest: 'digest', locale: 'it' }] } }
    if (name === 'NexusTranslations') { translated.set(variables.id, variables.translations); return { translationsRegister: { userErrors: [] } } }
    if (name === 'NexusTranslationReadback') return { translatableResource: { translations: (translated.get(variables.id) ?? []).filter(t => t.locale === variables.locale) } }
    if (name === 'NexusInventoryBefore') return { productVariant: { inventoryItem: { inventoryLevel: { quantities: [{ name: 'available', quantity: product.variants.nodes.find((v: any) => v.id === variables.id).stock }] } } } }
    if (name === 'NexusFamilyInventory') { for (const q of variables.input.quantities) { const v = product.variants.nodes.find((v: any) => v.inventoryItem.id === q.inventoryItemId); if (v.stock !== q.changeFromQuantity) return { inventorySetQuantities: { userErrors: [{ message: 'Stock changed concurrently' }] } }; v.stock = q.quantity } return { inventorySetQuantities: { userErrors: [] } } }
    if (name === 'NexusTranslationsRemove') return { translationsRemove: { userErrors: [] } }
    if (name === 'NexusVariantReadback') { const v = product.variants.nodes.find((v: any) => v.id === variables.id); return { productVariant: { metafield: owners.get(v.id)?.find(f => f.namespace === 'nexus' && f.key === 'resolved'), inventoryItem: { inventoryLevel: { quantities: [{ name: 'available', quantity: v.stock }] } } } } }
    throw new Error(`Unmocked Shopify operation ${name}`)
  }
  return { gql, calls, owners, get product() { return product } }
}
/* A NEW product failed on a real Shopify development store (Lane B, 2026-09-28): "Metafield definition of type 'id' is required
   when using custom ids." Nexus made `nexus.family_id` as plain text; the stand-in above had modelled that broken store. */
describe('the family identity is a Shopify custom ID of type `id`', () => {
  const collection = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false } })
  const store = (familyIdType: string | null) => {
    const calls: { name: string; variables: any }[] = []
    const gql: any = async (query: string, variables: any = {}) => {
      parse(query)
      const name = query.match(/(?:mutation|query)\s+(\w+)/)![1]; calls.push({ name, variables })
      if (name === 'NexusDefinitions') return { metafieldDefinitions: collection(variables.ownerType === 'PRODUCT' && familyIdType
        ? [{ id: 'def-family', namespace: 'nexus', key: 'family_id', type: { name: familyIdType }, access: { storefront: 'PUBLIC_READ' }, validations: [], capabilities: { uniqueValues: { enabled: true } } }] : []) }
      if (name === 'NexusCreateDefinition') return { metafieldDefinitionCreate: { createdDefinition: { id: `def-${calls.length}` }, userErrors: [] } }
      if (name === 'NexusProductIdentity') return { product: null }
      throw new Error(`Unmocked Shopify operation ${name}`)
    }
    return { gql, calls }
  }
  const bare = () => ({ ...emptyShopifyContent(['Colour']), fields: [], metaobjectDefinitions: [] }) as ShopifyContent
  const identityCreates = (calls: { name: string; variables: any }[]) => calls.filter(c => c.name === 'NexusCreateDefinition' && c.variables.definition.key === 'family_id')

  it('a store without it gets `nexus.family_id` as type `id` (unique values come with the type)', async () => {
    const shop = store(null)
    await ensureContentDefinitions(shop.gql, bare())
    const [create] = identityCreates(shop.calls)
    expect(create.variables.definition).toMatchObject({ namespace: 'nexus', key: 'family_id', type: 'id', ownerType: 'PRODUCT', capabilities: { uniqueValues: { enabled: true } } })
    expect(identityCreates(shop.calls)).toHaveLength(1)
  })

  it('a store that kept the plain-text field from an earlier try is told what to do, and nothing is created or deleted', async () => {
    const shop = store('single_line_text_field')
    await expect(ensureContentDefinitions(shop.gql, bare())).rejects.toThrow(SHOPIFY_IDENTITY_NOT_ID)
    expect(shop.calls.filter(c => /Create|Delete/.test(c.name))).toEqual([])
    /* an `id` field already there is simply reused */
    const ok = store('id')
    await ensureContentDefinitions(ok.gql, bare())
    expect(identityCreates(ok.calls)).toEqual([])
  })

  it('🔴 the plain-text refusal is raised before any write, so the sync reports it as NOT sent — never "unverified"', async () => {
    const shop = store('single_line_text_field')
    const refusal = await ensureContentDefinitions(shop.gql, bare()).catch((e: unknown) => e) as Error & { notSent?: boolean }
    expect(refusal.notSent).toBe(true)
    const reported = syncFailure(refusal, 'NOT_PUBLISHED')
    expect(reported.checkpoint).toEqual({ status: 'NOT_PUBLISHED', error: SHOPIFY_IDENTITY_NOT_ID })
    expect(reported.error.message).toBe(SHOPIFY_IDENTITY_NOT_ID)
    expect((reported.error as Error & { notSent?: boolean }).notSent).toBe(true)
    /* anything else may have reached Shopify: still unverified, as before */
    const other = syncFailure(new Error('productSet timed out'), 'NOT_PUBLISHED')
    expect(other.checkpoint).toEqual({ status: 'UNVERIFIED', error: 'productSet timed out' })
    expect(other.error.message).toBe('Synchronisation is unverified. Some Shopify steps may have completed; refresh the remote review before retrying. productSet timed out')
    expect((other.error as Error & { notSent?: boolean }).notSent).toBeUndefined()
  })

  it('the lookup by custom ID runs only on an `id` field (Shopify refuses it on a plain-text one)', async () => {
    const text = store('single_line_text_field')
    expect(await readRemoteProduct(text.gql, null, 'workspace:family')).toBeNull()
    expect(text.calls.map(c => c.name)).toEqual(['NexusDefinitions'])
    const id = store('id')
    expect(await readRemoteProduct(id.gql, null, 'workspace:family')).toBeNull()
    expect(id.calls.find(c => c.name === 'NexusProductIdentity')?.variables.identifier).toEqual({ customId: { namespace: 'nexus', key: 'family_id', value: 'workspace:family' } })
  })
})

describe('native Shopify publication', () => {
  it('publishes every combination with independent offers, ordered media and translated metafields', async () => {
    const c = content(), shopify = fakeShopify(c), checkpoints = vi.fn()
    const result = await publishContent(shopify.gql, input(c), checkpoints)
    expect(result.status).toBe('VERIFIED')
    expect(Object.keys(result.variantIds)).toHaveLength(4)
    const write = shopify.calls.find(c => c.name === 'NexusProductSet')!.variables.input
    expect(write.status).toBe('DRAFT'); expect(write.templateSuffix).toBe('nexus')
    expect(write.variants.map((v: any) => [v.sku, v.price, v.inventoryQuantities[0].quantity])).toEqual(variants.map(v => [v.sku, v.price, v.stock]))
    expect(write.productOptions.map((o: any) => o.name)).toEqual(['Colour', 'Size'])
    expect(shopify.calls.filter(c => c.name === 'NexusTranslations').length).toBe(5)
    expect(shopify.calls.filter(c => c.name === 'NexusManifest').at(-1)!.variables.metafields[0].ownerId).toBe(result.productId)
  })
  // Wave 2 D3 (Owner decision 11, A) — a create sends the reviewed theme template; '' (the store's default) goes as null.
  it.each([['custom', 'custom'], ['', null], ['nexus', 'nexus']])('creates with the reviewed theme template %j (sent as %j)', async (templateSuffix, sent) => {
    const c = content(), shopify = fakeShopify(c)
    await publishContent(shopify.gql, { ...input(c), templateSuffix }, vi.fn())
    expect(shopify.calls.find(call => call.name === 'NexusProductSet')!.variables.input.templateSuffix).toBe(sent)
  })
  it('keeps collection grouping independent of SKUs and supports axes and exact variants', () => {
    const c = content()
    expect(collectionCards(c, variants).map(card => card.variantIds)).toEqual([['rs', 'rl'], ['bs', 'bl']])
    c.collectionAxes = ['Size']
    expect(collectionCards(c, variants).map(card => card.variantIds)).toEqual([['rs', 'bs'], ['rl', 'bl']])
    c.collectionAxes = ['Colour', 'Size']
    expect(collectionCards(c, variants)).toHaveLength(4)
    c.collectionMode = 'family'; expect(collectionCards(c, variants)[0].variantIds).toHaveLength(4)
    c.collectionMode = 'variants'; expect(collectionCards(c, variants).map(card => card.id)).toEqual(['variant:rs', 'variant:rl', 'variant:bs', 'variant:bl'])
  })
  it('keeps card definitions on the family and protects existing stock with compare-and-set', async () => {
    const c = content(), shop = fakeShopify(c)
    await publishContent(shop.gql, input(c), async () => {})
    const remote = structuredClone(shop.product), next = variants.map(v => ({ ...v, stock: v.stock + 1 }))
    await publishContent(shop.gql, { ...input(c), variants: next, remote }, async () => {})
    const lastSet = shop.calls.filter(c => c.name === 'NexusProductSet').at(-1)!.variables.input
    expect(lastSet.variants.every((v: any) => !v.inventoryQuantities)).toBe(true)
    expect(shop.calls.find(c => c.name === 'NexusFamilyInventory')!.variables.input.quantities.map((q: any) => q.changeFromQuantity)).toEqual(variants.map(v => v.stock))
    const manifests = shop.calls.filter(c => c.name === 'NexusManifest').slice(-5).map(c => JSON.parse(c.variables.metafields[0].value))
    expect(manifests.slice(0, 4).every(m => !m.cards)).toBe(true)
    expect(manifests[4].cards).toHaveLength(2)
  })
  /* S1 item 5 (d) — product sheet consistency: values a new variant takes from Shared ride the create, in the one-field
     writer's shapes (`applyNativeEdit`); no extra call, and a variant Shopify already holds never receives them here. */
  it('creates a new variant with its Shared barcode, cost, country, HS code and weight; a held variant gets none', async () => {
    expect(newVariantFacts({ barcode: '0001', cost: '9', countryCodeOfOrigin: 'IT', harmonizedSystemCode: '640399', weight: '{"value":1.2,"unit":"KILOGRAMS"}' })).toEqual({
      barcode: '0001', inventoryItem: { tracked: true, cost: '9', countryCodeOfOrigin: 'IT', harmonizedSystemCode: '640399', measurement: { weight: { value: 1.2, unit: 'KILOGRAMS' } } } })
    expect(newVariantFacts()).toEqual({ inventoryItem: { tracked: true } })
    const c = content(), shop = fakeShopify(c)
    const facts = Object.fromEntries(variants.map(v => [v.id, { barcode: `000-${v.id}`, weight: '{"value":1.2,"unit":"KILOGRAMS"}' }]))
    await publishContent(shop.gql, { ...input(c), variantFacts: facts }, async () => {})
    const sets = () => shop.calls.filter(c => c.name === 'NexusProductSet')
    expect(sets()[0].variables.input.variants.map((v: any) => [v.barcode, v.inventoryItem])).toEqual(variants.map(v => [`000-${v.id}`, { tracked: true, measurement: { weight: { value: 1.2, unit: 'KILOGRAMS' } } }]))
    const calls = shop.calls.length
    await publishContent(shop.gql, { ...input(c), remote: structuredClone(shop.product), variantFacts: facts }, async () => {})
    expect(sets().at(-1)!.variables.input.variants.every((v: any) => v.id && !('barcode' in v) && !('inventoryItem' in v))).toBe(true)
    expect(shop.calls.slice(calls).filter(c => /Variant(Update|sBulk)/.test(c.name))).toEqual([])
  })
  it('refuses a product changed while preparing content and rejects translation mismatches', async () => {
    const c = content(), shop = fakeShopify(c)
    await publishContent(shop.gql, input(c), async () => {})
    const remote = structuredClone(shop.product)
    const changed: any = async (q: string, v: any) => { const result = await shop.gql(q, v); if (q.includes('query NexusProduct(')) result.product = { ...result.product, updatedAt: 'changed' }; return result }
    await expect(publishContent(changed, { ...input(c), remote }, async () => {})).rejects.toThrow('changed while preparing')
    const missing: any = async (q: string, v: any) => q.includes('query NexusTranslationReadback') ? { translatableResource: { translations: [] } } : shop.gql(q, v)
    await expect(publishContent(missing, input(c), async () => {})).rejects.toThrow('Translation readback differs')
  })
  it('refuses active writes without explicit review and refuses deleting remote variants', async () => {
    const c = content(), shopify = fakeShopify(c)
    await publishContent(shopify.gql, input(c), async () => {})
    const remote = structuredClone(shopify.product); remote.status = 'ACTIVE'
    const gql = vi.fn()
    await expect(publishContent(gql, { ...input(c), remote }, async () => {})).rejects.toThrow('live or archived')
    expect(gql).not.toHaveBeenCalled()
    expect(() => mapRemoteVariants(variants.slice(1), remote)).toThrow('outside this Nexus family')
  })
  it('rejects duplicate remote SKU identities instead of taking the first', () => {
    const remote: any = { variants: { nodes: [{ id: 'a', sku: 'RED-S' }, { id: 'b', sku: 'RED-S' }] } }
    expect(() => mapRemoteVariants(variants, remote)).toThrow('multiple variants')
  })
  it('does not report success when Shopify rejects a productSet or changes content at readback', async () => {
    const c = content(), shopify = fakeShopify(c)
    const rejected: any = (q: string, v: any) => q.includes('mutation NexusProductSet') ? Promise.resolve({ productSet: { userErrors: [{ message: 'Invalid option combination' }] } }) : shopify.gql(q, v)
    await expect(publishContent(rejected, input(c), async () => {})).rejects.toThrow('Invalid option combination')
    const changed: any = async (q: string, v: any) => { const r = await shopify.gql(q, v); if (q.includes('query NexusContentReadback')) r.node.metafields.nodes = r.node.metafields.nodes.filter((f: any) => f.key !== 'caption'); return r }
    await expect(publishContent(changed, input(c), async () => {})).rejects.toThrow('Custom content readback differs')
  })
  it('does not substitute reference syntax inside plain text', async () => {
    const c = content(); c.assignments[0].values['custom.caption'].value = 'How to use @metaobject:reference in documentation'
    const s = fakeShopify(c)
    await expect(publishContent(s.gql, input(c), async () => {})).resolves.toMatchObject({ status: 'VERIFIED' })
  })
  it('versions imported reusable entries without overwriting their source handles', async () => {
    const c = emptyShopifyContent(); c.locales = ['it']; c.metaobjectDefinitions = [{ type: 'feature', name: 'Feature', fields: [{ key: 'text', label: 'Text', type: 'single_line_text_field' }] }]; c.metaobjects = [{ id: 'entry', type: 'feature', handle: 'existing-live-entry', fields: { text: { value: 'Updated', translations: {} } } }]
    const writes: any[] = []
    const gql: any = async (q: string, v: any) => { if (q.includes('query NexusEntryReadback')) return { metaobject: { fields: writes.at(-1).metaobject.fields } }; if (q.includes('query NexusEntryCapabilities')) return { metaobjectDefinitionByType: { capabilities: { publishable: { enabled: false } } } }; writes.push(v); return { metaobjectUpsert: { metaobject: { id: 'gid://shopify/Metaobject/1' }, userErrors: [] } } }
    await publishMetaobjects(gql, c); await publishMetaobjects(gql, c)
    expect(writes[0].handle.handle).toMatch(/^nexus-/)
    expect(writes[0].handle).toEqual(writes[1].handle)
    c.metaobjects[0].fields.text.value = 'Another version'; await publishMetaobjects(gql, c)
    expect(writes[2].handle.handle).not.toBe(writes[0].handle.handle)
  })
})

/* ── Sheet pop-up P3b, slice A4 — a Shopify-only option: what the sheet cell shows is what productSet sends ─────────────── */

describe('P3b A4 — a Shopify-only option (own:shared:fit), sheet cell ≡ publish payload', () => {
  const FIT = 'own:shared:fit'
  /** Four made-up variants: the family axis Colour, and a Shared per-variant attribute `fit` no family axis uses. */
  const products = [
    { id: 'rs', sku: 'RED-SLIM', categoryAttributes: { variations: { Colour: 'Red' }, fit: 'Slim' } },
    { id: 'rr', sku: 'RED-REG', categoryAttributes: { variations: { Colour: 'Red' }, fit: 'Regular' } },
    { id: 'bs', sku: 'BLUE-SLIM', categoryAttributes: { variations: { Colour: 'Blue' }, fit: 'Slim' } },
    { id: 'br', sku: 'BLUE-REG', categoryAttributes: { variations: { Colour: 'Blue' }, fit: 'Regular' } },
  ]
  /** The sheet cell: the resolver over the same products, their own-option values through the ONE reader. */
  const cellFor = () => resolveVariationProjection({
    coordinate: { channel: 'SHOPIFY', market: 'GLOBAL', accountId: 'acct-1', aliasKey: '', label: 'Shopify · GLOBAL' },
    family: { familyAxes: ['Colour'], axisLabels: {}, productVersion: 1, productTheme: null, childIds: products.map(p => p.id),
      variants: products.map(p => ({ id: p.id, sku: p.sku, included: true, axisValues: { Colour: p.categoryAttributes.variations.Colour, ...ownAxisValuesFor([FIT], null, p.categoryAttributes) } })) },
    listing: { version: 2, variationTheme: null, variationMapping: { axes: [{ axisKey: 'Colour', target: 'Colour', order: 0 }, { axisKey: FIT, target: 'Fit', order: 1 }] }, platformAttributes: null, externalListingId: null, listingStatus: 'DRAFT' },
    rule: null, schema: {}, limits: limitsFor('SHOPIFY'), vocabulary: vocabularyFor('SHOPIFY'),
  })
  /** The publish side: the workspace's own builders (`applyShopifyVariationProjection`, `withShopifyOwnOptions`). */
  const publishInputFor = (cell: ReturnType<typeof cellFor>, fits: Record<string, string> = {}) => {
    const c = applyShopifyVariationProjection(content(), cell)
    const ownKeys = cell.axes.filter(a => a.included && a.own).map(a => a.familyKey)
    const vs: ContentVariant[] = products.map((p, i) => ({ id: p.id, sku: p.sku, price: '10.00', stock: i + 1,
      options: withShopifyOwnOptions({ Colour: p.categoryAttributes.variations.Colour }, ownKeys, { ...p.categoryAttributes, ...(fits[p.id] ? { fit: fits[p.id] } : {}) }) }))
    return { c, vs }
  }

  it('🔴 the option list and every variant\'s value equal the cell\'s summary, and the read-back verifies', async () => {
    const cell = cellFor()
    const fit = cell.axes.find(a => a.familyKey === FIT)!
    expect(fit.unbound).toBeUndefined()
    const { c, vs } = publishInputFor(cell)
    expect(c.axes).toEqual(['Colour', FIT])
    expect(c.optionNames).toEqual({ Colour: 'Colour', [FIT]: 'Fit' })
    const shop = fakeShopify(c)
    const result = await publishContent(shop.gql, { ...input(c), variants: vs }, async () => {})
    expect(result.status).toBe('VERIFIED')
    const write = shop.calls.find(call => call.name === 'NexusProductSet')!.variables.input
    // the Shopify option is named as the pop-up names it — never the stored key
    expect(write.productOptions.map((o: any) => o.name)).toEqual(['Colour', 'Fit'])
    const sent = write.productOptions.find((o: any) => o.name === 'Fit').values.map((v: any) => v.name)
    expect([...sent].sort()).toEqual([...cell.valueSummary![FIT].values].sort())
    expect(cell.valueSummary![FIT]).toMatchObject({ filled: 4, of: 4 })
    for (const variant of write.variants) {
      const product = products.find(p => p.sku === variant.sku)!
      expect(variant.optionValues).toEqual([{ optionName: 'Colour', name: product.categoryAttributes.variations.Colour }, { optionName: 'Fit', name: product.categoryAttributes.fit }])
    }
    expect(JSON.stringify(write)).not.toContain('own:shared')
  })

  it('an option value longer than Shopify takes is refused before any call, naming the option — never its key', async () => {
    const cell = cellFor()
    const long = 'x'.repeat(SHOPIFY_OPTION_VALUE_MAX + 1)
    const { c, vs } = publishInputFor(cell, { rr: long })
    const sentence = `RED-REG: the Fit value is longer than Shopify’s ${SHOPIFY_OPTION_VALUE_MAX} characters. Shorten it on the Shared product.`
    expect(shopifyOptionValueProblems(c, vs)).toEqual([sentence])
    const gql = vi.fn()
    await expect(publishContent(gql, { ...input(c), variants: vs }, async () => {})).rejects.toThrow(sentence)
    expect(gql).not.toHaveBeenCalled()
    // the limit itself is allowed (positive control: the check is not "any long value")
    expect(shopifyOptionValueProblems(c, publishInputFor(cell, { rr: 'x'.repeat(SHOPIFY_OPTION_VALUE_MAX) }).vs)).toEqual([])
  })
})

/* ── S10 (per-channel SKU) — a SKU renamed in Nexus is renamed on Shopify in place, never a new variant + a removal ───── */

describe('S10 — Shopify renames a variant\'s SKU in place', () => {
  const remoteOf = (nodes: Array<{ id: string; sku: string }>): any => ({ variants: { nodes } })
  const one = (sku: string, extra: Partial<ContentVariant> = {}): ContentVariant => ({ id: 'rs', sku, options: {}, price: '1.00', stock: 0, ...extra })

  it('a stored Shopify variant id decides, whatever the SKUs', () => {
    const remote = remoteOf([{ id: 'gid://shopify/ProductVariant/7', sku: 'ANY' }])
    expect(mapRemoteVariants([one('NEW', { shopifyVariantId: '7' })], remote, { rs: 'OLD' })).toEqual({ rs: 'gid://shopify/ProductVariant/7' })
  })
  it('no stored id: the SKU Shopify holds (the live SKU) finds the variant the new SKU is sent to', () => {
    const remote = remoteOf([{ id: 'gid://shopify/ProductVariant/1', sku: 'OLD' }])
    expect(mapRemoteVariants([one('NEW')], remote, { rs: 'OLD' })).toEqual({ rs: 'gid://shopify/ProductVariant/1' })
    // Without the live SKU (today's rule) the variant is not found, and Shopify's own is "outside this family".
    expect(() => mapRemoteVariants([one('NEW')], remote)).toThrow('outside this Nexus family')
  })
  it('parity: a live SKU Shopify does not hold falls back to the SKU sent, as before', () => {
    const remote = remoteOf([{ id: 'gid://shopify/ProductVariant/1', sku: 'SENT' }])
    expect(mapRemoteVariants([one('SENT')], remote, { rs: 'PRODUCT-SKU' })).toEqual({ rs: 'gid://shopify/ProductVariant/1' })
    expect(mapRemoteVariants([one('SENT')], remote)).toEqual({ rs: 'gid://shopify/ProductVariant/1' })
  })
  it('ambiguity is still refused: two Shopify variants hold the live SKU, or one Shopify variant matches two Nexus variants', () => {
    expect(() => mapRemoteVariants([one('NEW')], remoteOf([{ id: 'a', sku: 'OLD' }, { id: 'b', sku: 'OLD' }]), { rs: 'OLD' })).toThrow('multiple variants with SKU OLD')
    const two = [one('NEW-A'), { ...one('OLD'), id: 'rl' }]
    expect(() => mapRemoteVariants(two, remoteOf([{ id: 'a', sku: 'OLD' }]), { rs: 'OLD' })).toThrow('matches two Nexus variants (NEW-A and OLD)')
  })
  it('the review sentence: "Shopify renames OLD to NEW." — only for a variant Shopify holds under another SKU', () => {
    const remote = remoteOf([{ id: 'v1', sku: 'OLD' }, { id: 'v2', sku: 'SAME' }])
    expect(shopifySkuRenames([one('NEW'), { ...one('SAME'), id: 'rl' }], remote, { rs: 'OLD', rl: 'SAME' }))
      .toEqual([{ productId: 'rs', from: 'OLD', to: 'NEW', sentence: 'Shopify renames OLD to NEW.' }])
    expect(shopifySkuRenames([one('NEW')], null, { rs: 'OLD' })).toEqual([])
  })
  it('publishContent sends the new SKU on the variant Shopify holds (same id, no new variant), and reads it back', async () => {
    const c = content(), shop = fakeShopify(c)
    await publishContent(shop.gql, input(c), async () => {})
    const remote = structuredClone(shop.product), before = remote.variants.nodes.map((v: any) => v.id)
    const renamed = variants.map(v => v.id === 'rs' ? { ...v, sku: 'RED-S-SHOP' } : v)
    // Without the live SKU the rename is refused before anything is sent (today's behaviour).
    const sets = () => shop.calls.filter(call => call.name === 'NexusProductSet').length
    const setsBefore = sets()
    await expect(publishContent(shop.gql, { ...input(c), variants: renamed, remote }, async () => {})).rejects.toThrow('outside this Nexus family')
    expect(sets()).toBe(setsBefore)
    const result = await publishContent(shop.gql, { ...input(c), variants: renamed, remote, liveSkus: Object.fromEntries(variants.map(v => [v.id, v.sku])) }, async () => {})
    const sent = shop.calls.filter(call => call.name === 'NexusProductSet').at(-1)!.variables.input.variants
    expect(sent.map((v: any) => [v.id, v.sku])).toEqual(before.map((id: string, index: number) => [id, renamed[index].sku]))
    expect(result.variantIds.rs).toBe(before[0])
    expect(shop.product.variants.nodes.map((v: any) => v.sku)).toEqual(renamed.map(v => v.sku))
  })
})
