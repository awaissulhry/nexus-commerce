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
}

export type MappingSource = 'exact-id' | 'exact-label' | 'normalized' | 'alias' | 'none'

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
  'exact-id': 1,
  'exact-label': 0.95,
  'normalized': 0.85,
  'alias': 0.7,
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
