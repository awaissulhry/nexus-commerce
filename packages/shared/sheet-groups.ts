/**
 * The product sheet's column GROUPS — the grouping, order and colours of the old eBay / Amazon flat files
 * (`apps/web/src/components/flat-file/FlatFileGrid.tsx` `GROUP_COLORS`, `ebay-columns.ts`, and the Amazon
 * manifest in `apps/api/src/services/amazon/flat-file.service.ts`). Owner, 2026-10-01: "have the attributes
 * grouped … keeping the same grouping as we had on our flat file, and maybe the same colors as well, and the
 * same order too." Plan: `docs/product-sheet-groups/PLAN-2026-10-01.md`.
 *
 * PRESENTATION only. The channel specs keep their own groups: the mapping page's field catalogue and the
 * sharing rules read those (`field-groups.ts` `classifyListingField`), and nothing here may change them.
 *
 * In `packages/shared` because both sides need it: the API groups and orders the sheet's columns, and the web
 * gives the columns it adds itself (progress, product media) the same group and colour.
 */
import { PARENT_SKU_COLUMN, PRODUCT_ROLE_COLUMN } from './master-sheet.js'

/** The flat file's colour names (Tailwind's), now design-system tokens: `--nds-grid-tone-<tone>-*`. */
export const SHEET_TONES = ['slate', 'blue', 'purple', 'emerald', 'orange', 'cyan', 'teal', 'sky', 'amber', 'yellow', 'red', 'violet'] as const
export type SheetTone = (typeof SHEET_TONES)[number]

/** Every flat-file group key starts with this, so a saved layout made before the regrouping is recognisable. */
export const SHEET_GROUP_PREFIX = 'sheet:'
export const isFlatFileGroupKey = (key: string | null | undefined): boolean => !!key?.startsWith(SHEET_GROUP_PREFIX)

/** The group the sheet's own progress column joins, and the group product media joins (a key ending in it). */
export const IMAGES_GROUP_SUFFIX = ':images'

export interface SheetGroupDef {
  key: string
  label: string
  tone: SheetTone
}

/** The minimal column shape the grouping needs; both apps' fuller `SheetColumn` satisfies it. */
export interface GroupableColumn {
  key: string
  group: string
  groupKey?: string
  groupTone?: SheetTone
  slot?: { of: string }
}

/** The minimal group shape; the API's `SheetGroup` satisfies it. `sourceOrder` is the channel schema's own position. */
export interface GroupableGroup {
  key: string
  label: string
  channelLabel: string | null
  order: number
  sourceOrder?: number
  tone?: SheetTone
}

const group = (key: string, label: string, tone: SheetTone): SheetGroupDef => ({ key: `${SHEET_GROUP_PREFIX}${key}`, label, tone })

/* ── eBay — `ebay-columns.ts`, in screen order ─────────────────────────────────────────────────────────────── */

const EBAY = {
  identifiers: group('identifiers', 'Identifiers', 'slate'),
  listing: group('listing', 'Listing', 'blue'),
  content: group('content', 'Content', 'purple'),
  pricing: group('pricing', 'Pricing', 'emerald'),
  inventory: group('inventory', 'Inventory', 'orange'),
  package: group('package', 'Package & Shipping', 'cyan'),
  images: group('images', 'Images', 'teal'),
  policies: group('policies', 'Policies', 'sky'),
  status: group('status', 'Status', 'slate'),
  specifics: group('item-specifics', 'Item Specifics', 'teal'),
} as const

/**
 * Each eBay listing field's group, in the flat file's column order inside it. The flat file's market group
 * ("Italy (eBay.it)") has no counterpart: the sheet shows one market at a time, so its price and quantity are
 * in Pricing and Inventory. `name` is the sheet's Title; `productMedia` is the web's own media column.
 */
