import type { PublicationFacts } from './studio-publication-plan.js'
import { object } from './studio-publication-plan.js'
import { buildRow, COCKPIT_EXPANDED_FIELDS } from '../amazon/cockpit-publish-row.js'
import { AmazonFlatFileService } from '../amazon/flat-file.service.js'
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
import { closedMarketSet } from '../amazon-market-offer.service.js'
import { attributesFromCells } from './mapping/schema-requirements.js'
import { loadStoredVariationProjection } from './stored-variation-projection.js'
import { resolveVariationProjection, variationReadinessItems } from './variation-rules.service.js'
import { publicationImages } from './studio-publication-media.js'

export interface AmazonPublication {
  kind: 'amazon'
  sellerId: string
  marketplaceId: string
  feed: { header: Record<string, unknown>; messages: Array<{ messageId: number; sku: string; operationType: string; productType: string; attributes?: Record<string, unknown>; patches?: any[] }> }
}

export async function prepareAmazonPublication(facts: PublicationFacts): Promise<AmazonPublication> {
  const { scope, parent, products, listings, resolved } = facts
  const marketplaceId = await configuredAmazonMarketplaceId(scope.marketplace)
  if (!marketplaceId) throw new Error('The Amazon marketplace identifier is unavailable.')
  const sellerId = await getAmazonSellerId(scope.accountId)
  const closed = await closedMarketSet(products.map(p => p.id))
  if (products.some(p => closed.has(`${p.id}|${scope.marketplace}`))) throw new Error('An Amazon offer is closed. Reopen it before publishing.')
  const service = new AmazonFlatFileService(prisma, new CategorySchemaService(prisma, new AmazonService()))
  const sellerSkus = new Map(products.map(product => {
    const listing = listings.find(l => l.productId === product.id)
    const offers = [...new Set(listing?.offers.filter(o => o.isActive).map(o => o.sku) ?? [])]
    if (offers.length > 1) throw new Error(`${product.sku} has multiple seller SKUs. Select its offer before publishing.`)
    const pa = object(listing?.platformAttributes)
    const identities = [...new Set([...offers, ...[pa.sellerSku, pa.seller_sku, pa.sku, pa.item_sku, object(listing?.flatFileSnapshot).item_sku].filter((v): v is string => typeof v === 'string' && !!v.trim())])]
    if (identities.length > 1) throw new Error(`${product.sku}: conflicting Amazon seller SKUs. Reconcile this listing's identity before publishing.`)
    if (!identities.length && facts.destination.aliasKey) throw new Error(`${product.sku}: this alias needs its own Amazon seller SKU before publishing.`)
    return [product.id, identities[0] ?? product.sku]
  }))
  if (new Set(sellerSkus.values()).size !== products.length) throw new Error('Included products share an Amazon seller SKU. Reconcile their listing identities before publishing.')
  let projection: ReturnType<typeof resolveVariationProjection> | undefined
  let variationInput: Awaited<ReturnType<typeof loadStoredVariationProjection>>['input'] | undefined
  if (products.length > 1) {
    const stored = await loadStoredVariationProjection({ productId: parent.id, channel: scope.channel, market: scope.marketplace, accountId: scope.accountId, aliasKey: facts.destination.aliasKey ?? '' })
    variationInput = stored.input
    variationInput.family.variants = variationInput.family.variants?.map(v => ({ ...v, included: products.some(p => p.id === v.id) }))
    projection = resolveVariationProjection(variationInput)
    const errors = variationReadinessItems(projection, `AMAZON ${scope.marketplace}`).filter(i => i.severity === 'error')
    if (!projection.theme || errors.length) throw new Error(errors.map(i => i.message).join('; ') || 'Set the Amazon variation theme in Information before publishing.')
  }
  const feed: AmazonPublication['feed'] = { header: {}, messages: [] }
  for (const product of products) {
    const listing = listings.find(l => l.productId === product.id)
    const data = resolved[0]?.products.find(p => p.productId === product.id)
    if (!data) throw new Error(`${product.sku} could not be resolved.`)
    const current = { ...listing, priceOverride: listing?.followMasterPrice !== false ? product.basePrice : listing.priceOverride ?? listing.price,
      quantityOverride: listing?.followMasterQuantity !== false ? product.totalStock : listing.quantityOverride ?? listing.quantity }
    const row = buildRow({ listing: current, product, marketplace: scope.marketplace, parentSku: sellerSkus.get(parent.id) })
    row.item_sku = sellerSkus.get(product.id)
    row.product_type = data.category.channelCategoryId ?? row.product_type
    row._isNew = !listing?.externalListingId
    row.record_action = row._isNew ? 'full_update' : 'partial_update'
    if (projection?.theme) row.variation_theme = projection.theme.code
    const activeOffer = listing?.offers.find(o => o.isActive)
    const fulfillment = activeOffer?.fulfillmentMethod ?? listing?.fulfillmentMethod ?? product.fulfillmentMethod
    if (fulfillment) row.fulfillment_availability__fulfillment_channel_code = fulfillment === 'FBA' ? `AMAZON_${({ eu: 'EU', na: 'NA', fe: 'JP' } as const)[await getAmazonRegion(scope.accountId)]}` : 'DEFAULT'
    if (!product.isParent && !fulfillment && !row.fulfillment_availability__fulfillment_channel_code) throw new Error(`${product.sku}: choose a fulfillment method before publishing.`)
    row.fulfillment_availability__quantity = Math.max(0, Number(current.quantityOverride ?? 0) - (listing?.stockBuffer ?? 0))
    if (Number.isNaN(Number(row.fulfillment_availability__quantity))) throw new Error(`${product.sku}: quantity is invalid.`)
    const images = publicationImages(facts, product)
    if (!images.length) throw new Error(`${product.sku}: add a product image before publishing.`)
    if (images.length > 9) throw new Error(`${product.sku}: choose at most nine images for the Amazon product gallery.`)
    row.main_product_image_locator = images[0]
    for (let i = 1; i < images.length; i++) row[`other_product_image_locator_${i}`] = images[i]
    const hints = await service.getFeedSchemaHints(scope.marketplace, String(row.product_type))
    const legacy = service.buildJsonFeedBody([row as any], scope.marketplace, sellerId, COCKPIT_EXPANDED_FIELDS, hints)
    const spec = await loadAmazonSpec(scope.marketplace, String(row.product_type), scope.accountId)
    const base = JSON.parse(legacy)
    const values = Object.fromEntries(Object.entries(data.cells).map(([key, cell]) => [key, cell.value]))
    for (const axis of projection?.axes.filter(a => a.included) ?? []) {
      const variant = variationInput?.family.variants?.find(v => v.id === product.id)
      if (variant && axis.target) values[axis.target] = variant.axisValues[axis.familyKey]
    }
    // Preserve the owning pricing/inventory/media builder; serialize the other
    // saved listing settings with their schema paths, including policies.
    const ownedKeys = new Set(resolved[0].catalogue?.fields.filter(f => f.sourceOwner && !['Pricing', 'Inventory', 'Media', 'Product media', 'Channel-reported data'].includes(f.sourceOwner.label)).map(f => f.fieldKey))
    const owned = attributesFromCells(spec, Object.fromEntries(Object.entries(values).filter(([key]) => ownedKeys.has(key))))
    delete owned.child_parent_sku_relationship // parent identity is the selected alias's seller SKU
    delete owned.variation_theme // the shared variation resolver is authoritative
    Object.assign(base.messages[0].attributes, owned)
    const mappedCells = Object.fromEntries(Object.entries(data.cells).map(([key, cell]) => [key, { ...cell, value: values[key] }]))
    const mapped = applyResolvedMappingToAmazonFeed(JSON.stringify(base), { ...resolved[0], products: [{ ...data, cells: mappedCells }] }, spec)
    const envelope = JSON.parse(mapped)
    const message = envelope.messages[0]
    // The content resolver owns every supported language, including reviewed pins.
    const content = await buildAmazonContentAttributes({ product: product as any, parent: product.id === parent.id ? null : parent as any,
      listing, marketplace: scope.marketplace, marketplaceId })
    if (message.attributes) {
      for (const key of ['item_name', 'product_description', 'bullet_point', 'generic_keyword']) delete message.attributes[key]
      Object.assign(message.attributes, content)
    } else {
      const contentKeys = new Set(['item_name', 'product_description', 'bullet_point', 'generic_keyword'].map(k => `/attributes/${k}`))
      message.patches = [...(message.patches ?? []).filter((p: any) => !contentKeys.has(p.path)),
        ...Object.entries(content).map(([key, value]) => ({ op: 'replace', path: `/attributes/${key}`, value }))]
    }
    feed.header = envelope.header
    feed.messages.push({ ...message, messageId: feed.messages.length + 1 })
  }
  return { kind: 'amazon', sellerId, marketplaceId, feed }
}

