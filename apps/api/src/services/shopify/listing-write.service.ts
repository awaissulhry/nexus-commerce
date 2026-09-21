/**
 * P1.4 (docs/channel-connections/FINAL-PLAN.md) — a queued change to a LINKED Shopify listing (a
 * product imported or linked, not a Nexus-native family), sent on the 2026-07 GraphQL client with the
 * row's own account. It replaces the REST 2024-01 path that used env credentials, picked "the first"
 * variant for a SKU and "the first" shop location.
 *
 *   - identity: the variant / inventory item / product ids stored on the listing, else EXACTLY ONE
 *     variant with the SKU; the variant read back must carry the SKU and the product;
 *   - content: `productUpdate` (title, description) + `metafieldsSet` (compliance fields);
 *   - price: `productVariantsBulkUpdate`, read back;
 *   - stock: the reviewed location on the listing (`inventoryLocationId`), else — Owner decision
 *     2026-09-20 — the shop's location when it has EXACTLY ONE active one; two or more, or none, are
 *     refused (never "the first"). Then `inventorySetQuantities` with compare-and-set
 *     (`changeFromQuantity`: the quantity just read) and `@idempotent(key)` (mandatory since 2026-04),
 *     read back.
 * Every call goes through the channel gateway (admin-client → shopifyTransport). A refusal or a failed
 * read-back throws with one plain sentence; the queue records it.
 */
import { assertPushAllowed, type PushLockListing } from '@nexus/shared/push-lock'
import { shopifyAdmin, assertShopifyResult as checked, ShopifyUserErrors, type ShopifyGraphql } from './admin-client.js'
import { toGid } from './content-publisher.js'
import { idempotencyKeyFor } from '../gateway/gateway.js'
import { checkShopifyCircuit, recordShopifyOutcome } from '../shopify-publish-gate.service.js'

export interface LinkedListingRow {
  id: string
  syncType: string
  payload?: Record<string, any> | null
  product?: { id: string; sku: string } | null
  /** The listing row as loaded (it carries the push-lock fields too). */
  channelListing?: (PushLockListing & { id: string; platformAttributes?: unknown }) | null
}

export interface LinkedListingWork {
  /** CONTENT_UPDATE: the product fields to send (title / description) and the compliance metafields. */
  content?: { title?: string | null; description?: string | null; metafields: Array<{ namespace: string; key: string; type: string; value: string }> }
  /** PRICE_UPDATE: the price to set. */
  price?: number | null
  /** Stock: the quantity to set (already buffered and clamped by the caller). */
  quantity?: number | null
}

const VARIANT_QUERY = `query NexusVariant($id: ID!, $location: ID!) { productVariant(id: $id) { id sku price product { id } inventoryItem { id inventoryLevel(locationId: $location) { quantities(names: ["available"]) { name quantity } } } } }`
const VARIANT_BY_SKU = `query NexusVariantBySku($q: String!) { productVariants(first: 2, query: $q) { nodes { id sku product { id } inventoryItem { id } } } }`
const VARIANT_PRICE_QUERY = `query NexusVariantPrice($id: ID!) { productVariant(id: $id) { id sku price product { id } inventoryItem { id } } }`
const SHOP_LOCATIONS = `query NexusShopLocations { locations(first: 3, includeInactive: false, includeLegacy: false) { nodes { id name isActive } } }`
const isLocationId = (value: unknown) => /^gid:\/\/shopify\/Location\/\d+$/.test(String(value ?? ''))

/**
 * The location this listing's stock goes to: the one reviewed on the listing, else the shop's own when
 * it has exactly one active location (Owner decision 2026-09-20). Two or more → refused: Nexus never
 * picks one of several. The single location is not stored, so a second one refuses from that day on.
 */
async function stockLocation(gql: ShopifyGraphql, row: LinkedListingRow, sku: string): Promise<string> {
  const reviewed = mapping(row).inventoryLocationId
  if (isLocationId(reviewed)) return reviewed as string
  const nodes = (await gql(SHOP_LOCATIONS)).locations?.nodes ?? []
  const active = nodes.filter((l: any) => l?.isActive !== false && isLocationId(l?.id))
  if (active.length === 1) return active[0].id as string
  throw new Error(active.length === 0
    ? `No reviewed Shopify stock location for ${sku}, and the shop has no active location. Nothing was sent.`
    : `No reviewed Shopify stock location for ${sku}, and the shop has ${active.length} active locations. Choose the location for this listing; none was chosen automatically.`)
}

function mapping(row: LinkedListingRow): Record<string, string | undefined> {
  const attrs = row.channelListing?.platformAttributes
  return attrs && typeof attrs === 'object' ? (attrs as Record<string, string | undefined>) : {}
}