const EBAY_FIELDS: ReadonlyArray<readonly [SheetGroupDef, readonly string[]]> = [
  [EBAY.identifiers, [PRODUCT_ROLE_COLUMN, PARENT_SKU_COLUMN, 'sku', 'ean', 'mpn']],
  [EBAY.listing, ['name', 'title', 'conditionId', 'categoryId', 'variation_theme', 'sharedSkuListing', 'subtitle', 'listingFormat', 'listingDuration']],
  [EBAY.content, ['description', 'descriptionThemeId']],
  [EBAY.pricing, ['price', 'bestOffer', 'bestOfferFloor', 'bestOfferCeiling', 'vatRate']],
  [EBAY.inventory, ['quantity', 'handlingTime']],
  [EBAY.package, ['itemLocationCountry', 'itemLocation', 'itemPostalCode', 'packageType', 'packageWeight', 'packageLength', 'packageWidth', 'packageHeight', 'dimensionUnit']],
  [EBAY.images, ['productMedia', 'imageUrls', 'videoId']],
  [EBAY.policies, ['fulfillmentPolicyId', 'paymentPolicyId', 'returnPolicyId']],
]
const EBAY_ORDER: readonly SheetGroupDef[] = Object.values(EBAY)
const EBAY_SPECIFICS_KEYS = new Set(['EBAY:aspects', 'EBAY:other-specifics'])

/* ── Amazon — the flat file's manifest ─────────────────────────────────────────────────────────────────────── */

const AMAZON_OFFER_IDENTITY = group('offer-identity', 'Offer Identity', 'blue')
const AMAZON_VARIATIONS = group('variations', 'Variations', 'purple')
const AMAZON_OTHER = group('other-attributes', 'Other Attributes', 'violet')
/** The flat file's `GROUP_COLOR_PALETTE`; a template group takes `[schema position + 2]`, slate after the end. */
const AMAZON_PALETTE: readonly SheetTone[] = ['blue', 'purple', 'emerald', 'orange', 'teal', 'amber', 'yellow', 'sky', 'red', 'violet', 'slate']
/** The flat file's English names for Amazon's well-known template groups (`KNOWN_GROUP_EN`). */
const AMAZON_GROUP_EN: Record<string, string> = {
  product_identity: 'Product Identity', images: 'Images', product_details: 'Product Details', offer: 'Offer',
  shipping: 'Shipping', compliance: 'Compliance & Safety', fulfillment: 'Fulfillment',
}
const AMAZON_IDENTITY_FIELDS = [PRODUCT_ROLE_COLUMN, PARENT_SKU_COLUMN, 'sku', 'item_sku', 'productType', 'product_type', 'external_product_id', 'external_product_id_type', 'record_action']
const AMAZON_VARIATION_FIELDS = ['variation_theme', 'parentage_level', 'child_parent_sku_relationship']

function amazonTemplateGroup(source: GroupableGroup | undefined, templateKey: string): SheetGroupDef {
  const position = source?.sourceOrder ?? source?.order ?? AMAZON_PALETTE.length
  const label = AMAZON_GROUP_EN[templateKey] ?? (/^offer_/.test(templateKey) ? 'Offer — Selling on Amazon' : source?.label ?? templateKey)
  return group(`amazon:${templateKey}`, label, AMAZON_PALETTE[position + 2] ?? 'slate')
}

/* ── every other scope: the groups stay, each gets the colour of what it holds ─────────────────────────────── */

/** A colour for a group the flat file never had (Shared, Shopify, Etsy), by what its name says it holds. */
export function sheetGroupTone(key: string | null | undefined, label: string | null | undefined): SheetTone {
  const text = `${key ?? ''} ${label ?? ''}`.toLowerCase()
  if (/relationship|progress|identity|identifier|variation-theme|status/.test(text)) return 'slate'
  if (/pric|cost|margin/.test(text)) return 'emerald'
  if (/inventor|stock|quantit/.test(text)) return 'orange'
  if (/ship|package|dimension|weight|physical/.test(text)) return 'cyan'
  if (/image|media|photo|video/.test(text)) return 'teal'
  if (/polic|publish/.test(text)) return 'sky'
  if (/content|seo|description/.test(text)) return 'purple'
  if (/complian|safety|hazmat/.test(text)) return 'red'
  if (/metafield|attribute|specific|detail|propert|aspect/.test(text)) return 'teal'
  if (/classif|categor|general|listing|variation/.test(text)) return 'blue'
  return 'violet'
}

