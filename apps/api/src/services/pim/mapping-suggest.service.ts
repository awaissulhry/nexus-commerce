/**
 * FM.13 — mapping suggestions.
 *
 * For every UNMAPPED channel-schema field, suggest a master `source` path
 * by matching the field key/label against a catalog of canonical master
 * attributes + their common channel aliases. Heuristic (no AI call) — fast,
 * deterministic, and good enough to seed the bulk of a mapping; the
 * operator reviews + applies via the existing PUT. (An AI re-rank can layer
 * on later for the long tail.) Read-only.
 */

import prisma from '../../db.js'
import { getResolvedRules } from './schema-mapping.service.js'

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
  { source: 'manufacturer', label: 'Manufacturer', aliases: ['manufacturer', 'maker', 'supplier'] },
  { source: 'our_price', label: 'Price', aliases: ['price', 'our_price', 'standard_price', 'list_price'] },
  { source: 'categoryAttributes.material', label: 'Material', aliases: ['material', 'material_type', 'fabric', 'fabric_type', 'outer_material', 'material_composition'] },
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
 * match → high; substring containment → medium; otherwise null. Pure.
 */
export function suggestSourceForField(fieldKey: string, label?: string | null): FieldSuggestion | null {
  const fk = norm(fieldKey)
  const lbl = label ? norm(label) : ''

  // Pass 1 — exact normalized match (key or label) against an alias.
  for (const c of CANDIDATES) {
    for (const a of c.aliases) {
      const na = norm(a)
      if (fk === na || (lbl && lbl === na)) {
        return { source: c.source, confidence: 'high', reason: `matches "${a}"` }
      }
    }
  }
  // Pass 2 — substring containment (≥5 chars to avoid spurious hits like
  // "name" matching "color_name").
  for (const c of CANDIDATES) {
    for (const a of c.aliases) {
      const na = norm(a)
      if (na.length < 5) continue
      if (fk.includes(na) || na.includes(fk) || (lbl && (lbl.includes(na) || na.includes(lbl)))) {
        return { source: c.source, confidence: 'medium', reason: `partial match "${a}"` }
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

/** Suggest sources for every UNMAPPED field on a (channel, marketplace) for
 *  the given productType overlay. */
export async function suggestMappings(input: {
  channel: string
  code: string
  productType?: string | null
}): Promise<{ channel: string; code: string; productType: string | null; suggestions: MappingSuggestion[]; unmappedTotal: number }> {
  const rules = await getResolvedRules(input.channel, input.code, input.productType)
  const fields = await prisma.channelSchema.findMany({
    where: { channel: input.channel, OR: [{ marketplace: input.code }, { marketplace: null }] },
    orderBy: { fieldKey: 'asc' },
    select: { fieldKey: true, label: true, required: true },
  })

  const suggestions: MappingSuggestion[] = []
  let unmappedTotal = 0
  for (const f of fields) {
    if (rules[f.fieldKey]) continue // already mapped
    unmappedTotal++
    const s = suggestSourceForField(f.fieldKey, f.label)
    if (s) {
      suggestions.push({
        fieldKey: f.fieldKey,
        label: f.label,
        suggestedSource: s.source,
        confidence: s.confidence,
        reason: s.reason,
        required: f.required,
      })
    }
  }

  return {
    channel: input.channel,
    code: input.code,
    productType: input.productType ?? null,
    suggestions,
    unmappedTotal,
  }
}
