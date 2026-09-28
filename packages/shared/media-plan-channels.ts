import { resolveAxis, resolveSet, resolveSwatch, valueKeyAttribute, type MediaPlanStack, type MediaSetRef } from './media-plan.js'

/**
 * Channel layouts computed from a media plan (docs/images-studio-rebuild/PLAN.md §4.4, §4.8, §4.9). Pure: the same
 * function feeds the Media page's channel views, the review, and the publishers, so what you see is what is sent.
 * Order is never changed here — no sort, no Set, no slicing without a check naming what did not fit.
 */

/** Channel limits (eBay: 24 per listing, 12 per variation value; Amazon: MAIN + PT01–08; Shopify: 250; Etsy: 20). */
export const MEDIA_LIMITS = {
  EBAY: { gallery: 24, perValue: 12, minLongEdge: 500, maxBytes: 12 * 1024 * 1024, tradingUrlChars: 3975 },
  AMAZON: { others: 8, safety: 6, minLongEdge: 500, zoomLongEdge: 1000 },
  // Shopify allows 250 media per product; Nexus publishes at most 50 per resolved storefront gallery (shopify-content.ts).
  SHOPIFY: { media: 250, storefrontGallery: 50, maxPixels: 20_000_000, maxBytes: 20 * 1024 * 1024 },
  ETSY: { images: 20, videos: 2, variationOptions: 20, firstMinEdge: 635 },
} as const
export const AMAZON_SLOTS = ['MAIN', 'PT01', 'PT02', 'PT03', 'PT04', 'PT05', 'PT06', 'PT07', 'PT08'] as const
export const AMAZON_SAFETY_SLOTS = ['PS01', 'PS02', 'PS03', 'PS04', 'PS05', 'PS06'] as const

export interface MediaAsset {
  id: string; url: string; mediaType: string; width: number | null; height: number | null
  mimeType: string | null; fileSize: number | null
  /** `zxx` no text · `mul` several languages · a language code. */
  languageTag: string
  /** Language versions of one photo share this id; null = a photo with no other versions. */
  versionGroupId: string | null
  label?: string
}
/** `values`: attribute code → value key, for every variation axis the variant has (`{ color: 'color:black' }`). */
export interface MediaVariant { productId: string; sku: string; values: Record<string, string>; included: boolean }
export interface MediaFamily {
  /** The family root (or the single product). */
  productId: string
  variants: MediaVariant[]
  /** The picture axis the family would use when no layer chose one. */
  defaultAxis: string | null
  /** Per axis (attribute code): its value keys in the family's value order. */
  valueOrder: Record<string, string[]>
  valueLabels: Record<string, string>
}
export interface MediaDestination {
  channel: 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'ETSY'
  market: string
  /** Languages to prefer, best first (eBay DE: ['de']; Amazon API: ['mul', 'it']). */
  languages: string[]
  /** The business's main language — the last resort before any version (D6). */
  mainLanguage: string
  /** eBay only: which API owns the listing. */
  api?: 'TRADING' | 'INVENTORY'
  /** eBay only: this destination is a listing alias (a second listing of the family on one account and market). */
  alias?: boolean
  /** How this destination names each value (eBay DE: `color:black` → "Schwarz"). */
  valueNames: Record<string, string>
  /** How this destination names the picture axis ("Colore", "Farbe"). */
  axisName: string | null
}

export type MediaCheckSeverity = 'error' | 'warning'
export interface MediaCheck { severity: MediaCheckSeverity; code: string; message: string; set?: MediaSetRef; assetId?: string }

export interface PickedAsset { assetId: string; placedId: string; exact: boolean; language: string }

