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
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps, isMediaSwitched, mediaLayoutFor, readMediaWorkspace, sheetMediaPlan, updateMediaLibrary } from './media-plan.service.js'

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
    // ★ ①: eBay IT on this account holds two listings of the family; Amazon's one listing needs no mark.
    expect(read.destinations.map(d => d.listingMark)).toEqual([null, 0, 1])
    // The alias is on the Inventory API (offer ids on its rows): its SKUs are the main listing's, so it is blocked.
    expect(read.layouts[ebayKey(ids.alias)].checks.filter((c: { code: string }) => c.code === 'inventory-alias').map((c: { severity: string }) => c.severity)).toEqual(['error'])
    expect(read.layouts[ebayKey()].checks.map((c: { code: string }) => c.code)).not.toContain('inventory-alias')
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
  it('every edit returns its Undo: applied, the layer comes back (the alias row goes away); a stale undo is refused', async () => {
    const address = { layer: 'LISTING' as const, channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias }
    const edit = await scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'remove', set: 'value:color:black', assetId: img.n1 }] }, null))
    expect(edit.undo).toEqual([{ op: 'follow', set: 'value:color:black', expect: [img.cover] }])
    const undone = await scoped(() => applyMediaPlanOps(ids.root, { address, ops: edit.undo }, null))
    expect(undone.plan).toBeNull()
    // Redo is the undo's own undo; once someone else changes the set, the old undo is refused and nothing changes.
    await scoped(() => applyMediaPlanOps(ids.root, { address, ops: undone.undo }, null))
    await scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'insert', set: 'value:color:black', assetIds: [img.g1] }] }, null))
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address, ops: edit.undo }, null))).rejects.toThrow(/cannot be undone/)
    await scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'follow', set: 'value:color:black' }] }, null))
    expect(await scoped(() => prisma.productMediaPlan.count({ where: { layer: 'LISTING' } }))).toBe(0)
  })
  it('the Information sheet cell reads the plan: parent = Common, variant = its value set then Common (muted), per sheet language and listing', async () => {
    const sheet = (await scoped(() => sheetMediaPlan(ids.root)))!
    const show = (cell: ReturnType<typeof sheet.row>) => cell.items.map(i => `${i.id}${i.muted ? '*' : ''}`)
    expect(sheet.row(ids.root, null, 'it')).toMatchObject({ set: { ref: 'common', label: 'Common' } })
    expect(show(sheet.row(ids.root, null, 'it'))).toEqual([img.cover, img['chart-it']])
    const nero = sheet.row(ids.nm, null, 'it')
    expect(nero.set).toEqual({ ref: 'value:color:black', label: 'Nero', sharedBy: 2 })
    expect(show(nero)).toEqual([img.cover, img.n1, `${img['chart-it']}*`])
    // The German sheet shows the German version of the size chart (the cell keeps the placed id, so edits address it).
    expect(sheet.row(ids.root, null, 'de').items[1]).toMatchObject({ id: img['chart-it'], alt: 'chart-de' })
    // A channel sheet reads that listing's layers: the alias with its own Nero set.
    await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias }, ops: [{ op: 'remove', set: 'value:color:black', assetId: img.n1 }] }, null))
    const again = (await scoped(() => sheetMediaPlan(ids.root)))!
    expect(show(again.row(ids.nm, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias }, 'it'))).toEqual([img.cover, `${img['chart-it']}*`])
    expect(show(again.row(ids.nm, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: '' }, 'it'))).toEqual([img.cover, img.n1, `${img['chart-it']}*`])
    await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey: ids.alias }, ops: [{ op: 'follow', set: 'value:color:black' }] }, null))
  })
  it('Amazon photos belong to the account: its listing layer is GLOBAL whatever market is sent', async () => {
    const saved = await scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon, aliasKey: 'ignored' },
      ops: [{ op: 'own', set: 'common' }] }, null))
    expect(saved.key).toBe(`LISTING:AMAZON:GLOBAL:${ids.amazon}:`)
  })
  it('an Amazon market can own photos below the account\'s (marketOnly); publishers and the sheet keep the account\'s', async () => {
    const accountKey = `LISTING:AMAZON:GLOBAL:${ids.amazon}:`, deKey = `LISTING:AMAZON:DE:${ids.amazon}:`
    const address = { layer: 'LISTING' as const, channel: 'AMAZON', marketplace: 'de', accountId: ids.amazon, marketOnly: true }
    const own = await scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'insert', set: 'common', assetIds: [img.g1], index: 0 }] }, null))
    // DE's copy starts from what DE showed: the account's own Common (the test above), with g1 first.
    expect(own).toMatchObject({ key: deKey, revision: 1, plan: { sets: { common: [{ assetId: img.g1 }, { assetId: img.cover }, { assetId: img['chart-it'] }] } } })
    expect(state.events).toEqual([expect.objectContaining({ layer: deKey })])
    const read = await scoped(() => readMediaWorkspace(ids.root))
    expect(read.destinations.filter(d => d.channel === 'AMAZON').map(d => d.key)).toEqual([accountKey])
    expect(read.layers.find(l => l.key === deKey)).toMatchObject({ layer: 'LISTING', channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon, aliasKey: '' })
    // A publisher gets the account's layout (All Amazon markets), whatever market it names; only the ZIP asks for DE's.
    const api = await scoped(() => mediaLayoutFor({ productId: ids.root, channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon }))
    expect(api!.layout).toEqual(read.layouts[accountKey])
    expect((api!.layout as any).parent.slots).toEqual({ MAIN: img.cover, PT01: img['chart-it'] })
    expect(api!.marketLayout).toBeNull()
    const de = await scoped(() => mediaLayoutFor({ productId: ids.root, channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon, amazonMarket: { market: 'DE', languages: ['de'] } }))
    expect(de!.layout).toEqual(api!.layout)
    expect((de!.marketLayout as any).parent.slots).toEqual({ MAIN: img.g1, PT01: img.cover, PT02: img['chart-de'] })
    expect(de!.marketLayout!.revisions).toContain(`${deKey}@1`)
    // The Information sheet on Amazon DE shows (and edits) the account's photos, as before.
    const sheet = (await scoped(() => sheetMediaPlan(ids.root)))!
    expect(sheet.row(ids.root, { channel: 'AMAZON', marketplace: 'DE', accountId: ids.amazon, aliasKey: '' }, 'de').items.map(i => i.id)).toEqual([img.cover, img['chart-it']])
    // Safety images are one set for every market; a market with no listing, and "one market" off Amazon, are refused.
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'own', set: 'safety' }] }, null))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address, ops: [{ op: 'move', from: 'common', to: 'safety', assetId: img.g1, index: 0 }] }, null))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { ...address, marketplace: 'FR' }, ops: [{ op: 'own', set: 'common' }] }, null))).rejects.toMatchObject({ statusCode: 404 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { ...address, marketplace: 'GLOBAL' }, ops: [{ op: 'own', set: 'common' }] }, null))).rejects.toMatchObject({ statusCode: 400 })
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, marketOnly: true }, ops: [{ op: 'own', set: 'common' }] }, null)))
      .rejects.toMatchObject({ statusCode: 400 })
    // Reset to shared (the edit's Undo here): the DE row goes, DE follows the account again.
    const back = await scoped(() => applyMediaPlanOps(ids.root, { address, ops: own.undo }, null))
    expect(back).toMatchObject({ key: deKey, plan: null })
    expect(await scoped(() => prisma.productMediaPlan.count({ where: { marketplace: 'DE' } }))).toBe(0)
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

