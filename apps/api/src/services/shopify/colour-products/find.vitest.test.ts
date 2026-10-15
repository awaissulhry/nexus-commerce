/**
 * Find (PR 3) on an in-process PostgreSQL (PGlite: the generated schema and the production row policies) against a
 * stand-in Shopify store shaped like the live GALE pair: two linked products, 9 sizes each, SKUs on 7 Black variants
 * and none on Yellow. The family and its destination are stand-ins too. No real Shopify call; every id is invented.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { planColourProducts, type ColourPlanFamily } from '@nexus/shared/shopify-colour-products'

const state = vi.hoisted(() => ({ db: null as any, destination: null as any, store: [] as any[], queries: [] as string[], read: [] as string[][] }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../content-workspace.service.js', () => ({ contentDestination: async () => state.destination }))
vi.mock('../admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: async (query: string, variables: any) => shopify(query, variables) }) }))

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
const COLOURS = [{ key: 'color:black', label: 'Nero', sku: 'BLACK' }, { key: 'color:yellow', label: 'Giallo', sku: 'YELLOW' }]
const family: ColourPlanFamily = {
  familyId: 'fam', axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
  variants: COLOURS.flatMap(c => SIZES.map(s => ({ productId: `p-${c.sku}-${s}`, sku: `GALE-JACKET-${c.sku}-MEN-${s}`, values: { color: c.key, size: `size:${s.toLowerCase()}` } }))),
  valueOrder: { color: COLOURS.map(c => c.key), size: SIZES.map(s => `size:${s.toLowerCase()}`) },
  valueLabels: { ...Object.fromEntries(COLOURS.map(c => [c.key, c.label])), ...Object.fromEntries(SIZES.map(s => [`size:${s.toLowerCase()}`, s])) }, unmapped: [],
}
const split = { value: 'color' as string | null }
vi.mock('./family.js', () => ({ loadColourPlan: async (_rootId: string, options: any = {}) => ({ plan: planColourProducts(family, { splitAxis: split.value, colourNames: options.colourNames }), rootId: 'fam', sku: 'GALE-JACKET' }) }))

const BLACK = 'gid://shopify/Product/101', YELLOW = 'gid://shopify/Product/102', NOISE = 'gid://shopify/Product/103'
const liveProduct = (id: string, colour: string, sku: (s: string) => string | null) => ({ id, title: 'GALE jacket', handle: id.split('/').pop(), status: 'ACTIVE', colour: { value: colour },
  group: { value: JSON.stringify([BLACK, YELLOW]) },
  variants: { nodes: SIZES.filter(s => s !== 'XXS').map(s => ({ id: `${id}/v/${s}`, sku: sku(s), inventoryItem: { id: `${id}/i/${s}` }, selectedOptions: [{ value: s }] })), pageInfo: { hasNextPage: false } } })
const liveStore = () => [
  liveProduct(BLACK, 'Black', s => ['S', '3XL'].includes(s) ? '' : `GALE-JACKET-BLACK-MEN-${s}`),
  liveProduct(YELLOW, 'Yellow', () => ''),
  // Shopify's search is loose: this product answers a SKU query without holding the exact SKU.
  { ...liveProduct(NOISE, 'Black', s => `GALE-JACKET-BLACK-MEN-${s}-OLD`), group: { value: '[]' } },
]
function shopify(query: string, variables: any) {
  state.queries.push(query.trim().split(/[\s({]/)[1] ?? query)
  if (query.trim().startsWith('mutation')) throw new Error('Find must never write to Shopify')
  if (query.includes('NexusColourSkus')) {
    const asked = [...(variables.query as string).matchAll(/sku:"([^"]+)"/g)].map(m => m[1])
    const nodes = state.store.flatMap(p => p.variants.nodes.filter((v: any) => v.sku && asked.some(a => v.sku.startsWith(a))).map((v: any) => ({ sku: v.sku, product: { id: p.id } })))
    return { productVariants: { nodes } }
  }
  if (query.includes('NexusColourLocations')) return { locations: { nodes: [{ id: 'gid://shopify/Location/7', name: 'Warehouse', isActive: true }, { id: 'gid://shopify/Location/8', name: 'Closed', isActive: false }] } }
  if (query.includes('NexusColourStoreProducts')) {
    state.read.push(['search', variables.query ?? '', variables.vns, variables.vkey])
    const nodes = state.store.filter(p => !variables.query || p.title.toLowerCase().includes(String(variables.query).toLowerCase()))
      .map(p => ({ id: p.id, title: p.title, handle: p.handle, status: p.status, featuredMedia: null, colour: p.colour, variantsCount: { count: p.variants.nodes.length }, variants: { nodes: p.variants.nodes.slice(0, 5) } }))
    return { products: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } }
  }
  if (query.includes('NexusColourCandidates')) { state.read.push([...variables.ids]); return { nodes: variables.ids.map((id: string) => state.store.find(p => p.id === id) ?? null) } }
  throw new Error(`unexpected query ${query.slice(0, 60)}`)
}

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { findColourProducts, readColourProducts, searchColourStoreProducts } from './find.service.js'
import { readColourProductSettings, saveColourProductSettings, DEFAULT_COLOUR_PRODUCT_SETTINGS } from './settings.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const rows = () => scoped(() => prisma.shopifyColourProduct.findMany({ where: { familyId: ids.fam }, orderBy: { valueKey: 'asc' } }))
const byKey = async () => Object.fromEntries((await rows()).map(r => [r.valueKey, r]))

afterAll(async () => { await state.db?.close() })
beforeAll(async () => {
  await scoped(async () => {
    ids.account = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'dev', isActive: true, isPrimary: true, externalAccountId: 'shop-1', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    ids.fam = (await prisma.product.create({ data: { sku: 'GALE-JACKET', name: 'GALE', basePrice: 10, isParent: true } as never })).id
    ids.other = (await prisma.product.create({ data: { sku: 'OTHER-JACKET', name: 'Other', basePrice: 10, isParent: true } as never })).id
  })
}, 60_000)
beforeEach(async () => {
  state.store = liveStore(); state.queries = []; state.read = []; split.value = 'color'
  state.destination = { familyId: ids.fam, accountId: ids.account, marketplace: 'GLOBAL', aliasKey: '' }
  await scoped(() => prisma.shopifyColourProduct.deleteMany({}))
})

describe('Find — the live Shopify product of each colour', () => {
  it('GALE: Black by its SKUs, Yellow through the group; proposals stored, nothing written to Shopify, the loose search result ignored', async () => {
    const view = await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    const r = await byKey()
    expect(r['color:black']).toMatchObject({ state: 'PROPOSED', shopifyProductId: null, splitAxis: 'color', remoteStatus: 'ACTIVE', colourName: null })
    expect(r['color:black'].proposal).toMatchObject({ method: 'sku', shopifyProductId: BLACK, shopifyColourName: 'Black', issues: [],
      skusToWrite: [{ shopifyVariantId: `${BLACK}/v/S`, sku: 'GALE-JACKET-BLACK-MEN-S' }, { shopifyVariantId: `${BLACK}/v/3XL`, sku: 'GALE-JACKET-BLACK-MEN-3XL' }],
      missing: [{ productId: 'p-BLACK-XXS', sku: 'GALE-JACKET-BLACK-MEN-XXS', options: ['XXS'] }] })
    expect(r['color:yellow'].proposal).toMatchObject({ method: 'group', shopifyProductId: YELLOW, shopifyColourName: 'Yellow' })
    expect((r['color:yellow'].proposal as any).skusToWrite).toHaveLength(9)
    expect(state.queries.some(q => q === 'mutation')).toBe(false)
    // The product holding the exact SKUs, then the rest of its group; never the loose search result.
    expect(state.read).toEqual([[BLACK], [YELLOW]])
    expect(view.colourProducts.map(c => [c.valueKey, c.state])).toEqual([['color:black', 'PROPOSED'], ['color:yellow', 'PROPOSED']])
    expect(view.plan).toMatchObject({ mode: 'colour-products', splitAxis: 'color', grouped: true })
    // The store's active locations, for the review's stock location.
    expect(view.locations).toEqual([{ id: 'gid://shopify/Location/7', name: 'Warehouse' }])
  })

  it('a confirmed link stays confirmed; Find refreshes its proposal and reads the linked product even with no SKU in the store', async () => {
    await scoped(() => prisma.shopifyColourProduct.create({ data: { familyId: ids.fam, channelConnectionId: ids.account, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: BLACK, colourName: 'Black' } }))
    state.store = state.store.map(p => ({ ...p, variants: { ...p.variants, nodes: p.variants.nodes.map((v: any) => ({ ...v, sku: '' })) } }))
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    const r = await byKey()
    expect(r['color:black']).toMatchObject({ state: 'LINKED', shopifyProductId: BLACK, colourName: 'Black' })
    expect(r['color:black'].proposal).toMatchObject({ method: 'linked', shopifyProductId: BLACK })
    expect(r['color:yellow']).toMatchObject({ state: 'PROPOSED', proposal: expect.objectContaining({ method: 'group', shopifyProductId: YELLOW }) })
  })

  it('a product already linked to another family is not proposed again, and says whose it is', async () => {
    await scoped(() => prisma.shopifyColourProduct.create({ data: { familyId: ids.other, channelConnectionId: ids.account, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: BLACK } }))
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    const black = (await byKey())['color:black']
    expect(black.state).toBe('NOT_FOUND')
    expect((black.proposal as any).issues).toEqual([expect.objectContaining({ code: 'linked-elsewhere', message: '"GALE jacket" is already the Shopify product of OTHER-JACKET.' })])
  })

  it('no SKU anywhere: the operator names one product; its group and the operator\'s colour names do the rest', async () => {
    state.store = state.store.map(p => ({ ...p, variants: { ...p.variants, nodes: p.variants.nodes.map((v: any) => ({ ...v, sku: '' })) } }))
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    expect((await rows()).map(r => r.state)).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: 'color:black' }, data: { colourName: 'Black' } }))
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { valueKey: 'color:yellow' }, data: { colourName: 'Yellow' } }))
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { sourceProductId: YELLOW }))
    const r = await byKey()
    expect([r['color:black'].proposal, r['color:yellow'].proposal]).toEqual([expect.objectContaining({ method: 'name', shopifyProductId: BLACK }), expect.objectContaining({ method: 'name', shopifyProductId: YELLOW })])
    await expect(scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { sourceProductId: 'not-a-gid' }))).rejects.toThrow('Choose a Shopify product.')
  })

  it('the operator\'s chosen product outranks the guesses, is kept for the next Find, and a null choice withdraws it', async () => {
    // No SKU anywhere and the colour names the store shows match no Nexus name: Find has nothing to guess from.
    state.store = state.store.map(p => ({ ...p, colour: { value: 'Unknown' }, variants: { ...p.variants, nodes: p.variants.nodes.map((v: any) => ({ ...v, sku: '' })) } }))
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    expect((await rows()).map(r => r.state)).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    const view = await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { choices: [{ valueKey: 'color:black', shopifyProductId: BLACK }] }))
    let r = await byKey()
    expect(r['color:black']).toMatchObject({ state: 'PROPOSED', proposal: expect.objectContaining({ method: 'operator', chosenProductId: BLACK, shopifyProductId: BLACK, issues: [] }) })
    // Its sizes still match by option values, with every SKU Nexus will write listed for the review.
    expect((r['color:black'].proposal as any).skusToWrite).toHaveLength(9)
    expect((r['color:black'].proposal as any).missing.map((m: any) => m.sku)).toEqual(['GALE-JACKET-BLACK-MEN-XXS'])
    // The chosen product's group names the rest: Yellow is the one colour and the one product left.
    expect(r['color:yellow'].proposal).toMatchObject({ method: 'group', shopifyProductId: YELLOW, chosenProductId: null })
    expect(view.plan.products[0].sizes).toHaveLength(10)
    expect(view.sync).toEqual({ linked: false, adoptOnly: false })
    // Kept: a Find without choices proposes it again; null withdraws it.
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    expect((await byKey())['color:black'].proposal).toMatchObject({ method: 'operator', chosenProductId: BLACK })
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { choices: [{ valueKey: 'color:black', shopifyProductId: null }] }))
    r = await byKey()
    expect([r['color:black'].state, (r['color:black'].proposal as any).chosenProductId]).toEqual(['NOT_FOUND', null])
    // A colour this family does not have, or a choice that is not a Shopify product, is refused.
    await expect(scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { choices: [{ valueKey: 'color:green', shopifyProductId: BLACK }] }))).rejects.toThrow('"color:green" is not a colour of this family.')
    await expect(scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, { choices: [{ valueKey: 'color:black', shopifyProductId: '101' }] }))).rejects.toThrow('Choose a Shopify product.')
  })

  it('the store search for the picker: status, the colour the product shows, its sizes, a SKU, and whose colour it already is', async () => {
    await scoped(() => prisma.shopifyColourProduct.create({ data: { familyId: ids.other, channelConnectionId: ids.account, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: BLACK } }))
    const page = await scoped(() => searchColourStoreProducts('p-BLACK-M', { accountId: 'x' }, { accountId: 'x', query: 'gale' }))
    expect(state.read).toEqual([['search', 'gale', 'custom', 'variation_value']])
    expect(page.cursor).toBeNull()
    expect(page.items.map(i => i.id)).toEqual([BLACK, YELLOW, NOISE])
    expect(page.items[0]).toEqual({ id: BLACK, title: 'GALE jacket', handle: '101', status: 'ACTIVE', image: null, colourName: 'Black', variants: 9, sampleSku: 'GALE-JACKET-BLACK-MEN-XS',
      linkedTo: { familySku: 'OTHER-JACKET', valueKey: 'color:black', state: 'LINKED', thisFamily: false } })
    expect(page.items[1]).toMatchObject({ colourName: 'Yellow', sampleSku: null, linkedTo: null })
    expect(state.queries.some(q => q === 'mutation')).toBe(false)
  })

  it('a family that stays one product asks Shopify nothing', async () => {
    split.value = null
    const view = await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    expect(view.plan.mode).toBe('one-product')
    expect(state.queries).toEqual([])
    expect(await rows()).toEqual([])
    expect((await scoped(() => readColourProducts('p-BLACK-M', { accountId: 'x' }))).plan.mode).toBe('one-product')
  })

  it('the view names the axes whose value order the family sets (a dictionary axis); a free-text axis is not one', async () => {
    const ordered = async () => (await scoped(() => readColourProducts('p-BLACK-M', { accountId: 'x' }))).plan.orderedAxes
    expect(await ordered()).toEqual([])
    await scoped(() => prisma.product.update({ where: { id: ids.fam }, data: { variationAxisCodes: ['', 'size'] } as never }))
    try { expect(await ordered()).toEqual(['size']) }
    finally { await scoped(() => prisma.product.update({ where: { id: ids.fam }, data: { variationAxisCodes: [] } as never })) }
  })
})

describe('the store switch', () => {
  it('reads as the defaults until saved, saves against the revision the operator saw, and refuses a stale one', async () => {
    const first = await scoped(() => readColourProductSettings(ids.account))
    expect(first).toMatchObject(DEFAULT_COLOUR_PRODUCT_SETTINGS)
    const saved = await scoped(() => saveColourProductSettings(ids.account, { settings: { ...DEFAULT_COLOUR_PRODUCT_SETTINGS, enabled: true }, expectedRevision: first.revision }))
    expect(saved.enabled).toBe(true)
    await expect(scoped(() => saveColourProductSettings(ids.account, { settings: DEFAULT_COLOUR_PRODUCT_SETTINGS, expectedRevision: first.revision }))).rejects.toThrow('The store settings changed.')
    await expect(scoped(() => saveColourProductSettings(ids.account, { settings: { ...DEFAULT_COLOUR_PRODUCT_SETTINGS, method: 'app' }, expectedRevision: saved.revision }))).rejects.toThrow()
  })
})

/**
 * S5 (per-channel SKU) — Find searches and matches each size under the SKU Shopify knows it by: its listing's own SKU on
 * THIS store, else its product SKU (every case above). Another account's listing is never read.
 */
