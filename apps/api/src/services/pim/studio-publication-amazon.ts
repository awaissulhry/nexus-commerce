import type { PublicationFacts } from './studio-publication-plan.js'
import type { StudioChannelIssue, StudioPublishFieldWrite } from '@nexus/shared/studio-publication'
import { object } from './studio-publication-plan.js'
import { buildRow, COCKPIT_EXPANDED_FIELDS } from '../amazon/cockpit-publish-row.js'
import { AmazonFlatFileService, normalizeVariationTheme } from '../amazon/flat-file.service.js'
import { CategorySchemaService } from '../categories/schema-sync.service.js'
import { AmazonService } from '../marketplaces/amazon.service.js'
import prisma from '../../db.js'
import { applyResolvedMappingToAmazonFeed } from '../amazon/mapping-payload.js'
import { loadAmazonSpec } from './channel-specs/index.js'
import { buildAmazonContentAttributes } from './amazon-content-payload.js'
import { configuredAmazonMarketplaceId } from '../categories/marketplace-ids.js'
import { getAmazonSellerId, getAmazonSpClient } from '../../lib/amazon-sp-client.js'
import { AmazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { getAmazonRegion } from '../../lib/amazon-sp-client.js'
import { attributesFromCells } from './mapping/schema-requirements.js'
import { shapeAmazonStudioAttributes, type AmazonFamilyRow } from './studio-publication-amazon-shape.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection, variationReadinessItems } from './variation-rules.service.js'
import { publicationImages } from './studio-publication-media.js'
import type { ResolvedCell } from './mapping/resolve-batch.service.js'
import { amazonImageSlots } from '@nexus/shared/amazon-media'
import { readAmazonMedia, desiredAmazonImages } from '../images/amazon-media-workspace.service.js'
import { loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { amazonExcludedRoots, amazonRootOf, pushExclusionsCache } from '../channel-mapping/push.js'
import { AMAZON_LISTING_SKU_KEYS } from '../channel-mapping/defaults.js'
import { CONTENT_ROOTS } from '../channel-drift/amazon-content-compare.js'
import { languageTag } from './market-languages.js'
import { effectiveFulfilment } from './matrix-cells.js'
import { isOnMediaPlan } from '../images/media-plan-switch.js'
import { mediaLayoutFor } from '../images/media-plan.service.js'
import { amazonSlotsFor, type AmazonMediaLayout } from '@nexus/shared/media-plan-channels'
import { NO_LISTING_PRICE_FACTS, currencyCode, listingSendPrice } from './follower-price.js'
import { assertNoMerchantQuantityForFba } from '../../lib/amazon-fba-boundary.js'
import { describeAmazonFulfilmentCode, isFbaFulfilmentCode } from '../../lib/amazon-fulfilment-programme.js'
import { readAmazonOfferFacts } from '../amazon/offer-facts.js'
import { amazonFulfillmentAvailability, amazonPurchasableOffer, amazonSellerBoundsRefusal } from '../amazon/offer-attributes.js'
import { amazonSendQuantity, readEuIntentRows, type SendQuantity } from '../amazon/send-quantity.js'
import { AMAZON_EU_SHARED_MARKETS } from '../amazon-eu-quantity-guard.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { masterCurrency } from '../fx-rate.service.js'
import { priceBoundsOf, priceBoundsRefusal } from '../price-bounds.service.js'
import type { ProductLedger } from '../stock-pool/sync-ledgers.js'
import { readSaleWindows, type SaleWindow } from './sale-window.js'
import type { AmazonOfferJournal } from './studio-publication-amazon-offer.js'

export interface AmazonPublication {
  kind: 'amazon'
  sellerId: string
  marketplaceId: string
  products: Array<{ productId: string; sku: string }>
  fieldWrites?: Record<string, StudioPublishFieldWrite[]>
  /** Amazon sheet gaps — per product, the offer leaves the message carries (the journal's `request.offer`). */
  offers?: Record<string, AmazonOfferJournal>
  feed: { header: Record<string, unknown>; messages: Array<{ messageId: number; sku: string; operationType: string; productType: string; requirements?: string; attributes?: Record<string, unknown>; patches?: any[] }> }
}

export async function prepareAmazonPublication(facts: PublicationFacts): Promise<AmazonPublication> {
  const { scope, parent, products, listings, resolved } = facts
  const marketplaceId = await configuredAmazonMarketplaceId(scope.marketplace)
  if (!marketplaceId) throw new Error('The Amazon marketplace identifier is unavailable.')
  const sellerId = await getAmazonSellerId(scope.accountId)
  if (!products.length) return { kind: 'amazon', sellerId, marketplaceId, products: [], feed: { header: { sellerId, version: '2.0' }, messages: [] } }
  const service = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))
  const rootListing = listings.find(l => l.productId === parent.id)
  // Images rebuild P2e — a family on the media plan: new listings take their slots from the plan's Amazon layout; an
  // existing listing sends no image attributes here (the Amazon photo review owns them), so the two paths never collide.
  const planMedia = await isOnMediaPlan(parent.id)
    ? await mediaLayoutFor({ productId: parent.id, channel: 'AMAZON', marketplace: scope.marketplace, accountId: scope.accountId, includedIds: products.map(p => p.id) }) : null
  if (planMedia && planMedia.layout.channel !== 'AMAZON') throw new Error('This product\'s photo plan changed. Review again.')
  const planLayout = planMedia?.layout as (AmazonMediaLayout & { channel: 'AMAZON' }) | undefined
  const gallery = !planMedia && object(rootListing?.platformAttributes)._amazonMediaWorkspace && rootListing
    ? await readAmazonMedia({ ...facts.destination, productId: parent.id, listing: { id: rootListing.id, productId: parent.id, aliasKey: rootListing.aliasKey, version: rootListing.version } }) : null
  // Shared stock — each product's ledger: its own warehouses, or the pool it sells from.
  const ledgers = await loadSyncLedgers(prisma, products.map(p => p.id))
  const saleWindows = await readSaleWindows(prisma as never, listings.filter(l => !l.externalListingId).map(l => l.id))
  const identityProducts = products.some(product => product.id === parent.id) ? products : [parent, ...products]
  const sellerSkus = new Map(identityProducts.map(product => {
    const listing = listings.find(l => l.productId === product.id)
    const offers = [...new Set(listing?.offers.filter(o => o.isActive).map(o => o.sku) ?? [])]
    if (offers.length > 1) throw new Error(`${product.sku} has multiple seller SKUs. Select its offer before publishing.`)
    const pa = object(listing?.platformAttributes)
    const ff = object(listing?.flatFileSnapshot)
    const identities = [...new Set([...offers, ...[...AMAZON_LISTING_SKU_KEYS.platformAttributes.map(k => pa[k]), ...AMAZON_LISTING_SKU_KEYS.flatFileSnapshot.map(k => ff[k])].filter((v): v is string => typeof v === 'string' && !!v.trim())])]
    if (identities.length > 1) throw new Error(`${product.sku}: conflicting Amazon seller SKUs. Reconcile this listing's identity before publishing.`)
    if (!identities.length && facts.destination.aliasKey) throw new Error(`${product.sku}: this alias needs its own Amazon seller SKU before publishing.`)
    return [product.id, identities[0] ?? product.sku]
  }))
  if (new Set(sellerSkus.values()).size !== identityProducts.length) throw new Error('Included products share an Amazon seller SKU. Reconcile their listing identities before publishing.')
  let projection: ReturnType<typeof resolveVariationProjection> | undefined
  let variationInput: Awaited<ReturnType<typeof loadStoredVariationProjection>>['input'] | undefined
  if (products.length > 1 || products.some(product => product.id !== parent.id)) {
    const stored = await loadStoredVariationProjection({ productId: parent.id, channel: scope.channel, market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    variationInput = stored.input
    variationInput.family.variants = variationInput.family.variants?.map(v => {
      const cells = resolved[0]?.products.find(p => p.productId === v.id)?.cells ?? {}
      const axisValues = { ...v.axisValues }
      for (const axis of stored.cell.axes.filter(a => a.included)) {
        const field = resolved[0]?.catalogue?.fields.find(f => f.sheetKey === axis.axisKey || f.fieldKey === axis.target)
        const value = field ? cells[field.fieldKey]?.value : undefined
        if (value !== undefined) axisValues[axis.familyKey] = value == null ? '' : String(value)
      }
      return { ...v, axisValues, included: products.some(p => p.id === v.id) }
    })
    projection = resolveVariationProjection(variationInput)
    const errors = variationReadinessItems(projection, `AMAZON ${scope.marketplace}`).filter(i => i.severity === 'error')
    if (!projection.theme || errors.length) throw new Error(errors.map(i => i.message).join('; ') || 'Set the Amazon variation theme in Information before publishing.')
  }
  const feed: AmazonPublication['feed'] = { header: {}, messages: [] }
  // Round 6 — the currency this publication sends its prices in (the destination market's): a follower is sent its rule's
  // price only in the master currency, never the master number into another currency (`listingSendPrice`).
  const marketCur = currencyCode(facts.destination.currency)
  const exclusionsFor = pushExclusionsCache()
  // CHMAP M7 (B2) — the row builder's own maps know five markets and fall back to Italy; give it this market's own.
  const market = { marketplaceId, languageTag: facts.languages[0] ? languageTag(facts.languages[0], scope.marketplace) : '' }
  for (const product of products) {
    const listing = listings.find(l => l.productId === product.id)
    const data = resolved[0]?.products.find(p => p.productId === product.id)
    if (!data) throw new Error(`${product.sku} could not be resolved.`)
    const ledger = ledgers.get(product.id)
    // Round 6 — THE send price (`listingSendPrice`): a pin's own price, a follower's rule price from the current master in
    // the master currency, else the price the listing holds. It sent a follower the master price: "master +10%" went live
    // at the master, and Amazon UK was sent the EUR number as pounds. Nothing to send is refused for that SKU, by name.
    const send = listingSendPrice(listing ?? NO_LISTING_PRICE_FACTS, { masterPrice: product.basePrice, marketCurrency: marketCur, where: `Amazon ${scope.marketplace}` })
    if (send.price == null && !product.isParent) throw new Error(`${product.sku}: ${send.reason}`)
    // Amazon sheet gaps — the quantity is the offer builder's (a new listing, below) or the stock job's: never the row's.
    const current = { ...listing, priceOverride: send.price, quantityOverride: null, quantity: null }
    // `data.category` is resolveBatch's answer for this listing (the #82 rule); the row builder takes it, no second read.
    const row = buildRow({ listing: current, product, marketplace: scope.marketplace, parentSku: sellerSkus.get(parent.id), productType: data.category.channelCategoryId })
    // Condition belongs to its own attribute, not the purchasable_offer object.
    // The legacy row builder can otherwise stringify an attribute envelope here.
    delete row.purchasable_offer__condition_type
    row.purchasable_offer__currency = facts.destination.currency
    row.item_sku = sellerSkus.get(product.id)
    row._isNew = !listing?.externalListingId
    row.record_action = row._isNew ? 'full_update' : 'partial_update'
    if (projection?.theme) row.variation_theme = projection.theme.code
    const activeOffer = listing?.offers.find(o => o.isActive)
    // 2026-09-27 — the ONE rule the sheet cell and the Matrix show (`effectiveFulfilment`): Amazon's reported code and
    // the flat mirror now sit above the product flag, so an FBA listing is never sent as FBM because of that flag.
    const fulfillment = effectiveFulfilment({ activeOfferMethod: activeOffer?.fulfillmentMethod, typed: listing?.fulfillmentMethod,
      platformAttributes: listing?.platformAttributes, productMethod: product.fulfillmentMethod })?.method
      ?? describeAmazonFulfilmentCode(row.fulfillment_availability__fulfillment_channel_code).method ?? undefined
    if (row._isNew && !product.isParent && !fulfillment) throw new Error(`${product.sku}: choose a fulfillment method before publishing.`)
    // A live listing's fulfilment root is the offer lane's (never a code from here, never AMAZON_<region>): see below.
    delete row.fulfillment_availability__fulfillment_channel_code
    if (planMedia && planLayout) {
      for (const slot of amazonImageSlots) delete row[slot.attribute]
      if (row._isNew) {
        const errors = planLayout.checks.filter(c => c.severity === 'error').map(c => c.message)
        if (errors.length) throw new Error(`${product.sku}: ${errors.join('; ')}`)
        const slots = amazonSlotsFor(planLayout, product.id)
        if (!slots?.MAIN) throw new Error(`${product.sku}: choose a main photo on the Media page before publishing.`)
        for (const slot of amazonImageSlots) { const id = slots[slot.code as keyof typeof slots]; if (id) row[slot.attribute] = planMedia.url(id) }
      }
    } else if (gallery && listing) {
      const { desired, problems } = desiredAmazonImages(gallery, listing.id)
      if (problems.length) throw new Error(`${product.sku}: ${problems.join('; ')}`)
      if (!desired.MAIN) throw new Error(`${product.sku}: choose a main image in Images before publishing.`)
      for (const slot of amazonImageSlots) {
        delete row[slot.attribute]
        if (desired[slot.code]) row[slot.attribute] = desired[slot.code]
      }
    } else if (row._isNew || object(listing?.platformAttributes)._productMediaLocales) {
      const images = publicationImages(facts, product)
      if (!images.length) throw new Error(`${product.sku}: add a product image before publishing.`)
      if (images.length > 9) throw new Error(`${product.sku}: choose at most nine images for the Amazon product gallery.`)
      row.main_product_image_locator = images[0]
      for (let i = 1; i < images.length; i++) row[`other_product_image_locator_${i}`] = images[i]
    } else {
      // A partial content update has no gallery edit to publish. The shared
      // asset library can include several colours and is not a selected gallery.
      for (const slot of amazonImageSlots) delete row[slot.attribute]
    }
    const hints = await service.getFeedSchemaHints(scope.marketplace, String(row.product_type))
    const legacy = service.buildJsonFeedBody([row as any], scope.marketplace, sellerId, COCKPIT_EXPANDED_FIELDS, market.languageTag ? { ...hints, market } : hints)
    const spec = await loadAmazonSpec(scope.marketplace, String(row.product_type), scope.accountId)
    // CHMAP M4 — fields the Owner chose not to send in the ACTIVE mapping version are left out (an omission is never a clear).
    const excluded = await exclusionsFor('AMAZON', scope.marketplace, String(row.product_type))
    const excludedRoots = amazonExcludedRoots(excluded)
    const base = JSON.parse(legacy)
    const cells = data.cells as Record<string, ResolvedCell>
    const values = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, cell.value]))
    for (const axis of projection?.axes.filter(a => a.included) ?? []) {
      const variant = variationInput?.family.variants?.find(v => v.id === product.id)
      if (variant && axis.target) values[axis.target] = variant.axisValues[axis.familyKey]
    }
    // Preserve the owning pricing/inventory/media builder; serialize the other
    // saved listing settings with their schema paths, including policies.
    const ownedKeys = new Set(resolved[0].catalogue?.fields.filter(f => f.sourceOwner && !['Pricing', 'Inventory', 'Media', 'Product media', 'Channel-reported data'].includes(f.sourceOwner.label)).map(f => f.fieldKey))
    // RRP is a saved pricing fact; serialize it without changing selling prices.
    for (const field of spec.fields.filter(f => f.attribute === 'list_price')) ownedKeys.add(field.key)
    const owned = attributesFromCells(spec, Object.fromEntries(Object.entries(values).filter(([key]) => ownedKeys.has(key))))
    // The family shape is not a saved cell: the shared variation resolver is authoritative (`shapeAmazonStudioAttributes`).
    delete owned.child_parent_sku_relationship
    delete owned.variation_theme
    Object.assign(base.messages[0].attributes, owned)
    // 2026-10-03 — every family row carries its relationship and the theme (the parent's spelling, normalised as the legacy
    // builder normalises it); every row, standalone included, drops a `marketplace_id` the schema does not declare.
    const family: AmazonFamilyRow | null = projection?.theme ? { theme: normalizeVariationTheme(projection.theme.code, hints.enumCodeMap?.variation_theme ?? {}),
      ...(product.id === parent.id ? { role: 'parent' as const } : { role: 'child' as const, parentSku: sellerSkus.get(parent.id)! }) } : null
    base.messages[0].attributes = shapeAmazonStudioAttributes(spec, base.messages[0].attributes, family)
    const mappedCells = Object.fromEntries(Object.entries(cells).map(([key, cell]) => [key, { ...cell, value: values[key] }]))
    const catalogue = resolved[0].catalogue && excludedRoots.size ? { ...resolved[0].catalogue, fields: resolved[0].catalogue.fields.filter(f => !excludedRoots.has(amazonRootOf(f.fieldKey))) } : resolved[0].catalogue
    const mapped = applyResolvedMappingToAmazonFeed(JSON.stringify(base), { ...resolved[0], catalogue, products: [{ ...data, cells: mappedCells }] }, spec)
    const envelope = JSON.parse(mapped)
    const message = envelope.messages[0]
    // Amazon sheet gaps — a new listing's two offer roots from the one builder, over whatever the row and the mapping
    // wrote (an old sheet value in `overrideData` never leaks into them). A parent has none.
    if (row._isNew && message.attributes) {
      const roots = await newListingOfferRoots({ sku: String(row.item_sku), product, listing, ledger, method: fulfillment, sendPrice: send.price,
        saleWindow: listing ? saleWindows.get(listing.id) ?? null : null, marketplace: scope.marketplace, marketplaceId, currency: facts.destination.currency, accountId: scope.accountId })
      for (const [root, value] of Object.entries(roots)) {
        if (value) message.attributes[root] = value
        else delete message.attributes[root]
      }
    }
    // The content resolver owns every supported language, including reviewed pins.
    const content = await buildAmazonContentAttributes({ product: product as any, parent: product.id === parent.id ? null : parent as any,
      listing, marketplace: scope.marketplace, marketplaceId })
    if (message.attributes) {
      for (const key of CONTENT_ROOTS) delete message.attributes[key]
      Object.assign(message.attributes, content)
    } else {
      const contentKeys = new Set(CONTENT_ROOTS.map(k => `/attributes/${k}`))
      message.patches = [...(message.patches ?? []).filter((p: any) => !contentKeys.has(p.path)),
        ...Object.entries(content).map(([key, value]) => ({ op: 'replace', path: `/attributes/${key}`, value }))]
    }
    for (const root of excludedRoots) {
      if (message.attributes) delete message.attributes[root]
      if (message.patches) message.patches = message.patches.filter((p: any) => p.path !== `/attributes/${root}`)
    }
    feed.header = envelope.header
    feed.messages.push({ ...message, messageId: feed.messages.length + 1 })
  }
  return { kind: 'amazon', sellerId, marketplaceId, feed, products: products.map(product => ({ productId: product.id, sku: sellerSkus.get(product.id)! })) }
}

