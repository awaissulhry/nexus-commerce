import prisma from '../../db.js'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { shopifyAdmin, assertShopifyResult as checked } from './admin-client.js'
import { toGid } from './content-publisher.js'
import { object, digest } from './content-workspace.service.js'
import { previewContentSync, synchronizeContent } from './content-sync.service.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'
import { idempotencyKeyFor } from '../gateway/gateway.js'
import { ledgerInputs, loadSyncLedgers } from '../stock-pool/sync-ledgers.js'
import { resolveIntendedQuantity, routedAvailable } from '../sync-control-core.js'
import { loadChannelPolicies, policyFor } from '../sync-control-policy.service.js'
import { guardedColourGraphql, withColourSyncLock } from './colour-products/sync-work.js'
import { listingSendPriceNow } from '../pim/follower-price.js'
import { priceRefusalFor } from '../price-bounds.service.js'

/** Activated native families use named accounts and exact IDs; SKU searches never choose a variant. */
export async function syncNativeShopifyOffer(item: any) {
  const listing = await prisma.channelListing.findUnique({ where: { id: item.channelListing.id } })
  const mapping = object(listing?.platformAttributes)
  if (mapping.shopifyColourProductId && mapping.nexusFamilyId && listing?.channelConnectionId) {
    return withColourSyncLock({ familyId: mapping.nexusFamilyId, accountId: listing.channelConnectionId, marketplace: listing.marketplace, aliasKey: listing.aliasKey },
      () => syncNativeOffer(item))
  }
  return syncNativeOffer(item, listing)
}

