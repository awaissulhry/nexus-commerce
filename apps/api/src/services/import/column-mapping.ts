/**
 * W8.2 — Column-mapping resolver.
 *
 * Auto-suggests a `field → header` mapping by matching the source
 * file's headers against the target entity's known fields. The
 * operator can override every suggestion before applying.
 *
 * Matching strategy (in priority order):
 *   1. exact case-insensitive match on field id ('basePrice')
 *   2. exact case-insensitive match on field label ('Base Price')
 *   3. normalised match (strip non-alphanum, lower) — catches
 *      'Base_Price', 'BASE PRICE', 'baseprice'
 *   4. alias match against a small ALIAS_MAP — covers operator
 *      conventions ('Price' → basePrice, 'Title' → name, …)
 *
 * Pure module: no DB. The route layer feeds in the headers + a
 * field catalogue and gets the suggested mapping back.
 */

export interface FieldDef {
  id: string
  label: string
}

const ALIAS_MAP: Record<string, string> = {
  // catalogue conventions Awa hits in supplier sheets
  price: 'basePrice',
  msrp: 'maxPrice',
  cost: 'costPrice',
  qty: 'totalStock',
  quantity: 'totalStock',
  stock: 'totalStock',
  inventory: 'totalStock',
  title: 'name',
  productname: 'name',
  product: 'name',
  itemname: 'name',
  desc: 'description',
  productdescription: 'description',
  ean: 'ean',
  upc: 'upc',
  asin: 'amazonAsin',
  vendor: 'brand',
  manufacturer: 'manufacturer',
  hs: 'hsCode',
  origin: 'countryOfOrigin',
  reorderpoint: 'lowStockThreshold',
}

function normalise(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface SuggestionResult {
  /** field-id → header (the operator-facing direction). */
  mapping: Record<string, string>
  /** Headers that didn't auto-match anything — surfaced in the UI
   *  so the operator can manually wire them up. */
  unmappedHeaders: string[]
  /** Fields that didn't get a header — the UI uses this to hint
   *  "your spreadsheet is missing this column". */
  unmappedFields: string[]
}

export function suggestMapping(
  headers: string[],
  fields: FieldDef[],
): SuggestionResult {
  const mapping: Record<string, string> = {}
  const usedHeaders = new Set<string>()

  // Build lookup maps over the available headers once.
  const byExactId = new Map<string, string>()
  const byExactLabel = new Map<string, string>()
  const byNormalised = new Map<string, string>()
  for (const h of headers) {
    const lower = h.toLowerCase()
    if (!byExactId.has(lower)) byExactId.set(lower, h)
    if (!byExactLabel.has(lower)) byExactLabel.set(lower, h)
    const n = normalise(h)
    if (!byNormalised.has(n)) byNormalised.set(n, h)
  }

  for (const field of fields) {
    const idLower = field.id.toLowerCase()
    const labelLower = field.label.toLowerCase()
    const idNorm = normalise(field.id)
    const labelNorm = normalise(field.label)

    let match: string | undefined =
      byExactId.get(idLower) ??
      byExactLabel.get(labelLower) ??
      byNormalised.get(idNorm) ??
      byNormalised.get(labelNorm)

    // Alias check — walk every header normalised and see if the
    // alias map points to this field id.
    if (!match) {
      for (const h of headers) {
        if (usedHeaders.has(h)) continue
        const aliasTarget = ALIAS_MAP[normalise(h)]
        if (aliasTarget === field.id) {
          match = h
          break
        }
      }
    }

    if (match && !usedHeaders.has(match)) {
      mapping[field.id] = match
      usedHeaders.add(match)
    }
  }

  return {
    mapping,
    unmappedHeaders: headers.filter((h) => !usedHeaders.has(h)),
    unmappedFields: fields
      .filter((f) => !mapping[f.id])
      .map((f) => f.id),
  }
}

/**
 * Apply a finalised mapping to a raw row. Returns a {field-id →
 * value} bag the import service can hand to writeRow. Unmapped
 * headers drop out; unmapped fields are absent from the result
 * (writeRow's empty-value short-circuit treats them as no-op).
 */
export function applyMapping(
  row: Record<string, unknown>,
  mapping: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [fieldId, header] of Object.entries(mapping)) {
    if (!header) continue
    if (header in row) out[fieldId] = row[header]
  }
  return out
}