type PublicationListing = PublicationFacts['listings'][number]
type PublicationProduct = PublicationFacts['products'][number]

/**
 * Amazon sheet gaps (bug 3) — THE quantity a new listing is created with: the stock job's rule (`amazonSendQuantity`:
 * FBA → none, the committed or resolved number, the routed oversell clamp, the EU shared-quantity guard), never the
 * buffer taken off a pin nor stock routed to another market. Publish refuses any paused listing but a still-draft, whose
 * pause only keeps it inert until this send, so the pause does not hold its quantity here.
 */
async function newListingQuantity(input: { sku: string; product: PublicationProduct; listing: PublicationListing | undefined; ledger: ProductLedger | undefined;
  marketplace: string; accountId: string }): Promise<SendQuantity> {
  const { product, listing } = input
  const [fbaStock, policies] = await Promise.all([
    prisma.stockLevel.aggregate({ where: { productId: product.id, location: { code: 'AMAZON-EU-FBA' } }, _sum: { quantity: true } }),
    loadChannelPolicies(prisma as never),
  ])
  let euRows: Awaited<ReturnType<typeof readEuIntentRows>> | null = null, euRowsError: string | null = null
  if (AMAZON_EU_SHARED_MARKETS.has(input.marketplace.toUpperCase())) {
    try { euRows = await readEuIntentRows(prisma, product.id) } catch (error) { euRowsError = error instanceof Error ? error.message : String(error) }
  }
  return amazonSendQuantity({ sku: input.sku, listing: listing ? { ...listing, syncPaused: false } : null, marketplace: input.marketplace,
    product: { id: product.id, fulfillmentMethod: product.fulfillmentMethod ?? null }, ledger: input.ledger,
    evidence: { fbaStockQty: fbaStock._sum.quantity ?? null, hasActiveFbaOffer: !!listing?.offers.some(o => o.isActive && o.fulfillmentMethod === 'FBA') },
    channelPolicy: policyFor(policies, 'AMAZON', input.marketplace, input.accountId), euRows, euRowsError })
}

