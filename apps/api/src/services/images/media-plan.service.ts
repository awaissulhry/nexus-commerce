import prisma from '../../db.js'
import { applyMediaOps, collapseVersionsInPlan, emptyMediaPlan, inverseMediaOps, MediaPlanEditError, mediaPlanSchema, mediaLayerKey, planAssetIds, replaceAssetInPlan, resolveAxis, type MediaLayer, type MediaOp, type MediaPlan, type MediaPlanStack } from '@nexus/shared/media-plan'
import { channelNames, projectMediaDestination, rowGallery, type MediaAsset, type MediaFamily } from '@nexus/shared/media-plan-channels'
import { storedVariationValues } from '../pim/stored-variation-projection.js'
import { optionForValue, type DictionaryAttribute } from '../pim/family-variations-core.js'
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'
import { marketLanguages, type MarketLanguageRow } from '../pim/market-languages.js'
import { NoConnectionError, resolveChannelConnectionId } from '../connection-resolver.service.js'
import { connectionLabel } from '../connection-label.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { publishListingEvent } from '../listing-events.service.js'
import { readExcludedListingIds } from '../pim/variation-excluded.js'
import { usesEbayInventory } from '../pim/ebay-listing-model.js'
import { isOnMediaPlan } from './media-plan-switch.js'
import { libraryEntries, lookalikes, pictureKeys, samePhoto } from './media-library-identity.js'

/**
 * Images rebuild P1 — the media plan read and write (docs/images-studio-rebuild/PLAN.md §6). One read gives the page
 * everything: the family and its axes, the photo library, every layer, every destination and each destination's
 * layout and checks, computed by the same pure functions the publishers will use. Writes are small operations applied
 * to the latest plan of one layer, so two people editing different sets never conflict.
 */

export const MEDIA_CHANNELS = ['AMAZON', 'EBAY', 'SHOPIFY', 'ETSY'] as const
type MediaChannel = typeof MEDIA_CHANNELS[number]
/** Channels whose photos belong to the whole account, not to one market (PLAN.md §4.3). */
const GLOBAL_CHANNELS = new Set<MediaChannel>(['AMAZON', 'SHOPIFY'])

const fold = (text: string) => text.trim().toLowerCase().replace(/[\s_-]+/g, '')
const slug = (text: string) => text.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').replace(/^(?=[^a-z])/, 'a_').slice(0, 64) || 'axis'
const isColour = (label: string, code: string) => canonicalVariantAxis(label) === canonicalVariantAxis('Color') || code === 'color'

export async function familyRoot(productId: string) {
  const product = await prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { id: true, parentId: true } })
  if (!product) throw new WorkspaceScopeError('This product is unavailable.', 404)
  return product.parentId ?? product.id
}

/** A value's plan key: its dictionary option (`color:black`), or its folded text until it is mapped (`color:text:nero`). */
export function planValueKey(code: string, text: string, attribute: DictionaryAttribute | undefined): { key: string; label: string; mapped: boolean } {
  const option = attribute ? optionForValue(text, attribute) : null
  return option ? { key: `${code}:${option.code}`, label: option.label, mapped: true } : { key: `${code}:text:${fold(text)}`, label: text.trim(), mapped: false }
}

/** The family, its variation axes as dictionary codes, and each variant's value key per axis (PLAN.md §4.9). */
export async function loadFamily(rootId: string) {
  const root = await prisma.product.findUniqueOrThrow({ where: { id: rootId }, select: { id: true, sku: true, name: true, variationAxes: true, variationAxisCodes: true, variationValueOrder: true,
    children: { where: { deletedAt: null }, orderBy: { sku: 'asc' }, select: { id: true, sku: true, categoryAttributes: true, variantAttributes: true } } } })
  const labels = root.variationAxes
  const codes = labels.map((label, i) => root.variationAxisCodes[i] || slug(label))
  const attributes: DictionaryAttribute[] = root.variationAxisCodes.length ? await prisma.customAttribute.findMany({ where: { code: { in: root.variationAxisCodes } }, select: {
    id: true, code: true, label: true, semanticKey: true, archivedAt: true,
    options: { orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }], select: { id: true, code: true, label: true, metadata: true, synonyms: true, sortOrder: true, archivedAt: true } },
  } }) : []
  const valueLabels: Record<string, string> = {}
  const unmapped = new Set<string>()
  const variants: MediaFamily['variants'] = root.children.map(child => {
    const stored = storedVariationValues(child, labels)
    const values: Record<string, string> = {}
    codes.forEach((code, i) => {
      const text = stored[labels[i]]?.trim()
      if (!text) return
      const value = planValueKey(code, text, attributes.find(a => a.code === code))
      if (!value.mapped) unmapped.add(value.key)
      values[code] = value.key
      valueLabels[value.key] ??= value.label
    })
    return { productId: child.id, sku: child.sku, values, included: true }
  })
  const savedOrder = (root.variationValueOrder ?? {}) as Record<string, unknown>
  const valueOrder = Object.fromEntries(codes.map(code => {
    const used = [...new Set(variants.map(v => v.values[code]).filter((k): k is string => !!k))]
    const saved = Array.isArray(savedOrder[code]) ? (savedOrder[code] as unknown[]).map(o => `${code}:${String(o)}`) : []
    const dictionary = attributes.find(a => a.code === code)?.options.map(o => `${code}:${o.code}`) ?? []
    const order = [...saved, ...dictionary.filter(k => !saved.includes(k))].filter(k => used.includes(k))
    return [code, [...order, ...used.filter(k => !order.includes(k))]]
  }))
  const colour = codes.find((code, i) => isColour(labels[i], code))
  const family: MediaFamily = { productId: root.id, variants, defaultAxis: colour ?? codes[0] ?? null, valueOrder, valueLabels }
  return { root, family, attributes, axes: codes.map((code, i) => ({ code, label: labels[i], dictionary: root.variationAxisCodes[i] === code, values: valueOrder[code].map(key => ({ key, label: valueLabels[key] })) })), unmapped: [...unmapped] }
}

