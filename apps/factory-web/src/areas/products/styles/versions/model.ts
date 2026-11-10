import type { OrderRow, RequestRow, StyleDriftView, VersionsCompareView } from '../../changes/api'
import { raisedByPhrase, recordHref, rowOfOrder, rowOfRequest, statusOf, type ChangeRow, type Phrase, type Tone } from '../../changes/model'
import type { ReleasedScopeView } from '../release/api'
import type { StyleVersionsView, VersionRow } from './api'

/**
 * Style › Versions & changes (design products.styles rec:Style tab style.versions; PRD-166, PRD-168, PRD-194), pure: who
 * reads which section, the revisions table, the two revisions compared (the released one against the draft by default),
 * the cost section's lines in money (cost grain only), the style's change requests and orders as one table, and what the
 * released revision is released for (a later release: "Release more…"). The containers read; the views draw.
 */

// ---- who may do what ---------------------------------------------------------------------------------------------------------

export interface VersionsCan {
  /** The revisions, the compare and the drift (product.bom.view, B-W2b-220). */
  read: boolean
  /** The style's change requests and orders (product.changes.view, B-W2b-226). */
  changes: boolean
  /** Raise a change request (product.changes.request). */
  request: boolean
  /** Release a draft, release more of a released one (product.bom.release). */
  release: boolean
  /** The compare's cost section (the cost grain; costing.view is asked by the API over the company). */
  cost: boolean
}

export function versionsCan(permissions: readonly string[]): VersionsCan {
  const held = new Set(permissions)
  return {
    read: held.has('product.bom.view'),
    changes: held.has('product.changes.view'),
    request: held.has('product.changes.request'),
    release: held.has('product.bom.release'),
    cost: held.has('money.cost'),
  }
}

// ---- reads -------------------------------------------------------------------------------------------------------------------

/** A part of the tab: each read alone and failing alone (never drawn as empty when it failed). `problem` is a key of `products-changes`. */
export type Read<T> = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }

export interface StyleChanges {
  requests: readonly RequestRow[]
  orders: readonly OrderRow[]
  /** Each list read whole (the API stops at its limit). */
  complete: boolean
}

export interface ComparePair {
  from: string
  to: string
}

export interface VersionsModel {
  can: VersionsCan
  /** The person reading (a change's "You" / "A colleague"). */
  me: string
  versions: Read<StyleVersionsView>
  pair: ComparePair | null
  compare: Read<VersionsCompareView>
  /** null: the style's changes are not in the role. */
  changes: Read<StyleChanges> | null
  drift: Read<StyleDriftView>
  released: Read<ReleasedScopeView>
  /** The Compare revisions pop-up (Versions tab · band overflow). */
  compareOpen: boolean
}

export interface VersionsActions {
  onPair?: (pair: ComparePair) => void
  onSwap?: () => void
  onCompareOpen?: (pair?: ComparePair) => void
  onCompareClose?: () => void
  onRetry?: (part: 'versions' | 'compare' | 'changes' | 'drift' | 'released') => void
  /** "Release more…" of the released revision (only wider). */
  onWiden?: () => void
}

// ---- the revisions ---------------------------------------------------------------------------------------------------------------

/** Newest first, as the API answers; the released one first among equals never happens (one revision number each). */
export const byNewest = (rows: readonly VersionRow[]): VersionRow[] => [...rows].sort((a, b) => b.revision - a.revision)

/**
 * The two revisions compared when nothing was picked: the released one against the draft (what the draft changes), else the
 * one before the released one against it (what the last release changed), else the two newest; null with fewer than two.
 */
export function defaultPair(rows: readonly Pick<VersionRow, 'id' | 'revision' | 'status'>[]): ComparePair | null {
  if (rows.length < 2) return null
  const sorted = [...rows].sort((a, b) => a.revision - b.revision)
  const draft = sorted.find((row) => row.status === 'DRAFT')
  const released = sorted.find((row) => row.status === 'RELEASED')
  if (draft && released) return { from: released.id, to: draft.id }
  if (released) {
    const before = sorted.filter((row) => row.revision < released.revision).at(-1)
    if (before) return { from: before.id, to: released.id }
  }
  const [older, newer] = sorted.slice(-2)
  return older && newer ? { from: older.id, to: newer.id } : null
}

/** A pair that still names two different revisions of the style (else the default). */
export function pairIn(rows: readonly Pick<VersionRow, 'id' | 'revision' | 'status'>[], pair: ComparePair | null): ComparePair | null {
  if (pair && pair.from !== pair.to && rows.some((row) => row.id === pair.from) && rows.some((row) => row.id === pair.to)) return pair
  return defaultPair(rows)
}

