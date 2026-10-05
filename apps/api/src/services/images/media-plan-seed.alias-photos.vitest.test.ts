import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import sharp from 'sharp'

/**
 * Owner 2026-10-05 — moving a family onto the photo plan keeps every eBay alias's own photos (Product media is the one photo
 * source): an alias with no old builder rows and no old eBay media draft keeps its own Product media list, or its old Image
 * URLs list, as its Listing layer, so each of its rows shows the photos it showed before. On PGlite with the real schema;
 * photo downloads are replaced by generated images; nothing reaches a channel. Fake ids and addresses only.
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

beforeAll(async () => {
  await scoped(async () => {
    await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', synonyms: [], sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', synonyms: [], sortOrder: 2 } as never })
    ids.root = (await prisma.product.create({ data: { sku: 'KNEE', name: 'Knee slider', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'], imageAxisPreference: 'Color' } as never })).id
    for (const [key, sku, value] of [['nm', 'KNEE-NERO-M', 'Nero'], ['nl', 'KNEE-NERO-L', 'Nero'], ['gm', 'KNEE-GIALLO-M', 'Giallo']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: ids.root, categoryAttributes: { variations: { Colore: value } } } as never })).id
    for (const [index, name] of ['cover', 'n1', 'n2', 'g1'].entries())
      ids[name] = (await prisma.productImage.create({ data: { productId: ids.root, url: url(name), type: index ? 'ALT' : 'MAIN', sortOrder: index } as never })).id
    ids.ebay = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
    const alias = async (label: string, position: number) => (await prisma.productListingAlias.create({ data: { productId: ids.root, channel: 'EBAY', marketplace: 'IT', channelConnectionId: ids.ebay, label, position } as never })).id
    // The MAIN eBay listing: Product media on its main row and on Giallo M (no eBay media draft anywhere).
    // ALT1: Product media on its main row and on both Nero sizes (the same list); Giallo follows.
    // ALT2: its old Image URLs list (one photo outside the library). ALT3: the two Nero sizes disagree. ALT4: nothing of its own.
    ids.alt1 = await alias('ALT1', 1); ids.alt2 = await alias('ALT2', 2); ids.alt3 = await alias('ALT3', 3); ids.alt4 = await alias('ALT4', 4)
    const own: Record<string, Record<string, unknown>> = {
      [`:${ids.root}`]: productMedia(ids.g1, ids.cover), [`:${ids.gm}`]: productMedia(ids.g1),
      [`${ids.alt1}:${ids.root}`]: productMedia(ids.n1, ids.cover), [`${ids.alt1}:${ids.nm}`]: productMedia(ids.n2), [`${ids.alt1}:${ids.nl}`]: productMedia(ids.n2),
      [`${ids.alt2}:${ids.root}`]: { imageUrls: [url('cover'), OUTSIDE] },
      [`${ids.alt3}:${ids.nm}`]: productMedia(ids.n2), [`${ids.alt3}:${ids.nl}`]: productMedia(ids.g1),
    }
    for (const p of [ids.root, ids.nm, ids.nl, ids.gm]) for (const aliasKey of ['', ids.alt1, ids.alt2, ids.alt3, ids.alt4])
      await prisma.channelListing.create({ data: { productId: p, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT', region: 'IT', channelConnectionId: ids.ebay,
        platformAttributes: own[`${aliasKey}:${p}`] ?? {}, ...(aliasKey ? { aliasId: aliasKey, aliasKey } : {}) } as never })
  })
}, 120_000)
afterAll(async () => { await state.db?.close() })

const layerKey = (alias: string) => `LISTING:EBAY:IT:${ids.ebay}:${alias}`
const assets = (set: Array<{ assetId: string }> | undefined) => set?.map(item => item.assetId)

describe('switching to the photo plan keeps an eBay alias\'s and main listing\'s own photos (Owner 2026-10-05)', () => {
  it('the preview: each alias and main listing with photos of its own gets a Listing layer holding exactly them; one with none follows', async () => {
    const preview = await scoped(() => previewMediaSwitch(ids.root)) as any
    const layer = (alias: string) => preview.layers.find((l: any) => l.key === layerKey(alias))
    // ALT1 — its main row's list is Common; both Nero sizes hold the same list, so it is Nero's set (eBay shows photos per value).
    expect(layer(ids.alt1)).toMatchObject({ label: 'ALT1', source: 'Product media' })
    expect(layer(ids.alt1).plan).toEqual({ version: 1, axis: 'color', sets: { common: [{ assetId: ids.n1 }, { assetId: ids.cover }], values: { 'color:black': [{ assetId: ids.n2 }] } } })
    // ALT2 — its old Image URLs list, in its order; the address outside the library is imported at the switch.
    expect(assets(layer(ids.alt2).plan.sets.common)).toEqual([ids.cover, expect.stringMatching(/^import:/)])
    expect(layer(ids.alt2).plan.axis).toBeUndefined()
    // ALT3 — the Nero sizes disagree: each keeps its own list as its SKU set; no Common of its own (it follows).
    expect(layer(ids.alt3).plan).toEqual({ version: 1, sets: { skus: { [ids.nm]: [{ assetId: ids.n2 }], [ids.nl]: [{ assetId: ids.g1 }] } } })
    // NEGATIVE CONTROL — ALT4 has no photos of its own: no layer, it follows the Shared photos as before.
    expect(layer(ids.alt4)).toBeUndefined()
    // The MAIN listing's own list is its market's Listing layer (LISTING:EBAY:IT:<account>:''), never Shared: Shared keeps the
    // family's library order, which every other channel and market follows as before.
    expect(layer('')).toMatchObject({ label: 'eBay IT', source: 'Product media' })
    expect(layer('').plan).toEqual({ version: 1, axis: 'color', sets: { common: [{ assetId: ids.g1 }, { assetId: ids.cover }], values: { 'color:yellow': [{ assetId: ids.g1 }] } } })
    expect(assets(preview.layers.find((l: any) => l.key === 'SHARED').plan.sets.common)).toEqual([ids.cover, ids.n1, ids.n2, ids.g1])
    expect(preview.layers.find((l: any) => l.key === 'SHARED').source).toBe('library')
    expect(preview.imports).toBe(1)
    expect(preview.destinations.find((d: any) => d.key === layerKey(ids.alt1)).source).toBe('Product media (ALT1)')
  })

  it('after the switch every row shows the photos eBay showed before (a variant\'s Common photos follow, muted)', async () => {
    const { revision } = await scoped(() => previewMediaSwitch(ids.root)) as any
    await scoped(() => switchToMediaPlan(ids.root, { revision }, null))
    const plan = (await scoped(() => sheetMediaPlan(ids.root)))!
    const row = (productId: string, aliasKey: string) => plan.row(productId, { channel: 'EBAY', marketplace: 'IT', accountId: ids.ebay, aliasKey }, 'it').items
    expect(row(ids.root, ids.alt1).map(item => item.id)).toEqual([ids.n1, ids.cover])
    // The main listing: its own list; Giallo its own photo; Nero (none of its own) shows the listing's gallery, as on eBay.
    expect(row(ids.root, '').map(item => item.id)).toEqual([ids.g1, ids.cover])
    expect(row(ids.gm, '').filter(item => !item.muted).map(item => item.id)).toEqual([ids.g1])
    expect(row(ids.nm, '').map(item => [item.id, !!item.muted])).toEqual([[ids.g1, true], [ids.cover, true]])
    // NEGATIVE CONTROL — the Shared sheet (no channel) still shows the Shared photos, not the eBay listing's.
    expect(plan.row(ids.root, null, 'it').items.map(item => item.id)).toEqual([ids.cover, ids.n1, ids.n2, ids.g1])
    expect(row(ids.nm, ids.alt1).filter(item => !item.muted).map(item => item.id)).toEqual([ids.n2])
    expect(row(ids.nl, ids.alt1).filter(item => !item.muted).map(item => item.id)).toEqual([ids.n2])
    expect(row(ids.nl, ids.alt3).filter(item => !item.muted).map(item => item.id)).toEqual([ids.g1])
    const imported = await scoped(() => prisma.productImage.findFirst({ where: { url: OUTSIDE } }))
    expect(row(ids.root, ids.alt2).map(item => item.id)).toEqual([ids.cover, imported!.id])
  })
})