/** The version of a photo a destination shows: its language → English → several languages → main language → any (D6). */
export function pickVersion(placedId: string, assets: ReadonlyMap<string, MediaAsset>, languages: readonly string[], mainLanguage: string): PickedAsset | null {
  const placed = assets.get(placedId)
  if (!placed) return null
  const versions = placed.versionGroupId ? [...assets.values()].filter(a => a.versionGroupId === placed.versionGroupId) : [placed]
  const neutral = versions.find(v => v.languageTag === 'zxx')
  if (neutral && versions.length === 1) return { assetId: neutral.id, placedId, exact: true, language: 'zxx' }
  for (const language of languages) {
    const hit = versions.find(v => v.languageTag === language)
    if (hit) return { assetId: hit.id, placedId, exact: true, language }
  }
  for (const language of ['en', 'mul', mainLanguage, 'zxx']) {
    const hit = versions.find(v => v.languageTag === language)
    if (hit) return { assetId: hit.id, placedId, exact: language === 'mul' || language === 'zxx', language }
  }
  return { assetId: versions[0].id, placedId, exact: false, language: versions[0].languageTag }
}

interface Context { stack: MediaPlanStack; family: MediaFamily; assets: ReadonlyMap<string, MediaAsset>; destination: MediaDestination; checks: MediaCheck[] }

const name = (ctx: Context, id: string) => ctx.assets.get(id)?.label ?? 'a photo'
const valueLabel = (ctx: Context, key: string) => ctx.family.valueLabels[key] ?? key.split(':').slice(1).join(':')

function pickAll(ctx: Context, ids: string[], ref: MediaSetRef, kinds: ReadonlySet<string> = new Set(['IMAGE'])): string[] {
  const out: string[] = []
  for (const id of ids) {
    const picked = pickVersion(id, ctx.assets, ctx.destination.languages, ctx.destination.mainLanguage)
    if (!picked) { ctx.checks.push({ severity: 'error', code: 'missing-photo', set: ref, assetId: id, message: 'A photo in this set was deleted from the library. Remove it or add it again.' }); continue }
    const asset = ctx.assets.get(picked.assetId)!
    if (!kinds.has(asset.mediaType)) continue
    if (!picked.exact) ctx.checks.push({ severity: 'warning', code: 'language-fallback', set: ref, assetId: id,
      message: `${name(ctx, id)} has no ${ctx.destination.languages.filter(l => l !== 'mul').join('/').toUpperCase() || 'matching'} version — shows ${picked.language.toUpperCase()}.` })
    if (!out.includes(picked.assetId)) out.push(picked.assetId)
  }
  return out
}

/** The picture axis a destination uses, its values in order, and which values the included variants carry. */
function axisPlan(ctx: Context) {
  const { axis } = resolveAxis(ctx.stack, ctx.family.defaultAxis)
  const included = ctx.family.variants.filter(v => v.included)
  const keyOf = (v: MediaVariant) => (axis ? v.values[axis] : undefined) ?? null
  const used = new Set(included.map(keyOf).filter((k): k is string => !!k && valueKeyAttribute(k) === axis))
  const order = (axis && ctx.family.valueOrder[axis]) || []
  const values = [...order.filter(k => used.has(k)), ...[...used].filter(k => !order.includes(k))]
  return { axis, values, included, keyOf }
}

function sizeChecks(ctx: Context, ids: string[], ref: MediaSetRef, minLongEdge: number, message: (label: string, edge: number) => string) {
  for (const id of ids) {
    const asset = ctx.assets.get(id)
    if (!asset) continue
    if (!/^https:\/\//i.test(asset.url)) ctx.checks.push({ severity: 'error', code: 'not-https', set: ref, assetId: id, message: `${name(ctx, id)} is not on a public HTTPS address.` })
    if (asset.width == null || asset.height == null) ctx.checks.push({ severity: 'warning', code: 'size-unknown', set: ref, assetId: id, message: `${name(ctx, id)}: size unknown — cannot check it.` })
    else if (Math.max(asset.width, asset.height) < minLongEdge) ctx.checks.push({ severity: 'error', code: 'too-small', set: ref, assetId: id, message: message(name(ctx, id), Math.max(asset.width, asset.height)) })
  }
}

// ── eBay ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EbayMediaLayout {
  /** Listing gallery: `PictureDetails` / group `imageUrls`. First = search photo. */
  gallery: string[]
  /** `VariationSpecificName` / `aspectsImageVariesBy`; null = one shared gallery. */
  axisName: string | null
  /** One set per value in value order: `VariationSpecificPictureSet`, and every SKU of the value on the Inventory API.
   *  `productIds` names the variants (the channel's seller SKU can differ from `skus`). */
  sets: Array<{ valueKey: string; value: string; items: string[]; skus: string[]; productIds: string[] }>
  checks: MediaCheck[]
}

