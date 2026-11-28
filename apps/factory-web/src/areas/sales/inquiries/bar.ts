import { isOpen } from '@nexus/factory-domain/sales/inquiries/rules'
import type { IncomingRow } from './api'
import { catalogueConfirmPlan, type CatalogueFacts } from './catalogue-facts' // owb-of4: bulk Confirm of the Sent orders
import { barFrom, NO_ACT, type Bar, type ManyRecord, type ManyWords } from '../_shared/many-acts/model'
import { replyManyHeld, replyPortalHeld, type PortalState, type ReplyRecordType, type ReplyRow } from '../orders/list/reply-many' // F-CQ-304; cq fx5 W3-2

/**
 * F-CQ-201 (customer page › Quotes & incoming, 10-design §6.2; settle C10) — the Incoming list's bar, pure (on Sales › Incoming and
 * the customer's tab: one list): Assign N… · Ask <customer> about N… · Decline N…, then More ▾: Mark N lost… · Reply to <customer>
 * on N… (F-CQ-304: the Reply-to-N window on every ticked request and portal order, threads.post) · Add task to N…. Assign, Ask, Decline and Mark lost act on open REQUESTS only (each counts what it runs
 * on — never "Assign 0", P0-B6); a portal order is answered one at a time (its row's ⋯): one line under the bar says so. An act
 * without its right is not drawn; one blocked by the ticked rows' state is held with words.
 */

/** An Incoming row as the window names it (its number, its own place). */
export type IncomingRecord = IncomingRow & ManyRecord

export const bi = (key: string, params?: Readonly<Record<string, string | number>>): ManyWords => ({ ns: 'before-order', key, ...(params ? { params } : {}) })

export type IncomingActKind = 'assign' | 'askInfo' | 'decline' | 'lost' | 'reply' /* F-CQ-304 */ | 'addTask' | 'confirm' /* owb-of4 */

/** The ticked rows that are open requests (what Assign, Decline and Mark lost run on). */
export const openRequests = (rows: readonly IncomingRow[]): IncomingRow[] => rows.filter((row) => row.kind === 'REQUEST' && !!row.request && isOpen(row.request.status))
/** The ticked requests we may ask about (New or In progress: one already waiting for the customer is asked already). */
export const askableRequests = (rows: readonly IncomingRow[]): IncomingRow[] => rows.filter((row) => row.kind === 'REQUEST' && (row.request?.status === 'NEW' || row.request?.status === 'ASSIGNED'))

/** The most requests one Assign / Decline takes (the API's all-or-none commands). */
export const BULK_REQUESTS_MAX = 100

export interface IncomingBarRights {
  /** sales.inquiries.manage. */
  readonly manage: boolean
  /** tasks.manage. */
  readonly tasks: boolean
  /** F-CQ-304: threads.post — Reply to <customer> on N… (each record's own conversation). */
  readonly threads: boolean
  /** owb-of4: orders.manage — Confirm N (the Sent orders; text orders and the ones that hold are skipped and said). */
  readonly orders?: boolean
}

// ---- F-CQ-304: the Incoming rows as the Reply-to-N window takes them (a request's or a portal order's customer; a prospect has none).
/** A ticked row as a reply's record: its own conversation (Inquiry / PortalOrderRequest), its customer. */
export const replyRowOf = (row: Pick<IncomingRow, 'id' | 'number' | 'party' | 'companyId'>): ReplyRow => ({ id: row.id, number: row.number, customerRef: null, partyId: row.party?.id ?? '', partyName: row.party?.name ?? '', companyId: row.companyId ?? null })
/** Each row's own thread type (a request's Inquiry, a portal order's PortalOrderRequest). */
export const replyTypeOf = (rows: readonly Pick<IncomingRow, 'id' | 'kind'>[]): ((row: ReplyRow) => ReplyRecordType) => {
  const kinds = new Map(rows.map((row) => [row.id, row.kind]))
  return (row) => (kinds.get(row.id) === 'CATALOGUE_ORDER' ? 'PortalOrderRequest' : 'Inquiry')
}
// ---- end F-CQ-304