export async function loadLibrary(productIds: string[]) {
  const rows = await prisma.productImage.findMany({ where: { productId: { in: productIds } }, orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }], select: {
    id: true, productId: true, url: true, alt: true, type: true, mediaType: true, width: true, height: true, mimeType: true, fileSize: true,
    languageTag: true, versionGroupId: true, isPrimary: true, posterUrl: true, durationSec: true, contentHash: true,
    sameAsImageId: true, distinctFromIds: true, perceptualHash: true, dhash256: true } })
  return rows.map(r => ({ ...r, label: r.alt?.trim() || decodeURIComponent(r.url.split('/').pop()?.split('?')[0] ?? '') || 'Photo' }))
}

const layerWhere = (rootId: string, layer: MediaLayer, channel = '', marketplace = '', channelConnectionId = '', aliasKey = '') =>
  ({ productId: rootId, layer, channel, marketplace, channelConnectionId, aliasKey })

function readPlan(value: unknown): MediaPlan {
  const parsed = mediaPlanSchema.safeParse(value)
  if (!parsed.success) throw new WorkspaceScopeError('A saved photo plan is unreadable. Nothing was changed; ask for it to be repaired.', 500)
  return parsed.data
}

/** Every destination of the family, keyed the way LISTING layers are keyed. Amazon and Shopify photos belong to the account. */
export async function loadDestinations(productIds: string[]) {
  const listings = await prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: { in: [...MEDIA_CHANNELS] } },
    select: { id: true, productId: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true } })
  // Only eBay needs the listing's own attributes (the Trading/Inventory marker); Amazon's are large and are not read.
  const [excluded, ebayAttributes] = await Promise.all([
    readExcludedListingIds(listings.map(l => l.id)),
    prisma.channelListing.findMany({ where: { productId: { in: productIds }, channel: 'EBAY' }, select: { id: true, platformAttributes: true } }),
  ])
  const attributesOf = new Map(ebayAttributes.map(l => [l.id, l.platformAttributes]))
  const aliasIds = [...new Set(listings.map(l => l.aliasKey).filter(Boolean))]
  const aliases = aliasIds.length ? await prisma.productListingAlias.findMany({ where: { id: { in: aliasIds } }, select: { id: true, label: true, position: true, status: true } }) : []
  const accountIds = [...new Set(listings.map(l => l.channelConnectionId).filter((id): id is string => !!id))]
  const accounts = accountIds.length ? (await prisma.channelConnection.findMany({ where: { id: { in: accountIds } }, select: { id: true, channelType: true, accountLabel: true,
    ebayStoreName: true, displayName: true, ebaySignInName: true, externalAccountId: true, isActive: true, isPrimary: true } }))
    // The human name the rest of the app shows (label, store name, display or sign-in name), never "Unknown account".
    .map(a => ({ ...a, accountLabel: connectionLabel(a).label })) : []
  const markets: MarketLanguageRow[] = await prisma.marketplace.findMany({ select: { channel: true, code: true, languages: true, language: true } })
  const languagesOf = (channel: string, code: string) => { try { return marketLanguages(channel, code, markets) } catch { return [] } }
  const groups = new Map<string, { channel: MediaChannel; marketplace: string; accountId: string; aliasKey: string; markets: Map<string, number>; listed: number; productIds: Set<string>; listingIds: string[] }>()
  for (const l of listings) {
    const channel = l.channel as MediaChannel
    const global = GLOBAL_CHANNELS.has(channel) || channel === 'ETSY'
    // Amazon aliases share the ASIN and so the photos (PLAN.md §4.5): one destination per account.
    const aliasKey = channel === 'AMAZON' ? '' : l.aliasKey
    const marketplace = global ? 'GLOBAL' : l.marketplace
    const key = mediaLayerKey({ layer: 'LISTING', channel, marketplace, accountId: l.channelConnectionId ?? '', aliasKey })
    const group = groups.get(key) ?? { channel, marketplace, accountId: l.channelConnectionId ?? '', aliasKey, markets: new Map(), listed: 0, productIds: new Set(), listingIds: [] }
    group.markets.set(l.marketplace, (group.markets.get(l.marketplace) ?? 0) + 1)
    group.listed += 1
    group.listingIds.push(l.id)
    // A variant the listing's variation setup excludes is not part of what this destination publishes.
    if (!excluded.has(l.id)) group.productIds.add(l.productId)
    groups.set(key, group)
  }
  const counts = [...groups.values()].flatMap(g => [...g.markets].map(([code, n]) => ({ channel: g.channel, code, n }))).sort((a, b) => b.n - a.n)
  const mainLanguage = counts.map(c => languagesOf(c.channel, c.code)[0]).find(Boolean) ?? 'en'
  const order: Record<MediaChannel, number> = { AMAZON: 0, EBAY: 1, SHOPIFY: 2, ETSY: 3 }
  // ★ ①②③ (the DS AliasMark) only where one account and market hold more than one listing of the family.
  const listingsAt = new Map<string, number>()
  for (const g of groups.values()) listingsAt.set(`${g.channel}|${g.marketplace}|${g.accountId}`, (listingsAt.get(`${g.channel}|${g.marketplace}|${g.accountId}`) ?? 0) + 1)
  return { mainLanguage, destinations: [...groups.entries()].map(([key, g]) => {
    const alias = g.aliasKey ? aliases.find(a => a.id === g.aliasKey) ?? null : null
    const account = accounts.find(a => a.id === g.accountId)
    const marketList = [...g.markets.keys()].sort((a, b) => (g.markets.get(b)! - g.markets.get(a)!) || a.localeCompare(b))
    const own = g.channel === 'EBAY' ? languagesOf('EBAY', g.marketplace) : g.channel === 'AMAZON' ? ['mul', ...languagesOf('AMAZON', marketList[0])] : [mainLanguage]
    const refusal = !g.accountId ? 'This listing has no account, so its photos cannot be set here.' : !account ? 'This account is not available in this business.'
      : alias && alias.status !== 'ACTIVE' ? 'This listing alias is archived.' : null
    return { key, channel: g.channel, marketplace: g.marketplace, markets: marketList, accountId: g.accountId, accountLabel: account?.accountLabel ?? null,
      accountActive: account?.isActive ?? false, alias: alias ? { id: alias.id, label: alias.label, position: alias.position } : null,
      listingMark: (listingsAt.get(`${g.channel}|${g.marketplace}|${g.accountId}`) ?? 0) > 1 ? (g.aliasKey ? alias?.position ?? null : 0) : null,
      languages: [...new Set(own.length ? own : [mainLanguage])], listed: g.listed, productIds: [...g.productIds], targetable: !refusal, refusal,
      api: g.channel === 'EBAY' ? (usesEbayInventory({ listings: g.listingIds.map(id => ({ platformAttributes: attributesOf.get(id) })) }) ? 'INVENTORY' as const : 'TRADING' as const) : undefined }
  }).sort((a, b) => order[a.channel] - order[b.channel] || a.marketplace.localeCompare(b.marketplace) || (a.accountLabel ?? '').localeCompare(b.accountLabel ?? '') || (a.alias?.position ?? 0) - (b.alias?.position ?? 0)) }
}

