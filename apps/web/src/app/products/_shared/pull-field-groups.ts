/**
 * Shared field-group classifier for the in-editor "Pull from {channel}"
 * feature. Used by:
 *   - AmazonFlatFileClient (P1+P2)
 *   - PullDiffModal           (P2)
 *   - EbayFlatFileClient      (P3)
 *
 * Routes a column id into one of the six high-level pull groups the
 * scope panel exposes. Amazon and eBay column ids don't overlap, so a
 * single function can route both — the order of checks below preserves
 * Amazon's pre-existing behaviour exactly.
 */

export type PullGroupId =
  | 'content'
  | 'pricing'
  | 'stock'
  | 'images'
  | 'variations'
  | 'other'

export interface PullGroup {
  id: PullGroupId
  label: string
  description: string
}

export const PULL_GROUPS: PullGroup[] = [
  { id: 'content',    label: 'Title & content',     description: 'Title, description, bullets, keywords, condition, category' },
  { id: 'pricing',    label: 'Pricing',             description: 'Price, sale price, best-offer, currency' },
  { id: 'stock',      label: 'Stock & fulfillment', description: 'Quantity, handling time, channel, lead time' },
  { id: 'images',     label: 'Images',              description: 'Main image + additional image locators' },
  { id: 'variations', label: 'Variations',          description: 'Parentage level, parent SKU, variation theme' },
  { id: 'other',      label: 'All other attributes', description: 'Item specifics, policies, anything else returned' },
]

export const GROUP_LABEL: Record<PullGroupId, string> = {
  content:    'Content',
  pricing:    'Pricing',
  stock:      'Stock',
  images:     'Images',
  variations: 'Variations',
  other:      'Other',
}

export const GROUP_BADGE_CLASS: Record<PullGroupId, string> = {
  content:    'bg-blue-50 text-blue-700 dark:bg-blue-950/40 dark:text-blue-300',
  pricing:    'bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300',
  stock:      'bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300',
  images:     'bg-purple-50 text-purple-700 dark:bg-purple-950/40 dark:text-purple-300',
  variations: 'bg-teal-50 text-teal-700 dark:bg-teal-950/40 dark:text-teal-300',
  other:      'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-400',
}

export function pullFieldGroup(field: string): PullGroupId {
  // ── Amazon flat-file columns (preserved from P1) ─────────────────
  if (
    field === 'item_name' ||
    field === 'product_description' ||
    field === 'generic_keyword' ||
    field === 'brand' ||
    field === 'color'
  ) return 'content'
  if (/^bullet_point(_\d+)?$/.test(field)) return 'content'
  if (field.startsWith('purchasable_offer')) return 'pricing'
  if (field.startsWith('fulfillment_availability')) return 'stock'
  if (field === 'main_product_image_locator' || /image_locator(_\d+)?$/.test(field)) return 'images'
  if (field === 'parentage_level' || field === 'parent_sku' || field === 'variation_theme') return 'variations'

  // ── eBay flat-file columns (P3) ───────────────────────────────────
  // Editor uses flat, snake_case ids — no nested __ structures.
  if (
    field === 'title' ||
    field === 'subtitle' ||
    field === 'description' ||
    field === 'condition' ||
    field === 'category_id' ||
    field === 'ean' ||
    field === 'mpn'
  ) return 'content'
  if (
    field === 'price' ||
    field === 'best_offer_enabled' ||
    field === 'best_offer_floor' ||
    field === 'best_offer_ceiling' ||
    /^(it|de|fr|es|uk)_price$/.test(field)
  ) return 'pricing'
  if (
    field === 'quantity' ||
    field === 'handling_time' ||
    /^(it|de|fr|es|uk)_qty$/.test(field)
  ) return 'stock'
  if (/^image_\d+$/.test(field)) return 'images'

  return 'other'
}
