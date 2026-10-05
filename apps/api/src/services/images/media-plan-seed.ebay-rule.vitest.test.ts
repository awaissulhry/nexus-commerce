import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

/**
 * Owner 2026-10-05 — the photo plan switch must never block an eBay listing that #355 publishes fine. Each case is seeded
 * through the real `previewMediaSwitch` → `projectEbay`, which must name no blocking problem, and its value sets are compared
 * with what #355 sends for the same rows (`ebayVariationPhotoSets`): a value #355 sends gets the same photos (its first 12);
 * a value #355 leaves on the gallery gets the gallery (its first 12). Cases: (D) a value showing a gallery of 13, (E) an own
 * list of 13, (F) photos on the variation's product itself (its files, its saved Shared list), (C7) a value the axis
 * dictionary does not know, (X) an excluded variation. On PGlite with the real schema; nothing reaches a channel. Fake ids.
 */
const state = vi.hoisted(() => ({ db: null as any }))
vi.mock('@nexus/database', async () => {
  const { formulaDatabase } = await import('../../test-support/formula-database.js')
  state.db = await formulaDatabase()
  return { default: state.db.client }
})
vi.mock('../listing-events.service.js', () => ({ publishListingEvent: () => undefined }))
vi.mock('../pim/catalog-source-fetch.js', () => ({ fetchCatalogSource: async () => { throw new Error('no download in this gate') } }))

import prisma from '../../db.js'
import { LEGACY_WORKSPACE_ID, withWorkspace } from '../../lib/workspace-context.js'
import { previewMediaSwitch } from './media-plan-seed.service.js'
import { ebayVariationPhotoSets } from '../pim/ebay-variation-photos.js'

const scoped = <T>(work: () => Promise<T>) => withWorkspace({ workspaceId: LEGACY_WORKSPACE_ID, actorUserId: null, membershipId: null, roleKeys: [] }, work)
const url = (name: string) => `https://cdn.example/${name}.jpg`
const media = (assetIds: string[]) => ({ version: 1, items: assetIds.map(assetId => ({ assetId })) })
let account = ''

beforeAll(() => scoped(async () => {
  await prisma.marketplace.create({ data: { channel: 'EBAY', code: 'IT', name: 'eBay IT', region: 'EU', currency: 'EUR', language: 'it', languages: ['it'] } as never })
  const group = await prisma.attributeGroup.create({ data: { code: 'variation', label: 'Variation' } as never })
  const colour = await prisma.customAttribute.create({ data: { code: 'color', label: 'Colore', groupId: group.id, type: 'select', semanticKey: 'color' } as never })
  await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'black', label: 'Nero', synonyms: [], sortOrder: 1 } as never })
  await prisma.attributeOption.create({ data: { attributeId: colour.id, code: 'yellow', label: 'Giallo', synonyms: [], sortOrder: 2 } as never })
  account = (await prisma.channelConnection.create({ data: { channelType: 'EBAY', accountLabel: 'Test eBay', isActive: true, externalAccountId: 'SELLER', authStatus: 'connected', managedBy: 'oauth', region: 'IT' } as never })).id
}), 120_000)
afterAll(async () => { await state.db?.close() })

interface Variation { sku: string; colour: string; list?: string[]; files?: string[]; content?: string[]; excluded?: true }
/**
 * One family on eBay IT's Main listing: the root's photos `photos`; the Main row's own list `main` (names of root photos);
 * each variation's own listing list, own product files, own saved Shared list (names), or exclusion.
 */