type Destination = Awaited<ReturnType<typeof loadDestinations>>['destinations'][number]
/** What a publisher knows better than the page: the channel's own names and the variants its review includes. */
export interface MediaLayoutOverrides { valueNames?: Record<string, string>; axisName?: string | null; includedIds?: readonly string[] }
/** A publisher's channel values, as its variation projection resolved them: per variant, per axis label (`Colore`),
 *  the value the channel receives; and per axis label, the channel's axis name. */
export interface MediaChannelValues { byProduct: Record<string, Record<string, string>>; axisNames: Record<string, string | null> }

/** Everything a layout needs, loaded once for the family — the page and the publishers use this one loader. */
async function loadMediaContext(rootId: string) {
  const { root, family, axes, unmapped } = await loadFamily(rootId)
  const ids = [root.id, ...root.children.map(c => c.id)]
  const [library, rows, { destinations, mainLanguage }] = await Promise.all([
    loadLibrary(ids),
    prisma.productMediaPlan.findMany({ where: { productId: rootId }, select: { layer: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, plan: true, revision: true, updatedAt: true } }),
    loadDestinations(ids),
  ])
  const layers = rows.map(r => ({ key: mediaLayerKey({ layer: r.layer as MediaLayer, channel: r.channel, marketplace: r.marketplace, accountId: r.channelConnectionId, aliasKey: r.aliasKey }),
    layer: r.layer as MediaLayer, channel: r.channel, marketplace: r.marketplace, accountId: r.channelConnectionId, aliasKey: r.aliasKey, plan: readPlan(r.plan), revision: r.revision, updatedAt: r.updatedAt }))
  const assets = new Map<string, MediaAsset>(library.map(a => [a.id, { id: a.id, url: a.url, mediaType: a.mediaType, width: a.width, height: a.height, mimeType: a.mimeType, fileSize: a.fileSize, languageTag: a.languageTag, versionGroupId: a.versionGroupId, label: a.label }]))
  // Every row stays resolvable (a plan may point at any copy); the page's library shows each picture once.
  const referenced = new Set(layers.flatMap(l => [...JSON.stringify(l.plan).matchAll(/"assetId":"([^"]+)"/g)].map(m => m[1])))
  const entries = libraryEntries(library, root.id, referenced)
  // W4a — the same picture at another address ("Looks like …"), by the upload gate's calibrated rule.
  const alike = lookalikes(library, entries)
  const pictures = entries.map(({ contentHash: _hash, perceptualHash: _a, dhash256: _d, distinctFromIds: _n, sameAsImageId: _s, ...entry }) => {
    // The photos the Owner marked the same as this one (W4a): the photo window lists them, each with "Separate".
    const merged = library.filter(r => r.sameAsImageId === entry.id).map(r => ({ id: r.id, label: r.label }))
    return { ...entry, ...(alike.has(entry.id) ? { lookalikes: alike.get(entry.id)! } : {}), ...(merged.length ? { merged } : {}) }
  })
  return { root, family, axes, unmapped, library, pictures, layers, byKey: new Map(layers.map(l => [l.key, l])), assets, destinations, mainLanguage }
}
type MediaContext = Awaited<ReturnType<typeof loadMediaContext>>

function projectDestination(ctx: MediaContext, d: Destination, overrides: MediaLayoutOverrides = {}) {
  const stack: MediaPlanStack = { shared: ctx.byKey.get('SHARED')?.plan ?? null, channel: ctx.byKey.get(`CHANNEL:${d.channel}`)?.plan ?? null, listing: ctx.byKey.get(d.key)?.plan ?? null }
  const layout = projectMediaDestination({ stack, family: ctx.family, axes: ctx.axes, assets: ctx.assets, target: d, mainLanguage: ctx.mainLanguage,
    valueNames: overrides.valueNames, axisName: overrides.axisName, includedIds: overrides.includedIds })
  // Revisions of the layers this destination reads — a publisher binds its review to them.
  const revisions = [ctx.byKey.get('SHARED'), ctx.byKey.get(`CHANNEL:${d.channel}`), ctx.byKey.get(d.key)].map(l => l ? `${l.key}@${l.revision}` : null).filter(Boolean)
  return { channel: d.channel, revisions, ...layout }
}

export async function readMediaWorkspace(productId: string) {
  const started = Date.now()
  const rootId = await familyRoot(productId)
  const ctx = await loadMediaContext(rootId)
  const layouts = Object.fromEntries(ctx.destinations.filter(d => d.targetable).map(d => [d.key, projectDestination(ctx, d)]))
  return { productId, rootId, sku: ctx.root.sku, name: ctx.root.name, mainLanguage: ctx.mainLanguage, family: { ...ctx.family, axes: ctx.axes, unmapped: ctx.unmapped },
    library: ctx.pictures, layers: ctx.layers, destinations: ctx.destinations, layouts,
    // Value and axis names here are the Shared ones; a publisher passes each market's own names (value maps, pins).
    meta: { tookMs: Date.now() - started, names: 'shared' as const } }
}

/**
 * The Information sheet's view of a switched family (P3c, PLAN.md §5.7): each row's gallery from the plan, as the Media
 * page resolves it — the Shared layer on the master sheet, a destination's layers on a channel sheet. `null` = the family
 * is not on the plan (the sheet keeps its older column).
 */
export async function sheetMediaPlan(rootId: string) {
  // One read decides it: a family with no Shared layer is not on the plan, and the sheet pays nothing more.
  const rows = await prisma.productMediaPlan.findMany({ where: { productId: rootId }, select: { layer: true, channel: true, marketplace: true, channelConnectionId: true, aliasKey: true, plan: true } })
  if (!rows.some(r => r.layer === 'SHARED')) return null
  const { root, family } = await loadFamily(rootId)
  const library = await loadLibrary([root.id, ...root.children.map(c => c.id)])
  const plans = new Map(rows.map(r => [mediaLayerKey({ layer: r.layer as MediaLayer, channel: r.channel, marketplace: r.marketplace, accountId: r.channelConnectionId, aliasKey: r.aliasKey }), readPlan(r.plan)]))
  const assets = new Map<string, MediaAsset>(library.map(a => [a.id, { id: a.id, url: a.url, mediaType: a.mediaType, width: a.width, height: a.height, mimeType: a.mimeType, fileSize: a.fileSize, languageTag: a.languageTag, versionGroupId: a.versionGroupId, label: a.label }]))
  const byId = new Map(library.map(a => [a.id, a]))
  /** The layers a sheet reads: Shared on the master sheet; on a channel sheet, that listing's destination. */
  const stackFor = (coordinate: { channel: string; marketplace: string; accountId: string; aliasKey: string } | null): MediaPlanStack => {
    if (!coordinate) return { shared: plans.get('SHARED') ?? null }
    const channel = coordinate.channel as MediaChannel
    const key = mediaLayerKey({ layer: 'LISTING', channel, marketplace: GLOBAL_CHANNELS.has(channel) || channel === 'ETSY' ? 'GLOBAL' : coordinate.marketplace,
      accountId: coordinate.accountId, aliasKey: channel === 'AMAZON' ? '' : coordinate.aliasKey })
    return { shared: plans.get('SHARED') ?? null, channel: plans.get(`CHANNEL:${channel}`) ?? null, listing: plans.get(key) ?? null }
  }
  return {
    /** One row's cell: the set it edits, and its photos (a variant's Common photos come last, marked `muted`). */
    row(productId: string, coordinate: Parameters<typeof stackFor>[0], language: string) {
      const gallery = rowGallery({ stack: stackFor(coordinate), family, productId, assets, languages: [language], mainLanguage: language })
      return {
        set: { ref: gallery.set, label: gallery.label, sharedBy: gallery.sharedBy },
        items: gallery.items.map(item => {
          const asset = byId.get(item.assetId)
          return { id: item.placedId, type: asset?.mediaType ?? 'FILE', preview: asset ? asset.mediaType === 'IMAGE' ? asset.url : asset.posterUrl : null,
            alt: asset?.alt?.trim() || asset?.label || '', ...(item.from === 'common' ? { muted: true } : {}) }
        }),
      }
    },
  }
}

/** A family is switched to the media plan once it has a Shared layer: its publishers send the plan's layout. */
export async function isMediaSwitched(productId: string): Promise<boolean> {
  await familyRoot(productId)
  return isOnMediaPlan(productId)
}

/**
 * The layout one destination must receive, for a publisher — or `null` when the family is not switched (the publisher
 * keeps today's behaviour). Computed by the same loader and projection as the page, so both agree on language versions,
 * listed variants and order; the publisher supplies the channel's own names and the variants its review includes.
 */
export async function mediaLayoutFor(input: { productId: string; channel: MediaChannel; marketplace: string; accountId: string; aliasKey?: string; channelValues?: MediaChannelValues } & MediaLayoutOverrides) {
  const rootId = await familyRoot(input.productId)
  if (!(await isOnMediaPlan(rootId))) return null
  const ctx = await loadMediaContext(rootId)
  const marketplace = GLOBAL_CHANNELS.has(input.channel) || input.channel === 'ETSY' ? 'GLOBAL' : input.marketplace
  const key = mediaLayerKey({ layer: 'LISTING', channel: input.channel, marketplace, accountId: input.accountId, aliasKey: input.channel === 'AMAZON' ? '' : input.aliasKey ?? '' })
  const d = ctx.destinations.find(x => x.key === key)
  if (!d) throw new WorkspaceScopeError('This listing is not one of the product\'s photo destinations yet. Reload the Media page.', 409)
  if (!d.targetable) throw new WorkspaceScopeError(d.refusal ?? 'This destination cannot receive photos.', 409)
  // The channel's own names for the picture axis and its values, from the publisher's projection (pins, value maps).
  const names: MediaLayoutOverrides = {}
  if (input.channelValues) {
    const { axis } = resolveAxis({ shared: ctx.byKey.get('SHARED')?.plan ?? null, channel: ctx.byKey.get(`CHANNEL:${d.channel}`)?.plan ?? null, listing: ctx.byKey.get(key)?.plan ?? null }, ctx.family.defaultAxis)
    const named = channelNames({ axes: ctx.axes, variants: ctx.family.variants, axis, channelValues: input.channelValues, valueLabels: ctx.family.valueLabels })
    if (named.conflicts.length) throw new WorkspaceScopeError(named.conflicts.join(' '), 409)
    names.valueNames = named.valueNames
    names.axisName = named.axisName
  }
  const layout = projectDestination(ctx, d, { ...input, ...names })
  const url = (id: string) => {
    const asset = ctx.assets.get(id)
    if (!asset) throw new WorkspaceScopeError('A photo in the plan was deleted from the library. Review the Media page.', 409)
    return asset.url
  }
  return { rootId, destination: d, layout, url, assets: ctx.assets, mainLanguage: ctx.mainLanguage }
}

export interface MediaLayerAddress { layer: MediaLayer; channel?: string; marketplace?: string; accountId?: string; aliasKey?: string }

/** The layer an edit targets, checked against the family and the business's accounts. */
async function checkedAddress(rootId: string, address: MediaLayerAddress) {
  if (address.layer === 'SHARED') return { layer: 'SHARED' as const, channel: '', marketplace: '', accountId: '', aliasKey: '' }
  const channel = String(address.channel ?? '').toUpperCase()
  if (!(MEDIA_CHANNELS as readonly string[]).includes(channel)) throw new WorkspaceScopeError('Choose Amazon, eBay, Shopify or Etsy.', 400)
  if (address.layer === 'CHANNEL') return { layer: 'CHANNEL' as const, channel, marketplace: '', accountId: '', aliasKey: '' }
  const marketplace = GLOBAL_CHANNELS.has(channel as MediaChannel) || channel === 'ETSY' ? 'GLOBAL' : String(address.marketplace ?? '').toUpperCase()
  if (!marketplace) throw new WorkspaceScopeError('Choose the market of this listing.', 400)
  if (!address.accountId) throw new WorkspaceScopeError('Choose the account of this listing.', 400)
  const accountId = await resolveChannelConnectionId(channel, address.accountId).catch(error => {
    if (error instanceof NoConnectionError) throw new WorkspaceScopeError(error.message, 404)
    throw error
  }) ?? ''
  const aliasKey = channel === 'AMAZON' ? '' : address.aliasKey ?? ''
  if (aliasKey) {
    const alias = await prisma.productListingAlias.findFirst({ where: { id: aliasKey, productId: rootId, channel, channelConnectionId: accountId, status: 'ACTIVE',
      ...(marketplace === 'GLOBAL' ? {} : { marketplace }) }, select: { id: true } })
    if (!alias) throw new WorkspaceScopeError('This listing alias is unavailable for this product and account.')
  }
  return { layer: 'LISTING' as const, channel, marketplace, accountId, aliasKey }
}

/**
 * Apply edits to one layer. The plan is re-read inside the transaction and the write is a compare-and-swap on the
 * layer's revision; when another edit landed first the ops are applied again on top of it (they still fit or they are
 * refused with the reason). A layer that ends up owning nothing is removed, so it follows again.
 */
/** A photo's language: `zxx` (no text), `mul` (several languages), or a two- or three-letter language code. */
export const MEDIA_LANGUAGE = /^(zxx|mul|[a-z]{2,3})$/

/**
 * Images rebuild P4b — what the upload dialog read from the file names (PLAN.md §4.6, §4.8): each photo's language, and
 * which photos are language versions of one photo. A group may join a photo already in the library (`join`): it keeps
 * that photo's group, or starts one with it. Versions of one photo need different languages, none of them "no text".
 * Only photos of this family; nothing is placed in a set here (the plan's ops do that).
 */
export async function updateMediaLibrary(productId: string, input: {
  languages: Array<{ id: string; languageTag: string }>
  groups: Array<{ ids: string[]; join?: string | null }>
}) {
  const rootId = await familyRoot(productId)
  const family = [rootId, ...(await prisma.product.findMany({ where: { parentId: rootId, deletedAt: null }, select: { id: true } })).map(c => c.id)]
  const named = [...new Set([...input.languages.map(l => l.id), ...input.groups.flatMap(g => [...g.ids, ...(g.join ? [g.join] : [])])])]
  const rows = await prisma.productImage.findMany({ where: { id: { in: named }, productId: { in: family } }, select: { id: true, languageTag: true, versionGroupId: true } })
  if (rows.length !== named.length) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (input.languages.some(l => !MEDIA_LANGUAGE.test(l.languageTag))) throw new WorkspaceScopeError('Choose a language for each photo.', 422)
  const grouped = input.groups.flatMap(g => g.ids)
  if (new Set(grouped).size !== grouped.length) throw new WorkspaceScopeError('A photo can be a version of one photo only.', 422)
  const language = new Map(rows.map(r => [r.id, input.languages.find(l => l.id === r.id)?.languageTag ?? r.languageTag]))
  // W4b — a photo's own language change must keep its version group valid: text in it, a different language each.
  for (const change of input.languages) {
    const row = rows.find(r => r.id === change.id)
    if (!row?.versionGroupId || input.groups.some(g => g.ids.includes(change.id))) continue
    const others = await prisma.productImage.findMany({ where: { versionGroupId: row.versionGroupId, productId: { in: family }, id: { not: row.id } }, select: { languageTag: true } })
    if (change.languageTag === 'zxx' || others.some(o => o.languageTag === change.languageTag))
      throw new WorkspaceScopeError('This photo is a language version of another. Choose a language that none of its versions has, or leave its versions first.', 422)
  }
  const byId = new Map(rows.map(r => [r.id, r]))
  // The members each group will have: the joined photo's existing versions, the joined photo, and the new files.
  const plans = await Promise.all(input.groups.map(async g => {
    const joined = g.join ? byId.get(g.join)! : null
    const existing = joined?.versionGroupId ? await prisma.productImage.findMany({ where: { versionGroupId: joined.versionGroupId, productId: { in: family } }, select: { id: true, languageTag: true } }) : []
    for (const row of existing) if (!language.has(row.id)) language.set(row.id, row.languageTag)
    const members = [...new Set([...existing.map(r => r.id), ...(joined ? [joined.id] : []), ...g.ids])]
    const tags = members.map(id => language.get(id)!)
    if (members.length < 2 || tags.includes('zxx') || new Set(tags).size !== tags.length)
      throw new WorkspaceScopeError('Versions of one photo need a different language each (and text in them).', 422)
    return { groupId: joined?.versionGroupId ?? crypto.randomUUID(), ids: members.filter(id => !existing.some(r => r.id === id)) }
  }))
  await prisma.$transaction([
    ...input.languages.map(l => prisma.productImage.update({ where: { id: l.id }, data: { languageTag: l.languageTag } })),
    ...plans.map(p => prisma.productImage.updateMany({ where: { id: { in: p.ids } }, data: { versionGroupId: p.groupId } })),
  ])
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId, groups: plans.map(p => ({ versionGroupId: p.groupId, ids: p.ids })) }
}

export async function applyMediaPlanOps(productId: string, input: { address: MediaLayerAddress; ops: MediaOp[] }, actorId: string | null) {
  const rootId = await familyRoot(productId)
  const address = await checkedAddress(rootId, input.address)
  const ids = [rootId, ...(await prisma.product.findMany({ where: { parentId: rootId, deletedAt: null }, select: { id: true } })).map(c => c.id)]
  const library = await prisma.productImage.findMany({ where: { productId: { in: ids } }, select: { id: true, productId: true, url: true, contentHash: true, versionGroupId: true } })
  const known = new Set(library.map(a => a.id))
  const introduced = input.ops.flatMap(op => op.op === 'insert' || op.op === 'replace' ? op.assetIds : op.op === 'swatch' && op.assetId ? [op.assetId] : [])
  const foreign = introduced.filter(id => !known.has(id))
  if (foreign.length) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  // One picture stored on several SKUs, or language versions of one photo, is one photo: never twice in a set.
  const sameGroup = samePhoto(library)
  const key = mediaLayerKey({ layer: address.layer, channel: address.channel, marketplace: address.marketplace, accountId: address.accountId, aliasKey: address.aliasKey })
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await prisma.$transaction(async tx => {
      const rows = await tx.productMediaPlan.findMany({ where: { productId: rootId, OR: [{ layer: 'SHARED' }, ...(address.layer !== 'SHARED' ? [{ layer: 'CHANNEL', channel: address.channel }] : []),
        ...(address.layer === 'LISTING' ? [{ ...layerWhere(rootId, 'LISTING', address.channel, address.marketplace, address.accountId, address.aliasKey) }] : [])] } })
      const find = (layer: MediaLayer, channel = '', marketplace = '', account = '', alias = '') => rows.find(r => r.layer === layer && r.channel === channel && r.marketplace === marketplace && r.channelConnectionId === account && r.aliasKey === alias)
      const sharedRow = find('SHARED'), channelRow = address.layer === 'SHARED' ? undefined : find('CHANNEL', address.channel)
      const target = address.layer === 'SHARED' ? sharedRow : address.layer === 'CHANNEL' ? channelRow : find('LISTING', address.channel, address.marketplace, address.accountId, address.aliasKey)
      const stack: MediaPlanStack = { shared: sharedRow ? readPlan(sharedRow.plan) : null, channel: channelRow ? readPlan(channelRow.plan) : null,
        listing: address.layer === 'LISTING' && target ? readPlan(target.plan) : null }
      const next = applyMediaOps(stack, address.layer, input.ops, sameGroup)
      const empty = address.layer !== 'SHARED' && JSON.stringify(next) === JSON.stringify(emptyMediaPlan())
      // Undo: the ops that put this layer back, each bound to what the layer holds after this edit.
      const before = address.layer === 'SHARED' ? stack.shared : address.layer === 'CHANNEL' ? stack.channel : stack.listing
      const undo = inverseMediaOps(address.layer, before ?? null, empty ? null : next)
      if (target) {
        if (empty) { const gone = await tx.productMediaPlan.deleteMany({ where: { id: target.id, revision: target.revision } }); return gone.count ? { plan: null, revision: 0, undo } : null }
        const saved = await tx.productMediaPlan.updateMany({ where: { id: target.id, revision: target.revision }, data: { plan: next, revision: { increment: 1 }, updatedById: actorId } })
        return saved.count ? { plan: next, revision: target.revision + 1, undo } : null
      }
      if (empty) return { plan: null, revision: 0, undo }
      await tx.productMediaPlan.create({ data: { ...layerWhere(rootId, address.layer, address.channel, address.marketplace, address.accountId, address.aliasKey), plan: next, updatedById: actorId } })
      return { plan: next, revision: 1, undo }
    }).catch(error => {
      if (error instanceof MediaPlanEditError) throw new WorkspaceScopeError(error.message, 409)
      if ((error as { code?: string }).code === 'P2002') return null
      throw error
    })
    if (result) {
      publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: key, ts: Date.now() })
      return { rootId, key, ...result }
    }
  }
  throw new WorkspaceScopeError('Someone else changed these photos at the same moment. Reload the page and try again.', 409)
}