describe('one picture, one library card (Owner, 2026-09-28: "multiple duplicates of the same image")', () => {
  it('the page shows each picture once, even when every SKU stores its own copy; the copies stay resolvable', async () => {
    await scoped(async () => {
      for (const kid of [ids.nm, ids.gm]) {
        await prisma.productImage.create({ data: { productId: kid, url: 'https://cdn.example/cover.jpg', type: 'MAIN' } as never })
        await prisma.productImage.create({ data: { productId: kid, url: `https://m.media-amazon.com/images/I/71zz${kid === ids.nm ? '' : '._AC_SL1500_'}.jpg`, type: 'LIFESTYLE' } as never })
      }
    })
    const read = await scoped(() => readMediaWorkspace(ids.root))
    const cover = read.library.filter(a => a.url.endsWith('/cover.jpg'))
    expect(cover.map(a => [a.id, a.copies.length])).toEqual([[img.cover, 2]])
    expect(read.library.filter(a => a.url.includes('71zz'))).toHaveLength(1)
    expect(read.library.some(a => 'contentHash' in a)).toBe(false)
  })
  it('a copy of a photo already in a set is the same photo: refused, never placed twice', async () => {
    const copy = await scoped(async () => (await prisma.productImage.findFirstOrThrow({ where: { productId: ids.nm, url: 'https://cdn.example/cover.jpg' } })).id)
    const plan = await scoped(() => prisma.productMediaPlan.findFirstOrThrow({ where: { layer: 'SHARED' } }))
    const setWithCover = (plan.plan as any).sets.common.some((i: any) => i.assetId === img.cover) ? 'common' : 'value:color:black'
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops: [{ op: 'insert', set: setWithCover as never, assetIds: [copy] }] }, null)))
      .rejects.toMatchObject({ statusCode: 409, message: 'This photo is already in that set.' })
  })
  it('an upload is checked against the whole family on the plan; older tools may not copy photos onto its SKUs', async () => {
    const { uploadDedupScope } = await import('./media-plan-switch.js')
    const { applyImagesToProducts, MediaPlanRefusal } = await import('./bulk-apply.service.js')
    expect((await scoped(() => uploadDedupScope(ids.nm))).sort()).toEqual([ids.root, ids.nm, ids.nl, ids.gm, ids.rm].sort())
    await expect(scoped(() => applyImagesToProducts({ sourceProductId: ids.root, targetProductIds: [ids.nm] }))).rejects.toBeInstanceOf(MediaPlanRefusal)
    expect(await scoped(() => prisma.productImage.count({ where: { productId: ids.nm } }))).toBe(2)
  })
})

