import { cachedSchemasOnly } from './cached-schema-context.js'
/**
 * PES.5 — a process-local cache for studio column builds.
 *
 * `getSheetColumns()` derives its set from the 24 h-cached Amazon product-type
 * definitions plus the eBay aspect table. Measured cost on the GALE family:
 * ~1.4 s per call. The scope bar needs one build PER CHANNEL, so the readiness
 * endpoint's first cut spent **14.9 seconds** rebuilding the same manifests six
 * times to paint one row of chips.
 *
 * MS.1 caches this in its ROUTE (`products-sheet.routes.ts`). That cache cannot
 * be reached from a service, and moving it would change MS.1's `?force=1`
 * behaviour on a shipped surface — so the studio keeps its own, here, at the
 * service level where both studio readers can share it.
 */
import { workspaceIdForQuery } from '../../lib/workspace-context.js'
import { TtlCache } from '../../utils/ttl-cache.js'
import { getSheetColumns, lacksShopifyStoreFields, type SheetColumnSet } from './sheet-columns.service.js'
import { dictionaryVersion } from './dictionary-version.js'

const cache = new TtlCache<Promise<SheetColumnSet>>({ ttlMs: 5 * 60_000, maxEntries: 128 })

export function clearStudioColumnCache(): void { cache.clear() }

export interface StudioColumnsInput {
  accountId?: string | null
  locale?: string

  familyIds?: string[]
  savedFields?: import('./field-registry.service.js').FieldDefinition[]
  /** P3b S4 — see `GetSheetColumnsInput.savedFieldsFor`. */
  savedFieldsFor?: 'shared' | 'all'
  market: string
  productTypes: string[]
  variationAxes?: string[]
  channels?: string[]
  /** TRUE narrowing — part of the cache key, so a narrowed build cannot be
   *  served from an un-narrowed entry. */
  onlyChannels?: string[]
  includeEmptyChannels?: boolean
  /** AM.1 — the eBay leaf categories the family's listings use; part of the key. */
  ebayCategoryIds?: string[]
  etsyCategoryIds?: string[]
  /** See `GetSheetColumnsInput.shopifyCategoryIds`; part of the key (omitted ≠ empty). */
  shopifyCategoryIds?: string[]
  scopeKind?: 'master' | 'channel'
}

/**
 * The PROMISE is cached, not the result: six concurrent chips asking for the
 * same market must share one build rather than starting six and caching the
 * last. A rejected promise is evicted so a transient failure is not remembered
 * for five minutes.
 */
export async function getStudioColumns(input: StudioColumnsInput): Promise<SheetColumnSet> {
  const key = [
    // P3b S4 (docs/attributes/PLAN.md §10.9) — the dictionary's version, so an edit shows at once.
    await dictionaryVersion(),
    workspaceIdForQuery(), cachedSchemasOnly() ? 'cached-only' : 'interactive',
    input.accountId ?? '',
    input.market,
    input.locale ?? '',
    input.productTypes.slice().sort().join(','),
    (input.variationAxes ?? []).slice().sort().join(','),
    (input.channels ?? []).slice().sort().join(','),
    (input.onlyChannels ?? []).slice().sort().join(','),
    input.includeEmptyChannels ? '1' : '0',
    (input.ebayCategoryIds ?? []).slice().sort().join(','),
    (input.etsyCategoryIds ?? []).slice().sort().join(','),
    input.shopifyCategoryIds === undefined ? '-' : input.shopifyCategoryIds.slice().sort().join(','),
    input.scopeKind ?? '',
    (input.familyIds ?? []).slice().sort().join(','),
    JSON.stringify(input.savedFields ?? []),
    input.savedFieldsFor ?? 'all',
  ].join('|')

  const hit = cache.get(key)
  if (hit) return hit

  const built: Promise<SheetColumnSet> = getSheetColumns(input).then((set) => {
    // A Shopify set built before the store's field list was available is served once, never kept.
    if (lacksShopifyStoreFields(set) && cache.get(key) === built) cache.delete(key)
    return set
  }, (err) => {
    cache.delete(key)
    throw err
  })
  cache.set(key, built)
  return built
}