// ── W4a — the same picture at two addresses ─────────────────────────────────────────────────────────────────────

/** One layer's way back after a merge: the ops that put it back, each bound to what the layer holds after the merge. */
export interface SamePhotoLayerUndo { layer: MediaLayer; channel: string; marketplace: string; accountId: string; aliasKey: string; ops: MediaOp[] }
export interface SamePhotoUndo { keep: string; drop: string; previous: string | null; repointed: string[]; layers: SamePhotoLayerUndo[] }

async function familyPhotos(rootId: string) {
  const ids = [rootId, ...(await prisma.product.findMany({ where: { parentId: rootId, deletedAt: null }, select: { id: true } })).map(c => c.id)]
  return prisma.productImage.findMany({ where: { productId: { in: ids } }, select: { id: true, productId: true, url: true, contentHash: true, versionGroupId: true,
    languageTag: true, mediaType: true, sameAsImageId: true, distinctFromIds: true } })
}

const textLanguage = (tag: string) => tag !== 'zxx' && tag !== 'mul'
const planConflict = () => new WorkspaceScopeError('Someone else changed these photos at the same moment. Reload the page and try again.', 409)

/** The stack a layer row is edited in (its own plan on top of the layers it follows). */
function stackOf(rows: ReadonlyArray<{ layer: string; channel: string; plan: unknown }>, row: { layer: string; channel: string; plan: unknown }): MediaPlanStack {
  const shared = rows.find(r => r.layer === 'SHARED'), channel = rows.find(r => r.layer === 'CHANNEL' && r.channel === row.channel)
  return { shared: shared ? readPlan(shared.plan) : null, channel: row.layer !== 'SHARED' && channel ? readPlan(channel.plan) : null, listing: row.layer === 'LISTING' ? readPlan(row.plan) : null }
}

