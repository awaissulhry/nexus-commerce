/**
 * FX.3 — smart column-mapping for external-file import into the Amazon
 * flat-file grid.
 *
 * Given the raw headers of an uploaded external file (from the FX.2 /parse
 * endpoint) and the live flat-file column catalog (the manifest — per market +
 * product type, MT-union aware), suggest the best flat-file column for each
 * header, with a confidence + source + reason, so the FX.5 wizard can show what
 * matched and let the operator override before applying.
 *
 * Mirrors the proven W8.2 import column-mapping strategy
 * (apps/api/src/services/import/column-mapping.ts) — exact-id → exact-label →
 * normalized → alias — but is flat-file-tailored:
 *   • matches BOTH the English and the localized (Italian) column label,
 *   • uses an Amazon-specific alias map (supplier conventions → Amazon column ids),
 *   • reports confidence + source per header so low-confidence guesses get flagged.
 * Tiers run as order-independent passes so the highest-confidence match claims a
 * column first regardless of header order. Pure: no DB.
 */

export interface FlatFileMappableColumn {
  id: string
  labelEn?: string
  labelLocal?: string
  /** Amazon attribute path (manifest `fieldRef`) — powers the template-path tier. */
  fieldRef?: string
}

export type MappingSource = 'template-path' | 'template-alias' | 'exact-id' | 'exact-label' | 'normalized' | 'alias' | 'none'

export interface HeaderMapping {
  /** The external file's header (verbatim). */
  header: string
  /** The flat-file column id it maps to, or null when nothing matched. */
  columnId: string | null
  /** 0..1 — 1 = exact id, down to 0 = unmatched. */
  confidence: number
  source: MappingSource
  reason: string
}

export interface FlatFileMappingResult {
  /** One entry per header, in header order. */
  mappings: HeaderMapping[]
  /** Headers that matched nothing — the operator wires these up manually. */
  unmappedHeaders: string[]
  /** Flat-file column ids that received no header — "your file is missing these". */
  unmappedColumns: string[]
}

const CONFIDENCE: Record<Exclude<MappingSource, 'none'>, number> = {
  'template-path': 1,
  'template-alias': 0.85,
  'exact-id': 1,
  'exact-label': 0.95,
  'normalized': 0.85,
  'alias': 0.7,
}

/**
 * A3 (XLSM hybrid) — canonicalize an Amazon listings attribute path so a
 * template header and a manifest fieldRef compare equal:
 *   • `[qualifier…]` blocks are dropped — the template carries concrete values
 *     (`[marketplace_id=APJ6JRA9NG5V4]`, `[language_tag=it_IT]`, `[audience=ALL]`)
 *     while fieldRefs carry empty names (`[marketplace_id]`) or omit them.
 *   • the FIRST path segment keeps its `#N` instance index (that is what tells
 *     `bullet_point#2` from `bullet_point#1`); later segments drop a redundant
 *     `#1` — the template repeats `#1` at every array level
 *     (`our_price#1.schedule#1.value_with_tax`), fieldRefs do not.
 *
 *   purchasable_offer[…][audience=ALL]#1.our_price#1.schedule#1.value_with_tax
 *     → purchasable_offer#1.our_price.schedule.value_with_tax
 *   item_name[marketplace_id=…][language_tag=…]#1.value → item_name#1.value
 *   color[…][…]#1.standardized_values#1 → color#1.standardized_values
 */