async function syncNativeOffer(item: any, observedListing?: Awaited<ReturnType<typeof prisma.channelListing.findUnique>>) {
  const listing = observedListing ?? await prisma.channelListing.findUnique({ where: { id: item.channelListing.id } })
  const refusal = assertPushAllowed(listing)
  if (refusal) throw Object.assign(new Error(refusal.sentence), { code: refusal.code, refusal })
  if (!listing || listing.productId !== item.product.id || !listing.channelConnectionId || listing.syncLocked) throw new Error('The Shopify offer is unavailable, unpublished or paused.')
  if ((item.channelConnectionId && item.channelConnectionId !== listing.channelConnectionId)
    || ['channelConnectionId', 'marketplace', 'aliasKey'].some(key => item.channelListing[key] !== undefined && item.channelListing[key] !== listing[key])) {
    throw new Error('The Shopify listing destination changed. Discard this old job and sync its current destination.')
  }
  const mapping = object(listing.platformAttributes)
  let retired = false
  let expectedColourIdentity: string | null = null
  if (mapping.shopifyColourProductId) {
    const colour = await prisma.shopifyColourProduct.findUnique({ where: { id: mapping.shopifyColourProductId } })
    if (!colour || colour.state !== 'LINKED' || !colour.shopifyProductId || colour.familyId !== mapping.nexusFamilyId
      || colour.channelConnectionId !== listing.channelConnectionId || colour.marketplace !== listing.marketplace || colour.aliasKey !== listing.aliasKey
      || colour.shopifyProductId !== toGid('Product', mapping.shopifyProductId)) throw new Error('The Shopify colour mapping is no longer confirmed. Reconcile this colour before sending stock.')
    expectedColourIdentity = `${colour.workspaceId}:${colour.familyId}:c:${colour.id}`
    const product = await prisma.product.findUnique({ where: { id: listing.productId }, select: { sku: true, parentId: true, deletedAt: true } })
    if (!product || product.sku !== item.product.sku) throw new Error('The Shopify size identity changed. Reconcile this colour before sending stock.')
    retired = !!product.deletedAt || product.parentId !== colour.familyId || mapping.shopifyColourRetired === true
    if (item.syncType === 'CONTENT_UPDATE') throw new Error('Manage colour product content through Information.')
  }
  const stock = ['INVENTORY_UPDATE', 'STOCK_UPDATE', 'QUANTITY_UPDATE'].includes(item.syncType)
  if ((!listing.isPublished && !(retired && stock)) || (retired && !stock)) throw new Error('The Shopify offer is unavailable, unpublished or paused.')
  if (!mapping.nexusFamilyId) throw new Error('The native Shopify mapping is incomplete. Review the family synchronisation.')
  if (item.syncType === 'CONTENT_UPDATE') {
    const scope = { accountId: listing.channelConnectionId, market: listing.marketplace }
    const preview = await previewContentSync(mapping.nexusFamilyId, scope, true)
    if (preview.publication.status !== 'VERIFIED' || preview.publication.contentHash !== digest(preview.draft)) throw new Error('Family content contains unreviewed edits or remote changes. Review synchronisation in the product editor before automatic content updates resume.')
    if (preview.remote?.status !== 'ACTIVE' || !mapping.inventoryLocationId) throw new Error('The Shopify family is not active or has no reviewed inventory location.')
    await synchronizeContent(mapping.nexusFamilyId, scope, { expectedRevision: preview.revision, expectedRemoteRevision: preview.remoteRevision, locationId: mapping.inventoryLocationId, confirmActive: true })
    return 'Shopify family content synchronised and read back.'
  }
  if (!mapping.variantId || !mapping.inventoryItemId || !mapping.shopifyProductId) throw new Error('Only a sellable child variant can receive a price or stock update. The family is a content owner.')
  const admin = await shopifyAdmin(listing.channelConnectionId)
  const gql = mapping.shopifyColourProductId ? guardedColourGraphql(admin.graphql) : admin.graphql
  const variantId = toGid('ProductVariant', mapping.variantId), inventoryItemId = toGid('InventoryItem', mapping.inventoryItemId), productId = toGid('Product', mapping.shopifyProductId)
  const locationId = mapping.inventoryLocationId
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId ?? '')) throw new Error('The reviewed Shopify inventory location is missing.')
  const query = `query NexusOffer($id:ID!,$location:ID!) { productVariant(id:$id) { id sku price product { id identity:metafield(namespace:"nexus",key:"family_id") { value } } inventoryItem { id inventoryLevel(locationId:$location) { quantities(names:["available"]) { name quantity } } } } }`
  const read = async () => (await gql(query, { id: variantId, location: locationId })).productVariant
  const remote = await read()
  if (!remote || remote.sku !== item.product.sku || remote.product.id !== productId || remote.inventoryItem.id !== inventoryItemId
    || expectedColourIdentity && remote.product.identity?.value !== expectedColourIdentity) throw new Error('The Shopify variant identity changed. Reconcile the family before syncing.')
  if (item.syncType === 'PRICE_UPDATE') {
    // Round 6 — the price as the price door queued it (`payload.price`), as every other dispatcher sends it: a follower's
    // RULE price, a pin's own. It sent `product.basePrice` for every following listing, so a "master +10%" variant got the
    // master. A row with no price (the bulk channel batch) sends the listing's own send price (`listingSendPrice`).
    let price: unknown = item.payload?.price
    if (price === undefined || price === null || price === '') {
      const send = await listingSendPriceNow(listing, item.product.basePrice, `Shopify ${listing.marketplace}`)
      if (send.price == null) throw Object.assign(new Error(`${item.product.sku}: ${send.reason} Nothing was sent.`), { code: 'NO_PRICE_TO_SEND' })
      price = send.price
    }
    // The product's own floor and ceiling, as the other price senders hold a price to them (master currency only).
    const outside = await priceRefusalFor({ price: Number(price), productId: item.product.id, channel: 'Shopify', sku: item.product.sku, market: { channel: 'SHOPIFY', marketplace: listing.marketplace } })
    if (outside) throw Object.assign(new Error(outside), { code: 'PRICE_OUT_OF_BOUNDS' })
    // Shopify's two decimals ("22.00", not "22"), as the stored prices read.
    if (typeof price === 'number' && Number.isFinite(price)) price = price.toFixed(2)
    if (!/^\d+(\.\d{1,2})?$/.test(String(price))) throw new Error('A valid variant price is required.')
    checked((await gql(`mutation NexusOfferPrice($productId:ID!,$variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId,variants:$variants) { userErrors { field message } } }`, { productId, variants: [{ id: variantId, price: String(price) }] })).productVariantsBulkUpdate, 'Update variant price')
    if (Number((await read())?.price) !== Number(price)) throw new Error('Shopify price readback differs from the requested price.')
    return `Verified Shopify price for ${item.product.sku}.`
  }
  if (!['INVENTORY_UPDATE', 'STOCK_UPDATE', 'QUANTITY_UPDATE'].includes(item.syncType)) throw new Error(`Unsupported native Shopify sync type ${item.syncType}; no stock change was attempted.`)
  // Shared stock — the product's ledger: its own warehouses, or the pool it sells from. For a product
  // with its own stock, `quantity` is Σ WAREHOUSE quantity, which is what Product.totalStock caches.
  const productLedger = (await loadSyncLedgers(prisma, [item.product.id])).get(item.product.id)
  let quantity = retired ? 0 : listing.followMasterQuantity ? productLedger?.quantity ?? 0 : listing.quantityOverride ?? listing.quantity ?? item.payload?.quantity
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('A valid explicit inventory quantity is required.')
  quantity = Math.max(0, quantity - (listing.stockBuffer ?? 0))
  if (process.env.NEXUS_OVERSELL_CLAMP !== '0') {
    const available = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: productLedger?.available ?? 0, fbaSellable: 0, stockBuffer: listing.stockBuffer }).available
    quantity = Math.min(quantity, available)
  }
  // A retired size retains its mapping for orders and retries. No older quantity job may revive it.
  if (retired) quantity = 0
  if (mapping.shopifyColourProductId) {
    // The older policy loader is fail-open. Read here first so an unavailable policy cannot enable this new writer.
    const policies = await prisma.syncChannelPolicy.findMany()
    const inputs = { channel: 'SHOPIFY', marketplace: listing.marketplace, isFba: listing.fulfillmentMethod === 'FBA',
      offerClosed: !!listing.offerClosedAt, followMasterQuantity: listing.followMasterQuantity, syncPaused: listing.syncPaused,
      pinnedQuantity: listing.quantityOverride ?? listing.quantity, stockBuffer: listing.stockBuffer,
      channelPolicy: policyFor(await loadChannelPolicies({ syncChannelPolicy: { findMany: async () => policies } }), 'SHOPIFY', listing.marketplace, listing.channelConnectionId),
      ...ledgerInputs(productLedger, listing.sourceLocationCodes) }
    const resolved = resolveIntendedQuantity(inputs)
    if (['PAUSED', 'CLOSED', 'FBA_EXCLUDED'].includes(resolved.kind) || !retired && resolved.kind === 'UNCOUNTED')
      throw new Error(`Shopify stock waits: ${resolved.kind}. Review the listing's stock controls.`)
    if (!retired && resolved.kind === 'FOLLOW') quantity = resolved.quantity
    if (!retired && resolved.kind === 'PINNED' && process.env.NEXUS_OVERSELL_CLAMP !== '0') {
      const available = routedAvailable(inputs)
      if (!available.routed && !productLedger?.uncountedIsZero) throw new Error('Shopify stock waits: UNCOUNTED. No stock location is routed to this listing.')
      quantity = Math.min(quantity, Math.max(0, available.available - listing.stockBuffer))
    }
  }
  const observed = remote.inventoryItem.inventoryLevel?.quantities.find((q: any) => q.name === 'available')?.quantity
  if (!Number.isSafeInteger(observed)) throw new Error('Shopify stock is not active at the reviewed location. No location was selected automatically.')
  // P1.4 — since API 2026-04 `compareQuantity` is gone (compare-and-set is `changeFromQuantity`) and the
  // mutation must carry `@idempotent(key)`; the old form failed on every call on the 2026-07 client.
  if (quantity !== observed) checked((await gql(`mutation NexusOfferInventory($input:InventorySetQuantitiesInput!, $key:String!) { inventorySetQuantities(input:$input) @idempotent(key:$key) { userErrors { field message } } }`, { key: idempotencyKeyFor('shopify-stock', item.id, inventoryItemId, locationId, observed, quantity), input: { name: 'available', reason: 'correction', referenceDocumentUri: `nexus://shopify-sync/${item.id}`, quantities: [{ inventoryItemId, locationId, quantity, changeFromQuantity: observed }] } })).inventorySetQuantities, 'Update variant inventory')
  if ((await read())?.inventoryItem.inventoryLevel?.quantities.find((q: any) => q.name === 'available')?.quantity !== quantity) throw new Error('Shopify inventory changed during readback. Reconcile before retrying.')
  return `Verified Shopify inventory for ${item.product.sku}.`
}
