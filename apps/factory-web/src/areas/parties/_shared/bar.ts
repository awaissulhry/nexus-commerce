import type { ReactNode } from 'react'
import type { PartyRow } from './api'
import { BULK_MAX, bulkReach, type BulkKind, type ListCan, type Side } from './model'

/**
 * F-CL-103 (customers list plan §1, 13-backend §8.2, settles T8 / T9 / T16): the bar of a selection on the shared list, pure —
 * it READS like the Work tab's: at most 3 buttons with words (the two first acts by their order, then the frame's Export N
 * always third; without Export a third act moves up), the rest in ONE More ▾ right of Export, last before ✕. An act the reader
 * has no right for is not given (hidden); an act the state or a cap blocks stays where its order puts it, held with words —
 * a reach of 0 too ("None of the selected has an EU VAT number"), never a "… for 0".
 */

export interface BarAct {
  readonly id: string
  /** Its place: the lowest orders are promoted (Customers: Add task 10 · Set supervisor 20 · VIES 40 · Block 50 · Archive 60). */
  readonly order: number
  readonly label: string
  readonly icon: ReactNode
  /** Why it cannot run now, in words (a state or a cap); null: it may. A missing right is never held: such an act is left out. */
  readonly held: string | null
  readonly run: () => void
  readonly tone?: 'danger'
}

/** The promoted acts (2 beside Export N, 3 without it) and the rest for More ▾, each list in its order. */
export function barOf<A extends { readonly order: number }>(acts: readonly A[], exportShown: boolean): { promoted: A[]; more: A[] } {
  const sorted = [...acts].sort((a, b) => a.order - b.order)
  const room = exportShown ? 2 : 3
  return { promoted: sorted.slice(0, room), more: sorted.slice(room) }
}

/** The shared list's own acts on a selection. */
export type SharedActId = 'vies' | 'block' | 'archive'

/** Their places: Suppliers' Check VIES leads (then its Request documents, 20); the customers' leads after Add task and Set supervisor. */
export const SHARED_ORDER: Readonly<Record<Side, Readonly<Record<SharedActId, number>>>> = Object.freeze({
  customers: Object.freeze({ vies: 40, block: 50, archive: 60 }),
  suppliers: Object.freeze({ vies: 10, block: 50, archive: 60 }),
})

export interface SharedAct {
  readonly id: SharedActId
  readonly order: number
  /** The selected rows it runs on, and the rest (each with its why: whyNotOf). */
  readonly reach: readonly PartyRow[]
  readonly skipped: readonly PartyRow[]
  /** Why it is held now (a `parties` key with its params), or null. */
  readonly held: { readonly key: string; readonly params?: Readonly<Record<string, number>> } | null
}

/** The shared acts a reader may use on these rows (each by its OWN right: VIES parties.vies, Block parties.block, Archive parties.manage). */
export function sharedActsOf(side: Side, can: ListCan, rows: readonly PartyRow[]): SharedAct[] {
  const out: SharedAct[] = []
  const add = (id: SharedActId, kind: BulkKind, allowed: boolean, none: string) => {
    if (!allowed) return
    const { reach, skipped } = bulkReach(kind, rows)
    const held = reach.length === 0 ? { key: none } : reach.length > BULK_MAX ? { key: 'held.bulkMax', params: { max: BULK_MAX } } : null
    out.push({ id, order: SHARED_ORDER[side][id], reach, skipped, held })
  }
  add('vies', 'vies', can.vies, 'held.noEuNumber')
  add('block', 'block', can.block, 'held.nothingToBlock')
  add('archive', 'archive', can.manage, 'held.nothingToArchive')
  return out
}

/** Why a selected row is not on a run, in words: a key and its catalogue (one word per thing: the parties' own where it exists). */
export interface WhyNot {
  readonly ns: 'parties' | 'customers-list'
  readonly key: string
}

export function whyNotOf(kind: BulkKind, side: Side, row: Pick<PartyRow, 'status'>): WhyNot {
  if (kind === 'archive') return row.status === 'BLOCKED' ? { ns: 'parties', key: 'held.archiveBlocked' } : { ns: 'customers-list', key: 'p2.why.archived' }
  if (row.status === 'ARCHIVED') return { ns: 'parties', key: 'held.archived' }
  if (kind === 'vies') return { ns: 'customers-list', key: 'p2.why.noNumber' }
  return row.status === 'BLOCKED' ? { ns: 'customers-list', key: 'p2.why.blocked' } : { ns: 'customers-list', key: `p2.why.prospect.${side}` }
}