/** Why the pair cannot be compared (a key of products-versions), or null. */
export function pairHeld(rows: readonly Pick<VersionRow, 'id'>[], pair: ComparePair | null): string | null {
  if (rows.length < 2) return 'pair.onlyOne'
  if (!pair) return 'pair.pick'
  if (pair.from === pair.to) return 'pair.same'
  return null
}

export const REVISION_TONE: Readonly<Record<VersionRow['status'], Tone>> = { DRAFT: 'info', RELEASED: 'success', OBSOLETE: 'neutral' }

/** A count of records made from a revision: a number, or held when the role does not reach them (never 0). */
export const countText = (value: number | null): string | null => (value === null ? null : String(value))

// ---- the compare's cost section (the cost grain) -----------------------------------------------------------------------------

/** "Not in your role" (no grain: the API dropped it), "needs costing" (null: no costing.view or no company to price it for), or shown. */
export function costState(compare: Pick<VersionsCompareView, 'cost'> | null): 'absent' | 'held' | 'shown' {
  if (!compare || !('cost' in compare) || compare.cost === undefined) return 'absent'
  return compare.cost === null ? 'held' : 'shown'
}

/** A cost section's values as money in its currency (every value of the section is a decimal string in that currency). */
export function costLines(section: NonNullable<VersionsCompareView['cost']>, money: (value: string) => string): NonNullable<VersionsCompareView['cost']>['lines'] {
  const side = (value: { fields: Record<string, string | null>; sizes?: Record<string, string> } | null) =>
    value ? { fields: Object.fromEntries(Object.entries(value.fields).map(([id, field]) => [id, field === null ? null : money(field)])), ...(value.sizes ? { sizes: value.sizes } : {}) } : null
  return section.lines.map((line) => ({ ...line, before: side(line.before), after: side(line.after) }))
}

/** A decimal string as money (the API rounds once; two decimals for the eye). */
export function moneyOf(currency: string, locale: 'it' | 'en'): (value: string) => string {
  const format = new Intl.NumberFormat(locale === 'it' ? 'it-IT' : 'en-GB', { style: 'currency', currency, minimumFractionDigits: 2, maximumFractionDigits: 2 })
  return (value) => {
    const number = Number(value)
    return Number.isFinite(number) ? format.format(number) : value
  }
}

// ---- the style's change requests and orders -----------------------------------------------------------------------------------

export interface ChangeLine {
  id: string
  kind: 'request' | 'order'
  number: string | null
  title: string
  href: string
  status: { key: string; tone: Tone }
  raisedBy: Phrase
  at: string
}

/** One table of the style's requests and change orders, newest first (a person said as "You" / "A colleague"). */
export function changeLines(changes: StyleChanges, prefix: string, me: string): ChangeLine[] {
  const rows: ChangeRow[] = [...changes.requests.map(rowOfRequest), ...changes.orders.map(rowOfOrder)].sort((a, b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
  return rows.flatMap((row) =>
    row.kind === 'smv'
      ? []
      : [{ id: row.id, kind: row.kind, number: row.number, title: row.title, href: recordHref(prefix, row.kind, row.recordId), status: statusOf(row), raisedBy: raisedByPhrase(row, me), at: row.at }],
  )
}

/** The changes still open on the style (a request not done or rejected, an order not released, rejected or cancelled). */
export const openChanges = (changes: StyleChanges): number =>
  changes.requests.filter((request) => !['DONE', 'REJECTED'].includes(request.status)).length + changes.orders.filter((order) => !['RELEASED', 'REJECTED', 'CANCELLED'].includes(order.status)).length

// ---- what the released revision is released for --------------------------------------------------------------------------------

/** "Release more…" is offered: the released revision waits for some colourways or sizes, and the person releases. */
export const mayWiden = (released: ReleasedScopeView | null, can: Pick<VersionsCan, 'release'>): boolean => !!released?.revision && !!released.scope && !released.scope.whole && can.release

/** The released scope by codes (the same in every language): the colourways and sizes released, and what waits. */
export function releasedText(released: ReleasedScopeView): { colourways: string; sizes: string; cells: number } | null {
  if (!released.revision || !released.scope || released.scope.whole) return null
  const colourways = [...new Set(released.cells.map((cell) => cell.colourway))]
  const sizes = [...new Set(released.cells.map((cell) => cell.size))]
  return { colourways: colourways.join(', '), sizes: sizes.join(', '), cells: released.cells.length }
}
