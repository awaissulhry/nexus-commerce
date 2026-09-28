import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild W4a — the same picture at two addresses, with the real schema, the real tenant policies and the real
 * shared plan rules: the merge changes every layer of the family (Shared, a channel, an alias listing), the undo puts
 * each one back, a stale undo changes nothing, and "not the same" stops the suggestion. Only the SSE publish is observed.
 */
const state = vi.hoisted(() => ({ db: null as any, events: [] as unknown[] }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { state.events.push(event) } }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps, markDistinctPhotos, markSamePhoto, readMediaWorkspace, separateSamePhoto, undoSamePhoto } from './media-plan.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const img: Record<string, string> = {}
const A = '0'.repeat(16), D = '0'.repeat(64)

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', sortOrder: 2 } as never })
    const root = await prisma.product.create({ data: { sku: 'JACKET', name: 'Jacket', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'] } as never })
    ids.root = root.id
    for (const [key, sku, value] of [['nm', 'JACKET-NERO-M', 'Nero'], ['gm', 'JACKET-GIALLO-M', 'Giallo']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: root.id, categoryAttributes: { variations: { Colore: value } } } as never })).id
    const photo = (name: string, productId: string, url: string, extra: object = {}) => prisma.productImage.create({ data: { productId, url, alt: name, type: 'ALT', width: 1600, height: 1600,
      perceptualHash: A, dhash256: D, ...extra } as never })
    // Ours (Cloudinary) and Amazon's copy of the same picture at another address; Amazon's also stored on a second SKU.
    img.cover = (await photo('cover', root.id, 'https://res.cloudinary.com/test/cover.jpg')).id
    img.amz = (await photo('amz', ids.nm, 'https://m.media-amazon.com/images/I/81cover.jpg')).id
    img.amz2 = (await photo('amz2', ids.gm, 'https://m.media-amazon.com/images/I/81cover._AC_SL1500_.jpg')).id
    img.n1 = (await photo('n1', root.id, 'https://res.cloudinary.com/test/n1.jpg', { perceptualHash: 'f'.repeat(16), dhash256: 'f'.repeat(64) })).id
    img.chartIt = (await photo('chart-it', root.id, 'https://res.cloudinary.com/test/chart-it.jpg', { languageTag: 'it', versionGroupId: 'chart', dhash256: '1'.repeat(64) })).id
    img.chartDe = (await photo('chart-de', root.id, 'https://res.cloudinary.com/test/chart-de.jpg', { languageTag: 'de', versionGroupId: 'chart', dhash256: '1'.repeat(64) })).id
    img.chartEs = (await photo('chart-es', root.id, 'https://res.cloudinary.com/test/chart-es.jpg', { languageTag: 'es', dhash256: '3'.repeat(64) })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    ids.alias = (await prisma.productListingAlias.create({ data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label: 'Winter', position: 1 } as never })).id
    for (const p of [ids.root, ids.nm, ids.gm]) for (const alias of ['', ids.alias])
      await prisma.channelListing.create({ data: { productId: p, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: ids.ebay,
        ...(alias ? { aliasId: alias, aliasKey: alias } : {}) } as never })
  })
  await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [
    { op: 'insert', set: 'common', assetIds: [img.amz, img.cover] },
    { op: 'insert', set: 'value:color:black', assetIds: [img.n1, img.amz] },
    { op: 'insert', set: 'value:color:yellow', assetIds: [img.cover] },
  ] }, null))
  await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'CHANNEL', channel: 'EBAY' }, ops: [{ op: 'replace', set: 'common', assetIds: [img.amz2] }] }, null))
  await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias },
    ops: [{ op: 'replace', set: 'value:color:black', assetIds: [img.amz] }] }, null))
}, 120_000)
beforeEach(() => { state.events.length = 0 })
afterAll(async () => { await state.db?.close() })

const plans = async () => Object.fromEntries((await scoped(() => prisma.productMediaPlan.findMany({ where: { productId: ids.root } })))
  .map(r => [r.aliasKey ? 'alias' : r.layer, r.plan as any]))
const setIds = (plan: any, ref: 'common' | 'black' | 'yellow') => (ref === 'common' ? plan.sets.common : plan.sets.values?.[`color:${ref}`])?.map((i: { assetId: string }) => i.assetId)

