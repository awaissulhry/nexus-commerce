/**
 * FM.13 — mapping suggestions.
 *
 * For every UNMAPPED channel-schema field, suggest a master `source` path
 * by matching the field key/label against a catalog of canonical master
 * attributes + their common channel aliases. Heuristic (no AI call) — fast,
 * deterministic, and good enough to seed the bulk of a mapping; the
 * operator reviews the catalog impact before activating a proposal.
 * This service is read-only; AI suggestions use the same source inventory.
 */

import { getFieldCatalogue } from './mapping/field-catalogue.service.js'
import { getMappingSources } from './mapping/mapping-sources.service.js'

export type SuggestConfidence = 'high' | 'medium'

interface SuggestCandidate {
  source: string
  label: string
  aliases: string[]
}

// Canonical master attributes ↔ the channel field names that usually map
// to them (Amazon flat-file, eBay aspects, Shopify metafields).
const CANDIDATES: SuggestCandidate[] = [
  { source: 'title', label: 'Master title', aliases: ['title', 'item_name', 'name', 'product_name', 'product_title'] },
  { source: 'description', label: 'Master description', aliases: ['description', 'product_description', 'desc', 'long_description', 'body_html'] },
  { source: 'brand', label: 'Brand', aliases: ['brand', 'brand_name', 'manufacturer_brand', 'vendor'] },
  { source: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer', 'maker'] },
  { source: 'basePrice', label: 'Price', aliases: ['price', 'our_price', 'standard_price'] },
  { source: 'categoryAttributes.material', label: 'Material', aliases: ['material', 'material_type'] },
  { source: 'categoryAttributes.color', label: 'Color', aliases: ['color', 'color_name', 'colour', 'color_map'] },
  { source: 'categoryAttributes.size', label: 'Size', aliases: ['size', 'size_name', 'apparel_size', 'size_map'] },
  { source: 'bulletPoints', label: 'Bullet points', aliases: ['bullet_point', 'bullet_points', 'feature_bullets', 'key_features'] },
  { source: 'keywords', label: 'Keywords', aliases: ['generic_keyword', 'keywords', 'search_terms', 'search_keywords'] },
  { source: 'ean', label: 'EAN', aliases: ['ean', 'ean13', 'barcode'] },
  { source: 'upc', label: 'UPC', aliases: ['upc'] },
  { source: 'gtin', label: 'GTIN', aliases: ['gtin', 'gtin13', 'externally_assigned_product_identifier'] },
]

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

export interface FieldSuggestion {
  source: string
  confidence: SuggestConfidence
  reason: string
}

/**
 * Suggest a master source for one channel field. Exact (normalized) alias
 * match → high; otherwise null. Substrings confuse prices with sale dates and
 * manufacturer names with contact details. Pure.
 */
export function suggestSourceForField(fieldKey: string, label?: string | null): FieldSuggestion | null {
  const fk = norm(fieldKey)
  const lbl = label ? norm(label) : ''
  if (!fk) return null

  // Pass 1 — exact normalized match (key or label) against an alias.
  for (const c of CANDIDATES) {
    for (const a of c.aliases) {
      const na = norm(a)
      if (fk === na || (lbl && lbl === na)) {
        return { source: c.source, confidence: 'high', reason: `matches "${a}"` }
      }
    }
  }
  return null
}

export interface MappingSuggestion {
  fieldKey: string
  label: string | null
  suggestedSource: string
  confidence: SuggestConfidence
  reason: string
  /** BM.6 — whether the channel marks this field required (governance). */
  required?: boolean
}

/** Match against actual source definitions/observed Master paths. No invented destinations or sources. */
export function suggestKnownSource(fieldKey: string, label: string | null, available: ReadonlySet<string>): FieldSuggestion | null {
  if (!norm(fieldKey) || ['productType', 'categoryId', 'category_id'].includes(fieldKey)) return null
  const direct = [...available].filter(path => !path.includes('.') && norm(path) === norm(fieldKey))
  if (direct.length === 1) return { source: direct[0], confidence: 'high', reason: 'Matches an existing Master attribute code' }
  const heuristic = suggestSourceForField(fieldKey, label)
  if (!heuristic) return null
  if (available.has(heuristic.source)) return heuristic
  const short = heuristic.source.replace(/^categoryAttributes\./, '')
  return available.has(short) ? { ...heuristic, source: short } : null
}

export async function mappingSuggestionContext(input: { channel: string; code: string; productType?: string | null; productId?: string }) {
  const [catalogue, sourceCatalogue] = await Promise.all([
    getFieldCatalogue({ channel: input.channel, marketplace: input.code, productType: input.productType }),
    getMappingSources({ marketplace: input.code, productId: input.productId }),
  ])
  return { catalogue, available: new Set(sourceCatalogue.sources.map(s => s.path)) }
}

export async function suggestMappings(input: {
  channel: string; code: string; productType?: string | null; productId?: string
}) {
  const { catalogue, available } = await mappingSuggestionContext(input)
  const unmapped = catalogue.fields.filter(f => f.status === 'unmapped' && f.schemaKnown !== false)
  const suggestions: MappingSuggestion[] = []
  for (const field of unmapped) {
    const suggestion = suggestKnownSource(field.fieldKey, field.label, available)
    if (suggestion) suggestions.push({ fieldKey: field.fieldKey, label: field.label,
      suggestedSource: suggestion.source, confidence: suggestion.confidence, reason: suggestion.reason,
      required: field.priority === 'required' })
  }
  return { channel: catalogue.channel, code: input.code, productType: catalogue.productType,
    suggestions, unmappedTotal: unmapped.length }
}
