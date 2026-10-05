import { createHash } from 'node:crypto'
import sharp from 'sharp'
import prisma from '../../db.js'
import { mediaLayerKey, mediaPlanSchema, type MediaLayer, type MediaPlan, type MediaPlanStack } from '@nexus/shared/media-plan'
import { projectMediaDestination, type MediaAsset } from '@nexus/shared/media-plan-channels'
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'
import { axisSynonymKey } from '../ebay-theme-axes.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { fetchCatalogSource } from '../pim/catalog-source-fetch.js'
import { publishListingEvent } from '../listing-events.service.js'
import { aHashBuffer, dHash256Buffer, sha256Buffer } from './image-hash.service.js'
import { familyRoot, loadDestinations, loadFamily, loadLibrary, planValueKey } from './media-plan.service.js'
import { libraryEntries } from './media-library-identity.js'
import { normalizeAmazonImageUrl } from './normalize-amazon-image-url.js'
import { legacyImageUrls } from './listing-photos.pure.js'
import { mediaObject, readMediaCollection } from '@nexus/shared/product-media'

/**
 * Images rebuild P3a (docs/images-studio-rebuild/P3-PLAN.md) — move ONE family onto the media plan, explicitly.
 *
 * The seed copies the family's current curation, in this order: the previous edit page's eBay builder rows, else the
 * eBay media draft of the primary listing, else the library order. Every adopted shell alias (and any other listing with
 * its own draft) gets a Listing layer holding exactly its photos, their URLs imported into the family library. An eBay
 * alias or main listing with neither keeps its own Product media (or its old Image URLs list) the same way (Owner 2026-10-05).
 * `previewMediaSwitch` writes nothing; `switchToMediaPlan` writes only when the preview's revision still holds. Nothing
 * is sent to any channel — publishing stays its own click.
 */

type Source = 'old eBay builder' | 'eBay media draft' | 'library' | 'Product media'
/** `common` null = the layer owns no Common set (it follows). A value's `key` is its plan key when it is known already.
 *  `noAxis`: the layer shows one gallery for every variation (plan `axis: null`), as eBay does when no axis fits. */
interface Curation { source: Source; axisLabel: string | null; common: string[] | null; values: Array<{ text: string; urls: string[]; key?: string }>; noAxis?: true }
interface SeedLayer { address: { layer: MediaLayer; channel: string; marketplace: string; accountId: string; aliasKey: string }; plan: MediaPlan; source: Source; label: string }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const unique = (list: string[]) => [...new Set(list)]
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** The previous edit page's eBay builder rows of one product (the family root or an old shell). */
async function builderCuration(productId: string, preferredAxis: string | null, report: string[], label: string): Promise<Curation | null> {
  const rows = await prisma.listingImage.findMany({ where: { productId, platform: 'EBAY', variationId: null, mediaType: 'IMAGE' },
    orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { url: true, variantGroupKey: true, variantGroupValue: true } })
  if (!rows.length) return null
  // The builder showed ONE axis spelling (the product's preference), but the old eBay publisher sent every row whose axis
  // is a synonym of the listing's ("Color", "Colore"), merged per value in position order with repeated photos dropped
  // (ebay-shared-image-publish.service.ts). The plan takes exactly that, so the switch keeps what eBay was sent; rows
  // under a different axis were never sent as that axis — they are left out and named.
  const keys = rows.map(r => r.variantGroupKey).filter((k): k is string => !!k)
  const counts = new Map<string, number>(); for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  const axisLabel = (preferredAxis && counts.has(preferredAxis) ? preferredAxis : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]) ?? null
  const sameAxis = (key: string | null) => !!key && !!axisLabel && axisSynonymKey(key) === axisSynonymKey(axisLabel)
  const spellings = [...new Set(keys.filter(k => k !== axisLabel && sameAxis(k)))]
  const taken = keys.filter(k => k !== axisLabel && sameAxis(k)).length
  if (taken) report.push(`${label}: ${taken} photo${taken > 1 ? 's' : ''} saved under ${spellings.map(k => `"${k}"`).join(', ')} (the same axis as "${axisLabel}") ${taken > 1 ? 'were' : 'was'} taken in, as the old eBay publisher sent ${taken > 1 ? 'them' : 'it'}; repeats were dropped.`)
  const skipped = keys.filter(k => !sameAxis(k)).length
  if (skipped) report.push(`${label}: ${skipped} older photo${skipped > 1 ? 's' : ''} saved under another axis (${[...new Set(keys.filter(k => !sameAxis(k)))].map(k => `"${k}"`).join(', ')}) ${skipped > 1 ? 'were' : 'was'} left out.`)
  const values: Curation['values'] = []
  for (const row of rows.filter(r => sameAxis(r.variantGroupKey) && r.variantGroupValue)) {
    const found = values.find(v => v.text === row.variantGroupValue)
    if (found) found.urls.push(row.url); else values.push({ text: row.variantGroupValue!, urls: [row.url] })
  }
  return { source: 'old eBay builder', axisLabel, common: unique(rows.filter(r => !r.variantGroupKey).map(r => r.url)), values }
}