/**
 * The Owner marks two library photos as one picture (an Amazon copy and ours): `drop` becomes a copy of `keep` — never
 * deleted — and every layer of the family that shows `drop` (or its copies) shows `keep` instead: Shared, each channel,
 * each listing, alias layers included. One transaction; the answer carries the way back.
 */
export async function markSamePhoto(productId: string, input: { keep: string; drop: string }, actorId: string | null) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const keep = rows.find(r => r.id === input.keep), drop = rows.find(r => r.id === input.drop)
  if (!keep || !drop) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (keep.id === drop.id) throw new WorkspaceScopeError('Choose two different photos.', 422)
  if (keep.mediaType !== 'IMAGE' || drop.mediaType !== 'IMAGE') throw new WorkspaceScopeError('Only photos can be marked as the same photo.', 422)
  if (keep.sameAsImageId) throw new WorkspaceScopeError('The photo to keep is itself marked as a copy of another. Reload the page.', 409)
  const keys = pictureKeys(rows)
  if (keys.get(keep.id) === keys.get(drop.id)) throw new WorkspaceScopeError('These are already one photo.', 409)
  if ((keep.versionGroupId && keep.versionGroupId === drop.versionGroupId) || (textLanguage(keep.languageTag) && textLanguage(drop.languageTag) && keep.languageTag !== drop.languageTag))
    throw new WorkspaceScopeError('These are two languages of one photo. Keep both, as language versions.', 422)
  const dropIds = rows.filter(r => keys.get(r.id) === keys.get(drop.id)).map(r => r.id)
  const same = samePhoto(rows)
  const repointed = rows.filter(r => r.sameAsImageId === drop.id).map(r => r.id)
  const layers = await prisma.$transaction(async tx => {
    const planRows = await tx.productMediaPlan.findMany({ where: { productId: rootId } })
    const undo: SamePhotoLayerUndo[] = []
    for (const row of planRows) {
      const plan = readPlan(row.plan)
      const next = dropIds.reduce((current, id) => replaceAssetInPlan(current, id, keep.id, same), plan)
      if (next === plan) continue
      const saved = await tx.productMediaPlan.updateMany({ where: { id: row.id, revision: row.revision }, data: { plan: next, revision: { increment: 1 }, updatedById: actorId } })
      if (!saved.count) throw planConflict()
      undo.push({ layer: row.layer as MediaLayer, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId, aliasKey: row.aliasKey,
        ops: inverseMediaOps(row.layer as MediaLayer, plan, next) })
    }
    await tx.productImage.update({ where: { id: drop.id }, data: { sameAsImageId: keep.id } })
    if (repointed.length) await tx.productImage.updateMany({ where: { id: { in: repointed } }, data: { sameAsImageId: keep.id } })
    return undo
  })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  const undo: SamePhotoUndo = { keep: keep.id, drop: drop.id, previous: drop.sameAsImageId, repointed, layers }
  return { rootId, layersChanged: layers.length, undo }
}

