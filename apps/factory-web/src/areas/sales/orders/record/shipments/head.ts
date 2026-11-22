import type { Order } from '../../api'
import type { Deliveries } from './delivered/api'
import type { WhereModel } from './where'
import { word, type ShipWord } from './word'

/**
 * F-OS-101 (order SHIPMENTS tab, 10-design §3) — the tab's ONE answer above its three sections (no card, no h2), pure: where the order
 * stands ("Partly shipped · 40 of 110 garments have left"), what can go and what is still to make, then what needs a person on its
 * shipments (came back and not received, on hold, a tracking problem, on its way and when it is expected) and what was closed short.
 * Its tone follows the case: delivered success, a hold / problem / return warning, else info.
 */

export type HeadTone = 'info' | 'success' | 'warning' | 'neutral'

export interface HeadModel {
  readonly tone: HeadTone
  readonly parts: readonly ShipWord[]
}

/** At most this many shipment facts after the order's own (the line stays one line). */
const MAX_FACTS = 3

export function headOf(order: Pick<Order, 'status' | 'progress' | 'chain'>, where: WhereModel, deliveries: Deliveries | null): HeadModel {
  if (where.state !== 'goods') return { tone: 'neutral', parts: [word(`where.state.${where.state}`)] }
  const parts: ShipWord[] = []
  let tone: HeadTone = 'info'
  const delivered = order.status === 'DELIVERED' ? (deliveries?.order.deliveredAt ?? null) : null
  if (delivered) {
    parts.push(word('head.delivered', undefined, { instants: { day: delivered } }))
    tone = 'success'
  } else if (where.allOut) parts.push(word('head.inFull'))
  else if (order.progress.shipped > 0) parts.push(word('head.partly', { shipped: order.progress.shipped, ordered: order.progress.ordered }))
  else parts.push(word('head.none'))
  if (where.mode === 'counted' && !where.allOut) {
    if (where.totals.ready > 0) parts.push(word('head.ready', { count: where.totals.ready }))
    if (where.totals.making > 0) parts.push(word('head.making', { count: where.totals.making }))
  }
  const byId = new Map((deliveries?.shipments ?? []).map((row) => [row.id, row]))
  const facts: ShipWord[] = []
  for (const row of order.chain.shipments) {
    if (row.status === 'CANCELLED') continue
    const delivery = byId.get(row.id) ?? null
    if (row.status === 'RETURNED' && delivery?.returned?.received !== true) {
      facts.push(delivery?.returned?.at ? word('head.backOn', { number: row.number }, { instants: { day: delivery.returned.at } }) : word('head.back', { number: row.number }))
      tone = 'warning'
    } else if ((row.status === 'DRAFT' || row.status === 'PACKED') && (row.holds ?? []).length > 0) {
      facts.push(word('head.held', { number: row.number }))
      tone = 'warning'
    } else if (row.status === 'SHIPPED' && delivery && delivery.openProblems > 0) {
      facts.push(word('head.problem', { number: row.number, count: delivery.openProblems }))
      tone = 'warning'
    } else if (row.status === 'SHIPPED') facts.push(row.expectedDeliveryAt ? word('head.expected', { number: row.number }, { instants: { day: row.expectedDeliveryAt } }) : word('head.onItsWay', { number: row.number }))
  }
  parts.push(...facts.slice(0, MAX_FACTS))
  if (where.totals.closed > 0) parts.push(word('head.closed', { count: where.totals.closed }))
  return { tone, parts }
}