export function projectEbay(stack: MediaPlanStack, family: MediaFamily, assets: ReadonlyMap<string, MediaAsset>, destination: MediaDestination): EbayMediaLayout {
  const ctx: Context = { stack, family, assets, destination, checks: [] }
  const limits = MEDIA_LIMITS.EBAY
  // First, because no photo fix helps: an Inventory listing's photos belong to its SKUs, and Nexus addresses an eBay
  // Inventory listing by the family's SKUs — the main listing's. An alias there would write the main listing's photos.
  if (destination.api === 'INVENTORY' && destination.alias) ctx.checks.push({ severity: 'error', code: 'inventory-alias',
    message: 'This alias uses the eBay Inventory API. There, photos belong to the SKUs, and this alias has the main listing\'s SKUs, so a send would change the main listing too. Nexus does not send photos to it.' })
  const gallery = pickAll(ctx, resolveSet(stack, 'common').items, 'common')
  if (!gallery.length) ctx.checks.push({ severity: 'error', code: 'no-common', set: 'common', message: 'eBay needs at least one Common photo — it is the search photo.' })
  if (gallery.length > limits.gallery) ctx.checks.push({ severity: 'error', code: 'over-limit', set: 'common', message: `Common has ${gallery.length} photos; eBay allows ${limits.gallery}.` })
  sizeChecks(ctx, gallery, 'common', limits.minLongEdge, (l, e) => `${l} is ${e} px — eBay needs ${limits.minLongEdge} px on the longest side.`)
  const { axis, values, included, keyOf } = axisPlan(ctx)
  const sets: EbayMediaLayout['sets'] = []
  if (axis && family.variants.length) {
    if (!destination.axisName) ctx.checks.push({ severity: 'error', code: 'axis-unmapped', message: `This listing has no eBay name for the picture axis (${axis}). Set the variation theme first.` })
    for (const key of values) {
      const ref: MediaSetRef = `value:${key}`
      const label = valueLabel(ctx, key)
      if (key.includes(':text:')) ctx.checks.push({ severity: 'error', code: 'value-unmapped', set: ref, message: `"${label}" is not a known option of ${axis}. Map it in the variation theme.` })
      const value = destination.valueNames[key]
      if (!value) ctx.checks.push({ severity: 'error', code: 'value-name-missing', set: ref, message: `No eBay ${destination.market} name for ${label}.` })
      const items = pickAll(ctx, resolveSet(stack, ref).items, ref)
      if (!items.length) ctx.checks.push({ severity: 'error', code: 'value-without-photos', set: ref, message: `${label} has no photos — eBay would show "no picture available".` })
      if (items.length > limits.perValue) ctx.checks.push({ severity: 'error', code: 'over-limit', set: ref, message: `${label} has ${items.length} photos; eBay allows ${limits.perValue} per value.` })
      sizeChecks(ctx, items, ref, limits.minLongEdge, (l, e) => `${l} is ${e} px — eBay needs ${limits.minLongEdge} px on the longest side.`)
      const members = included.filter(v => keyOf(v) === key)
      sets.push({ valueKey: key, value: value ?? label, items, skus: members.map(v => v.sku), productIds: members.map(v => v.productId) })
    }
    const perSku = included.filter(v => resolveSet(stack, `sku:${v.productId}`).source !== null)
    if (perSku.length) ctx.checks.push({ severity: 'warning', code: 'sku-photos-unused', message: `eBay shows photos per ${destination.axisName ?? axis}; the SKU photos of ${perSku.map(v => v.sku).join(', ')} are not used here.` })
  }
  if (destination.api === 'TRADING') {
    const chars = gallery.reduce((n, id) => n + (assets.get(id)?.url.length ?? 0), 0)
    if (chars > limits.tradingUrlChars) ctx.checks.push({ severity: 'error', code: 'url-length', set: 'common', message: `The Common photo addresses are ${chars} characters long; eBay allows ${limits.tradingUrlChars}.` })
  }
  return { gallery, axisName: axis ? destination.axisName : null, sets: axis ? sets : [], checks: ctx.checks }
}

