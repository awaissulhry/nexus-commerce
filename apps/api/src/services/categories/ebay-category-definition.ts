/**
 * The cached eBay category definition (`CategorySchema.schemaDefinition` for channel EBAY): one category's item
 * specifics and the conditions it allows, from eBay's Taxonomy and Metadata answers (`EbayCategoryService`).
 *
 * ONE builder for two readers: the writer behind "Load eBay fields" (`CategorySchemaService.fetchAndCacheEbay`) stores
 * it, and the `ebay-categories` tool shows it for a category Nexus has not loaded yet, without storing anything. So what
 * Claude reads live is what a person's load would store. Pure: no database, no channel call.
 *
 * 🔴 The key order of each entry is part of the stored row's `schemaVersion` (a hash of this JSON): change it and every
 * cached eBay category reads as a new version (change log, readiness rebuild).
 */
import { optionModeFrom } from '@nexus/shared/attributes'
import { toInventoryCondition } from '../ebay-condition.js'
import type { EbayAspectRich, EbayConditionPolicy } from '../ebay-category.service.js'

export function ebayCategoryDefinition(aspects: EbayAspectRich[], conditions: EbayConditionPolicy[]) {
  return {
    aspects: aspects.map(a => ({
      id: `aspect_${a.englishName ?? a.name}`, label: a.name, localizedName: a.name,
      englishName: a.englishName, dataType: a.dataType,
      kind: a.values.length ? 'enum' : a.dataType === 'NUMBER' ? 'number' : a.dataType === 'DATE' ? 'date' : 'text',
      options: a.values, enumMode: optionModeFrom(a.mode) ?? 'open',
      required: a.required, recommended: a.usage === 'RECOMMENDED',
      cardinality: a.cardinality, variantEligible: a.variantEligible, maxLength: a.maxLength,
      // W3-5 — eBay's approximate "required from" date, stored only when eBay sends one: an aspect without it keeps
      // the old JSON, so the schema hash (and its change log / readiness rebuild) does not move for those categories.
      ...(a.expectedRequiredByDate ? { expectedRequiredByDate: a.expectedRequiredByDate } : {}),
    })),
    conditions: conditions.map(c => ({ value: toInventoryCondition(c.conditionId), label: c.conditionDescription })),
  }
}
