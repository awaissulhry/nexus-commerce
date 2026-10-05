import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PRODUCT_MEDIA_KEY } from '@nexus/shared/product-media'

/**
 * Review 2026-10-05 (finding 11) — Claude's remove-unused-photo asks `photoInUse` first. A photo a listing's Product media
 * names (any channel, any row of the family, any language) is in use: removed, that listing's Publish would refuse "a
 * saved gallery file is missing". So is a photo a product's own saved list names (the main product or a row, any
 * language): every listing that follows that list would lose it. Real schema and tenant policies (PGlite); nothing is
 * fetched or stored.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
// The live events reach Redis; nothing here sends one (no photo is added or removed).
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { photoHome, photoInUse } from './photo-from-url.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const gallery = (locale: string, ...assetIds: string[]) => ({ [locale]: { [PRODUCT_MEDIA_KEY]: { version: 1, items: assetIds.map(assetId => ({ assetId })) } } })

beforeAll(async () => {
  await scoped(async () => {
    const product = async (sku: string, parentId?: string) => (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, ...(parentId ? { parentId } : { isParent: true }) } as never })).id
    const photo = async (productId: string, name: string) => (await prisma.productImage.create({ data: { productId, url: `https://cdn.example/${name}.jpg`, type: 'ALT' } as never })).id
    const listing = (productId: string, channel: string, platformAttributes: unknown) => prisma.channelListing.create({ data: {
      productId, channel, marketplace: 'IT', channelMarket: `${channel}_IT`, region: 'IT', platformAttributes } as never })
    ids.root = await product('USE'); ids.row = await product('USE-NERO', ids.root); ids.other = await product('OTHER')
    ids.onRootUsedByRow = await photo(ids.root, 'root-used'); ids.onRootFree = await photo(ids.root, 'root-free')
    ids.onRowUsed = await photo(ids.row, 'row-used'); ids.onOtherFamilyOnly = await photo(ids.root, 'named-elsewhere')
    ids.inRowList = await photo(ids.root, 'in-row-list'); ids.inRootList = await photo(ids.root, 'in-root-list')
    // Saved lists of the products themselves: the row's French list, the main product's all-languages list; another
    // family's product list naming this family's photo does not count either.
    await prisma.product.update({ where: { id: ids.row }, data: { localizedContent: { it: { title: 'Nero' }, ...gallery('fr', ids.inRowList) } } })
    await prisma.product.update({ where: { id: ids.root }, data: { localizedContent: gallery('und', ids.inRootList) } })
    await prisma.product.update({ where: { id: ids.other }, data: { localizedContent: gallery('und', ids.onOtherFamilyOnly) } })
    // A colour row's eBay listing names a main-product photo in German only; its Etsy listing names its own photo.
    await listing(ids.row, 'EBAY', { title: 'x', _productMediaLocales: { ...gallery('it'), ...gallery('de', ids.onRootUsedByRow) } })
    await listing(ids.row, 'ETSY', { _productMediaLocales: gallery('und', ids.onRowUsed) })
    // Another family's listing naming this family's photo cannot use it (its editor reads its own family's files only).
    await listing(ids.other, 'EBAY', { _productMediaLocales: gallery('und', ids.onOtherFamilyOnly) })
    // An old Image URLs list or a listing without Product media names no photo by id.
    await listing(ids.root, 'EBAY', { imageUrls: ['https://cdn.example/root-free.jpg'] })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

describe('photoInUse counts a listing\'s Product media', () => {
  it('a photo of the main product named by a colour row\'s eBay listing, in one language, is in use', async () => {
    const home = (await scoped(() => photoHome(ids.root)))!
    expect(await scoped(() => photoInUse(home, ids.onRootUsedByRow))).toBe('a listing\'s Product media uses it (EBAY IT); take it out of that listing\'s photos first')
  })
  it('a row\'s own photo named by any channel\'s listing is in use', async () => {
    const home = (await scoped(() => photoHome(ids.row)))!
    expect(await scoped(() => photoInUse(home, ids.onRowUsed))).toMatch(/Product media uses it \(ETSY IT\)/)
  })
  it('a photo a product\'s own saved list names (a row\'s, in one language, or the main product\'s) is in use', async () => {
    const home = (await scoped(() => photoHome(ids.root)))!
    expect(await scoped(() => photoInUse(home, ids.inRowList))).toBe('a product\'s own Product media uses it (USE-NERO); take it out of that product\'s photos first')
    expect(await scoped(() => photoInUse(home, ids.inRootList))).toMatch(/own Product media uses it \(USE\)/)
  })
  it('a photo no listing or product of the family names stays removable; the earlier checks still answer first', async () => {
    const home = (await scoped(() => photoHome(ids.root)))!
    expect(await scoped(() => photoInUse(home, ids.onRootFree))).toBeNull()
    expect(await scoped(() => photoInUse(home, ids.onOtherFamilyOnly))).toBeNull()
    expect(await scoped(() => photoInUse(home, ids.onRowUsed))).toBe('it is not one of this product\'s photos')
  })
})
