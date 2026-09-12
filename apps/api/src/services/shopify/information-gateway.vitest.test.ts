import { describe, expect, it, vi } from 'vitest'
import { advanceMediaOrder, applyNativeEdit, readInformation, readInformationMedia, readInformationNativeOwners, verifyInformationPlan } from './information-gateway.js'
import { emptyShopifyLinkedDraft } from '@nexus/shared/shopify-linked-products'
const pid = 'gid://shopify/Product/1', vid = 'gid://shopify/ProductVariant/11'
const ids = [1, 2, 3, 4].map(n => `gid://shopify/MediaImage/${n}`)
const mediaEdit = { productId: pid, ownerLabel: 'MOSS', value: ids, nextValue: [ids[2], ids[0], ids[1], ids[3]] }
function gateway() {
  let order = [...ids], jobDone = false, price = '20.00', title = 'MOSS', taxable = false
  const page = (nodes: unknown[]) => ({ nodes, pageInfo: { hasNextPage: false, endCursor: null } })
  const gql = vi.fn(async (query: string, vars?: Record<string, any>): Promise<any> => {
    if (query.includes('NexusInformationNativeOwners')) return { nodes: vars?.ids.map((id: string) => id.includes('/ProductVariant/') ? { id, product: { id: pid }, price, compareAtPrice: null, taxable, inventoryPolicy: 'DENY', inventoryItem: { sku: '001-S', requiresShipping: true, harmonizedSystemCode: '001234' } } : { id, title, descriptionHtml: '', tags: [], vendor: 'Xavia', productType: 'Jacket', seo: { title: null, description: null } }) }
    if (query.includes('NexusInformationContext')) return { shop: { currencyCode: 'EUR', ianaTimezone: 'Europe/Rome' } }
    if (query.includes('NexusInformationProductUpdate')) { if (vars?.product.title) title = vars.product.title; return { productUpdate: { product: { id: pid }, userErrors: [] } } }
    if (query.includes('NexusInformationVariantUpdate')) { const v = vars?.variants[0]; if (v.price !== undefined) price = v.price; if (v.taxable !== undefined) taxable = v.taxable; return { productVariantsBulkUpdate: { productVariants: [{ id: vid }], userErrors: [] } } }
    if (query.includes('NexusInformationProduct(')) return { product: { id: pid, title, descriptionHtml: '<p>Full description</p>', tags: [], vendor: 'Xavia', productType: 'Jacket', status: 'DRAFT', handle: 'moss', seo: { title: null, description: null } } }
    if (query.includes('NexusLinkedOwner(')) return { node: { id: pid, title, metafields: page([]) } }
    if (query.includes('NexusLinkedOwnerVariants')) return { product: { variants: page([{ id: vid, title: 'S', sku: '001-S' }]) } }
    if (query.includes('NexusInformationVariants')) return { product: { variants: page([{ id: vid, title: 'S', price, compareAtPrice: null, barcode: '001', taxable, inventoryPolicy: 'DENY', inventoryItem: { sku: '001-S', tracked: true, requiresShipping: true, harmonizedSystemCode: '001234', countryCodeOfOrigin: 'IT', measurement: { weight: { value: 1, unit: 'KILOGRAMS' } } }, metafields: page([]) }]) } }
    if (query.includes('NexusInformationMedia(')) return { product: { media: page(order.map(id => ({ id, alt: 'View', mediaContentType: 'IMAGE', status: 'READY', preview: { image: { url: `https://cdn.shopify.com/${id.split('/').at(-1)}.png` } } }))) } }
    if (query.includes('NexusInformationReorder')) return { productReorderMedia: { job: { id: 'job-1' }, mediaUserErrors: [] } }
    if (query.includes('NexusInformationMediaJob')) return { job: { id: vars?.id, done: jobDone } }
    throw new Error(`Unexpected query ${query}`)
  })
  return { gql, setOrder: (ids: string[]) => { order = ids }, finish: () => { jobDone = true }, setPrice: (v: string) => { price = v } }
}
describe('Information ownership and patch adapter', () => {
  it('preserves video renditions, external video links and 3D originals', async () => {
    const videoSources = [{ url: 'https://cdn.example/video.webm', mimeType: 'video/webm' }, { url: 'https://cdn.example/video.mp4', mimeType: 'video/mp4' }]
    const gql = vi.fn(async () => ({ product: { media: { nodes: [
      { id: 'video', mediaContentType: 'VIDEO', status: 'READY', sources: videoSources },
      { id: 'external', mediaContentType: 'EXTERNAL_VIDEO', status: 'READY', embeddedUrl: 'https://video.example/watch/1' },
      { id: 'model', mediaContentType: 'MODEL_3D', status: 'READY', sources: [{ url: 'https://cdn.example/model.glb', mimeType: 'model/gltf-binary' }] },
    ], pageInfo: { hasNextPage: false, endCursor: null } } } }))
    const media = await readInformationMedia(gql, pid)
    expect(media[0]).toMatchObject({ type: 'VIDEO', preview: null, url: videoSources[1].url, sources: videoSources })
    expect(media[1].url).toBe('https://video.example/watch/1')
    expect(media[2].url).toBe('https://cdn.example/model.glb')
  })
  it('reads native product and variant fields with store context, preserving zeros and false', async () => {
    const g = gateway(), info = await readInformation(g.gql, [pid])
    expect(info.currency).toBe('EUR'); expect(info.timezone).toBe('Europe/Rome')
    expect(info.rows.map(r => r.kind)).toEqual(['PRODUCT', 'PRODUCTVARIANT'])
    expect(info.rows[1].values).toMatchObject({ sku: '001-S', taxable: 'false', harmonizedSystemCode: '001234' })
  })
  it('rejects malformed product IDs before remote access', async () => {
    const g = gateway(); await expect(readInformation(g.gql, [vid])).rejects.toThrow(); expect(g.gql).not.toHaveBeenCalled()
  })
  it('keeps the recorded Online Store publish date distinct from a future schedule', async () => {
    const g = gateway()
    const gql: typeof g.gql = vi.fn(async (query, variables) => {
      if (query.includes('NexusInformationPublications')) return { product: { resourcePublicationsV2: { nodes: [{ isPublished: false, publishDate: '2030-01-01T00:00:00Z', publication: { id: 'gid://shopify/Publication/1' } }], pageInfo: { hasNextPage: false } } } }
      const result = await g.gql(query, variables)
      if (query.includes('NexusInformationProduct(')) result.product.publishedAt = '2020-01-01T00:00:00Z'
      return result
    })
    const info = await readInformation(gql, [pid], { publications: [] } as any)
    expect(info.rows[0].values).toMatchObject({ scheduled: 'true', publishDate: '2020-01-01T00:00:00Z' })
  })
  it('applies only the selected variant price and verifies its remote value', async () => {
    const g = gateway()
    await applyNativeEdit(g.gql, { ownerId: vid, productId: pid, ownerLabel: 'MOSS / S', field: 'price', value: '20.00', nextValue: '0.00' })
    expect(g.gql.mock.calls.find(c => c[0].includes('mutation'))?.[1]).toEqual({ id: pid, variants: [{ id: vid, price: '0.00' }] })
    expect(g.gql.mock.calls).toHaveLength(3)
    expect(g.gql.mock.calls.some(c => /NexusInformation(Context|Variants|Media\()/.test(c[0]))).toBe(false)
  })
  it('batches scalar baseline reads and verifies parent identity without loading child matrices', async () => {
    const g = gateway(), owners = Array.from({ length: 121 }, (_, i) => `gid://shopify/ProductVariant/${i + 1}`)
    const rows = await readInformationNativeOwners(g.gql, owners)
    expect(rows).toHaveLength(121)
    expect(g.gql.mock.calls.map(c => c[1]?.ids.length)).toEqual([50, 50, 21])
    await expect(applyNativeEdit(g.gql, { ownerId: vid, productId: 'gid://shopify/Product/99', ownerLabel: 'Wrong parent', field: 'price', value: '20.00', nextValue: '5.00' })).rejects.toThrow(/owner/)
    expect(g.gql.mock.calls.some(c => c[0].includes('mutation'))).toBe(false)
  })
  it('reconciles an already applied change without another mutation', async () => {
    const g = gateway(); g.setPrice('0.00')
    await applyNativeEdit(g.gql, { ownerId: vid, productId: pid, ownerLabel: 'MOSS / S', field: 'price', value: '20.00', nextValue: '0.00' })
    expect(g.gql.mock.calls.some(c => c[0].includes('mutation'))).toBe(false)
  })
  it('rejects stale changes and wrong variant ownership', async () => {
    const g = gateway(), edit = { ownerId: vid, productId: pid, ownerLabel: 'MOSS / S', field: 'price' as const, value: '19.00', nextValue: '0.00' }
    await expect(applyNativeEdit(g.gql, edit)).rejects.toThrow(/changed/)
    await expect(applyNativeEdit(g.gql, { ...edit, ownerId: pid })).rejects.toThrow()
    expect(g.gql.mock.calls.some(c => c[0].includes('mutation'))).toBe(false)
  })
  it('checks media order at review before accepting a synchronization plan', async () => {
    const g = gateway(); g.setOrder([...ids].reverse())
    await expect(verifyInformationPlan(g.gql, { ...emptyShopifyLinkedDraft(), mediaEdits: [mediaEdit] })).rejects.toThrow(/gallery changed/)
  })
})
describe('Media submission, completion and reconciliation are distinct', () => {
  it('persists submitting before the request and then its job; returns pending', async () => {
    const g = gateway(), checkpoint = vi.fn(async () => {})
    expect(await advanceMediaOrder(g.gql, mediaEdit, undefined, checkpoint)).toBe(false)
    expect(checkpoint.mock.calls).toEqual([[{ submitted: true }], [{ submitted: true, jobId: 'job-1' }]])
    const mutation = g.gql.mock.calls.find(c => c[0].startsWith('mutation'))
    expect(mutation?.[1]?.moves).toEqual([{ id: ids[2], newPosition: '0' }])
    expect(checkpoint.mock.invocationCallOrder[0]).toBeLessThan(g.gql.mock.invocationCallOrder[g.gql.mock.calls.findIndex(c => c[0].startsWith('mutation'))])
  })
  it('does not claim synchronization while a job is running, even if order already looks right', async () => {
    const g = gateway(); g.setOrder(mediaEdit.nextValue)
    expect(await advanceMediaOrder(g.gql, mediaEdit, { submitted: true, jobId: 'job-1' }, async () => {})).toBe(false)
  })
  it('requires completed job AND exact final order', async () => {
    const g = gateway(); g.finish()
    await expect(advanceMediaOrder(g.gql, mediaEdit, { submitted: true, jobId: 'job-1' }, async () => {})).rejects.toThrow(/different result/)
    g.setOrder(mediaEdit.nextValue)
    expect(await advanceMediaOrder(g.gql, mediaEdit, { submitted: true, jobId: 'job-1' }, async () => {})).toBe(true)
  })
  it('never resubmits an unknown acknowledgement; exact readback can resolve it', async () => {
    const g = gateway()
    await expect(advanceMediaOrder(g.gql, mediaEdit, { submitted: true }, async () => {})).rejects.toThrow(/uncertain/)
    g.setOrder(mediaEdit.nextValue)
    expect(await advanceMediaOrder(g.gql, mediaEdit, { submitted: true }, async () => {})).toBe(true)
    expect(g.gql.mock.calls.some(c => c[0].startsWith('mutation'))).toBe(false)
  })
  it('refuses external membership changes without removing anything', async () => {
    const g = gateway(); g.setOrder(ids.slice(1))
    await expect(advanceMediaOrder(g.gql, mediaEdit, undefined, async () => {})).rejects.toThrow(/gallery changed/)
    expect(g.gql.mock.calls.some(c => c[0].startsWith('mutation'))).toBe(false)
  })
  it('surfaces mediaUserErrors and retains an uncertain checkpoint', async () => {
    const g = gateway(), checkpoint = vi.fn(async () => {})
    const original = g.gql.getMockImplementation()!
    g.gql.mockImplementation(async (q, v) => q.startsWith('mutation') ? { productReorderMedia: { job: null, mediaUserErrors: [{ message: 'Permission denied' }] } } : original(q, v))
    await expect(advanceMediaOrder(g.gql, mediaEdit, undefined, checkpoint)).rejects.toThrow(/Permission denied/)
    expect(checkpoint).toHaveBeenCalledTimes(1)
  })
})