describe('library languages and versions (P4b upload)', () => {
  const photo = (name: string, languageTag = 'zxx') => scoped(async () => (await prisma.productImage.create({ data: { productId: ids.root, url: `https://cdn.example/${name}.jpg`, alt: name, type: 'ALT', languageTag } as never })).id)
  const row = (id: string) => scoped(() => prisma.productImage.findUniqueOrThrow({ where: { id }, select: { languageTag: true, versionGroupId: true } }))
  it('sets each file\'s language and makes files that differ only by language versions of one photo', async () => {
    const [it, es] = [await photo('guide-it'), await photo('guide-es')]
    const saved = await scoped(() => updateMediaLibrary(ids.nm, { languages: [{ id: it, languageTag: 'it' }, { id: es, languageTag: 'es' }], groups: [{ ids: [it, es] }] }))
    expect(saved.rootId).toBe(ids.root)
    const [a, b] = [await row(it), await row(es)]
    expect([a.languageTag, b.languageTag]).toEqual(['it', 'es'])
    expect(a.versionGroupId).toBeTruthy()
    expect(b.versionGroupId).toBe(a.versionGroupId)
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: ids.root, layer: 'LIBRARY' })])
  })
  it('a new file can join a photo already in the library and keeps that photo\'s group', async () => {
    const fr = await photo('chart-fr')
    await scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: fr, languageTag: 'fr' }], groups: [{ ids: [fr], join: img['chart-it'] }] }))
    expect((await row(fr)).versionGroupId).toBe('chart')
    // The page reads it as a third version: placing it next to the Italian chart is refused as the same photo.
    await expect(scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'LISTING', channel: 'EBAY', marketplace: 'DE', accountId: ids.ebay }, ops: [{ op: 'insert', set: 'common', assetIds: [img['chart-it'], fr] }] }, null)))
      .rejects.toMatchObject({ statusCode: 409 })
  })
  it('refuses two versions in one language, a version without text, and a photo of another family — and changes nothing', async () => {
    const [a, b] = [await photo('twin-a'), await photo('twin-b')]
    const other = await scoped(async () => (await prisma.productImage.create({ data: { productId: (await prisma.product.create({ data: { sku: 'ELSE', name: 'Else', basePrice: 1 } as never })).id, url: 'https://cdn.example/else.jpg', type: 'ALT' } as never })).id)
    await expect(scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: a, languageTag: 'it' }, { id: b, languageTag: 'it' }], groups: [{ ids: [a, b] }] }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: a, languageTag: 'it' }], groups: [{ ids: [a, b] }] }))).rejects.toMatchObject({ statusCode: 422 })
    await expect(scoped(() => updateMediaLibrary(ids.root, { languages: [{ id: other, languageTag: 'de' }], groups: [] }))).rejects.toMatchObject({ statusCode: 409 })
    expect([await row(a), await row(b)]).toEqual([{ languageTag: 'zxx', versionGroupId: null }, { languageTag: 'zxx', versionGroupId: null }])
    expect(state.events).toEqual([])
  })
})