/** The way back from `markSamePhoto`, refused (nothing changes) when a set it touched changed after the merge. */
export async function undoSamePhoto(productId: string, undo: SamePhotoUndo) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const drop = rows.find(r => r.id === undo.drop)
  if (!drop || drop.sameAsImageId !== undo.keep || undo.repointed.some(id => rows.find(r => r.id === id)?.sameAsImageId !== undo.keep))
    throw new WorkspaceScopeError('This photo changed after it was marked the same, so the mark cannot be undone.', 409)
  // The rule "a set never repeats a photo" as it stands after the undo: the two photos are two again.
  const same = samePhoto(rows.map(r => r.id === drop.id ? { ...r, sameAsImageId: undo.previous } : undo.repointed.includes(r.id) ? { ...r, sameAsImageId: drop.id } : r))
  await prisma.$transaction(async tx => {
    const planRows = await tx.productMediaPlan.findMany({ where: { productId: rootId } })
    for (const step of undo.layers) {
      const row = planRows.find(r => r.layer === step.layer && r.channel === step.channel && r.marketplace === step.marketplace && r.channelConnectionId === step.accountId && r.aliasKey === step.aliasKey)
      if (!row) throw new WorkspaceScopeError('A photo set changed after it was marked the same, so the mark cannot be undone.', 409)
      let next: MediaPlan
      try { next = applyMediaOps(stackOf(planRows, row), step.layer, step.ops, same) }
      catch (error) { if (error instanceof MediaPlanEditError) throw new WorkspaceScopeError('A photo set changed after it was marked the same, so the mark cannot be undone.', 409); throw error }
      const saved = await tx.productMediaPlan.updateMany({ where: { id: row.id, revision: row.revision }, data: { plan: next, revision: { increment: 1 } } })
      if (!saved.count) throw planConflict()
    }
    await tx.productImage.update({ where: { id: drop.id }, data: { sameAsImageId: undo.previous } })
    if (undo.repointed.length) await tx.productImage.updateMany({ where: { id: { in: undo.repointed } }, data: { sameAsImageId: drop.id } })
  })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId }
}

