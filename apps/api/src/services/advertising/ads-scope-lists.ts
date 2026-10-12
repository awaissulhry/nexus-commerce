/**
 * Scope filter (2026-10-12) — the four id lists the Bid, Keyword Harvest and Negative Targeting reads take beside their
 * singular params: `portfolioIds`, `campaignIds`, `adGroupIds`, `productIds`, each a comma-separated query string.
 *
 *   parse    trimmed, empty parts dropped, the same id once; at most MAX_SCOPE_IDS ids per list (more is a 400 in words)
 *   merge    a singular param (`campaignId` …) is a list of one, merged with its plural; nothing named = not narrowed
 *   meaning  OR inside one list, AND across lists — each read applies its own per-row rule to the merged lists
 *
 * Pure (no database): the ids are checked against this business where each read checks its singular param
 * (ads-scope-reach.ts unknownScopeId for the Bid and Negative Targeting reads; the harvest engine for its product).
 */
import { z } from 'zod'

export const MAX_SCOPE_IDS = 500

/** One list param: `a,b , ,c` → ['a', 'b', 'c'] (each id at most 64 characters, at most MAX_SCOPE_IDS of them). */
export const ID_LIST = z.string()
  .transform((v) => [...new Set(v.split(',').map((s) => s.trim()).filter(Boolean))])
  .pipe(z.array(z.string().max(64, 'an id is at most 64 characters')).max(MAX_SCOPE_IDS, `at most ${MAX_SCOPE_IDS} ids in one list`))

/** The four lists a scoped read takes, as parsed (each may be absent). */
export interface ScopeIdLists {
  portfolioIds?: readonly string[] | null
  campaignIds?: readonly string[] | null
  adGroupIds?: readonly string[] | null
  productIds?: readonly string[] | null
}

/** A singular param merged with its plural, each id once; null when neither names an id (the read is not narrowed). */
export function mergeIds(one: string | null | undefined, many: readonly string[] | null | undefined): string[] | null {
  const out = [...new Set([one, ...(many ?? [])].map((x) => x?.trim()).filter((x): x is string => !!x))]
  return out.length ? out : null
}

/** Does `id` pass one dimension? Yes when neither the singular nor the plural names an id; else it must be one of them. */
export function idIn(id: string | null | undefined, one: string | null | undefined, many: readonly string[] | null | undefined): boolean {
  if (!one && !many?.length) return true
  return !!id && (id === one || !!many?.includes(id))
}
