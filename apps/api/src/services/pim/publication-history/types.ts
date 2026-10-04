/**
 * Sheet publish parity, step 4 — the contract every publish history source implements.
 *
 * The core (`../publication-history.service.ts`) merges sources newest first with one keyset cursor. A source only
 * has to answer for its own rows; adding a source is a new file here plus one line in `registry.ts`, never a change
 * to the core.
 *
 * Global order (the cursor is a position in it): `sortAt` DESC, then `rank` ASC, then `localId` DESC. `rank` is the
 * source's fixed place in that order, so two sources with the same timestamp never swap places between pages.
 */
import { HISTORY_KINDS, type HistoryCoverage, type HistoryKind, type HistoryRun, type HistoryRunDetail, type HistorySource, type HistoryState,
  type HistoryWhat } from '@nexus/shared/publication-history'
import type { StudioChannelIssue } from '@nexus/shared/studio-publication'

/** A position in the global order. `at` is epoch milliseconds. */
export interface HistoryCursor {
  at: number
  rank: number
  id: string
}

/** Normalised filters. Every value is already trimmed and upper-cased where the column is. */
export interface HistoryFilters {
  channel?: string
  marketplace?: string
  accountId?: string
  /** Empty or absent = every state. */
  states?: HistoryState[]
  /** The FAMILY (parent) product id, already resolved from whichever family member was asked for. */
  familyId?: string
  userId?: string
  /** Epoch ms, inclusive. */
  from?: number
  /** Epoch ms, inclusive. */
  to?: number
  /** Free text: SKU (family or a member), title, or channel reference. */
  q?: string
  /**
   * false = leave out runs a person marked as checked (D3); true = only those; absent = both. A source that has no
   * such runs returns no rows for `true` and ignores `false`.
   */
  checked?: boolean
  /**
   * The "What" filter: only runs with at least one part in these groups. Empty or absent = every run. A source whose
   * runs all belong to fixed groups declares them (`PublicationHistoryAdapter.what`) and is never asked to filter.
   */
  what?: HistoryWhat[]
}

export interface HistoryListInput {
  filters: HistoryFilters
  /** Return only rows strictly AFTER this position in the global order; null = from the newest. */
  cursor: HistoryCursor | null
  /** Return at most this many rows (the core asks for one more than a page, to know whether another page exists). */
  limit: number
  now: Date
}

/**
 * One row as a source returns it. The core fills `userName` and `checkedBy` names in one batched read, so a source
 * returns user ids only.
 */
export interface HistorySourceRow extends Omit<HistoryRun, 'userName' | 'checkedBy'> {
  /** Epoch ms of `startedAt` — the sort key. */
  sortAt: number
  /** The source's own id (without the `<source>:` prefix); the cursor's tie-break. */
  localId: string
  /** The user id that marked the run checked; the core turns it into a name. */
  checkedByUserId: string | null
}

export interface HistoryCountInput {
  /** The list's filters; `states` and `checked` are ignored (a count covers every state). */
  filters: HistoryFilters
  now: Date
  /** Epoch ms. `done` counts finished runs that STARTED on or after this time (the list's `from` rule). */
  doneSince: number
}

/** A source's exact counts for the list it would return with the same filters. */
export interface HistorySourceTotals {
  byState: Record<HistoryState, number>
  /** needs_check runs a person marked as checked. */
  checked: number
  /** succeeded + partial + failed runs started on or after `doneSince`. */
  done: number
}

export const emptyTotals = (): HistorySourceTotals => ({
  byState: { in_progress: 0, succeeded: 0, partial: 0, failed: 0, needs_check: 0 }, checked: 0, done: 0,
})

/** Rows of `SELECT state, count(*)::int AS n, … GROUP BY state` (`checked` and `done` per state) as totals. */
export function totalsOf(rows: Array<{ state: string; n: number; checked: number; done: number }>): HistorySourceTotals {
  const totals = emptyTotals()
  for (const row of rows) {
    if (!(row.state in totals.byState)) continue
    totals.byState[row.state as HistoryState] += Number(row.n) || 0
    totals.checked += Number(row.checked) || 0
    totals.done += Number(row.done) || 0
  }
  return totals
}

export interface PublicationHistoryAdapter {
  source: HistorySource
  /** Fixed position among sources at an equal timestamp. Unique per source. */
  rank: number
  /**
   * Every run of this source belongs to these "What" groups (the old flat files: updates; photo runs: photos). The core
   * leaves the source out of a list or count whose `what` names none of them, and never asks it to filter. A source
   * without it filters `filters.what` itself, in its list AND its count.
   */
  what?: readonly HistoryWhat[]
  /** Rows strictly after `cursor`, in the global order (`sortAt` DESC, `localId` DESC), at most `limit`. */
  list(input: HistoryListInput): Promise<HistorySourceRow[]>
  /**
   * Exact counts over the SAME rows `list` would return for these filters (every state, no cursor) — the same state
   * rules, so a tile's count equals the length of the list it opens. A source without it is counted by paging `list`.
   */
  count?(input: HistoryCountInput): Promise<HistorySourceTotals>
  /** One run in full. `localId` is the source's own id. null = not found in this business. */
  detail(localId: string, now: Date): Promise<HistoryRunDetail | null>
  /**
   * The exact request one listing received in this run; null = not kept (or not found). Sources that keep no
   * request leave it out.
   */
  request?(localId: string, listingId: string): Promise<{ sku: string; requests: unknown[] } | null>
  /** What this source covers: included, since when, and a plain note when something is missing. */
  coverage(): Promise<HistoryCoverage>
}

export const kindOf = (value: unknown, fallback: HistoryKind): HistoryKind =>
  typeof value === 'string' && (HISTORY_KINDS as readonly string[]).includes(value) ? value as HistoryKind : fallback

/** Does this source answer a list or count with this "What" filter? (A source with fixed groups answers all or nothing.) */
export const answersWhat = (adapter: Pick<PublicationHistoryAdapter, 'what'>, filters: Pick<HistoryFilters, 'what'>): boolean =>
  !filters.what?.length || !adapter.what || adapter.what.some(group => filters.what!.includes(group))

/** Every attribute the channel named, in order, without repeats: what "Show in sheet" maps to sheet columns. */
export const columnHintOf = (issues: Pick<StudioChannelIssue, 'attributeNames'>[]): string[] =>
  [...new Set(issues.flatMap(issue => issue.attributeNames).filter(name => typeof name === 'string' && name.trim() !== ''))]

/** The run id a reader sees: product sheet publications keep their own id; other sources are prefixed. */
export const publicRunId = (source: HistorySource, localId: string) => source === 'studio' ? localId : `${source}:${localId}`