/** The eBay media draft stored on one listing (`_mediaGalleryDraft`). */
function draftCuration(platformAttributes: unknown): Curation | null {
  const draft = obj(obj(platformAttributes)._mediaGalleryDraft)
  if (!Array.isArray(draft.galleries)) return null
  const axis = typeof draft.axis === 'string' ? draft.axis : null
  const galleries = (draft.galleries as unknown[]).map(obj)
  const urls = (g: Record<string, unknown>) => (Array.isArray(g.images) ? g.images : []).map(i => String(obj(i).url ?? '')).filter(Boolean)
  return { source: 'eBay media draft', axisLabel: axis, common: unique(galleries.filter(g => g.axis === null).flatMap(urls)),
    values: galleries.filter(g => axis && g.axis === axis && typeof g.value === 'string').map(g => ({ text: String(g.value), urls: urls(g) })) }
}

/**
 * An eBay listing row's own photo list, as Product media shows and Publish sends it: its old Image URLs list while that is
 * still the list sent, else its own Product media in the market's language (or for every language). `urls` undefined = it
 * has none (it shows the listing's gallery): no list, an unreadable one (`unreadable`), or one with no photo in the library
 * (only videos or missing files). Photos only — eBay takes no video; `dropped` counts what was left out.
 */
function ownPhotoUrls(platformAttributes: unknown, language: string, urlOf: ReadonlyMap<string, string>): { urls?: string[]; dropped: number; unreadable?: true } {
  const legacy = legacyImageUrls(platformAttributes)
  if (legacy) return { urls: legacy, dropped: 0 }
  const own = mediaObject(platformAttributes)._productMediaLocales
  let collection: ReturnType<typeof readMediaCollection>
  try { collection = own === undefined ? undefined : readMediaCollection(own, language) ?? readMediaCollection(own, 'und') }
  catch { return { dropped: 0, unreadable: true } }
  if (!collection) return { dropped: 0 }
  const urls = collection.items.flatMap(item => urlOf.has(item.assetId) ? [urlOf.get(item.assetId)!] : [])
  const dropped = collection.items.length - urls.length
  return collection.items.length && !urls.length ? { dropped } : { urls, dropped }
}