/* ── Shared, Shopify, Etsy: one Identity group ─────────────────────────────────────────────────────────────── */

/**
 * The Owner, 2026-10-01: "fold [the variation theme, product relations and identity] into a single group named
 * identity, and maybe also the identifiers, so that everything related to the identity lives here." On the sheets
 * the flat file never had, these four groups are ONE: the variation theme first, then the product role and parent
 * SKU, then the identity fields and the identifiers in their incoming order. (eBay and Amazon keep the flat file's.)
 */
export const IDENTITY_GROUP = { key: 'master:identity', label: 'Identity' } as const
const FOLDED_INTO_IDENTITY = new Set(['master:relationships', 'master:identity', 'master:identifiers'])
const IDENTITY_LEAD = ['variation_theme', PRODUCT_ROLE_COLUMN, PARENT_SKU_COLUMN]

function withOneIdentityGroup<C extends GroupableColumn, G extends GroupableGroup>(columns: readonly C[], groups: readonly G[]): { columns: C[]; groups: GroupableGroup[] } {
  const folded = columns.map((c) => (c.groupKey && FOLDED_INTO_IDENTITY.has(c.groupKey) ? { ...c, group: IDENTITY_GROUP.label, groupKey: IDENTITY_GROUP.key } : c))
  const firstSeen = new Map<string, number>()
  folded.forEach((c, i) => { const key = c.groupKey ?? c.group; if (!firstSeen.has(key)) firstSeen.set(key, i) })
  const ordered = stableByRank(folded, (c) => {
    const lead = c.groupKey === IDENTITY_GROUP.key ? IDENTITY_LEAD.indexOf(c.key) : -1
    return firstSeen.get(c.groupKey ?? c.group)! * 10 + (lead < 0 ? IDENTITY_LEAD.length : lead)
  })
  const at = groups.findIndex((g) => FOLDED_INTO_IDENTITY.has(g.key))
  const kept: GroupableGroup[] = groups.filter((g) => !FOLDED_INTO_IDENTITY.has(g.key))
  if (at >= 0 || folded.some((c) => c.groupKey === IDENTITY_GROUP.key)) kept.splice(Math.max(at, 0), 0, { ...IDENTITY_GROUP, channelLabel: null, order: 0 })
  return { columns: ordered, groups: kept.map((g, i) => ({ ...g, order: i })) }
}

/* ── the one function ──────────────────────────────────────────────────────────────────────────────────────── */

function stableByRank<T>(items: readonly T[], rank: (item: T) => number): T[] {
  return items.map((item, index) => ({ item, index, r: rank(item) }))
    .sort((a, b) => a.r - b.r || a.index - b.index)
    .map(({ item }) => item)
}

/**
 * The sheet's columns in their flat-file groups and order, and the groups in display order, each with its colour.
 * eBay and Amazon are regrouped; every other scope keeps its groups and order, except that its identity groups become
 * one (`IDENTITY_GROUP`), and gains colours. Idempotent: a
 * column already in a flat-file group keeps it. Within a group the incoming order holds, except for the eBay fields
 * the flat file listed, which lead their group in the flat file's order.
 */
