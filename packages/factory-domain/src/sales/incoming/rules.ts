import { DECLINE_WORDS, SOURCE_WORDS, STATUS_WORDS, type DeclineReason, type InquiryStatus } from '../inquiries/rules'
import { REQUEST_STATUS_WORDS as CATALOGUE_STATUS_WORDS } from '../portal-ordering/rules'
import { KIND_WORDS as CHANGE_KIND_WORDS, REQUEST_STATUS_WORDS as CHANGE_STATUS_WORDS } from '../change-requests/rules'

/** Words in both languages. */
export interface Words {
  readonly it: string
  readonly en: string
}

/**
 * Sales › Incoming over every door (B-TH-039; threads plan G2, L2-G07; O-SAL-INQ-LIST.list / .tiles / .band, O-HOME-TODAY.incoming,
 * O-HOME-APV.list), pure: the kinds of row one list holds, its tiles and saved rows, and what each kind counts in them.
 *
 *   REQUEST          an inquiry (any door: portal, mail, office, phone, fair) — sales.inquiries.view over its company and customer
 *   CATALOGUE_ORDER  a catalogue order the customer SENT from its portal (never a draft: it is theirs) — orders.view
 *   CHANGE_REQUEST   a customer's change or cancel request on a confirmed order — orders.view; agreement T3 with the production
 *                    lane: only the kinds CHANGE and CANCEL (their RUSH, HOLD, RESUME, SPLIT_SHIPMENT, SAMPLE_ROUND are answered in
 *                    Home › Approvals alone), and such a row opens the Approvals review window (`opens.place` APPROVALS)
 *
 * The tiles (the five of the design first, then the saved rows of "Rows ▾"), per kind:
 *
 *   tile              REQUEST                          CATALOGUE_ORDER              CHANGE_REQUEST
 *   NEW               NEW                              SENT (not decided yet)       OPEN
 *   WAITING_US        NEW/ASSIGNED > 1 working day     SENT > 1 working day         OPEN > 1 working day
 *   WAITING_CUSTOMER  NEED_INFO                        —                            —
 *   QUOTED_THIS_WEEK  QUOTED, closed this week         ACCEPTED as a quote this wk  —
 *   MINE              open, assigned to the reader     SENT, its thread owned by    —
 *                                                      the reader (B-TH-028)
 *   OPEN              NEW, ASSIGNED, NEED_INFO         SENT                         OPEN
 *   QUOTED            QUOTED                           ACCEPTED as a quote          —
 *   ORDERED           ORDERED                          ACCEPTED as an order         —
 *   DECLINED          DECLINED (not "Not an order")    REFUSED                      REFUSED
 *   NOT_AN_ORDER      DECLINED as NOT_AN_ORDER         —                            —
 *   LOST              LOST                             WITHDRAWN by the customer    WITHDRAWN by the customer
 *   ALL               every row                        every row (never a draft)    every row
 *
 * A change request the office ACCEPTED is in ALL only (its order changed; nothing of Incoming's waits).
 */

export const INCOMING_KINDS = ['REQUEST', 'CATALOGUE_ORDER', 'CHANGE_REQUEST'] as const
export type IncomingKind = (typeof INCOMING_KINDS)[number]

/** The kinds of change request Incoming lists (agreement T3): every other kind is answered in Home › Approvals alone. */
export const INCOMING_CHANGE_KINDS = ['CHANGE', 'CANCEL'] as const
export type IncomingChangeKind = (typeof INCOMING_CHANGE_KINDS)[number]

export const INCOMING_TILES = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'MINE', 'OPEN', 'QUOTED', 'ORDERED', 'DECLINED', 'NOT_AN_ORDER', 'LOST', 'ALL'] as const
export type IncomingTile = (typeof INCOMING_TILES)[number]

/** The design's five tiles (O-SAL-INQ-LIST.tiles-F01), counted under the same filters as the list. */
export const INCOMING_DESIGN_TILES = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'QUOTED_THIS_WEEK', 'MINE'] as const satisfies readonly IncomingTile[]

/** The rows that wait (the queue): oldest first; every other tile newest first. */
export const QUEUE_TILES: readonly IncomingTile[] = ['NEW', 'WAITING_US', 'WAITING_CUSTOMER', 'MINE', 'OPEN']

/** Which kinds can have a row in a tile at all (a kind that cannot is not read for it). */
export const TILE_KINDS: Readonly<Record<IncomingTile, readonly IncomingKind[]>> = Object.freeze({
  NEW: INCOMING_KINDS,
  WAITING_US: INCOMING_KINDS,
  WAITING_CUSTOMER: ['REQUEST'],
  QUOTED_THIS_WEEK: ['REQUEST', 'CATALOGUE_ORDER'],
  MINE: ['REQUEST', 'CATALOGUE_ORDER'],
  OPEN: INCOMING_KINDS,
  QUOTED: ['REQUEST', 'CATALOGUE_ORDER'],
  ORDERED: ['REQUEST', 'CATALOGUE_ORDER'],
  DECLINED: INCOMING_KINDS,
  NOT_AN_ORDER: ['REQUEST'],
  LOST: INCOMING_KINDS,
  ALL: INCOMING_KINDS,
})

export const INCOMING_LIMITS = Object.freeze({
  /** The most rows one page brings. */
  list: 200,
  /** The most open rows of one kind whose waiting time one read computes (beyond it WAITING_US is partial: `complete` false). */
  waitingRead: 1000,
  q: 100,
})

