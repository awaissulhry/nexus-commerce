/**
 * The product sheet's column GROUPS — one set of names, one order and one colour per group, on every sheet.
 *
 * Owner, 2026-10-01: first "group the attributes like the old flat file" (`docs/product-sheet-groups/PLAN-2026-10-01.md`),
 * then, the same evening: "I want the names of the groups to stay consistent across every variation … We follow the
 * names of all the groups as we see in the Amazon scope", with colours that do not look alike, "unless … there is
 * something unique (like in the case of Shopify, where we have meta fields)". So:
 *   - every sheet (Shared, eBay, Amazon, Shopify, Etsy) uses the Amazon group names, in the order the Amazon sheet
 *     showed them (OUTERWEAR, 2026-10-01): Offer Identity, Variations, Offer, Images, Shipping, Product Details,
 *     Product Identity, Safety and compliance — plus Metafields (Shopify's own) and Other Attributes;
 *   - each group has ONE colour, the same on every sheet, and no two groups share a hue;
 *   - on Shared, Shopify and Etsy everything about identity stays in ONE group (the Owner's earlier fold of Variation
 *     theme, Product relationships, Identity and Identifiers), named Offer Identity.
 *
 * PRESENTATION only. The channel specs keep their own groups: the mapping page's field catalogue and the sharing rules
 * read those (`field-groups.ts` `classifyListingField`), and nothing here may change them.
 *
 * In `packages/shared` because both sides need it: the API groups and orders the sheet's columns, and the web gives the
 * columns it adds itself (progress, product media) the same groups.
 */
import { PARENT_SKU_COLUMN, PRODUCT_ROLE_COLUMN } from './master-sheet.js'

/** Colour names (Tailwind's), as design-system tokens: `--nds-grid-tone-<tone>-*`. */
export const SHEET_TONES = ['slate', 'purple', 'emerald', 'pink', 'orange', 'blue', 'yellow', 'red', 'violet', 'cyan'] as const
export type SheetTone = (typeof SHEET_TONES)[number]

/** Every sheet group key starts with this, so a saved layout made before the regrouping is recognisable. */
export const SHEET_GROUP_PREFIX = 'sheet:'
export const isSheetGroupKey = (key: string | null | undefined): boolean => !!key?.startsWith(SHEET_GROUP_PREFIX)

export interface SheetGroupDef {
  key: string
  label: string
  tone: SheetTone
}

const group = (key: string, label: string, tone: SheetTone): SheetGroupDef => ({ key: `${SHEET_GROUP_PREFIX}${key}`, label, tone })

/** The groups, in display order. */
export const SHEET_GROUPS = {
  offerIdentity: group('offer-identity', 'Offer Identity', 'slate'),
  variations: group('variations', 'Variations', 'purple'),
  offer: group('offer', 'Offer', 'emerald'),
  images: group('images', 'Images', 'pink'),
  shipping: group('shipping', 'Shipping', 'orange'),
  productDetails: group('product-details', 'Product Details', 'blue'),
  productIdentity: group('product-identity', 'Product Identity', 'yellow'),
  safety: group('safety-and-compliance', 'Safety and compliance', 'red'),
  metafields: group('metafields', 'Metafields', 'violet'),
  other: group('other-attributes', 'Other Attributes', 'cyan'),
} as const satisfies Record<string, SheetGroupDef>

const ORDER: readonly SheetGroupDef[] = Object.values(SHEET_GROUPS)
const BY_KEY = new Map(ORDER.map((g) => [g.key, g]))
/** A group's place in the display order (unknown keys last). */
export const sheetGroupRank = (key: string | null | undefined): number => {
  const i = ORDER.findIndex((g) => g.key === key)
  return i < 0 ? ORDER.length : i
}

/** The minimal column shape the grouping needs; both apps' fuller `SheetColumn` satisfies it. */
export interface GroupableColumn {
  key: string
  group: string
  groupKey?: string
  groupTone?: SheetTone
  slot?: { of: string }
}

/** The minimal group shape; the API's `SheetGroup` satisfies it. */
export interface GroupableGroup {
  key: string
  label: string
  channelLabel: string | null
  order: number
  sourceOrder?: number
  tone?: SheetTone
}

/* ── which group a column belongs to ───────────────────────────────────────────────────────────────────────── */

const G = SHEET_GROUPS

/**
 * Fields placed by KEY, each list in its order inside the group. eBay's listing fields keep the old eBay flat file's
 * order inside their new group; `name` is the sheet's Title; `productMedia` is the web's own media column.
 */