export function canonicalizeTemplatePath(path: string): string {
  const stripped = path.replace(/\[[^\]]*\]/g, '')
  return stripped
    .split('.')
    .map((seg, i) => (i === 0 ? seg : seg.replace(/#1$/, '')))
    .join('.')
}

/**
 * Offer-level template attributes bridged onto their product-level manifest
 * columns when the schema exposes only the latter. Amazon's v2 templates
 * manage catalog images through `*_offer_image_locator` columns; the grid's
 * image columns are the `*_product_image_locator` family.
 */
const TEMPLATE_PATH_ALIASES: Record<string, string[]> = {
  'main_offer_image_locator#1.media_location': ['main_product_image_locator#1.media_location'],
}
for (let i = 1; i <= 8; i++) {
  TEMPLATE_PATH_ALIASES[`other_offer_image_locator_${i}#1.media_location`] = [
    `other_product_image_locator_${i}#1.media_location`,
  ]
}

/** Cheap gate so plain external headers ("Price") never enter the template tier. */
function looksLikeTemplatePath(header: string): boolean {
  return header.startsWith('::') || header.includes('[') || /#\d+/.test(header)
}

/**
 * Common external→Amazon column-id conventions. Each concept lists candidate
 * column ids most→least likely; only a candidate that actually EXISTS in the
 * current manifest is used, so a stale alias simply doesn't match. That keeps
 * the map safe across the schema variation between marketplaces + product types
 * (the identifier/price column id differs by schema).
 */
const AMAZON_ALIAS_MAP: Record<string, string[]> = {
  sku: ['item_sku', 'contribution_sku'],
  sellersku: ['item_sku', 'contribution_sku'],
  productid: ['item_sku'],
  title: ['item_name'],
  name: ['item_name'],
  productname: ['item_name'],
  itemtitle: ['item_name'],
  description: ['product_description'],
  productdescription: ['product_description'],
  ean: ['externally_assigned_product_identifier', 'external_product_id'],
  upc: ['externally_assigned_product_identifier', 'external_product_id'],
  gtin: ['externally_assigned_product_identifier', 'external_product_id'],
  barcode: ['externally_assigned_product_identifier', 'external_product_id'],
  brand: ['brand_name', 'brand'],
  manufacturer: ['manufacturer'],
  vendor: ['brand_name', 'brand'],
  price: ['standard_price', 'list_price', 'your_price'],
  rrp: ['list_price'],
  msrp: ['list_price'],
  saleprice: ['sale_price'],
  qty: ['quantity'],
  quantity: ['quantity'],
  stock: ['quantity'],
  color: ['color_name', 'color'],
  colour: ['color_name', 'color'],
  size: ['size_name', 'size'],
  material: ['outer_material_type', 'material', 'material_type'],
  image: ['main_image_url', 'main_product_image_locator'],
  imageurl: ['main_image_url', 'main_product_image_locator'],
  mainimage: ['main_image_url', 'main_product_image_locator'],
  keywords: ['generic_keywords', 'search_terms'],
  // ── Structural / variation columns ──────────────────────────────────────
  // Amazon's own downloaded flat-file templates use "parentage" (not
  // "parentage_level"), so tier-3 normalized matching misses them.
  parentage: ['parentage_level'],
  // "parent-sku" / "parent sku" / "parent_sku" all normalize to "parentsku"
  // which matches the column id via tier 3, but the Amazon column name
  // "child_parent_sku_relationship" does not — add both directions.
  childparentskurelationship: ['child_parent_sku_relationship', 'parent_sku'],
  parentitemsku: ['parent_sku', 'child_parent_sku_relationship'],
  // "variation_theme" already matches via tier 3, but supplier files often
  // write it as "variation type" or "variant type".
  variationtype: ['variation_theme'],
  varianttype: ['variation_theme'],
}

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export function suggestFlatFileMapping(
  headers: string[],
  columns: FlatFileMappableColumn[],
): FlatFileMappingResult {
  // Build column lookups once. First-insert wins on collisions.
  const byId = new Map<string, FlatFileMappableColumn>()
  const byLabel = new Map<string, FlatFileMappableColumn>()
  const byNorm = new Map<string, FlatFileMappableColumn>()
  for (const c of columns) {
    const idl = c.id.toLowerCase()
    if (!byId.has(idl)) byId.set(idl, c)
    for (const lab of [c.labelEn, c.labelLocal]) {
      if (lab && lab.trim() && !byLabel.has(lab.toLowerCase())) byLabel.set(lab.toLowerCase(), c)
    }
    for (const key of [c.id, c.labelEn, c.labelLocal]) {
      const n = key ? norm(key) : ''
      if (n && !byNorm.has(n)) byNorm.set(n, c)
    }
  }

  const claimed = new Set<string>()
  const result = new Map<string, HeaderMapping>()
  const assign = (header: string, col: FlatFileMappableColumn, source: Exclude<MappingSource, 'none'>, reason: string) => {
    claimed.add(col.id)
    result.set(header, { header, columnId: col.id, confidence: CONFIDENCE[source], source, reason })
  }

  // Tier 0 — Amazon-template attribute paths (A3, XLSM hybrid). The official
  // templates' attr row and the manifest's fieldRefs derive from the same
  // SP-API listings schema, so after canonicalization they match exactly —
  // deterministic, not fuzzy. Runs first so a 344-column template claims its
  // columns before any label heuristics can steal one.
  const byTemplatePath = new Map<string, FlatFileMappableColumn>()
  for (const c of columns) {
    if (!c.fieldRef) continue
    const key = canonicalizeTemplatePath(c.fieldRef)
    if (key && !byTemplatePath.has(key)) byTemplatePath.set(key, c)
  }
  if (byTemplatePath.size > 0) {
    for (const h of headers) {
      if (result.has(h) || !looksLikeTemplatePath(h)) continue
      const key = canonicalizeTemplatePath(h)
      const direct = byTemplatePath.get(key)
      if (direct && !claimed.has(direct.id)) {
        assign(h, direct, 'template-path', `Amazon template attribute "${key}" is column "${direct.id}"`)
        continue
      }
      for (const aliasKey of TEMPLATE_PATH_ALIASES[key] ?? []) {
        const bridged = byTemplatePath.get(aliasKey)
        if (bridged && !claimed.has(bridged.id)) {
          assign(h, bridged, 'template-alias', `Offer-level template attribute "${key}" bridged to "${bridged.id}"`)
          break
        }
      }
    }
  }

  // Tier 1 — exact column id.
  for (const h of headers) {
    if (result.has(h)) continue
    const c = byId.get(h.toLowerCase())
    if (c && !claimed.has(c.id)) assign(h, c, 'exact-id', `Header matches column id "${c.id}"`)
  }
  // Tier 2 — exact label (English or localized).
  for (const h of headers) {
    if (result.has(h)) continue
    const c = byLabel.get(h.toLowerCase())
    if (c && !claimed.has(c.id)) assign(h, c, 'exact-label', `Header matches the column's label`)
  }
  // Tier 3 — normalized (case/space/punctuation-insensitive) on id or label.
  for (const h of headers) {
    if (result.has(h)) continue
    const c = byNorm.get(norm(h))
    if (c && !claimed.has(c.id)) assign(h, c, 'normalized', `Header normalizes to column "${c.id}"`)
  }
  // Tier 4 — Amazon alias conventions (only when the target column exists).
  for (const h of headers) {
    if (result.has(h)) continue
    for (const candId of AMAZON_ALIAS_MAP[norm(h)] ?? []) {
      const c = byId.get(candId.toLowerCase())
      if (c && !claimed.has(c.id)) {
        assign(h, c, 'alias', `"${h}" is a known alias for "${c.id}"`)
        break
      }
    }
  }

  const mappings: HeaderMapping[] = headers.map(
    (h) => result.get(h) ?? { header: h, columnId: null, confidence: 0, source: 'none', reason: 'No confident match — map manually' },
  )
  return {
    mappings,
    unmappedHeaders: mappings.filter((m) => !m.columnId).map((m) => m.header),
    unmappedColumns: columns.filter((c) => !claimed.has(c.id)).map((c) => c.id),
  }
}