async function family(code: string, photos: string[], main: string[] | null, variations: Variation[]) {
  const root = await prisma.product.create({ data: { sku: code, name: code, basePrice: 10, isParent: true, variationAxes: ['Colore'], variationAxisCodes: ['color'], imageAxisPreference: 'Color' } as never })
  const id: Record<string, string> = {}
  for (const [i, name] of photos.entries()) id[name] = (await prisma.productImage.create({ data: { productId: root.id, url: url(`${code}-${name}`), type: i ? 'ALT' : 'MAIN', sortOrder: i } as never })).id
  const listing = (productId: string, platformAttributes: Record<string, unknown>) => prisma.channelListing.create({ data: { productId, channel: 'EBAY', marketplace: 'IT', channelMarket: 'EBAY_IT',
    region: 'IT', channelConnectionId: account, platformAttributes } as never })
  await listing(root.id, main ? { _productMediaLocales: { it: { _productMedia: media(main.map(n => id[n])) } } } : {})
  const children: Record<string, string> = {}
  for (const v of variations) {
    const child = await prisma.product.create({ data: { sku: v.sku, name: v.sku, basePrice: 10, parentId: root.id, categoryAttributes: { variations: { Colore: v.colour } } } as never })
    children[v.sku] = child.id
    for (const [i, name] of (v.files ?? []).entries()) id[name] = (await prisma.productImage.create({ data: { productId: child.id, url: url(`${code}-${name}`), type: 'ALT', sortOrder: i } as never })).id
    if (v.content) await prisma.product.update({ where: { id: child.id }, data: { localizedContent: { und: { _productMedia: media(v.content.map(n => id[n])) } } } as never })
    const row = await listing(child.id, v.list ? { _productMediaLocales: { it: { _productMedia: media(v.list.map(n => id[n])) } } } : {})
    if (v.excluded) await prisma.$executeRawUnsafe('UPDATE "ChannelListing" SET "variationExcluded" = true WHERE "id" = $1', row.id)
  }
  return { rootId: root.id, children, at: (...names: string[]) => names.map(n => url(`${code}-${n}`)) }
}

/** The Main listing's layer as eBay would receive it (the real projection), its blocking problems, and the report. */
async function seeded(rootId: string) {
  const preview = await scoped(() => previewMediaSwitch(rootId)) as any
  const key = `LISTING:EBAY:IT:${account}:`
  const destination = preview.destinations.find((d: any) => d.key === key)
  const urlOf = (assetId: string) => preview.assets[assetId]?.url ?? assetId
  return { preview, layer: preview.layers.find((l: any) => l.key === key), blocking: destination.checks.filter((c: any) => c.severity === 'error').map((c: any) => c.message),
    sets: Object.fromEntries(destination.layout.sets.map((s: any) => [s.value, s.items.map(urlOf)])) as Record<string, string[]>, gallery: destination.layout.gallery.map(urlOf) as string[] }
}
/** What #355 sends for the same rows: per value its photos, else the gallery (eBay shows it); the first 12 each. */
function sent355(gallery: string[], rows: Array<{ colour: string; urls: string[] | null }>) {
  const photos = ebayVariationPhotoSets({ names: ['Colore'], gallery, chosen: 'Color',
    rows: rows.map((r, i) => ({ sku: `row-${i}`, specifics: { Colore: r.colour }, urls: r.urls ?? gallery, own: !!r.urls?.length })) })
  return { photos, byValue: Object.fromEntries([...new Set(rows.map(r => r.colour))].map(colour => [colour, (photos.sets?.byValue[colour] ?? gallery).slice(0, 12)])) }
}
const thirteen = Array.from({ length: 13 }, (_, i) => `p${i + 1}`)

