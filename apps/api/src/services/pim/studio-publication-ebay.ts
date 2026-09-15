import type { PublicationFacts } from './studio-publication-plan.js'
import { object, publicationDigest } from './studio-publication-plan.js'
import prisma from '../../db.js'
import { loadEbaySpec } from './channel-specs/index.js'
import { buildFlatRow } from '../ebay-variation-push.service.js'
import { buildSharedListingInput } from '../ebay-shared-listing-push.service.js'
import { buildAddFixedPriceItemXml, callTradingApi, escapeXml, siteIdForMarket, TradingApiFailure, type AddFixedPriceItemInput, type TradingCallResult } from '../ebay-trading-api.service.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection, variationReadinessItems } from './variation-rules.service.js'
import { renderListingDescriptionSafe } from '../ebay-description-theme.service.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'
import { publicationImages } from './studio-publication-media.js'
import { readEbayMediaGallery } from '../images/ebay-media-workspace.service.js'
import { inspectMediaDraft } from '@nexus/shared/ebay-media'

export interface EbayPublication { kind: 'ebay'; marketplace: string; itemId: string | null; xml: string; liveRevision: string | null }
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
  return callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`, { oauthToken, siteId: siteIdForMarket(market) })
}

function liveItemReceipt(itemId: string, got: Awaited<ReturnType<typeof requestLiveItem>>): EbayPublicationReceipt {
  if (!got.raw || !['Success', 'Warning'].includes(got.ack)) throw new Error('The current eBay listing could not be verified.')
  const warnings = [...(got.errors ?? [])]
  if (!/<ListingStatus>Active<\/ListingStatus>/.test(got.raw)) return { reference: itemId, warnings: [...warnings, 'This eBay listing is not active.'], verified: false }
  if (/<InventoryTrackingMethod>SKU<\/InventoryTrackingMethod>/.test(got.raw) && /<InventoryModel>/.test(got.raw)) return { reference: itemId, warnings: [...warnings, 'This listing uses the eBay Inventory model.'], verified: false }
  return { reference: itemId, warnings, verified: true }
}

/** Read the acknowledged item through the same account and marketplace; null means the provider gave no usable answer. */
export async function readEbayPublication(itemId: string, accountId: string, marketplace: string): Promise<EbayPublicationReceipt | null> {
  try { return liveItemReceipt(itemId, await requestLiveItem(itemId, accountId, marketplace)) }
  catch { return null }
}

async function liveItem(itemId: string, accountId: string, market: string) {
  const got = await requestLiveItem(itemId, accountId, market)
  const receipt = liveItemReceipt(itemId, got)
  if (!receipt.verified) throw new Error(receipt.warnings.at(-1) ?? 'The current eBay listing could not be verified.')
  // Exclude sold counters while protecting every editable field this publication
  // sends. Item-level StartPrice/Quantity are the single-SKU equivalents of the
  // price and quantity held inside Variations.
  const stable = got.raw.replace(/<QuantitySold>[^<]*<\/QuantitySold>/g, '')
  const fields = ['SKU', 'Title', 'SubTitle', 'Description', 'PrimaryCategory', 'ConditionID', 'Country', 'Currency', 'Location', 'PostalCode',
    'ListingDuration', 'ItemSpecifics', 'StartPrice', 'Quantity', 'ProductListingDetails', 'Variations', 'PictureDetails', 'SellerProfiles',
    'DispatchTimeMax', 'VATDetails', 'BestOfferDetails', 'QuantityRestrictionPerBuyer']
  return publicationDigest(fields.map(key => stable.match(new RegExp(`<${key}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${key}>`))?.[0] ?? ''))
}

export async function prepareEbayPublication(facts: PublicationFacts): Promise<EbayPublication> {
  const { scope, parent, products, listings } = facts
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') throw new Error('Live eBay publication is disabled for this connection.')
  const ids = [...new Set(listings.map(l => l.externalListingId).filter((id): id is string => !!id))]
  if (ids.length > 1) throw new Error('These products belong to different eBay listings. Choose one listing alias before publishing.')
  const itemId = ids[0] ?? null
  const parentListing = listings.find(l => l.productId === parent.id)
  if (listings.some(l => object(l.platformAttributes).__offerIds || object(l.platformAttributes).offerId)) throw new Error('This listing uses the eBay Inventory model. Direct studio publication currently supports Trading listings; Inventory publication is unavailable here.')
  if (itemId) {
    const other = await prisma.channelListing.findFirst({ where: { channel: 'EBAY', channelConnectionId: scope.accountId, externalListingId: itemId,
      OR: [{ productId: { notIn: products.map(p => p.id) } }, { aliasKey: { not: facts.destination.aliasKey ?? '' } }] }, select: { id: true } })
    if (other) throw new Error('This eBay item is also used by products outside this selection. Review its complete shared listing before publishing.')
  }
  const stocks = await prisma.stockLevel.findMany({ where: { productId: { in: products.map(p => p.id) }, location: { type: 'WAREHOUSE' } }, select: { productId: true, available: true } })
  const rows = []
  const galleries = new Map<string, string[]>()
  let settings: Record<string, any> = {}
  for (const product of products) {
    const listing = listings.find(l => l.productId === product.id)
    if (listing?.fulfillmentMethod === 'FBA') throw new Error('This eBay listing uses Amazon fulfillment. Its fulfillment publication workflow is required.')
    const resolved = facts.resolved[0]?.products.find(r => r.productId === product.id)
    const category = resolved?.category.channelCategoryId
    if (!resolved || !category) throw new Error(`${product.sku}: choose an eBay category in Information.`)
    const spec = await loadEbaySpec(scope.marketplace, category)
    if (spec.absent) throw new Error(`${product.sku}: the eBay category schema is unavailable.`)
    const effective: Record<string, any> = { ...listing, region: scope.marketplace, platformAttributes: { ...object(listing?.platformAttributes), categoryId: category }, flatFileSnapshot: null }
    for (const field of spec.fields) {
      const cell = resolved.cells[field.key]
      if (!cell || cell.value === undefined || !field.channelStore) continue
      if (field.channelStore.kind === 'platformAttributes') setPath(effective.platformAttributes, field.channelStore.path, cell.value)
      else effective[field.channelStore.column] = cell.value
    }
    const pa = effective.platformAttributes
    // These saved fields require transport support; silently omitting them would publish a different product.
    for (const key of ['videoId', 'compatibility', 'regulatory', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'bestOfferFloor', 'bestOfferCeiling']) {
      if (pa[key] != null && pa[key] !== '' && pa[key] !== 0 && pa[key] !== false) throw new Error(`${product.sku}: ${key} needs the eBay offer publication workflow before this listing can be sent.`)
    }
    if (pa.listingFormat && pa.listingFormat !== 'FIXED_PRICE') throw new Error('Direct publication supports fixed-price eBay listings.')
    if (products.length > 1 && pa.bestOffer === true) throw new Error('eBay does not support Best Offer on a variation listing. Turn it off in Information before publishing.')
    if (product.id === parent.id) settings = pa
    const price = Number(resolved.cells.price?.value ?? (listing?.followMasterPrice === false ? listing.priceOverride ?? listing.price : product.basePrice))
    const requested = Number(resolved.cells.quantity?.value ?? (listing?.followMasterQuantity === false ? listing.quantityOverride ?? listing.quantity : product.totalStock))
    const tracked = stocks.filter(s => s.productId === product.id)
    const available = Math.max(0, (tracked.length ? tracked.reduce((n, s) => n + s.available, 0) : product.totalStock) - (listing?.stockBuffer ?? 0))
    const quantity = Math.min(Math.max(0, Math.trunc(requested)), available)
    effective.price = { toNumber: () => price }
    effective.quantity = quantity
    effective.title = String(resolved.cells.title?.value ?? effective.title ?? product.name)
    effective.description = String(resolved.cells.description?.value ?? effective.description ?? '')
    effective.updatedAt = listing?.updatedAt ?? product.updatedAt
    const row = buildFlatRow({ ...product, channelListings: [effective] } as any, { marketplace: scope.marketplace, parentImages: parent.images })
    row[`${scope.marketplace.toLowerCase()}_price`] = price
    row[`${scope.marketplace.toLowerCase()}_qty`] = quantity
    const images = pa._productMediaLocales !== undefined ? publicationImages(facts, product)
      : Array.isArray(pa.imageUrls) ? pa.imageUrls as string[] : publicationImages(facts, product)
    if (images.length > 24 || images.some(url => !/^https:\/\//i.test(url))) throw new Error(`${product.sku}: eBay needs at most 24 publicly accessible HTTPS images.`)
    galleries.set(product.id, images)
    for (let i = 0; i < 6; i++) row[`image_${i + 1}`] = images[i] ?? ''
    rows.push(row)
  }
  const parentRow = rows[0], variants = products.length > 1 ? rows.slice(1) : rows
  if (products.length > 1) {
    const { input } = await loadStoredVariationProjection({ productId: parent.id, channel: 'EBAY', market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    input.family.variants = input.family.variants?.map(v => ({ ...v, included: products.some(p => p.id === v.id) }))
    const projection = resolveVariationProjection(input)
    const problems = variationReadinessItems(projection, `EBAY ${scope.marketplace}`).filter(i => i.severity === 'error')
    if (problems.length) throw new Error(problems.map(i => i.message).join('; '))
    const axes = projection.axes.filter(a => a.included)
    if (!axes.length || axes.some(a => !a.channelName)) throw new Error('Set the eBay variation theme in Information before publishing.')
    parentRow.variation_theme = axes.map(a => a.channelName).join(',')
    for (const row of variants) for (const axis of axes) {
      const value = input.family.variants?.find(v => v.id === row._productId)?.axisValues[axis.familyKey]
      if (!value) throw new Error(`${row.sku}: ${axis.familyKey} is missing.`)
      row[`aspect_${axis.channelName.replace(/ /g, '_')}`] = value
    }
  }
  const shared = buildSharedListingInput(parentRow, variants, scope.marketplace, undefined, object(parentListing?.platformAttributes)._axisValueOrder)
  const metadata = object(facts.account.connectionMetadata), defaults = object(metadata.ebayPolicies)
  const origin = object(metadata.itemLocation)
  shared.country = String(settings.itemLocationCountry ?? origin.country ?? process.env.EBAY_ITEM_COUNTRY ?? '')
  shared.location = String(settings.itemLocation ?? origin.city ?? process.env.EBAY_ITEM_LOCATION ?? '')
  shared.postalCode = String(settings.itemPostalCode ?? origin.postalCode ?? process.env.EBAY_ITEM_POSTAL_CODE ?? '')
  if (!itemId && (!shared.country || !shared.location)) throw new Error('Configure the item origin country and city for this eBay account before creating a listing.')
  shared.pictureUrls = galleries.get(parent.id) ?? []
  if (shared.variationPictures) {
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
  if (parentListing && object(parentListing.platformAttributes)._mediaGalleryDraft !== undefined) {
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
  if (Object.values(shared.policies).some(v => !v)) throw new Error('Choose shipping, payment and return policies in Information before publishing.')
  if (!shared.title.trim() || !shared.description.trim() || !shared.pictureUrls?.length) throw new Error('A title, description and product image are required for eBay.')
  if (shared.variations.some(v => v.price == null || !Number.isFinite(v.price) || v.price <= 0 || !Number.isSafeInteger(v.quantity))) throw new Error('Every included variation needs a valid price and quantity.')
  if (!shared.variations.some(v => v.quantity > 0)) throw new Error('This eBay listing has no available stock to publish.')
  const rendered = await renderListingDescriptionSafe(prisma, { productId: parent.id, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', mode: products.length > 1 ? 'group' : 'single', body: shared.description, title: shared.title })
  if (rendered.warnings.length) throw new Error(rendered.warnings.join('; '))
  shared.description = rendered.html
  const liveRevision = itemId ? await liveItem(itemId, scope.accountId, scope.marketplace) : null
  return { kind: 'ebay', marketplace: scope.marketplace, itemId, liveRevision, xml: ebayPublicationXml(shared as AddFixedPriceItemInput, itemId, products.length === 1, settings) }
}

export async function sendEbayPublication(plan: EbayPublication, accountId: string, operationId: string): Promise<EbayPublicationReceipt> {
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') throw Object.assign(new Error('Live eBay publication was disabled.'), { notSent: true })
  const beforeSend = (error: unknown): never => { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
  if (plan.itemId && await liveItem(plan.itemId, accountId, plan.marketplace).catch(beforeSend) !== plan.liveRevision) throw Object.assign(new Error('eBay changed after the review. Refresh the publication review.'), { notSent: true })
  const oauthToken = await ebayAuthService.getValidToken(accountId).catch(beforeSend)
  const ctx = { oauthToken, siteId: siteIdForMarket(plan.marketplace) }
  let validationWarnings: string[] = []
  if (!plan.itemId) {
    const check = await callTradingApi('VerifyAddFixedPriceItem', plan.xml.replace(/AddFixedPriceItemRequest/g, 'VerifyAddFixedPriceItemRequest'), ctx)
      .catch(error => { throw Object.assign(error, { notSent: true }) })
    if (!check.raw || !['Success', 'Warning'].includes(check.ack)) throw Object.assign(new Error('eBay did not validate this listing. Nothing was submitted.'), { notSent: true })
    validationWarnings = check.errors ?? []
  }
  const key = operationId.replace(/-/g, '').toUpperCase()
  const xml = plan.xml.replace('<Item>', `<Item><${plan.itemId ? 'InvocationID' : 'UUID'}>${key}</${plan.itemId ? 'InvocationID' : 'UUID'}>`)
  let sent: TradingCallResult
  try {
    sent = await callTradingApi(plan.itemId ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem', xml, ctx)
  } catch (error) {
    if (error instanceof TradingApiFailure && error.duplicateSubmission) {
      if (error.priorItemId) return { reference: error.priorItemId, warnings: [...validationWarnings, error.message] }
      throw error
    }
    if (error instanceof Error && /^eBay (?:Add|Revise)FixedPriceItem Failure:/.test(error.message)) beforeSend(error)
    throw error
  }
  const itemId = sent.itemId ?? plan.itemId
  if (!sent.raw || !['Success', 'Warning'].includes(sent.ack) || !itemId || !/^\d+$/.test(itemId)) throw new Error('eBay did not confirm the publication. Check the channel before retrying.')
  const warnings = [...new Set([...validationWarnings, ...(sent.errors ?? [])])]
  return { reference: itemId, warnings }
}
