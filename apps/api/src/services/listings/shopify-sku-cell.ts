/**
 * S9 — the Shopify sheet's SKU column (`listing_sku`, Shopify's native SKU; its stores are `platformAttributes.sku` and
 * the old sheet edits in `overrideData.listing_sku`) reads and writes the listing's OWN SKU (`ChannelListing.channelSku`):
 * the save goes through `setChannelSku` (the channel-SKU door of `bulk-edit.service.ts`), and the cell shows exactly the
 * SKU Publish sends — `wantedChannelSku` (channel-sku.pure.ts), the one rule and the one order (S5: its own SKU, then the
 * old sheet edit, then the stored native SKU or an extra listing's own SKU, then the product SKU). No second order here.
 *
 * This is the read half: a VIEW of the listing row for the resolver, in which the SKU stores hold only that answer, so
 * the cell, the mapping preview and every resolver reader agree with Publish (`content-workspace.service.ts`). Never
 * written back. A listing whose wanted SKU is the product SKU shows no stored SKU at all: the cell follows the column's
 * rule (the product SKU), as an inherited value. No single SKU on record (a conflict): the cell is empty, and Publish
 * refuses with the resolver's sentence.
 */
import { shopifyProductSpec } from '../pim/channel-specs/store.js'
import { SHOPIFY_SKU_STORES, wantedChannelSku, type ChannelSkuListing } from './channel-sku.pure.js'

/**
 * The rule the SKU column resolves with when a listing follows the product SKU: the column's own default (the product
 * SKU), never a business's mapping rule on it. Publish never applied a mapping rule to a Shopify SKU (it sends
 * `wantedChannelSku`), so the sheet ignores one too — what the cell shows is what Shopify gets, and a business that has
 * such a rule keeps the SKU it sends today.
 */
export const SHOPIFY_SKU_COLUMN_RULE = shopifyProductSpec().fields.find(field => field.shopifyField?.id === 'sku' && !field.shopifyField.definition)?.defaultRule ?? { source: 'sku' }

/** The Shopify SKU column (`listing_sku`), by its field key on a Shopify coordinate. */
export const isShopifySkuColumn = (channel: string, fieldKey: string) =>
  String(channel ?? '').toUpperCase() === 'SHOPIFY' && SHOPIFY_SKU_STORES.overrideKeys.includes(fieldKey)

/**
 * The one line the mapping editor shows on the Shopify SKU column (read-only, a saved rule "Not used") and the sentence a
 * mapping review refuses a rule for it with: a rule there would be saved and never read (the Owner's honesty rule).
 */
export const SHOPIFY_SKU_RULE_NOT_USED = 'The SKU column always sends the listing\'s own SKU, or the product SKU; edit it in the product sheet.'

type RuleBuckets = { fields?: Record<string, unknown>; byProductType?: Record<string, Record<string, unknown> | undefined> }

/**
 * A mapping change that gives the Shopify SKU column a rule it did not have (a new or changed rule, in the market's
 * rules or a category's): the refusal sentence; null otherwise. Removing a saved rule, or leaving one as it is, passes.
 */
export function shopifySkuRuleRefusal(channel: string, before: RuleBuckets, after: RuleBuckets): string | null {
  if (String(channel ?? '').toUpperCase() !== 'SHOPIFY') return null
  const keyOf = (bucket: Record<string, unknown> | undefined, key: string) => bucket?.[key] === undefined ? undefined : JSON.stringify(bucket[key])
  for (const key of SHOPIFY_SKU_STORES.overrideKeys) {
    if (keyOf(after.fields, key) !== undefined && keyOf(after.fields, key) !== keyOf(before.fields, key)) return SHOPIFY_SKU_RULE_NOT_USED
    for (const [type, bucket] of Object.entries(after.byProductType ?? {})) {
      if (keyOf(bucket, key) !== undefined && keyOf(bucket, key) !== keyOf(before.byProductType?.[type], key)) return SHOPIFY_SKU_RULE_NOT_USED
    }
  }
  return null
}

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}

/** A copy of `bag` without the value at `path` (nested objects copied on the way). */
function withoutPath(bag: Record<string, unknown>, path: string[]): Record<string, unknown> {
  if (!path.length || !(path[0] in bag)) return bag
  const out = { ...bag }
  if (path.length === 1) delete out[path[0]]
  else out[path[0]] = withoutPath(record(out[path[0]]), path.slice(1))
  return out
}

/** A copy of `bag` with `value` at `path`. */
function withPath(bag: Record<string, unknown>, path: string[], value: unknown): Record<string, unknown> {
  const out = { ...bag }
  out[path[0]] = path.length === 1 ? value : withPath(record(out[path[0]]), path.slice(1), value)
  return out
}

type ShopifySkuRow = Omit<ChannelSkuListing, 'channel'> & { channel?: string | null }

/**
 * The listing as the Shopify SKU column reads it: its SKU stores hold exactly `wantedChannelSku(listing, productSku)`.
 * `alias`: the extra listing's own SKU facts (`ProductListingAlias.sku`, its main product), when the row is one and the
 * caller read it; the rule reads it on the alias's main row only. Any other channel: the row as it is.
 */
export function withWantedShopifySku<T extends ShopifySkuRow>(listing: T, productSku: string | null | undefined,
  alias?: { sku: string | null; productId: string } | null): T {
  if (String(listing.channel ?? '').toUpperCase() !== 'SHOPIFY') return listing
  const facts = { ...listing, channel: 'SHOPIFY', ...(alias !== undefined ? { alias } : {}) }
  const wanted = wantedChannelSku(facts, productSku)
  let platformAttributes = record(listing.platformAttributes)
  for (const path of SHOPIFY_SKU_STORES.attributePaths) platformAttributes = withoutPath(platformAttributes, path)
  let overrideData = record(listing.overrideData)
  for (const key of SHOPIFY_SKU_STORES.overrideKeys) overrideData = withoutPath(overrideData, [key])
  // The product SKU: no stored SKU (the column's rule shows it, as inherited). Anything else, a conflict's empty value too.
  const path = SHOPIFY_SKU_STORES.attributePaths[0]
  if (wanted.source !== 'product' && path?.length) platformAttributes = withPath(platformAttributes, path, wanted.sku)
  return { ...listing, platformAttributes, overrideData }
}