/**
 * A new listing's `purchasable_offer` and `fulfillment_availability` (null = leave the root out), from the one builder:
 * the send price inside the product's floor and ceiling and Amazon's minimum and maximum, Nexus's sale with both dates,
 * the offer settings Nexus holds, and the stock job's quantity. FBA evidence on a listing set to FBM is refused by
 * name — never re-coded, never sent a merchant quantity.
 */
async function newListingOfferRoots(input: { sku: string; product: PublicationProduct; listing: PublicationListing | undefined; ledger: ProductLedger | undefined;
  method: 'FBA' | 'FBM' | undefined; sendPrice: number | null; saleWindow: SaleWindow | null; marketplace: string; marketplaceId: string; currency: string; accountId: string }) {
  if (input.product.isParent) return { purchasable_offer: null, fulfillment_availability: null }
  const facts = readAmazonOfferFacts({ ...(input.listing ?? {}), marketplace: input.marketplace, saleWindow: input.saleWindow }, 'publish', { followPrice: input.sendPrice })
  const sale = facts.values.sale?.start && facts.values.sale.end ? facts.values.sale.price : null
  const priceRefusal = input.sendPrice == null ? null
    : priceBoundsRefusal({ price: input.sendPrice, bounds: priceBoundsOf(input.product), channel: 'Amazon', sku: input.sku, currency: currencyCode(input.currency), masterCurrency: masterCurrency() })
      ?? amazonSellerBoundsRefusal({ price: input.sendPrice, salePrice: sale, min: facts.values.minimum_seller_allowed_price, max: facts.values.maximum_seller_allowed_price, sku: input.sku })
  if (priceRefusal) throw new Error(priceRefusal)
  const quantity = await newListingQuantity(input)
  if (input.method !== 'FBA' && (quantity.fba || facts.fbaByCode))
    throw new Error(`${input.sku}: Amazon fulfils this product (FBA), but this listing is set to FBM. Nexus never sends it a merchant quantity: choose FBA for it, or move its stock out of FBA, before publishing.`)
  if (input.method !== 'FBA' && quantity.quantity == null) throw new Error(`${input.sku}: ${quantity.refusal ?? 'No quantity was worked out for this listing.'}`)
  const fbaCode = `AMAZON_${({ eu: 'EU', na: 'NA', fe: 'JP' } as const)[await getAmazonRegion(input.accountId)]}`
  const fulfilment = amazonFulfillmentAvailability({ facts, fba: input.method === 'FBA', live: false, quantity: input.method === 'FBA' ? undefined : quantity.quantity, fbaCode })
  if (!fulfilment) {
    const kept = facts.fulfilmentCodes.map(describeAmazonFulfilmentCode).find(p => p.readOnlyReason)
    throw new Error(`${input.sku}: ${kept?.readOnlyReason ?? 'its fulfilment could not be built.'}`)
  }
  return { purchasable_offer: amazonPurchasableOffer({ marketplaceId: input.marketplaceId, currency: input.currency, facts, sendPrice: input.sendPrice }), fulfillment_availability: fulfilment }
}

