/**
 * Confirm (PR 3b) on an in-process PostgreSQL (PGlite: the generated schema and the production row policies) against a
 * stand-in Shopify store shaped like the live GALE pair: two linked products with 9 sizes each (Nexus has 10: XXS is
 * missing), SKUs on 7 Black variants and none on Yellow. The family is real rows; its plan comes from the pure planner.
 * No real Shopify call; every id is invented.
 *
 * Run: DATABASE_URL=postgresql://nexus@127.0.0.1:1/nexus_unit_test npx vitest run src/services/shopify/colour-products/confirm.vitest.test.ts
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { planColourProducts, type ColourPlanFamily } from '@nexus/shared/shopify-colour-products'

const state = vi.hoisted(() => ({ db: null as any, destination: null as any, family: null as any, store: [] as any[], queries: [] as string[], mutations: [] as string[],
  mode: 'live', definition: null as any, locations: [] as any[], refuseIdentity: null as string | null, refreshed: [] as string[], duringConfirm: null as null | (() => Promise<void>) }))
vi.mock('@nexus/database', async importOriginal => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await importOriginal<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../content-workspace.service.js', () => ({ contentDestination: async () => state.destination, object: (v: unknown) => v && typeof v === 'object' && !Array.isArray(v) ? v : {} }))
vi.mock('../admin-client.js', async importOriginal => ({ ...await importOriginal<any>(), shopifyAdmin: async () => ({ graphql: async (query: string, variables: any) => shopify(query, variables) }) }))
vi.mock('../../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => state.mode, acquireShopifyPublishToken: async () => ({ ok: true }) }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: async (ids: string[]) => { state.refreshed.push(...ids) } } }))
vi.mock('./family.js', () => ({ loadColourPlan: async (_rootId: string, options: any = {}) => ({ plan: planColourProducts(state.family, { splitAxis: 'color', colourNames: options.colourNames }), rootId: state.family.familyId, sku: 'GALE-JACKET' }) }))

const SIZES = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', '3XL', '4XL', '5XL']
const COLOURS = [{ key: 'color:black', label: 'Nero', sku: 'BLACK' }, { key: 'color:yellow', label: 'Giallo', sku: 'YELLOW' }]
const skuOf = (colour: string, size: string) => `GALE-JACKET-${colour}-MEN-${size}`
const BLACK = 'gid://shopify/Product/101', YELLOW = 'gid://shopify/Product/102'
const LOCATION = 'gid://shopify/Location/7', OTHER_LOCATION = 'gid://shopify/Location/8'
const variantGid = (product: string, size: string) => `gid://shopify/ProductVariant/${product.split('/').pop()}${SIZES.indexOf(size)}`
const itemGid = (product: string, size: string) => `gid://shopify/InventoryItem/${product.split('/').pop()}${SIZES.indexOf(size)}`
const liveProduct = (id: string, colour: string, sku: (s: string) => string) => ({ id, title: 'GALE jacket', handle: `gale-${colour.toLowerCase()}`, status: 'ACTIVE', onlineStorePublished: true, colour,
  group: [BLACK, YELLOW], identity: null as string | null,
  variants: SIZES.filter(s => s !== 'XXS').map(s => ({ id: variantGid(id, s), sku: sku(s), inventoryItemId: itemGid(id, s), option: s, stocked: true })) })
const liveStore = () => [
  liveProduct(BLACK, 'Black', s => ['S', '3XL'].includes(s) ? '' : skuOf('BLACK', s)),
  liveProduct(YELLOW, 'Yellow', () => ''),
]
const productOf = (id: string) => state.store.find(p => p.id === id)!

/** The stand-in store: the reads Find and Confirm send, and the three writes Confirm may send. */
async function shopify(query: string, variables: any) {
  const name = query.trim().split(/[\s({]/)[1] ?? query
  state.queries.push(name)
  if (name === 'NexusColourPublications') return { publications: { nodes: [{ id: 'gid://shopify/Publication/1', catalog: { apps: { nodes: [{ handle: 'online_store' }] } } }], pageInfo: { hasNextPage: false } } }
  if (query.trim().startsWith('mutation')) state.mutations.push(name)
  if (name === 'NexusColourSkus') {
    const asked = [...(variables.query as string).matchAll(/sku:"([^"]+)"/g)].map(m => m[1])
    return { productVariants: { nodes: state.store.flatMap(p => p.variants.filter((v: any) => v.sku && asked.includes(v.sku)).map((v: any) => ({ sku: v.sku, product: { id: p.id } }))) } }
  }
  if (name === 'NexusColourCandidates') return { nodes: variables.ids.map((id: string) => {
    const p = state.store.find(q => q.id === id)
    return p ? { id: p.id, title: p.title, handle: p.handle, status: p.status, colour: { value: p.colour }, group: { value: JSON.stringify(p.group) },
      variants: { nodes: p.variants.map((v: any) => ({ id: v.id, sku: v.sku, inventoryItem: { id: v.inventoryItemId }, selectedOptions: [{ value: v.option }] })), pageInfo: { hasNextPage: false } } } : null
  }) }
  if (name === 'NexusColourConfirmRead') {
    const hook = state.duringConfirm; state.duringConfirm = null; await hook?.()
    return {
    nodes: variables.ids.map((id: string) => { const p = state.store.find(q => q.id === id); return p ? { id: p.id, title: p.title, status: p.status, identity: p.identity ? { value: p.identity } : null } : null }),
    locations: { nodes: state.locations }, identityDefinition: { nodes: state.definition ? [state.definition] : [] },
    }
  }
  if (name === 'NexusCreateDefinition') {
    expect(variables.definition).toMatchObject({ namespace: 'nexus', key: 'family_id', type: 'id', ownerType: 'PRODUCT', capabilities: { uniqueValues: { enabled: true } } })
    state.definition = { id: 'def-1', type: { name: 'id' }, capabilities: { uniqueValues: { enabled: true } } }
    return { metafieldDefinitionCreate: { createdDefinition: { id: 'def-1' }, userErrors: [] } }
  }
  if (name === 'NexusColourIdentity') {
    const [field] = variables.metafields
    expect(field).toMatchObject({ namespace: 'nexus', key: 'family_id', type: 'id' })
    if (state.refuseIdentity === field.ownerId || state.store.some(p => p.id !== field.ownerId && p.identity === field.value)) return { metafieldsSet: { metafields: [], userErrors: [{ field: ['value'], message: 'Value is already taken' }] } }
    productOf(field.ownerId).identity = field.value
    return { metafieldsSet: { metafields: [{ id: 'mf' }], userErrors: [] } }
  }
  if (name === 'NexusColourWriteSkus') {
    for (const v of variables.variants) productOf(variables.productId).variants.find((x: any) => x.id === v.id).sku = v.inventoryItem.sku
    return { productVariantsBulkUpdate: { userErrors: [] } }
  }
  if (name === 'NexusColourReadBack') {
    const p = state.store.find(q => q.id === variables.id)
    return { product: p ? { id: p.id, status: p.status, onlineStorePublished: p.onlineStorePublished, identity: p.identity ? { value: p.identity } : null,
      variants: { nodes: p.variants.map((v: any) => ({ id: v.id, sku: v.sku, inventoryItem: { id: v.inventoryItemId, inventoryLevel: v.stocked && variables.location ? { id: 'level' } : null } })) } } : null }
  }
  throw new Error(`unexpected Shopify call ${name}`)
}

import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { findColourProducts } from './find.service.js'
import { confirmColourProducts, colourProductIdentity } from './confirm.service.js'
import { DEFAULT_COLOUR_PRODUCT_SETTINGS } from './settings.js'
import { startFullColourSync } from './full-sync.service.js'
import { ADOPT_ONLY_LINK_REFUSED, linkColourProducts } from './link.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const find = () => scoped(() => findColourProducts(ids.fam, { accountId: 'x' }, {}))
const confirm = (colours: any[]) => scoped(() => confirmColourProducts(ids.fam, { accountId: 'x' }, { colours }))
const startFullSync = () => scoped(() => startFullColourSync(ids.fam, { accountId: 'x' }, { confirm: true }))
const syncRow = async () => (await scoped(() => prisma.shopifyColourSync.findMany({ where: { familyId: ids.fam } })))[0]
const BOTH = [{ valueKey: 'color:black', shopifyProductId: BLACK }, { valueKey: 'color:yellow', shopifyProductId: YELLOW }]
const rowOf = async (valueKey: string) => (await scoped(() => prisma.shopifyColourProduct.findMany({ where: { familyId: ids.fam, valueKey } })))[0]
const listingOf = async (sku: string) => (await scoped(() => prisma.channelListing.findMany({ where: { productId: ids[sku], channel: 'SHOPIFY' } })))[0] ?? null
const switchOn = (enabled: boolean) => scoped(() => prisma.channelConnection.update({ where: { id: ids.account }, data: { connectionMetadata: { shopifyColourProducts: { ...DEFAULT_COLOUR_PRODUCT_SETTINGS, enabled } } } }))
/** A refusal changes nothing: no Shopify write, both rows still proposals, no listing. */
async function nothingChanged() {
  expect(state.mutations).toEqual([])
  expect([(await rowOf('color:black')).state, (await rowOf('color:yellow')).state]).toEqual(['PROPOSED', 'PROPOSED'])
  expect(await scoped(() => prisma.channelListing.count({ where: { channel: 'SHOPIFY' } }))).toBe(0)
}

afterAll(async () => { await state.db?.close() })
beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'], isActive: true } })
    ids.account = (await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'dev', isActive: true, isPrimary: true, externalAccountId: 'shop-1', authStatus: 'connected', managedBy: 'oauth' } as never })).id
    ids.fam = (await prisma.product.create({ data: { sku: 'GALE-JACKET', name: 'GALE', basePrice: 10, isParent: true } as never })).id
    for (const c of COLOURS) for (const s of SIZES) ids[skuOf(c.sku, s)] = (await prisma.product.create({ data: { sku: skuOf(c.sku, s), name: `GALE ${c.label} ${s}`, basePrice: 10, parentId: ids.fam } as never })).id
  })
  state.family = {
    familyId: ids.fam, axes: [{ code: 'color', label: 'Colore' }, { code: 'size', label: 'Taglia' }],
    variants: COLOURS.flatMap(c => SIZES.map(s => ({ productId: ids[skuOf(c.sku, s)], sku: skuOf(c.sku, s), values: { color: c.key, size: `size:${s.toLowerCase()}` } }))),
    valueOrder: { color: COLOURS.map(c => c.key), size: SIZES.map(s => `size:${s.toLowerCase()}`) },
    valueLabels: { ...Object.fromEntries(COLOURS.map(c => [c.key, c.label])), ...Object.fromEntries(SIZES.map(s => [`size:${s.toLowerCase()}`, s])) }, unmapped: [],
  } satisfies ColourPlanFamily
}, 60_000)
beforeEach(async () => {
  Object.assign(state, { store: liveStore(), queries: [], mutations: [], mode: 'live', definition: null, locations: [{ id: LOCATION, name: 'Warehouse', isActive: true }], refuseIdentity: null, refreshed: [] })
  state.destination = { familyId: ids.fam, accountId: ids.account, marketplace: 'GLOBAL', aliasKey: '' }
  await scoped(async () => { await prisma.shopifyColourProduct.deleteMany({}); await prisma.shopifyColourSync.deleteMany({}); await prisma.channelListing.deleteMany({ where: { channel: 'SHOPIFY' } }) })
  await switchOn(true)
})

