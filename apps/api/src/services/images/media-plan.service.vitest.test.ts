import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild P1 — the media plan read and edits with the real schema, the real tenant policies and the real shared
 * plan logic. Only the SSE publish is observed instead of sent. On PGlite (one connection) the "same moment" test runs
 * edits one after the other; scripts/run-real-postgres-tests.mjs runs this file on PostgreSQL 17, where they race.
 */
const state = vi.hoisted(() => ({ db: null as any, events: [] as unknown[] }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { state.events.push(event) } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps, isMediaSwitched, mediaLayoutFor, readMediaWorkspace } from './media-plan.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const img: Record<string, string> = {}

beforeAll(async () => {
  await scoped(async () => {
    for (const [channel, code, language] of [['EBAY', 'IT', 'it'], ['EBAY', 'DE', 'de'], ['AMAZON', 'IT', 'it'], ['AMAZON', 'DE', 'de']])
      await prisma.marketplace.create({ data: { channel, code, name: `${channel} ${code}`, region: 'EU', currency: 'EUR', language, languages: [language] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', synonyms: ['Black'], sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', sortOrder: 2 } as never })
    // The family's own value order (yellow first) must win over the dictionary's (black first).
    const root = await prisma.product.create({ data: { sku: 'GALE', name: 'Gale jacket', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'], variationValueOrder: { color: ['yellow', 'black'] } } as never })
    ids.root = root.id
    for (const [key, sku, value] of [['nm', 'GALE-NERO-M', 'Nero'], ['nl', 'GALE-NERO-L', ' nero '], ['gm', 'GALE-GIALLO-M', 'Giallo'], ['rm', 'GALE-ROSSO-M', 'Rosso']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: root.id, categoryAttributes: { variations: { Colore: value } } } as never })).id
    for (const name of ['cover', 'n1', 'g1', 'chart-it', 'chart-de'])
      img[name] = (await prisma.productImage.create({ data: { productId: root.id, url: `https://cdn.example/${name}.jpg`, alt: name, type: 'ALT', width: 1600, height: 1600,
        ...(name.startsWith('chart') ? { languageTag: name.slice(6), versionGroupId: 'chart' } : {}) } as never })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Xavia eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Xavia Amazon', isActive: true, externalAccountId: 'A1', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    ids.alias = (await prisma.productListingAlias.create({ data: { productId: root.id, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label: 'Winter', position: 1 } as never })).id
    const listing = (productId: string, channel: string, marketplace: string, account: string, alias = '') => prisma.channelListing.create({ data: {
      productId, channel, marketplace, channelMarket: `${channel}_${marketplace}`, region: marketplace, channelConnectionId: account,
      ...(alias ? { aliasId: alias, aliasKey: alias } : {}) } as never })
    for (const p of [ids.root, ids.nm, ids.gm]) { await listing(p, 'EBAY', 'IT', ids.ebay); await listing(p, 'EBAY', 'IT', ids.ebay, ids.alias) }
    // The alias is an eBay Inventory listing (offer ids on its root row); the primary listing is a Trading listing.
    await prisma.channelListing.updateMany({ where: { productId: root.id, aliasKey: ids.alias }, data: { platformAttributes: { __offerIds: { IT: 'offer-1' } } } as never })
    await listing(ids.root, 'AMAZON', 'IT', ids.amazon); await listing(ids.nm, 'AMAZON', 'IT', ids.amazon); await listing(ids.root, 'AMAZON', 'DE', ids.amazon)
  })
}, 120_000)
beforeEach(() => { state.events.length = 0 })
afterAll(async () => { await state.db?.close() })

const ebayKey = (alias = '') => `LISTING:EBAY:IT:${ids.ebay}:${alias}`

describe('media plan read', () => {
  it('keys values by dictionary option (case and spaces folded), keeps the family order, and names unmapped values', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.nl))
    expect(read.rootId).toBe(ids.root)
    expect(read.family.valueOrder.color).toEqual(['color:yellow', 'color:black', 'color:text:rosso'])
    expect(read.family.variants.find(v => v.sku === 'GALE-NERO-L')!.values).toEqual({ color: 'color:black' })
    expect(read.family.unmapped).toEqual(['color:text:rosso'])
    expect(read.family.defaultAxis).toBe('color')
    expect(read.mainLanguage).toBe('it')
  })
  it('a family without a Shared layer is not switched: publishers keep today\'s behaviour', async () => {
    expect(await scoped(() => isMediaSwitched(ids.nm))).toBe(false)
    expect(await scoped(() => mediaLayoutFor({ productId: ids.root, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay }))).toBeNull()
  })
  it('knows each eBay listing\'s API (Trading or Inventory) from its own offer marker', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect(read.destinations.filter(d => d.channel === 'EBAY').map(d => [d.alias?.label ?? 'primary', d.api])).toEqual([['primary', 'TRADING'], ['Winter', 'INVENTORY']])
  })
  it('lists one Amazon destination per account (all its markets) and one eBay destination per alias', async () => {
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect(read.destinations.map(d => [d.channel, d.marketplace, d.markets, d.alias?.label ?? null, d.languages])).toEqual([
      ['AMAZON', 'GLOBAL', ['IT', 'DE'], null, ['mul', 'it']],
      ['EBAY', 'IT', ['IT'], null, ['it']],
      ['EBAY', 'IT', ['IT'], 'Winter', ['it']],
    ])
    expect(read.layouts[ebayKey()].checks.map((c: { code: string }) => c.code)).toContain('no-common')
  })
})