export async function buildMediaSeed(productId: string) {
  const rootId = await familyRoot(productId)
  const fam = await loadFamily(rootId)
  const ids = [rootId, ...fam.root.children.map(c => c.id)]
  const [library, { destinations, mainLanguage }, switched, root, aliases, ebayRoots] = await Promise.all([
    loadLibrary(ids), loadDestinations(ids),
    prisma.productMediaPlan.count({ where: { productId: rootId, layer: 'SHARED' } }),
    prisma.product.findUniqueOrThrow({ where: { id: rootId }, select: { imageAxisPreference: true } }),
    prisma.productListingAlias.findMany({ where: { productId: rootId, status: 'ACTIVE' }, orderBy: { position: 'asc' },
      select: { id: true, label: true, channel: true, marketplace: true, channelConnectionId: true, adoptedFromProductId: true } }),
    prisma.channelListing.findMany({ where: { productId: rootId, channel: 'EBAY' }, orderBy: { id: 'asc' },
      select: { marketplace: true, channelConnectionId: true, aliasKey: true, platformAttributes: true } }),
  ])
  // Owner 2026-10-05 — every eBay row of the family (each listing's main row and its variations): their own Product media is kept.
  const ebayRows = ebayRoots.length || aliases.some(a => a.channel === 'EBAY') ? await prisma.channelListing.findMany({ where: { productId: { in: ids }, channel: 'EBAY' },
    orderBy: { id: 'asc' }, select: { productId: true, marketplace: true, channelConnectionId: true, aliasKey: true, platformAttributes: true } }) : []
  const report: string[] = []
  // One picture stored on several SKUs is one photo: the plan points at its library card (the root's own row first).
  const pictures = libraryEntries(library, rootId, new Set())
  const card = new Map(pictures.flatMap(p => [[p.id, p.id] as const, ...p.copies.map(c => [c, p.id] as const)]))
  const byUrl = new Map(library.map(a => [normalizeAmazonImageUrl(a.url), card.get(a.id)!]))
  const imports = new Map<string, string>()
  const assetFor = (url: string) => byUrl.get(normalizeAmazonImageUrl(url)) ?? imports.get(url) ?? (imports.set(url, `import:${sha(url).slice(0, 20)}`), imports.get(url)!)

  const axisOf = (label: string | null) => label ? fam.axes.find(a => a.code === label || canonicalVariantAxis(a.label) === canonicalVariantAxis(label)) : undefined
  const toPlan = (curation: Curation, label: string): MediaPlan => {
    const axis = axisOf(curation.axisLabel)
    if (curation.values.length && !axis) report.push(`${label}: photos were grouped by "${curation.axisLabel}", which is not a variation axis of this family; those sets were left out.`)
    const values: Record<string, string[]> = {}
    if (axis) for (const value of curation.values) {
      const key = value.key ?? planValueKey(axis.code, value.text, fam.attributes.find(a => a.code === axis.code)).key
      values[key] = unique([...(values[key] ?? []), ...value.urls.map(assetFor)])
    }
    const item = (ids: string[]) => ids.map(assetId => ({ assetId }))
    return mediaPlanSchema.parse({ version: 1, ...(curation.noAxis ? { axis: null } : axis ? { axis: axis.code } : {}), sets: { ...(curation.common ? { common: item(unique(curation.common.map(assetFor))) } : {}),
      ...(Object.keys(values).length ? { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, item(v)])) } : {}) } })
  }

  /**
   * Owner 2026-10-05 — an eBay listing's own photos off the plan (Product media is the one photo source, #355), for an alias
   * or a Main listing (`aliasKey` ''), laid out the way #355's Publish lays them out (`ebayVariationPhotoSets`):
   * - the Main row's own list is the listing's Common set (its gallery); without one, the gallery is the Shared Common;
   * - a variation with no own list (none, an empty one, only videos) shows the gallery;
   * - every variation showing the gallery → one gallery for all (`axis: null`), as eBay shows today;
   * - else, under the chosen photo axis (`_imageAxis`, else the product's choice; else each axis in turn), when every
   *   variation of a value shows the same photos: that axis, and a set for EVERY value (its photos, or the gallery);
   * - else no axis fits: one gallery for all (`axis: null`), as #355 sends no colour photos then.
   * Null when no row of the listing has photos of its own (it follows the Shared photos, before and after).
   */
  const urlOf = new Map(library.filter(a => (a.mediaType ?? 'IMAGE') === 'IMAGE').map(a => [a.id, a.url]))
  /** One photo, whatever its address: its library card, else the address (never imports anything). */
  const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((url, i) => (byUrl.get(normalizeAmazonImageUrl(url)) ?? url) === (byUrl.get(normalizeAmazonImageUrl(b[i])) ?? b[i]))
  const productMediaCuration = (listing: { marketplace: string; accountId: string; aliasKey: string; label: string }, sharedCommon: string[]): Curation | null => {
    // An alias id names one account and market; a Main listing is the account's and market's row with no alias.
    const rows = ebayRows.filter(l => l.aliasKey === listing.aliasKey && (listing.aliasKey !== '' || (l.marketplace === listing.marketplace && l.channelConnectionId === listing.accountId)))
    if (!rows.length) return null
    const key = mediaLayerKey({ layer: 'LISTING', channel: 'EBAY', marketplace: listing.marketplace, accountId: listing.accountId, aliasKey: listing.aliasKey })
    const language = destinations.find(d => d.key === key)?.languages[0] ?? mainLanguage
    let dropped = 0, unreadable = 0
    const own = (row: (typeof rows)[number] | undefined) => {
      if (!row) return undefined
      const found = ownPhotoUrls(row.platformAttributes, language, urlOf)
      dropped += found.dropped; if (found.unreadable) unreadable++
      return found.urls
    }
    const mainRow = rows.find(l => l.productId === rootId)
    const mainOwn = own(mainRow)
    const gallery = mainOwn ?? sharedCommon
    const variants = fam.family.variants.flatMap(variant => {
      const row = rows.find(l => l.productId === variant.productId)
      if (!row) return []
      const urls = own(row)
      return [{ variant, own: !!urls?.length, shown: urls?.length ? urls : gallery }]
    })
    if (dropped) report.push(`${listing.label}: ${dropped} saved item${dropped > 1 ? 's' : ''} of its Product media ${dropped > 1 ? 'are' : 'is'} not a photo in the library and ${dropped > 1 ? 'were' : 'was'} left out.`)
    if (unreadable) report.push(`${listing.label}: ${unreadable} saved Product media list${unreadable > 1 ? 's' : ''} could not be read and ${unreadable > 1 ? 'were' : 'was'} left out; ${unreadable > 1 ? 'those rows show' : 'that row shows'} the listing's photos.`)
    if (mainOwn === undefined && !variants.some(v => v.own)) return null
    const common = mainOwn ?? null
    if (variants.every(v => sameList(v.shown, gallery))) return { source: 'Product media', axisLabel: null, common, values: [], noAxis: true }
    const chosenText = [mediaObject(mainRow?.platformAttributes)._imageAxis, root.imageAxisPreference].find((a): a is string => typeof a === 'string' && !!a.trim())?.trim() ?? null
    const chosen = axisOf(chosenText)
    for (const axis of chosen ? [chosen] : fam.axes) {
      const byValue = new Map<string, string[]>()
      const fits = variants.every(({ variant, shown }) => {
        const value = variant.values[axis.code]
        if (!value) return false
        const held = byValue.get(value)
        if (!held) { byValue.set(value, shown); return true }
        return sameList(held, shown)
      })
      if (fits) return { source: 'Product media', axisLabel: axis.code, common, values: [...byValue].map(([value, urls]) => ({ text: fam.family.valueLabels[value] ?? value, key: value, urls })) }
    }
    const name = chosen?.label ?? fam.axes.map(a => a.label).join(' or ')
    report.push(`${listing.label}: variations with the same ${name || 'value'} show different photos, so it shows its gallery for every variation — as eBay does today.`)
    return { source: 'Product media', axisLabel: null, common, values: [], noAxis: true }
  }

  const primary = ebayRoots.find(l => l.aliasKey === '' && draftCuration(l.platformAttributes))
  const sharedCuration = await builderCuration(rootId, root.imageAxisPreference, report, 'Shared')
    ?? (primary ? draftCuration(primary.platformAttributes) : null)
    ?? { source: 'library' as const, axisLabel: null, values: [], common: library.filter(a => a.productId === rootId && a.mediaType === 'IMAGE').map(a => a.url) }
  const sharedCommon = sharedCuration.common ?? []
  const layers: SeedLayer[] = [{ address: { layer: 'SHARED', channel: '', marketplace: '', accountId: '', aliasKey: '' }, plan: toPlan(sharedCuration, 'Shared'), source: sharedCuration.source, label: 'Shared' }]
  const add = (listing: { channel: string; marketplace: string; accountId: string; aliasKey: string }, curation: Curation, label: string) => {
    const global = listing.channel !== 'EBAY'
    layers.push({ address: { layer: 'LISTING', channel: listing.channel, marketplace: global ? 'GLOBAL' : listing.marketplace, accountId: listing.accountId, aliasKey: listing.channel === 'AMAZON' ? '' : listing.aliasKey },
      plan: toPlan(curation, label), source: curation.source, label })
  }
  for (const alias of aliases) {
    const own = ebayRoots.find(l => l.aliasKey === alias.id)
    // What Publish sends off the plan (studio-publication-ebay.ts): the alias's eBay media draft over its Product media (or old
    // Image URLs list); the adopted shell's old builder rows, which nothing sends any more, come last (Owner 2026-10-05).
    const curation = (own ? draftCuration(own.platformAttributes) : null)
      ?? (alias.channel === 'EBAY' ? productMediaCuration({ marketplace: alias.marketplace, accountId: alias.channelConnectionId ?? '', aliasKey: alias.id, label: alias.label }, sharedCommon) : null)
      ?? (alias.adoptedFromProductId ? await builderCuration(alias.adoptedFromProductId, root.imageAxisPreference, report, alias.label) : null)
    if (!curation) continue
    if (!alias.channelConnectionId) { report.push(`${alias.label}: this alias has no account, so its photos were left out.`); continue }
    add({ channel: alias.channel, marketplace: alias.marketplace, accountId: alias.channelConnectionId, aliasKey: alias.id }, curation, alias.label)
  }
  // Each other eBay main listing: its eBay media draft (what Publish sends over its Product media), else (Owner 2026-10-05) its
  // own Product media or old Image URLs list. Its own list is its market's Listing layer (LISTING:EBAY:<market>:<account>:''),
  // never Shared: it was that one eBay listing's only — Shared also feeds every other channel and market, which keep
  // following the Shared photos as they did. The primary listing's draft is Shared already.
  for (const listing of ebayRoots.filter(l => l.aliasKey === '' && l !== primary)) {
    if (!listing.channelConnectionId) continue
    const label = `eBay ${listing.marketplace}`
    const curation = draftCuration(listing.platformAttributes) ?? productMediaCuration({ marketplace: listing.marketplace, accountId: listing.channelConnectionId, aliasKey: '', label }, sharedCommon)
    if (curation) add({ channel: 'EBAY', marketplace: listing.marketplace, accountId: listing.channelConnectionId, aliasKey: '' }, curation, label)
  }
  return { rootId, switched: switched > 0, fam, library, destinations, mainLanguage, layers, imports: [...imports].map(([url, id]) => ({ url, id })), report }
}

