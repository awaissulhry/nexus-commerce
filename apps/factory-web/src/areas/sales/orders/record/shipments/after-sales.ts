import { COMPLAINT_CATEGORIES, COMPLAINT_SEVERITIES } from '@nexus/factory-domain/quality/complaints/rules'
import type { OrderComplaint, OrderReturn } from '../links/api'
import { COMPLAINT_TONE, RETURN_TONE, type LinksModel } from '../links/model'
import type { ShipmentRow } from './where'
import { word, wordOf, type ShipWord } from './word'

/**
 * F-OS-104 (order SHIPMENTS tab, 10-design §6; research H4; 13-backend B-OS-004) — section 3 "Complaints & returns" (#after-sales),
 * pure: what the customer reported about what we shipped, and where each case stands — ONE list, newest first, both kinds; each row
 * says which shipment it is about (a complaint names its shipment; a return line names none, so a return says "this order's
 * garments"), what (its pieces; a complaint's category and severity), its status ("Waiting for your yes" while a return waits to be
 * authorised) and what comes next (what the customer wants, the answer's due day, the replacement order). Closed cases fold behind
 * "Show N closed"; a list cut at its limit says so. Titled by what the reader may see (P0-B8): both rights "Complaints and returns",
 * returns only "Returns", complaints only "Complaints", neither: no section. The tab only lists a case: each lives on its own page.
 */

export type CaseTone = 'info' | 'warning' | 'danger' | 'success' | 'neutral'

// os-fx7 (W-13): a return names no shipment (its lines are the order's) — it is about the "Whole order", as 10-design §6 says.
export type CaseAbout = { readonly kind: 'shipment'; readonly id: string; readonly number: string; readonly onThisOrder: boolean } | { readonly kind: 'order' }

export interface CaseRow {
  readonly kind: 'return' | 'complaint'
  readonly id: string
  readonly number: string
  readonly about: CaseAbout
  /** Its pieces (a return) or its category and severity (a complaint); empty: not said. */
  readonly what: readonly ShipWord[]
  readonly status: ShipWord
  readonly tone: CaseTone
  /** A return that waits for its authorisation (the office's yes). */
  readonly waiting: boolean
  readonly next: readonly ShipWord[]
  readonly replacement: { readonly id: string; readonly number: string } | null
  /** When it came in (ISO). */
  readonly at: string
  readonly closed: boolean
}

export type AfterSalesModel =
  | { readonly state: 'hidden' }
  | { readonly state: 'loading' }
  | { readonly state: 'error'; readonly problem: string }
  | {
      readonly state: 'ready'
      readonly title: ShipWord
      readonly answer: readonly ShipWord[]
      readonly open: readonly CaseRow[]
      readonly closed: readonly CaseRow[]
      readonly truncated: boolean
    }

const CLOSED_COMPLAINT = new Set(['CLOSED'])
/** Only a category and a severity the catalogues know are said (an unknown code is left out, never shown as a code). */
const CATEGORIES = new Set<string>(COMPLAINT_CATEGORIES)
const SEVERITIES = new Set<string>(COMPLAINT_SEVERITIES)
const CLOSED_RETURN = new Set(['CLOSED', 'REJECTED', 'CANCELLED'])

export function complaintRow(row: OrderComplaint, shipments: readonly Pick<ShipmentRow, 'id'>[]): CaseRow {
  const shipment = row.shipment ?? null
  const what: ShipWord[] = []
  if (row.category && CATEGORIES.has(row.category)) what.push(wordOf('complaints', `category.${row.category}`))
  if (row.severity && SEVERITIES.has(row.severity)) what.push(wordOf('orders', `links.severity.${row.severity}`))
  return {
    kind: 'complaint',
    id: row.id,
    number: row.number,
    about: shipment ? { kind: 'shipment', id: shipment.id, number: shipment.number, onThisOrder: shipments.some((entry) => entry.id === shipment.id) } : { kind: 'order' },
    what,
    status: wordOf('orders', `links.complaintStatus.${row.status}`),
    tone: COMPLAINT_TONE[row.status] ?? 'neutral',
    waiting: false,
    next: row.answerDueOn && !CLOSED_COMPLAINT.has(row.status) ? [word('after.next.answerDue', undefined, { days: { day: row.answerDueOn } })] : [],
    replacement: null,
    at: row.receivedAt,
    closed: CLOSED_COMPLAINT.has(row.status),
  }
}

export function returnRow(row: OrderReturn): CaseRow {
  const next: ShipWord[] = []
  if (row.outcomeWanted && !CLOSED_RETURN.has(row.status)) next.push(word('after.next.wants', undefined, { words: { outcome: wordOf('orders', `links.wanted.${row.outcomeWanted}`) } }))
  return {
    kind: 'return',
    id: row.id,
    number: row.number,
    about: { kind: 'order' },
    what: row.pieces !== undefined ? [word('ships.carries.pieces', { count: row.pieces })] : [],
    status: wordOf('orders', `links.returnStatus.${row.status}`),
    tone: RETURN_TONE[row.status] ?? 'neutral',
    waiting: row.status === 'REQUESTED',
    next,
    replacement: row.replacementOrder ?? null,
    at: row.requestedAt,
    closed: CLOSED_RETURN.has(row.status),
  }
}

/** The section by what the reader may see; null lists (no right) are not drawn, nor counted. */
export function afterSalesOf(links: LinksModel | null | undefined, shipments: readonly Pick<ShipmentRow, 'id'>[]): AfterSalesModel {
  if (!links) return { state: 'hidden' }
  if (links.state === 'loading') return { state: 'loading' }
  if (links.state === 'error') return { state: 'error', problem: links.problem }
  const { complaints, returns, truncated } = links.links
  if (complaints === null && returns === null) return { state: 'hidden' }
  const title = complaints !== null && returns !== null ? wordOf('orders', 'links.title') : returns !== null ? wordOf('orders', 'links.returns.title') : wordOf('orders', 'links.complaints.title')
  const rows = [...(complaints ?? []).map((row) => complaintRow(row, shipments)), ...(returns ?? []).map(returnRow)].sort((a, b) => Date.parse(b.at) - Date.parse(a.at))
  const open = rows.filter((row) => !row.closed)
  const closed = rows.filter((row) => row.closed)
  const waiting = open.filter((row) => row.waiting).length
  const answer: ShipWord[] =
    open.length > 0
      ? [word('after.answer.open', { count: open.length }), ...(waiting > 0 ? [word('after.answer.waiting', { count: waiting })] : []), ...(closed.length > 0 ? [word('after.answer.closed', { count: closed.length })] : [])]
      : closed.length > 0
        ? [word('after.answer.nothingOpen'), word('after.answer.closed', { count: closed.length })]
        : [word('after.answer.empty')]
  return { state: 'ready', title, answer, open, closed, truncated: (complaints !== null && truncated?.complaints === true) || (returns !== null && truncated?.returns === true) }
}