// ── Amazon ──────────────────────────────────────────────────────────────────────────────────────────────────────

export interface AmazonItemLayout { productId: string; sku: string; slots: Partial<Record<typeof AMAZON_SLOTS[number] | 'SWCH', string>>; cut: string[] }
export interface AmazonMediaLayout { parent: AmazonItemLayout | null; items: AmazonItemLayout[]; safety: string[]; checks: MediaCheck[] }

export function projectAmazon(stack: MediaPlanStack, family: MediaFamily, assets: ReadonlyMap<string, MediaAsset>, destination: MediaDestination): AmazonMediaLayout {
  const ctx: Context = { stack, family, assets, destination, checks: [] }
  const common = pickAll(ctx, resolveSet(stack, 'common').items, 'common')
  const layout = (productId: string, sku: string, ids: string[], ref: MediaSetRef): AmazonItemLayout => {
    const slots: AmazonItemLayout['slots'] = {}
    ids.slice(0, AMAZON_SLOTS.length).forEach((id, i) => { slots[AMAZON_SLOTS[i]] = id })
    const cut = ids.slice(AMAZON_SLOTS.length)
    if (cut.length) ctx.checks.push({ severity: 'warning', code: 'does-not-fit', set: ref,
      message: `${sku}: Amazon shows 9 photos — ${cut.length} do not fit: ${cut.map(id => name(ctx, id)).join(', ')}.` })
    if (!slots.MAIN) ctx.checks.push({ severity: 'error', code: 'no-main', set: ref, message: `${sku} has no MAIN photo.` })
    return { productId, sku, slots, cut }
  }
  const { included, keyOf } = axisPlan(ctx)
  // One pick per value set and swatch — nine sizes of one colour share them, and so do their warnings.
  const valueSets = new Map<string, string[]>(), swatches = new Map<string, string | undefined>()
  const valueSet = (key: string) => valueSets.get(key) ?? valueSets.set(key, pickAll(ctx, resolveSet(stack, `value:${key}`).items, `value:${key}`)).get(key)!
  const swatchOf = (key: string) => {
    if (!swatches.has(key)) { const id = resolveSwatch(stack, key).assetId; swatches.set(key, id ? pickAll(ctx, [id], `value:${key}`)[0] : undefined) }
    return swatches.get(key)
  }
  const items: AmazonItemLayout[] = []
  for (const variant of included) {
    const own = resolveSet(stack, `sku:${variant.productId}`)
    const key = keyOf(variant)
    const valueRef: MediaSetRef | null = key ? `value:${key}` : null
    const ref: MediaSetRef = own.source !== null ? `sku:${variant.productId}` : valueRef ?? 'common'
    const set = own.source !== null ? pickAll(ctx, own.items, ref) : key ? valueSet(key) : []
    const ids = [...set, ...common.filter(id => !set.includes(id))]
    const item = layout(variant.productId, variant.sku, ids, ref)
    const swatch = key ? swatchOf(key) : undefined
    if (swatch) item.slots.SWCH = swatch
    items.push(item)
  }
  const parent = common.length || !family.variants.length ? layout(family.productId, family.variants.length ? 'Parent' : 'Product', common, 'common') : null
  const safety = pickAll(ctx, resolveSet(stack, 'safety').items, 'safety')
  if (safety.length > MEDIA_LIMITS.AMAZON.safety) ctx.checks.push({ severity: 'error', code: 'over-limit', set: 'safety', message: `Safety has ${safety.length} photos; Amazon allows ${MEDIA_LIMITS.AMAZON.safety} (PS01–PS06).` })
  const shown = new Set([...items, ...(parent ? [parent] : [])].flatMap(i => Object.values(i.slots)))
  for (const id of shown) {
    const asset = assets.get(id!)
    if (!asset || asset.width == null || asset.height == null) continue
    const edge = Math.max(asset.width, asset.height)
    if (edge < MEDIA_LIMITS.AMAZON.minLongEdge) ctx.checks.push({ severity: 'error', code: 'too-small', assetId: id, message: `${name(ctx, id!)} is ${edge} px — Amazon needs ${MEDIA_LIMITS.AMAZON.minLongEdge} px.` })
    else if (edge < MEDIA_LIMITS.AMAZON.zoomLongEdge) ctx.checks.push({ severity: 'warning', code: 'no-zoom', assetId: id, message: `${name(ctx, id!)} is ${edge} px — buyers cannot zoom below ${MEDIA_LIMITS.AMAZON.zoomLongEdge} px.` })
  }
  return { parent, items, safety, checks: ctx.checks }
}