/** The variant this row is for: its stored ids, else exactly one variant with the SKU. */
async function identify(gql: ShopifyGraphql, row: LinkedListingRow) {
  const m = mapping(row)
  const sku = row.product?.sku ?? ''
  if (m.variantId && m.inventoryItemId && m.shopifyProductId) {
    return { variantId: toGid('ProductVariant', m.variantId), inventoryItemId: toGid('InventoryItem', m.inventoryItemId), productId: toGid('Product', m.shopifyProductId) }
  }
  if (!sku) throw new Error('This listing has no SKU and no stored Shopify variant. Link the variant first.')
  const found = (await gql(VARIANT_BY_SKU, { q: `sku:${JSON.stringify(sku)}` })).productVariants?.nodes ?? []
  const exact = found.filter((v: any) => v?.sku === sku)
  if (exact.length !== 1) {
    throw new Error(exact.length === 0
      ? `No Shopify variant has the SKU ${sku}. Publish or link the listing first.`
      : `More than one Shopify variant has the SKU ${sku}. Link the right variant; none was chosen automatically.`)
  }
  return { variantId: exact[0].id as string, inventoryItemId: exact[0].inventoryItem.id as string, productId: exact[0].product.id as string }
}

/**
 * P4.3f — Shopify's OWN `available` for this listing, read exactly as the write
 * path reads it.
 *
 * 🔴 It lives HERE, beside the write, and reuses `identify` and `stockLocation`
 * rather than re-deriving them in the read-back service. A reader that decides
 * "which variant" or "which location" one line away from the writer is the drift
 * this programme keeps finding: the read-back would then report a mismatch for a
 * listing the writer sends to a different location, or miss one it does.
 *
 * `available: null` means the variant is not stocked at the reviewed location —
 * "could not read", which is a different fact from "reads zero" and must never be
 * diffed as a quantity.
 */
export async function readShopifyAvailable(
  gql: ShopifyGraphql,
  row: LinkedListingRow,
): Promise<{ available: number | null; price: number | null; locationId: string; variantId: string }> {
  const sku = row.product?.sku ?? '(no SKU)'
  const ids = await identify(gql, row)
  const locationId = await stockLocation(gql, row, sku)
  const variant = (await gql(VARIANT_QUERY, { id: ids.variantId, location: locationId })).productVariant
  const observed = variant?.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === 'available')?.quantity
  // P4.4e — `VARIANT_QUERY` has always selected `price`; the caller threw it
  // away. Returning it costs no extra call. `null` = Shopify did not tell us,
  // which is not the same fact as "Shopify says 0".
  const rawPrice = Number(variant?.price)
  return {
    available: Number.isSafeInteger(observed) ? Number(observed) : null,
    price: Number.isFinite(rawPrice) ? rawPrice : null,
    locationId,
    variantId: ids.variantId,
  }
}

/** Send one queued change to a linked Shopify listing through `accountId`. Returns the result sentence. */
/**
 * P3.2 — the same write, with any rejection recorded on the listing before it is
 * re-thrown.
 *
 * A Shopify `userErrors` is the channel telling us which field it refused and why, in
 * its own words. Before this it reached the queue row as a sentence and reached the
 * listing not at all, so an operator looking at the listing saw a healthy listing.
 *
 * The throw is unchanged — the queue's error handling, the circuit breaker and every
 * caller behave exactly as before. Only a row is added alongside.
 */
export async function syncShopifyLinkedListing(row: LinkedListingRow, accountId: string, work: LinkedListingWork): Promise<string> {
  try {
    return await syncShopifyLinkedListingInner(row, accountId, work)
  } catch (err: any) {
    const listingId = row.channelListing?.id
    if (listingId && err instanceof ShopifyUserErrors) {
      const { recordListingIssues } = await import('../listing-issue-recorder.service.js')
      await recordListingIssues({
        listingId,
        source: 'shopify-write',
        issues: err.userErrors.map((e) => ({
          // Shopify names the field as a path; the LAST segment is the field, the
          // earlier ones are the mutation's own envelope ('input', 'variants').
          code: e.code ?? err.operation,
          message: e.message,
          severity: 'ERROR',
          attributeNames: e.field?.length ? [String(e.field[e.field.length - 1])] : [],
          categories: ['userErrors'],
        })),
      })
    }
    throw err
  }
}

