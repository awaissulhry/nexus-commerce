import type { PublicationFacts } from './studio-publication-plan.js'
import { object, publicationDigest } from './studio-publication-plan.js'
import prisma from '../../db.js'
import { loadEbaySpec } from './channel-specs/index.js'
import { buildFlatRow } from '../ebay-variation-push.service.js'
import { buildSharedListingInput } from '../ebay-shared-listing-push.service.js'
import { buildAddFixedPriceItemXml, callTradingApi, escapeXml, siteIdForMarket, type AddFixedPriceItemInput } from '../ebay-trading-api.service.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection } from './variation-rules.service.js'
import { renderListingDescriptionSafe } from '../ebay-description-theme.service.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { getEbayPublishMode } from '../ebay-publish-gate.service.js'

export interface EbayPublication { kind: 'ebay'; marketplace: string; itemId: string | null; xml: string; liveRevision: string | null }

function setPath(target: Record<string, any>, path: string[], value: unknown) {
  let node = target
  for (const key of path.slice(0, -1)) node = node[key] = { ...object(node[key]) }
  node[path[path.length - 1]] = value
}

/** Trading revisions preserve fields outside the submitted product payload. */
export function ebayPublicationXml(input: AddFixedPriceItemInput, itemId: string | null, single: boolean) {
  let xml = buildAddFixedPriceItemXml(input)
  if (single) {
    const variant = input.variations[0]
    xml = xml.replace(/    <Variations>[\s\S]*?<\/Variations>/, `    <StartPrice>${variant.price}</StartPrice><Quantity>${variant.quantity}</Quantity>`)
  }
  if (itemId) xml = xml.replace(/AddFixedPriceItemRequest/g, 'ReviseFixedPriceItemRequest').replace('<Item>', `<Item><ItemID>${escapeXml(itemId)}</ItemID>`)
  return xml
}