/** The Amazon slots (MAIN, PT01–PT08, SWCH → asset id) one product receives from a layout; the parent uses `parent`. */
export function amazonSlotsFor(layout: Pick<AmazonMediaLayout, 'items' | 'parent'>, productId: string): AmazonItemLayout['slots'] | null {
  const item = layout.items.find(i => i.productId === productId) ?? (layout.parent?.productId === productId ? layout.parent : null)
  return item ? item.slots : null
}

// ── Shopify ─────────────────────────────────────────────────────────────────────────────────────────────────────

export interface ShopifyMediaLayout { media: string[]; variantImages: Record<string, string | null>; checks: MediaCheck[] }

export function projectShopify(stack: MediaPlanStack, family: MediaFamily, assets: ReadonlyMap<string, MediaAsset>, destination: MediaDestination): ShopifyMediaLayout {
  const ctx: Context = { stack, family, assets, destination, checks: [] }
  // Both spellings of a 3D model exist in stored rows (`MODEL3D` in the library comment, `MODEL_3D` in Shopify content).
  const kinds = new Set(['IMAGE', 'VIDEO', 'MODEL3D', 'MODEL_3D'])
  const media = pickAll(ctx, resolveSet(stack, 'common').items, 'common', kinds)
  const { axis, values, included, keyOf } = axisPlan(ctx)
  const setOf = new Map<string, string[]>()
  if (axis) for (const key of values) { const ids = pickAll(ctx, resolveSet(stack, `value:${key}`).items, `value:${key}`, kinds); setOf.set(key, ids); ids.forEach(id => { if (!media.includes(id)) media.push(id) }) }
  const variantImages: Record<string, string | null> = {}
  for (const variant of included) {
    const own = resolveSet(stack, `sku:${variant.productId}`)
    const key = keyOf(variant)
    const ids = own.source !== null ? pickAll(ctx, own.items, `sku:${variant.productId}`, kinds) : key ? setOf.get(key) ?? [] : []
    ids.forEach(id => { if (!media.includes(id)) media.push(id) })
    variantImages[variant.productId] = ids.find(id => assets.get(id)?.mediaType === 'IMAGE') ?? null
  }
  if (media.length > MEDIA_LIMITS.SHOPIFY.media) ctx.checks.push({ severity: 'error', code: 'over-limit', message: `Shopify allows ${MEDIA_LIMITS.SHOPIFY.media} media per product; this has ${media.length}.` })
  else if (media.length > MEDIA_LIMITS.SHOPIFY.storefrontGallery) ctx.checks.push({ severity: 'error', code: 'over-limit', message: `Nexus publishes at most ${MEDIA_LIMITS.SHOPIFY.storefrontGallery} photos in a Shopify gallery; this has ${media.length}.` })
  for (const id of media) {
    const a = assets.get(id)
    if (a?.width && a.height && a.width * a.height > MEDIA_LIMITS.SHOPIFY.maxPixels) ctx.checks.push({ severity: 'error', code: 'too-large', assetId: id, message: `${name(ctx, id)} is over 20 megapixels — Shopify refuses it.` })
    if (a?.fileSize && a.fileSize > MEDIA_LIMITS.SHOPIFY.maxBytes) ctx.checks.push({ severity: 'error', code: 'too-large', assetId: id, message: `${name(ctx, id)} is over 20 MB — Shopify refuses it.` })
  }
  return { media, variantImages, checks: ctx.checks }
}

