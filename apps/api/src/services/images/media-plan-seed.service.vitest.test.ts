import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/**
 * Images rebuild P3a — moving one family onto the media plan, on PGlite with the real schema and policies. The previous
 * edit page's eBay builder rows (on the family and on an adopted shell) are the curation; photo downloads are replaced by
 * generated images; nothing reaches a channel.
 */
const state = vi.hoisted(() => ({ db: null as any, events: [] as unknown[], fetched: [] as string[], colours: {} as Record<string, string> }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: (event: unknown) => { state.events.push(event) } }))
vi.mock('../pim/catalog-source-fetch.js', () => ({ fetchCatalogSource: async (url: string) => {
  state.fetched.push(url)
  if (url.includes('broken')) throw new Error('404')
  // Each URL is its own picture (a colour from its name) unless the test gives two URLs the same bytes.
  const own = '#' + [...url].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(6, '0').slice(-6)
  return { buffer: await sharp({ create: { width: 800, height: 800, channels: 3, background: state.colours[url] ?? own } }).png().toBuffer() }
} }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { previewMediaSwitch, switchToMediaPlan } from './media-plan-seed.service.js'
import { sha256Buffer } from './image-hash.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const url = (name: string) => `https://cdn.example/${name}.jpg`

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', synonyms: [], sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', synonyms: [], sortOrder: 2 } as never })
    ids.root = (await prisma.product.create({ data: { sku: 'GALE', name: 'Gale', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'], imageAxisPreference: 'Color' } as never })).id
    for (const [key, sku, value] of [['nm', 'GALE-NERO-M', 'Nero'], ['gm', 'GALE-GIALLO-M', 'Giallo']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: ids.root, categoryAttributes: { variations: { Colore: value } } } as never })).id
    // In the library already: the cover (with its bytes' hash) and one Nero photo.
    state.colours[url('same-as-cover')] = '#ff0000'
    const coverHash = sha256Buffer(await sharp({ create: { width: 800, height: 800, channels: 3, background: '#ff0000' } }).png().toBuffer())
    ids.cover = (await prisma.productImage.create({ data: { productId: ids.root, url: url('cover'), type: 'MAIN', sortOrder: 0, contentHash: coverHash } as never })).id
    ids.n1 = (await prisma.productImage.create({ data: { productId: ids.root, url: url('n1'), type: 'ALT', sortOrder: 1 } as never })).id
    // The previous edit page's eBay builder rows on the family: Default + per colour (a case twin, and one row under another spelling).
    const row = (productId: string, name: string, position: number, key: string | null = null, value: string | null = null) =>
      prisma.listingImage.create({ data: { productId, url: url(name), position, platform: 'EBAY', scope: 'PLATFORM', variantGroupKey: key, variantGroupValue: value } as never })
    await row(ids.root, 'cover', 0); await row(ids.root, 'same-as-cover', 1); await row(ids.root, 'detail', 2)
    await row(ids.root, 'n1', 0, 'Color', 'Nero'); await row(ids.root, 'n2', 1, 'Color', 'nero'); await row(ids.root, 'g1', 0, 'Color', 'Giallo')
    await row(ids.root, 'old-spelling', 0, 'Colore', 'Nero')
    // A row under a DIFFERENT axis: the old publisher never sent it as a colour photo.
    await row(ids.root, 'by-size', 0, 'Taglia', 'M')
    // An old shell, adopted as the alias "ALT1": its own builder rows become that alias's own photos.
    ids.shell = (await prisma.product.create({ data: { sku: 'GALE-ALT1', name: 'Gale alt', basePrice: 0, productType: 'EBAY_LISTING_SHELL' } as never })).id
    await row(ids.shell, 'shell-cover', 0); await row(ids.shell, 'shell-nero', 0, 'Color', 'Nero')
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Xavia eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    ids.alias = (await prisma.productListingAlias.create({ data: { productId: ids.root, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label: 'ALT1', position: 1, adoptedFromProductId: ids.shell } as never })).id
    for (const p of [ids.root, ids.nm, ids.gm]) for (const alias of ['', ids.alias])
      await prisma.channelListing.create({ data: { productId: p, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: ids.ebay,
        ...(alias ? { aliasId: alias, aliasKey: alias } : {}) } as never })
  })
}, 120_000)
beforeEach(() => { state.events.length = 0; state.fetched.length = 0 })

