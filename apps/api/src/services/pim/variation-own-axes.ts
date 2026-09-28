/**
 * Sheet pop-up P3 (PLAN §10, the Owner 2026-09-28) — the VALUES of a channel-only axis, read in ONE place.
 *
 * A channel-only axis names where its values live in its key (`@nexus/shared/variation-mapping` `parseOwnAxisKey`):
 *   - `own:channel:<column>` — the variant's cell of that column on the coordinate (an eBay aspect column), read
 *     exactly as the family axes are read from the same cells (`studio-sheet.service.ts` `axisValuesFromCells`):
 *     the mapped value when a mapping rule resolved one, else the stored cell.
 *   - `own:shared:<attribute>` — the variant's Shared per-variant attribute, `Product.categoryAttributes[<attribute>]`,
 *     the store the master sheet reads for a `categoryAttributes` column (`studio-sheet.service.ts` `readValue`).
 *
 * The sheet cell, the save's collision and gap checks and every publisher call these, so what the pop-up counts is
 * what a publish sends (VTR rule 6). PURE: no database.
 */

import { hasVariationMappingOverride, parseOwnAxisKey, parseVariationMapping, type OwnAxisSource } from '@nexus/shared/variation-mapping'
import { canonicalVariantAxis } from './variant-attribute-keys.js'

export type OwnAxisCell = { value?: unknown; mapped?: { status?: string; value?: unknown } } | undefined

function text(value: unknown): string {
  if (typeof value === 'string') return value.trim() ? value : ''
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

/** One variant's value for one channel-only axis. `''` = the variant has none (a value gap, never a guess). */
export function ownAxisValue(
  source: OwnAxisSource,
  channelCells: Record<string, OwnAxisCell> | null | undefined,
  sharedAttributes: unknown,
): string {
  if (source.from === 'channel') {
    // The exact column first; else the one whose key folds to the same axis key (the tolerance the family axes' own
    // reader has, `axisValuesFromCells`), so a spelling difference between two builders never reads as a gap.
    const cell = channelCells?.[source.field]
      ?? Object.entries(channelCells ?? {}).find(([key]) => canonicalVariantAxis(key) === canonicalVariantAxis(source.field))?.[1]
    return text(cell?.mapped?.status === 'mapped' ? cell.mapped.value : cell?.value)
  }
  const bag = sharedAttributes && typeof sharedAttributes === 'object' && !Array.isArray(sharedAttributes) ? sharedAttributes as Record<string, unknown> : {}
  return text(bag[source.field])
}

/** Every listed channel-only key's value for one variant, keyed by the RAW key (the axis's `familyKey`). */
export function ownAxisValuesFor(
  keys: readonly string[],
  channelCells: Record<string, OwnAxisCell> | null | undefined,
  sharedAttributes: unknown,
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of keys) {
    const source = parseOwnAxisKey(key)
    if (source) out[key] = ownAxisValue(source, channelCells, sharedAttributes)
  }
  return out
}

/**
 * The channel-only keys a coordinate's parent listing STORES, in delivery order: eBay's `_variationAxes`, every other
 * channel's `variationMapping`. A reset (`_variationAxesMode: 'inherit'`) or no override stores none.
 */
export function storedOwnAxisKeys(
  channel: string | null | undefined,
  listing: { variationMapping?: unknown; platformAttributes?: unknown } | null | undefined,
): string[] {
  if (!listing) return []
  if (String(channel ?? '').toUpperCase() === 'EBAY') {
    const bag = (listing.platformAttributes ?? {}) as Record<string, unknown>
    if (bag._variationAxesMode === 'inherit' || !Array.isArray(bag._variationAxes)) return []
    return (bag._variationAxes as unknown[]).filter((key): key is string => parseOwnAxisKey(key) !== null)
  }
  if (!hasVariationMappingOverride(listing.variationMapping)) return []
  return parseVariationMapping(listing.variationMapping).entries.map(entry => entry.axisKey).filter(key => parseOwnAxisKey(key) !== null)
}

/** The keys whose values a caller loads: the stored ones plus the candidates the pop-up counts, once each. */
export function ownAxisKeysToRead(stored: readonly string[], candidates: readonly string[] = []): string[] {
  return [...new Set([...stored, ...candidates])]
}

/**
 * eBay's two older readers — the push's row scan (`ebay-variation-push.service.ts`) and the family-axes read behind
 * the presentation order (`ebay-family-axes.service.ts`) — find an axis by its NAME on each variant row
 * (`aspect_<name>`). So a channel-only axis is declared to them under its eBay name, and a Shared-attribute one also
 * gets that aspect on each row, from the value the studio publish sends. MUTATES `rows` (in-memory flat rows only).
 */
export function ebayRowAxes(
  included: ReadonlyArray<{ familyKey: string; channelName: string; own?: { from: string } }>,
  variants: ReadonlyArray<{ sku: string; axisValues: Record<string, string> }> | undefined,
  rows: Array<Record<string, unknown>>,
): { declared: string[]; nameLabels: Record<string, string> } {
  for (const axis of included.filter(a => a.own?.from === 'shared')) {
    for (const row of rows) {
      const value = variants?.find(v => v.sku === row.sku)?.axisValues[axis.familyKey]
      if (value) row[`aspect_${axis.channelName.replace(/\s+/g, '_')}`] = value
    }
  }
  const nameOf = (axis: { familyKey: string; channelName: string; own?: unknown }) => axis.own ? axis.channelName : axis.familyKey
  return { declared: included.map(nameOf), nameLabels: Object.fromEntries(included.map(a => [nameOf(a), a.channelName])) }
}
