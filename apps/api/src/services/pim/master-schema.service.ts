/**
 * MA.1 — Master attribute schema resolver.
 *
 * The Master tab's "Technical Attributes" is a free key/value bag — the
 * operator has to invent both key and value, so nobody fills it and the
 * mapping engine has nothing to map FROM. This computes the attribute set a
 * master SHOULD hold for its productType, so the Master tab can render typed,
 * required-aware fields instead of a blank bag.
 *
 * Source of truth (reused, not rebuilt):
 *  - `field-registry.getAvailableFields` already unfolds the cached Amazon
 *    CategorySchema into typed `attr_*` FieldDefinitions (type/options/
 *    required) + the hardcoded per-type fallback.
 *  - PLUS the distinct `categoryAttributes.*` sources the product's mapping
 *    rules already reference — so the master surfaces exactly what the
 *    channels read, even for attrs not in the Amazon schema.
 *
 * The master key is the `categoryAttributes` key (the `attr_` prefix stripped)
 * — i.e. what `attribute-resolver` reads and `PATCH /global`'s mergeTechnical
 * writes.
 */

import prisma from '../../db.js'
import { getAvailableFields, type FieldDefinition } from './field-registry.service.js'
import { getResolvedRules } from './schema-mapping.service.js'

export interface MasterAttribute {
  /** categoryAttributes key (e.g. 'material_type') — the master path is
   *  `categoryAttributes.<key>`. */
  key: string
  label: string
  type: 'text' | 'number' | 'select' | 'boolean'
  required: boolean
  allowedValues?: string[]
  /** VL.1 — wire value → English display label, for enum/select attributes
   *  (Amazon enum wire is canonical; this is the operator-facing English). */
  optionLabels?: Record<string, string>
  group: string
  helpText?: string
  /** 'schema' = from the channel/category schema; 'mapping' = surfaced
   *  because a mapping rule reads it. */
  source: 'schema' | 'mapping'
}

function humanize(s: string): string {
  return s
    .split(/[_.]+/)
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(' ')
}

// Amazon's schema includes plumbing that is NOT a product attribute the master
// should hold: content (handled by the locale section), identity (identity
// card), and offer/fulfillment/variation/envelope keys. Exclude them so the
// master schema only surfaces genuine product attributes (material, color,
// size, care, armor, …). Content keys still import as content via MA.7's
// FLATFILE_CONTENT map.
const NON_ATTRIBUTE_KEYS = new Set([
  // content → locale/content section
  'item_name', 'product_description', 'bullet_point', 'generic_keyword',
  // identity → identity card
  'brand', 'manufacturer',
  'externally_assigned_product_identifier', 'supplier_declared_has_product_identifier_exemption', 'merchant_suggested_asin',
  // offer / price / fulfillment plumbing
  'purchasable_offer', 'list_price', 'condition_type', 'condition_note',
  'fulfillment_availability', 'merchant_shipping_group', 'max_order_quantity', 'main_offer_image_locator',
  // variation / browse / envelope plumbing
  'parentage_level', 'child_parent_sku_relationship', 'variation_theme', 'skip_offer',
  'recommended_browse_nodes', 'browse_node', 'item_type_keyword', 'product_tax_code',
])

/** Pure: fold the registry's category FieldDefinitions + the mapping-rule
 *  `categoryAttributes.*` sources into the master attribute schema. Schema
 *  wins on key collision; required-first then alpha. Exposed for tests. */