// ── Etsy ────────────────────────────────────────────────────────────────────────────────────────────────────────

export interface EtsyMediaLayout { images: string[]; videos: string[]; variationImages: Array<{ valueKey: string; value: string; assetId: string }>; cut: string[]; checks: MediaCheck[] }

export function projectEtsy(stack: MediaPlanStack, family: MediaFamily, assets: ReadonlyMap<string, MediaAsset>, destination: MediaDestination): EtsyMediaLayout {
  const ctx: Context = { stack, family, assets, destination, checks: [] }
  const limits = MEDIA_LIMITS.ETSY
  const all = pickAll(ctx, resolveSet(stack, 'common').items, 'common')
  const videos = pickAll(ctx, resolveSet(stack, 'common').items, 'common', new Set(['VIDEO'])).slice(0, limits.videos)
  const { axis, values } = axisPlan(ctx)
  const variationImages: EtsyMediaLayout['variationImages'] = []
  if (axis) for (const key of values) {
    const ids = pickAll(ctx, resolveSet(stack, `value:${key}`).items, `value:${key}`)
    ids.forEach(id => { if (!all.includes(id)) all.push(id) })
    if (ids[0]) variationImages.push({ valueKey: key, value: destination.valueNames[key] ?? valueLabel(ctx, key), assetId: ids[0] })
  }
  const images = all.slice(0, limits.images), cut = all.slice(limits.images)
  if (cut.length) ctx.checks.push({ severity: 'warning', code: 'does-not-fit', message: `Etsy shows ${limits.images} photos — ${cut.length} do not fit: ${cut.map(id => name(ctx, id)).join(', ')}.` })
  for (const v of variationImages) if (!images.includes(v.assetId)) ctx.checks.push({ severity: 'error', code: 'variation-photo-cut', set: `value:${v.valueKey}`, message: `${v.value}'s main photo is not among the first ${limits.images}, and Etsy can only link a listing photo.` })
  if (variationImages.length > limits.variationOptions) ctx.checks.push({ severity: 'error', code: 'over-limit', message: `Etsy links photos to at most ${limits.variationOptions} options; this has ${variationImages.length}.` })
  const first = images[0] ? assets.get(images[0]) : undefined
  if (!images.length) ctx.checks.push({ severity: 'error', code: 'no-common', message: 'Etsy needs at least one photo.' })
  else if (first?.width && first.height && Math.min(first.width, first.height) < limits.firstMinEdge) ctx.checks.push({ severity: 'warning', code: 'too-small', assetId: first.id, message: `The first photo should be at least ${limits.firstMinEdge} px — Etsy ranks it lower.` })
  return { images, videos, variationImages, cut, checks: ctx.checks }
}

// ── One destination ─────────────────────────────────────────────────────────────────────────────────────────────