/**
 * The lasting way back from a merge (the Undo in the page lasts seconds): the copy is its own photo again. Photo sets
 * keep showing the kept photo — nothing is sent and no set changes; the copy returns to the library, unused.
 */
export async function separateSamePhoto(productId: string, input: { drop: string }) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const drop = rows.find(r => r.id === input.drop)
  if (!drop) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (!drop.sameAsImageId) throw new WorkspaceScopeError('This photo is already its own photo.', 409)
  await prisma.productImage.update({ where: { id: drop.id }, data: { sameAsImageId: null } })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId }
}

// ── W4b — language versions of one photo ─────────────────────────────────────────────────────────────────────────

export interface VersionsUndo { groupId: string; members: Array<{ id: string; languageTag: string; versionGroupId: string | null }>; layers: SamePhotoLayerUndo[] }

/**
 * The Owner says two or more library photos are language versions of one photo (a size chart in IT, ES and FR), each
 * with its language. They join one version group (an existing one if a photo has it); every destination then shows its
 * market's version. A set that held two of them keeps one — the main-language one — in every layer of the family,
 * alias layers included. One transaction; the answer carries the way back.
 */
export async function joinVersions(productId: string, input: { ids: string[]; languages: Record<string, string> }, actorId: string | null) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const ids = [...new Set(input.ids)]
  if (ids.length < 2) throw new WorkspaceScopeError('Choose two or more photos.', 422)
  const picked = ids.map(id => rows.find(r => r.id === id))
  if (picked.some(r => !r)) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (picked.some(r => r!.mediaType !== 'IMAGE')) throw new WorkspaceScopeError('Only photos can be language versions.', 422)
  const keys = pictureKeys(rows)
  if (new Set(ids.map(id => keys.get(id))).size !== ids.length) throw new WorkspaceScopeError('Two of these are already one photo.', 409)
  // Photos already in a version group bring their group along: the result is one group.
  const groups = [...new Set(picked.map(r => r!.versionGroupId).filter((g): g is string => !!g))]
  const members = rows.filter(r => ids.includes(r.id) || (r.versionGroupId && groups.includes(r.versionGroupId)))
  const tagOf = (r: { id: string; languageTag: string }) => input.languages[r.id] ?? r.languageTag
  if (Object.values(input.languages).some(tag => !MEDIA_LANGUAGE.test(tag))) throw new WorkspaceScopeError('Choose a language for each photo.', 422)
  const tags = members.map(tagOf)
  if (tags.includes('zxx') || new Set(tags).size !== tags.length) throw new WorkspaceScopeError('Versions of one photo need a different language each (and text in them).', 422)
  const groupId = groups[0] ?? crypto.randomUUID()
  const { mainLanguage } = await loadDestinations([...new Set(rows.map(r => r.productId))])
  const keep = members.find(r => tagOf(r) === mainLanguage)?.id ?? ids[0]
  // A set may hold a member through one of its copies: the copies count as the member.
  const memberKeys = new Set(members.map(r => keys.get(r.id)))
  const withCopies = rows.filter(r => memberKeys.has(keys.get(r.id))).map(r => r.id)
  const keepCard = keys.get(keep)
  const undo: VersionsUndo = { groupId, members: members.map(r => ({ id: r.id, languageTag: r.languageTag, versionGroupId: r.versionGroupId })), layers: [] }
  await prisma.$transaction(async tx => {
    const planRows = await tx.productMediaPlan.findMany({ where: { productId: rootId } })
    for (const row of planRows) {
      const plan = readPlan(row.plan)
      // Per set, one member stays: the main-language photo (or a copy of it) when the set has it.
      const inSet = planAssetIds(plan).filter(id => withCopies.includes(id))
      const stay = inSet.find(id => keys.get(id) === keepCard) ?? keep
      const next = collapseVersionsInPlan(plan, withCopies, stay)
      if (next === plan) continue
      const saved = await tx.productMediaPlan.updateMany({ where: { id: row.id, revision: row.revision }, data: { plan: next, revision: { increment: 1 }, updatedById: actorId } })
      if (!saved.count) throw planConflict()
      undo.layers.push({ layer: row.layer as MediaLayer, channel: row.channel, marketplace: row.marketplace, accountId: row.channelConnectionId, aliasKey: row.aliasKey,
        ops: inverseMediaOps(row.layer as MediaLayer, plan, next) })
    }
    for (const member of members) await tx.productImage.update({ where: { id: member.id }, data: { languageTag: tagOf(member), versionGroupId: groupId } })
  })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId, groupId, keep, layersChanged: undo.layers.length, undo }
}