describe('the same picture at two addresses (W4a)', () => {
  it('the read suggests the Amazon copy as "looks like" ours, and never the photo with its own look', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.root))
    const card = (id: string) => read.library.find((c: { id: string }) => c.id === id) as any
    expect(card(img.cover).lookalikes.map((x: { id: string }) => x.id)).toContain(img.amz)
    expect(card(img.n1).lookalikes).toBeUndefined()
    // The hashes stay on the server.
    expect(card(img.cover)).not.toHaveProperty('dhash256')
  })

  it('refuses languages of one photo, a photo already joined, and a photo from elsewhere', async () => {
    await expect(scoped(() => markSamePhoto(ids.root, { keep: img.chartIt, drop: img.chartEs }, null))).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/two languages of one photo/) })
    await expect(scoped(() => markSamePhoto(ids.root, { keep: img.chartIt, drop: img.chartDe }, null))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => markSamePhoto(ids.root, { keep: img.amz, drop: img.amz2 }, null))).rejects.toMatchObject({ statusCode: 409, message: 'These are already one photo.' })
    await expect(scoped(() => markSamePhoto(ids.root, { keep: img.cover, drop: 'not-a-photo' }, null))).rejects.toMatchObject({ statusCode: 409 })
  })

  it('merges into every layer — Shared, the eBay channel (a copy of the copy), the alias listing — and undo puts each back', async () => {
    const before = await plans()
    const merged = await scoped(() => markSamePhoto(ids.root, { keep: img.cover, drop: img.amz }, null))
    expect(merged.layersChanged).toBe(3)
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', layer: 'LIBRARY' })])
    const after = await plans()
    expect(setIds(after.SHARED, 'common')).toEqual([img.cover])
    expect(setIds(after.SHARED, 'black')).toEqual([img.n1, img.cover])
    expect(setIds(after.CHANNEL, 'common')).toEqual([img.cover])
    expect(setIds(after.alias, 'black')).toEqual([img.cover])
    // One card, ours, with the Amazon copies behind it; nothing deleted.
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect(read.library.find((c: { id: string }) => c.id === img.cover)).toMatchObject({ copies: expect.arrayContaining([img.amz, img.amz2]) })
    expect(read.library.some((c: { id: string }) => c.id === img.amz || c.id === img.amz2)).toBe(false)
    expect(await scoped(() => prisma.productImage.count({ where: { id: { in: [img.amz, img.amz2] } } }))).toBe(2)

    await scoped(() => undoSamePhoto(ids.root, merged.undo))
    const back = await plans()
    for (const key of ['SHARED', 'CHANNEL', 'alias']) expect(back[key].sets).toEqual(before[key].sets)
    expect((await scoped(() => prisma.productImage.findUniqueOrThrow({ where: { id: img.amz } }))).sameAsImageId).toBeNull()
  })

  it('an undo after someone changed a set it touched is refused and changes nothing', async () => {
    const merged = await scoped(() => markSamePhoto(ids.root, { keep: img.cover, drop: img.amz }, null))
    await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [{ op: 'insert', set: 'value:color:black', assetIds: [img.chartIt] }] }, null))
    const now = await plans()
    await expect(scoped(() => undoSamePhoto(ids.root, merged.undo))).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/cannot be undone/) })
    expect(await plans()).toEqual(now)
    expect((await scoped(() => prisma.productImage.findUniqueOrThrow({ where: { id: img.amz } }))).sameAsImageId).toBe(img.cover)
  })

  it('the photo window lists the merged copy; "Separate" makes it its own photo again and leaves every set as it is', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect((read.library.find((c: { id: string }) => c.id === img.cover) as any).merged).toEqual([{ id: img.amz, label: 'amz' }])
    const sets = await plans()
    await scoped(() => separateSamePhoto(ids.root, { drop: img.amz }))
    expect(await plans()).toEqual(sets)
    const after = await scoped(() => readMediaWorkspace(ids.root))
    expect(after.library.some((c: { id: string }) => c.id === img.amz)).toBe(true)
    await expect(scoped(() => separateSamePhoto(ids.root, { drop: img.amz }))).rejects.toMatchObject({ statusCode: 409, message: 'This photo is already its own photo.' })
  })
  it('"not the same" stops the suggestion both ways; its undo brings it back', async () => {
    const suggested = async () => ((await scoped(() => readMediaWorkspace(ids.root))).library.find((c: { id: string }) => c.id === img.chartEs) as any)?.lookalikes ?? []
    // chart-es looks like nothing yet; give it the cover's look to make a pair, then answer "not the same".
    await scoped(() => prisma.productImage.update({ where: { id: img.chartEs }, data: { dhash256: D } as never }))
    expect((await suggested()).map((x: { id: string }) => x.id)).toContain(img.cover)
    await scoped(() => markDistinctPhotos(ids.root, { a: img.cover, b: img.chartEs }))
    expect((await suggested()).map((x: { id: string }) => x.id)).not.toContain(img.cover)
    await scoped(() => markDistinctPhotos(ids.root, { a: img.cover, b: img.chartEs }, true))
    expect((await suggested()).map((x: { id: string }) => x.id)).toContain(img.cover)
  })
})
