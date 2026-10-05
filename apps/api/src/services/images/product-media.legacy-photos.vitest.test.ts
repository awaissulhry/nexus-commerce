import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { PRODUCT_MEDIA_KEY } from '@nexus/shared/product-media'

/**
 * Owner 2026-10-05 — Product media is the one photo source of an eBay listing; one list at a time, the last save wins.
 * An eBay listing that still holds an old Image URLs list (and no Product media) shows THAT list in the editor, with the
 * sheet cell's ids; a save adds its other addresses to the family's library and removes the old list; a reset removes it
 * too; a copy carries it. Real schema and tenant policies (PGlite); the destination check is the one stand-in.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
// The destination rules (markets, accounts, aliases) are tested with workspace-destination; here every listing is valid.
vi.mock('../pim/workspace-destination.js', async original => ({ ...await original<object>(),
  resolveWorkspaceDestination: async (input: { productId: string; listingId?: string }) => ({ listing: input.listingId ? { productId: input.productId } : null }) }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { copyProductMedia, readProductMedia, saveProductMedia } from './product-media.service.js'
import { legacyPhotoId } from './listing-photos.pure.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
let ebay = '', etsy = ''
const cloud = (name: string, size = '') => `https://res.cloudinary.com/fake-cloud/image/upload/${size}v1700000000/fake/${name}.jpg`

/** A family (root + one colour row) with its own files, an eBay IT listing on the colour row holding `imageUrls`. */
async function family(tag: string, imageUrls: string[], channel: 'EBAY' | 'ETSY' = 'EBAY') {
  return scoped(async () => {
    const root = (await prisma.product.create({ data: { sku: `${tag}`, name: tag, basePrice: 10, isParent: true } as never })).id
    const row = (await prisma.product.create({ data: { sku: `${tag}-NERO`, name: `${tag} nero`, basePrice: 10, parentId: root } as never })).id
    const file = async (productId: string, url: string, sortOrder: number) => (await prisma.productImage.create({ data: { productId, url, type: 'ALT', sortOrder, alt: url.split('/').pop() } as never })).id
    const files = { front: await file(root, cloud(`${tag}-front`), 0), back: await file(root, `https://cdn.example/${tag}/back.jpg`, 1),
      shared: await file(root, `https://cdn.example/${tag}/shared.jpg`, 2), own: await file(row, `https://cdn.example/${tag}/own.jpg`, 0),
      ownShared: await file(row, `https://cdn.example/${tag}/shared.jpg`, 1) }
    const listing = (await prisma.channelListing.create({ data: { productId: row, channel, marketplace: 'IT', channelMarket: `${channel}_IT`, region: 'IT',
      channelConnectionId: channel === 'EBAY' ? ebay : etsy, platformAttributes: { title: `${tag} title`, imageUrls } } as never })).id
    const input = { productId: row, scope: channel, market: 'IT', locale: 'it', accountId: channel === 'EBAY' ? ebay : etsy, listingId: listing }
    return { root, row, files, listing, input }
  })
}
const outside = (tag: string, n: number) => `https://cdn.example/${tag}/outside-${n}.jpg`
const attributes = (id: string) => scoped(async () => (await prisma.channelListing.findUniqueOrThrow({ where: { id }, select: { platformAttributes: true } })).platformAttributes as Record<string, any>)
const filesOf = (productId: string) => scoped(() => prisma.productImage.findMany({ where: { productId }, orderBy: [{ sortOrder: 'asc' }, { id: 'asc' }], select: { id: true, url: true } }))

