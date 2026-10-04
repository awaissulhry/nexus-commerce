/**
 * Ads fix 5c (review 7.2, 7.13) — the pure view logic of `ProtectedTermsPanel.tsx`.
 *
 * Three things the panel got wrong, each now a function here so it can be tested without a DOM:
 * - A failed load became an empty list, which then showed "Nothing is protected" — an outage
 *   and an empty whitelist were the same pixels. `readProtections` keeps them apart.
 * - The panel could only create EXACT or prefix terms, while all ten live terms are CONTAINS.
 *   The match select now offers all three and starts on CONTAINS.
 * - Rows showed only "prefix", so the ten CONTAINS rows looked like EXACT. `matchLabel` names
 *   the match the write gate actually applies.
 *
 * "Always negate" (BLACKLIST) is gone: no engine ever read it (Owner decision D3). Any such row
 * still stored is listed apart as not used, so it can be removed, rather than hidden.
 */

export type MatchType = 'CONTAINS' | 'PREFIX' | 'EXACT'

export interface Protection {
  id: string
  mode: string
  term: string
  isPrefix: boolean
  matchType: string | null
  marketplace: string | null
  campaignId: string | null
  reason: string | null
  createdBy: string | null
}

export const DEFAULT_MATCH_TYPE: MatchType = 'CONTAINS'

export const MATCH_OPTIONS: ReadonlyArray<{ value: MatchType; label: string }> = [
  { value: 'CONTAINS', label: 'Contains' },
  { value: 'PREFIX', label: 'Starts with' },
  { value: 'EXACT', label: 'Exact' },
]

/** The match the write gate applies: `matchType ?? (isPrefix ? 'PREFIX' : 'EXACT')`; anything else matches exactly. */
export function effectiveMatchType(p: Pick<Protection, 'matchType' | 'isPrefix'>): MatchType {
  const m = p.matchType ?? (p.isPrefix ? 'PREFIX' : 'EXACT')
  return m === 'CONTAINS' || m === 'PREFIX' ? m : 'EXACT'
}

export function matchLabel(p: Pick<Protection, 'matchType' | 'isPrefix'>): string {
  const m = effectiveMatchType(p)
  return MATCH_OPTIONS.find((o) => o.value === m)!.label
}

/** One line under the form: what the chosen match blocks, with the operator's own term. */
export function matchHint(matchType: MatchType, term: string): string {
  const t = term.trim().toLowerCase() || 'xavia'
  if (matchType === 'CONTAINS') return `Blocks any negative that contains “${t}” anywhere, such as “giacca moto ${t}”.`
  if (matchType === 'PREFIX') return `Blocks a negative that starts with “${t}”, but not “giacca moto ${t}”.`
  return `Blocks only the negative “${t}” itself.`
}

export type ProtectionsLoad =
  | { status: 'loading' }
  | { status: 'failed'; message: string }
  | { status: 'loaded'; items: Protection[] }

/** A load is only `loaded` when the server answered OK with a list; everything else is `failed`, never empty. */
export function readProtections(ok: boolean, httpStatus: number, body: unknown): ProtectionsLoad {
  const items = (body as { items?: unknown } | null)?.items
  if (ok && Array.isArray(items)) return { status: 'loaded', items: items as Protection[] }
  const error = (body as { error?: unknown } | null)?.error
  const detail = typeof error === 'string' && error ? error : `HTTP ${httpStatus}`
  return { status: 'failed', message: `Nexus could not read the list (${detail}).` }
}

export function failedLoad(e: unknown): ProtectionsLoad {
  const detail = e instanceof Error && e.message ? e.message : 'no answer'
  return { status: 'failed', message: `Nexus could not read the list (${detail}).` }
}

/** WHITELIST rows are the protected terms; any other stored mode is a retired row that does nothing. */
export function splitProtections(items: Protection[]): { terms: Protection[]; retired: Protection[] } {
  return {
    terms: items.filter((p) => p.mode === 'WHITELIST'),
    retired: items.filter((p) => p.mode !== 'WHITELIST'),
  }
}

/** The "Nothing is protected" warning: only after a load that worked and found no protected term. */
export function showNothingProtected(load: ProtectionsLoad): boolean {
  return load.status === 'loaded' && splitProtections(load.items).terms.length === 0
}

export function addProtectionBody(input: { term: string; matchType: MatchType; marketplace: string; reason: string }) {
  return {
    mode: 'WHITELIST' as const,
    term: input.term.trim(),
    matchType: input.matchType,
    marketplace: input.marketplace || null,
    reason: input.reason.trim() || null,
  }
}
