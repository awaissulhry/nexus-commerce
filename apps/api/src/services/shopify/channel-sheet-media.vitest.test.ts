import { beforeEach, describe, expect, it, vi } from 'vitest'
import { parse } from 'graphql'
import { writeMediaCollection } from '@nexus/shared/product-media'
import type { ShopifyStoreSchema, ShopifySheetGallery } from '@nexus/shared/shopify-linked-products'
vi.mock('../../db.js', () => ({ default: {} }))
import { readSheetGallerySources, reviewSheetGalleries, advanceSheetGallery, verifySheetGallery, SHEET_MEDIA_SYNC, type SheetGalleryProgress } from './channel-sheet-media.js'

const productId = 'gid://shopify/Product/10', variantId = 'gid://shopify/ProductVariant/11', oldId = 'gid://shopify/MediaImage/1'
const destination = { familyId: 'family', productId: 'family', accountId: 'store-a', aliasKey: 'alias-a', marketplace: 'GLOBAL' } as any
const schema = { locales: [{ locale: 'en', primary: true }, { locale: 'fr', primary: false }], native: { scopes: ['write_files', 'write_products', 'write_translations'] } } as ShopifyStoreSchema
let listings: any[], products: any[], files: any[], calls: any[], media: any[], variant: string[], uploaded: Map<string, any>, loseAssociation: boolean, failFile: boolean, jobDone: boolean
const connection = (nodes: any[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
const tx = { product: { findMany: vi.fn(async () => products) }, channelListing: { findMany: vi.fn(async () => listings) }, productImage: { findMany: vi.fn(async () => files) } } as any
beforeEach(() => {
  products = [{ id: 'family', parentId: null, name: 'Family', localizedContent: {} }, { id: 'child', parentId: 'family', name: 'Child', localizedContent: {} }]
  files = [{ id: 'asset', productId: 'family', url: 'https://example.test/a.jpg', alt: 'Base alt', mediaType: 'IMAGE' }]
  listings = [{ id: 'listing-a', productId: 'family', externalListingId: '10', platformAttributes: { _productMediaLocales: writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'asset', alt: '' }] }) } }]
  calls = []; media = [{ id: oldId, alt: 'Old', mediaContentType: 'IMAGE', status: 'READY' }]; variant = [oldId]; uploaded = new Map(); loseAssociation = false; failFile = false; jobDone = true
  vi.clearAllMocks()
})
async function gql(query: string, variables: any = {}): Promise<any> {
  parse(query); const name = query.match(/(?:query|mutation)\s+(\w+)/)![1]; calls.push({ name, variables })
  if (name === 'NexusInformationMedia') return { product: { media: connection(structuredClone(media)) } }
  if (name === 'NexusInformationMediaVariants') return { product: { variants: connection([{ id: variantId, title: 'Child', media: connection(variant.map(id => ({ id }))) }]) } }
  if (name === 'NexusSheetVariantMedia') return { productVariant: { id: variantId, product: { id: productId }, media: connection(variant.map(id => ({ id }))) } }
  if (name === 'NexusImage') return { files: { nodes: uploaded.has(variables.query.replace('filename:', '')) ? [uploaded.get(variables.query.replace('filename:', ''))] : [] } }
  if (name === 'NexusImageCreate') {
    const input = variables.files[0], file = { id: `gid://shopify/MediaImage/${uploaded.size + 20}`, fileStatus: 'READY', alt: input.alt, mediaContentType: 'IMAGE', status: 'READY' }
    uploaded.set(input.filename, file)
    if (failFile) { failFile = false; throw new Error('Lost file acknowledgement') }
    return { fileCreate: { files: [file], userErrors: [] } }
  }
  if (name === 'NexusInformationFileReferences') {
    for (const file of variables.files) {
      if (file.referencesToAdd) { expect(file.referencesToAdd).toEqual([productId]); media.push([...uploaded.values()].find(f => f.id === file.id)!) }
      if (file.referencesToRemove) { expect(file.referencesToRemove).toEqual([productId]); media = media.filter(f => f.id !== file.id); variant = variant.filter(id => id !== file.id) }
    }
    if (loseAssociation) { loseAssociation = false; throw new Error('Lost association acknowledgement') }
    return { fileUpdate: { userErrors: [], files: [] } }
  }
  if (name === 'NexusInformationReorder') { for (const move of variables.moves) { const index = media.findIndex(m => m.id === move.id), [item] = media.splice(index, 1); media.splice(Number(move.newPosition), 0, item) }; return { productReorderMedia: { job: { id: 'job-1' }, mediaUserErrors: [] } } }
  if (name === 'NexusInformationMediaJob') return { job: { id: 'job-1', done: jobDone } }
  if (name === 'NexusSheetVariantDetach') { variant = variant.filter(id => !variables.media[0].mediaIds.includes(id)); return { productVariantDetachMedia: { userErrors: [] } } }
  if (name === 'NexusSheetVariantAppend') { expect(variables.id).toBe(productId); expect(variables.media[0].variantId).toBe(variantId); variant = [...variables.media[0].mediaIds]; return { productVariantAppendMedia: { userErrors: [] } } }
  throw new Error(`Unexpected operation ${name}`)
}
async function plan() { const source = await readSheetGallerySources(tx, destination, schema); return { ...source, galleries: await reviewSheetGalleries(gql, source.galleries, schema) } }
describe('common Shopify gallery persistence and narrow synchronization', () => {
  it('resolves exact account, alias, owner and empty alt without uploading during review', async () => {
    const review = await plan()
    expect(tx.channelListing.findMany.mock.calls[0][0].where).toMatchObject({ channelConnectionId: 'store-a', aliasKey: 'alias-a', marketplace: 'GLOBAL' })
    expect(review.galleries[0]).toMatchObject({ listingId: 'listing-a', productId, nexusProductId: 'family', assets: [{ id: 'asset', alt: '' }], value: [oldId], affectedVariants: [{ id: variantId }] })
    expect(calls.some(c => /Create|References|Reorder/.test(c.name))).toBe(false)
    listings[0].platformAttributes[SHEET_MEDIA_SYNC] = { signature: review.galleries[0].signature }
    expect((await plan()).galleries).toHaveLength(0)
    listings[0].platformAttributes._productMediaLocales = writeMediaCollection({}, 'en', null)
    expect((await plan()).galleries[0].assets[0].alt).toBe('Base alt')
  })
  it('checks unknown files, store permissions and language membership even for empty galleries', async () => {
    listings[0].platformAttributes._productMediaLocales = writeMediaCollection(listings[0].platformAttributes._productMediaLocales, 'fr', { version: 1, items: [] })
    await expect(plan()).rejects.toThrow('across languages')
    listings[0].platformAttributes._productMediaLocales = writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'foreign' }] })
    await expect(plan()).rejects.toThrow('library')
    await expect(reviewSheetGalleries(gql, [{} as ShopifySheetGallery], { ...schema, native: { ...schema.native!, scopes: ['write_products'] } })).rejects.toThrow('write_files')
  })
  it('preserves captions/transcripts as Nexus metadata and explicitly reviews the native restriction', async () => {
    listings[0].platformAttributes._productMediaLocales = writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'asset', transcript: '', captions: [{ language: 'en', label: 'English', url: 'https://example.test/a.vtt' }] }] })
    expect((await plan()).warnings[0]).toContain('captions and transcripts remain in Nexus')
  })
  it('reconciles lost upload and association acknowledgements without duplicating files', async () => {
    const gallery = (await plan()).galleries[0]
    let state: SheetGalleryProgress | undefined
    const checkpoint = async (next: SheetGalleryProgress) => { state = structuredClone(next) }
    failFile = true
    await expect(advanceSheetGallery(gql, gallery, state, checkpoint)).rejects.toThrow('Lost file')
    loseAssociation = true
    await expect(advanceSheetGallery(gql, gallery, state, checkpoint)).rejects.toThrow('Lost association')
    expect(await advanceSheetGallery(gql, gallery, state, checkpoint)).toBe(true)
    await verifySheetGallery(gql, gallery, state!)
    expect(calls.filter(c => c.name === 'NexusImageCreate')).toHaveLength(1)
    expect(media.map(m => m.id)).toEqual(['gid://shopify/MediaImage/20'])
    expect(variant).toEqual([]) // Explicitly reviewed affected variant.
  })
  it('rejects external changes after review without writing associations', async () => {
    const gallery = (await plan()).galleries[0]
    media.push({ ...media[0], id: 'gid://shopify/MediaImage/9' })
    await expect(advanceSheetGallery(gql, gallery, undefined, async () => {})).rejects.toThrow('changed after review')
    expect(calls.some(c => c.name === 'NexusImageCreate' || c.name === 'NexusInformationFileReferences')).toBe(false)
  })
  it('keeps an accepted reorder job pending until job completion and final readback', async () => {
    files.push({ ...files[0], id: 'asset-2', url: 'https://example.test/b.jpg' })
    const setItems = (ids: string[]) => { listings[0].platformAttributes._productMediaLocales = writeMediaCollection({}, 'en', { version: 1, items: ids.map(assetId => ({ assetId })) }) }
    setItems(['asset', 'asset-2'])
    let state: SheetGalleryProgress | undefined
    await advanceSheetGallery(gql, (await plan()).galleries[0], state, async next => { state = structuredClone(next) })
    setItems(['asset-2', 'asset'])
    const gallery = (await plan()).galleries[0]; state = undefined
    const checkpoint = async (next: SheetGalleryProgress) => { state = structuredClone(next) }
    jobDone = false
    expect(await advanceSheetGallery(gql, gallery, state, checkpoint)).toBe(false)
    expect(state?.order).toEqual({ submitted: true, jobId: 'job-1' })
    expect(await advanceSheetGallery(gql, gallery, state, checkpoint)).toBe(false)
    jobDone = true
    expect(await advanceSheetGallery(gql, gallery, state, checkpoint)).toBe(true)
    await verifySheetGallery(gql, gallery, state!)
    expect(calls.filter(c => c.name === 'NexusInformationReorder')).toHaveLength(1)
  })
  it('writes one exact variant image and keeps other product attachments', async () => {
    listings[0].platformAttributes = { _nexusContentPublish: { variantIds: { child: variantId } } }
    listings.push({ id: 'listing-child', productId: 'child', externalListingId: '10', platformAttributes: { _productMediaLocales: writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'asset' }] }) } })
    const gallery = (await plan()).galleries[0]; expect(gallery.variantId).toBe(variantId)
    let state: SheetGalleryProgress | undefined
    expect(await advanceSheetGallery(gql, gallery, state, async next => { state = structuredClone(next) })).toBe(true)
    await verifySheetGallery(gql, gallery, state!)
    expect(media.map(m => m.id)).toEqual([oldId, 'gid://shopify/MediaImage/20'])
    expect(variant).toEqual(['gid://shopify/MediaImage/20'])
    files.push({ ...files[0], id: 'asset-2', url: 'https://example.test/b.jpg' })
    listings[1].platformAttributes._productMediaLocales = writeMediaCollection({}, 'en', { version: 1, items: [{ assetId: 'asset' }, { assetId: 'asset-2' }] })
    await expect(plan()).rejects.toThrow('one image')
  })
})