describe('moving a family onto the photo plan', () => {
  it('the preview copies the builder\'s curation into the plan, names what it left out, and writes nothing', async () => {
    const before = await scoped(() => prisma.productImage.count())
    const preview = await scoped(() => previewMediaSwitch(ids.nm)) as any
    expect(preview.switched).toBe(false)
    const shared = preview.layers.find((l: any) => l.key === 'SHARED')
    expect(shared.source).toBe('old eBay builder')
    expect(shared.plan.axis).toBe('color')
    expect(shared.plan.sets.common.map((i: any) => i.assetId)).toEqual([ids.cover, expect.stringMatching(/^import:/), expect.stringMatching(/^import:/)])
    // "Nero" and its case twin "nero" are one dictionary value, in the builder's order; the row saved under "Colore" (the same
    // axis) comes in at its position, as the old eBay publisher sent it.
    expect(shared.plan.sets.values['color:black'].map((i: any) => i.assetId)).toEqual([ids.n1, expect.stringMatching(/^import:/), expect.stringMatching(/^import:/)])
    expect(Object.keys(shared.plan.sets.values)).toEqual(['color:black', 'color:yellow'])
    const alias = preview.layers.find((l: any) => l.label === 'ALT1')
    expect(alias).toMatchObject({ key: `LISTING:EBAY:IT:${ids.ebay}:${ids.alias}`, source: 'old eBay builder' })
    expect(preview.report).toEqual([
      'Shared: 1 photo saved under "Colore" (the same axis as "Color") was taken in, as the old eBay publisher sent it; repeats were dropped.',
      'Shared: 1 older photo saved under another axis ("Taglia") was left out.',
    ])
    expect(preview.imports).toBe(7)
    expect(preview.destinations.map((d: any) => d.source)).toEqual(['old eBay builder (Shared)', 'old eBay builder (ALT1)'])
    expect(await scoped(() => prisma.productMediaPlan.count())).toBe(0)
    expect(await scoped(() => prisma.productImage.count())).toBe(before)
    expect(state.fetched).toEqual([])
  })
  it('the switch refuses a stale preview, then imports the photos (reusing identical ones) and writes every layer', async () => {
    await expect(scoped(() => switchToMediaPlan(ids.root, { revision: 'f'.repeat(64) }, null))).rejects.toMatchObject({ statusCode: 409 })
    const { revision } = await scoped(() => previewMediaSwitch(ids.root)) as any
    const done = await scoped(() => switchToMediaPlan(ids.root, { revision }, null))
    expect(done).toMatchObject({ layers: 2, imported: 7 })
    const rows = await scoped(() => prisma.productMediaPlan.findMany({ orderBy: { layer: 'desc' } }))
    expect(rows.map(r => r.layer)).toEqual(['SHARED', 'LISTING'])
    expect(JSON.stringify(rows.map(r => r.plan))).not.toContain('import:')
    // "same-as-cover" has the cover's bytes: it is the cover, so Common keeps the cover once.
    const common = (rows[0].plan as any).sets.common.map((i: any) => i.assetId)
    expect(common[0]).toBe(ids.cover)
    expect(common).toHaveLength(2)
    const imported = await scoped(() => prisma.productImage.findMany({ where: { url: { in: [url('detail'), url('shell-nero')] } } }))
    expect(imported.map(i => [i.productId, i.width])).toEqual([[ids.root, 800], [ids.root, 800]])
    expect(state.events).toEqual([expect.objectContaining({ type: 'product.media.changed', productId: ids.root, layer: 'SHARED' })])
    await expect(scoped(() => switchToMediaPlan(ids.root, { revision }, null))).rejects.toMatchObject({ statusCode: 409, message: 'This product already uses the photo plan.' })
    expect(await scoped(() => previewMediaSwitch(ids.root))).toEqual({ rootId: ids.root, switched: true })
  })
})
