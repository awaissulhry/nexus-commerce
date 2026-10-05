import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/**
 * Owner 2026-10-05 — moving a family onto the photo plan keeps every eBay listing's own photos (Product media is the one
 * photo source, #355), laid out the way #355's Publish lays them out (`ebayVariationPhotoSets`), so what eBay shows does not
 * change: the Main row's list is the gallery; a variation with no list of its own shows the gallery; under the chosen axis
 * every value gets a set when its variations agree, else no axis and one gallery for all. Each layer is run through the real
 * eBay projection (the preview's): no blocking problem. On PGlite with the real schema; downloads are generated images;
 * nothing reaches a channel. Fake ids and addresses only.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../pim/catalog-source-fetch.js', () => ({ fetchCatalogSource: async (url: string) => {
  const colour = '#' + [...url].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7).toString(16).padStart(6, '0').slice(-6)
  return { buffer: await sharp({ create: { width: 800, height: 800, channels: 3, background: colour } }).png().toBuffer() }
} }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { previewMediaSwitch, switchToMediaPlan } from './media-plan-seed.service.js'
import { sheetMediaPlan } from './media-plan.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const url = (name: string) => `https://cdn.example/${name}.jpg`
const OUTSIDE = 'https://elsewhere.example/outside.jpg'
const productMedia = (...assetIds: string[]) => ({ _productMediaLocales: { it: { _productMedia: { version: 1, items: assetIds.map(assetId => ({ assetId })) } } } })
const mediaDraft = (...names: string[]) => ({ _mediaGalleryDraft: { axis: null, galleries: [{ axis: null, value: null, images: names.map(name => ({ url: url(name) })) }] } })

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', synonyms: [], sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', synonyms: [], sortOrder: 2 } as never })
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    const listing = (productId: string, aliasKey: string, platformAttributes: Record<string, unknown> = {}) => prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT',
      channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: ids.ebay, platformAttributes, ...(aliasKey ? { aliasId: aliasKey, aliasKey } : {}) } as never })

    // Family KNEE — Nero M, Nero L, Giallo M; the library holds cover, n1, n2, g1 and a video.
    ids.root = (await prisma.product.create({ data: { sku: 'KNEE', name: 'Knee slider', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'], imageAxisPreference: 'Color' } as never })).id
    for (const [key, sku, value] of [['nm', 'KNEE-NERO-M', 'Nero'], ['nl', 'KNEE-NERO-L', 'Nero'], ['gm', 'KNEE-GIALLO-M', 'Giallo']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: ids.root, categoryAttributes: { variations: { Colore: value } } } as never })).id
    for (const [index, name] of ['cover', 'n1', 'n2', 'g1'].entries())
      ids[name] = (await prisma.productImage.create({ data: { productId: ids.root, url: url(name), type: index ? 'ALT' : 'MAIN', sortOrder: index } as never })).id
    ids.video = (await prisma.productImage.create({ data: { productId: ids.root, url: 'https://cdn.example/clip.mp4', type: 'ALT', mediaType: 'VIDEO', sortOrder: 9 } as never })).id
    const alias = async (label: string, position: number, adoptedFromProductId?: string) => (await prisma.productListingAlias.create({ data: { productId: ids.root, channel: 'EBAY',
      marketplace: 'IT', channelConnectionId: ids.ebay, label, position, ...(adoptedFromProductId ? { adoptedFromProductId } : {}) } as never })).id
    // An old shell with builder rows, adopted by ALT5 and ALT6.
    ids.shell = (await prisma.product.create({ data: { sku: 'KNEE-SHELL', name: 'Knee shell', basePrice: 0, productType: 'EBAY_LISTING_SHELL' } as never })).id
    await prisma.listingImage.create({ data: { productId: ids.shell, url: url('shell-cover'), position: 0, platform: 'EBAY', scope: 'PLATFORM' } as never })
    // Main listing: own list on its main row and on Giallo M; Nero has none (scenario a).
    // ALT1: own list on its main row and on both Nero sizes (the same list); Giallo has none (scenario a).
    // ALT2: its old Image URLs list. ALT3: the two Nero sizes disagree. ALT4: nothing of its own.
    // ALT5: adopted shell + Product media → Product media. ALT6: adopted shell + Product media + eBay media draft → the draft.
    // ALT7: an unreadable Product media list. ALT8: a main row whose list holds only a video.
    ids.alt1 = await alias('ALT1', 1); ids.alt2 = await alias('ALT2', 2); ids.alt3 = await alias('ALT3', 3); ids.alt4 = await alias('ALT4', 4)
    ids.alt5 = await alias('ALT5', 5, ids.shell); ids.alt6 = await alias('ALT6', 6, ids.shell); ids.alt7 = await alias('ALT7', 7); ids.alt8 = await alias('ALT8', 8)
    const own: Record<string, Record<string, unknown>> = {
      [`:${ids.root}`]: productMedia(ids.g1, ids.cover), [`:${ids.gm}`]: productMedia(ids.g1),
      [`${ids.alt1}:${ids.root}`]: productMedia(ids.n1, ids.cover), [`${ids.alt1}:${ids.nm}`]: productMedia(ids.n2), [`${ids.alt1}:${ids.nl}`]: productMedia(ids.n2),
      [`${ids.alt2}:${ids.root}`]: { imageUrls: [url('cover'), OUTSIDE] },
      [`${ids.alt3}:${ids.nm}`]: productMedia(ids.n2), [`${ids.alt3}:${ids.nl}`]: productMedia(ids.g1),
      [`${ids.alt5}:${ids.root}`]: productMedia(ids.n1),
      [`${ids.alt6}:${ids.root}`]: { ...productMedia(ids.n1), ...mediaDraft('g1') },
      [`${ids.alt7}:${ids.root}`]: { _productMediaLocales: { it: { _productMedia: { version: 7, items: 'unreadable' } } } },
      [`${ids.alt8}:${ids.root}`]: productMedia(ids.video),
    }
    for (const p of [ids.root, ids.nm, ids.nl, ids.gm]) for (const aliasKey of ['', ids.alt1, ids.alt2, ids.alt3, ids.alt4, ids.alt5, ids.alt6, ids.alt7, ids.alt8])
      await listing(p, aliasKey, own[`${aliasKey}:${p}`])

    // Family BOLT (scenario b) — Nero S has its own photo, Nero M has none: the Nero variations disagree.
    ids.bolt = (await prisma.product.create({ data: { sku: 'BOLT', name: 'Bolt jacket', basePrice: 10, isParent: true, variationAxes: ['Colore', 'Taglia'], variationAxisCodes: ['color', 'size'], imageAxisPreference: 'Color' } as never })).id
    for (const [key, sku, size] of [['bs', 'BOLT-NERO-S', 'S'], ['bm', 'BOLT-NERO-M', 'M']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: ids.bolt, categoryAttributes: { variations: { Colore: 'Nero', Taglia: size } } } as never })).id
    for (const [index, name] of ['b0', 'b1'].entries()) ids[name] = (await prisma.productImage.create({ data: { productId: ids.bolt, url: url(name), type: index ? 'ALT' : 'MAIN', sortOrder: index } as never })).id
    await listing(ids.bolt, '', productMedia(ids.b0)); await listing(ids.bs, '', productMedia(ids.b1)); await listing(ids.bm, '')
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const layerKey = (alias: string) => `LISTING:EBAY:IT:${ids.ebay}:${alias}`
const assets = (set: Array<{ assetId: string }> | undefined) => set?.map(item => item.assetId)
const set = (...assetIds: string[]) => assetIds.map(assetId => ({ assetId }))
/** The preview's projection of a destination is the real eBay one (`projectMediaDestination` → `projectEbay`). */
const blocking = (preview: any, key: string) => preview.destinations.find((d: any) => d.key === key).checks.filter((c: any) => c.severity === 'error').map((c: any) => c.message)