describe('S5 — Find uses the listing\'s own SKU on this store', () => {
  it('a size with its own SKU is searched and matched by it (no SKU to write for it); another account\'s own SKU is not used', async () => {
    await scoped(async () => {
      for (const size of ['S', 'M']) await prisma.product.create({ data: { id: `p-BLACK-${size}`, sku: `GALE-JACKET-BLACK-MEN-${size}`, name: size, basePrice: 10, parentId: ids.fam } as never })
      await prisma.channelListing.create({ data: { productId: 'p-BLACK-S', channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL',
        channelConnectionId: ids.account, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: '101', liveChannelSku: 'BLACK-S-OWN' } as never })
      const other = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'other', isActive: true, isPrimary: false, externalAccountId: 'shop-2', authStatus: 'connected', managedBy: 'oauth' } as never })).id
      await prisma.channelListing.create({ data: { productId: 'p-BLACK-M', channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL',
        channelConnectionId: other, aliasKey: '', listingStatus: 'ACTIVE', isPublished: true, externalListingId: '201', liveChannelSku: 'BLACK-M-ELSEWHERE' } as never })
    })
    state.store[0].variants.nodes.find((v: any) => v.id === `${BLACK}/v/S`).sku = 'BLACK-S-OWN'
    await scoped(() => findColourProducts('p-BLACK-M', { accountId: 'x' }, {}))
    const black = (await byKey())['color:black'].proposal as any
    expect(black).toMatchObject({ method: 'sku', shopifyProductId: BLACK, issues: [], skusToWrite: [{ shopifyVariantId: `${BLACK}/v/3XL`, sku: 'GALE-JACKET-BLACK-MEN-3XL' }] })
    expect(black.variants).toEqual(expect.arrayContaining([
      expect.objectContaining({ productId: 'p-BLACK-S', sku: 'BLACK-S-OWN', shopifySku: 'BLACK-S-OWN', by: 'sku' }),
      expect.objectContaining({ productId: 'p-BLACK-M', sku: 'GALE-JACKET-BLACK-MEN-M', by: 'sku' }),
    ]))
    expect(JSON.stringify(black)).not.toContain('ELSEWHERE')
  })
})