/** The way back from `joinVersions`, refused (nothing changes) when a photo or a set it touched changed after it. */
export async function undoVersions(productId: string, undo: VersionsUndo) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  if (undo.members.some(m => rows.find(r => r.id === m.id)?.versionGroupId !== undo.groupId))
    throw new WorkspaceScopeError('These photos changed after they were made language versions, so this cannot be undone.', 409)
  const restored = rows.map(r => { const m = undo.members.find(x => x.id === r.id); return m ? { ...r, languageTag: m.languageTag, versionGroupId: m.versionGroupId } : r })
  const same = samePhoto(restored)
  await prisma.$transaction(async tx => {
    const planRows = await tx.productMediaPlan.findMany({ where: { productId: rootId } })
    for (const step of undo.layers) {
      const row = planRows.find(r => r.layer === step.layer && r.channel === step.channel && r.marketplace === step.marketplace && r.channelConnectionId === step.accountId && r.aliasKey === step.aliasKey)
      if (!row) throw new WorkspaceScopeError('A photo set changed after the photos were made language versions, so this cannot be undone.', 409)
      let next: MediaPlan
      try { next = applyMediaOps(stackOf(planRows, row), step.layer, step.ops, same) }
      catch (error) { if (error instanceof MediaPlanEditError) throw new WorkspaceScopeError('A photo set changed after the photos were made language versions, so this cannot be undone.', 409); throw error }
      const saved = await tx.productMediaPlan.updateMany({ where: { id: row.id, revision: row.revision }, data: { plan: next, revision: { increment: 1 } } })
      if (!saved.count) throw planConflict()
    }
    for (const m of undo.members) await tx.productImage.update({ where: { id: m.id }, data: { languageTag: m.languageTag, versionGroupId: m.versionGroupId } })
  })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId }
}

/** A photo leaves its language versions: it is its own photo again (its language stays). Photo sets do not change. */
export async function leaveVersions(productId: string, input: { id: string }) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const row = rows.find(r => r.id === input.id)
  if (!row) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (!row.versionGroupId) throw new WorkspaceScopeError('This photo has no language versions.', 409)
  const rest = rows.filter(r => r.versionGroupId === row.versionGroupId && r.id !== row.id)
  // A group of one is no group: the last version is its own photo too.
  await prisma.productImage.updateMany({ where: { id: { in: [row.id, ...(rest.length === 1 ? [rest[0].id] : [])] } }, data: { versionGroupId: null } })
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId }
}

/** "Not the same": the two photos stop suggesting each other (and `undo` brings the suggestion back). */
export async function markDistinctPhotos(productId: string, input: { a: string; b: string }, undo = false) {
  const rootId = await familyRoot(productId)
  const rows = await familyPhotos(rootId)
  const a = rows.find(r => r.id === input.a), b = rows.find(r => r.id === input.b)
  if (!a || !b) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  if (a.id === b.id) throw new WorkspaceScopeError('Choose two different photos.', 422)
  const answer = (list: string[], other: string) => undo ? list.filter(id => id !== other) : [...new Set([...list, other])]
  await prisma.$transaction([
    prisma.productImage.update({ where: { id: a.id }, data: { distinctFromIds: answer(a.distinctFromIds, b.id) } }),
    prisma.productImage.update({ where: { id: b.id }, data: { distinctFromIds: answer(b.distinctFromIds, a.id) } }),
  ])
  publishListingEvent({ type: 'product.media.changed', productId: rootId, layer: 'LIBRARY', ts: Date.now() })
  return { rootId }
}