beforeAll(async () => {
  await scoped(async () => {
    ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Fake eBay', isActive: true, externalAccountId: 'FAKE-SELLER', region: 'IT' } as never })).id
    etsy = (await prisma.channelConnection.create({ data: { channelType: 'ETSY', accountLabel: 'Fake Etsy', isActive: true, externalAccountId: 'FAKE-SHOP' } as never })).id
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

describe('the editor shows an eBay listing\'s old Image URLs list', () => {
  it('a library photo by its id (own files first, the same Cloudinary photo at another size), any other address by its url: id', async () => {
    const tag = 'LEGA'
    const f = await family(tag, [`https://cdn.example/${tag}/shared.jpg`, cloud(`${tag}-front`, 'w_800,c_fill/'), outside(tag, 1), ` ${outside(tag, 1)} `, outside(tag, 2)])
    const read = await scoped(() => readProductMedia(f.input))
    expect(read.collection.items).toEqual([{ assetId: f.files.ownShared }, { assetId: f.files.front }, { assetId: legacyPhotoId(outside(tag, 1)) }, { assetId: legacyPhotoId(outside(tag, 2)) }])
    expect(read).toMatchObject({ source: 'locale', hasOverride: true, missingAssetIds: [] })
    expect(read.assets.filter(asset => asset.id.startsWith('url:'))).toEqual([1, 2].map(n => ({ id: legacyPhotoId(outside(tag, n)), type: 'IMAGE', url: outside(tag, n), preview: outside(tag, n), alt: '' })))
    // Every language shows it: the old list has no language.
    expect((await scoped(() => readProductMedia({ ...f.input, locale: 'de' }))).collection.items).toEqual(read.collection.items)
  })

  it('an empty old list is an empty gallery; a listing with Product media saved, or on another channel, reads as before', async () => {
    const empty = await family('LEGB', [])
    expect((await scoped(() => readProductMedia(empty.input))).collection.items).toEqual([])
    const etsyRow = await family('LEGC', [outside('LEGC', 1)], 'ETSY')
    const read = await scoped(() => readProductMedia(etsyRow.input))
    expect(read.collection.items.some(item => item.assetId.startsWith('url:'))).toBe(false)
    expect(read.hasOverride).toBe(false)
  })
})

describe('a save replaces the old list (last save wins)', () => {
  it('adds the kept addresses to the family library, saves their new ids, removes imageUrls and keeps every other field', async () => {
    const tag = 'LEGD'
    const f = await family(tag, [`https://cdn.example/${tag}/own.jpg`, outside(tag, 1), outside(tag, 2)])
    const before = await scoped(() => readProductMedia(f.input))
    const rootBefore = await scoped(() => readProductMedia({ productId: f.root, scope: 'MASTER', market: 'GLOBAL', locale: 'it' }))
    const saved = await scoped(() => saveProductMedia(f.input, { expectedRevision: before.revision,
      collection: { version: 1, items: [{ assetId: legacyPhotoId(outside(tag, 2)), alt: 'Side' }, { assetId: f.files.own }] } }))
    const rootFiles = await filesOf(f.root)
    const added = rootFiles.find(file => file.url === outside(tag, 2))!
    expect(added).toBeDefined()
    expect(rootFiles.some(file => file.url === outside(tag, 1))).toBe(false)
    expect(saved.collection.items).toEqual([{ assetId: added.id, alt: 'Side' }, { assetId: f.files.own }])
    expect(saved).toMatchObject({ source: 'locale', hasOverride: true, missingAssetIds: [] })
    expect(saved.assets.some(asset => asset.id.startsWith('url:'))).toBe(false)
    const pa = await attributes(f.listing)
    expect(pa.imageUrls).toBeUndefined()
    expect(pa.title).toBe(`${tag} title`)
    expect(pa._productMediaLocales.it[PRODUCT_MEDIA_KEY].items.map((item: { assetId: string }) => item.assetId)).toEqual([added.id, f.files.own])
    // The family's own list does not change when its library grows (pinned before the photo was added).
    expect((await scoped(() => readProductMedia({ productId: f.root, scope: 'MASTER', market: 'GLOBAL', locale: 'it' }))).collection.items).toEqual(rootBefore.collection.items)
  })

  it('a stale editor is refused and writes nothing; an address the list no longer holds is refused', async () => {
    const tag = 'LEGE'
    const f = await family(tag, [outside(tag, 1)])
    const before = await scoped(() => readProductMedia(f.input))
    await scoped(() => prisma.channelListing.update({ where: { id: f.listing }, data: { platformAttributes: { title: `${tag} title`, imageUrls: [outside(tag, 1), outside(tag, 2)] } } }))
    await expect(scoped(() => saveProductMedia(f.input, { expectedRevision: before.revision, collection: { version: 1, items: [{ assetId: legacyPhotoId(outside(tag, 1)) }] } })))
      .rejects.toThrow(/Media changed since this editor opened/)
    const now = await scoped(() => readProductMedia(f.input))
    await expect(scoped(() => saveProductMedia(f.input, { expectedRevision: now.revision, collection: { version: 1, items: [{ assetId: legacyPhotoId(outside(tag, 3)) }] } })))
      .rejects.toThrow(/no longer in this product’s media library/)
    expect((await filesOf(f.root)).some(file => file.url.includes('outside'))).toBe(false)
    expect((await attributes(f.listing)).imageUrls).toEqual([outside(tag, 1), outside(tag, 2)])
  })

  it('a reset removes the old list too: the listing follows the shared list again', async () => {
    const tag = 'LEGF'
    const f = await family(tag, [outside(tag, 1)])
    const before = await scoped(() => readProductMedia(f.input))
    const reset = await scoped(() => saveProductMedia(f.input, { expectedRevision: before.revision, collection: null }))
    expect(reset).toMatchObject({ source: 'shared', hasOverride: false })
    expect(reset.collection.items.map(item => item.assetId)).toEqual([f.files.own, f.files.ownShared])
    expect((await attributes(f.listing)).imageUrls).toBeUndefined()
    expect((await filesOf(f.root)).some(file => file.url.includes('outside'))).toBe(false)
  })

  it('another channel\'s listing keeps its imageUrls on a save', async () => {
    const f = await family('LEGG', [outside('LEGG', 1)], 'ETSY')
    const before = await scoped(() => readProductMedia(f.input))
    await scoped(() => saveProductMedia(f.input, { expectedRevision: before.revision, collection: { version: 1, items: [{ assetId: f.files.own }] } }))
    expect((await attributes(f.listing)).imageUrls).toEqual([outside('LEGG', 1)])
  })
})

describe('a copy carries an old list', () => {
  it('from an eBay listing with an old list onto another eBay listing with one: by address, and the target\'s old list is removed', async () => {
    const source = await family('LEGH', [`https://cdn.example/LEGH/own.jpg`, outside('LEGH', 1), cloud('LEGI-front', 'w_500/')])
    const target = await family('LEGI', [outside('LEGI', 9)])
    const from = await scoped(() => readProductMedia(source.input)), to = await scoped(() => readProductMedia(target.input))
    const copied = await scoped(() => copyProductMedia(target.input, { expectedRevision: to.revision,
      source: { productId: source.row, context: { scope: 'EBAY', market: 'IT', locale: 'it', accountId: ebay, listingId: source.listing }, expectedRevision: from.revision } }))
    const targetFiles = await filesOf(target.row)
    const byUrl = (url: string) => targetFiles.find(file => file.url === url)?.id
    // The source's library photo and its outside address become target files; the target's own Cloudinary photo is reused.
    expect(copied.collection.items.map(item => item.assetId)).toEqual([byUrl('https://cdn.example/LEGH/own.jpg'), byUrl(outside('LEGH', 1)), target.files.front])
    expect(copied.missingAssetIds).toEqual([])
    expect((await attributes(target.listing)).imageUrls).toBeUndefined()
    // The source keeps its old list: a copy reads it, never changes it.
    expect((await attributes(source.listing)).imageUrls).toHaveLength(3)
  })
})
