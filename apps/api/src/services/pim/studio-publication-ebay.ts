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
import { reconcileEbayPolicies } from '../ebay-policy-reconcile.service.js'
import { ebayAccountService } from '../ebay-account.service.js'
import { EBAY_POLICY_FIELD, EBAY_POLICY_KINDS, ebayLocationKnownMissing, ebayMarketplaceId, ebayPolicyKnownMissing, isCompleteEbayLocation, resolveEbayItemLocation, usableEbayLocation, type EbayPolicyKind } from '../ebay-account-defaults.js'
import { EbaySendingOff, ebayFieldLabel, ebayProblems, stripSku, type EbayProblems } from './studio-publication-ebay-problems.js'
import { ebaySendsLive } from './studio-publication-ebay-verify.js'
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

/** A saved value that would be sent (blank, 0 and false send nothing). */
const filled = (value: unknown) => value != null && value !== '' && value !== 0 && value !== false && !(typeof value === 'string' && !value.trim())

function setPath(target: Record<string, any>, path: string[], value: unknown) {
  let node = target
  for (const key of path.slice(0, -1)) node = node[key] = { ...object(node[key]) }
  node[path[path.length - 1]] = value
}

// #36 (2026-10-01) — eBay Trading takes a listing's package type, weight and size as ONE item-level ShippingPackageDetails.
// The sheet stores eBay's Inventory names (PACKAGE_THICK_ENVELOPE); Trading names them differently (ShippingPackageCodeType).
const TRADING_PACKAGES: Readonly<Record<string, string>> = {
  LETTER: 'Letter', BULKY_GOODS: 'BulkyGoods', CARAVAN: 'Caravan', CARS: 'Cars', EUROPALLET: 'Europallet', EXPANDABLE_TOUGH_BAGS: 'ExpandableToughBags',
  EXTRA_LARGE_PACK: 'ExtraLargePack', FURNITURE: 'Furniture', INDUSTRY_VEHICLES: 'IndustryVehicles', LARGE_CANADA_POSTBOX: 'LargeCanadaPostBox',
  LARGE_CANADA_POST_BUBBLE_MAILER: 'LargeCanadaPostBubbleMailer', LARGE_ENVELOPE: 'LargeEnvelope', MAILING_BOX: 'MailingBoxes', MEDIUM_CANADA_POST_BOX: 'MediumCanadaPostBox',
  MEDIUM_CANADA_POST_BUBBLE_MAILER: 'MediumCanadaPostBubbleMailer', MOTORBIKES: 'Motorbikes', ONE_WAY_PALLET: 'OneWayPallet', PACKAGE_THICK_ENVELOPE: 'PackageThickEnvelope',
  PADDED_BAGS: 'PaddedBags', PARCEL_OR_PADDED_ENVELOPE: 'ParcelOrPaddedEnvelope', ROLL: 'Roll', SMALL_CANADA_POST_BOX: 'SmallCanadaPostBox',
  SMALL_CANADA_POST_BUBBLE_MAILER: 'SmallCanadaPostBubbleMailer', TOUGH_BAGS: 'ToughBags', UPS_LETTER: 'UPSLetter', USPS_FLAT_RATE_ENVELOPE: 'USPSFlatRateEnvelope',
  USPS_LARGE_PACK: 'USPSLargePack', VERY_LARGE_PACK: 'VeryLargePack', WINE_PAK: 'Winepak',
}
const GRAMS: Readonly<Record<string, number>> = { KILOGRAM: 1000, GRAM: 1, POUND: 453.59237, OUNCE: 28.349523125 }
const CENTIMETERS: Readonly<Record<string, number>> = { CENTIMETER: 1, METER: 100, INCH: 2.54, FEET: 30.48 }
const measure = (value: unknown) => {
  const n = value && typeof value === 'object' ? Number((value as { value?: unknown }).value) : value === '' || value == null ? NaN : Number(value)
  return Number.isFinite(n) && n > 0 ? n : null
}

/**
 * A listing's saved package as eBay Trading XML, in metric (eBay wants whole numbers: kg + g, cm). '' when nothing is set.
 * Throws, by name, on a value it cannot send — silently omitting one would publish a different product.
 */
