import prisma from '../../db.js'
import { shopifyAdmin, assertShopifyResult as checked } from './admin-client.js'
import { toGid } from './content-publisher.js'
import { object, digest } from './content-workspace.service.js'
import { previewContentSync, synchronizeContent } from './content-sync.service.js'
import { computeAvailableToPublish } from '../available-to-publish.service.js'

/** Activated native families use named accounts and exact IDs; SKU searches never choose a variant. */
export async function syncNativeShopifyOffer(item: any) {
  const listing = await prisma.channelListing.findUnique({ where: { id: item.channelListing.id } })
  if (!listing || listing.productId !== item.product.id || !listing.channelConnectionId || listing.syncPaused || listing.syncLocked || !listing.isPublished) throw new Error('The Shopify offer is unavailable, unpublished or paused.')
  const mapping = object(listing.platformAttributes)
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
  const { graphql: gql } = await shopifyAdmin(listing.channelConnectionId)
  const variantId = toGid('ProductVariant', mapping.variantId), inventoryItemId = toGid('InventoryItem', mapping.inventoryItemId), productId = toGid('Product', mapping.shopifyProductId)
  const locationId = mapping.inventoryLocationId
  if (!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId ?? '')) throw new Error('The reviewed Shopify inventory location is missing.')
  const query = `query NexusOffer($id:ID!,$location:ID!) { productVariant(id:$id) { id sku price product { id } inventoryItem { id inventoryLevel(locationId:$location) { quantities(names:["available"]) { name quantity } } } } }`
  const read = async () => (await gql(query, { id: variantId, location: locationId })).productVariant
  const remote = await read()
  if (!remote || remote.sku !== item.product.sku || remote.product.id !== productId || remote.inventoryItem.id !== inventoryItemId) throw new Error('The Shopify variant identity changed. Reconcile the family before syncing.')
  if (item.syncType === 'PRICE_UPDATE') {
    const price = listing.followMasterPrice ? item.product.basePrice : listing.priceOverride ?? listing.price ?? item.payload?.price
    if (!/^\d+(\.\d{1,2})?$/.test(String(price))) throw new Error('A valid variant price is required.')
    checked((await gql(`mutation NexusOfferPrice($productId:ID!,$variants:[ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId:$productId,variants:$variants) { userErrors { field message } } }`, { productId, variants: [{ id: variantId, price: String(price) }] })).productVariantsBulkUpdate, 'Update variant price')
    if (Number((await read())?.price) !== Number(price)) throw new Error('Shopify price readback differs from the requested price.')
    return `Verified Shopify price for ${item.product.sku}.`
  }
  if (!['INVENTORY_UPDATE', 'STOCK_UPDATE', 'QUANTITY_UPDATE'].includes(item.syncType)) throw new Error(`Unsupported native Shopify sync type ${item.syncType}; no stock change was attempted.`)
  let quantity = listing.followMasterQuantity ? item.product.totalStock : listing.quantityOverride ?? listing.quantity ?? item.payload?.quantity
  if (!Number.isSafeInteger(quantity) || quantity < 0) throw new Error('A valid explicit inventory quantity is required.')
  quantity = Math.max(0, quantity - (listing.stockBuffer ?? 0))
  if (process.env.NEXUS_OVERSELL_CLAMP !== '0') {
    const levels = await prisma.stockLevel.findMany({ where: { productId: item.product.id, location: { type: 'WAREHOUSE' } }, select: { available: true } })
    const available = computeAvailableToPublish({ fulfillmentMethod: 'FBM', warehouseAvailable: levels.reduce((n, level) => n + level.available, 0), fbaSellable: 0, stockBuffer: listing.stockBuffer }).available
    quantity = Math.min(quantity, available)
  }
  const observed = remote.inventoryItem.inventoryLevel?.quantities.find((q: any) => q.name === 'available')?.quantity
  if (!Number.isSafeInteger(observed)) throw new Error('Shopify stock is not active at the reviewed location. No location was selected automatically.')
  if (quantity !== observed) checked((await gql(`mutation NexusOfferInventory($input:InventorySetQuantitiesInput!) { inventorySetQuantities(input:$input) { userErrors { field message } } }`, { input: { name: 'available', reason: 'correction', referenceDocumentUri: `nexus://shopify-sync/${item.id}`, quantities: [{ inventoryItemId, locationId, quantity, compareQuantity: observed }] } })).inventorySetQuantities, 'Update variant inventory')
  if ((await read())?.inventoryItem.inventoryLevel?.quantities.find((q: any) => q.name === 'available')?.quantity !== quantity) throw new Error('Shopify inventory changed during readback. Reconcile before retrying.')
  return `Verified Shopify inventory for ${item.product.sku}.`
}