export type AmazonFeedMessage = AmazonPublication['feed']['messages'][number]
export interface AmazonFeedRequest { feedType: string; marketplaceIds: string[]; feed: AmazonPublication['feed'] }

/**
 * Amazon's own dry run (Listings Items VALIDATION_PREVIEW) for each message. The first refusal throws `notSent`: nothing
 * was submitted. `onChecked` is told after each message (a batch keeps its heartbeat with it).
 */
export async function validateAmazonMessages(plan: Pick<AmazonPublication, 'sellerId' | 'marketplaceId'> & { feed: { messages: AmazonFeedMessage[] } },
  accountId: string, onChecked?: () => Promise<unknown> | void) {
  try {
    // FBA boundary first: a merchant quantity for an FBA SKU refuses the whole feed before any preview or upload.
    await assertNoMerchantQuantityForFba(plan.feed, accountId)
    const client = new AmazonSpApiClient({ id: accountId, region: await getAmazonRegion(accountId) })
    for (const message of plan.feed.messages) {
      const checked = await client.validateListing({ sellerId: plan.sellerId, marketplaceId: plan.marketplaceId,
        sku: message.sku, productType: message.productType, requirements: message.requirements,
        ...(message.operationType === 'UPDATE' ? { attributes: message.attributes ?? {} } : { patches: message.patches ?? Object.entries(message.attributes ?? {}).map(([key, value]) => ({ op: 'replace' as const, path: `/attributes/${key}`, value })) }) })
      if (!checked.available || !checked.ok) throw Object.assign(new Error(`${message.sku}: ${checked.available ? checked.errors : 'Amazon validation is unavailable. Nothing was submitted.'}`), { notSent: true })
      await onChecked?.()
    }
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
}

/**
 * Upload one JSON_LISTINGS_FEED and create it. `beforeSend` runs first (the publication journal is written before any
 * byte leaves). Anything that fails before `createFeed` throws `notSent`; a `createFeed` failure does not (Amazon may
 * have it). Returns Amazon's feed id.
 */
export async function submitAmazonFeed(plan: { marketplaceId: string; feed: AmazonPublication['feed'] }, accountId: string,
  beforeSend?: (request: AmazonFeedRequest) => Promise<void>) {
  const request: AmazonFeedRequest = { feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [plan.marketplaceId], feed: plan.feed }
  let documentId: string
  let sp: Awaited<ReturnType<typeof getAmazonSpClient>>
  try {
    // The FBA boundary again at the upload itself: a feed shared by several publications (a batch) is checked whole,
    // so no path to `createFeedDocument` can carry a merchant quantity for an FBA SKU.
    await assertNoMerchantQuantityForFba(plan.feed, accountId)
    sp = await getAmazonSpClient(accountId)
    await beforeSend?.(request)
    const document = await sp.callAPI({ operation: 'createFeedDocument', endpoint: 'feeds', body: { contentType: 'application/json; charset=UTF-8' } })
    // gateway-exempt: pre-signed feed document on Amazon's storage; the feed itself goes through the gateway
    const uploaded = await fetch(document.url, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
      body: JSON.stringify(plan.feed), signal: AbortSignal.timeout(60_000) })
    if (!uploaded.ok) throw new Error(`Amazon feed upload failed (${uploaded.status}).`)
    documentId = document.feedDocumentId
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
  const feed = await sp.callAPI({ operation: 'createFeed', endpoint: 'feeds', body: { feedType: request.feedType, marketplaceIds: request.marketplaceIds, inputFeedDocumentId: documentId } })
  if (typeof object(feed).feedId !== 'string') throw new Error('Amazon did not return a feed identifier. Check submission history before retrying.')
  return feed.feedId as string
}

/** Validate the complete family before submitting its single feed. An acknowledgement is not live status. */
export async function sendAmazonPublication(plan: AmazonPublication, accountId: string, beforeSend?: (request: AmazonFeedRequest) => Promise<void>) {
  await validateAmazonMessages(plan, accountId)
  return submitAmazonFeed(plan, accountId, beforeSend)
}

/** Where one publication's products sit in a feed: the message ids Amazon reports issues against. */
export interface AmazonFeedMessageRef { messageId: number; sku: string }
export interface AmazonFeedReadOptions {
  /** This publication's messages in the feed. Absent: messages 1..n in SKU order (a feed of one publication). */
  messages?: AmazonFeedMessageRef[]
  /** How many messages the feed holds in all. Absent: this publication's own count. */
  feedTotal?: number
}

/** A feed's processing state and report, read once. `text` is null while there is no report document. */
interface AmazonFeedRead { status: string; completedAt: Date | null; text: string | null }

/**
 * Step 6 — several publications of one batch can share a feed; the result sweep settles each of them, one after another
 * in the same tick. A SHARED feed's finished report is read once and kept for a minute, so it costs one getFeed +
 * getFeedDocument per tick, not one per publication. Only a finished read is kept (a finished report never changes);
 * a feed still processing, and a failed read, are never kept. A feed of one publication is read fresh every time.
 */
const FEED_READ_TTL_MS = 60_000
const feedReads = new Map<string, { at: number; read: AmazonFeedRead }>()
const finishedRead = (read: AmazonFeedRead) => read.status === 'CANCELLED' || ((read.status === 'DONE' || read.status === 'FATAL') && read.text != null)

async function readFeedOnce(feedId: string, accountId: string, keep: boolean, now = Date.now()): Promise<AmazonFeedRead> {
  for (const [key, entry] of feedReads) if (now - entry.at > FEED_READ_TTL_MS) feedReads.delete(key)
  const key = `${accountId}\u0000${feedId}`
  const kept = keep ? feedReads.get(key) : undefined
  if (kept) return kept.read
  const read = await (async (): Promise<AmazonFeedRead> => {
    const sp = await getAmazonSpClient(accountId)
    const feed = await sp.callAPI({ operation: 'getFeed', endpoint: 'feeds', path: { feedId } })
    // When Amazon finished processing: the as-of of every issue the report carries (not the time somebody read it).
    const completedAt = typeof feed.processingEndTime === 'string' && !Number.isNaN(Date.parse(feed.processingEndTime)) ? new Date(feed.processingEndTime) : null
    if (feed.processingStatus !== 'DONE' && feed.processingStatus !== 'FATAL') return { status: String(feed.processingStatus), completedAt, text: null }
    if (!feed.resultFeedDocumentId) return { status: String(feed.processingStatus), completedAt, text: null }
    const document = await sp.callAPI({ operation: 'getFeedDocument', endpoint: 'feeds', path: { feedDocumentId: feed.resultFeedDocumentId } })
    // gateway-exempt: pre-signed feed document on Amazon's storage; the feed itself goes through the gateway
    const response = await fetch(document.url, { signal: AbortSignal.timeout(20_000) })
    if (!response.ok) throw new Error(`Amazon processing report is unavailable (${response.status}).`)
    const { decodeReportBytes } = await import('../amazon-flat-file-feed.service.js')
    return { status: String(feed.processingStatus), completedAt, text: decodeReportBytes(Buffer.from(await response.arrayBuffer()), document.compressionAlgorithm) }
  })()
  if (keep && finishedRead(read)) feedReads.set(key, { at: now, read })
  return read
}

/** Test seam: forget every kept feed read. */
export function clearAmazonFeedReads() { feedReads.clear() }

/**
 * PURE. The part of a SHARED feed's report that is about one publication: its own messages' issues, plus any issue
 * that names no message and no SKU (it concerns the whole feed). Null while the report does not cover every message.
 * `everyInvalid` = Amazon refused every message of the feed (a feed-level failure).
 */
export function sharedFeedReport(text: string, skus: string[], messages: AmazonFeedMessageRef[], feedTotal: number): { text: string; everyInvalid: boolean } | null {
  let report: any
  try { report = JSON.parse((text ?? '').trim()) } catch { return null }
  if (!report || !Array.isArray(report.issues) || !Number.isFinite(Number(report.summary?.messagesProcessed))) return null
  if (Number(report.summary.messagesProcessed) !== feedTotal) return null
  const ids = new Set(messages.map(message => message.messageId))
  const own = new Set(skus)
  const issues = report.issues.filter((issue: any) => {
    const messageId = Number(issue?.messageId)
    if (issue?.messageId != null && Number.isSafeInteger(messageId)) return ids.has(messageId)
    if (typeof issue?.sku === 'string' && issue.sku) return own.has(issue.sku)
    return true
  })
  return { text: JSON.stringify({ issues, summary: { messagesProcessed: messages.length } }), everyInvalid: Number(report.summary.messagesInvalid) === feedTotal }
}

/**
 * PURE. One publication's result from a processing report: per SKU, failed or not, with each issue kept apart.
 * Null while the report is not final for every one of its messages.
 */
export async function amazonReportResults(text: string, skus: string[], options: AmazonFeedReadOptions = {}) {
  const messages = options.messages?.length ? options.messages : skus.map((sku, index) => ({ messageId: index + 1, sku }))
  const feedTotal = options.feedTotal ?? messages.length
  const shared = feedTotal > messages.length ? sharedFeedReport(text, skus, messages, feedTotal) : null
  if (feedTotal > messages.length && !shared) return null
  const { parseProcessingReport } = await import('../amazon-flat-file-feed.service.js')
  const report = parseProcessingReport(shared ? shared.text : text, skus, messages)
  if (report.pending || (!report.feedError && skus.some(sku => !report.perSku.some(row => row.sku === sku)))) return null
  if (report.summary.messagesProcessed !== skus.length
    || report.summary.messagesSuccessful + report.summary.messagesWithError !== skus.length) return null
  const submitted = new Set(skus)
  const mappedFailures = report.perSku.filter(row => submitted.has(row.sku) && row.status === 'error').length
  const allMessagesFailed = shared?.everyInvalid === true || report.summary.messagesWithError === skus.length
  if (!allMessagesFailed && mappedFailures !== report.summary.messagesWithError) return null
  return skus.map(sku => {
    const row = report.perSku.find(r => r.sku === sku)
    const failed = allMessagesFailed || row?.status === 'error'
    // Each issue kept apart with its code and the attributes Amazon named, so the result sweep can file them on the
    // exact listing and a sheet row can point at the column (sheet publish parity, step 2).
    const issues: StudioChannelIssue[] = (row?.issues ?? []).map(issue => ({ code: String(issue.code ?? ''), severity: issue.severity, message: issue.message,
      attributeNames: [...(issue.attributeNames ?? [])].map(String) }))
    return { sku, failed, issues, message: row?.issues.map(i => i.message).join('; ') || (failed ? report.feedError : undefined) || 'Amazon processed this product.' }
  })
}

/**
 * Poll with the reviewed account; processing success does not prove storefront visibility. A publication that shares
 * its feed with others of a batch passes its own `messages` and the feed's `feedTotal` (step 6); one without them is
 * read as a feed of its own, messages 1..n, as before.
 */
export async function readAmazonPublication(feedId: string, accountId: string, skus: string[], options: AmazonFeedReadOptions = {}) {
  const shared = (options.feedTotal ?? 0) > (options.messages?.length ?? skus.length)
  const read = await readFeedOnce(feedId, accountId, shared)
  if (!['DONE', 'CANCELLED', 'FATAL'].includes(read.status)) return null
  const { completedAt } = read
  if (read.status === 'CANCELLED') return { failed: true, completedAt, results: skus.map(sku => ({ sku, failed: true, issues: [] as StudioChannelIssue[], message: 'Amazon feed cancelled.' })) }
  if (read.text == null) return null
  const results = await amazonReportResults(read.text, skus, options)
  if (!results) return null
  return { failed: results.every(result => result.failed), completedAt, results }
}
