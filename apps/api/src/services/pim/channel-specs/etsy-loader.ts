import prisma from '../../../db.js'
import { etsyProductSpec, etsyTaxonomySpec, type EtsyTaxonomyProperty } from './etsy.js'
import type { ChannelSpec } from './types.js'

/** Reject truncated/malformed definitions; zero properties is valid only with a complete results array. */
export function readEtsyProperties(value: unknown): EtsyTaxonomyProperty[] {
  const body = value as { count?: unknown; results?: unknown[] } | null
  if (!body || !Array.isArray(body.results) || body.count !== body.results.length) throw new Error('Etsy returned an incomplete category definition.')
  const ids = new Set<number>()
  for (const raw of body.results) {
    const p = raw as EtsyTaxonomyProperty
    if (!p || !Number.isSafeInteger(p.property_id) || p.property_id < 1 || ids.has(p.property_id)
      || typeof p.name !== 'string' || typeof p.display_name !== 'string'
      || !['is_required', 'supports_attributes', 'supports_variations', 'is_multivalued'].every(k => typeof p[k] === 'boolean')
      || !(p.max_values_allowed === null || Number.isSafeInteger(p.max_values_allowed) && p.max_values_allowed >= 0)
      || !Array.isArray(p.scales) || !Array.isArray(p.possible_values) || !Array.isArray(p.selected_values)
      || ![...p.possible_values, ...p.selected_values].every(v => v && typeof v.name === 'string' && (v.value_id === null || Number.isSafeInteger(v.value_id) && v.value_id > 0))
      || !p.scales.every(s => s && Number.isSafeInteger(s.scale_id) && s.scale_id > 0 && typeof s.display_name === 'string')) throw new Error('Etsy returned an invalid category property.')
    ids.add(p.property_id)
  }
  return body.results as EtsyTaxonomyProperty[]
}

/** Cached taxonomy only: opening a sheet never waits for Etsy or guesses a neighbouring category. */
export async function loadEtsyTaxonomySpec(category: string): Promise<ChannelSpec> {
  if (!/^[1-9]\d*$/.test(category)) throw new Error('An Etsy seller taxonomy category ID is required.')
  const row = await prisma.categorySchema.findFirst({
    where: { channel: 'ETSY', marketplace: 'GLOBAL', productType: category, isActive: true },
    orderBy: [{ fetchedAt: 'desc' }, { id: 'asc' }],
    select: { schemaDefinition: true, fetchedAt: true, schemaVersion: true },
  })
  if (!row) return { ...etsyTaxonomySpec(category, []), absent: true }
  return { ...etsyTaxonomySpec(category, readEtsyProperties(row.schemaDefinition), row.fetchedAt), schemaVersion: row.schemaVersion }
}

/** The mapping catalogue sees the identical native fields and selected category contract. */
export async function loadEtsyProductSpec(category?: string | null, locale?: string): Promise<ChannelSpec> {
  const native = etsyProductSpec(locale)
  if (!category) return native
  const taxonomy = await loadEtsyTaxonomySpec(category)
  return { ...taxonomy, fields: [...native.fields, ...taxonomy.fields], groups: [...native.groups, ...taxonomy.groups],
    coverage: { ...native.coverage, ...taxonomy.coverage },
    validationSchema: { type: 'object', properties: { ...(native.validationSchema?.properties as object), ...(taxonomy.validationSchema?.properties as object) },
      required: [...native.validationSchema?.required as string[], ...taxonomy.validationSchema?.required as string[]], allOf: taxonomy.validationSchema?.allOf ?? [] } }
}
