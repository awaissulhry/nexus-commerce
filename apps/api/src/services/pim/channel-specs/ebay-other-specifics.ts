/**
 * P1 of fix/product-sheet-editing (report 3 I-3.4, report 6 I-8b) — item specifics a listing STORES that are not in eBay's
 * list for its category (Genere, Athlete, Body type, Team name, Paese di fabbricazione…). The publisher sends every stored
 * item specific (`buildEbayListingInput` starts from the stored bag), yet no column showed them, so the operator could
 * neither see nor remove what was published. They are served as columns in one "Other item specifics" group, edited and
 * cleared like any aspect (the same store, the same writer), with eBay's 65-character value limit.
 *
 * Pure: the caller hands the columns it already serves and the family's listings on the coordinate.
 */
import { aspectCanonicalName } from '../../ebay-theme-axes.js'
import { EBAY_ASPECT_VALUE_MAX } from '../../ebay-aspect-values.js'
import { normaliseKey } from './types.js'
import { isBlankValue } from '../sheet-values.js'
import type { SheetColumn, SheetGroup } from '../sheet-columns.service.js'

export const OTHER_SPECIFICS_GROUP: SheetGroup = { key: 'EBAY:other-specifics', label: 'Other item specifics', channelLabel: null, order: 998 }
/** A key no category aspect can take (aspect keys are the aspect's own normalised name). */
export const OTHER_SPECIFIC_PREFIX = 'other_specific_'

export function otherItemSpecificColumns(input: {
  columns: ReadonlyArray<Pick<SheetColumn, 'channels'>>
  coordinateLabel: string
  listings: ReadonlyArray<{ platformAttributes?: unknown }>
  category?: string | null
}): SheetColumn[] {
  // An aspect is covered when a served column stores it, in any spelling of its name (Marca / Brand).
  const covered = new Set(input.columns.flatMap(col => {
    const store = col.channels?.[input.coordinateLabel]?.store
    return store?.kind === 'platformAttributes' && store.path[0] === 'itemSpecifics' && store.path[1] ? [aspectCanonicalName(store.path[1])] : []
  }))
  const found = new Map<string, { name: string; list: boolean }>()
  for (const listing of input.listings) {
    const bag = (listing.platformAttributes as { itemSpecifics?: unknown } | null | undefined)?.itemSpecifics
    if (!bag || typeof bag !== 'object' || Array.isArray(bag)) continue
    for (const [name, value] of Object.entries(bag as Record<string, unknown>)) {
      const identity = aspectCanonicalName(name)
      // eBay renders the condition structurally; the publisher never sends a "Condizione" specific. A cleared value
      // (stored blank) is not sent either, so it is not shown.
      if (!name.trim() || identity === 'condizione' || covered.has(identity) || isBlankValue(value)) continue
      const seen = found.get(identity)
      found.set(identity, { name: seen?.name ?? name, list: (seen?.list ?? false) || Array.isArray(value) })
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name)).map(({ name, list }): SheetColumn => {
    const key = `${OTHER_SPECIFIC_PREFIX}${normaliseKey(name)}`
    const cardinality = list ? { min: 0, max: null } : { min: 0, max: 1 }
    return {
      key, writeField: `attr_${key}`, label: name, channelLabel: name,
      group: OTHER_SPECIFICS_GROUP.label, groupKey: OTHER_SPECIFICS_GROUP.key,
      kind: 'text', storage: 'listing', scope: 'global', requiredBy: [], editable: true, defaultVisible: true,
      shape: list ? 'list' : 'scalar', cardinality, maxLength: EBAY_ASPECT_VALUE_MAX, capFrom: input.coordinateLabel,
      helpText: 'Stored on this listing and sent to eBay, but not an item specific of this eBay category. Clear it to stop sending it.',
      channels: { [input.coordinateLabel]: { key, attribute: `aspect_${name}`, path: [], label: name, requirement: 'optional', cardinality,
        maxLength: EBAY_ASPECT_VALUE_MAX, store: { kind: 'platformAttributes', path: ['itemSpecifics', name] }, hidden: false, editableOnExisting: true,
        categories: input.category ? [input.category] : [] } },
    }
  })
}
