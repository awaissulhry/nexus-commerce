import { z } from 'zod'
import { businessDate, id, input, instant, output } from '../../core/contracts'
import type { ChangeOrderStatus, ChangeRequestStatus, OrderTile, RequestTile } from './rules'

/**
 * B-W2b-244 (Changes & versions, SCR-117): the two reads the screens need beside B-W2b-226's lists, added in the smallest
 * marked way (apps/factory-api modules/product/changes/screens.ts).
 *
 *   GET /product/released-versions                       product.changes.view: style revisions released, newest first
 *                                                        (design changes.released), each with the change order that
 *                                                        released it (if any) and the revision it replaced
 *   GET /product/change-orders/:id/approver-options      product.changes.manage: who may be named an approver (ACTIVE
 *                                                        office people holding product.changes.approve over the change
 *                                                        order's company by their live roles; never its author)
 *
 * People as ids in the list (the screens say "You" / "A colleague": no name in a list); names only in the approver picker,
 * which belongs to one change order.
 */

export const releasedQuery = input({
  styleId: id().optional(),
  /** A style's code or name, or the change order's number. */
  q: z.string().trim().min(1).max(100).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
})
export type ReleasedQuery = z.output<typeof releasedQuery>

export const releasedRow = output({
  style: output({ id: id(), code: z.string(), name: z.string() }),
  revision: output({ id: id(), revision: z.number().int(), status: z.string() }),
  /** The released revision it replaced (the change order's, else the style's newest earlier released or obsolete one). */
  previous: output({ id: id(), revision: z.number().int() }).nullable(),
  releasedAt: instant(),
  releasedById: id().nullable(),
  effectiveFrom: businessDate().nullable(),
  /** The revision's own "what changed". */
  changeNote: z.string().nullable(),
  /** The change order that released it; null: released without one (W1's release, before change control). */
  changeOrder: output({ id: id(), number: z.string(), title: z.string() }).nullable(),
})
export type ReleasedRow = z.output<typeof releasedRow>

export const releasedList = output({ rows: z.array(releasedRow), complete: z.boolean() })
export type ReleasedList = z.output<typeof releasedList>

export const approverOptionsView = output({
  people: z.array(output({ id: id(), name: z.string() })),
  /** The change order's author, who is never offered (four eyes). */
  authorId: id(),
})
export type ApproverOptionsView = z.output<typeof approverOptionsView>

// ---- the changes list: one list over three reads (the web page and its export source) -------------------------------------

/**
 * The page lists change requests, change orders and the SMV changes waiting from Operations (B-W2b-215) as one list (design
 * changes.grid "Kind": request · order · SMV change). Its saved rows (design savedRows; the tiles are four of them) say which
 * of the three reads each takes, with which of B-W2b-226's own tiles and statuses; `kind` keeps one read only.
 */
export const CHANGE_ROWS = ['TO_TRIAGE', 'MINE_TO_APPROVE', 'TO_RELEASE', 'RELEASED_THIS_MONTH', 'RELEASED', 'REJECTED', 'ALL'] as const
export type ChangeRows = (typeof CHANGE_ROWS)[number]
/** The design's tiles, in its order (each a saved row). */
export const CHANGE_TILES = ['TO_TRIAGE', 'MINE_TO_APPROVE', 'TO_RELEASE', 'RELEASED_THIS_MONTH'] as const satisfies readonly ChangeRows[]
export type ChangeTile = (typeof CHANGE_TILES)[number]
export const CHANGE_KINDS = ['request', 'order', 'smv'] as const
export type ChangeKind = (typeof CHANGE_KINDS)[number]

export interface ChangeLists {
  /** The requests' read (null: not listed under these rows; its counts are still read for the tiles). */
  readonly requests: { readonly tile: RequestTile; readonly status?: ChangeRequestStatus } | null
  readonly orders: { readonly tile: OrderTile; readonly status?: ChangeOrderStatus } | null
  /** The SMV changes waiting: every one, only those the reader may decide, or none. */
  readonly smv: 'all' | 'mine' | null
}

const LISTS: Readonly<Record<ChangeRows, ChangeLists>> = Object.freeze({
  TO_TRIAGE: { requests: { tile: 'TO_TRIAGE' }, orders: null, smv: null },
  MINE_TO_APPROVE: { requests: null, orders: { tile: 'MINE_TO_APPROVE' }, smv: 'mine' },
  TO_RELEASE: { requests: null, orders: { tile: 'TO_RELEASE' }, smv: null },
  RELEASED_THIS_MONTH: { requests: null, orders: { tile: 'RELEASED_THIS_MONTH' }, smv: null },
  RELEASED: { requests: { tile: 'ALL', status: 'DONE' }, orders: { tile: 'ALL', status: 'RELEASED' }, smv: null },
  REJECTED: { requests: { tile: 'ALL', status: 'REJECTED' }, orders: { tile: 'ALL', status: 'REJECTED' }, smv: null },
  ALL: { requests: { tile: 'ALL' }, orders: { tile: 'ALL' }, smv: 'all' },
})

/** Which reads a list of these rows (and maybe one kind) takes. */
export function changeListsOf(rows: ChangeRows, kind: ChangeKind | null): ChangeLists {
  const lists = LISTS[rows]
  return {
    requests: kind === null || kind === 'request' ? lists.requests : null,
    orders: kind === null || kind === 'order' ? lists.orders : null,
    smv: kind === null || kind === 'smv' ? lists.smv : null,
  }
}

/** A row's id in the one list (the web list frame's rowId and an export's selected ids): its kind and its record. */
export const changeRowId = (kind: ChangeKind, recordId: string): string => `${kind}:${recordId}`