describe('the switch lays out each eBay listing as #355 sends it, and never blocks it (Owner 2026-10-05)', () => {
  it('(D) a value showing a gallery of 13: its set holds the gallery\'s first 12, named in the report', async () => {
    const f = await scoped(() => family('DGAL', thirteen, thirteen, [{ sku: 'DGAL-N', colour: 'Nero', list: ['p1'] }, { sku: 'DGAL-G', colour: 'Giallo' }]))
    const { blocking, sets, gallery, preview } = await seeded(f.rootId)
    expect(blocking).toEqual([])
    expect(gallery).toEqual(f.at(...thirteen))
    const expected = sent355(gallery, [{ colour: 'Nero', urls: f.at('p1') }, { colour: 'Giallo', urls: null }])
    expect(expected.photos.sets?.byValue).toEqual({ Nero: f.at('p1') })
    expect(sets).toEqual(expected.byValue)
    expect(sets.Giallo).toHaveLength(12)
    expect(preview.report).toContain('eBay IT: Giallo: eBay shows 12 photos per value; the first 12 are used.')
  })

  it('(E) an own list of 13: its set is the first 12, the photos #355 sends', async () => {
    const f = await scoped(() => family('EOWN', [...thirteen, 'cover'], ['cover'], [
      { sku: 'EOWN-NM', colour: 'Nero', list: thirteen }, { sku: 'EOWN-NL', colour: 'Nero', list: thirteen }, { sku: 'EOWN-G', colour: 'Giallo' }]))
    const { blocking, sets, gallery, preview } = await seeded(f.rootId)
    expect(blocking).toEqual([])
    const expected = sent355(gallery, [{ colour: 'Nero', urls: f.at(...thirteen) }, { colour: 'Nero', urls: f.at(...thirteen) }, { colour: 'Giallo', urls: null }])
    expect(expected.photos.notes).toEqual(['The Nero photos: eBay shows at most 12 per variation; the first 12 of 13 are sent.'])
    expect(sets).toEqual(expected.byValue)
    expect(sets.Nero).toEqual(f.at(...thirteen.slice(0, 12)))
    expect(preview.report).toContain('eBay IT: Nero: eBay shows 12 photos per value; the first 12 are used.')
  })

  it('(F) photos on the variation\'s product itself — its files, its saved Shared list — are its photos, as #355 counts them', async () => {
    const f = await scoped(() => family('FPRD', ['r1', 'r2'], null, [{ sku: 'FPRD-N', colour: 'Nero', files: ['f1', 'f2'] }, { sku: 'FPRD-G', colour: 'Giallo', content: ['r2'] }]))
    const { blocking, sets, gallery, layer } = await seeded(f.rootId)
    expect(blocking).toEqual([])
    // No own Main list: the gallery is the Shared one (the library), and the layer owns only its value sets.
    expect(layer.plan.sets.common).toBeUndefined()
    expect(gallery).toEqual(f.at('r1', 'r2'))
    const expected = sent355(gallery, [{ colour: 'Nero', urls: f.at('f1', 'f2') }, { colour: 'Giallo', urls: f.at('r2') }])
    expect(sets).toEqual(expected.byValue)
    expect(sets).toEqual({ Nero: f.at('f1', 'f2'), Giallo: f.at('r2') })
  })

  it('(C7) a value the axis dictionary does not know: one gallery for every variation, named — not a blocked listing', async () => {
    const f = await scoped(() => family('CTXT', ['m1', 'v1'], ['m1'], [{ sku: 'CTXT-V', colour: 'Viola', list: ['v1'] }, { sku: 'CTXT-N', colour: 'Nero' }]))
    const { blocking, sets, layer, preview } = await seeded(f.rootId)
    expect(blocking).toEqual([])
    expect(layer.plan).toEqual({ version: 1, axis: null, sets: { common: [{ assetId: expect.any(String) }] } })
    expect(sets).toEqual({})
    expect(preview.report).toContain('eBay IT: "Viola" is not a known option of Colore, so it shows its gallery for every variation. Map it in the variation theme to give each Colore its photos.')
  })

  it('(X) a variation the listing leaves out does not count: the Nero rows left agree, as #355 sees them', async () => {
    const f = await scoped(() => family('XEXC', ['m1', 'a1', 'a2'], ['m1'], [
      { sku: 'XEXC-NM', colour: 'Nero', list: ['a1'] }, { sku: 'XEXC-NL', colour: 'Nero', list: ['a2'], excluded: true }, { sku: 'XEXC-G', colour: 'Giallo' }]))
    const { blocking, sets, gallery } = await seeded(f.rootId)
    expect(blocking).toEqual([])
    const expected = sent355(gallery, [{ colour: 'Nero', urls: f.at('a1') }, { colour: 'Giallo', urls: null }])
    expect(sets).toEqual(expected.byValue)
    expect(sets).toEqual({ Nero: f.at('a1'), Giallo: f.at('m1') })
  })
})