const revisionOf = (seed: Awaited<ReturnType<typeof buildMediaSeed>>) => sha({ layers: seed.layers.map(l => [l.address, l.plan]), imports: seed.imports })

/** What each destination would send once the family is on the plan, next to where its photos come from today. Writes nothing. */
export async function previewMediaSwitch(productId: string) {
  const seed = await buildMediaSeed(productId)
  if (seed.switched) return { rootId: seed.rootId, switched: true as const }
  const assets = new Map<string, MediaAsset>([
    ...seed.library.map(a => [a.id, { id: a.id, url: a.url, mediaType: a.mediaType, width: a.width, height: a.height, mimeType: a.mimeType, fileSize: a.fileSize, languageTag: a.languageTag, versionGroupId: a.versionGroupId, label: a.label }] as const),
    ...seed.imports.map(i => [i.id, { id: i.id, url: i.url, mediaType: 'IMAGE', width: null, height: null, mimeType: null, fileSize: null, languageTag: 'zxx', versionGroupId: null, label: decodeURIComponent(i.url.split('/').pop()?.split('?')[0] ?? 'Photo') }] as const),
  ])
  const byKey = new Map(seed.layers.map(l => [mediaLayerKey({ ...l.address }), l]))
  const shared = byKey.get('SHARED')!
  const destinations = seed.destinations.filter(d => d.targetable).map(d => {
    const own = byKey.get(d.key)
    const stack: MediaPlanStack = { shared: shared.plan, channel: null, listing: own?.plan ?? null }
    const layout = projectMediaDestination({ stack, family: seed.fam.family, axes: seed.fam.axes, assets, target: d, mainLanguage: seed.mainLanguage })
    const checks = [...new Map(layout.checks.map(c => [`${c.severity}|${c.message}`, c])).values()]
    return { key: d.key, channel: d.channel, marketplace: d.marketplace, markets: d.markets, accountLabel: d.accountLabel, alias: d.alias,
      source: own ? `${own.source} (${own.label})` : `${shared.source} (Shared)`, layout, checks }
  })
  return { rootId: seed.rootId, switched: false as const, revision: revisionOf(seed), sharedSource: shared.source,
    layers: seed.layers.map(l => ({ key: mediaLayerKey({ ...l.address }), label: l.label, source: l.source, plan: l.plan })),
    imports: seed.imports.length, report: seed.report, destinations, assets: Object.fromEntries(assets) }
}