describe('media plan edits', () => {
  it('Shared edits create the Shared layer, publish one event, and every destination follows', async () => {
    const saved = await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [
      { op: 'insert', set: 'common', assetIds: [img.cover, img['chart-it']] },
      { op: 'insert', set: 'value:color:black', assetIds: [img.cover, img.n1] },
      { op: 'insert', set: 'value:color:yellow', assetIds: [img.g1] },
    ] }, null))
    expect(saved).toMatchObject({ key: 'SHARED', revision: 1 })
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: ids.root, layer: 'SHARED' })])
    const read = await scoped(() => readMediaWorkspace(ids.root))
    const ebay = read.layouts[ebayKey()] as any
    expect(ebay.gallery).toEqual([img.cover, img['chart-it']])
    expect(ebay.sets.map((s: any) => [s.value, s.items])).toEqual([['Giallo', [img.g1]], ['Nero', [img.cover, img.n1]]])
    expect((read.layouts[ebayKey(ids.alias)] as any).gallery).toEqual(ebay.gallery)
  })
  it('gives a publisher the same layout as the page, with the channel\'s own names and review variants', async () => {
    expect(await scoped(() => isMediaSwitched(ids.nm))).toBe(true)
    const page = (await scoped(() => readMediaWorkspace(ids.root))).layouts[ebayKey()] as any
    const out = await scoped(() => mediaLayoutFor({ productId: ids.nm, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay }))
    expect(out!.layout).toEqual(page)
    expect(out!.layout.revisions).toEqual(['SHARED@1'])
    expect(out!.url(img.cover)).toBe('https://cdn.example/cover.jpg')
    const named = await scoped(() => mediaLayoutFor({ productId: ids.root, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay,
      axisName: 'Colore', valueNames: { 'color:black': 'Nero lucido', 'color:yellow': 'Giallo fluo' }, includedIds: [ids.nm] }))
    expect((named!.layout as any).sets.map((s: any) => [s.value, s.productIds])).toEqual([['Nero lucido', [ids.nm]]])
    await expect(scoped(() => mediaLayoutFor({ productId: ids.root, channel: 'EBAY', marketplace: 'DE', accountId: ids.ebay }))).rejects.toMatchObject({ statusCode: 409 })
  })
  it('a variant its listing excludes is not part of that destination', async () => {
    const child = await scoped(() => prisma.channelListing.findFirstOrThrow({ where: { productId: ids.gm, channel: 'EBAY', aliasKey: '' }, select: { id: true } }))
    await scoped(() => prisma.$executeRawUnsafe(`update "ChannelListing" set "variationExcluded" = true where id = $1`, child.id))
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect((read.layouts[ebayKey()] as any).sets.map((s: any) => s.value)).toEqual(['Nero'])
    await scoped(() => prisma.$executeRawUnsafe(`update "ChannelListing" set "variationExcluded" = false where id = $1`, child.id))
  })
  it('an alias can own one set; the primary listing keeps following; Follow again removes the layer row', async () => {
    const own = await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias },
      ops: [{ op: 'remove', set: 'value:color:black', assetId: img.n1 }] }, null))
    expect(own).toMatchObject({ key: ebayKey(ids.alias), revision: 1, plan: { version: 1, sets: { values: { 'color:black': [{ assetId: img.cover }] } } } })
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect((read.layouts[ebayKey(ids.alias)] as any).sets.find((s: any) => s.value === 'Nero').items).toEqual([img.cover])
    expect((read.layouts[ebayKey()] as any).sets.find((s: any) => s.value === 'Nero').items).toEqual([img.cover, img.n1])
    const back = await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias },
      ops: [{ op: 'follow', set: 'value:color:black' }] }, null))
    expect(back.plan).toBeNull()
    expect(await scoped(() => prisma.productMediaPlan.count({ where: { layer: 'LISTING' } }))).toBe(0)
  })
  it('Amazon photos belong to the account: its listing layer is GLOBAL whatever market is sent', async () => {
    const saved = await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon, aliasKey: 'ignored' },
      ops: [{ op: 'own', set: 'common' }] }, null))
    expect(saved.key).toBe(`LISTING:AMAZON:GLOBAL:${ids.amazon}:`)
  })
  it('refuses a photo from another product, a repeat inside a set, a foreign alias and a wrong-channel account', async () => {
    const other = await scoped(async () => (await prisma.productImage.create({ data: { productId: (await prisma.product.create({ data: { sku: 'OTHER', name: 'Other', basePrice: 1 } as never })).id, url: 'https://cdn.example/o.jpg', type: 'ALT' } as never })).id)
    const shared = (ops: any[]) => scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops }, null))
    await expect(shared([{ op: 'insert', set: 'common', assetIds: [other] }])).rejects.toMatchObject({ statusCode: 409 })
    await expect(shared([{ op: 'insert', set: 'common', assetIds: [img.cover] }])).rejects.toMatchObject({ statusCode: 409, message: 'This photo is already in that set.' })
    await expect(shared([{ op: 'insert', set: 'common', assetIds: [img['chart-de']] }])).rejects.toMatchObject({ statusCode: 409 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: 'not-an-alias' }, ops: [{ op: 'own', set: 'common' }] }, null)))
      .rejects.toMatchObject({ statusCode: 409 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.amazon }, ops: [{ op: 'own', set: 'common' }] }, null)))
      .rejects.toMatchObject({ statusCode: 404 })
    expect(state.events).toEqual([])
  })
  it('two edits of different sets at the same moment both land', async () => {
    const before = await scoped(() => prisma.productMediaPlan.findFirstOrThrow({ where: { layer: 'SHARED' } }))
    await Promise.all([
      scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [{ op: 'reorder', set: 'common', assetIds: [img['chart-it'], img.cover] }] }, null)),
      scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [{ op: 'move', from: 'value:color:black', to: 'value:color:black', assetId: img.n1, index: 0 }] }, null)),
    ])
    const after = await scoped(() => prisma.productMediaPlan.findFirstOrThrow({ where: { layer: 'SHARED' } }))
    expect(after.revision).toBe(before.revision + 2)
    expect((after.plan as any).sets.common).toEqual([{ assetId: img['chart-it'] }, { assetId: img.cover }])
    expect((after.plan as any).sets.values['color:black']).toEqual([{ assetId: img.n1 }, { assetId: img.cover }])
  })
})
