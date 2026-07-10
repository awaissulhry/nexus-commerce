/**
 * Pure merge/intersection helpers for the eBay "Axes Consistency Layer A"
 * client wiring. Each of the four OUTPUT surfaces (variation-order modal,
 * cockpit matrix, images picker + buckets) prefers the server's authoritative
 * `resolvedAxes` and falls back to its current local derivation; the INPUT
 * surface (theme column) widens to `axisCandidates` / observed aspect keys.
 *
 * Kept framework-free so vitest can exercise the tricky set logic without
 * mounting React. See resolvedAxes.vitest.test.ts for the invariants.
 *
 * Synonym folding is delegated to the ONE client home for it
 * (variationValueOrder.pure.ts → axisSynonymKey), which is parity-checked
 * against the server helper.
 */

import { axisSynonymKey } from './variationValueOrder.pure'

/** One authoritative axis from the server (GET variation-cells / images-workspace).
 *  name = canonical display label · key = axisSynonymKey(name) · values = clean list. */
export interface ResolvedAxis {
  name: string
  key: string
  values: string[]
}

/** Convert an `aspect_Foo_Bar` column id back to the axis name "Foo Bar". */
export function aspectKeyToAxisName(aspectKey: string): string {
  if (!aspectKey.startsWith('aspect_')) return aspectKey.trim()
  return aspectKey.slice('aspect_'.length).replace(/_/g, ' ').trim()
}

/**
 * TASK 1 — variation-order modal axis SEQUENCE seed.
 *
 * Order the authoritative `resolved` axes by the stored `picked` sequence
 * (matched via synonym key, so a Colore↔Color rename still ranks). Any resolved
 * axis absent from `picked` is appended in resolved order; any picked axis with
 * NO resolved match (a ghost like "Team Name") is dropped — the intersection is
 * what stops the ghost re-appearing in the modal.
 *
 * Returns the resolved DISPLAY names in the intended dropdown order.
 */
export function intersectPickedWithResolved(picked: string[], resolved: ResolvedAxis[]): string[] {
  const rank = new Map<string, number>()
  picked.forEach((p, i) => {
    const k = axisSynonymKey(p)
    if (!rank.has(k)) rank.set(k, i)
  })
  return [...resolved]
    .map((a, i) => ({ a, i }))
    .sort((x, y) => {
      const rx = rank.get(x.a.key) ?? Number.MAX_SAFE_INTEGER
      const ry = rank.get(y.a.key) ?? Number.MAX_SAFE_INTEGER
      return rx !== ry ? rx - ry : x.i - y.i // stable: resolved order among unranked
    })
    .map(({ a }) => a.name)
}

/**
 * TASK 2 — cockpit matrix axis list.
 *
 * The matrix cells are keyed by the OBSERVED variation-attribute name, so the
 * axis list must stay in OBSERVED-key space for `cellAt` / value derivation to
 * keep matching. For each resolved axis (in declared-theme order) pick the first
 * observed key that folds to the same synonym key; drop resolved axes with no
 * observed key (surfaced as a warning elsewhere) and observed ghosts that match
 * no resolved axis. The result is observed keys, ordered by the resolved theme.
 */
export function mapResolvedToObservedKeys(resolved: ResolvedAxis[], observedKeys: string[]): string[] {
  const out: string[] = []
  const used = new Set<string>()
  for (const axis of resolved) {
    const hit = observedKeys.find((k) => !used.has(k) && axisSynonymKey(k) === axis.key)
    if (hit) {
      used.add(hit)
      out.push(hit)
    }
  }
  return out
}

/** Look up a resolved axis (by synonym key) for a given observed/display name. */
export function resolvedAxisFor(resolved: ResolvedAxis[], axisName: string): ResolvedAxis | null {
  const k = axisSynonymKey(axisName)
  return resolved.find((a) => a.key === k) ?? null
}

/**
 * TASK 3 — images drawer value BUCKETS.
 *
 * SAFETY: image sets are stored/published keyed by the EXACT value string
 * (ListingImage.variantGroupValue). We show the resolved CLEAN value list, but
 * must never hide an already-saved bucket, so we UNION the clean list with the
 * values actually present in storage (`stored`) and on the variants
 * (`observed`). Values not covered by the clean list are returned as
 * `unmatched` (the pollution the operator still has to clean up) — surfaced as
 * a visible warning, never silently dropped or remapped.
 *
 * When `resolved` is null/empty (endpoint predates resolvedAxes) the caller's
 * current behavior stands: values = observed, unmatched = [].
 *
 * Matching is case-insensitive for de-duplication, but the FIRST-seen exact
 * spelling is preserved so the returned string still matches the storage key.
 */
export function buildImageBuckets(
  resolved: string[] | null,
  stored: string[],
  observed: string[],
): { values: string[]; unmatched: string[] } {
  if (!resolved || resolved.length === 0) {
    // Fallback: exactly the pre-Layer-A behavior (observed variant values).
    const values: string[] = []
    const seen = new Set<string>()
    for (const v of observed) {
      const lk = v.toLowerCase()
      if (v && !seen.has(lk)) {
        seen.add(lk)
        values.push(v)
      }
    }
    return { values, unmatched: [] }
  }

  const values: string[] = []
  const seen = new Set<string>()
  const push = (v: string) => {
    const lk = v.toLowerCase()
    if (v && !seen.has(lk)) {
      seen.add(lk)
      values.push(v)
    }
  }
  // Clean resolved values first — these define picker count == bucket count.
  for (const v of resolved) push(v)
  const resolvedSet = new Set(resolved.map((v) => v.toLowerCase()))

  // Append any stored/observed value the clean list doesn't cover so no saved
  // bucket is ever hidden. Track them as unmatched (pollution to clean up).
  const unmatched: string[] = []
  const unmatchedSeen = new Set<string>()
  for (const v of [...stored, ...observed]) {
    if (!v) continue
    const lk = v.toLowerCase()
    if (resolvedSet.has(lk)) continue
    push(v)
    if (!unmatchedSeen.has(lk)) {
      unmatchedSeen.add(lk)
      unmatched.push(v)
    }
  }
  return { values, unmatched }
}

/**
 * TASK 4 — variation-theme combobox options.
 *
 * Widen the theme dropdown to the UNION of the variation-eligible schema axis
 * names and every axis observed on the loaded family rows (`aspect_*` column
 * ids, converted back to names) — plus, when available, the endpoint's
 * `candidates`. Synonym-folded so Color/Colore don't both show; the FIRST-seen
 * spelling wins (schema/candidate names are passed first so the locale-correct
 * label beats an ad-hoc observed key). enumMode stays 'open' at the call site so
 * free text is always still allowed.
 */
export function unionThemeOptions(
  schemaAxisNames: string[],
  observedAspectKeys: string[],
  candidates: string[] = [],
): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  const add = (raw: string) => {
    const name = raw.trim()
    if (!name) return
    const k = axisSynonymKey(name)
    if (seen.has(k)) return
    seen.add(k)
    out.push(name)
  }
  for (const n of candidates) add(n)
  for (const n of schemaAxisNames) add(n)
  for (const key of observedAspectKeys) add(aspectKeyToAxisName(key))
  return out
}