/** What a destination row must say for its layout: channel, market, languages, API, and the variants listed on it. */
export interface MediaDestinationTarget {
  channel: MediaDestination['channel']; marketplace: string; languages: string[]; api?: 'TRADING' | 'INVENTORY'; productIds: readonly string[]
  /** A listing alias (null or absent = the main listing). */
  alias?: { id: string } | null
}
export type ChannelMediaLayout = EbayMediaLayout | AmazonMediaLayout | ShopifyMediaLayout | EtsyMediaLayout

/**
 * One destination's layout from its layer stack — the Media page, the review and the publishers call this one function.
 * Names default to the Shared ones; a publisher passes the channel's own names and may narrow the variants to its review.
 */
export function projectMediaDestination(input: {
  stack: MediaPlanStack; family: MediaFamily; axes: ReadonlyArray<{ code: string; label: string }>; assets: ReadonlyMap<string, MediaAsset>
  target: MediaDestinationTarget; mainLanguage: string; valueNames?: Record<string, string>; axisName?: string | null; includedIds?: readonly string[]
}): ChannelMediaLayout {
  const { axis } = resolveAxis(input.stack, input.family.defaultAxis)
  const t = input.target
  const destination: MediaDestination = { channel: t.channel, market: t.marketplace, languages: t.languages, mainLanguage: input.mainLanguage, api: t.api, alias: !!t.alias,
    valueNames: input.valueNames ?? input.family.valueLabels, axisName: input.axisName !== undefined ? input.axisName : input.axes.find(a => a.code === axis)?.label ?? null }
  // A destination shows only the variants listed (and not excluded) on it; a publisher may narrow that to its review.
  const listed = new Set(input.includedIds ?? t.productIds)
  const family: MediaFamily = { ...input.family, variants: input.family.variants.map(v => ({ ...v, included: listed.has(v.productId) })) }
  const project = t.channel === 'EBAY' ? projectEbay : t.channel === 'AMAZON' ? projectAmazon : t.channel === 'SHOPIFY' ? projectShopify : projectEtsy
  return project(input.stack, family, input.assets, destination)
}

/**
 * eBay's duplicate-listings rule (PLAN.md §4.5): two listings of one item on one account and market must not look the
 * same. This page knows the photos, not the titles: a listing whose photos (gallery and value sets, in order) equal
 * another's on the same account and market gets a warning that names it and asks to check the titles.
 */
export function duplicateListingChecks(
  entries: ReadonlyArray<{ key: string; channel: string; marketplace: string; accountId: string; name: string }>,
  layouts: Readonly<Record<string, ChannelMediaLayout>>,
  urlOf: (assetId: string) => string = id => id,
): Map<string, MediaCheck[]> {
  const groups = new Map<string, Array<{ key: string; name: string }>>()
  for (const entry of entries) {
    const layout = layouts[entry.key] as EbayMediaLayout | undefined
    if (entry.channel !== 'EBAY' || !layout?.gallery?.length) continue
    const photos = JSON.stringify([layout.gallery.map(urlOf), (layout.sets ?? []).map(set => [set.valueKey, set.items.map(urlOf)])])
    const at = `${entry.marketplace}|${entry.accountId}|${photos}`
    groups.set(at, [...(groups.get(at) ?? []), { key: entry.key, name: entry.name }])
  }
  const out = new Map<string, MediaCheck[]>()
  for (const same of groups.values()) {
    if (same.length < 2) continue
    for (const entry of same) out.set(entry.key, [{ severity: 'warning', code: 'duplicate-listing-photos',
      message: `Same photos as ${same.filter(o => o.key !== entry.key).map(o => o.name).join(', ')} on this account and market. eBay does not allow two listings of one item that look the same. Check that the titles differ, or give this listing other photos.` }])
  }
  return out
}

// ── One sheet row ───────────────────────────────────────────────────────────────────────────────────────────────

