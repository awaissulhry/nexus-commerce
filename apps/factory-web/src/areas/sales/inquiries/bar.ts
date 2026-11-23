import { isOpen } from '@nexus/factory-domain/sales/inquiries/rules'
import type { IncomingRow } from './api'
import { barFrom, NO_ACT, type Bar, type ManyRecord, type ManyWords } from '../_shared/many-acts/model'

/**
 * F-CQ-201 (customer page › Quotes & incoming, 10-design §6.2; settle C10) — the Incoming list's bar, pure (on Sales › Incoming and
 * the customer's tab: one list): Assign N… · Ask <customer> about N… · Decline N…, then More ▾: Mark N lost… · Add task to N…
 * ("Reply to <customer> on N…" joins it in W3). Assign, Ask, Decline and Mark lost act on open REQUESTS only (each counts what it runs
 * on — never "Assign 0", P0-B6); a portal order is answered one at a time (its row's ⋯): one line under the bar says so. An act
 * without its right is not drawn; one blocked by the ticked rows' state is held with words.
 */

/** An Incoming row as the window names it (its number, its own place). */
export type IncomingRecord = IncomingRow & ManyRecord

export const bi = (key: string, params?: Readonly<Record<string, string | number>>): ManyWords => ({ ns: 'before-order', key, ...(params ? { params } : {}) })

export type IncomingActKind = 'assign' | 'askInfo' | 'decline' | 'lost' | 'addTask'

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
}

export function incomingBarOf(rights: IncomingBarRights, picked: readonly IncomingRow[], customer: string | null): Bar {
  const count = picked.length
  const open = openRequests(picked).length
  const askable = askableRequests(picked).length
  const portals = picked.filter((row) => row.kind === 'CATALOGUE_ORDER').length
  const notRequest = open === 0 ? bi('acts.held.notRequest', { count }) : open > BULK_REQUESTS_MAX ? { ns: 'sales-inquiries', key: 'bulk.tooMany', params: { max: BULK_REQUESTS_MAX } } : null
  return barFrom(
    [
      { id: 'assign', right: rights.manage, label: { ns: 'sales-inquiries', key: 'bulk.assign', params: { count: open } }, held: notRequest },
      { id: 'askInfo', right: rights.manage, label: customer ? bi('acts.label.askAbout', { customer, count: askable }) : bi('acts.label.askAboutAny', { count: askable }), held: askable === 0 ? bi('acts.held.notAskable', { count }) : null },
      { id: 'decline', right: rights.manage, danger: true, label: { ns: 'sales-inquiries', key: 'bulk.decline', params: { count: open } }, held: notRequest },
      { id: 'lost', right: rights.manage, label: bi('acts.label.markLost', { count: open }), held: open === 0 ? bi('acts.held.notRequest', { count }) : null },
      { id: 'addTask', right: rights.tasks, label: { ns: 'orders-sheet', key: 'bulk.addTask', params: { count } }, held: null },
    ],
    portals > 0 && rights.manage ? bi('acts.portalOne', { count: portals }) : null,
    NO_ACT,
  )
}