async function syncShopifyLinkedListingInner(row: LinkedListingRow, accountId: string, work: LinkedListingWork): Promise<string> {
  // The push lock (paused, closed, ended, Presence intent), here as well as at the callers: this module
  // is the one place every linked Shopify write passes (Presence W1.5).
  const refusal = assertPushAllowed(row.channelListing ?? null)
  if (refusal) throw Object.assign(new Error(refusal.sentence), { code: refusal.code, refusal })
  const { graphql, domain } = await shopifyAdmin(accountId)
  // The shop's circuit breaker (kept from the REST path): after repeated failures, stop calling this shop.
  const circuit = checkShopifyCircuit(domain)
  if (!circuit.ok) throw new Error(circuit.error)
  const gql: ShopifyGraphql = async (query, variables) => {
    try {
      const data = await graphql(query, variables)
      recordShopifyOutcome(domain, true)
      return data
    } catch (error) {
      recordShopifyOutcome(domain, false, error instanceof Error ? error.message : String(error))
      throw error
    }
  }
  const sku = row.product?.sku ?? '(no SKU)'
  const ids = await identify(gql, row)

  // Identity read-back: the variant must still carry this SKU and belong to this product.
  const current = (await gql(VARIANT_PRICE_QUERY, { id: ids.variantId })).productVariant
  if (!current || current.sku !== row.product?.sku || current.product?.id !== ids.productId || current.inventoryItem?.id !== ids.inventoryItemId) {
    throw new Error(`The Shopify variant for ${sku} changed (SKU, product or inventory item). Reconcile the listing before syncing.`)
  }

  if (row.syncType === 'CONTENT_UPDATE') {
    const content = work.content
    const product: Record<string, string> = { id: ids.productId }
    if (content?.title != null && String(content.title).trim() !== '') product.title = String(content.title)
    if (content?.description !== undefined) product.descriptionHtml = content.description == null ? '' : String(content.description)
    const metafields = content?.metafields ?? []
    if (Object.keys(product).length === 1 && metafields.length === 0) return `Shopify content: no pushable field for ${sku} (skipped).`
    if (Object.keys(product).length > 1) {
      checked((await gql(`mutation NexusProductContent($product: ProductUpdateInput!) { productUpdate(product: $product) { product { id title descriptionHtml } userErrors { field message } } }`, { product })).productUpdate, 'Update product content')
    }
    if (metafields.length) {
      checked((await gql(`mutation NexusComplianceFields($metafields: [MetafieldsSetInput!]!) { metafieldsSet(metafields: $metafields) { metafields { namespace key } userErrors { field message } } }`, {
        metafields: metafields.map((f) => ({ ...f, ownerId: ids.productId })),
      })).metafieldsSet, 'Set compliance fields')
    }
    return `Shopify content updated: ${sku}${metafields.length ? ` + ${metafields.length} compliance field(s)` : ''}.`
  }

  if (row.syncType === 'PRICE_UPDATE' || work.price != null) {
    const price = work.price
    if (price == null || !Number.isFinite(Number(price)) || Number(price) < 0) throw new Error(`A valid price is required for ${sku}.`)
    const priceStr = Number(price).toFixed(2)
    checked((await gql(`mutation NexusVariantPriceSet($productId: ID!, $variants: [ProductVariantsBulkInput!]!) { productVariantsBulkUpdate(productId: $productId, variants: $variants) { productVariants { id price } userErrors { field message } } }`, {
      productId: ids.productId, variants: [{ id: ids.variantId, price: priceStr }],
    })).productVariantsBulkUpdate, 'Update variant price')
    const after = (await gql(VARIANT_PRICE_QUERY, { id: ids.variantId })).productVariant
    if (Number(after?.price) !== Number(priceStr)) throw new Error(`Shopify price read-back for ${sku} differs from ${priceStr}.`)
    return `Shopify price updated and read back: ${sku} → ${priceStr}.`
  }

  // Stock
  const quantity = work.quantity
  if (quantity == null || !Number.isSafeInteger(quantity) || quantity < 0) throw new Error(`A valid stock quantity is required for ${sku}.`)
  const location = await stockLocation(gql, row, sku)
  const read = async () => (await gql(VARIANT_QUERY, { id: ids.variantId, location })).productVariant
  const before = await read()
  const observed = before?.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === 'available')?.quantity
  if (!Number.isSafeInteger(observed)) throw new Error(`Shopify stock for ${sku} is not stocked at the reviewed location. No other location was used.`)
  if (observed !== quantity) {
    checked((await gql(`mutation NexusVariantStock($input: InventorySetQuantitiesInput!, $key: String!) { inventorySetQuantities(input: $input) @idempotent(key: $key) { inventoryAdjustmentGroup { reason } userErrors { field message code } } }`, {
      key: idempotencyKeyFor('shopify-stock', row.id, ids.inventoryItemId, location, observed, quantity),
      input: { name: 'available', reason: 'correction', referenceDocumentUri: `nexus://shopify-sync/${row.id}`, quantities: [{ inventoryItemId: ids.inventoryItemId, locationId: location, quantity, changeFromQuantity: observed }] },
    })).inventorySetQuantities, 'Set variant stock')
  }
  const after = (await read())?.inventoryItem?.inventoryLevel?.quantities?.find((q: any) => q.name === 'available')?.quantity
  if (after !== quantity) throw new Error(`Shopify stock for ${sku} changed during the read-back (${after} ≠ ${quantity}). Reconcile before retrying.`)
  return observed === quantity ? `Shopify stock already ${quantity} for ${sku} (nothing sent).` : `Shopify stock set and read back: ${sku} ${observed} → ${quantity}.`
}
