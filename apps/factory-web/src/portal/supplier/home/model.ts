import { Dec } from '@nexus/factory-domain/tax/decimal'
import { recordHref } from '../orders/model'
import type { Conversation, HomeRead, ShippableRead } from './api'

/**
 * SCR-189 — the supplier's Home (design portal.supplier.home; SCM-093, SCM-102), pure: the five counts and where each
 * opens, the next ten lines by date in the supplier's words, our last three messages and where to answer them, the PO a
 * "Confirm" row names. No price, cost or amount anywhere (Owner answer C2).
 */

export type SupplierKind = 'SUPPLIER' | 'SUBCONTRACTOR'

/** One tile: a count of the API's Home, its words (a key of `portal-supplier-orders`), the list it opens (null: not built). */
export interface TileDef {
  readonly key: string
  readonly label: string
  readonly hint: string
  /** The page the count belongs to: the person must be able to open it, else the tile is not drawn. */
  readonly permission: string
  readonly href: string | null
  readonly tone?: 'danger' | 'warning'
}

/**
 * The design's five ("To confirm · Due this week · Late (past the date, not announced) · Documents expiring in 30 days ·
 * Jobs in progress (subcontractors)"), each from a count the API has. A workshop's Home counts its jobs instead of POs.
 */
export function tilesFor(kind: SupplierKind, built: { orders: boolean; deliveries: boolean; documents: boolean; jobs: boolean }): TileDef[] {
  const documents: TileDef = { key: 'supplier_documents.expiring', label: 'tiles.expiring', hint: 'tiles.expiringHint', permission: 'portal.supplierDocuments.view', href: built.documents ? '/documents' : null, tone: 'warning' }
  if (kind === 'SUBCONTRACTOR') {
    const jobs = built.jobs ? '/jobs' : null
    return [
      { key: 'jobs.to_accept', label: 'tiles.toAccept', hint: 'tiles.toAcceptHint', permission: 'portal.jobs.view', href: jobs },
      { key: 'jobs.kit_to_confirm', label: 'tiles.kitToConfirm', hint: 'tiles.kitToConfirmHint', permission: 'portal.jobs.view', href: jobs },
      { key: 'jobs.ready_to_send_back', label: 'tiles.readyToSendBack', hint: 'tiles.readyToSendBackHint', permission: 'portal.jobs.view', href: jobs },
      { key: 'jobs.late', label: 'tiles.lateJobs', hint: 'tiles.lateJobsHint', permission: 'portal.jobs.view', href: jobs, tone: 'danger' },
      documents,
    ]
  }
  return [
    { key: 'purchase_orders.to_confirm', label: 'tiles.toConfirm', hint: 'tiles.toConfirmHint', permission: 'portal.purchaseOrders.view', href: built.orders ? '/orders?chip=TO_CONFIRM' : null },
    { key: 'deliveries.to_announce', label: 'tiles.dueThisWeek', hint: 'tiles.dueThisWeekHint', permission: 'portal.shipNotices.view', href: built.deliveries ? '/deliveries' : null },
    { key: 'purchase_orders.late', label: 'tiles.late', hint: 'tiles.lateHint', permission: 'portal.purchaseOrders.view', href: built.orders ? '/orders?chip=ALL' : null, tone: 'danger' },
    documents,
    { key: 'deliveries.on_the_way', label: 'tiles.onTheWay', hint: 'tiles.onTheWayHint', permission: 'portal.shipNotices.view', href: built.deliveries ? '/deliveries' : null },
  ]
}

export interface Tile extends TileDef {
  /** null: it could not be counted (shown as a dash, never 0). */
  readonly value: number | null
}

/** The tiles this person may open, with their counts (a tile whose page they cannot open is not drawn: fails closed). */
export function tilesOf(defs: readonly TileDef[], home: HomeRead | null, can: (permission: string) => boolean): Tile[] {
  const byKey = new Map((home?.counts ?? []).map((count) => [count.key, count.value]))
  return defs.filter((def) => can(def.permission)).map((def) => ({ ...def, value: byKey.get(def.key) ?? null }))
}

/** One of the next deliveries: an open line of a confirmed order, in the supplier's words. */
export interface UpcomingLine {
  readonly id: string
  readonly orderId: string
  readonly documentNumber: string
  readonly seq: number
  /** The supplier's article code first, else ours. */
  readonly code: string
  readonly name: string
  readonly colour: string | null
  /** Still to deliver, in the line's unit. */
  readonly open: string
  readonly uom: string
  readonly needDate: string
  readonly confirmedDate: string | null
  /** The day it is expected: the confirmed date, else the date asked. */
  readonly expected: string
  /** Announced on a ship notice already (some of it on its way). */
  readonly announced: boolean
  readonly late: boolean
}

export const UPCOMING_SHOWN = 10

/** The next ten open lines by the day they are expected (late ones first: their day has passed). */
export function upcomingOf(read: ShippableRead | null, today: string, shown = UPCOMING_SHOWN): UpcomingLine[] {
  if (!read) return []
  const lines = read.orders.flatMap((order) =>
    order.lines
      .filter((line) => new Dec(line.open || '0').gt(0))
      .map((line): UpcomingLine => {
        const expected = line.confirmedDate ?? line.needDate
        return {
          id: line.purchaseOrderLineId,
          orderId: order.id,
          documentNumber: order.documentNumber,
          seq: line.seq,
          code: line.supplierArticleCode ?? line.item.code,
          name: line.item.name,
          colour: line.colour,
          open: line.open,
          uom: line.uom,
          needDate: line.needDate,
          confirmedDate: line.confirmedDate,
          expected,
          announced: new Dec(line.inTransit || '0').gt(0),
          late: expected < today,
        }
      }),
  )
  return lines.sort((a, b) => a.expected.localeCompare(b.expected) || a.documentNumber.localeCompare(b.documentNumber) || a.seq - b.seq).slice(0, shown)
}

/** Where an upcoming line opens: its order's Lines tab with the line shown. */
export const upcomingHref = (prefix: string, line: Pick<UpcomingLine, 'orderId' | 'id'>): string => recordHref(prefix, line.orderId, 'lines', line.id)

/** Where "Reply" on one of our messages goes: the record's Messages (a PO's own page; any other record the frame's). */
export function replyHref(prefix: string, conversation: Pick<Conversation, 'record'>, purchaseOrderPage: boolean): string {
  const { type, id } = conversation.record
  if (type === 'PurchaseOrder' && purchaseOrderPage) return `${recordHref(prefix, id, 'messages')}#messages`
  return `${prefix}/open/${encodeURIComponent(type)}/${encodeURIComponent(id)}#messages`
}

/** The PO a task row asks to confirm (its link names it), or null. */
export function orderOfTask(row: { kind: string; href: string }): string | null {
  if (row.kind !== 'CONFIRM_PO') return null
  const match = /\/open\/PurchaseOrder\/([0-9a-f-]{36})/i.exec(row.href)
  return match ? match[1]! : null
}

/** The free-for-suppliers note, hidden once by this person on this device. */
export const freeNoteKey = (userId: string): string => `fw-portal-free-note:${userId}`

/** The Home's own kind: a supplier's, else a workshop's. */
export const supplierKindOf = (kinds: readonly string[]): SupplierKind => (kinds.includes('SUPPLIER') ? 'SUPPLIER' : 'SUBCONTRACTOR')