/** A photo URL as a library photo of the family: reused by URL or by exact bytes, otherwise added (the URL is kept). */
async function importLibraryUrl(rootId: string, familyIds: string[], url: string): Promise<string> {
  const byUrl = await prisma.productImage.findFirst({ where: { productId: { in: familyIds }, url }, select: { id: true } })
  if (byUrl) return byUrl.id
  const { buffer } = await fetchCatalogSource(url).catch(error => { throw new WorkspaceScopeError(`A photo could not be downloaded for the library (${url}): ${(error as Error).message}. Nothing was switched.`, 422) })
  const contentHash = sha256Buffer(buffer)
  const same = await prisma.productImage.findFirst({ where: { productId: { in: familyIds }, contentHash }, select: { id: true } })
  if (same) return same.id
  const meta = await sharp(buffer, { limitInputPixels: 64_000_000 }).metadata()
  const last = await prisma.productImage.findFirst({ where: { productId: rootId }, orderBy: { sortOrder: 'desc' }, select: { sortOrder: true } })
  const mime: Record<string, string> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif', tiff: 'image/tiff' }
  const created = await prisma.productImage.create({ data: { productId: rootId, url, type: 'ALT', sortOrder: (last?.sortOrder ?? -1) + 1, contentHash,
    perceptualHash: await aHashBuffer(buffer), dhash256: await dHash256Buffer(buffer), width: meta.width ?? null, height: meta.height ?? null,
    mimeType: meta.format ? mime[meta.format] ?? null : null, fileSize: buffer.length } })
  return created.id
}

