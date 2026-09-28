import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild W4b — language versions of one photo, with the real schema, the real tenant policies and the real
 * shared plan rules: joining them keeps one of them per set in every layer (Shared and an alias listing), the undo puts
 * each layer and each photo back, leaving a group changes no set, and a photo's own language cannot break its group.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps, joinVersions, leaveVersions, readMediaWorkspace, undoVersions, updateMediaLibrary } from './media-plan.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const img: Record<string, string> = {}
const A = '0'.repeat(16)

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    const root = await prisma.product.create({ data: { sku: 'JACKET', name: 'Jacket', basePrice: 10 } as never })
    ids.root = root.id
    // Three size charts: one template, other text. Fingerprints 20 bits apart (the "versions" band); no language yet.
    const photo = (name: string, dhash: string, extra: object = {}) => prisma.productImage.create({ data: { productId: root.id, url: `https://res.cloudinary.com/test/${name}.jpg`, alt: name,
      type: 'ALT', width: 1600, height: 1600, perceptualHash: A, dhash256: dhash, ...extra } as never })
    img.cover = (await photo('cover', 'f'.repeat(64))).id
    img.it = (await photo('chart-it', '0'.repeat(64))).id
    img.es = (await photo('chart-es', '1'.repeat(20) + '0'.repeat(44))).id
    img.fr = (await photo('chart-fr', '0'.repeat(44) + '1'.repeat(20))).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    ids.alias = (await prisma.productListingAlias.create({ data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label: 'Winter', position: 1 } as never })).id
    for (const alias of ['', ids.alias]) await prisma.channelListing.create({ data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT',
      region: 'IT', channelConnectionId: ids.ebay, ...(alias ? { aliasId: alias, aliasKey: alias } : {}) } as never })
  })
  await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [{ op: 'insert', set: 'common', assetIds: [img.cover, img.es, img.it] }] }, null))
  await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias },
    ops: [{ op: 'replace', set: 'common', assetIds: [img.fr, img.es] }] }, null))
}, 120_000)
afterAll(async () => { await state.db?.close() })

const common = async () => Object.fromEntries((await scoped(() => prisma.productMediaPlan.findMany({ where: { productId: ids.root } })))
  .map(r => [r.aliasKey ? 'alias' : r.layer, ((r.plan as any).sets.common ?? []).map((i: { assetId: string }) => i.assetId)]))
const photos = async () => Object.fromEntries((await scoped(() => prisma.productImage.findMany({ where: { productId: ids.root } }))).map(r => [r.alt, [r.languageTag, r.versionGroupId]]))

describe('language versions of one photo (W4b)', () => {
  it('suggests the charts as language versions (same template, other text), never the cover', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.root))
    const card = (id: string) => read.library.find((c: { id: string }) => c.id === id) as any
    expect(card(img.it).lookalikes).toEqual(expect.arrayContaining([{ id: img.es, distance: 20, kind: 'versions' }, { id: img.fr, distance: 20, kind: 'versions' }]))
    expect(card(img.cover).lookalikes).toBeUndefined()
  })

  it('refuses the same language twice, a photo with no text, and one photo', async () => {
    await expect(scoped(() => joinVersions(ids.root, { ids: [img.it, img.es], languages: { [img.it]: 'it', [img.es]: 'it' } }, null))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => joinVersions(ids.root, { ids: [img.it, img.es], languages: { [img.it]: 'it' } }, null))).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/different language each/) })
    await expect(scoped(() => joinVersions(ids.root, { ids: [img.it], languages: { [img.it]: 'it' } }, null))).rejects.toMatchObject({ statusCode: 422 })
  })

  it('joins them: each gets its language, a set that held two keeps one (the main language where it can), undo puts all back', async () => {
    const before = await common(), tags = await photos()
    const joined = await scoped(() => joinVersions(ids.root, { ids: [img.it, img.es, img.fr], languages: { [img.it]: 'it', [img.es]: 'es', [img.fr]: 'fr' } }, null))
    expect(joined).toMatchObject({ keep: img.it, layersChanged: 2 })
    const after = await common()
    // Shared held ES and IT: IT (the business's main language) stays in IT's place. The alias held FR and ES: FR stays.
    expect(after.SHARED).toEqual([img.cover, img.it])
    expect(after.alias).toEqual([img.fr])
    expect(await photos()).toMatchObject({ 'chart-it': ['it', joined.groupId], 'chart-es': ['es', joined.groupId], 'chart-fr': ['fr', joined.groupId] })
    // Joined versions are one photo: no longer suggested to each other.
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect((read.library.find((c: { id: string }) => c.id === img.it) as any).lookalikes).toBeUndefined()

    await scoped(() => undoVersions(ids.root, joined.undo))
    expect(await common()).toEqual(before)
    expect(await photos()).toEqual(tags)
  })

  it('a photo cannot take a language its versions have; leaving the group changes no set, and a group of one ends', async () => {
    const joined = await scoped(() => joinVersions(ids.root, { ids: [img.it, img.es], languages: { [img.it]: 'it', [img.es]: 'es' } }, null))
    await expect(scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: img.es, languageTag: 'it' }], groups: [] }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: img.es, languageTag: 'zxx' }], groups: [] }))).rejects.toMatchObject({ statusCode: 422 })
    const sets = await common()
    await scoped(() => leaveVersions(ids.root, { id: img.es }))
    expect(await common()).toEqual(sets)
    // Two were in the group: once one leaves, the other is its own photo again too.
    expect((await photos())['chart-it']).toEqual(['it', null])
    expect((await photos())['chart-es']).toEqual(['es', null])
    await expect(scoped(() => undoVersions(ids.root, joined.undo))).rejects.toMatchObject({ statusCode: 409 })
  })
})