describe('Confirm — adopt the live Shopify product of each colour', () => {
  it('GALE: identity and the missing SKUs written and read back; each matched size listed with its own colour product\'s ids', async () => {
    await find()
    state.queries = []
    const view = await confirm(BOTH)
    const black = await rowOf('color:black'), yellow = await rowOf('color:yellow')
    // The identity field is created once; then per colour: identity, SKUs. Nothing else is written.
    expect(state.mutations).toEqual(['NexusCreateDefinition', 'NexusColourIdentity', 'NexusColourWriteSkus', 'NexusColourIdentity', 'NexusColourWriteSkus'])
    expect(productOf(BLACK).identity).toBe(`${LEGACY_WORKSPACE_ID}:${ids.fam}:c:${black.id}`)
    expect(productOf(YELLOW).identity).toBe(colourProductIdentity(yellow))
    expect(state.store.flatMap(p => p.variants.map((v: any) => v.sku))).toEqual([...SIZES.slice(1).map(s => skuOf('BLACK', s)), ...SIZES.slice(1).map(s => skuOf('YELLOW', s))])
    expect(black).toMatchObject({ state: 'LINKED', shopifyProductId: BLACK, colourName: 'Black', remoteStatus: 'ACTIVE' })
    expect(yellow).toMatchObject({ state: 'LINKED', shopifyProductId: YELLOW, colourName: 'Yellow' })
    expect(view.confirmed).toEqual([
      { valueKey: 'color:black', name: 'Nero', shopifyProductId: BLACK, status: 'ACTIVE', identityWritten: true, skusWritten: 2, sizesLinked: 9, draftsCreated: 21, locationId: LOCATION, notStockedAt: [], adoptOnly: true, skusRecorded: 0, skusReplaced: 0 },
      { valueKey: 'color:yellow', name: 'Giallo', shopifyProductId: YELLOW, status: 'ACTIVE', identityWritten: true, skusWritten: 9, sizesLinked: 9, draftsCreated: 0, locationId: LOCATION, notStockedAt: [], adoptOnly: true, skusRecorded: 0, skusReplaced: 0 },
    ])
    // What the stock and price sync read (offer-sync.service.ts): numeric ids, the location GID, a live row — which stays
    // PAUSED (adopt only, the default of a first Confirm): no stock is queued, no stock or price reaches Shopify.
    const yellowM = await listingOf(skuOf('YELLOW', 'M'))
    expect(yellowM).toMatchObject({ externalListingId: '102', platformProductId: '102', isPublished: true, listingStatus: 'ACTIVE', syncPaused: true,
      platformAttributes: { nexusFamilyId: ids.fam, shopifyColourProductId: yellow.id, shopifyProductId: '102', variantId: '1023', inventoryItemId: '1023', inventoryLocationId: LOCATION, shopifyColourAdoptPaused: true } })
    expect((yellowM!.platformAttributes as any).shopifyColourStockPending).toBeUndefined()
    expect(await scoped(() => prisma.channelListing.count({ where: { channel: 'SHOPIFY', syncPaused: false } }))).toBe(0)
    expect(await syncRow()).toMatchObject({ adoptOnly: true })
    expect(view.sync).toEqual({ linked: true, adoptOnly: true })
    expect((await listingOf(skuOf('BLACK', 'S')))!.platformAttributes).toMatchObject({ shopifyProductId: '101', variantId: '1012', inventoryItemId: '1012' })
    // XXS is not on Shopify: its listing is an inert draft, like the parent's (the family's listing is born whole).
    for (const sku of [skuOf('BLACK', 'XXS'), skuOf('YELLOW', 'XXS')]) expect(await listingOf(sku)).toMatchObject({ listingStatus: 'DRAFT', isPublished: false, syncPaused: true, externalListingId: null })
    expect(await scoped(() => prisma.channelListing.findFirst({ where: { productId: ids.fam, channel: 'SHOPIFY' } }))).toMatchObject({ listingStatus: 'DRAFT', syncPaused: true })
    expect(state.refreshed).toContain(ids.fam)
  })

  it('confirming again changes nothing on Shopify (a stopped run resumes); another product for a linked colour is refused', async () => {
    await find()
    await confirm([BOTH[0]])
    const before = await listingOf(skuOf('BLACK', 'M'))
    state.mutations = []
    const again = await confirm([BOTH[0]])
    expect(state.mutations).toEqual([])
    expect(again.confirmed[0]).toMatchObject({ identityWritten: false, skusWritten: 0, sizesLinked: 9, draftsCreated: 0 })
    expect((await listingOf(skuOf('BLACK', 'M')))!.version).toBe(before!.version + 1)
    // One reason, not the size and identity checks of a product that is not this colour's.
    await expect(confirm([{ valueKey: 'color:black', shopifyProductId: YELLOW }])).rejects.toThrow(/^"Nero" is already linked to another Shopify product\. Nothing was changed\.$/)
    expect(state.mutations).toEqual([])
  })

  it('confirming withdraws the family\'s "Linked ✓" (the link writer has not read the change back yet), after every chosen colour is done', async () => {
    await find()
    await scoped(() => prisma.shopifyColourProduct.updateMany({ where: { familyId: ids.fam }, data: { linkVerifiedAt: new Date('2026-09-01T00:00:00Z') } }))
    await confirm(BOTH)
    expect([await rowOf('color:black'), await rowOf('color:yellow')].map(r => [r.state, r.linkVerifiedAt])).toEqual([['LINKED', null], ['LINKED', null]])
  })

  it('a Draft product: its sizes are linked but not published (stock waits); a size not stocked at the location is named', async () => {
    productOf(BLACK).status = 'DRAFT'
    productOf(BLACK).variants[2].stocked = false
    await find()
    const view = await confirm([BOTH[0]])
    expect(view.confirmed[0]).toMatchObject({ status: 'DRAFT', notStockedAt: [skuOf('BLACK', 'M')] })
    expect(await listingOf(skuOf('BLACK', 'L'))).toMatchObject({ isPublished: false, listingStatus: 'INACTIVE', externalListingId: '101' })
    expect((await rowOf('color:black')).remoteStatus).toBe('DRAFT')
  })

  it('full sync: an Active product off Online Store waits for stock, but retains the initial stock task', async () => {
    productOf(BLACK).onlineStorePublished = false
    await find(); await confirm([BOTH[1]]); await startFullSync()
    await confirm([BOTH[0]])
    expect(await listingOf(skuOf('BLACK', 'S'))).toMatchObject({ isPublished: false, platformAttributes: { shopifyColourStockPending: true } })
  })
  it('first Confirm stops when the store switch changes during its read', async () => {
    await find()
    state.duringConfirm = async () => { await switchOn(false) }
    await expect(confirm(BOTH)).rejects.toThrow(/changed/)
    await nothingChanged()
  })
  it('first Confirm stops when a child SKU changes during its read', async () => {
    await find()
    state.duringConfirm = async () => { await prisma.product.update({ where: { id: ids[skuOf('BLACK', 'S')] }, data: { sku: 'CHANGED-DURING-CONFIRM' } }) }
    try { await expect(confirm(BOTH)).rejects.toThrow(/changed/); await nothingChanged() }
    finally { await scoped(() => prisma.product.update({ where: { id: ids[skuOf('BLACK', 'S')] }, data: { sku: skuOf('BLACK', 'S') } })) }
  })

  it('Shopify refuses one colour: the colours before it stay confirmed and the message says so', async () => {
    await find()
    state.refuseIdentity = YELLOW
    await expect(confirm(BOTH)).rejects.toThrow(/Shopify did not accept the change to "GALE jacket" \(Giallo\): .*Value is already taken.* "Nero" is confirmed\./)
    expect([(await rowOf('color:black')).state, (await rowOf('color:yellow')).state]).toEqual(['LINKED', 'PROPOSED'])
    expect((await listingOf(skuOf('YELLOW', 'M')))!.externalListingId).toBeNull()
  })
})

