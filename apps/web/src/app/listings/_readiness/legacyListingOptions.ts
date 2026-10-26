/**
 * The old Listings page's address options, read by this page (step 8, the legacy exit, of
 * docs/listings/LISTINGS-LIVE-LAYER-PLAN-2026-10-25.md).
 *
 * The old page (`ListingsWorkspace.tsx`, `/listings/legacy…`) is gone. Bookmarks, stored alerts and links written
 * before it went still carry its options; `/listings/legacy…` sends here with the query kept (`next.config.js`).
 * `parseReadinessQuery` puts each old option into this page's own words first, then reads the address as always —
 * and the page writes its address back with its own words only, so the old ones leave the address on the first visit.
 *
 * | Old option                         | This page                                                     |
 * |------------------------------------|---------------------------------------------------------------|
 * | `search`                           | `q`                                                           |
 * | `listingStatus` ACTIVE · INACTIVE  | `live` active · paused (Inactive)                             |
 * | `listingStatus` DRAFT              | `live` draft, not_listed (both read "Not listed")             |
 * | `listingStatus` ENDED              | `live` ended                                                  |
 * | `listingStatus` ERROR · SUPPRESSED | `flags` error · suppressed                                    |
 * | `hasError=true`                    | `flags` error                                                 |
 * | `syncStatus` FAILED                | `flags` error                                                 |
 * | `syncStatus` PENDING · SYNCING     | `flags` outOfSync (Nexus holds a change the channel lacks)    |
 * | `published` true · false           | `live` active · draft, not_listed                             |
 * | `lowStock=true`                    | `flags` lowStock                                              |
 * | `drawer=<listingId>`               | `listing=<listingId>` (the Listing window)                    |
 * | `lens=health`                      | `view=problems`                                               |
 * | `sortBy` name · price · quantity · lastSyncedAt, `sortDir` | `sort` name · price · stock · synced, `dir` |
 *
 * Anything else is dropped: `listingStatus` PENDING, `syncStatus` IDLE · IN_SYNC (no filter says "in sync"), the other
 * lenses (the Performance lens is not carried over; Grid, Matrix and Drafts are this page), and `sortBy` updatedAt ·
 * channel · marketplace (no such order here). When the address also names this page's own `q`, `listing`, `view` or
 * `sort`, that one wins; `live` and `flags` add up. Several old values of one option are one choice, as on the old
 * page; `live` takes any of its states, while `flags` must all hold (this page's rule), so `listingStatus=ACTIVE,ERROR`
 * reads as active listings with an error.
 *
 * Pure — no React, no fetch — so every mapping is a test.
 */
import type { ReadinessLiveFlag, ReadinessLiveState, ReadinessSort } from '@nexus/shared/listing-readiness'

/** Every option the old page read that this page does not (`page`, `pageSize`, `channel`, `marketplace` it reads too). */
export const LEGACY_LISTINGS_OPTIONS = [
  'search', 'listingStatus', 'hasError', 'syncStatus', 'published', 'lowStock', 'drawer', 'lens', 'sortBy', 'sortDir',
] as const

const STATUS_LIVE: Readonly<Record<string, readonly ReadinessLiveState[]>> = {
  ACTIVE: ['active'], INACTIVE: ['paused'], DRAFT: ['draft', 'not_listed'], ENDED: ['ended'],
}
const STATUS_FLAGS: Readonly<Record<string, ReadinessLiveFlag>> = { ERROR: 'error', SUPPRESSED: 'suppressed' }
const SYNC_FLAGS: Readonly<Record<string, ReadinessLiveFlag>> = { FAILED: 'error', PENDING: 'outOfSync', SYNCING: 'outOfSync' }
const SORTS: Readonly<Record<string, ReadinessSort>> = { name: 'name', price: 'price', quantity: 'stock', lastSyncedAt: 'synced' }

/** An option's values: repeated (`?a=1&a=2`) or a comma list (`?a=1,2`), both of which the old page sent. */
const valuesOf = (params: URLSearchParams, key: string): string[] =>
  params.getAll(key).flatMap((v) => v.split(',')).map((v) => v.trim()).filter(Boolean)

/**
 * The address with the old page's options put into this page's words. Returns `params` itself when it carries none,
 * so a plain visit costs nothing; otherwise a copy without them.
 */
export function withLegacyListingOptions(params: URLSearchParams): URLSearchParams {
  if (!LEGACY_LISTINGS_OPTIONS.some((key) => params.has(key))) return params
  const out = new URLSearchParams(params)
  for (const key of LEGACY_LISTINGS_OPTIONS) out.delete(key)
  const own = (key: string) => (params.get(key) ?? '').trim() !== ''
  const old = (key: string) => (params.get(key) ?? '').trim()

  const search = old('search')
  if (search && !own('q')) out.set('q', search)

  const live = new Set<string>(valuesOf(params, 'live'))
  const flags = new Set<string>(valuesOf(params, 'flags'))
  for (const status of valuesOf(params, 'listingStatus').map((v) => v.toUpperCase())) {
    for (const state of STATUS_LIVE[status] ?? []) live.add(state)
    const flag = STATUS_FLAGS[status]
    if (flag) flags.add(flag)
  }
  for (const status of valuesOf(params, 'syncStatus').map((v) => v.toUpperCase())) {
    const flag = SYNC_FLAGS[status]
    if (flag) flags.add(flag)
  }
  if (old('hasError') === 'true') flags.add('error')
  if (old('lowStock') === 'true') flags.add('lowStock')
  if (old('published') === 'true') live.add('active')
  if (old('published') === 'false') { live.add('draft'); live.add('not_listed') }
  if (live.size) out.set('live', [...live].join(','))
  if (flags.size) out.set('flags', [...flags].join(','))

  const drawer = old('drawer')
  if (drawer && !own('listing')) out.set('listing', drawer)

  if (old('lens') === 'health' && !own('view')) out.set('view', 'problems')

  const sort = SORTS[old('sortBy')]
  if (sort && !own('sort')) {
    out.set('sort', sort)
    // The old page sorted descending unless it said `asc`.
    out.set('dir', old('sortDir') === 'asc' ? 'asc' : 'desc')
  }
  return out
}