/** Validate the complete family before submitting its single feed. An acknowledgement is not live status. */
export async function sendAmazonPublication(plan: AmazonPublication, accountId: string) {
  let documentId: string
  try {
  const client = new AmazonSpApiClient({ id: accountId, region: await getAmazonRegion(accountId) })
  for (const message of plan.feed.messages) {
    const checked = await client.validateListing({ sellerId: plan.sellerId, marketplaceId: plan.marketplaceId,
      sku: message.sku, productType: message.productType,
      ...(message.operationType === 'UPDATE' ? { attributes: message.attributes ?? {} } : { patches: message.patches ?? Object.entries(message.attributes ?? {}).map(([key, value]) => ({ op: 'replace' as const, path: `/attributes/${key}`, value })) }) })
    if (!checked.available || !checked.ok) throw Object.assign(new Error(`${message.sku}: ${checked.available ? checked.errors : 'Amazon validation is unavailable. Nothing was submitted.'}`), { notSent: true })
  }
  const sp = await getAmazonSpClient(accountId)
  const document = await sp.callAPI({ operation: 'createFeedDocument', endpoint: 'feeds', body: { contentType: 'application/json; charset=UTF-8' } })
  const uploaded = await fetch(document.url, { method: 'PUT', headers: { 'Content-Type': 'application/json; charset=UTF-8' },
    body: JSON.stringify(plan.feed), signal: AbortSignal.timeout(60_000) })
  if (!uploaded.ok) throw new Error(`Amazon feed upload failed (${uploaded.status}).`)
  documentId = document.feedDocumentId
  } catch (error) { throw Object.assign(error instanceof Error ? error : new Error(String(error)), { notSent: true }) }
  const sp = await getAmazonSpClient(accountId)
  const feed = await sp.callAPI({ operation: 'createFeed', endpoint: 'feeds', body: { feedType: 'JSON_LISTINGS_FEED', marketplaceIds: [plan.marketplaceId], inputFeedDocumentId: documentId } })
  if (typeof object(feed).feedId !== 'string') throw new Error('Amazon did not return a feed identifier. Check submission history before retrying.')
  return feed.feedId as string
}