const FIELDS: ReadonlyArray<readonly [SheetGroupDef, readonly string[]]> = [
  [G.offerIdentity, ['variation_theme', PRODUCT_ROLE_COLUMN, PARENT_SKU_COLUMN, 'sku', 'item_sku', 'productType', 'product_type', 'categoryId', 'external_product_id', 'external_product_id_type', 'record_action']],
  [G.variations, ['variation_theme', 'sharedSkuListing', 'parentage_level', 'child_parent_sku_relationship']],
  [G.offer, ['conditionId', 'listingFormat', 'listingDuration', 'price', 'bestOffer', 'bestOfferFloor', 'bestOfferCeiling', 'vatRate', 'quantity', 'handlingTime', 'fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']],
  [G.images, ['productMedia', 'imageUrls', 'videoId']],
  [G.shipping, ['itemLocationCountry', 'itemLocation', 'itemPostalCode', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit']],
  [G.productDetails, ['name', 'title', 'subtitle', 'description', 'descriptionThemeId']],
]
const RANK = new Map<string, number>()
for (const [def, keys] of FIELDS) keys.forEach((k, i) => RANK.set(`${def.key}|${k}`, i))
const fieldGroup = (field: string): SheetGroupDef | undefined => {
  if (field.startsWith('child_parent_sku_relationship')) return G.variations
  for (const [def, keys] of FIELDS) if (keys.includes(field)) return def
  return undefined
}
/** The groups the Owner folded into one identity group (Shared, Shopify, Etsy): they all show as Offer Identity. */
const IDENTITY_SOURCES = new Set(['master:relationships', 'master:identity', 'master:identifiers'])

/** A spec or master group, by the last part of its key (`EBAY:aspects` → `aspects`, `master:physical` → `physical`). */
function groupOfSourceKey(sourceKey: string, channel: string): SheetGroupDef {
  const [owner, rest = ''] = sourceKey.includes(':') ? [sourceKey.slice(0, sourceKey.indexOf(':')), sourceKey.slice(sourceKey.indexOf(':') + 1)] : [sourceKey, '']
  const k = rest.toLowerCase()
  if (!k) return owner === 'master' ? G.productDetails : G.other // an ungrouped channel field (`AMAZON`)
  if (/metafield/.test(k)) return G.metafields
  if (['relationships', 'identity', 'identifiers', 'classification'].includes(k)) return G.offerIdentity
  if (k === 'variations') return G.variations
  if (/^offer|^selling_|pricing|inventory|publishing|polic|listing_status|^listing$|fulfil|fulfill/.test(k)) return G.offer
  if (k === 'images' || k === 'media') return G.images
  if (/shipping|physical|package/.test(k)) return G.shipping
  if (k === 'product_identity') return G.productIdentity
  if (/safety|compliance|hazmat/.test(k)) return G.safety
  if (/content|aspects|specifics|product_details|attributes|legacy|seo|search|general|category_attributes/.test(k)) return G.productDetails
  // A business's own attribute group on Shared (its dictionary) is product information; a channel group we do not know
  // is said to be other attributes rather than placed on a guess.
  return owner === 'master' || owner === 'family' ? G.productDetails : channel ? G.other : G.productDetails
}

/** The group a column shows in on this channel's sheet (`null` channel = the Shared sheet). */
export function sheetGroupOf(column: Pick<GroupableColumn, 'key' | 'groupKey' | 'group' | 'slot'>, channel: string | null | undefined): SheetGroupDef {
  const ch = (channel ?? '').toUpperCase()
  if (isSheetGroupKey(column.groupKey)) return BY_KEY.get(column.groupKey!) ?? G.other
  const field = column.slot?.of ?? column.key
  // eBay's item specifics are its Product Details, whatever an aspect is called (an aspect may be keyed `brand`).
  if (column.groupKey === 'EBAY:aspects' || column.groupKey === 'EBAY:other-specifics') return G.productDetails
  // The variation theme is a Variations field where the channel has variations of its own (eBay, Amazon); everywhere
  // else it stays with the identity, as does everything of the folded identity groups.
  if (field === 'variation_theme') return ch === 'EBAY' || ch === 'AMAZON' ? G.variations : G.offerIdentity
  if (column.groupKey && IDENTITY_SOURCES.has(column.groupKey)) return G.offerIdentity
  // On the Amazon sheet Amazon's own template groups decide (its item name is a Product Identity field, for one).
  if (ch === 'AMAZON' && column.groupKey?.startsWith('AMAZON:')) return groupOfSourceKey(column.groupKey, ch)
  return fieldGroup(field) ?? groupOfSourceKey(column.groupKey ?? column.group, ch)
}

function stableByRank<T>(items: readonly T[], rank: (item: T) => number): T[] {
  return items.map((item, index) => ({ item, index, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map(({ item }) => item)
}

/**
 * The sheet's columns in their groups and in the groups' order, and the groups shown, each with its colour. Inside a
 * group the fields listed above lead in their order; the rest keep the incoming order. Idempotent.
 */
export function groupSheetColumns<C extends GroupableColumn>(
  columns: readonly C[], channel: string | null | undefined,
): { columns: C[]; groups: GroupableGroup[] } {
  const placed = columns.map((c) => {
    const def = sheetGroupOf(c, channel)
    return { ...c, group: def.label, groupKey: def.key, groupTone: def.tone }
  })
  const ordered = stableByRank(placed, (c) => sheetGroupRank(c.groupKey) * 10_000 + (RANK.get(`${c.groupKey}|${c.slot?.of ?? c.key}`) ?? 1_000))
  const used = ORDER.filter((g) => ordered.some((c) => c.groupKey === g.key))
  return {
    columns: ordered,
    groups: used.map((g, i) => ({ key: g.key, label: g.label, channelLabel: null, order: i, tone: g.tone })),
  }
}
