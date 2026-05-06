/**
 * Phase 10a — URL parse / serialize helpers for the canonical filter
 * contract. Pure functions, no React, no DOM, no Next.js — easy to
 * unit-test and safe to call on the server side too.
 *
 * Canonical URL form is documented in ./types.ts. This file is the
 * one-and-only place that knows how to translate between
 * URLSearchParams and CommonFilters.
 */

import type { CommonFilters, FilterDelta } from './types'
import { EMPTY_FILTERS } from './types'

/**
 * Legacy CSV → canonical key map. Phase 1 audit identified each entry;
 * keeping them as deprecated aliases preserves bookmarks and external
 * links from before the unification. Remove an entry once the relevant
 * page has been migrated and we've waited a release cycle for the
 * referrers to age out.
 */
const LEGACY_CSV_PARAMS: Record<string, keyof CommonFilters> = {
  channels: 'channel',
  marketplaces: 'marketplace',
  statuses: 'status',
  // /listings used to call the listing-specific filter listingStatus.
  // It's the same data as `status` for that page.
  listingStatus: 'status',
}

/**
 * Parse URLSearchParams into a CommonFilters, accepting both the
 * canonical repeated-key form and the deprecated CSV form. CSVs are
 * silently expanded; a one-line console.warn fires in dev so the
 * deprecation is visible during local work without spamming production.
 *
 * Unknown params are ignored — page-specific parsers handle those.
 */
export function parseFilters(params: URLSearchParams | string): CommonFilters {
  const sp = typeof params === 'string' ? new URLSearchParams(params) : params

  const result: CommonFilters = {
    search: sp.get('search') || undefined,
    channel: collectMulti(sp, 'channel'),
    marketplace: collectMulti(sp, 'marketplace'),
    status: collectMulti(sp, 'status'),
  }

  // Legacy CSV expansion. The URL might carry both forms during a
  // transition; we union them so e.g. ?channels=A,B&channel=C produces
  // [A, B, C] rather than dropping one form. Dedup at the end.
  for (const [legacyKey, canonicalKey] of Object.entries(LEGACY_CSV_PARAMS)) {
    const csv = sp.get(legacyKey)
    if (!csv) continue
    if (typeof console !== 'undefined' && process.env.NODE_ENV !== 'production') {
      // eslint-disable-next-line no-console
      console.warn(
        `[filters] Legacy URL param "${legacyKey}=${csv}" — will be removed once /products and /listings finish their Phase 10 migration. Canonical form: ?${canonicalKey}=${csv.split(',').join(`&${canonicalKey}=`)}`,
      )
    }
    const expanded = csv
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    if (canonicalKey === 'search') {
      // search is single-value; CSV doesn't apply, but be defensive.
      if (!result.search && expanded[0]) result.search = expanded[0]
    } else {
      result[canonicalKey] = uniq([...result[canonicalKey], ...expanded])
    }
  }

  return result
}

/**
 * Serialise CommonFilters back to URLSearchParams in the canonical
 * repeated-key form. Empty arrays / empty search are omitted entirely
 * so the URL stays short. Output is sorted (search first, then
 * channels, marketplaces, status) so two equivalent filter sets always
 * produce identical URLs — important for caching and history.
 */
export function serializeFilters(filters: CommonFilters): URLSearchParams {
  const sp = new URLSearchParams()
  if (filters.search) sp.set('search', filters.search)
  for (const c of [...filters.channel].sort()) sp.append('channel', c)
  for (const m of [...filters.marketplace].sort()) sp.append('marketplace', m)
  for (const s of [...filters.status].sort()) sp.append('status', s)
  return sp
}

/**
 * Apply a partial filter update and return a new CommonFilters.
 * Undefined values in the patch leave the existing value alone; setting
 * `channel: []` (an empty array) DOES clear the existing channel
 * filter, so the caller has an explicit way to remove a constraint.
 */
export function mergeFilters(
  base: CommonFilters,
  patch: FilterDelta,
): CommonFilters {
  return {
    search: patch.search === undefined ? base.search : patch.search || undefined,
    channel: patch.channel === undefined ? base.channel : patch.channel,
    marketplace:
      patch.marketplace === undefined ? base.marketplace : patch.marketplace,
    status: patch.status === undefined ? base.status : patch.status,
  }
}

/**
 * Convenience: test-only helper for the merge logic so we can express
 * "set, clear, or leave alone" intentions explicitly. Returns the same
 * object shape mergeFilters consumes.
 */
export function clearAll(): CommonFilters {
  return { ...EMPTY_FILTERS, channel: [], marketplace: [], status: [] }
}

/**
 * Convert filters back to the query string suffix (no leading `?`).
 * Wrapper around serializeFilters that's directly usable in
 * Next.js router.replace() / push().
 */
export function toQueryString(filters: CommonFilters): string {
  return serializeFilters(filters).toString()
}

/**
 * URLs are user-typed and external — defend against accidental
 * duplicates ("AMAZON,amazon,AMAZON") by upper-casing channel /
 * marketplace / status values during parse. Search is left as-is
 * because it's free text the user typed.
 */
function collectMulti(sp: URLSearchParams, key: string): string[] {
  return uniq(
    sp.getAll(key).map((v) => v.trim().toUpperCase()).filter(Boolean),
  )
}

function uniq<T>(arr: T[]): T[] {
  return Array.from(new Set(arr))
}