export function ebayPackageXml(pa: Record<string, any>, sku: string): string {
  const parts: string[] = []
  const type = typeof pa.packageType === 'string' ? pa.packageType.trim() : ''
  if (type) {
    const code = TRADING_PACKAGES[type.toUpperCase()] ?? (Object.values(TRADING_PACKAGES).includes(type) ? type : null)
    if (!code) throw new Error(`${sku}: eBay does not know the package type "${type}". Choose one from the list.`)
    parts.push(`<ShippingPackage>${code}</ShippingPackage>`)
  }
  const weight = measure(pa.packageWeight)
  if (weight != null) {
    const unit = String((pa.packageWeight && typeof pa.packageWeight === 'object' ? pa.packageWeight.unit : pa.weightUnit) ?? '').toUpperCase()
    if (!GRAMS[unit]) throw new Error(`${sku}: set the package weight unit (kilogram, gram, pound or ounce).`)
    const grams = Math.max(1, Math.round(weight * GRAMS[unit]))
    parts.push(`<WeightMajor unit="kg">${Math.floor(grams / 1000)}</WeightMajor><WeightMinor unit="gr">${grams % 1000}</WeightMinor>`)
  }
  const sides = (['packageDepth', 'packageLength', 'packageWidth'] as const).map(key => [key, measure(pa[key === 'packageDepth' ? 'packageHeight' : key])] as const)
  if (sides.some(([, n]) => n != null)) {
    const unit = String(pa.dimensionUnit ?? '').toUpperCase()
    if (!CENTIMETERS[unit]) throw new Error(`${sku}: set the package dimension unit (centimeter, meter, inch or feet).`)
    for (const [key, n] of sides) if (n != null) {
      const tag = key === 'packageDepth' ? 'PackageDepth' : key === 'packageLength' ? 'PackageLength' : 'PackageWidth'
      parts.push(`<${tag} unit="cm">${Math.max(1, Math.ceil(n * CENTIMETERS[unit]))}</${tag}>`)
    }
  }
  return parts.length ? `<ShippingPackageDetails><MeasurementUnit>Metric</MeasurementUnit>${parts.join('')}</ShippingPackageDetails>` : ''
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
    // A revision keeps eBay's package (#36 sends it only when the listing is created).
    !itemId ? ebayPackageXml(settings, input.sku ?? 'This listing') : '',
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
 *
 * Publish without surprises (2026-10-01, audit P1) — a problem with ONE row or field no longer stops the build: it goes to
 * `problems` (by SKU and column label) and the build goes on with what it has, so the review names them all at once. Only a
 * problem that leaves nothing to build (another listing's item, the Inventory model, no readable main row) still throws at
 * once. Without a `problems` collector (a reader), the collected problems are thrown at the end, as before.
 */
export async function buildEbayListingInput(facts: PublicationFacts, options: { currency?: string; inventory?: boolean; problems?: EbayProblems } = {}) {
  const { scope, parent, products, listings } = facts
  const problems = options.problems ?? ebayProblems()
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
  const packages = new Map<string, string>()
  const galleries = new Map<string, string[]>()
  let settings: Record<string, any> = {}
  const exclusionsFor = pushExclusionsCache()
  // Round 6 — the currency this publication sends its prices in (the destination market's; `listingSendPrice` below).
  const marketCur = currencyCode(facts.destination.currency)
  // Audit P7 — eBay files ONE category per listing, and an eBay file carries it on the main row only: a variation row
  // without its own category uses the main row's. A missing main-row category is named once, on the main row.
  const mainCategory: string | null | undefined = facts.resolved[0]?.products.find(r => r.productId === parent.id)?.category.channelCategoryId
  const mainIncluded = products.some(p => p.id === parent.id)
  for (const product of products) {
    const at = { productId: product.id, sku: product.sku }
    const listing = listings.find(l => l.productId === product.id)
    if (listing?.fulfillmentMethod === 'FBA') problems.add('This row uses Amazon fulfillment (FBA), which Nexus cannot publish to eBay from the studio.', { ...at, field: 'fulfillment' })
    const resolved = facts.resolved[0]?.products.find(r => r.productId === product.id)
    if (!resolved) { problems.add('Nexus could not read this row. Refresh the product, then review again.', at); continue }
    // A-56 — typed on purpose: `resolved` arrives untyped, so the one category string went into `loadEbaySpec(…, categoryIds: string[])`
    // unchecked, and every Trading listing that reached here failed with "categoryIds.map is not a function" (since 2026-09-13).
    const category: string | null | undefined = resolved.category.channelCategoryId || (products.length > 1 && product.id !== parent.id ? mainCategory : null)
    let spec: Awaited<ReturnType<typeof loadEbaySpec>> | null = null
    if (!category) {
      if (product.id === parent.id || !mainIncluded) problems.add(`${ebayFieldLabel('categoryId')} is empty. Choose an eBay category on this listing's main row.`, { ...at, field: 'categoryId' })
    } else {
      spec = await loadEbaySpec(scope.marketplace, [category])
      if (spec.absent) { problems.add(`Nexus has not loaded eBay's details for category ${category} yet, so the listing cannot be checked. Choose the category again, or try again later.`, { field: 'categoryId' }); spec = null }
    }
    const effective: Record<string, any> = { ...listing, region: scope.marketplace, platformAttributes: { ...object(listing?.platformAttributes), ...(category ? { categoryId: category } : {}) }, flatFileSnapshot: null }
    for (const field of spec?.fields ?? []) {
      const cell = resolved.cells[field.key]
      if (!cell || cell.value === undefined || !field.channelStore) continue
      if (field.channelStore.kind === 'platformAttributes') setPath(effective.platformAttributes, field.channelStore.path, cell.value)
      else effective[field.channelStore.column] = cell.value
    }
    // CHMAP M4 — item specifics the Owner chose not to send in the ACTIVE mapping version (a live listing keeps eBay's value).
    const excluded = spec ? await exclusionsFor('EBAY', scope.marketplace, category!) : null
    if (spec && excluded && (excluded.fieldKeys.size || excluded.specifics.size)) {
      const names = new Set([...excluded.specifics, ...spec.fields.filter(f => excluded.fieldKeys.has(f.key) && f.channelStore?.kind === 'platformAttributes' && f.channelStore.path[0] === 'itemSpecifics')
        .map(f => foldName((f.channelStore as { path: string[] }).path[1]))])
      effective.platformAttributes.itemSpecifics = Object.fromEntries(Object.entries(object(effective.platformAttributes.itemSpecifics)).filter(([name]) => !names.has(foldName(name))))
    }
    const pa = effective.platformAttributes
    // Saved fields this builder cannot send; silently omitting them would publish a different product. Audit P8 — the Best
    // Offer floor and ceiling only matter while Best Offer is on (eBay ignores them otherwise), so they are ignored when it is off.
    if (!itemId) {
      if (filled(pa.videoId)) problems.add(`${ebayFieldLabel('videoId')}: Nexus cannot send a video with a new eBay listing yet. Clear the "${ebayFieldLabel('videoId')}" cell on this row in the sheet.`, { ...at, field: 'videoId' })
      for (const key of ['compatibility', 'regulatory']) if (filled(pa[key])) problems.add(`${ebayFieldLabel(key)}: Nexus cannot send this with a new eBay listing yet.`, { ...at, field: key })
      if (pa.bestOffer === true) for (const key of ['bestOfferFloor', 'bestOfferCeiling']) {
        if (filled(pa[key])) problems.add(`${ebayFieldLabel(key)}: Nexus cannot send it with a new eBay listing yet. Clear it on this row, or turn "${ebayFieldLabel('bestOffer')}" off.`, { ...at, field: key })
      }
    }
    // #36 — eBay takes ONE package per listing (item level): every row must hold the main row's package, or none.
    if (!itemId) packages.set(product.id, problems.attempt(() => ebayPackageXml(pa, product.sku), { ...at, field: 'package' }) ?? '')
    if (pa.listingFormat && pa.listingFormat !== 'FIXED_PRICE') problems.add(`${ebayFieldLabel('listingFormat')}: Nexus publishes fixed-price eBay listings only. Set it to FIXED_PRICE.`, { field: 'listingFormat' })
    if (products.length > 1 && pa.bestOffer === true) problems.add(`${ebayFieldLabel('bestOffer')}: eBay does not take Best Offer on a listing with variations. Turn it off on this row.`, { ...at, field: 'bestOffer' })
    if (product.id === parent.id) settings = pa
    // Round 6 — THE send price (`listingSendPrice`): a pin's own price, a follower's rule price from the current master in
    // the master currency, else the price the listing holds. It sent a follower the master price (the resolved price cell
    // of a follower IS the master): "master +10%" went live at the master, and eBay UK was sent the EUR number as pounds.
    // Nothing to send is refused for that SKU, by name. A variation parent sells nothing itself.
    const send = listingSendPrice(listing ?? NO_LISTING_PRICE_FACTS, { masterPrice: product.basePrice, marketCurrency: marketCur, where: `eBay ${scope.marketplace}` })
    // A market with no currency is refused by name further on ("No currency was resolved…"): nothing is sent either way.
    if (send.price == null && !product.isParent && marketCur) problems.add(stripSku(send.reason, product.sku), { ...at, field: 'price' })
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
    if (typeof row.sku !== 'string' || !row.sku.trim()) { problems.add(`${ebayFieldLabel('sellerSku')} is empty. Set this row's SKU.`, { ...at, field: 'sellerSku' }); continue }
    identities.push({ productId: product.id, sku: row.sku })
    row[`${scope.marketplace.toLowerCase()}_price`] = price
    row[`${scope.marketplace.toLowerCase()}_qty`] = quantity
    if (!onPlan) {
      const images = pa._productMediaLocales !== undefined ? publicationImages(facts, product)
        : Array.isArray(pa.imageUrls) ? pa.imageUrls as string[] : publicationImages(facts, product)
      if (images.length > 24) problems.add(`${ebayFieldLabel('pictures')}: eBay takes at most 24 photos; this row has ${images.length}.`, { ...at, field: 'pictures' })
      if (images.some(url => !/^https:\/\//i.test(url))) problems.add(`${ebayFieldLabel('pictures')}: eBay needs every photo as a public https:// link.`, { ...at, field: 'pictures' })
      galleries.set(product.id, images)
      for (let i = 0; i < 6; i++) row[`image_${i + 1}`] = images[i] ?? ''
    }
    rows.push(row)
  }
  // The listing is built from its main row; without it there is nothing to build (its problem is already named).
  if (!rows.length || rows[0]._productId !== products[0]?.id) { problems.throwIfAny(); throw new Error('No row of this eBay listing could be read. Refresh the product, then review again.') }
  const parentRow = rows[0], variants = products.length > 1 ? rows.slice(1) : rows
  if (products.length > 1) {
    const { input, cell } = await loadStoredVariationProjection({ productId: parent.id, channel: 'EBAY', market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    // VTR step 0 — the channel cells (pins, value maps) the Information sheet shows, not the Shared values.
    input.family.variants = input.family.variants?.map(v => ({ ...v, included: products.some(p => p.id === v.id),
      axisValues: channelAxisValues(v.axisValues, cell.axes, facts.resolved[0]?.products.find(p => p.productId === v.id)?.cells ?? {}, facts.resolved[0]?.catalogue?.fields ?? []) }))
    const projection = resolveVariationProjection(input)
    // A live re-publish is validated like a first one: the review must not compare a structure that could not be sent.
    const structure = variationReadinessItems(projection, `EBAY ${scope.marketplace}`).filter(i => i.severity === 'error')
    for (const item of structure) problems.add(item.message, { field: 'variationTheme' })
    const axes = projection.axes.filter(a => a.included)
    if (!axes.length || axes.some(a => !a.channelName)) problems.add(`${ebayFieldLabel('variationTheme')}: set the eBay variation theme on this listing's main row.`, { field: 'variationTheme' })
    else {
      parentRow.variation_theme = axes.map(a => a.channelName).join(',')
      for (const row of variants) for (const axis of axes) {
        const value = input.family.variants?.find(v => v.id === row._productId)?.axisValues[axis.familyKey]
        // The structure check above already names a missing value; this one names it only when that check did not.
        if (!value) { if (!structure.length) problems.add(`${axis.label || axis.channelName} is empty. Fill it in on this row.`, { productId: String(row._productId), sku: String(row.sku), field: axis.familyKey }); continue }
        if (axis.channelName) row[`aspect_${axis.channelName.replace(/ /g, '_')}`] = value ?? ''
      }
      // The values this listing receives, per variant — the media plan names its photo sets with them.
      channelValues = { byProduct: Object.fromEntries((input.family.variants ?? []).map(v => [v.id, v.axisValues])), axisNames: Object.fromEntries(axes.map(a => [a.familyKey, a.channelName ?? null])) }
    }
  }
  const shared = problems.attempt(() => buildSharedListingInput(parentRow, variants, scope.marketplace, undefined, object(parentListing?.platformAttributes)._axisValueOrder, options.currency))
  // Audit P10 — the condition, named before eBay sees it (the pre-flight `ebay-shared-listing-push.service.ts` runs): a word
  // eBay does not know is a problem; an empty condition is sent as New, as before, and the review says so.
  if (shared && !itemId) {
    const condition = settings.conditionId
    if (!filled(condition)) problems.note(`${ebayFieldLabel('conditionId')} is empty, so Nexus sends New. Choose another condition on the main row if the item is not new.`)
    else if (!shared.conditionId) problems.add(`${ebayFieldLabel('conditionId')}: eBay does not know "${String(condition)}". Choose a condition from the list on the main row.`, { productId: parent.id, sku: parent.sku, field: 'conditionId' })
  }
  const differing = products.filter(p => p.id !== parent.id && (packages.get(p.id) ?? '') !== '' && packages.get(p.id) !== (packages.get(parent.id) ?? ''))
  if (differing.length) problems.add(`eBay takes one package type, weight and size for the whole listing. ${differing.map(p => p.sku).join(', ')} ${differing.length === 1 ? 'holds' : 'hold'} a different package than the main row: make them the same as the main row, or leave them blank.`, { field: 'package' })
  if (!options.problems || !shared) problems.throwIfAny()
  return { shared: shared!, itemId, parentListing, settings, galleries, variants, identities, media: onPlan ? { channelValues } : null }
}

/** Images rebuild P2c — the plan's eBay layout, checked, as the Trading/Inventory input's pictures (screen order = payload order). */
async function ebayPicturesFromPlan(facts: PublicationFacts, shared: Awaited<ReturnType<typeof buildEbayListingInput>>['shared'], channelValues: MediaChannelValues | undefined, problems: EbayProblems) {
  const { scope, parent, products } = facts
  const media = await mediaLayoutFor({ productId: parent.id, channel: 'EBAY', marketplace: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '',
    includedIds: products.map(p => p.id), channelValues })
  if (!media || media.layout.channel !== 'EBAY') throw new Error('This product\'s photo plan changed while publishing. Review again.')
  const layout = media.layout as EbayMediaLayout & { channel: 'EBAY' }
  const errors = layout.checks.filter(c => c.severity === 'error')
  // Each of the plan's own checks is one problem (audit P1): they were joined into one sentence.
  if (errors.length) { for (const check of errors) problems.add(check.message, { field: 'pictures' }); return }
  shared.pictureUrls = layout.gallery.map(media.url)
  if (!layout.axisName || !layout.sets.length) { shared.variationPictures = undefined; return }
  const axisName = shared.variationSpecificNames.find(name => aspectCanonicalName(name) === aspectCanonicalName(layout.axisName!))
  if (!axisName) throw new Error(`Photos vary by ${layout.axisName}, which is not a variation of this eBay listing. Choose the photo axis on the Media page.`)
  const allowed = shared.variationSpecificsSet?.[axisName] ?? shared.variations.map(v => String(v.specifics?.[axisName] ?? ''))
  for (const set of layout.sets) if (!allowed.includes(set.value)) problems.add(`${set.value} is not a ${axisName} value of this eBay listing. Check the photo sets on the Media page.`, { field: 'variationPictures' })
  shared.variationPictures = { axisName, byValue: Object.fromEntries(layout.sets.map(set => [set.value, set.items.map(media.url)])), order: layout.sets.map(set => set.value) }
}

/**
 * Audit P9 — the review runs every check in every mode; only SENDING needs live eBay. With sending off, the review's one
 * gate message already says so when the publish mode is not live (`EbaySendingOff` adds no second one); a live mode on a
 * server without the real eBay API is said here, once.
 */
function sendingOff(notes: string[]): Error {
  if (getEbayPublishMode() !== 'live') return new EbaySendingOff(notes)
  return Object.assign(new Error(`Sending to eBay is off on this server (${process.env.EBAY_SANDBOX === 'true' ? 'it points at the eBay sandbox' : 'its real eBay connection is not switched on'}). Every check above ran; nothing will be sent.`), { notes })
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
  const live = ebaySendsLive()
  const problems = ebayProblems()
  const built = await buildEbayListingInput(facts, { currency: facts.destination.currency ?? undefined, inventory: true, problems })
  if (!built.itemId) { problems.add('This eBay Inventory listing has no eBay item. Create it on eBay before publishing changes.'); problems.throwIfAny() }
  const shared = await finishEbayListingInput(facts, built, problems, live)
  problems.throwIfAny()
  // Audit P9 — the checks above ran in every mode; the live group is read only when this server really sends to eBay.
  if (!live) throw sendingOff(problems.notes)
  const owner = built.identities.find(i => i.productId === parent.id) ?? built.identities[0]
  if (!owner) throw new Error('No included eBay product can own this listing publication.')
  const children = built.identities.filter(i => i.productId !== owner.productId)
  const destination: EbayInventoryDestination = { productId: parent.id, channel: 'EBAY', marketplace: scope.marketplace, accountId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', expectedSkus: children.map(c => c.sku), itemId: built.itemId, parentSku: parent.sku }
  const liveGroup = await readEbayInventoryListing(destination, ebayInventoryReads(scope.accountId, scope.marketplace, built.itemId))
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
  return { kind: 'ebay-inventory', marketplace: scope.marketplace, itemId: built.itemId, destination, owner, products: [owner], ours, live: liveGroup }
}

/** This account's eBay snapshot (policies and locations, cached five minutes), or null when eBay could not be read. */
async function accountSnapshot(accountId: string, market: string) {
  try { return await ebayAccountService.getSnapshot(accountId, ebayMarketplaceId(market)) } catch { return null }
}

const POLICY_WORD: Readonly<Record<EbayPolicyKind, string>> = { shipping: 'shipping', payment: 'payment', return: 'return' }

/**
 * Origin, pictures, policies and the rendered description — the same for a Trading and an Inventory listing. Every check
 * names its problem in `problems` and goes on (audit P1). `live`: this server really sends to eBay, so eBay may be read
 * for the defaults Nexus can fill (audit P2/P3); otherwise nothing here reaches eBay.
 */
async function finishEbayListingInput(facts: PublicationFacts, built: Awaited<ReturnType<typeof buildEbayListingInput>>, problems: EbayProblems, live: boolean) {
  const { scope, parent, products } = facts
  const { shared, itemId, parentListing, settings, galleries, variants } = built
  const main = { productId: parent.id, sku: parent.sku }
  const metadata = object(facts.account.connectionMetadata), defaults = object(metadata.ebayPolicies)
  // A blank cell falls through to the account's default, then the server's (`resolveEbayItemLocation`). Audit P3 — the
  // account's default is the location Nexus last read from eBay; a new listing without one reads it now.
  let location = resolveEbayItemLocation({ country: settings.itemLocationCountry, postalCode: settings.itemPostalCode, city: settings.itemLocation }, metadata)
  if (!itemId && !isCompleteEbayLocation(location) && live) {
    const usable = usableEbayLocation((await accountSnapshot(scope.accountId, scope.marketplace))?.locations ?? [])
    // eBay's location is taken whole, or only to complete the same country: a postal code is never paired with another country.
    if (usable && !location.country && !location.postalCode && !location.city) location = usable
    else if (usable && location.country === usable.country && !location.postalCode && !location.city) location = { ...location, postalCode: usable.postalCode, city: usable.city }
  }
  shared.country = location.country
  shared.location = location.city
  shared.postalCode = location.postalCode
  // eBay takes the country with a postal code OR a city (Trading `Item.PostalCode` / `Item.Location`: one of the two).
  if (!itemId && !isCompleteEbayLocation(location)) {
    if (live || ebayLocationKnownMissing(metadata) === true) problems.add(`eBay needs the item location country and a postal code or city to create a listing. Set "${ebayFieldLabel('itemLocationCountry')}" and "${ebayFieldLabel('itemPostalCode')}" on this listing's main row in the sheet.`, { ...main, field: 'itemPostalCode' })
    else problems.note(`${ebayFieldLabel('itemPostalCode')} is not set on the main row, and Nexus has not read this eBay account's location yet. When sending is on, Nexus reads it from eBay.`)
  }
  if (built.media) {
    try { await ebayPicturesFromPlan(facts, shared, built.media.channelValues, problems) }
    catch (error) { problems.add(error instanceof Error ? error.message : String(error), { field: 'pictures' }) }
  }
  else shared.pictureUrls = galleries.get(parent.id) ?? []
  if (!built.media && shared.variationPictures) {
    const axis = shared.variationPictures.axisName
    for (const [value] of Object.entries(shared.variationPictures.byValue)) {
      const matching = variants.filter(row => String(row[`aspect_${axis.replace(/ /g, '_')}`]) === value)
      const urls = [...new Set(matching.flatMap(row => galleries.get(String(row._productId)) ?? []))]
      if (urls.length > 24) problems.add(`The ${value} photos: eBay takes at most 24 per variation; there are ${urls.length}.`, { field: 'variationPictures' })
      if (urls.length) shared.variationPictures.byValue[value] = urls
    }
  }
  let policies = { fulfillmentPolicyId: shared.policies?.fulfillmentPolicyId ?? defaults.fulfillmentPolicyId,
    paymentPolicyId: shared.policies?.paymentPolicyId ?? defaults.paymentPolicyId, returnPolicyId: shared.policies?.returnPolicyId ?? defaults.returnPolicyId }
  // Audit P2 — a new listing without a policy takes this market's own, as the other eBay publishers do (`reconcileEbayPolicies`:
  // the row, then the account default, then this market's first policy; an id from another market is replaced).
  const missingPolicies = () => EBAY_POLICY_KINDS.filter(kind => !filled(policies[EBAY_POLICY_FIELD[kind]]))
  if (!itemId && missingPolicies().length) {
    if (live) {
      const resolution = await reconcileEbayPolicies({ connectionId: scope.accountId, marketplaceId: ebayMarketplaceId(scope.marketplace), market: scope.marketplace,
        rowOverrides: { fulfillment_policy_id: policies.fulfillmentPolicyId, payment_policy_id: policies.paymentPolicyId, return_policy_id: policies.returnPolicyId } })
      if (resolution.policies) policies = { fulfillmentPolicyId: resolution.policies.fulfillmentPolicyId || undefined,
        paymentPolicyId: resolution.policies.paymentPolicyId || undefined, returnPolicyId: resolution.policies.returnPolicyId || undefined }
      else problems.add(`Nexus could not read this eBay account's business policies for ${scope.marketplace}. Review again in a minute.`)
      if (resolution.policies) for (const kind of missingPolicies()) problems.add(`${ebayFieldLabel(EBAY_POLICY_FIELD[kind])}: this eBay account has no ${POLICY_WORD[kind]} policy for eBay ${scope.marketplace}. Create one in eBay (Account › Business policies), then review again.`, { ...main, field: EBAY_POLICY_FIELD[kind] })
    } else {
      const known = ebayPolicyKnownMissing(metadata, scope.marketplace)
      for (const kind of missingPolicies()) {
        if (known[kind] === true) problems.add(`${ebayFieldLabel(EBAY_POLICY_FIELD[kind])}: this eBay account has no ${POLICY_WORD[kind]} policy for eBay ${scope.marketplace}. Create one in eBay (Account › Business policies), then review again.`, { ...main, field: EBAY_POLICY_FIELD[kind] })
        else problems.note(`${ebayFieldLabel(EBAY_POLICY_FIELD[kind])} is not set. When sending is on, Nexus uses this eBay account's first ${POLICY_WORD[kind]} policy for eBay ${scope.marketplace}.`)
      }
    }
  }
  shared.policies = policies
  if (!built.media && parentListing && object(parentListing.platformAttributes)._mediaGalleryDraft !== undefined) {
    const axes = shared.variationSpecificNames.map(name => ({ name, key: name, label: name, values: shared.variationSpecificsSet?.[name] ?? [] }))
    const gallery = await readEbayMediaGallery(parent.id, { axes, axesVerified: true, destination: { ...facts.destination, productId: parent.id,
      listing: { id: parentListing.id, productId: parent.id, aliasKey: parentListing.aliasKey, version: parentListing.version } } })
    const inspection = inspectMediaDraft(gallery.draft, gallery.assets)
    for (const problem of inspection.problems) problems.add(problem, { field: 'pictures' })
    if (!inspection.problems.length) {
      const urls = (ids: string[]) => ids.map(id => gallery.assets.find(a => a.id === id)!.url)
      shared.pictureUrls = urls(gallery.draft.galleries.find(g => g.axis === null)?.assetIds ?? [])
      if (gallery.draft.axis && !axes.some(a => a.name === gallery.draft.axis)) problems.add('The saved photo grouping does not match this listing\'s variation theme. Review Images before publishing.', { field: 'pictures' })
      else shared.variationPictures = gallery.draft.axis ? { axisName: gallery.draft.axis, byValue: Object.fromEntries(gallery.draft.galleries
        .filter(g => g.axis === gallery.draft.axis && g.value !== null).map(g => [g.value!, urls(g.assetIds)])) } : undefined
    }
  }
  if (!itemId) {
    if (!shared.title.trim()) problems.add(`${ebayFieldLabel('title')} is empty. Fill it in on the main row.`, { ...main, field: 'title' })
    if (!shared.description.trim()) problems.add(`${ebayFieldLabel('description')} is empty. Fill it in on the main row.`, { ...main, field: 'description' })
    // A photo problem already named (the plan's own checks) is not named twice.
    if (!shared.pictureUrls?.length && !problems.issues.some(issue => issue.field === 'pictures')) problems.add(`${ebayFieldLabel('pictures')}: eBay needs at least one photo. Add photos on the Media page.`, { ...main, field: 'pictures' })
    const productOf = new Map(built.identities.map(identity => [identity.sku, identity.productId]))
    for (const variation of shared.variations) {
      const at = { productId: productOf.get(variation.sku), sku: variation.sku }
      // A price the send-price rule already named (no price of its own) is not named twice.
      if ((variation.price == null || !Number.isFinite(variation.price) || variation.price <= 0) && !problems.issues.some(issue => issue.sku === variation.sku && issue.field === 'price'))
        problems.add(`${ebayFieldLabel('price')}: set a price above 0.`, { ...at, field: 'price' })
      if (!Number.isSafeInteger(variation.quantity)) problems.add(`${ebayFieldLabel('quantity')} is not a whole number.`, { ...at, field: 'quantity' })
    }
  }
  // Owner 2026-10-01: a new listing may start at 0 and get its stock later. eBay keeps a listing at 0 alive (hidden from
  // search) only while the account's out-of-stock option is on; without it a listing cannot wait at 0. eBay's own dry
  // run (`sendEbayPublication`) still decides before anything is created.
  if (!itemId && shared.variations.length && !shared.variations.some(v => v.quantity > 0)) {
    if (live) {
      const { readEbayOutOfStockPreference } = await import('../channel-delist.service.js')
      const outOfStock = await readEbayOutOfStockPreference(scope.accountId, scope.marketplace)
      if (outOfStock === 'OFF') problems.add('The stock is 0, and this eBay account\'s out-of-stock option is off, so eBay cannot hold the listing at 0. Turn on the out-of-stock option in eBay (Account › Site Preferences › Selling preferences), then refresh this review.', { field: 'quantity' })
      else if (outOfStock !== 'ON') problems.add('The stock is 0, and Nexus could not read this eBay account\'s out-of-stock option. Refresh this review.', { field: 'quantity' })
      else problems.note('The stock is 0. eBay keeps this listing hidden from search until it has stock.')
    } else problems.note('The stock is 0. When sending is on, Nexus checks that this eBay account keeps a listing at 0 (its out-of-stock option).')
  }
  const rendered = await renderListingDescriptionSafe(prisma, { productId: parent.id, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', mode: products.length > 1 ? 'group' : 'single', body: shared.description, title: shared.title })
  for (const warning of rendered.warnings) problems.add(warning, { field: 'description' })
  if (!rendered.warnings.length) shared.description = rendered.html
  return shared
}

export async function prepareEbayPublication(facts: PublicationFacts): Promise<EbayPublication> {
  const { scope, products } = facts
  const live = ebaySendsLive()
  const problems = ebayProblems()
  const built = await buildEbayListingInput(facts, { currency: facts.destination.currency ?? undefined, problems })
  const { itemId, settings, identities } = built
  const shared = await finishEbayListingInput(facts, built, problems, live)
  problems.throwIfAny()
  // Audit P9 — every check above ran in every mode; eBay is read (the live item) only when this server really sends to eBay.
  if (!live) throw sendingOff(problems.notes)
  let liveRevision: string | null = null, liveContent: Record<string, unknown> | null = null, liveReadError: string | undefined
  if (itemId) {
    try { const live = await readLiveItem(itemId, scope.accountId, scope.marketplace); liveRevision = live.revision; liveContent = live.content }
    catch (error) { liveReadError = error instanceof Error ? error.message : String(error) }
  }
  const notices = problems.notes
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
