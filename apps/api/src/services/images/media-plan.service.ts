import prisma from '../../db.js'
import { applyMediaOps, emptyMediaPlan, MediaPlanEditError, mediaPlanSchema, mediaLayerKey, resolveAxis, type MediaLayer, type MediaOp, type MediaPlan, type MediaPlanStack } from '@nexus/shared/media-plan'
import { channelNames, projectAmazon, projectEbay, projectEtsy, projectShopify, type MediaAsset, type MediaDestination, type MediaFamily } from '@nexus/shared/media-plan-channels'
import { storedVariationValues } from '../pim/stored-variation-projection.js'
import { optionForValue, type DictionaryAttribute } from '../pim/family-variations-core.js'
import { canonicalVariantAxis } from '../pim/variant-attribute-keys.js'
import { marketLanguages, type MarketLanguageRow } from '../pim/market-languages.js'
import { NoConnectionError, resolveChannelConnectionId } from '../connection-resolver.service.js'
import { WorkspaceScopeError } from '../pim/workspace-destination.js'
import { publishListingEvent } from '../listing-events.service.js'
import { readExcludedListingIds } from '../pim/variation-excluded.js'
import { usesEbayInventory } from '../pim/ebay-listing-model.js'
import { isOnMediaPlan } from './media-plan-switch.js'

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
    languageTag: true, versionGroupId: true, isPrimary: true, posterUrl: true, durationSec: true } })
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
  const accounts = accountIds.length ? await prisma.channelConnection.findMany({ where: { id: { in: accountIds } }, select: { id: true, accountLabel: true, isActive: true, isPrimary: true } }) : []
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
  return { mainLanguage, destinations: [...groups.entries()].map(([key, g]) => {
    const alias = g.aliasKey ? aliases.find(a => a.id === g.aliasKey) ?? null : null
    const account = accounts.find(a => a.id === g.accountId)
    const marketList = [...g.markets.keys()].sort((a, b) => (g.markets.get(b)! - g.markets.get(a)!) || a.localeCompare(b))
    const own = g.channel === 'EBAY' ? languagesOf('EBAY', g.marketplace) : g.channel === 'AMAZON' ? ['mul', ...languagesOf('AMAZON', marketList[0])] : [mainLanguage]
    const refusal = !g.accountId ? 'This listing has no account, so its photos cannot be set here.' : !account ? 'This account is not available in this business.'
      : alias && alias.status !== 'ACTIVE' ? 'This listing alias is archived.' : null
    return { key, channel: g.channel, marketplace: g.marketplace, markets: marketList, accountId: g.accountId, accountLabel: account?.accountLabel ?? null,
      accountActive: account?.isActive ?? false, alias: alias ? { id: alias.id, label: alias.label, position: alias.position } : null,
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
  return { root, family, axes, unmapped, library, layers, byKey: new Map(layers.map(l => [l.key, l])), assets, destinations, mainLanguage }
}
type MediaContext = Awaited<ReturnType<typeof loadMediaContext>>

function projectDestination(ctx: MediaContext, d: Destination, overrides: MediaLayoutOverrides = {}) {
  const shared = ctx.byKey.get('SHARED')?.plan ?? null
  const stack: MediaPlanStack = { shared, channel: ctx.byKey.get(`CHANNEL:${d.channel}`)?.plan ?? null, listing: ctx.byKey.get(d.key)?.plan ?? null }
  const axis = ctx.axes.find(a => a.code === (stack.listing?.axis ?? stack.channel?.axis ?? shared?.axis ?? ctx.family.defaultAxis))
  const destination: MediaDestination = { channel: d.channel, market: d.marketplace, languages: d.languages, mainLanguage: ctx.mainLanguage, api: d.api,
    valueNames: overrides.valueNames ?? ctx.family.valueLabels, axisName: overrides.axisName !== undefined ? overrides.axisName : axis?.label ?? null }
  const project = d.channel === 'EBAY' ? projectEbay : d.channel === 'AMAZON' ? projectAmazon : d.channel === 'SHOPIFY' ? projectShopify : projectEtsy
  // A destination shows only the variants listed (and not excluded) on it; a publisher may narrow that to its review.
  const listed = new Set(overrides.includedIds ?? d.productIds)
  const family: MediaFamily = { ...ctx.family, variants: ctx.family.variants.map(v => ({ ...v, included: listed.has(v.productId) })) }
  // Revisions of the layers this destination reads — a publisher binds its review to them.
  const revisions = [ctx.byKey.get('SHARED'), ctx.byKey.get(`CHANNEL:${d.channel}`), ctx.byKey.get(d.key)].map(l => l ? `${l.key}@${l.revision}` : null).filter(Boolean)
  return { channel: d.channel, revisions, ...project(stack, family, ctx.assets, destination) }
}

export async function readMediaWorkspace(productId: string) {
  const started = Date.now()
  const rootId = await familyRoot(productId)
  const ctx = await loadMediaContext(rootId)
  const layouts = Object.fromEntries(ctx.destinations.filter(d => d.targetable).map(d => [d.key, projectDestination(ctx, d)]))
  return { productId, rootId, sku: ctx.root.sku, name: ctx.root.name, mainLanguage: ctx.mainLanguage, family: { ...ctx.family, axes: ctx.axes, unmapped: ctx.unmapped },
    library: ctx.library, layers: ctx.layers, destinations: ctx.destinations, layouts,
    // Value and axis names here are the Shared ones; a publisher passes each market's own names (value maps, pins).
    meta: { tookMs: Date.now() - started, names: 'shared' as const } }
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
  return { rootId, destination: d, layout, url, mainLanguage: ctx.mainLanguage }
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
export async function applyMediaPlanOps(productId: string, input: { address: MediaLayerAddress; ops: MediaOp[] }, actorId: string | null) {
  const rootId = await familyRoot(productId)
  const address = await checkedAddress(rootId, input.address)
  const ids = [rootId, ...(await prisma.product.findMany({ where: { parentId: rootId, deletedAt: null }, select: { id: true } })).map(c => c.id)]
  const library = await prisma.productImage.findMany({ where: { productId: { in: ids } }, select: { id: true, versionGroupId: true } })
  const group = new Map(library.map(a => [a.id, a.versionGroupId]))
  const introduced = input.ops.flatMap(op => op.op === 'insert' ? op.assetIds : op.op === 'swatch' && op.assetId ? [op.assetId] : [])
  const foreign = introduced.filter(id => !group.has(id))
  if (foreign.length) throw new WorkspaceScopeError('A photo is not in this product\'s library any more. Reload the page.', 409)
  const sameGroup = (a: string, b: string) => a === b || (!!group.get(a) && group.get(a) === group.get(b))
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
      if (target) {
        if (empty) { const gone = await tx.productMediaPlan.deleteMany({ where: { id: target.id, revision: target.revision } }); return gone.count ? { plan: null, revision: 0 } : null }
        const saved = await tx.productMediaPlan.updateMany({ where: { id: target.id, revision: target.revision }, data: { plan: next, revision: { increment: 1 }, updatedById: actorId } })
        return saved.count ? { plan: next, revision: target.revision + 1 } : null
      }
      if (empty) return { plan: null, revision: 0 }
      await tx.productMediaPlan.create({ data: { ...layerWhere(rootId, address.layer, address.channel, address.marketplace, address.accountId, address.aliasKey), plan: next, updatedById: actorId } })
      return { plan: next, revision: 1 }
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