export interface RowGalleryItem { placedId: string; assetId: string; exact: boolean; language: string; from: 'row' | 'common' }
export interface RowGallery {
  /** The set this row edits: Common on the parent (or a single product), else the SKU's own set or its value's set. */
  set: MediaSetRef
  label: string
  /** Variants that share the set (a value set is shared by every SKU of the value). */
  sharedBy: number
  /** The set's photos, then (on a variant) the Common photos it does not already show — in the order a buyer sees them. */
  items: RowGalleryItem[]
}

/**
 * What the Information sheet's "Product media" cell shows for one row (PLAN.md §5.7): the parent row shows Common; a
 * variant shows its own SKU set, else its value's set, then the Common photos. Each placed photo shows the version for
 * the sheet's languages (D6). The same resolver as every channel layout, so the cell and the Media page cannot disagree.
 */
export function rowGallery(input: { stack: MediaPlanStack; family: MediaFamily; productId: string; assets: ReadonlyMap<string, MediaAsset>; languages: readonly string[]; mainLanguage: string }): RowGallery {
  const { stack, family } = input
  const pick = (ids: string[], from: RowGalleryItem['from']) => ids.flatMap(id => {
    const picked = pickVersion(id, input.assets, input.languages, input.mainLanguage)
    return picked ? [{ placedId: id, assetId: picked.assetId, exact: picked.exact, language: picked.language, from }] : [{ placedId: id, assetId: id, exact: false, language: 'zxx', from }]
  })
  const common = resolveSet(stack, 'common').items
  const variant = family.variants.find(v => v.productId === input.productId)
  if (!variant) return { set: 'common', label: 'Common', sharedBy: family.variants.length || 1, items: pick(common, 'row') }
  const withCommon = (ref: MediaSetRef, label: string, sharedBy: number, own: string[]): RowGallery =>
    ({ set: ref, label, sharedBy, items: [...pick(own, 'row'), ...pick(common.filter(id => !own.includes(id)), 'common')] })
  const sku = resolveSet(stack, `sku:${variant.productId}`)
  if (sku.source !== null) return withCommon(`sku:${variant.productId}`, `${variant.sku} only`, 1, sku.items)
  const { axis } = resolveAxis(stack, family.defaultAxis)
  const key = axis ? variant.values[axis] : undefined
  if (!key) return withCommon('common', 'Common', family.variants.length, [])
  return withCommon(`value:${key}`, family.valueLabels[key] ?? key.split(':').slice(1).join(':'), family.variants.filter(v => v.values[axis!] === key).length, resolveSet(stack, `value:${key}`).items)
}

// ── Channel names ───────────────────────────────────────────────────────────────────────────────────────────────

/**
 * A publisher's own names for the picture axis and its values (pins, value maps), keyed the plan's way. `byProduct`:
 * per variant, per axis label (`Colore`), the value the channel receives; `axisNames`: per axis label, the channel's
 * axis name. Only the channel's names are returned — a value it does not name is left for the checks to report.
 */
export function channelNames(input: {
  axes: ReadonlyArray<{ code: string; label: string }>
  variants: ReadonlyArray<{ productId: string; values: Record<string, string> }>
  axis: string | null
  channelValues: { byProduct: Record<string, Record<string, string>>; axisNames: Record<string, string | null> }
  valueLabels?: Record<string, string>
}) {
  const valueNames: Record<string, string> = {}
  const conflicts: string[] = []
  for (const axis of input.axes) for (const variant of input.variants) {
    const valueKey = variant.values[axis.code], name = input.channelValues.byProduct[variant.productId]?.[axis.label]
    if (!valueKey || !name) continue
    if (valueNames[valueKey] !== undefined && valueNames[valueKey] !== name)
      conflicts.push(`${input.valueLabels?.[valueKey] ?? valueKey} is named both "${valueNames[valueKey]}" and "${name}" on this listing.`)
    valueNames[valueKey] ??= name
  }
  const label = input.axes.find(a => a.code === input.axis)?.label
  return { valueNames, axisName: label ? input.channelValues.axisNames[label] ?? null : null, conflicts }
}