async function liveItem(itemId: string, accountId: string, market: string) {
  const oauthToken = await ebayAuthService.getValidToken(accountId)
  const got = await callTradingApi('GetItem', `<?xml version="1.0" encoding="UTF-8"?><GetItemRequest xmlns="urn:ebay:apis:eBLBaseComponents"><ItemID>${escapeXml(itemId)}</ItemID><DetailLevel>ReturnAll</DetailLevel><IncludeItemSpecifics>true</IncludeItemSpecifics></GetItemRequest>`, { oauthToken, siteId: siteIdForMarket(market) })
  if (!got.raw || !['Success', 'Warning'].includes(got.ack)) throw new Error('The current eBay listing could not be verified.')
  if (!/<ListingStatus>Active<\/ListingStatus>/.test(got.raw)) throw new Error('This eBay listing is not active. Review its ended status before relisting.')
  if (/<InventoryTrackingMethod>SKU<\/InventoryTrackingMethod>/.test(got.raw) && /<InventoryModel>/.test(got.raw)) throw new Error('This listing uses the eBay Inventory model. Its Inventory publication workflow is required.')
  // Exclude volatile clocks/counters. Protect editable content, identity and variation structure.
  const fields = ['Title', 'Description', 'PrimaryCategory', 'ItemSpecifics', 'Variations', 'PictureDetails', 'SellerProfiles']
  return publicationDigest(fields.map(key => got.raw.match(new RegExp(`<${key}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${key}>`))?.[0] ?? ''))
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
    for (const key of ['videoId', 'compatibility', 'regulatory', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'bestOfferFloor', 'bestOfferCeiling']) {
      if (pa[key] != null && pa[key] !== '' && pa[key] !== 0 && pa[key] !== false) throw new Error(`${product.sku}: ${key} needs the eBay offer publication workflow before this listing can be sent.`)
    }
    if (pa.listingFormat && pa.listingFormat !== 'FIXED_PRICE') throw new Error('Direct publication supports fixed-price eBay listings.')
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
    if (Array.isArray(pa.imageUrls)) for (let i = 0; i < 6; i++) row[`image_${i + 1}`] = pa.imageUrls[i] ?? ''
    rows.push(row)
  }
  const parentRow = rows[0], variants = products.length > 1 ? rows.slice(1) : rows
  if (products.length > 1) {
    const { input } = await loadStoredVariationProjection({ productId: parent.id, channel: 'EBAY', market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    input.family.variants = input.family.variants?.map(v => ({ ...v, included: products.some(p => p.id === v.id) }))
    const projection = resolveVariationProjection(input)
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
  shared.policies = { fulfillmentPolicyId: shared.policies?.fulfillmentPolicyId ?? defaults.fulfillmentPolicyId,
    paymentPolicyId: shared.policies?.paymentPolicyId ?? defaults.paymentPolicyId, returnPolicyId: shared.policies?.returnPolicyId ?? defaults.returnPolicyId }
  if (Object.values(shared.policies).some(v => !v)) throw new Error('Choose shipping, payment and return policies in Information before publishing.')
  if (!shared.title.trim() || !shared.description.trim() || !shared.pictureUrls?.length) throw new Error('A title, description and product image are required for eBay.')
  if (shared.variations.some(v => v.price == null || !Number.isFinite(v.price) || v.price <= 0 || !Number.isSafeInteger(v.quantity))) throw new Error('Every included variation needs a valid price and quantity.')
  if (!shared.variations.some(v => v.quantity > 0)) throw new Error('This eBay listing has no available stock to publish.')
  const rendered = await renderListingDescriptionSafe(prisma, { productId: parent.id, marketplace: scope.marketplace, channelConnectionId: scope.accountId,
    aliasKey: facts.destination.aliasKey ?? '', mode: products.length > 1 ? 'group' : 'single', body: shared.description, title: shared.title })
  if (rendered.warnings.length) throw new Error(rendered.warnings.join('; '))
  shared.description = rendered.html
  const liveRevision = itemId ? await liveItem(itemId, scope.accountId, scope.marketplace) : null
  return { kind: 'ebay', marketplace: scope.marketplace, itemId, liveRevision, xml: ebayPublicationXml(shared as AddFixedPriceItemInput, itemId, products.length === 1) }
}

export async function sendEbayPublication(plan: EbayPublication, accountId: string, operationId: string) {
  if (getEbayPublishMode() !== 'live' || process.env.NEXUS_EBAY_REAL_API !== 'true' || process.env.EBAY_SANDBOX === 'true') throw new Error('Live eBay publication was disabled.')
  if (plan.itemId && await liveItem(plan.itemId, accountId, plan.marketplace) !== plan.liveRevision) throw Object.assign(new Error('eBay changed after the review. Refresh the publication review.'), { notSent: true })
  const oauthToken = await ebayAuthService.getValidToken(accountId)
  const ctx = { oauthToken, siteId: siteIdForMarket(plan.marketplace) }
  if (!plan.itemId) {
    const check = await callTradingApi('VerifyAddFixedPriceItem', plan.xml.replace(/AddFixedPriceItemRequest/g, 'VerifyAddFixedPriceItemRequest'), ctx)
      .catch(error => { throw Object.assign(error, { notSent: true }) })
    if (!check.raw || !['Success', 'Warning'].includes(check.ack)) throw Object.assign(new Error('eBay did not validate this listing. Nothing was submitted.'), { notSent: true })
  }
  const key = operationId.replace(/-/g, '').toUpperCase()
  const xml = plan.xml.replace('<Item>', `<Item><${plan.itemId ? 'InvocationID' : 'UUID'}>${key}</${plan.itemId ? 'InvocationID' : 'UUID'}>`)
  const sent = await callTradingApi(plan.itemId ? 'ReviseFixedPriceItem' : 'AddFixedPriceItem', xml, ctx)
  const itemId = sent.itemId ?? plan.itemId
  if (!sent.raw || !['Success', 'Warning'].includes(sent.ack) || !itemId || !/^\d+$/.test(itemId)) throw new Error('eBay did not confirm the publication. Check the channel before retrying.')
  await liveItem(itemId, accountId, plan.marketplace)
  return itemId
}
