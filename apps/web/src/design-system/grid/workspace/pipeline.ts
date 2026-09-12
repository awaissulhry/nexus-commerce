/**
 * AGW — the pure pieces of the grid's behaviour that are NOT AG's: the search narrowing, the page
 * arithmetic the pager prints, the enabled-first banding and the group ordering `postSortRows`
 * applies, and the noun pluraliser. Each is either lifted verbatim from the hand-rolled grid or
 * written so a unit test can hold it to the legacy's answer.
 *
 * Filtering (`filterRows`), the sort comparison (`compareSortValues`), the edit diff
 * (`collectEdits`), the rank vocabulary (`enabledRank`) and the interactive-child rule
 * (`isInteractiveChild`) are the SHARED modules both engines already ran — imported, never copied.
 */
import { enabledRank } from '@/design-system/patterns/workspace-grid/enabledRank'

// Consonant-y takes -ies ("8 Queries", not "8 Querys" — shipped, seen, fixed).
export const pluralize = (noun: string, n: number) => (n === 1 ? noun : /[^aeiou]y$/i.test(noun) ? `${noun.slice(0, -1)}ies` : `${noun}s`)

/** The H10 inline 🔍 — narrows on the first-column text by default. Verbatim from the legacy memo. */
export function searchRows<T>(
  rows: readonly T[],
  search: string,
  searchable: boolean | undefined,
  accessor: ((row: T) => string) | undefined,
): T[] {
  const q = search.trim().toLowerCase()
  if (!searchable || !q || !accessor) return rows as T[]
  return (rows as T[]).filter((r) => String(accessor(r) ?? '').toLowerCase().includes(q))
}

export interface PageMath {
  pageCount: number
  safePage: number
  viewStart: number
  viewEnd: number
}

/** What the pager and the count line print. `totalCount` is the whole result, never the page. */
export function pageMath(page: number, perPage: number, totalCount: number): PageMath {
  const pageCount = Math.max(1, Math.ceil(totalCount / perPage))
  const safePage = Math.min(page, pageCount)
  return {
    pageCount,
    safePage,
    viewStart: totalCount === 0 ? 0 : (safePage - 1) * perPage + 1,
    viewEnd: Math.min(safePage * perPage, totalCount),
  }
}

/** The legacy's `useState` initializer for the page: a finite integer ≥ 1, else 1. */
export const initialPageOf = (initialPage: number | undefined): number =>
  initialPage != null && Number.isFinite(initialPage) && initialPage >= 1 ? Math.floor(initialPage) : 1

/**
 * SF.1 banding, as a STABLE re-order of an already-sorted list: live rows first, then paused, then
 * archived (`enabledRank`), with the incoming order kept inside each band. That incoming order is
 * AG's — the column sort, or the row order when nothing is sorted — so the result is byte-for-byte
 * the legacy's `arr.sort((a, b) => ra - rb || compareSortValues(…))`.
 */
export function bandByEnabled<N>(nodes: N[], rowOf: (n: N) => unknown | undefined, enabledFirst: (row: never) => unknown): void {
  const ranked = nodes.map((n, i) => {
    const row = rowOf(n)
    return { n, i, r: row === undefined ? 1 : enabledRank(enabledFirst(row as never)) }
  })
  ranked.sort((a, b) => a.r - b.r || a.i - b.i)
  for (let i = 0; i < nodes.length; i++) nodes[i] = ranked[i].n
}

export interface GroupMeta { label: string; order?: number }

/**
 * R1 — group order: an explicit `order` wins where BOTH groups carry one and they differ;
 * otherwise alphabetical by label, exactly as before. Stable, so equal groups keep AG's order.
 */
export function orderGroups<N>(nodes: N[], keyOf: (n: N) => string | null | undefined, meta: ReadonlyMap<string, GroupMeta>): void {
  const indexed = nodes.map((n, i) => ({ n, i, m: meta.get(keyOf(n) ?? '') }))
  indexed.sort((a, b) => {
    const ga = a.m, gb = b.m
    if (ga && gb) {
      if (ga.order != null && gb.order != null && ga.order !== gb.order) return ga.order - gb.order
      const c = ga.label.localeCompare(gb.label)
      if (c !== 0) return c
    }
    return a.i - b.i
  })
  for (let i = 0; i < nodes.length; i++) nodes[i] = indexed[i].n
}

/** Every distinct group a row set produces, keyed for `orderGroups` and the band renderer. */
export function collectGroupMeta<T>(rows: readonly T[], groupBy: (row: T) => { key: string; label: string; order?: number }): Map<string, GroupMeta> {
  const m = new Map<string, GroupMeta>()
  for (const r of rows) {
    const g = groupBy(r)
    if (!m.has(g.key)) m.set(g.key, { label: g.label, order: g.order })
  }
  return m
}

/** The legacy toolbar's "is any filter set" test — drives the Save-preset button. */
export function hasActiveFilters(fstate: Record<string, { min: string; max: string } | string | string[]>): boolean {
  return Object.values(fstate).some((v) => (Array.isArray(v) ? v.length > 0 : typeof v === 'string' ? !!v : !!(v?.min || v?.max)))
}
