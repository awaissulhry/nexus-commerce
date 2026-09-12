/**
 * PES.5 — reconstructing a product's state at a past instant from `AuditLog`.
 *
 * Extracted from `GET /products/:id/state` so the fold is testable without a
 * database. It is the whole correctness of that endpoint, and it was wrong.
 *
 * ── The two shapes, both live in the table at once ─────────────────────────
 * Measured on GALE-JACKET: 4 rows `before=descriptor after=descriptor`,
 * 5 `before=null after=descriptor`, 74 `before=null after=null`.
 *
 *   descriptor  `{ field: 'brand', value: 'Old' }` — ONE field per row. What
 *               the bulk PATCH and the restore capture write, i.e. every
 *               studio edit.
 *   map         `{ brand: 'Old', name: 'X' }` — several fields per row. What
 *               the older row-level writers use.
 *
 * Spreading a DESCRIPTOR as a map sets `state.field = 'brand'` and
 * `state.value = 'Old'` — inventing two junk keys while never rolling `brand`
 * back. Measured before the fix: coverage came back
 * `reconstructed: ["field","value"]`. The `after` branch had always handled the
 * descriptor form; only `before` did not, so one half of the same function
 * knew a shape the other half did not.
 */

export type Coverage = 'reconstructed' | 'uncertain' | 'unchanged'

export interface AuditEntryLike {
  before?: unknown
  after?: unknown
}

/**
 * A descriptor is EXACTLY `{ field: string, value: unknown }`. The
 * two-key check matters: a real field-map could contain a key called `field`,
 * but never *only* `field` and `value` — no Product column is named either.
 */
export function asDescriptor(v: unknown): { field: string; value: unknown } | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  return typeof o.field === 'string' && 'value' in o && Object.keys(o).length === 2
    ? { field: o.field, value: o.value }
    : null
}

/**
 * Fold audit entries — **oldest first** — onto a starting state.
 *
 * Order is load-bearing: the FIRST entry after the target instant carries the
 * value as it was AT that instant. A later entry's `before` is a later state
 * and must not overwrite it, which is why every write is guarded by
 * "not already covered".
 *
 * `uncertain` means "this field changed and we cannot say to what" — an entry
 * recorded the change without its prior value. That is a real answer, not a
 * failure: the alternative is reporting the CURRENT value as if it were
 * historical.
 */
export function reconstructState(
  current: Record<string, unknown>,
  entriesOldestFirst: AuditEntryLike[],
): { state: Record<string, unknown>; coverage: Record<string, Coverage> } {
  const state: Record<string, unknown> = { ...current }
  const coverage: Record<string, Coverage> = {}

  for (const entry of entriesOldestFirst) {
    if (entry.before && typeof entry.before === 'object') {
      const desc = asDescriptor(entry.before)
      if (desc) {
        if (!(desc.field in coverage)) {
          state[desc.field] = desc.value
          coverage[desc.field] = 'reconstructed'
        }
      } else {
        for (const [field, beforeVal] of Object.entries(entry.before as Record<string, unknown>)) {
          if (!(field in coverage)) {
            state[field] = beforeVal
            coverage[field] = 'reconstructed'
          }
        }
      }
    }

    // An `after` descriptor with no usable `before` says the field changed
    // without saying to what. Rows written before the audit enrichment are all
    // of this kind.
    if (entry.after && typeof entry.after === 'object') {
      const afterDesc = asDescriptor(entry.after)
      if (afterDesc && !(afterDesc.field in coverage)) coverage[afterDesc.field] = 'uncertain'
    }
  }

  return { state, coverage }
}