export function buildMasterAttributes(categoryFields: FieldDefinition[], ruleSources: string[]): MasterAttribute[] {
  const byKey = new Map<string, MasterAttribute>()
  for (const f of categoryFields) {
    const key = f.id.startsWith('attr_') ? f.id.slice(5) : f.id
    if (!key || NON_ATTRIBUTE_KEYS.has(key) || byKey.has(key)) continue
    const type: MasterAttribute['type'] =
      f.type === 'number' ? 'number' : f.type === 'select' ? 'select' : f.type === 'boolean' ? 'boolean' : 'text'
    byKey.set(key, {
      key,
      // Operators read English only — label from the (English) attribute key,
      // NOT the marketplace-localized schema title (IT/DE/ES/FR come back
      // translated, e.g. "Marca"/"Materiale"). The dropped helpText was the
      // same localized Amazon description.
      label: humanize(key),
      type,
      required: !!f.required,
      allowedValues: f.options && f.options.length > 0 ? f.options : undefined,
      group: 'Category attributes',
      source: 'schema',
    })
  }
  for (const src of ruleSources) {
    if (typeof src !== 'string' || !src.startsWith('categoryAttributes.')) continue
    const key = src.slice('categoryAttributes.'.length)
    if (!key || NON_ATTRIBUTE_KEYS.has(key) || byKey.has(key)) continue
    byKey.set(key, { key, label: humanize(key), type: 'text', required: false, group: 'Mapped attributes', source: 'mapping' })
  }
  return [...byKey.values()].sort(
    (a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label),
  )
}

export async function getMasterAttributeSchema(productId: string): Promise<{
  productId: string
  productType: string | null
  attributes: MasterAttribute[]
  /** Amazon plumbing keys that may sit in categoryAttributes but are NOT
   *  product attributes — the editor hides them from "Custom attributes". */
  hiddenKeys: string[]
}> {
  const product = await prisma.product.findUnique({
    where: { id: productId },
    select: {
      id: true,
      productType: true,
      channelListings: { select: { channel: true, marketplace: true } },
    },
  })
  if (!product) throw new Error(`Product ${productId} not found`)
  const productType = product.productType ?? null
  const amazonMarkets = [
    ...new Set(
      product.channelListings
        .filter((l) => l.channel === 'AMAZON' && l.marketplace)
        .map((l) => l.marketplace as string),
    ),
  ]

  // Category fields from the registry (Amazon dynamic schema across the
  // product's Amazon markets, de-duped; hardcoded fallback merges in).
  const categoryFields: FieldDefinition[] = []
  if (productType) {
    const markets: (string | null)[] = amazonMarkets.length > 0 ? amazonMarkets : [null]
    const seen = new Set<string>()
    for (const mkt of markets) {
      const fields = await getAvailableFields({
        productTypes: [productType],
        channels: ['AMAZON'],
        marketplace: mkt ?? undefined,
      })
      for (const f of fields) {
        if (f.category !== 'category' || seen.has(f.id)) continue
        seen.add(f.id)
        categoryFields.push(f)
      }
    }
  }

  // Mapping rule sources (categoryAttributes.*) across the product's coordinates.
  const ruleSources: string[] = []
  const coords = [
    ...new Set(product.channelListings.filter((l) => l.marketplace).map((l) => `${l.channel}:${l.marketplace}`)),
  ]
  for (const c of coords) {
    const [channel, marketplace] = c.split(':')
    try {
      const rules = await getResolvedRules(channel, marketplace, productType)
      for (const r of Object.values(rules)) {
        if (r && typeof r.source === 'string') ruleSources.push(r.source)
      }
    } catch {
      /* coordinate may have no Marketplace row — skip */
    }
  }

  const attributes = buildMasterAttributes(categoryFields, ruleSources)

  // VL.1 — attach English option labels to enum attributes. Amazon enum WIRE
  // values are canonical across markets; the en_US enumNames give the
  // operator-facing English label. Best-effort (SP-API may be unavailable →
  // the UI falls back to the wire value).
  const market = amazonMarkets[0]
  if (productType && market && attributes.some((a) => a.allowedValues && a.allowedValues.length > 0)) {
    try {
      const { AmazonService } = await import('../marketplaces/amazon.service.js')
      const { CategorySchemaService } = await import('../categories/schema-sync.service.js')
      const svc = new CategorySchemaService(prisma as any, new AmazonService())
      const labels = await svc.getEnglishEnumLabels(market, productType)
      for (const a of attributes) {
        const m = labels[a.key]
        if (m && a.allowedValues && a.allowedValues.length > 0) a.optionLabels = m
      }
    } catch {
      /* graceful — UI falls back to the wire value */
    }
  }

  return {
    productId: product.id,
    productType,
    attributes,
    hiddenKeys: [...NON_ATTRIBUTE_KEYS],
  }
}
