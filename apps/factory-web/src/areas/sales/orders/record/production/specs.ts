import type { StyleView } from '../../../../products/styles/api'
import type { Order } from '../../api'
import type { Work } from '../overview/api'

/**
 * F-PT-401 (order PRODUCTION tab, 10-design §7 "What we make it to"; bugs B33–B35; lead settle L1 "Pattern v{n}"; R15 cut: composed in
 * the browser) — "Our pattern", without a screen: one row per style AND per pinned revision (B33), each with the pattern it is made
 * to and whether that is still the right one. Three reads meet: the order lines' pin (`styleRevision`), each work order's spec
 * (B-PT-004, the production read; never its English message) and the style's revisions (`GET /product/styles/:id`, product.styles.view,
 * read when the section comes into view — each style alone). Revision numbers only; a pin never moves here ("Move to v3" is later).
 */

type Line = Order['lines'][number]
type WorkRow = Work['workOrders'][number]
type Revisions = Pick<StyleView, 'revisions'>

/** One style's read: its revisions (null while read, failed, or not read: no right). */
export interface StylePart {
  readonly value: Revisions | null
  readonly problem: string | null
}

export type SpecState =
  | { readonly kind: 'inForce'; readonly revision: number }
  | { readonly kind: 'replaced'; readonly revision: number; readonly by: number | null; readonly on: string | null }
  | { readonly kind: 'withdrawn'; readonly revision: number }
  | { readonly kind: 'notApproved'; readonly revision: number }
  | { readonly kind: 'notFixedUses'; readonly workOrder: string; readonly revision: number }
  | { readonly kind: 'notFixedWill'; readonly revision: number }
  | { readonly kind: 'notFixed' }

/** A work order of this style made to an older pattern than the one in force, and what was decided for it (an ECO). */
export interface OlderWork {
  readonly id: string
  readonly number: string
  readonly revision: number | null
  readonly newer: { readonly revision: number; readonly on: string | null } | null
  readonly decision: { readonly disposition: string; readonly changeOrder: string } | null
}

export interface SpecRow {
  readonly key: string
  readonly styleId: string
  readonly code: string
  readonly name: string
  readonly lineIds: readonly string[]
  readonly picture: Line['picture'] | null
  readonly state: SpecState
  /** The pattern in force's change note (shown on a replaced row: what changed). */
  readonly changeNote: { readonly revision: number; readonly note: string } | null
  /** The in-force revision's id (the style page's versions tab opens on it); null: not read. */
  readonly releasedId: string | null
  readonly older: readonly OlderWork[]
  /** A replaced or withdrawn pattern, or a work order on an older one with no decision yet. */
  readonly needsDecision: boolean
  /** The style's read: not asked (no right / not in view), reading, failed (its own Try again), read. */
  readonly read: 'none' | 'reading' | 'failed' | 'read'
}

/** The style a work order makes: by its style code (the production read names a style by code and name). */
const sameStyle = (row: WorkRow, line: Line) => !!row.style && !!line.style && row.style.code === line.style.code

const day = (instant: string | null): string | null => (instant ? instant.slice(0, 10) : null)

export function specRowsOf(order: Pick<Order, 'lines'>, work: readonly WorkRow[] | null | undefined, styles: ReadonlyMap<string, StylePart>): SpecRow[] {
  const goods = order.lines.filter((line) => line.kind !== 'FEE' && line.styleId && line.style)
  const groups = new Map<string, Line[]>()
  for (const line of goods) {
    const key = `${line.styleId}:${line.styleRevision?.revision ?? '-'}`
    groups.set(key, [...(groups.get(key) ?? []), line])
  }
  return [...groups.entries()].map(([key, lines]) => {
    const first = lines[0]!
    const part = styles.get(first.styleId) ?? null
    const revisions = part?.value?.revisions ?? null
    const released = revisions?.find((revision) => revision.status === 'RELEASED') ?? null
    const rows = (work ?? []).filter((row) => sameStyle(row, first) && !row.sharedWithOtherCustomers)
    const newerOfWork = rows.map((row) => row.spec?.newer ?? null).find((newer) => newer !== null) ?? null
    const pin = first.styleRevision
    let state: SpecState
    if (pin) {
      if (pin.status === 'DRAFT') state = { kind: 'notApproved', revision: pin.revision }
      else if (revisions) state = released ? (released.revision === pin.revision ? { kind: 'inForce', revision: pin.revision } : { kind: 'replaced', revision: pin.revision, by: released.revision, on: day(released.releasedAt) }) : { kind: 'withdrawn', revision: pin.revision }
      // Not read (no product.styles.view, or not yet): the pin's own status, the newer one a work order names.
      else state = pin.status === 'RELEASED' ? { kind: 'inForce', revision: pin.revision } : { kind: 'replaced', revision: pin.revision, by: newerOfWork?.revision ?? null, on: newerOfWork?.releasedOn ?? null }
    } else {
      const uses = [...rows].sort((a, b) => a.number.localeCompare(b.number, 'en', { numeric: true })).find((row) => row.spec?.revision)
      const inForce = released?.revision ?? newerOfWork?.revision ?? null
      state = uses?.spec?.revision ? { kind: 'notFixedUses', workOrder: uses.number, revision: uses.spec.revision.revision } : inForce !== null ? { kind: 'notFixedWill', revision: inForce } : { kind: 'notFixed' }
    }
    const older: OlderWork[] = rows
      .filter((row) => row.spec?.state === 'NEWER_RELEASED')
      .map((row) => ({ id: row.id, number: row.number, revision: row.spec?.revision?.revision ?? null, newer: row.spec?.newer ? { revision: row.spec.newer.revision, on: row.spec.newer.releasedOn } : null, decision: row.spec?.decision ?? null }))
    return {
      key,
      styleId: first.styleId,
      code: first.style!.code,
      name: first.style!.name,
      lineIds: lines.map((line) => line.id),
      picture: lines.find((line) => line.picture)?.picture ?? null,
      state,
      changeNote: state.kind === 'replaced' && released?.changeNote ? { revision: released.revision, note: released.changeNote } : null,
      releasedId: released?.id ?? null,
      older,
      needsDecision: state.kind === 'replaced' || state.kind === 'withdrawn' || older.some((row) => row.decision === null),
      read: !part ? 'none' : part.value ? 'read' : part.problem ? 'failed' : 'reading',
    }
  })
}

/** The styles to read (at most 10, the order's own order; more is said, never read). */
export const STYLES_READ_MAX = 10
export function styleIdsOf(order: Pick<Order, 'lines'>): { readonly ids: readonly string[]; readonly more: number } {
  const ids = [...new Set(order.lines.filter((line) => line.kind !== 'FEE' && line.styleId).map((line) => line.styleId))]
  return { ids: ids.slice(0, STYLES_READ_MAX), more: Math.max(0, ids.length - STYLES_READ_MAX) }
}

/** The state tag's tone: in force success, a pattern to decide warning, withdrawn danger, the rest neutral. */
export const specTone = (state: SpecState): 'success' | 'warning' | 'danger' | 'neutral' =>
  state.kind === 'inForce' ? 'success' : state.kind === 'replaced' || state.kind === 'notApproved' ? 'warning' : state.kind === 'withdrawn' ? 'danger' : 'neutral'