/** Poll with the reviewed account; processing success does not prove storefront visibility. */
export async function readAmazonPublication(feedId: string, accountId: string, skus: string[]) {
  const sp = await getAmazonSpClient(accountId)
  const feed = await sp.callAPI({ operation: 'getFeed', endpoint: 'feeds', path: { feedId } })
  if (!['DONE', 'CANCELLED', 'FATAL'].includes(feed.processingStatus)) return null
  if (feed.processingStatus !== 'DONE') return { failed: true, results: skus.map(sku => ({ sku, failed: true, message: `Amazon feed ${feed.processingStatus.toLowerCase()}.` })) }
  if (!feed.resultFeedDocumentId) return null
  const document = await sp.callAPI({ operation: 'getFeedDocument', endpoint: 'feeds', path: { feedDocumentId: feed.resultFeedDocumentId } })
  const response = await fetch(document.url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`Amazon processing report is unavailable (${response.status}).`)
  const { decodeReportBytes, parseProcessingReport } = await import('../amazon-flat-file-feed.service.js')
  const report = parseProcessingReport(decodeReportBytes(Buffer.from(await response.arrayBuffer()), document.compressionAlgorithm), skus)
  if (report.pending || (!report.feedError && skus.some(sku => !report.perSku.some(row => row.sku === sku)))) return null
  return { failed: !!report.feedError, results: skus.map(sku => {
    const row = report.perSku.find(r => r.sku === sku)
    return { sku, failed: !!report.feedError || row?.status === 'error', message: report.feedError ?? (row?.issues.map(i => i.message).join('; ') || 'Amazon processed this product.') }
  }) }
}