/** F-CQ-304: Reply's words and hold (the orders sheet's own; a prospect's row has no customer: "one customer" holds it). */
function replyAct(rights: IncomingBarRights, picked: readonly IncomingRow[], customer: string | null, portal?: PortalState | null): { id: string; right: boolean; label: ManyWords; held: ManyWords | null } {
  const count = picked.length
  // cq fx5 W3-2: … or the customer reads no portal (the host knows it): held in the requests' own words, never a window to write in.
  const held = replyManyHeld(picked.map(replyRowOf), null, true) ?? replyPortalHeld(portal, 'Inquiry', customer)
  return { id: 'reply', right: rights.threads, label: customer ? { ns: 'orders-sheet', key: 'bulk.reply', params: { customer, count } } : { ns: 'orders-sheet', key: 'bulk.replyAny', params: { count } }, held: held ? { ns: 'orders-sheet', key: held.key, ...(held.params ? { params: held.params } : {}) } : null }
}

export function incomingBarOf(rights: IncomingBarRights, picked: readonly IncomingRow[], customer: string | null, /** cq fx5 W3-2 */ portal?: PortalState | null, /** owb-of4: the Sent orders' facts */ facts?: ReadonlyMap<string, CatalogueFacts>): Bar {
  const count = picked.length
  // owb-of4 step 1: Confirm N over the ticked Sent orders (first in the bar when it may run); the skipped ones are said in the note.
  const confirm = rights.orders && facts ? catalogueConfirmPlan(picked, facts) : null
  const confirmAct = confirm && (confirm.go.length > 0 || confirm.text + confirm.held > 0) ? [{ id: 'confirm', right: true, label: { ns: 'orders-sheet', key: 'incoming.bulkConfirm', params: { count: confirm.go.length } }, held: confirm.go.length === 0 ? { ns: 'orders-sheet', key: 'incoming.bulkNone' } : null }] : []
  const confirmNote = confirm && confirm.text + confirm.held > 0 ? { ns: 'orders-sheet', key: 'incoming.bulkSkips', params: { text: confirm.text, held: confirm.held } } : null
  const open = openRequests(picked).length
  const askable = askableRequests(picked).length
  const portals = picked.filter((row) => row.kind === 'CATALOGUE_ORDER').length
  const notRequest = open === 0 ? bi('acts.held.notRequest', { count }) : open > BULK_REQUESTS_MAX ? { ns: 'sales-inquiries', key: 'bulk.tooMany', params: { max: BULK_REQUESTS_MAX } } : null
  return barFrom(
    [
      ...confirmAct,
      { id: 'assign', right: rights.manage, label: { ns: 'sales-inquiries', key: 'bulk.assign', params: { count: open } }, held: notRequest },
      { id: 'askInfo', right: rights.manage, label: customer ? bi('acts.label.askAbout', { customer, count: askable }) : bi('acts.label.askAboutAny', { count: askable }), held: askable === 0 ? bi('acts.held.notAskable', { count }) : null },
      { id: 'decline', right: rights.manage, danger: true, label: { ns: 'sales-inquiries', key: 'bulk.decline', params: { count: open } }, held: notRequest },
      { id: 'lost', right: rights.manage, label: bi('acts.label.markLost', { count: open }), held: open === 0 ? bi('acts.held.notRequest', { count }) : null },
      // F-CQ-304: Reply to <customer> on N… — every ticked row (one customer, at most 50: the window's own hold, in its words).
      replyAct(rights, picked, customer, portal),
      { id: 'addTask', right: rights.tasks, label: { ns: 'orders-sheet', key: 'bulk.addTask', params: { count } }, held: null },
    ],
    confirmNote ?? (portals > 0 && rights.manage && confirmAct.length === 0 ? bi('acts.portalOne', { count: portals }) : null),
    NO_ACT,
  )
}