describe('Confirm refuses before any Shopify write', () => {
  it('without Find, with the store switch off, or with Shopify writes off on the server — Shopify is not even read', async () => {
    await expect(confirm(BOTH)).rejects.toThrow('Run Find first')
    await find()
    state.queries = []
    await switchOn(false)
    await expect(confirm(BOTH)).rejects.toThrow('Switch on colour products for this Shopify store first. Nothing was changed.')
    await switchOn(true)
    state.mode = 'dry-run'
    await expect(confirm(BOTH)).rejects.toThrow('Shopify writes are switched off on this server. Nothing was changed.')
    expect(state.queries).toEqual([])
    await nothingChanged()
  })

  it('Shopify changed since Find (a size gone, a SKU typed in): run Find again', async () => {
    await find()
    productOf(YELLOW).variants.pop()
    await expect(confirm(BOTH)).rejects.toThrow('"GALE jacket" changed since Find, or Find proposed another product for "Giallo". Run Find again.')
    await nothingChanged()
    state.store = liveStore()
    productOf(YELLOW).variants[1].sku = 'Y-OLD-S'
    await expect(confirm(BOTH)).rejects.toThrow('the S variant has SKU Y-OLD-S; Nexus has GALE-JACKET-YELLOW-MEN-S.')
    await nothingChanged()
  })

  it('a size already listed as another Shopify product, a product with another Nexus identity, two locations and none chosen', async () => {
    await find()
    await scoped(() => prisma.channelListing.create({ data: { productId: ids[skuOf('BLACK', 'M')], channel: 'SHOPIFY', marketplace: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL',
      channelConnectionId: ids.account, aliasKey: '', externalListingId: '999', listingStatus: 'ACTIVE', isPublished: true } as never }))
    productOf(YELLOW).identity = 'ws:another-family'
    state.locations = [{ id: LOCATION, name: 'Warehouse', isActive: true }, { id: OTHER_LOCATION, name: 'Shop', isActive: true }]
    const refusal = await confirm(BOTH).catch((e: Error) => e.message)
    expect(refusal).toContain(`${skuOf('BLACK', 'M')} is already the listing of another Shopify product (999).`)
    expect(refusal).toContain('"GALE jacket" already carries another Nexus identity (ws:another-family).')
    expect(refusal).toContain('The store has 2 active locations. Choose where the stock of "Nero" is counted.')
    expect(refusal).toMatch(/Nothing was changed\.$/)
    expect(state.mutations).toEqual([])
    // A chosen location is used; one that is not an active location of the store is refused.
    await scoped(() => prisma.channelListing.deleteMany({ where: { channel: 'SHOPIFY' } }))
    productOf(YELLOW).identity = null
    await expect(confirm([{ ...BOTH[0], locationId: 'gid://shopify/Location/99' }])).rejects.toThrow('The location chosen for "Nero" is not an active location of the store.')
    await confirm([{ ...BOTH[0], locationId: OTHER_LOCATION }])
    expect((await listingOf(skuOf('BLACK', 'M')))!.platformAttributes).toMatchObject({ inventoryLocationId: OTHER_LOCATION })
  })

  it('a body that names one product for two colours, or no colour, is refused', async () => {
    await expect(confirm([BOTH[0], { valueKey: 'color:yellow', shopifyProductId: BLACK }])).rejects.toThrow('One Shopify product can be one colour only.')
    await expect(confirm([])).rejects.toThrow('Choose at least one colour to confirm.')
    await expect(confirm([{ valueKey: 'color:black', shopifyProductId: 'not-a-gid' }])).rejects.toThrow('Choose a Shopify product.')
  })
})

