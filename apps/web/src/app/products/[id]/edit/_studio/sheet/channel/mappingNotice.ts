/**
 * What the derived (`🔗`) column says when the mapping run did not fully answer.
 *
 * 🔴 The defect this closes (hub #295). The mapping enrichment has an 8s budget and times out while
 * its Redis-backed queue connects on a cold process. When it does, the sheet still ships — but every
 * cell comes back `mapped: null`, so for the first load or two after a deploy the `🔗` column
 * renders SILENTLY EMPTY and then fills on a later load. An operator reads that as data loss, and
 * nothing on screen says otherwise.
 *
 * The reason is already in the contract at `meta.mapping.skippedReason`; it had no consumer at all.
 * The whole class here is "an empty column has four causes and the screen names none of them" — an
 * empty cell must always be attributable, which is the same invariant `EmptyValue` defends one
 * level down.
 *
 * `productLevelOnly` is the second unwired honesty flag on this same object, and it is NOT the same
 * state: mapping succeeded, but the resolver is keyed by PRODUCT, so every alias projection of one
 * product shows the same mapped value and a derived cell does not account for per-alias overrides.
 * Silence there lets an operator read four aliases as four independently mapped listings.
 */

export interface MappingMeta {
  productLevelOnly: boolean
  missingProductIds: string[]
  skippedReason: string | null
}

export interface MappingNotice {
  /** The footer note's kind. `slow` is a state, not a failure — the next load usually fills it. */
  kind: 'slow' | 'provenance'
  /** Appended to the `🔗` column header, so the column explains itself where it is looked at. */
  headerSuffix: string
  /** The footer note. */
  note: string
  /** The contract's own words, never paraphrased into a diagnosis this lane cannot make. */
  detail?: string
}

export function mappingNotice(meta: MappingMeta | null | undefined): MappingNotice | null {
  // No mapping block at all is not the same as a failed one: a scope that derives nothing has
  // nothing to report, and inventing a warning there is the false-positive that costs more than
  // the silence it replaces.
  if (!meta) return null

  // 1 — the run did not happen. This is the empty-column case, and it is RETRYING, not lost.
  if (meta.skippedReason) {
    return {
      kind: 'slow',
      headerSuffix: 'unavailable',
      note: 'Derived values unavailable — retrying',
      detail: meta.skippedReason,
    }
  }

  // 2 — the run happened but some products are not in it. Partial, and the count is the honest
  // thing to say: which rows are affected is knowable, how many is what the contract gives us.
  if (meta.missingProductIds.length > 0) {
    const n = meta.missingProductIds.length
    return {
      kind: 'slow',
      headerSuffix: 'partial',
      note: `Derived values missing for ${n} ${n === 1 ? 'product' : 'products'} — retrying`,
    }
  }

  // 3 — the run fully succeeded, but at PRODUCT grain. The values are real; what is not real is the
  // impression that each alias was resolved independently.
  if (meta.productLevelOnly) {
    return {
      kind: 'provenance',
      headerSuffix: 'per product',
      note: 'Derived per product — aliases of one product share this value',
    }
  }

  return null
}
