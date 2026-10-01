import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { planColourProducts } from '@nexus/shared/shopify-colour-products'
const state = vi.hoisted(() => ({ db: null as any, d: null as any, family: null as any, remote: null as any, sizes: ['S', 'M'], order: ['S', 'M'],
  calls: [] as string[], stock: [] as string[], failStock: '', lostCreate: false, gone: false, mode: 'live', next: 30, linked: 0, createdPrices: [] as string[] }))
vi.mock('@nexus/database', async original => {
  const { formulaDatabase } = await import('../../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { ...await original<any>(), default: state.db.client, prisma: state.db.client }
})
vi.mock('../content-workspace.service.js', () => ({ contentDestination: async () => state.d, object: (v: any) => v ?? {} }))
vi.mock('./family.js', () => ({ loadColourPlan: async () => ({ plan: planColourProducts({ ...state.family,
  variants: state.family.variants.filter((v: any) => state.sizes.includes(v.optionsSize)), valueOrder: { size: state.order.map(s => `size:${s}`) } }, { splitAxis: 'color' }) }) }))
vi.mock('../../shopify-publish-gate.service.js', () => ({ getShopifyPublishMode: () => state.mode }))
vi.mock('../admin-client.js', async original => ({ ...await original<any>(), shopifyAdmin: async () => ({ graphql: shopify }) }))
vi.mock('../offer-sync.service.js', () => ({ syncNativeShopifyOffer: async (item: any) => {
  const refusal = (await import('@nexus/shared/push-lock')).assertPushAllowed(item.channelListing)
  if (refusal) throw new Error(refusal.sentence)
  if (state.failStock === item.product.sku) throw new Error('stock failed')
  state.stock.push(item.product.sku)
} }))
vi.mock('./link.service.js', () => ({ linkColourProducts: async () => { state.linked++; return { link: { written: 0 } } } }))
vi.mock('../../product-read-cache.service.js', () => ({ productReadCacheService: { refreshMany: async () => {} } }))

function shopify(query: string, vars: any) {
  const op = query.match(/(?:query|mutation)\s+(\w+)/)?.[1]!
  state.calls.push(op)
  if (op === 'NexusColourPublications') return { publications: { nodes: [{ id: 'gid://shopify/Publication/1', catalog: { apps: { nodes: [{ handle: 'online_store' }] } } }], pageInfo: { hasNextPage: false } } }
  if (op === 'NexusColourSyncRead') return { product: state.gone || vars.id !== state.remote.id ? null : structuredClone(state.remote) }
  if (op === 'NexusColourLocation') return { location: { id: 'gid://shopify/Location/7', isActive: true } }
  if (op === 'NexusColourSizes') {
    expect(vars.strategy).toBeUndefined() // The document explicitly preserves the standalone variant.
    expect(query).toContain('PRESERVE_STANDALONE_VARIANT')
    for (const v of vars.variants) {
      state.createdPrices.push(v.price)
      expect(v.inventoryQuantities).toEqual([{ locationId: 'gid://shopify/Location/7', availableQuantity: 0 }])
      expect(v.inventoryPolicy).toBe('DENY')
      const id = String(state.next++)
      state.remote.variants.nodes.push({ id: `gid://shopify/ProductVariant/${id}`, sku: v.inventoryItem.sku, inventoryItem: { id: `gid://shopify/InventoryItem/${id}`, tracked: true },
        selectedOptions: v.optionValues.map((o: any) => ({ name: 'Size', value: o.name })) })
      state.remote.options[0].values.push(v.optionValues[0].name)
    }
    if (state.lostCreate) { state.lostCreate = false; throw new Error('response lost') }
    return { productVariantsBulkCreate: { userErrors: [] } }
  }
  if (op === 'NexusColourSizeOrder') {
    state.remote.options = vars.options.map((o: any) => ({ ...state.remote.options.find((r: any) => r.id === o.id), values: o.values.map((v: any) => v.name) }))
    return { productOptionsReorder: { userErrors: [] } }
  }
  if (op === 'NexusColourArchive') { state.remote.status = 'ARCHIVED'; state.remote.onlineStoreUrl = null; return { productUpdate: { userErrors: [] } } }
  throw new Error(`Unexpected ${op}`)
}
import prisma from '../../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../../lib/workspace-context.js'
import { syncColourProducts } from './sync.service.js'
import { processColourSyncs, queueColourChecks } from '../../../workers/shopify-colour-sync.worker.js'
const scoped = <T>(fn: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, fn)
const rows = () => scoped(() => prisma.channelListing.findMany({ where: { channelConnectionId: state.d.accountId, productId: { not: state.d.familyId } }, include: { product: true }, orderBy: { product: { sku: 'asc' } } }))
const run = () => scoped(() => syncColourProducts(state.d.familyId, { accountId: state.d.accountId }))
let seq = 0, colourId = ''
beforeAll(async () => {
  await scoped(() => prisma.marketplace.create({ data: { channel: 'SHOPIFY', code: 'GLOBAL', name: 'Shopify', currency: 'EUR', region: 'GLOBAL', language: 'en', languages: ['en'], isActive: true } }))
}, 60_000)
afterAll(async () => { await state.db?.close() })
beforeEach(async () => {
  seq++
  Object.assign(state, { sizes: ['S', 'M'], order: ['S', 'M'], calls: [], stock: [], failStock: '', lostCreate: false, gone: false, mode: 'live', next: 30, linked: 0 })
  await scoped(async () => {
    await prisma.shopifyColourSync.deleteMany({})
    await prisma.channelConnection.updateMany({ data: { isActive: false } })
    const account = await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: `test-${seq}`, externalAccountId: `test-${seq}`, authStatus: 'connected', managedBy: 'oauth', isActive: true,
      connectionMetadata: { shopifyColourProducts: { enabled: true } } } as never })
    const family = await prisma.product.create({ data: { sku: `COLOUR-${seq}`, name: 'Colour family', basePrice: 10, isParent: true } })
    state.d = { familyId: family.id, accountId: account.id, marketplace: 'GLOBAL', aliasKey: '' }
    const colour = await prisma.shopifyColourProduct.create({ data: { familyId: family.id, channelConnectionId: account.id, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/1', colourName: 'Black' } })
    colourId = colour.id
    const children = []
    for (const [i, size] of ['S', 'M', 'XS'].entries()) {
      const child = await prisma.product.create({ data: { sku: `COLOUR-${seq}-${size}`, name: size, basePrice: 10, parentId: family.id } })
      children.push({ productId: child.id, sku: child.sku, values: { color: 'color:black', size: `size:${size}` }, optionsSize: size })
      if (size !== 'XS') await prisma.channelListing.create({ data: { productId: child.id, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', marketplace: 'GLOBAL', channelConnectionId: account.id,
        listingStatus: 'INACTIVE', isPublished: false, syncPaused: false, followMasterQuantity: true,
        externalListingId: '1', platformAttributes: { nexusFamilyId: family.id, shopifyColourProductId: colour.id, shopifyProductId: '1', variantId: String(i + 1), inventoryItemId: String(i + 1), inventoryLocationId: 'gid://shopify/Location/7' } } })
    }
    state.family = { familyId: family.id, axes: [{ code: 'color', label: 'Color' }, { code: 'size', label: 'Size' }], variants: children,
      valueLabels: { 'color:black': 'Black', 'size:S': 'S', 'size:M': 'M', 'size:XS': 'XS' }, valueOrder: {}, unmapped: [] }
    state.remote = { id: 'gid://shopify/Product/1', status: 'ACTIVE', onlineStorePublished: true, identity: { value: `${LEGACY_WORKSPACE_ID}:${family.id}:c:${colour.id}` },
      options: [{ id: 'gid://shopify/ProductOption/1', name: 'Size', values: ['S', 'M'] }], variants: { pageInfo: { hasNextPage: false },
        nodes: children.slice(0, 2).map((v, i) => ({ id: `gid://shopify/ProductVariant/${i + 1}`, sku: v.sku, selectedOptions: [{ name: 'Size', value: v.optionsSize }], inventoryItem: { id: `gid://shopify/InventoryItem/${i + 1}`, tracked: true } })) } }
  })
})
it('publishes the size rows and sends each initial stock once; a clean poll writes nothing', async () => {
  await run(); expect(state.stock).toHaveLength(2)
  expect((await rows()).every(r => r.isPublished)).toBe(true)
  state.stock = []; state.calls = []
  await run(); expect(state.stock).toEqual([]); expect(state.calls).toEqual(['NexusColourPublications', 'NexusColourSyncRead'])
})
it.each(['DRAFT', 'ARCHIVED', 'OFF_STORE'])('keeps %s sizes unpublished and keeps their IDs', async status => {
  if (status === 'OFF_STORE') state.remote.onlineStorePublished = false; else state.remote.status = status
  await run(); expect(state.stock).toEqual([])
  expect((await rows()).every(r => !r.isPublished && r.externalListingId === '1')).toBe(true)
})
it('sends current stock again after the colour is shown again, including Unlisted', async () => {
  await run(); state.remote.status = 'DRAFT'; await run(); state.stock = []
  state.remote.status = 'UNLISTED'; await run(); expect(state.stock).toHaveLength(2)
})
it('keeps failed activation stock pending after publication has been saved', async () => {
  state.failStock = state.family.variants[1].sku
  await expect(run()).rejects.toThrow('stock failed')
  expect((await rows()).every(r => r.isPublished)).toBe(true)
  state.failStock = ''; state.stock = []; await run()
  expect(state.stock).toEqual([state.family.variants[1].sku])
})
it('creates a missing size at zero, saves exact IDs, reorders, then sends stock', async () => {
  state.sizes = ['XS', 'S', 'M']; state.order = ['XS', 'S', 'M']
  await run()
  expect(state.calls.filter(c => c === 'NexusColourSizes')).toHaveLength(1)
  expect(state.remote.options[0].values).toEqual(['XS', 'S', 'M'])
  expect((await rows()).find(r => r.product.sku.endsWith('-XS'))).toMatchObject({ platformAttributes: { variantId: '30', inventoryItemId: '30' }, isPublished: true })
  state.calls = []; await run(); expect(state.calls).toEqual(['NexusColourPublications', 'NexusColourSyncRead'])
})
// Round 6 — a new size is created at the listing's send price (`listingSendPrice`), not the master price.
it('🔴 creates a missing size following "master +10%" at 11.00 (it was the master 10); a FIXED one at 10.00', async () => {
  state.sizes = ['XS', 'S', 'M']; state.order = ['XS', 'S', 'M']; state.createdPrices = []
  const xs = state.family.variants.find((v: any) => v.optionsSize === 'XS')
  await scoped(() => prisma.channelListing.create({ data: { productId: xs.productId, channel: 'SHOPIFY', channelMarket: 'SHOPIFY_GLOBAL', region: 'GLOBAL', marketplace: 'GLOBAL',
    channelConnectionId: state.d.accountId, aliasKey: '', listingStatus: 'DRAFT', isPublished: false, syncPaused: true, followMasterPrice: true, pricingRule: 'PERCENT_OF_MASTER', priceAdjustmentPercent: 10 } as never }))
  await run()
  expect(state.createdPrices).toEqual(['11.00'])
})
it('a missing size with no listing yet is created at the master price, in Shopify\'s two decimals ("10.00"; it sent "10")', async () => {
  state.sizes = ['XS', 'S', 'M']; state.order = ['XS', 'S', 'M']; state.createdPrices = []
  await run()
  expect(state.createdPrices).toEqual(['10.00'])
})
it('recovers a create whose response was lost without a duplicate variant', async () => {
  state.sizes = ['XS', 'S', 'M']; state.order = ['XS', 'S', 'M']; state.lostCreate = true
  await expect(run()).rejects.toThrow('response lost')
  await run()
  expect(state.calls.filter(c => c === 'NexusColourSizes')).toHaveLength(1)
  expect(state.remote.variants.nodes).toHaveLength(3)
})
it('marks only mapped removed sizes retired and keeps their IDs', async () => {
  await run(); state.stock = []; state.sizes = ['M']; state.order = ['M']
  await run()
  const retired = (await rows()).find(r => r.product.sku.endsWith('-S'))!
  expect(retired).toMatchObject({ externalListingId: '1', isPublished: false, platformAttributes: { variantId: '1', shopifyColourRetired: true, shopifyColourStockPending: false } })
  expect(state.stock).toEqual([state.family.variants[0].sku])
  expect(state.remote.variants.nodes).toHaveLength(2)
})
it('forgets a proven deleted product and blocks old stock work', async () => {
  state.gone = true
  await run()
  expect((await rows()).every(r => !r.isPublished && r.syncPaused && !r.externalListingId && !(r.platformAttributes as any).variantId)).toBe(true)
  const row = await scoped(() => prisma.shopifyColourProduct.findUniqueOrThrow({ where: { id: colourId } }))
  expect(row).toMatchObject({ state: 'DELETED', shopifyProductId: null, linkVerifiedAt: null })
  expect(state.linked).toBe(0)
})
it('refuses a foreign product identity before any mutation or mapping change', async () => {
  state.remote.identity.value = 'another-family'
  await expect(run()).rejects.toThrow(/identity/)
  expect(state.stock).toEqual([]); expect(state.calls).toEqual(['NexusColourPublications', 'NexusColourSyncRead'])
  expect((await rows()).every(r => r.externalListingId === '1')).toBe(true)
})
it('the durable handler retries failed stock after a process stop and clears work only on success', async () => {
  await scoped(() => prisma.shopifyColourSync.updateMany({ data: { dueAt: new Date(0) } }))
  state.failStock = state.family.variants[1].sku
  expect(await scoped(() => processColourSyncs())).toEqual({ claimed: 1, done: 0, failed: 1 })
  const failed = await scoped(() => prisma.shopifyColourSync.findFirstOrThrow({ where: { familyId: state.d.familyId } }))
  expect(failed).toMatchObject({ leaseToken: null, lastError: `${state.family.variants[1].sku}: stock failed` })
  expect(failed.dueAt).not.toBeNull()
  state.failStock = ''; state.stock = []
  await scoped(() => prisma.shopifyColourSync.updateMany({ data: { dueAt: new Date(0) } }))
  expect(await scoped(() => processColourSyncs())).toEqual({ claimed: 1, done: 1, failed: 0 })
  expect(state.stock).toEqual([state.family.variants[1].sku])
  expect((await scoped(() => prisma.shopifyColourSync.findUniqueOrThrow({ where: { id: failed.id } }))).dueAt).toBeNull()
})
it('the sweep queues every store and alias without moving an existing debounce deadline', async () => {
  await scoped(async () => {
    const other = await prisma.channelConnection.create({ data: { channelType: 'SHOPIFY', accountLabel: 'second', externalAccountId: `second-${seq}`, isActive: true, authStatus: 'connected', managedBy: 'oauth', connectionMetadata: { shopifyColourProducts: { enabled: true } } } as never })
    await prisma.shopifyColourProduct.createMany({ data: [
      { familyId: state.d.familyId, channelConnectionId: state.d.accountId, aliasKey: 'outlet', splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/2' },
      { familyId: state.d.familyId, channelConnectionId: other.id, splitAxis: 'color', valueKey: 'color:black', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/1' },
    ] })
    const before = await prisma.shopifyColourSync.findMany({ where: { familyId: state.d.familyId }, orderBy: { id: 'asc' } })
    expect(await queueColourChecks()).toBe(3)
    const after = await prisma.shopifyColourSync.findMany({ where: { familyId: state.d.familyId }, orderBy: { id: 'asc' } })
    expect(after.map(r => [r.id, r.revision, r.dueAt])).toEqual(before.map(r => [r.id, r.revision, r.dueAt]))
    expect(new Set(after.map(r => `${r.channelConnectionId}/${r.aliasKey}`)).size).toBe(3)
  })
})
it('archives a whole retired colour after its sizes reach zero and keeps the product and IDs', async () => {
  state.sizes = []; state.order = []
  await run()
  expect(state.remote.status).toBe('ARCHIVED')
  expect(state.remote.variants.nodes).toHaveLength(2)
  expect(state.stock).toHaveLength(2)
  expect(state.linked).toBe(1)
  expect((await rows()).every(r => r.externalListingId === '1')).toBe(true)
})
it('keeps an ended size ended while healthy sibling stock still runs', async () => {
  const first = (await rows()).find(r => r.product.sku.endsWith('-S'))!
  await scoped(() => prisma.channelListing.update({ where: { id: first.id }, data: { listingStatus: 'ENDED' } }))
  await expect(run()).rejects.toThrow(/ended/i)
  expect((await rows()).find(r => r.id === first.id)!.listingStatus).toBe('ENDED')
  expect(state.stock).toEqual([state.family.variants[1].sku])
})
it('one paused size does not hide another colour\'s deletion or block healthy stock', async () => {
  const first = (await rows()).find(r => r.product.sku.endsWith('-S'))!
  let otherId = ''
  await scoped(async () => {
    await prisma.channelListing.update({ where: { id: first.id }, data: { syncPaused: true } })
    otherId = (await prisma.shopifyColourProduct.create({ data: { familyId: state.d.familyId, channelConnectionId: state.d.accountId, splitAxis: 'color', valueKey: 'color:yellow', state: 'LINKED', shopifyProductId: 'gid://shopify/Product/2' } })).id
  })
  await expect(run()).rejects.toThrow(/paused/i)
  expect(state.stock).toEqual([state.family.variants[1].sku])
  expect((await scoped(() => prisma.shopifyColourProduct.findUniqueOrThrow({ where: { id: otherId } }))).state).toBe('DELETED')
  expect((await rows()).find(r => r.id === first.id)!.platformAttributes).toMatchObject({ shopifyColourStockPending: true })
})
it('adds a size on an alias after preparing its own local draft row', async () => {
  await scoped(async () => {
    const alias = await prisma.productListingAlias.create({ data: { productId: state.d.familyId, channel: 'SHOPIFY', marketplace: 'GLOBAL', channelConnectionId: state.d.accountId, label: 'Outlet' } })
    state.d.aliasKey = alias.id
    await prisma.shopifyColourProduct.update({ where: { id: colourId }, data: { aliasKey: alias.id } })
    await prisma.channelListing.updateMany({ where: { channelConnectionId: state.d.accountId }, data: { aliasKey: alias.id, aliasId: alias.id } })
  })
  state.sizes = ['XS', 'S', 'M']; state.order = ['XS', 'S', 'M']
  await run()
  expect((await rows()).find(r => r.product.sku.endsWith('-XS'))).toMatchObject({ aliasKey: state.d.aliasKey, platformAttributes: { variantId: '30' } })
  await run(); expect(state.calls.filter(c => c === 'NexusColourSizes')).toHaveLength(1)
})
it('retires a deleted parent even when its child rows remain present', async () => {
  await scoped(() => prisma.product.update({ where: { id: state.d.familyId }, data: { deletedAt: new Date() } }))
  await run()
  expect(state.remote.status).toBe('ARCHIVED')
  expect(state.stock).toHaveLength(2)
  expect((await rows()).every(r => (r.platformAttributes as any).shopifyColourRetired && r.externalListingId === '1')).toBe(true)
})
it('syncs status and stock for a colour with only a Default Title variant', async () => {
  const first = state.family.variants[0]
  state.family.axes = [{ code: 'color', label: 'Color' }]
  state.family.variants = [first]
  state.sizes = ['S']
  state.remote.options = [{ id: 'gid://shopify/ProductOption/1', name: 'Title', values: ['Default Title'] }]
  state.remote.variants.nodes = [{ ...state.remote.variants.nodes[0], selectedOptions: [{ name: 'Title', value: 'Default Title' }] }]
  await scoped(() => prisma.channelListing.deleteMany({ where: { channelConnectionId: state.d.accountId, productId: { not: first.productId } } }))
  await run()
  expect(state.stock).toEqual([first.sku])
  expect(state.calls).toEqual(['NexusColourPublications', 'NexusColourSyncRead'])
  expect((await rows())[0]).toMatchObject({ isPublished: true, platformAttributes: { variantId: '1' } })
})
