import { createHash } from 'node:crypto'
import sharp from 'sharp'
import prisma from '../../db.js'
import { mediaLayerKey, mediaPlanSchema, type MediaLayer, type MediaPlan, type MediaPlanStack } from '@nexus/shared/media-plan'
import { projectMediaDestination, type MediaAsset } from '@nexus/shared/media-plan-channels'
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { fetchCatalogSource } from '../pim/catalog-source-fetch.js'
import { publishListingEvent } from '../listing-events.service.js'
import { aHashBuffer, dHash256Buffer, sha256Buffer } from './image-hash.service.js'
import { familyRoot, loadDestinations, loadFamily, loadLibrary, planValueKey } from './media-plan.service.js'

/**
 * Images rebuild P3a (docs/images-studio-rebuild/P3-PLAN.md) — move ONE family onto the media plan, explicitly.
 *
 * The seed copies the family's current curation, in this order: the previous edit page's eBay builder rows, else the
 * eBay media draft of the primary listing, else the library order. Every adopted shell alias (and any other listing with
 * its own draft) gets a Listing layer holding exactly its photos, their URLs imported into the family library.
 * `previewMediaSwitch` writes nothing; `switchToMediaPlan` writes only when the preview's revision still holds. Nothing
 * is sent to any channel — publishing stays its own click.
 */

type Source = 'old eBay builder' | 'eBay media draft' | 'library'
interface Curation { source: Source; axisLabel: string | null; common: string[]; values: Array<{ text: string; urls: string[] }> }
interface SeedLayer { address: { layer: MediaLayer; channel: string; marketplace: string; accountId: string; aliasKey: string }; plan: MediaPlan; source: Source; label: string }
const obj = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {}
const unique = (list: string[]) => [...new Set(list)]
const sha = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

/** The previous edit page's eBay builder rows of one product (the family root or an old shell). */
async function builderCuration(productId: string, preferredAxis: string | null, report: string[], label: string): Promise<Curation | null> {
  const rows = await prisma.listingImage.findMany({ where: { productId, platform: 'EBAY', variationId: null, mediaType: 'IMAGE' },
    orderBy: [{ position: 'asc' }, { id: 'asc' }], select: { url: true, variantGroupKey: true, variantGroupValue: true } })
  if (!rows.length) return null
  // The builder showed ONE axis spelling (the product's preference); rows it saved under another spelling were invisible
  // there and mixed in at publish — they are left out and named, never merged silently.
  const keys = rows.map(r => r.variantGroupKey).filter((k): k is string => !!k)
  const counts = new Map<string, number>(); for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + 1)
  const axisLabel = (preferredAxis && counts.has(preferredAxis) ? preferredAxis : [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]) ?? null
  const skipped = keys.filter(k => k !== axisLabel).length
  if (skipped) report.push(`${label}: ${skipped} older photo${skipped > 1 ? 's' : ''} saved under another axis spelling were left out.`)
  const values: Curation['values'] = []
  for (const row of rows.filter(r => r.variantGroupKey === axisLabel && r.variantGroupValue)) {
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
  const report: string[] = []
  const byUrl = new Map(library.map(a => [a.url, a.id]))
  const imports = new Map<string, string>()
  const assetFor = (url: string) => byUrl.get(url) ?? imports.get(url) ?? (imports.set(url, `import:${sha(url).slice(0, 20)}`), imports.get(url)!)

  const toPlan = (curation: Curation, label: string): MediaPlan => {
    const axis = curation.axisLabel ? fam.axes.find(a => a.code === curation.axisLabel || canonicalVariantAxis(a.label) === canonicalVariantAxis(curation.axisLabel!)) : undefined
    if (curation.values.length && !axis) report.push(`${label}: photos were grouped by "${curation.axisLabel}", which is not a variation axis of this family; those sets were left out.`)
    const values: Record<string, string[]> = {}
    if (axis) for (const value of curation.values) {
      const key = planValueKey(axis.code, value.text, fam.attributes.find(a => a.code === axis.code)).key
      values[key] = unique([...(values[key] ?? []), ...value.urls.map(assetFor)])
    }
    const item = (ids: string[]) => ids.map(assetId => ({ assetId }))
    return mediaPlanSchema.parse({ version: 1, ...(axis ? { axis: axis.code } : {}), sets: { common: item(unique(curation.common.map(assetFor))),
      ...(Object.keys(values).length ? { values: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, item(v)])) } : {}) } })
  }

  const primary = ebayRoots.find(l => l.aliasKey === '' && draftCuration(l.platformAttributes))
  const sharedCuration = await builderCuration(rootId, root.imageAxisPreference, report, 'Shared')
    ?? (primary ? draftCuration(primary.platformAttributes) : null)
    ?? { source: 'library' as const, axisLabel: null, values: [], common: library.filter(a => a.productId === rootId && a.mediaType === 'IMAGE').map(a => a.url) }
  const layers: SeedLayer[] = [{ address: { layer: 'SHARED', channel: '', marketplace: '', accountId: '', aliasKey: '' }, plan: toPlan(sharedCuration, 'Shared'), source: sharedCuration.source, label: 'Shared' }]
  const add = (listing: { channel: string; marketplace: string; accountId: string; aliasKey: string }, curation: Curation, label: string) => {
    const global = listing.channel !== 'EBAY'
    layers.push({ address: { layer: 'LISTING', channel: listing.channel, marketplace: global ? 'GLOBAL' : listing.marketplace, accountId: listing.accountId, aliasKey: listing.channel === 'AMAZON' ? '' : listing.aliasKey },
      plan: toPlan(curation, label), source: curation.source, label })
  }
  for (const alias of aliases) {
    const own = ebayRoots.find(l => l.aliasKey === alias.id)
    const curation = (alias.adoptedFromProductId ? await builderCuration(alias.adoptedFromProductId, root.imageAxisPreference, report, alias.label) : null) ?? (own ? draftCuration(own.platformAttributes) : null)
    if (!curation) continue
    if (!alias.channelConnectionId) { report.push(`${alias.label}: this alias has no account, so its photos were left out.`); continue }
    add({ channel: alias.channel, marketplace: alias.marketplace, accountId: alias.channelConnectionId, aliasKey: alias.id }, curation, alias.label)
  }
  for (const listing of ebayRoots.filter(l => l.aliasKey === '' && l !== primary && draftCuration(l.platformAttributes))) {
    if (!listing.channelConnectionId) continue
    add({ channel: 'EBAY', marketplace: listing.marketplace, accountId: listing.channelConnectionId, aliasKey: '' }, draftCuration(listing.platformAttributes)!, `eBay ${listing.marketplace}`)
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
    const sets = { ...swapped.sets, common: dedupe(swapped.sets.common), ...(swapped.sets.values ? { values: Object.fromEntries(Object.entries(swapped.sets.values).map(([k, v]) => [k, dedupe(v)!])) } : {}) }
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