/** The kind's words (the kind mark of a row, the export's words). */
export const KIND_WORDS: Readonly<Record<IncomingKind, Words>> = Object.freeze({
  REQUEST: { it: 'Richiesta', en: 'Request' },
  CATALOGUE_ORDER: { it: 'Ordine dal catalogo', en: 'Catalogue order' },
  CHANGE_REQUEST: { it: 'Richiesta di modifica', en: 'Change request' },
})

/** Whether a row of this kind in this state still waits for the office (the OPEN tile). */
export function isOpenState(kind: IncomingKind, state: string): boolean {
  if (kind === 'REQUEST') return state === 'NEW' || state === 'ASSIGNED' || state === 'NEED_INFO'
  if (kind === 'CATALOGUE_ORDER') return state === 'SENT'
  return state === 'OPEN'
}

/** Whether a row of this kind in this state waits for US (not for the customer): the waiting time is counted then. */
export function waitsOnUs(kind: IncomingKind, state: string): boolean {
  if (kind === 'REQUEST') return state === 'NEW' || state === 'ASSIGNED'
  return isOpenState(kind, state)
}

/** The words of a row's state, in both languages: the kind's own (a request's decline with its reason). */
export function stateWords(kind: IncomingKind, state: string, declineReason: DeclineReason | null = null, changeKind: IncomingChangeKind | null = null): Words {
  if (kind === 'REQUEST') {
    const words = STATUS_WORDS[state as InquiryStatus] ?? { it: state, en: state }
    if (state !== 'DECLINED' || declineReason === null) return words
    const reason = DECLINE_WORDS[declineReason]
    return { it: `${words.it} · ${reason.it}`, en: `${words.en} · ${reason.en}` }
  }
  if (kind === 'CATALOGUE_ORDER') return CATALOGUE_STATUS_WORDS[state as keyof typeof CATALOGUE_STATUS_WORDS] ?? { it: state, en: state }
  const words = CHANGE_STATUS_WORDS[state as keyof typeof CHANGE_STATUS_WORDS] ?? { it: state, en: state }
  return changeKind ? { it: `${CHANGE_KIND_WORDS[changeKind].it} · ${words.it}`, en: `${CHANGE_KIND_WORDS[changeKind].en} · ${words.en}` } : words
}

/** How it came, in words: a request's own source; a catalogue order and a change request come from the portal. */
export const sourceWordsOf = (kind: IncomingKind, source: keyof typeof SOURCE_WORDS | null): Words => (kind === 'REQUEST' && source ? SOURCE_WORDS[source] : SOURCE_WORDS.PORTAL)

/** The summary of a change request (no words of its own beyond the customer's note): what it asks of which order. */
export function changeSummaryOf(kind: IncomingChangeKind, order: string, lines: number, sizes: number, locale: 'it' | 'en' = 'en'): string {
  const what = CHANGE_KIND_WORDS[kind][locale]
  if (kind === 'CANCEL' && lines === 0) return locale === 'it' ? `${what} dell'ordine ${order}` : `${what} of order ${order}`
  const parts = locale === 'it' ? `${lines} ${lines === 1 ? 'riga' : 'righe'}${sizes > 0 ? `, ${sizes} ${sizes === 1 ? 'taglia' : 'taglie'}` : ''}` : `${lines} ${lines === 1 ? 'line' : 'lines'}${sizes > 0 ? `, ${sizes} ${sizes === 1 ? 'size' : 'sizes'}` : ''}`
  return lines === 0 ? (locale === 'it' ? `${what} dell'ordine ${order}` : `${what} of order ${order}`) : `${what} · ${order} · ${parts}`
}

/** The cursor of a page: the last row's instant, kind and id (the list's order is (at, kind, id), ascending or descending). */
export interface IncomingCursor {
  readonly at: string
  readonly kind: IncomingKind
  readonly id: string
}

/** The kinds in their tie order (rows at the same instant). */
export const KIND_RANK: Readonly<Record<IncomingKind, number>> = Object.freeze({ REQUEST: 0, CATALOGUE_ORDER: 1, CHANGE_REQUEST: 2 })

/** -1, 0, 1: a before b in ascending (at, kind, id) order. */
export function compareKeys(a: IncomingCursor, b: IncomingCursor): number {
  if (a.at !== b.at) return a.at < b.at ? -1 : 1
  if (a.kind !== b.kind) return KIND_RANK[a.kind] < KIND_RANK[b.kind] ? -1 : 1
  return a.id === b.id ? 0 : a.id < b.id ? -1 : 1
}

/**
 * The first `limit` rows of the merged kinds after the cursor, in the list's order (each kind's rows already in that order and
 * after the cursor), and the cursor of the next page (null: no row is left).
 */
export function mergePage<Row extends { readonly key: IncomingCursor }>(lists: readonly (readonly Row[])[], limit: number, descending: boolean): { readonly rows: Row[]; readonly next: IncomingCursor | null } {
  const order = (a: Row, b: Row) => (descending ? -compareKeys(a.key, b.key) : compareKeys(a.key, b.key))
  const all = lists.flat().sort(order)
  const rows = all.slice(0, limit)
  return { rows, next: all.length > limit && rows.length > 0 ? rows[rows.length - 1]!.key : null }
}