export function groupSheetColumns<C extends GroupableColumn, G extends GroupableGroup>(
  columns: readonly C[], groups: readonly G[], channel: string | null | undefined,
): { columns: C[]; groups: GroupableGroup[] } {
  const ch = (channel ?? '').toUpperCase()
  if (ch !== 'EBAY' && ch !== 'AMAZON') {
    const one = withOneIdentityGroup(columns, groups)
    const toned = one.columns.map((c) => ({ ...c, groupTone: c.groupTone ?? sheetGroupTone(c.groupKey, c.group) }))
    return { columns: toned, groups: one.groups.map((g) => ({ ...g, tone: g.tone ?? sheetGroupTone(g.key, g.label) })) }
  }
  const byGroupKey = new Map(groups.map((g) => [g.key, g]))
  const known = new Map<string, SheetGroupDef>()
  const fieldRank = new Map<string, number>()
  let assign: (c: C) => SheetGroupDef
  let order: (defs: SheetGroupDef[]) => SheetGroupDef[]

  if (ch === 'EBAY') {
    const fieldGroup = new Map<string, SheetGroupDef>()
    for (const [def, keys] of EBAY_FIELDS) keys.forEach((k, i) => { fieldGroup.set(k, def); fieldRank.set(`${def.key}|${k}`, i) })
    for (const def of EBAY_ORDER) known.set(def.key, def)
    assign = (c) => {
      if (c.groupKey && EBAY_SPECIFICS_KEYS.has(c.groupKey)) return EBAY.specifics
      return fieldGroup.get(c.slot?.of ?? c.key) ?? EBAY.listing
    }
    order = (defs) => stableByRank(defs, (d) => EBAY_ORDER.findIndex((e) => e.key === d.key))
  } else {
    AMAZON_IDENTITY_FIELDS.forEach((k, i) => fieldRank.set(`${AMAZON_OFFER_IDENTITY.key}|${k}`, i))
    AMAZON_VARIATION_FIELDS.forEach((k, i) => fieldRank.set(`${AMAZON_VARIATIONS.key}|${k}`, i))
    for (const def of [AMAZON_OFFER_IDENTITY, AMAZON_VARIATIONS, AMAZON_OTHER]) known.set(def.key, def)
    const position = new Map<string, number>()
    assign = (c) => {
      const k = c.slot?.of ?? c.key
      if (AMAZON_IDENTITY_FIELDS.includes(k) || c.groupKey === 'AMAZON:classification') return AMAZON_OFFER_IDENTITY
      if (AMAZON_VARIATION_FIELDS.some((v) => k === v || k.startsWith(`${v}__`)) || c.groupKey === 'AMAZON:variations') return AMAZON_VARIATIONS
      if (c.groupKey?.startsWith('AMAZON:')) {
        const source = byGroupKey.get(c.groupKey)
        const def = amazonTemplateGroup(source, c.groupKey.slice('AMAZON:'.length))
        position.set(def.key, source?.sourceOrder ?? source?.order ?? Number.MAX_SAFE_INTEGER)
        return def
      }
      return AMAZON_OTHER
    }
    order = (defs) => stableByRank(defs, (d) => d.key === AMAZON_OFFER_IDENTITY.key ? -2 : d.key === AMAZON_VARIATIONS.key ? -1
      : d.key === AMAZON_OTHER.key ? Number.MAX_SAFE_INTEGER : position.get(d.key) ?? Number.MAX_SAFE_INTEGER - 1)
  }

  const placed = columns.map((c) => {
    const def = isFlatFileGroupKey(c.groupKey) ? known.get(c.groupKey!) ?? { key: c.groupKey!, label: c.group, tone: c.groupTone ?? 'slate' } : assign(c)
    known.set(def.key, def)
    return { ...c, group: def.label, groupKey: def.key, groupTone: def.tone }
  })
  const used = order([...new Set(placed.map((c) => c.groupKey))].map((key) => known.get(key)!))
  const groupRank = new Map(used.map((d, i) => [d.key, i]))
  const ordered = stableByRank(placed, (c) => {
    // A field the flat file listed leads its group in the flat file's order; the rest keep the incoming order.
    const listed = fieldRank.get(`${c.groupKey}|${c.slot?.of ?? c.key}`)
    return groupRank.get(c.groupKey)! * 10_000 + (listed ?? 1_000)
  })
  return {
    columns: ordered,
    groups: used.map((d, i) => ({ key: d.key, label: d.label, channelLabel: null, order: i, tone: d.tone })),
  }
}