describe('switching to the photo plan keeps an eBay listing\'s own photos, laid out as #355 sends them (Owner 2026-10-05)', () => {
  it('(a) a value with no photos of its own gets the gallery as its set: Main listing Nero, ALT1 Giallo — no blocking problem', async () => {
    const preview = await scoped(() => previewMediaSwitch(ids.root)) as any
    const layer = (alias: string) => preview.layers.find((l: any) => l.key === layerKey(alias))
    // Main listing: its own list is its market's Listing layer, never Shared; Nero shows the gallery.
    expect(layer('')).toMatchObject({ label: 'eBay IT', source: 'Product media' })
    expect(layer('').plan).toEqual({ version: 1, axis: 'color', sets: { common: set(ids.g1, ids.cover), values: { 'color:black': set(ids.g1, ids.cover), 'color:yellow': set(ids.g1) } } })
    expect(layer(ids.alt1).plan).toEqual({ version: 1, axis: 'color', sets: { common: set(ids.n1, ids.cover), values: { 'color:black': set(ids.n2), 'color:yellow': set(ids.n1, ids.cover) } } })
    for (const key of ['', ids.alt1]) expect(blocking(preview, layerKey(key))).toEqual([])
    expect(preview.layers.find((l: any) => l.key === 'SHARED')).toMatchObject({ source: 'library' })
    expect(assets(preview.layers.find((l: any) => l.key === 'SHARED').plan.sets.common)).toEqual([ids.cover, ids.n1, ids.n2, ids.g1])
  })

  it('(b) Nero S has its own photo and Nero M none: no Nero set — no axis, one gallery for every variation, no blocking problem', async () => {
    const preview = await scoped(() => previewMediaSwitch(ids.bolt)) as any
    const main = preview.layers.find((l: any) => l.key === layerKey(''))
    expect(main.plan).toEqual({ version: 1, axis: null, sets: { common: set(ids.b0) } })
    expect(blocking(preview, layerKey(''))).toEqual([])
    expect(preview.report).toContain('eBay IT: variations with the same Colore show different photos, so it shows its gallery for every variation — as eBay does today.')
  })

  it('every other case: an Image URLs list, a disagreement, nothing of its own, the order, unreadable lists and videos', async () => {
    const preview = await scoped(() => previewMediaSwitch(ids.root)) as any
    const layer = (alias: string) => preview.layers.find((l: any) => l.key === layerKey(alias))
    // ALT2 — its old Image URLs list, in its order (the address outside the library is imported at the switch); every
    // variation shows it, so no axis.
    expect(layer(ids.alt2).plan).toEqual({ version: 1, axis: null, sets: { common: [{ assetId: ids.cover }, { assetId: expect.stringMatching(/^import:/) }] } })
    // ALT3 — the Nero sizes disagree: no axis and no sets; its gallery follows Shared.
    expect(layer(ids.alt3).plan).toEqual({ version: 1, axis: null, sets: {} })
    for (const key of [ids.alt2, ids.alt3]) expect(blocking(preview, layerKey(key))).toEqual([])
    // ALT4 — nothing of its own: no layer, it follows the Shared photos as before.
    expect(layer(ids.alt4)).toBeUndefined()
    // Instrument control: the projection does block a listing whose values have no set — ALT4 follows a Shared layer with
    // no axis (the family's colour applies) and no value sets (the library curation, as before this change).
    expect(blocking(preview, layerKey(ids.alt4))).toEqual(expect.arrayContaining([expect.stringContaining('has no photos')]))
    // ALT5 — Product media before the adopted shell's builder rows; ALT6 — its eBay media draft before both (what Publish sends).
    expect(layer(ids.alt5)).toMatchObject({ source: 'Product media', plan: { sets: { common: set(ids.n1) } } })
    expect(layer(ids.alt6)).toMatchObject({ source: 'eBay media draft', plan: { sets: { common: set(ids.g1) } } })
    // ALT7 — an unreadable list is named and left out (the preview still works); ALT8 — a list of only a video is no list.
    expect(layer(ids.alt7)).toBeUndefined()
    expect(layer(ids.alt8)).toBeUndefined()
    expect(preview.report).toEqual(expect.arrayContaining([
      'ALT3: variations with the same Colore show different photos, so it shows its gallery for every variation — as eBay does today.',
      'ALT7: 1 saved Product media list could not be read and was left out; that row shows the listing\'s photos.',
      'ALT8: 1 saved item of its Product media is not a photo in the library and was left out.',
    ]))
    expect(preview.imports).toBe(1)
  })

  it('after the switch every row shows what eBay showed before (a variation\'s Common photos follow, muted)', async () => {
    const { revision } = await scoped(() => previewMediaSwitch(ids.root)) as any
    await scoped(() => switchToMediaPlan(ids.root, { revision }, null))
    const plan = (await scoped(() => sheetMediaPlan(ids.root)))!
    const row = (productId: string, aliasKey: string) => plan.row(productId, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey }, 'it').items
    const shown = (productId: string, aliasKey: string) => row(productId, aliasKey).filter(item => !item.muted).map(item => item.id)
    expect(shown(ids.root, '')).toEqual([ids.g1, ids.cover])
    expect(shown(ids.gm, '')).toEqual([ids.g1])
    expect(shown(ids.nm, '')).toEqual([ids.g1, ids.cover])
    expect(shown(ids.root, ids.alt1)).toEqual([ids.n1, ids.cover])
    expect(shown(ids.nl, ids.alt1)).toEqual([ids.n2])
    expect(shown(ids.gm, ids.alt1)).toEqual([ids.n1, ids.cover])
    // ALT3: one gallery for every variation (the Shared photos), as eBay showed.
    expect(row(ids.nl, ids.alt3).map(item => item.id)).toEqual([ids.cover, ids.n1, ids.n2, ids.g1])
    const imported = await scoped(() => prisma.productImage.findFirst({ where: { url: OUTSIDE } }))
    expect(shown(ids.root, ids.alt2)).toEqual([ids.cover, imported!.id])
    // NEGATIVE CONTROL — the Shared sheet still shows the Shared photos, not an eBay listing's.
    expect(plan.row(ids.root, null, 'it').items.map(item => item.id)).toEqual([ids.cover, ids.n1, ids.n2, ids.g1])
  })
})