/** Put the family on the plan: import the photos the seed needs, then write every layer in one transaction. */
export async function switchToMediaPlan(productId: string, input: { revision: string }, actorId: string | null) {
  const seed = await buildMediaSeed(productId)
  if (seed.switched) throw new WorkspaceScopeError('This product already uses the photo plan.', 409)
  if (revisionOf(seed) !== input.revision) throw new WorkspaceScopeError('The photos changed since the preview. Review the preview again.', 409)
  const familyIds = [seed.rootId, ...seed.fam.root.children.map(c => c.id)]
  const real = new Map<string, string>()
  for (const { url, id } of seed.imports) real.set(id, await importLibraryUrl(seed.rootId, familyIds, url))
  // An imported URL can turn out to be a photo the library already holds (same bytes): after the swap a set keeps it once.
  const dedupe = (items?: Array<{ assetId: string }>) => items?.filter((item, i) => items.findIndex(other => other.assetId === item.assetId) === i)
  const swap = (plan: MediaPlan): MediaPlan => {
    const swapped = mediaPlanSchema.parse(JSON.parse(JSON.stringify(plan), (key, value) => key === 'assetId' && typeof value === 'string' && real.has(value) ? real.get(value) : value))
    const each = (sets?: Record<string, Array<{ assetId: string }>>) => sets && Object.fromEntries(Object.entries(sets).map(([k, v]) => [k, dedupe(v)!]))
    const sets = { ...swapped.sets, common: dedupe(swapped.sets.common), ...(swapped.sets.values ? { values: each(swapped.sets.values) } : {}), ...(swapped.sets.skus ? { skus: each(swapped.sets.skus) } : {}) }
    if (!sets.common) delete sets.common
    return { ...swapped, sets }
  }
  await prisma.$transaction(async tx => {
    if (await tx.productMediaPlan.count({ where: { productId: seed.rootId, layer: 'SHARED' } })) throw new WorkspaceScopeError('This product already uses the photo plan.', 409)
    for (const layer of seed.layers) await tx.productMediaPlan.create({ data: { productId: seed.rootId, layer: layer.address.layer, channel: layer.address.channel,
      marketplace: layer.address.marketplace, channelConnectionId: layer.address.accountId, aliasKey: layer.address.aliasKey, plan: swap(layer.plan), updatedById: actorId } })
  })
  publishListingEvent({ type: 'product.media.changed', productId: seed.rootId, layer: 'SHARED', ts: Date.now() })
  return { rootId: seed.rootId, layers: seed.layers.length, imported: seed.imports.length, report: seed.report }
}
