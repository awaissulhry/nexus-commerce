import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * Images rebuild P4d — the Amazon ZIPs for Seller Central, with the real schema, the real tenant policies and the real
 * plan projection and the real JPEG archive engine. Only the photo download is replaced (it would reach the network):
 * the stand-in serves a small PNG, records each address, and can change the plan while it "downloads", as a colleague
 * on the Media page could.
 */
const state = vi.hoisted(() => ({ db: null as any, fetched: [] as string[], during: null as null | (() => Promise<unknown>), failFetch: false, languageFault: false }))
vi.mock('@nexus/database', async () => {
  const { concurrentDatabase, concurrentDatabaseUrl } = await import('../../test-support/concurrent-database.js')
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = concurrentDatabaseUrl() ? await concurrentDatabase() : await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../product-event.service.js', () => ({ productEventService: { emit: async () => undefined } }))
// A database fault while reading the market's languages must stay a fault, not become "no language set" (the
// one-market read only; the page's batch read takes its rows as a third argument).
vi.mock('../pim/market-languages.js', async original => {
  const real = await original<typeof import('../pim/market-languages.js')>()
  return { ...real, marketLanguages: ((...args: Parameters<typeof real.marketLanguages>) => state.languageFault && args.length === 2 ? Promise.reject(new Error('connection lost')) : real.marketLanguages(...args)) as typeof real.marketLanguages }
})
vi.mock('../pim/catalog-source-fetch.js', () => ({
  fetchCatalogSource: async (url: string) => {
    state.fetched.push(url)
    if (state.failFetch) throw new Error('Source returned HTTP 404; redirects are not followed')
    const during = state.during
    state.during = null
    if (during) await during()
    const sharp = (await import('sharp')).default
    return { buffer: await sharp({ create: { width: 24, height: 24, channels: 3, background: '#808080' } }).png().toBuffer() }
  },
}))

import JSZip from 'jszip'
import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { applyMediaPlanOps } from './media-plan.service.js'
import { amazonArchiveDownload, amazonArchivePreview } from './media-plan-archive.service.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const ids: Record<string, string> = {}
const img: Record<string, string> = {}
const shared = (ops: any[]) => scoped(() => applyMediaPlanOps(ids.root, { address: { layer: 'SHARED' }, ops }, null))
const preview = (market: string, kind: 'slots' | 'safety' | 'country') => scoped(() => amazonArchivePreview(ids.root, { accountId: ids.amazon, market, kind }))
const download = (market: string, kind: 'slots' | 'safety' | 'country', digest: string) => scoped(() => amazonArchiveDownload(ids.root, { accountId: ids.amazon, market, kind, digest }))

beforeAll(async () => {
  await scoped(async () => {
    for (const [code, language] of [['IT', 'it'], ['DE', 'de']])
      await prisma.marketplace.create({ data: { channel: 'AMAZON', code, name: `Amazon ${code}`, region: 'EU', currency: 'EUR', language, languages: [language] } as never })
    const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
    const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', sortOrder: 1 } as never })
    await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', sortOrder: 2 } as never })
    const root = await prisma.product.create({ data: { sku: 'JACKET', name: 'Jacket', basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'] } as never })
    ids.root = root.id
    for (const [key, sku, value] of [['nm', 'JACKET-NERO-M', 'Nero'], ['nl', 'JACKET-NERO-L', 'Nero'], ['gm', 'JACKET-GIALLO-M', 'Giallo']])
      ids[key] = (await prisma.product.create({ data: { sku, name: sku, basePrice: 10, parentId: root.id, categoryAttributes: { variations: { Colore: value } } } as never })).id
    for (const name of ['cover', 'n1', 'g1', 'chart-it', 'chart-de', 'ps1'])
      img[name] = (await prisma.productImage.create({ data: { productId: root.id, url: `https://cdn.example/${name}.jpg`, alt: name, type: 'ALT', width: 1600, height: 1600,
        ...(name.startsWith('chart') ? { languageTag: name.slice(6), versionGroupId: 'chart' } : {}) } as never })).id
    ids.amazon = (await prisma.channelConnection.create({ data: { channelType: 'AMAZON', accountLabel: 'Test Amazon', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'EU' } as never })).id
    // Fake ASINs (B0FX…). IT: the Nero L ASIN is only in platformProductId (the Amazon workspace's fallback); Giallo M
    // has none yet. DE lists the parent and Nero M only.
    const listing = (productId: string, marketplace: string, asin: { externalListingId?: string; platformProductId?: string } = {}) => prisma.channelListing.create({ data: {
      productId, channel: 'AMAZON', marketplace, channelMarket: `AMAZON_${marketplace}`, region: marketplace, channelConnectionId: ids.amazon, ...asin } as never })
    await listing(ids.root, 'IT', { externalListingId: 'B0FXPARNT1' })
    await listing(ids.nm, 'IT', { externalListingId: 'B0FXNEROM1' })
    await listing(ids.nl, 'IT', { platformProductId: 'B0FXNEROL1' })
    await listing(ids.gm, 'IT')
    await listing(ids.root, 'DE', { externalListingId: 'B0FXPARNT1' })
    await listing(ids.nm, 'DE', { externalListingId: 'B0FXNEROM1' })
  })
}, 120_000)
beforeEach(() => { state.fetched.length = 0; state.during = null; state.failFetch = false; state.languageFault = false })
afterAll(async () => { await state.db?.close() })

describe('Amazon ZIPs for Seller Central (P4d)', () => {
  it('refuses a family that is not on the photo plan yet', async () => {
    await expect(preview('IT', 'slots')).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/does not use the photo plan/) })
  })

  it('names each file ASIN.SLOT.jpg from the market\'s own listings, and names the SKUs left out', async () => {
    await shared([
      { op: 'insert', set: 'common', assetIds: [img.cover, img['chart-it']] },
      { op: 'insert', set: 'value:color:black', assetIds: [img.n1] },
      { op: 'insert', set: 'value:color:yellow', assetIds: [img.g1] },
      { op: 'insert', set: 'safety', assetIds: [img.ps1] },
    ])
    const it = await preview('it', 'slots')
    // The API sends one version to every market: IT has the most listings, so Italian.
    expect(it).toMatchObject({ market: 'IT', kind: 'slots', language: 'it', apiLanguage: 'it', apiMarket: 'IT', issues: [], warnings: [],
      skipped: ['JACKET-GIALLO-M: its Amazon IT listing has no ASIN yet — left out.'] })
    expect(it.files.map(f => `${f.name}=${f.photo}`)).toEqual([
      'B0FXPARNT1.MAIN.jpg=cover', 'B0FXPARNT1.PT01.jpg=chart-it',
      'B0FXNEROL1.MAIN.jpg=n1', 'B0FXNEROL1.PT01.jpg=cover', 'B0FXNEROL1.PT02.jpg=chart-it',
      'B0FXNEROM1.MAIN.jpg=n1', 'B0FXNEROM1.PT01.jpg=cover', 'B0FXNEROM1.PT02.jpg=chart-it',
    ])
    expect(it.digest).toMatch(/^[a-f0-9]{64}$/)
    expect(it.filename).toBe(`amazon-IT-photos-${it.digest.slice(0, 10)}.zip`)
    // DE reads DE's listings: Nero L and Giallo M are not listed there, so they are left out and named.
    const de = await preview('DE', 'slots')
    expect(de.files.map(f => f.name)).toEqual(['B0FXPARNT1.MAIN.jpg', 'B0FXPARNT1.PT01.jpg', 'B0FXNEROM1.MAIN.jpg', 'B0FXNEROM1.PT01.jpg', 'B0FXNEROM1.PT02.jpg'])
    expect(de.skipped).toEqual(['JACKET-GIALLO-M: not listed on Amazon DE — left out.', 'JACKET-NERO-L: not listed on Amazon DE — left out.'])
    expect(de).toMatchObject({ language: 'de', apiLanguage: 'it', apiMarket: 'IT' })
    expect(de.digest).not.toBe(it.digest)
  })

  it('safety images go PS01… on every ASIN of the market', async () => {
    const safety = await preview('IT', 'safety')
    expect(safety.files.map(f => `${f.name}=${f.photo}`)).toEqual(['B0FXPARNT1.PS01.jpg=ps1', 'B0FXNEROL1.PS01.jpg=ps1', 'B0FXNEROM1.PS01.jpg=ps1'])
    expect(safety.filename).toMatch(/^amazon-IT-safety-[a-f0-9]{10}\.zip$/)
  })

  it('a country ZIP holds only the photos with a version in the market\'s language', async () => {
    const de = await preview('DE', 'country')
    expect(de).toMatchObject({ language: 'de', issues: [] })
    expect(de.files.map(f => `${f.name}=${f.photo}`)).toEqual(['B0FXPARNT1.PT01.jpg=chart-de', 'B0FXNEROM1.PT02.jpg=chart-de'])
    // Italian is the version the API already sends, so Italy has no country photos.
    expect((await preview('IT', 'country')).files).toEqual([])
    await expect(download('IT', 'country', (await preview('IT', 'country')).digest)).rejects.toMatchObject({ statusCode: 422, message: 'This ZIP has no photos, so none was made.' })
  })

  it('a market with no content language is refused with a sentence, not a server fault', async () => {
    await scoped(() => prisma.marketplace.updateMany({ where: { channel: 'AMAZON', code: 'DE' }, data: { language: '', languages: [] } as never }))
    try {
      await expect(preview('DE', 'country')).rejects.toMatchObject({ statusCode: 422, message: expect.stringMatching(/Amazon DE has no language set/) })
    } finally {
      await scoped(() => prisma.marketplace.updateMany({ where: { channel: 'AMAZON', code: 'DE' }, data: { language: 'de', languages: ['de'] } as never }))
    }
  })

  it('a database fault while reading the languages stays a fault', async () => {
    state.languageFault = true
    await expect(preview('DE', 'country')).rejects.toThrow('connection lost')
  })

  it('refuses a market where this account has no listing of the product', async () => {
    await expect(preview('FR', 'slots')).rejects.toMatchObject({ statusCode: 404 })
  })

  it('downloads exactly the previewed files as real JPEGs, each photo fetched once', async () => {
    const it = await preview('IT', 'slots')
    const archive = await download('IT', 'slots', it.digest)
    expect(archive).toMatchObject({ filename: it.filename, fileCount: 8 })
    expect([...state.fetched].sort()).toEqual(['https://cdn.example/chart-it.jpg', 'https://cdn.example/cover.jpg', 'https://cdn.example/n1.jpg'])
    const zip = await JSZip.loadAsync(archive.buffer)
    expect(Object.keys(zip.files)).toEqual(it.files.map(f => f.name))
    for (const name of Object.keys(zip.files)) expect([...(await zip.file(name)!.async('uint8array')).slice(0, 3)]).toEqual([0xff, 0xd8, 0xff])
  })

  it('one photo that cannot be downloaded stops the whole ZIP, and names that photo and its file', async () => {
    const it = await preview('IT', 'slots')
    state.failFetch = true
    await expect(download('IT', 'slots', it.digest)).rejects.toMatchObject({ statusCode: 422,
      message: 'cover (B0FXPARNT1 MAIN): Source returned HTTP 404; redirects are not followed. No ZIP was saved.' })
  })

  it('refuses a digest that is not the current preview\'s, and builds nothing', async () => {
    const it = await preview('IT', 'slots')
    await shared([{ op: 'insert', set: 'value:color:black', assetIds: [img.g1] }])
    await expect(download('IT', 'slots', it.digest)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed since the preview/) })
    await expect(download('IT', 'slots', '0'.repeat(64))).rejects.toMatchObject({ statusCode: 409 })
    expect(state.fetched).toHaveLength(0)
    await shared([{ op: 'remove', set: 'value:color:black', assetId: img.g1 }])
  })

  it('refuses an archive whose photos changed while it was built', async () => {
    const it = await preview('IT', 'slots')
    state.during = () => shared([{ op: 'reorder', set: 'common', assetIds: [img['chart-it'], img.cover] }])
    await expect(download('IT', 'slots', it.digest)).rejects.toMatchObject({ statusCode: 409, message: expect.stringMatching(/changed while the ZIP was made/) })
    expect(state.fetched.length).toBeGreaterThan(0)
    await shared([{ op: 'reorder', set: 'common', assetIds: [img.cover, img['chart-it']] }])
    expect((await preview('IT', 'slots')).digest).toBe(it.digest)
  })

  it('refuses to download when two SKUs on one ASIN would get different photos', async () => {
    await scoped(() => prisma.channelListing.updateMany({ where: { productId: ids.nl, channel: 'AMAZON', marketplace: 'IT' }, data: { platformProductId: 'B0FXNEROM1' } }))
    await shared([{ op: 'replace', set: `sku:${ids.nl}`, assetIds: [img.g1] }])
    try {
      const clash = await preview('IT', 'slots')
      expect(clash.issues).toEqual(['B0FXNEROM1 MAIN: JACKET-NERO-L and JACKET-NERO-M share this ASIN but get different photos. Give them the same photos first.'])
      await expect(download('IT', 'slots', clash.digest)).rejects.toMatchObject({ statusCode: 422 })
      expect(state.fetched).toHaveLength(0)
    } finally {
      await shared([{ op: 'follow', set: `sku:${ids.nl}` }])
      await scoped(() => prisma.channelListing.updateMany({ where: { productId: ids.nl, channel: 'AMAZON', marketplace: 'IT' }, data: { platformProductId: 'B0FXNEROL1' } }))
    }
  })
})
