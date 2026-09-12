import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash } from 'node:crypto'
const state = vi.hoisted(() => ({ listing: null as any, revision: 'media-source-1', done: false, failVerification: false, checkpoints: [] as any[] }))
const db = vi.hoisted(() => {
  const tx: any = {
    product: { findFirst: async () => ({ id: 'family', name: 'Family', children: [] }) },
    channelListing: {
      findMany: async () => [structuredClone(state.listing)], findFirst: async () => structuredClone(state.listing),
      updateMany: async ({ where, data }: any) => { if (where.version !== state.listing.version) return { count: 0 }; state.listing.platformAttributes = structuredClone(data.platformAttributes); state.listing.version++; return { count: 1 } },
    },
    auditLog: { create: async ({ data }: any) => { state.checkpoints.push(data); return data } },
  }
  tx.$transaction = async (fn: any) => { const prior = structuredClone(state.listing); try { return await fn(tx) } catch (e) { state.listing = prior; throw e } }
  return tx
})
vi.mock('../../db.js', () => ({ default: db }))
vi.mock('./content-workspace.service.js', () => ({ object: (v: unknown) => v ?? {}, PUBLISH_KEY: '_nexusContentPublish', contentDestination: async () => ({ familyId: 'family', productId: 'family', accountId: 'store-a', marketplace: 'GLOBAL', aliasKey: '' }) }))
const schema = vi.hoisted(() => ({ revision: 'schema-1', definitions: [], types: [], locales: [{ locale: 'en', primary: true }] }))
vi.mock('../pim/channel-specs/shopify.js', () => ({ readShopifyMappingSchema: async () => schema }))
vi.mock('./admin-client.js', () => ({ shopifyAdmin: async () => ({ graphql: async () => ({ job: { id: 'job-1', done: state.done } }) }), assertShopifyResult: (v: unknown) => v }))
vi.mock('./linked-products-gateway.js', () => ({
  linkedDigest: (v: unknown) => createHash('sha256').update(JSON.stringify(v)).digest('hex'), readLinkedStoreSchema: async () => schema, readLinkedProducts: async () => [], readLinkedFields: async () => [],
}))
vi.mock('./linked-shared-content.service.js', () => ({ resolveSharedContent: async () => ({ changes: [], sources: [], verification: [] }) }))
vi.mock('./information-gateway.js', () => ({ verifyInformationPlan: async () => ({ nativeEdits: [], mediaEdits: [] }) }))
vi.mock('./channel-sheet-media.js', () => ({
  SHEET_MEDIA_SYNC: '_nexusSheetMediaSync',
  readSheetGallerySources: async () => ({ revision: state.revision, warnings: [], galleries: [{ listingId: 'listing-a', nexusProductId: 'family', productId: 'gid://shopify/Product/10', ownerLabel: 'Family', signature: 'reviewed-gallery', locale: 'en', value: [], assets: [] }] }),
  reviewSheetGalleries: async (_: unknown, galleries: unknown) => galleries,
  advanceSheetGallery: async (_: unknown, gallery: any, previous: any, checkpoint: any) => { await checkpoint({ ...previous, edit: { productId: gallery.productId, value: [], nextValue: [] }, order: { submitted: true, jobId: 'job-1' } }); return state.done },
  verifySheetGallery: async () => { if (state.failVerification) throw new Error('Remote gallery differs') },
}))
import { advanceLinkedSync, beginLinkedSync, getLinkedWorkspace, previewLinkedWorkspace, rebaseLinkedWorkspace } from './linked-products.service.js'
const scope = { accountId: 'store-a', listingId: 'listing-a', market: 'GLOBAL' }
beforeEach(() => {
  state.revision = 'media-source-1'; state.done = false; state.failVerification = false; state.checkpoints = []
  state.listing = { id: 'listing-a', productId: 'family', version: 1, externalListingId: '10', platformAttributes: { _productMediaLocales: { en: { _productMedia: { version: 1, items: [] } } }, _nexusLinkedProducts: { version: 1, informationOnly: true, members: [], relationship: null, baselineLinks: [], edits: [], sheetValues: [{ ownerId: 'gid://shopify/Product/10', fieldId: 'title', type: 'single_line_text_field', locale: '', value: 'A durable pin' }] } } }
})
async function begin() {
  const { workspace, plan } = await previewLinkedWorkspace('family', scope)
  return beginLinkedSync('family', scope, { expectedRevision: workspace.revision, planRevision: plan.revision }, 'MANUAL', 'editor')
}
describe('common gallery inside the durable Shopify job', () => {
  it('persists accepted job progress, retains pins and marks only verified gallery signatures', async () => {
    const begun = await begin()
    expect(begun.operation).toMatchObject({ total: 1, completed: 0, status: 'RUNNING', includesSheetMedia: true })
    const pending = await advanceLinkedSync('family', scope, begun.operation!.id)
    expect(pending.operation?.status).toBe('RUNNING')
    expect(state.listing.platformAttributes._nexusLinkedProductsOperation.sheetGalleryJobs['listing-a'].order.jobId).toBe('job-1')
    expect(state.listing.platformAttributes._nexusSheetMediaSync).toBeUndefined()
    state.done = true
    const verified = await advanceLinkedSync('family', scope, begun.operation!.id)
    expect(verified.operation).toMatchObject({ completed: 1, status: 'VERIFIED' })
    expect(verified.draft.sheetValues?.[0].value).toBe('A durable pin')
    expect(state.listing.platformAttributes._nexusSheetMediaSync.signature).toBe('reviewed-gallery')
    expect(state.checkpoints.at(-1).action).toBe('shopify.sync.verified')
  })
  it('keeps newer Nexus intent and interrupts a stale reviewed gallery', async () => {
    const begun = await begin(); state.revision = 'newer-gallery'
    await expect(advanceLinkedSync('family', scope, begun.operation!.id)).rejects.toThrow('newer draft')
    const current = await getLinkedWorkspace('family', scope)
    expect(current.operation).toMatchObject({ status: 'UNVERIFIED', completed: 0 })
    expect(state.listing.platformAttributes._productMediaLocales.en._productMedia.items).toEqual([])
    expect(state.listing.platformAttributes._nexusSheetMediaSync).toBeUndefined()
  })
  it('does not record completion when final Shopify readback differs', async () => {
    const begun = await begin(); state.done = true; state.failVerification = true
    await expect(advanceLinkedSync('family', scope, begun.operation!.id)).rejects.toThrow('Remote gallery differs')
    expect((await getLinkedWorkspace('family', scope)).operation?.status).toBe('UNVERIFIED')
    expect(state.listing.platformAttributes._nexusSheetMediaSync).toBeUndefined()
  })
  it('does not replace a baseline while its submitted media job can still finish', async () => {
    const begun = await begin()
    const pending = await advanceLinkedSync('family', scope, begun.operation!.id)
    await expect(rebaseLinkedWorkspace('family', scope, pending.revision)).rejects.toThrow('Wait for the submitted Shopify media job')
    expect((await getLinkedWorkspace('family', scope)).operation?.id).toBe(begun.operation!.id)
  })
})
