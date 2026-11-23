import type { QuoteListRow } from '../api'
import type { Grains, QuoteAbilities } from '../model'
import { barFrom, NO_ACT, type Bar, type ManyRecord, type ManyWords } from '../../_shared/many-acts/model'
import { replyManyHeld } from '../../orders/list/reply-many' // F-CQ-304: Reply to N's own hold (one customer, at most 50)

/**
 * F-CQ-201 (customer page › Quotes & incoming, 10-design §6.1) — the Quotes list's bar, pure (the view draws it over the ticked rows;
 * the loops it opens live in acts.ts, the container's): Add task to N… · Cancel N quotes… · Ask for approval on N…, then More ▾: Make
 * the orders for N… · Send a new link to N…. F-CQ-304 (W3): "Ask <customer> about N…" leads it (threads.post with the customer's
 * to-dos: the Reply-to-N window with its to-do tick ON; without partners.tasks.manage it reads "Reply to <customer> on N…"), then Add
 * task · Cancel; More ▾: Ask for approval · Make the orders · Send a new link. Each act only with ITS right (Send a new
 * link: quotes.send AND the price grain — money wall); held with words only when none of the ticked quotes is one it runs on; the
 * next allowed act moves up. On Sales › Quotes and the customer's tab alike (one list).
 */

/** A quote row as the window names it (its number, its page). */
export type QuoteRecord = QuoteListRow & ManyRecord

export const quoteRecordOf = (row: QuoteListRow, prefix: string): QuoteRecord => ({ ...row, label: row.number, href: `${prefix}/sales/quotes/${encodeURIComponent(row.id)}` })

/** The states a quote is cancelled from (a closed quote is never cancelled). */
export const CANCELLABLE_QUOTES: readonly string[] = Object.freeze(['DRAFT', 'PENDING_APPROVAL', 'APPROVED', 'SENT'])

/** An accepted quote whose order waits and may be made now (C12: its reason NOT_MADE, or the PO number typed here, C36). */
const orderWaits = (row: Pick<QuoteListRow, 'status' | 'order'>): boolean => row.status === 'ACCEPTED' && row.order?.state === 'WAITS'
export const orderMakeable = (row: Pick<QuoteListRow, 'status' | 'order' | 'versionId'>): boolean => orderWaits(row) && !!row.versionId && (row.order?.reason === 'NOT_MADE' || row.order?.reason === 'PO_NUMBER_REQUIRED')

export const bo = (key: string, params?: Readonly<Record<string, string | number>>): ManyWords => ({ ns: 'before-order', key, ...(params ? { params } : {}) })

export type QuoteActKind = 'ask' /* F-CQ-304 */ | 'addTask' | 'cancel' | 'askApproval' | 'makeOrders' | 'newLink'

/** What the bar needs to know of the reader (each act its OWN right). */
export interface QuoteBarRights {
  readonly can: Pick<QuoteAbilities, 'manage' | 'send'>
  readonly grains: Pick<Grains, 'price'>
  /** tasks.manage (+ threads.read: a task lives in its record's thread). */
  readonly tasks: boolean
  /** orders.manage. */
  readonly orders: boolean
  /** F-CQ-304: threads.post — a reply into each quote's own conversation. */
  readonly threads: boolean
  /** F-CQ-304: partners.tasks.manage — the reply's to-do in the customer's list ("Ask"; without it the act reads "Reply"). */
  readonly customerTasks: boolean
}

export function quoteRightsOf(permissions: readonly string[], can: Pick<QuoteAbilities, 'manage' | 'send'>, grains: Pick<Grains, 'price'>): QuoteBarRights {
  const held = new Set(permissions)
  return { can, grains, tasks: held.has('tasks.manage'), orders: held.has('orders.manage'), threads: held.has('threads.post'), customerTasks: held.has('partners.tasks.manage') }
}

/** F-CQ-304: Ask / Reply's words and hold (the orders sheet's own: one customer, at most REPLY_MAX). */
function askAct(rights: QuoteBarRights, picked: readonly Pick<QuoteListRow, 'partyId'>[], customer: string | null): { id: string; right: boolean; label: ManyWords; held: ManyWords | null } {
  const count = picked.length
  const label: ManyWords = rights.customerTasks ? (customer ? bo('acts.label.askAbout', { customer, count }) : bo('acts.label.askAboutAny', { count })) : customer ? { ns: 'orders-sheet', key: 'bulk.reply', params: { customer, count } } : { ns: 'orders-sheet', key: 'bulk.replyAny', params: { count } }
  const held = replyManyHeld(picked, null, true)
  return { id: 'ask', right: rights.threads, label, held: held ? { ns: 'orders-sheet', key: held.key, ...(held.params ? { params: held.params } : {}) } : null }
}

/** The Quotes bar over the ticked quotes (F-CQ-201): ≤ 3 + More ▾; never an act for a missing right; held by state in words. */
export function quoteBarOf(rights: QuoteBarRights, picked: readonly Pick<QuoteListRow, 'status' | 'order' | 'versionId' | 'partyId'>[], customer: string | null): Bar {
  const count = picked.length
  const cancellable = picked.filter((row) => CANCELLABLE_QUOTES.includes(row.status)).length
  const drafts = picked.filter((row) => row.status === 'DRAFT').length
  const waits = picked.filter(orderMakeable).length
  const sent = picked.filter((row) => row.status === 'SENT').length
  return barFrom(
    [
      askAct(rights, picked, customer), // F-CQ-304: leads the bar
      { id: 'addTask', right: rights.tasks, label: { ns: 'orders-sheet', key: 'bulk.addTask', params: { count } }, held: null },
      { id: 'cancel', right: rights.can.manage, danger: true, label: { ns: 'sales', key: 'list.bulk.cancel', params: { count: cancellable } }, held: cancellable === 0 ? bo('acts.held.notOpen', { count }) : null },
      { id: 'askApproval', right: rights.can.manage, label: bo('acts.label.askApproval', { count: drafts }), held: drafts === 0 ? bo('acts.held.notDraft', { count }) : null },
      { id: 'makeOrders', right: rights.orders, label: bo('acts.label.makeOrders', { count: waits }), held: waits === 0 ? bo('acts.held.noWait', { count }) : null },
      // Money wall: a new link mails the priced PDF — only for a reader who may send quotes AND sees prices (else not drawn).
      { id: 'newLink', right: rights.can.send && rights.grains.price, label: bo('acts.label.newLink', { count: sent }), held: sent === 0 ? bo('acts.held.notSent', { count, customer: customer ?? '' }) : null },
    ],
    null,
    NO_ACT,
  )
}