/**
 * S5 (per-channel SKU) — Confirm matches and writes each size under the SKU Shopify will know it by: its listing's own SKU
 * on this store (for a still-draft, the one Publish would send), else its product SKU (every case above). What Shopify
 * read back under a listing's own SKU is recorded as the SKU it holds; a size under its product SKU records nothing.
 */
describe('S5 — Confirm writes and records the listing\'s own SKU', () => {
  it('a draft size listing with its own SKU: Shopify\'s SKU-less variant gets that SKU (never the product SKU), recorded as live', async () => {
    await scoped(() => prisma.channelListing.create({ data: { productId: ids[skuOf('BLACK', 'S')], channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL',
      channelConnectionId: ids.account, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, channelSku: 'BLACK-S-OWN' } as never }))
    await find()
    expect((await rowOf('color:black')).proposal).toMatchObject({ skusToWrite: [{ shopifyVariantId: variantGid(BLACK, 'S'), sku: 'BLACK-S-OWN' }, { shopifyVariantId: variantGid(BLACK, '3XL'), sku: skuOf('BLACK', '3XL') }] })
    await confirm([BOTH[0]])
    expect(productOf(BLACK).variants.find((v: any) => v.id === variantGid(BLACK, 'S')).sku).toBe('BLACK-S-OWN')
    expect(await listingOf(skuOf('BLACK', 'S'))).toMatchObject({ channelSku: 'BLACK-S-OWN', liveChannelSku: 'BLACK-S-OWN', isPublished: true, externalListingId: '101' })
    expect(await listingOf(skuOf('BLACK', '3XL'))).toMatchObject({ channelSku: null, liveChannelSku: null, isPublished: true })
  })
})

