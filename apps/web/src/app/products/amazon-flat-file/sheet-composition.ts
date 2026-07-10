// UFX P4b — multi-category (union) sheet composition pointer. Pure helpers,
// unit-tested; the page owns the localStorage calls.
//
// A union sheet's draft persists under the composite storageType — the SORTED
// distinct row types joined with '+' (computeStorageType). But a sheet is
// keyed on load by (marketplace, PRIMARY type) only, so without a pointer the
// composite "A+B" draft is orphaned on reload (MT.4b). The pointer records,
// per marketplace (family sessions get their own scope, mirroring
// rowStorageKey), that the last sheet on that market was a union of which
// types — the mount restore then knows to read the composite draft.

/** localStorage key for the composition pointer of (marketplace, family scope). */
export function sheetCompositionKey(mp: string, familyId?: string | null): string {
  const base = `ff-sheettypes-${mp.toUpperCase()}`
  return familyId ? `${base}-family-${familyId}` : base
}

/**
 * storageType → pointer value. Only a composite ("A+B") is worth remembering;
 * a single-type sheet returns null (the caller REMOVES the pointer, so leaving
 * union mode stops the composite restore).
 */
export function serializeComposition(storageType: string): string | null {
  const s = storageType.trim().toUpperCase()
  return s.includes('+') ? s : null
}

/**
 * Stored pointer → member types (UPPERCASE, deduped, original sorted order).
 * Anything that isn't a >1-type composite parses to null.
 */
export function parseComposition(raw: string | null): string[] | null {
  if (!raw || !raw.includes('+')) return null
  const types = [...new Set(raw.split('+').map((t) => t.trim().toUpperCase()).filter(Boolean))]
  return types.length > 1 ? types : null
}

/**
 * A stored composition only drives the restore of the sheet keyed by
 * (mp, primaryType) when the primary is one of its members — a pointer left
 * by a JACKET+PANTS sheet must not hijack an unrelated SHIRT sheet.
 */
export function compositionMatchesPrimary(types: string[], primaryType: string): boolean {
  return types.includes(primaryType.trim().toUpperCase())
}

/** The composite draft key suffix for a composition — MUST match the
 *  write-side computeStorageType exactly (sorted, '+'-joined). */
export function compositionStorageType(types: string[]): string {
  return [...types].map((t) => t.toUpperCase()).sort().join('+')
}
