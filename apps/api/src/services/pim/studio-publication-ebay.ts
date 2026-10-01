import { usesEbayInventory } from './ebay-listing-model.js'
import type { PublicationFacts } from './studio-publication-plan.js'
import { object, publicationDigest } from './studio-publication-plan.js'
import prisma from '../../db.js'
import { loadEbaySpec } from './channel-specs/index.js'
import { buildFlatRow } from '../ebay-variation-push.service.js'
import { buildSharedListingInput } from '../ebay-shared-listing-push.service.js'
import { buildAddFixedPriceItemXml, callTradingApi, escapeXml, siteIdForMarket, TradingApiFailure, type AddFixedPriceItemInput, type TradingCallResult } from '../ebay-trading-api.service.js'
import { channelAxisValues, loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection, variationReadinessItems } from './variation-rules.service.js'
import { renderListingDescriptionSafe } from '../ebay-description-theme.service.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { publicationImages } from './studio-publication-media.js'
import { readEbayMediaGallery } from '../images/ebay-media-workspace.service.js'
import { inspectMediaDraft } from '@nexus/shared/ebay-media'
import { loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { isOnMediaPlan } from '../images/media-plan-switch.js'
import { mediaLayoutFor, type MediaChannelValues } from '../images/media-plan.service.js'
import type { EbayMediaLayout } from '@nexus/shared/media-plan-channels'
import { aspectCanonicalName } from '../ebay-theme-axes.js'
import type { StudioPublishFieldWrite } from '@nexus/shared/studio-publication'
import { parseEbayItemDocument, parseEbayPublicationItem, ebayXmlObject, ebayXmlText } from '../channel-drift/ebay-content-compare.js'
import { ebayPublicationRequest } from './studio-publication-ebay-changes.js'
import { foldName, pushExclusionsCache } from '../channel-mapping/push.js'
import { readEbayInventoryListing, type EbayInventoryDestination, type EbayInventoryRaw } from '../live-read/ebay-inventory.js'
import type { ServerLiveRead } from '../live-read/types.js'
import type { EbayInventoryOurs } from './studio-publication-ebay-inventory-changes.js'
import { ebayInventoryReads } from './studio-publication-ebay-inventory.js'
import { NO_LISTING_PRICE_FACTS, currencyCode, listingSendPrice } from './follower-price.js'
export { ebayPublicationRequest } from './studio-publication-ebay-changes.js'

export interface EbayPublication {
  kind: 'ebay'; marketplace: string; itemId: string | null; xml: string; liveRevision: string | null
  products: Array<{ productId: string; sku: string }>
  liveContent?: Record<string, unknown> | null
  liveReadError?: string
  fieldWrites?: Record<string, StudioPublishFieldWrite[]>
  /** Review notes that block nothing (a new listing at stock 0). */
  notices?: string[]
}
export interface EbayPublicationReceipt { reference: string; warnings: string[]; verified?: boolean }

function setPath(target: Record<string, any>, path: string[], value: unknown) {
  let node = target
  for (const key of path.slice(0, -1)) node = node[key] = { ...object(node[key]) }
  node[path[path.length - 1]] = value
}

/** Trading revisions preserve fields outside the submitted product payload. */
export function ebayPublicationXml(input: AddFixedPriceItemInput, itemId: string | null, single: boolean, settings: Record<string, any> = {}) {
  let xml = buildAddFixedPriceItemXml(input)
  if (single) {
    const variant = input.variations[0]
    xml = xml.replace(/    <Variations>[\s\S]*?<\/Variations>/, `    <StartPrice>${variant.price}</StartPrice><Quantity>${variant.quantity}</Quantity>${variant.ean ? `<ProductListingDetails><EAN>${escapeXml(variant.ean)}</EAN></ProductListingDetails>` : ''}`)
  }
  const extra = [
    settings.subtitle != null ? `<SubTitle>${escapeXml(String(settings.subtitle))}</SubTitle>` : '',
    settings.handlingTime != null ? `<DispatchTimeMax>${Number(settings.handlingTime)}</DispatchTimeMax>` : '',
    settings.vatRate != null ? `<VATDetails><VATPercent>${Number(settings.vatRate)}</VATPercent></VATDetails>` : '',
    single && settings.bestOffer != null ? `<BestOfferDetails><BestOfferEnabled>${settings.bestOffer === true}</BestOfferEnabled></BestOfferDetails>` : '',
    settings.quantityLimitPerBuyer != null ? `<QuantityRestrictionPerBuyer><MaximumQuantity>${Number(settings.quantityLimitPerBuyer)}</MaximumQuantity></QuantityRestrictionPerBuyer>` : '',
  ].join('')
  xml = xml.replace('</Item>', `${extra}</Item>`)
  // Missing saved origin on a revision means preserve eBay's existing origin.
  if (itemId && !input.country) xml = xml.replace(/\s*<Country>[\s\S]*?<\/Country>/, '')
  if (itemId) xml = xml.replace(/AddFixedPriceItemRequest/g, 'ReviseFixedPriceItemRequest').replace('<Item>', `<Item><ItemID>${escapeXml(itemId)}</ItemID>`)
  return xml
}

async function requestLiveItem(itemId: string, accountId: string, market: string) {
  const oauthToken = await ebayAuthService.getValidToken(accountId)
  return callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`, { oauthToken, siteId: siteIdForMarket(market), connectionId: accountId, market })
}

function liveItemReceipt(itemId: string, got: Awaited<ReturnType<typeof requestLiveItem>>): EbayPublicationReceipt {
  if (!got.raw || !['Success', 'Warning'].includes(got.ack)) throw new Error('The current eBay listing could not be verified.')
  const item = parseEbayItemDocument(got.raw)
  if (ebayXmlText(item.ItemID) !== itemId) throw new Error('eBay returned a different or unidentified listing.')
  const warnings = [...(got.errors ?? [])]
  if (ebayXmlText(ebayXmlObject(item.SellingStatus).ListingStatus) !== 'Active') return { reference: itemId, warnings: [...warnings, 'This eBay listing is not active.'], verified: false }
  if (ebayXmlText(item.InventoryTrackingMethod) === 'SKU' && item.InventoryModel !== undefined) return { reference: itemId, warnings: [...warnings, 'This listing uses the eBay Inventory model.'], verified: false }
  return { reference: itemId, warnings, verified: true }
}

/** Read the acknowledged item through the same account and marketplace; null means the provider gave no usable answer. */
export async function readEbayPublication(itemId: string, accountId: string, marketplace: string): Promise<EbayPublicationReceipt | null> {
  try { return liveItemReceipt(itemId, await requestLiveItem(itemId, accountId, marketplace)) }
  catch { return null }
}

/** One stable parsed-content digest for review and the last read before dispatch. */
export function ebayLiveContentRevision(xml: string): string {
  return publicationDigest(parseEbayPublicationItem(xml))
}

async function readLiveItem(itemId: string, accountId: string, market: string) {
  const got = await requestLiveItem(itemId, accountId, market)
  const receipt = liveItemReceipt(itemId, got)
  if (!receipt.verified) throw new Error(receipt.warnings.at(-1) ?? 'The current eBay listing could not be verified.')
  const item = parseEbayItemDocument(got.raw)
  if (ebayXmlText(item.ItemID) !== itemId) throw new Error('eBay returned a different or unidentified listing. Nothing will be sent.')
  const content = parseEbayPublicationItem(got.raw)
  return { content, revision: publicationDigest(content) }
}
const liveItem = async (itemId: string, accountId: string, market: string) => (await readLiveItem(itemId, accountId, market)).revision

/**
 * PLAN R-43 (A-39 slice b2) — the listing input this builder sends, extracted from `prepareEbayPublication` with its
 * behaviour unchanged: every refusal from the ItemID checks to the shared input, and the title / item specifics / variations
 * it computes. No publish gate, no media gallery, no description render, no live call — so a READER (the nightly eBay content
 * read, `channel-drift/ebay-content-ours.ts`) takes "ours" from the builder itself, never from a second copy of it.
 *
 * `currency`: the market's own (`facts.destination.currency`). Both the publish path and a reader pass it; since P4.4a
 * (`4774b48ff`) `buildSharedListingInput` refuses a missing one by name (A-41, R-46). It feeds only the input's `currency`
 * field, never its title or item specifics.
 */
export async function buildEbayListingInput(facts: PublicationFacts, options: { currency?: string; inventory?: boolean } = {}) {
  const { scope, parent, products, listings } = facts
  const ids = [...new Set(listings.map(l => l.externalListingId).filter((id): id is string => !!id))]
  if (ids.length > 1) throw new Error('These products belong to different eBay listings. Choose one listing alias before publishing.')
  const itemId = ids[0] ?? null
  const parentListing = listings.find(l => l.productId === parent.id)
  if (!options.inventory && usesEbayInventory(facts)) throw new Error('This listing uses the eBay Inventory model. Direct studio publication currently supports Trading listings; Inventory publication is unavailable here.')
  if (itemId) {
    const other = await prisma.channelListing.findFirst({ where: { channel: 'EBAY', channelConnectionId: scope.accountId, externalListingId: itemId,
      OR: [{ productId: { notIn: products.map(p => p.id) } }, { aliasKey: { not: facts.destination.aliasKey ?? '' } }] }, select: { id: true } })
    if (other) throw new Error('This eBay item is also used by products outside this selection. Review its complete shared listing before publishing.')
  }
  // Shared stock — each product's ledger: its own warehouses, or the pool it sells from.
  const ledgers = await loadSyncLedgers(prisma, products.map(p => p.id))
  // Images rebuild P2c — a family on the media plan takes its photos from the plan (finishEbayListingInput). Its older
  // per-product galleries are not read, so a stale one can neither block the send nor leak into it.
  const onPlan = await isOnMediaPlan(parent.id)
  let channelValues: MediaChannelValues | undefined
  const rows = []
  const identities: Array<{ productId: string; sku: string }> = []
  const galleries = new Map<string, string[]>()
  let settings: Record<string, any> = {}
  const exclusionsFor = pushExclusionsCache()
  // Round 6 — the currency this publication sends its prices in (the destination market's; `listingSendPrice` below).
  const marketCur = currencyCode(facts.destination.currency)
  for (const product of products) {
    const listing = listings.find(l => l.productId === product.id)
    if (listing?.fulfillmentMethod === 'FBA') throw new Error('This eBay listing uses Amazon fulfillment. Its fulfillment publication workflow is required.')
    const resolved = facts.resolved[0]?.products.find(r => r.productId === product.id)
    // A-56 — typed on purpose: `resolved` arrives untyped, so the one category string went into `loadEbaySpec(…, categoryIds: string[])`
    // unchecked, and every Trading listing that reached here failed with "categoryIds.map is not a function" (since 2026-09-13).
    const category: string | null | undefined = resolved?.category.channelCategoryId
    if (!resolved || !category) throw new Error(`${product.sku}: choose an eBay category in Information.`)
    const spec = await loadEbaySpec(scope.marketplace, [category])
    if (spec.absent) throw new Error(`${product.sku}: the eBay category schema is unavailable.`)
    const effective: Record<string, any> = { ...listing, region: scope.marketplace, platformAttributes: { ...object(listing?.platformAttributes), categoryId: category }, flatFileSnapshot: null }
    for (const field of spec.fields) {
      const cell = resolved.cells[field.key]
      if (!cell || cell.value === undefined || !field.channelStore) continue
      if (field.channelStore.kind === 'platformAttributes') setPath(effective.platformAttributes, field.channelStore.path, cell.value)
      else effective[field.channelStore.column] = cell.value
    }
    // CHMAP M4 — item specifics the Owner chose not to send in the ACTIVE mapping version (a live listing keeps eBay's value).
    const excluded = await exclusionsFor('EBAY', scope.marketplace, category)
    if (excluded.fieldKeys.size || excluded.specifics.size) {
      const names = new Set([...excluded.specifics, ...spec.fields.filter(f => excluded.fieldKeys.has(f.key) && f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics')
        .map(f => foldName((f.channelStore as { path: string[] }).path[1]))])
      effective.platformAttributes.itemSpecifics = Object.fromEntries(Object.entries(object(effective.platformAttributes.itemSpecifics)).filter(([name]) => !names.has(foldName(name))))
    }
    const pa = effective.platformAttributes
    // These saved fields require transport support; silently omitting them would publish a different product.
    for (const key of ['videoId', 'compatibility', 'regulatory', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'bestOfferFloor', 'bestOfferCeiling']) {
      if (!itemId && pa[key] != null && pa[key] !== '' && pa[key] !== 0 && pa[key] !== false) throw new Error(`${product.sku}: ${key} needs the eBay offer publication workflow before this listing can be sent.`)
    }
    if (pa.listingFormat && pa.listingFormat !== 'FIXED_PRICE') throw new Error('Direct publication supports fixed-price eBay listings.')
    if (products.length > 1 && pa.bestOffer === true) throw new Error('eBay does not support Best Offer on a variation listing. Turn it off in Information before publishing.')
    if (product.id === parent.id) settings = pa
    // Round 6 — THE send price (`listingSendPrice`): a pin's own price, a follower's rule price from the current master in
    // the master currency, else the price the listing holds. It sent a follower the master price (the resolved price cell
    // of a follower IS the master): "master +10%" went live at the master, and eBay UK was sent the EUR number as pounds.
    // Nothing to send is refused for that SKU, by name. A variation parent sells nothing itself.
    const send = listingSendPrice(listing ?? NO_LISTING_PRICE_FACTS, { masterPrice: product.basePrice, marketCurrency: marketCur, where: `eBay ${scope.marketplace}` })
    // A market with no currency is refused by name further on ("No currency was resolved…"): nothing is sent either way.
    if (send.price == null && !product.isParent && marketCur) throw new Error(`${product.sku}: ${send.reason}`)
    const price = Number(send.price ?? resolved.cells.price?.value ?? product.basePrice)
    const ledger = ledgers.get(product.id)
    const tracked = !!ledger && (ledger.ledger.length > 0 || ledger.uncountedIsZero)
    const following = listing?.followMasterQuantity !== false
    // A pooled product follows the pool: its own Product.totalStock (what the mapped cell resolves to by
    // default) is not what it sells from.
    const requested = following && ledger?.source.kind === 'pool'
      ? ledger.quantity
      : Number(resolved.cells.quantity?.value ?? (!following ? listing!.quantityOverride ?? listing!.quantity : product.totalStock))
    const available = Math.max(0, (tracked ? ledger!.available : product.totalStock) - (listing?.stockBuffer ?? 0))
    const quantity = Math.min(Math.max(0, Math.trunc(requested)), available)
    effective.price = { toNumber: () => price }
    effective.quantity = quantity
    effective.title = String(resolved.cells.title?.value ?? effective.title ?? product.name)
    effective.description = String(resolved.cells.description?.value ?? effective.description ?? '')
    effective.updatedAt = listing?.updatedAt ?? product.updatedAt
    const row = buildFlatRow({ ...product, channelListings: [effective] } as any, { marketplace: scope.marketplace, parentImages: parent.images })
    if (typeof row.sku !== 'string' || !row.sku.trim()) throw new Error(`${product.sku}: the eBay seller SKU is unavailable.`)
    identities.push({ productId: product.id, sku: row.sku })
    row[`${scope.marketplace.toLowerCase()}_price`] = price
    row[`${scope.marketplace.toLowerCase()}_qty`] = quantity
    if (!onPlan) {
      const images = pa._productMediaLocales !== undefined ? publicationImages(facts, product)
        : Array.isArray(pa.imageUrls) ? pa.imageUrls as string[] : publicationImages(facts, product)
      if (images.length > 24 || images.some(url => !/^https:\/\//i.test(url))) throw new Error(`${product.sku}: eBay needs at most 24 publicly accessible HTTPS images.`)
      galleries.set(product.id, images)
      for (let i = 0; i < 6; i++) row[`image_${i + 1}`] = images[i] ?? ''
    }
    rows.push(row)
  }
  const parentRow = rows[0], variants = products.length > 1 ? rows.slice(1) : rows
  if (products.length > 1) {
    const { input, cell } = await loadStoredVariationProjection({ productId: parent.id, channel: 'EBAY', market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    // VTR step 0 — the channel cells (pins, value maps) the Information sheet shows, not the Shared values.
    input.family.variants = input.family.variants?.map(v => ({ ...v, included: products.some(p => p.id === v.id),
      axisValues: channelAxisValues(v.axisValues, cell.axes, facts.resolved[0]?.products.find(p => p.productId === v.id)?.cells ?? {}, facts.resolved[0]?.catalogue?.fields ?? []) }))
    const projection = resolveVariationProjection(input)
    // A live re-publish is validated like a first one: the review must not compare a structure that could not be sent.
    const problems = variationReadinessItems(projection, `EBAY ${scope.marketplace}`).filter(i => i.severity === 'error')
    if (problems.length) throw new Error(problems.map(i => i.message).join('; '))
    const axes = projection.axes.filter(a => a.included)
    if (!axes.length || axes.some(a => !a.channelName)) throw new Error('Set the eBay variation theme in Information before publishing.')
    parentRow.variation_theme = axes.map(a => a.channelName).join(',')
    for (const row of variants) for (const axis of axes) {
      const value = input.family.variants?.find(v => v.id === row._productId)?.axisValues[axis.familyKey]
      if (!value) throw new Error(`${row.sku}: ${axis.familyKey} is missing.`)
      if (axis.channelName) row[`aspect_${axis.channelName.replace(/ /g, '_')}`] = value ?? ''
    }
    // The values this listing receives, per variant — the media plan names its photo sets with them.
    channelValues = { byProduct: Object.fromEntries((input.family.variants ?? []).map(v => [v.id, v.axisValues])), axisNames: Object.fromEntries(axes.map(a => [a.familyKey, a.channelName ?? null])) }
  }
  const shared = buildSharedListingInput(parentRow, variants, scope.marketplace, undefined, object(parentListing?.platformAttributes)._axisValueOrder, options.currency)
  return { shared, itemId, parentListing, settings, galleries, variants, identities, media: onPlan ? { channelValues } : null }
}

/** Images rebuild P2c — the plan's eBay layout, checked, as the Trading/Inventory input's pictures (screen order = payload order). */
async function ebayPicturesFromPlan(facts: PublicationFacts, shared: Awaited<ReturnType<typeof buildEbayListingInput>>['shared'], channelValues: MediaChannelValues | undefined) {
  const { scope, parent, products } = facts
  const media = await mediaLayoutFor({ productId: parent.id, channel: 'EBAY', marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '',
    includedIds: products.map(p => p.id), channelValues })
  if (!media || media.layout.channel !== 'EBAY') throw new Error('This product\'s photo plan changed while publishing. Review again.')
  const layout = media.layout as EbayMediaLayout & { channel: 'EBAY' }
  const errors = layout.checks.filter(c => c.severity === 'error')
  if (errors.length) throw new Error(errors.map(c => c.message).join('; '))
  shared.pictureUrls = layout.gallery.map(media.url)
  if (!layout.axisName || !layout.sets.length) { shared.variationPictures = undefined; return }
  const axisName = shared.variationSpecificNames.find(name => aspectCanonicalName(name) === aspectCanonicalName(layout.axisName!))
  if (!axisName) throw new Error(`Photos vary by ${layout.axisName}, which is not a variation of this eBay listing. Choose the photo axis on the Media page.`)
  const allowed = shared.variationSpecificsSet?.[axisName] ?? shared.variations.map(v => String(v.specifics?.[axisName] ?? ''))
  for (const set of layout.sets) if (!allowed.includes(set.value)) throw new Error(`${set.value} is not a ${axisName} value of this eBay listing.`)
  shared.variationPictures = { axisName, byValue: Object.fromEntries(layout.sets.map(set => [set.value, set.items.map(media.url)])), order: layout.sets.map(set => set.value) }
}

function assertLiveEbay() {
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') throw new Error('Live eBay publication is disabled for this connection.')
}

// The marker lives in ./ebay-listing-model.ts so the Media page reads the same rule without loading this publisher.
export { usesEbayInventory }

export interface EbayInventoryPublication {
  kind: 'ebay-inventory'; marketplace: string; itemId: string; destination: EbayInventoryDestination
  owner: { productId: string; sku: string }; products: Array<{ productId: string; sku: string }>
  ours: EbayInventoryOurs; live: ServerLiveRead<EbayInventoryRaw>
}

export const INVENTORY_ALIAS_REFUSAL = 'This listing alias uses the eBay Inventory API. Nexus sends Inventory listings by the family\'s SKUs, and those belong to the main listing, so it cannot send to this alias. Nothing was sent.'

/** PE P3.4 — Nexus now (the same builder as Trading) and the live group, for the change-only review of an Inventory listing. */
export async function prepareEbayInventoryPublication(facts: PublicationFacts): Promise<EbayInventoryPublication> {
  const { scope, parent } = facts
  // Nexus addresses an Inventory listing by the family's parent SKU (its group) and SKUs — the main listing's. On an
  // alias that would read and write the main listing, so an Inventory alias is refused before anything is read.
  if (facts.destination.aliasKey) throw new Error(INVENTORY_ALIAS_REFUSAL)
  assertLiveEbay()
  const built = await buildEbayListingInput(facts, { currency: facts.destination.currency ?? undefined, inventory: true })
  if (!built.itemId) throw new Error('This eBay Inventory listing has no eBay item. Create it on eBay before publishing changes.')
  const shared = await finishEbayListingInput(facts, built)
  const owner = built.identities.find(i => i.productId === parent.id) ?? built.identities[0]
  if (!owner) throw new Error('No included eBay product can own this listing publication.')
  const children = built.identities.filter(i => i.productId !== owner.productId)
  const destination: EbayInventoryDestination = { productId: parent.id, channel: 'EBAY', marketplace: scope.marketplace, accountId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', expectedSkus: children.map(c => c.sku), itemId: built.itemId, parentSku: parent.sku }
  const live = await readEbayInventoryListing(destination, ebayInventoryReads(scope.accountId, scope.marketplace, built.itemId))
  const bySku = new Map(built.identities.map(i => [i.sku, i.productId]))
  const ours: EbayInventoryOurs = { title: shared.title, description: shared.description, pictures: shared.pictureUrls ?? [],
    aspects: Object.fromEntries(Object.entries(shared.itemSpecifics ?? {}).map(([name, values]) => [name, (Array.isArray(values) ? values : [values]).map(String)])),
    axes: shared.variationSpecificNames, order: shared.variationSpecificsSet ?? {},
    variants: shared.variations.filter(v => bySku.has(v.sku)).map(v => ({ productId: bySku.get(v.sku)!, sku: v.sku, values: v.specifics })) }
  // Images rebuild P2d — each SKU carries its value's photos (the same sets a Trading listing sends as picture sets).
  if (shared.variationPictures) {
    const { axisName, byValue } = shared.variationPictures
    const skus = Object.fromEntries(shared.variations.filter(v => bySku.has(v.sku)).flatMap(v => {
      const urls = byValue[String(v.specifics?.[axisName] ?? '')]
      return urls?.length ? [[v.sku, urls]] : []
    }))
    if (Object.keys(skus).length) ours.variationPictures = { axis: axisName, bySku: skus }
  }
  return { kind: 'ebay-inventory', marketplace: scope.marketplace, itemId: built.itemId, destination, owner, products: [owner], ours, live }
}

/** Origin, pictures, policies and the rendered description — the same for a Trading and an Inventory listing. */
async function finishEbayListingInput(facts: PublicationFacts, built: Awaited<ReturnType<typeof buildEbayListingInput>>, notices: string[] = []) {
  const { scope, parent, products } = facts
  const { shared, itemId, parentListing, settings, galleries, variants } = built
  const metadata = object(facts.account.connectionMetadata), defaults = object(metadata.ebayPolicies)
  const origin = object(metadata.itemLocation)
  // A blank cell falls through to the account's default, then the server's.
  const firstText = (...values: unknown[]) => String(values.find(value => value != null && String(value).trim() !== '') ?? '').trim()
  shared.country = firstText(settings.itemLocationCountry, origin.country, process.env.EBAY_ITEM_COUNTRY)
  shared.location = firstText(settings.itemLocation, origin.city, process.env.EBAY_ITEM_LOCATION)
  shared.postalCode = firstText(settings.itemPostalCode, origin.postalCode, process.env.EBAY_ITEM_POSTAL_CODE)
  // eBay takes the country with a postal code OR a city (Trading `Item.PostalCode` / `Item.Location`: one of the two).
  if (!itemId && (!shared.country || (!shared.location && !shared.postalCode))) throw new Error('eBay needs the item location country and a postal code or city to create a listing. Set "Item location country" and "Item location postal code" on this listing\'s main row in the sheet.')
  if (built.media) await ebayPicturesFromPlan(facts, shared, built.media.channelValues)
  else shared.pictureUrls = galleries.get(parent.id) ?? []
  if (!built.media && shared.variationPictures) {
    const axis = shared.variationPictures.axisName
    for (const [value] of Object.entries(shared.variationPictures.byValue)) {
      const matching = variants.filter(row => String(row[`aspect_${axis.replace(/ /g, '_')}`]) === value)
      const urls = [...new Set(matching.flatMap(row => galleries.get(String(row._productId)) ?? []))]
      if (urls.length > 24) throw new Error(`The ${value} variation gallery exceeds eBay's 24-image limit.`)
      if (urls.length) shared.variationPictures.byValue[value] = urls
    }
  }
  shared.policies = { fulfillmentPolicyId: shared.policies?.fulfillmentPolicyId ?? defaults.fulfillmentPolicyId,
    paymentPolicyId: shared.policies?.paymentPolicyId ?? defaults.paymentPolicyId, returnPolicyId: shared.policies?.returnPolicyId ?? defaults.returnPolicyId }
  if (!built.media && parentListing && object(parentListing.platformAttributes)._mediaGalleryDraft !== undefined) {
    const axes = shared.variationSpecificNames.map(name => ({ name, key: name, label: name, values: shared.variationSpecificsSet?.[name] ?? [] }))
    const gallery = await readEbayMediaGallery(parent.id, { axes, axesVerified: true, destination: { ...facts.destination, productId: parent.id,
      listing: { id: parentListing.id, productId: parent.id, aliasKey: parentListing.aliasKey, version: parentListing.version } } })
    const inspection = inspectMediaDraft(gallery.draft, gallery.assets)
    if (inspection.problems.length) throw new Error(inspection.problems.join('; '))
    const urls = (ids: string[]) => ids.map(id => gallery.assets.find(a => a.id === id)!.url)
    shared.pictureUrls = urls(gallery.draft.galleries.find(g => g.axis === null)?.assetIds ?? [])
    if (gallery.draft.axis && !axes.some(a => a.name === gallery.draft.axis)) throw new Error('The saved image grouping does not match this listing’s variation theme. Review Images before publishing.')
    shared.variationPictures = gallery.draft.axis ? { axisName: gallery.draft.axis, byValue: Object.fromEntries(gallery.draft.galleries
      .filter(g => g.axis === gallery.draft.axis && g.value !== null).map(g => [g.value!, urls(g.assetIds)])) } : undefined
  }
  if (!itemId && Object.values(shared.policies).some(v => !v)) throw new Error('Choose shipping, payment and return policies in Information before publishing.')
  if (!itemId && (!shared.title.trim() || !shared.description.trim() || !shared.pictureUrls?.length)) throw new Error('A title, description and product image are required for eBay.')
  if (!itemId && shared.variations.some(v => v.price == null || !Number.isFinite(v.price) || v.price <= 0 || !Number.isSafeInteger(v.quantity))) throw new Error('Every included variation needs a valid price and quantity.')
  // Owner 2026-10-01: a new listing may start at 0 and get its stock later. eBay keeps a listing at 0 alive (hidden from
  // search) only while the account's out-of-stock option is on; without it a listing cannot wait at 0. eBay's own dry
  // run (`sendEbayPublication`) still decides before anything is created.
  if (!itemId && !shared.variations.some(v => v.quantity > 0)) {
    const { readEbayOutOfStockPreference } = await import('../channel-delist.service.js')
    const outOfStock = await readEbayOutOfStockPreference(scope.accountId, scope.marketplace)
    if (outOfStock === 'OFF') throw new Error('The stock is 0, and this eBay account\'s out-of-stock option is off, so eBay cannot hold the listing at 0. Turn on the out-of-stock option in eBay (Account › Site Preferences › Selling preferences), then refresh this review.')
    if (outOfStock !== 'ON') throw new Error('The stock is 0, and Nexus could not read this eBay account\'s out-of-stock option. Refresh this review.')
    notices.push('The stock is 0. eBay keeps this listing hidden from search until it has stock.')
  }
  const rendered = await renderListingDescriptionSafe(prisma, { productId: parent.id, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', mode: products.length > 1 ? 'group' : 'single', body: shared.description, title: shared.title })
  if (rendered.warnings.length) throw new Error(rendered.warnings.join('; '))
  shared.description = rendered.html
  return shared
}

export async function prepareEbayPublication(facts: PublicationFacts): Promise<EbayPublication> {
  const { scope, products } = facts
  assertLiveEbay()
  const built = await buildEbayListingInput(facts, { currency: facts.destination.currency ?? undefined })
  const { itemId, settings, identities } = built
  const notices: string[] = []
  const shared = await finishEbayListingInput(facts, built, notices)
  let liveRevision: string | null = null, liveContent: Record<string, unknown> | null = null, liveReadError: string | undefined
  if (itemId) {
    try { const live = await readLiveItem(itemId, scope.accountId, scope.marketplace); liveRevision = live.revision; liveContent = live.content }
    catch (error) { liveReadError = error instanceof Error ? error.message : String(error) }
  }
  return { kind: 'ebay', marketplace: scope.marketplace, itemId, liveRevision, liveContent, ...(liveReadError ? { liveReadError } : {}), ...(notices.length ? { notices } : {}), products: identities,
    xml: ebayPublicationXml(shared as AddFixedPriceItemInput, itemId, products.length === 1, settings) }
}

export async function sendEbayPublication(plan: EbayPublication, accountId: string, operationId: string,
  beforeSend?: (request: { operation: string; xml: string }) => Promise<void>): Promise<EbayPublicationReceipt> {
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') throw Object.assign(new Error('Live eBay publication was disabled.'), { notSent: true })
  const markNotSent = (error: unknown): never => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
  if (plan.itemId && await liveItem(plan.itemId, accountId, plan.marketplace).catch(markNotSent) !== plan.liveRevision) throw Object.assign(new Error('eBay changed after the review. Refresh the publication review.'), { notSent: true })
  const oauthToken = await ebayAuthService.getValidToken(accountId).catch(markNotSent)
  const ctx = { oauthToken, siteId: siteIdForMarket(plan.marketplace), connectionId: accountId, market: plan.marketplace }
  let validationWarnings: string[] = []
  if (!plan.itemId) {
    const check = await callTradingApi('VerifyAddFixedPriceItem', plan.xml.replace(/AddFixedPriceItemRequest/g, 'VerifyAddFixedPriceItemRequest'), ctx)
      .catch(error => { throw Object.assign(error, { notSent: true }) })
    if (!check.raw || !['Success', 'Warning'].includes(check.ack)) throw Object.assign(new Error('eBay did not validate this listing. Nothing was submitted.'), { notSent: true })
    validationWarnings = check.errors ?? []
  }
  const { operation, xml } = ebayPublicationRequest(plan, operationId)
  try { await beforeSend?.({ operation, xml }) } catch (error) { markNotSent(error) }
  let sent: TradingCallResult
  try {
    // Keep both operations explicit for the repository's Trading-write audit census.
    sent = await callTradingApi(operation === 'ReviseFixedPriceItem' ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem', xml, ctx)
  } catch (error) {
    if (error instanceof TradingApiFailure && error.duplicateSubmission) {
      if (error.priorItemId) return { reference: error.priorItemId, warnings: [...validationWarnings, error.message] }
      throw error
    }
    if (error instanceof Error && /^eBay (?:Add|Revise)FixedPriceItem Failure:/.test(error.message)) markNotSent(error)
    throw error
  }
  const itemId = sent.itemId ?? plan.itemId
  if (!sent.raw || !['Success', 'Warning'].includes(sent.ack) || !itemId || !/^\d+$/.test(itemId)) throw new Error('eBay did not confirm the publication. Check the channel before retrying.')
  const warnings = [...new Set([...validationWarnings, ...(sent.errors ?? [])])]
  return { reference: itemId, warnings }
}