/**
 * Adopt only — the default of a family's first Confirm on a store that Nexus never wrote to: link, and nothing more. The
 * size listings stay paused, no stock is queued, the colour sync only reads, and the link writer refuses — until the
 * operator starts the full sync.
 */
describe('Adopt only, and Start full sync', () => {
  it('Start full sync writes nothing to Shopify: it resumes the sizes the link paused (never an operator\'s pause), queues their stock, and later Confirms run as before', async () => {
    // An operator paused BLACK-L before the link (a row that is not a draft): its pause is its own.
    await scoped(() => prisma.channelListing.create({ data: { productId: ids[skuOf('BLACK', 'L')], channel: 'SHOPIFY', marketplace: 'GLOBAL', region: 'GLOBAL', channelMarket: 'SHOPIFY_GLOBAL',
      channelConnectionId: ids.account, aliasKey: '', listingStatus: 'INACTIVE', isPublished: false, syncPaused: true } as never }))
    await find(); await confirm([BOTH[0]])
    expect(await listingOf(skuOf('BLACK', 'L'))).toMatchObject({ syncPaused: true, platformAttributes: { shopifyColourAdoptPaused: false } })
    state.queries = []; state.mutations = []
    // The swatch writer refuses while adopt only, before it reads anything.
    await expect(scoped(() => linkColourProducts(ids.fam, { accountId: 'x' }))).rejects.toThrow(ADOPT_ONLY_LINK_REFUSED)
    const view = await startFullSync()
    expect(state.queries).toEqual([])
    expect(view.started).toEqual({ resumed: 8, stockQueued: 9, alreadyRunning: false })
    expect(view.sync).toEqual({ linked: true, adoptOnly: false })
    expect(await syncRow()).toMatchObject({ adoptOnly: false })
    expect((await syncRow()).dueAt).not.toBeNull()
    expect(await listingOf(skuOf('BLACK', 'M'))).toMatchObject({ syncPaused: false, platformAttributes: { shopifyColourStockPending: true } })
    expect((await listingOf(skuOf('BLACK', 'M')))!.platformAttributes).not.toHaveProperty('shopifyColourAdoptPaused')
    expect(await listingOf(skuOf('BLACK', 'L'))).toMatchObject({ syncPaused: true, platformAttributes: { shopifyColourStockPending: true } })
    // Nothing outside the linked sizes was resumed.
    expect(await scoped(() => prisma.channelListing.count({ where: { channel: 'SHOPIFY', syncPaused: false } }))).toBe(8)
    // Again (a double click): nothing more.
    expect((await startFullSync()).started).toEqual({ resumed: 0, stockQueued: 0, alreadyRunning: true })
    // A colour confirmed now runs as before adopt only existed: the draft made real is resumed and its stock queued.
    const yellow = await confirm([BOTH[1]])
    expect(yellow.confirmed[0]).toMatchObject({ adoptOnly: false })
    expect(await listingOf(skuOf('YELLOW', 'M'))).toMatchObject({ syncPaused: false, platformAttributes: { shopifyColourStockPending: true } })
    expect(await syncRow()).toMatchObject({ adoptOnly: false })
  })

  it('Start full sync is refused without its confirmation, with the store switch off, with Shopify writes off, or with no linked colour', async () => {
    await expect(startFullSync()).rejects.toThrow('No colour of this family is linked to a Shopify product yet.')
    await find(); await confirm([BOTH[0]])
    await expect(scoped(() => startFullColourSync(ids.fam, { accountId: 'x' }, {}))).rejects.toThrow('Review what the full sync turns on, then confirm it.')
    state.mode = 'dry-run'
    await expect(startFullSync()).rejects.toThrow('Shopify writes are switched off on this server. Nothing was changed.')
    state.mode = 'live'
    await switchOn(false)
    await expect(startFullSync()).rejects.toThrow('Switch on colour products for this Shopify store first. Nothing was changed.')
    expect(await syncRow()).toMatchObject({ adoptOnly: true })
  })

  it('the operator\'s chosen product: Find proposes it for the colour, and Confirm links it', async () => {
    // A store with no SKU and no colour name Nexus knows: nothing to guess from.
    for (const p of state.store) { p.variants.forEach((v: any) => { v.sku = '' }); p.colour = 'Unknown' }
    await find()
    expect([(await rowOf('color:black')).state, (await rowOf('color:yellow')).state]).toEqual(['NOT_FOUND', 'NOT_FOUND'])
    await scoped(() => findColourProducts(ids.fam, { accountId: 'x' }, { choices: [{ valueKey: 'color:yellow', shopifyProductId: YELLOW }] }))
    const proposal = (await rowOf('color:yellow')).proposal as any
    expect(proposal).toMatchObject({ method: 'operator', chosenProductId: YELLOW, shopifyProductId: YELLOW, issues: [] })
    expect(proposal.skusToWrite).toHaveLength(9)
    // Black is then the one colour and BLACK the one product left of the group.
    expect((await rowOf('color:black')).proposal).toMatchObject({ method: 'group', shopifyProductId: BLACK })
    await confirm([BOTH[1]])
    expect(await rowOf('color:yellow')).toMatchObject({ state: 'LINKED', shopifyProductId: YELLOW })
    expect(productOf(YELLOW).identity).toBe(colourProductIdentity(await rowOf('color:yellow')))
  })

  it('a chosen product whose sizes carry another colour\'s SKUs: refused until the operator asks to replace them; then written and read back', async () => {
    // The store's Yellow product holds the Black SKUs (Black's own product too, on 7 sizes).
    for (const v of productOf(YELLOW).variants) v.sku = skuOf('BLACK', v.option)
    await scoped(() => findColourProducts(ids.fam, { accountId: 'x' }, { choices: [{ valueKey: 'color:yellow', shopifyProductId: YELLOW }] }))
    const proposal = (await rowOf('color:yellow')).proposal as any
    expect(proposal).toMatchObject({ method: 'operator', shopifyProductId: YELLOW, issues: [], skusToWrite: [] })
    expect(proposal.skusToReplace).toHaveLength(9)
    expect(proposal.skusToReplace).toContainEqual({ productId: ids[skuOf('YELLOW', 'M')], shopifyVariantId: variantGid(YELLOW, 'M'), from: skuOf('BLACK', 'M'), to: skuOf('YELLOW', 'M') })
    // Black is still Black's product by its SKUs: the product chosen for Yellow is not a claim on Black.
    expect((await rowOf('color:black')).proposal).toMatchObject({ method: 'sku', shopifyProductId: BLACK, issues: [] })
    await expect(confirm([BOTH[1]])).rejects.toThrow(`In "GALE jacket", 9 sizes carry other SKUs (${skuOf('BLACK', 'XS')} → ${skuOf('YELLOW', 'XS')}`)
    expect(state.mutations).toEqual([])
    const view = await confirm([{ ...BOTH[1], replaceSkus: true }])
    expect(view.confirmed[0]).toMatchObject({ skusWritten: 0, skusReplaced: 9, sizesLinked: 9, adoptOnly: true })
    expect(state.mutations).toEqual(['NexusCreateDefinition', 'NexusColourIdentity', 'NexusColourWriteSkus'])
    expect(productOf(YELLOW).variants.map((v: any) => v.sku)).toEqual(SIZES.slice(1).map(s => skuOf('YELLOW', s)))
    expect(await listingOf(skuOf('YELLOW', 'M'))).toMatchObject({ externalListingId: '102', syncPaused: true, platformAttributes: { variantId: '1023' } })
  })

  it('a Shopify SKU that differs only in letter case: Confirm links it and records Shopify\'s SKU as the listing\'s own SKU, writing nothing to Shopify for it', async () => {
    const lower = skuOf('BLACK', 'M').toLowerCase()
    productOf(BLACK).variants.find((v: any) => v.option === 'M').sku = lower
    await find()
    expect((await rowOf('color:black')).proposal).toMatchObject({ issues: [], skusToRecord: [{ productId: ids[skuOf('BLACK', 'M')], shopifyVariantId: variantGid(BLACK, 'M'), sku: lower }] })
    const view = await confirm([BOTH[0]])
    expect(view.confirmed[0]).toMatchObject({ skusWritten: 2, skusRecorded: 1, sizesLinked: 9 })
    expect(productOf(BLACK).variants.find((v: any) => v.option === 'M').sku).toBe(lower)
    expect(await listingOf(skuOf('BLACK', 'M'))).toMatchObject({ channelSku: lower, liveChannelSku: lower, externalListingId: '101', syncPaused: true })
    // Any other difference is still refused.
    state.store = liveStore()
    productOf(YELLOW).variants[1].sku = 'Y-OLD-S'
    await find()
    await expect(confirm([BOTH[1]])).rejects.toThrow('the S variant has SKU Y-OLD-S; Nexus has GALE-JACKET-YELLOW-MEN-S.')
  })
})
