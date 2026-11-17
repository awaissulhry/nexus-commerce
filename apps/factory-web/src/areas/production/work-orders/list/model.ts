import type { Tone } from '@nexus/ui/primitives'
import type { RelativeDay } from '@nexus/factory-domain/views/quick/relative'
import { isRelativeDay } from '@nexus/factory-domain/views/quick/relative'
import { viewQuery as savedViewQuery } from '@nexus/factory-domain/views/state'
import { waitingView, type HealthInput } from '../../../../lib/production/model'
import { BLOCKED_BY, LIST_SORTS, WAITING_ON, WORK_ORDER_RISKS, type BlockedBy, type ListQuery, type ListSort, type WaitingOn, type WorkOrderCounts, type WorkOrderRisk, type WorkOrderRow } from '../../_shared/api'
import { listProgress, percentOf, viewFromAddress, viewQuery, type ListView, type Phrase } from '../../_shared/model'
import { partyOf, PARTY_KEY } from '../../_shared/customer/model'
import type { ListMode } from '../../../../list-frame/w2b/model'
// F-PR-18: the Customer urgency column and filter (Urgent 2 / Urgent – asked / Regular / Set to regular by us).
import { CUSTOMER_URGENCY_STATES, type CustomerUrgencyState } from '../../_shared/api'

/**
 * F-PR-03 — the work orders list by risk, without a screen (production plan §5 "Work orders: sorted by risk; Customer (+ SO link,
 * PO), Health, Waiting on, Blocked by; customer filter and grouping"; 06-tree A.3; 09-design §2(b)). The API computes each row's
 * risk and what its order waits on (B-PR-34); this file reads the list's address, writes it back, says each row's cells, and groups
 * the loaded rows by customer.
 *
 * The address is the list's state and the export's: `?sort=` (the screen's default `risk`, written on every address the page makes;
 * an untouched address names none, and the export is given `sort=risk` then: `withScreenSort`), `?waitingOn=`, `?risk=`,
 * `?blockedBy=` (the API's own term names, so the work orders file reads the same, B-PR-34), `?party=` (the Production pages' one
 * customer filter, F-PR-02) and `?group=party`. A filter never widens what the API lets the person see: the brand wall is the API's.
 */

export interface Params {
  get(name: string): string | null
}

/** The screen's default order: the most at risk first (06-tree A.3 "Risk (default; today newest first)"). */
export const DEFAULT_SORT: ListSort = 'risk'
/** The Sort menu's choices, in the menu's order. */
export const SORT_CHOICES: readonly ListSort[] = ['risk', 'due', 'newest']

export type ListGroup = 'party'

export interface ListTerms {
  readonly view: ListView
  readonly q: string
  readonly mode: ListMode
  readonly due: RelativeDay | null
  readonly rush: boolean
  readonly sort: ListSort
  readonly waitingOn: WaitingOn | null
  readonly risk: WorkOrderRisk | null
  readonly blockedBy: BlockedBy | null
  /** The one customer (`?party=`), or null for every customer the person may see. */
  readonly party: string | null
  readonly group: ListGroup | null
  /** F-PR-21: `me` — only the work orders the reader supervises (`?supervisor=me`, the Mine tile); no filter by another person. */
  readonly supervisor: 'me' | null
  /** F-PR-18: one Customer urgency state (`?customerUrgency=`, the API's computed filter), or null. */
  readonly customerUrgency: CustomerUrgencyState | null
  // ── F-PR-04: the Overview's numbers open this list with their filters (B-PR-33's list terms) ──
  /** `?gate=true`: production work orders not started whose open order waits on a gate. */
  readonly gate: boolean
  /** `?mixed=true`: made before the one-customer rule with cells of several customers. */
  readonly mixed: boolean
  /** `?noCustomer=true`: the work of no customer (a sample for no customer). */
  readonly noCustomer: boolean
  // ── end F-PR-04
}

const pick = <Value extends string>(values: readonly Value[], value: string | null | undefined): Value | null => ((values as readonly string[]).includes(value ?? '') ? (value as Value) : null)

/** The list's terms of an address (an unknown value: the term is off, never a guess). */
export function termsOf(params: Params | null | undefined, modes: readonly ListMode[]): ListTerms {
  const due = params?.get('due') ?? null
  return {
    view: viewFromAddress(params),
    q: params?.get('q') ?? '',
    mode: pick(modes, params?.get('mode')) ?? 'table',
    due: isRelativeDay(due) ? due : null,
    rush: params?.get('rush') === 'true',
    sort: pick(LIST_SORTS, params?.get('sort')) ?? DEFAULT_SORT,
    waitingOn: pick(WAITING_ON, params?.get('waitingOn')),
    risk: pick(WORK_ORDER_RISKS, params?.get('risk')),
    blockedBy: pick(BLOCKED_BY, params?.get('blockedBy')),
    party: partyOf(params),
    group: params?.get('group') === 'party' ? 'party' : null,
    supervisor: params?.get('supervisor') === 'me' ? 'me' : null,
    customerUrgency: pick(CUSTOMER_URGENCY_STATES, params?.get('customerUrgency')), // F-PR-18
    // F-PR-04
    gate: params?.get('gate') === 'true',
    mixed: params?.get('mixed') === 'true',
    noCustomer: params?.get('noCustomer') === 'true',
  }
}

/**
 * The list's address with these terms (`new`: the New work order dialog). The sort is always written (the screen's default too),
 * so a saved view and the export name the order the screen shows.
 */
export function listAddress(path: string, terms: ListTerms, extra: { readonly new?: boolean } = {}): string {
  const query = new URLSearchParams()
  if (terms.view !== 'open') query.set('view', terms.view)
  if (terms.q.trim()) query.set('q', terms.q.trim())
  if (terms.due) query.set('due', terms.due)
  if (terms.rush) query.set('rush', 'true')
  if (terms.mode !== 'table') query.set('mode', terms.mode)
  query.set('sort', terms.sort)
  if (terms.waitingOn) query.set('waitingOn', terms.waitingOn)
  if (terms.risk) query.set('risk', terms.risk)
  if (terms.blockedBy) query.set('blockedBy', terms.blockedBy)
  if (terms.party) query.set(PARTY_KEY, terms.party)
  if (terms.group) query.set('group', terms.group)
  if (terms.supervisor) query.set('supervisor', terms.supervisor)
  if (terms.customerUrgency) query.set('customerUrgency', terms.customerUrgency) // F-PR-18
  // F-PR-04
  if (terms.gate) query.set('gate', 'true')
  if (terms.mixed) query.set('mixed', 'true')
  if (terms.noCustomer) query.set('noCustomer', 'true')
  if (extra.new) query.set('new', '1')
  const text = query.toString()
  return `${path}${text ? `?${text}` : ''}`
}

/** The API read of these terms (a page after `cursor`). */
export function listQueryOf(terms: ListTerms, cursor: string | null = null): ListQuery {
  return {
    ...viewQuery(terms.view, terms.q, cursor),
    due: terms.due,
    rush: terms.rush,
    partyId: terms.party ?? undefined,
    sort: terms.sort,
    waitingOn: terms.waitingOn ?? undefined,
    risk: terms.risk ?? undefined,
    blockedBy: terms.blockedBy ?? undefined,
    supervisor: terms.supervisor ?? undefined,
    customerUrgency: terms.customerUrgency ?? undefined, // F-PR-18
    // F-PR-04
    gate: terms.gate || undefined,
    mixed: terms.mixed || undefined,
    noCustomer: terms.noCustomer || undefined,
  }
}

/** Whether any term narrows the rows (the empty state then offers Clear filters). */
export const narrowed = (terms: ListTerms): boolean =>
  terms.q.trim() !== '' || !!terms.due || terms.rush || !!terms.waitingOn || !!terms.risk || !!terms.blockedBy || !!terms.party || !!terms.supervisor || /* F-PR-18 */ !!terms.customerUrgency || /* F-PR-04 */ terms.gate || terms.mixed || terms.noCustomer || (terms.view !== 'all' && terms.view !== 'open')

/** Every filter off (the sort, the mode and the grouping stay: they narrow nothing). */
export const cleared = (terms: ListTerms): ListTerms => ({ ...terms, view: 'all', q: '', due: null, rush: false, waitingOn: null, risk: null, blockedBy: null, party: null, supervisor: null, /* F-PR-18 */ customerUrgency: null, /* F-PR-04 */ gate: false, mixed: false, noCustomer: false })

/**
 * The export's query (a saved view's terms, B-W2a-23): an address that names no sort is shown by risk, so the file is told so too —
 * the work orders file reads `sort` from the address and its own default is newest first (B-PR-34). Every other term as it was.
 */
export function withScreenSort(query: string): string {
  const params = new URLSearchParams(query.startsWith('?') ? query.slice(1) : query)
  if (params.has('sort')) return query
  params.set('sort', DEFAULT_SORT)
  return savedViewQuery(params)
}

// ---- the tiles --------------------------------------------------------------------------------------------------------------------

export interface ListTile {
  readonly id: 'mine' | 'draft' | 'released' | 'inProgress' | 'late' | 'atRisk' | 'onHold' | 'waitingOnCustomer'
  /** The open work orders the tile counts (null: not read, the tile says "—"). */
  readonly count: number | null
  readonly active: boolean
  /** The terms a press gives (a second press undoes it). */
  readonly next: Partial<ListTerms>
}

const viewTile = (id: ListTile['id'], view: ListView, count: number | null, terms: ListTerms): ListTile => ({ id, count, active: terms.view === view, next: { view: terms.view === view ? 'open' : view } })

/**
 * The tiles (06-tree A.3 O-WOL-tiles): Drafts to release · Released, not started · In progress · Late · At risk · On hold · Waiting
 * on customer. The state tiles are the list's saved views (as before); At risk and Waiting on customer are the API's computed
 * filters (`?risk=AT_RISK`, `?waitingOn=BRAND`), so the export follows them.
 */
export function listTiles(terms: ListTerms, counts: WorkOrderCounts | null): ListTile[] {
  const of = (value: number | undefined): number | null => (counts && value !== undefined ? value : null)
  return [
    // F-PR-21: Mine — the open work orders the reader supervises (`?supervisor=me`; the export and a saved view follow it).
    { id: 'mine', count: of(counts?.mine), active: terms.supervisor === 'me', next: { supervisor: terms.supervisor === 'me' ? null : 'me' } },
    viewTile('draft', 'DRAFT', of(counts?.draft), terms),
    viewTile('released', 'RELEASED', of(counts?.released), terms),
    viewTile('inProgress', 'IN_PROGRESS', of(counts?.inProgress), terms),
    viewTile('late', 'late', of(counts?.late), terms),
    { id: 'atRisk', count: of(counts?.atRisk), active: terms.risk === 'AT_RISK', next: { risk: terms.risk === 'AT_RISK' ? null : 'AT_RISK' } },
    viewTile('onHold', 'ON_HOLD', of(counts?.onHold ?? (counts ? 0 : undefined)), terms),
    { id: 'waitingOnCustomer', count: of(counts?.waitingOnCustomer), active: terms.waitingOn === 'BRAND', next: { waitingOn: terms.waitingOn === 'BRAND' ? null : 'BRAND' } },
  ]
}

// ---- the cells -------------------------------------------------------------------------------------------------------------------

/** The Customer cell: its name (or code), each order with its link target and customer PO; mixed or none said in words. */
export interface CustomerCell {
  /** null: no customer, or a work order of several made before the one-customer rule (`mixed`). */
  readonly name: string | null
  readonly mixed: boolean
  readonly orders: readonly { readonly id: string; readonly number: string; readonly po: string | null }[]
}

export function customerCellOf(row: Pick<WorkOrderRow, 'customer' | 'mixedCustomers' | 'orders'>, names: boolean): CustomerCell {
  const name = row.customer ? (names ? row.customer.name : row.customer.code) : null
  return { name, mixed: !row.customer && !!row.mixedCustomers, orders: row.orders.map((order) => ({ id: order.id, number: order.number, po: order.customerRef ?? null })) }
}

/** The Stage cell's line under the state: the furthest step the floor counted (the same figure as before, F-PR-01). */
export const stageLineOf = (row: Pick<WorkOrderRow, 'progress' | 'pieces' | 'status'>): Phrase => listProgress(row).words

/**
 * The Done cell: finished ÷ pieces, the bar and its words from ONE figure (06-tree A.3 "Done (bar and words both finished %)";
 * rule R5). A draft is not released ("Not released yet", no bar); a site that does not count finished says so, never 0.
 */
export function doneOf(row: Pick<WorkOrderRow, 'progress' | 'pieces' | 'status'>): { readonly percent: number | null; readonly words: Phrase } {
  if (row.status === 'DRAFT' || !row.progress) return { percent: null, words: { key: 'progress.notFrozen' } }
  const finished = row.progress.finished
  if (finished === null) return { percent: null, words: { key: 'list.doneNotCounted' } }
  return { percent: percentOf(finished, row.pieces), words: { key: 'progress.finished', params: { done: finished, total: row.pieces } } }
}

/**
 * The Health cell from the row's risk (B-PR-34): Late (days), At risk (its planned finish after the due date, or a person's raise with
 * its reason), Blocked (the Blocked by column says by what), On track — "No date yet" for one with no due date. Finished: nothing;
 * an older answer without a risk: not known.
 */
export type HealthCell = { readonly kind: 'none' } | { readonly kind: 'unknown' } | { readonly kind: 'blocked'; readonly by: BlockedBy | null } | { readonly kind: 'health'; readonly input: HealthInput }

export function healthCellOf(row: Pick<WorkOrderRow, 'risk' | 'dueDate' | 'status'>): HealthCell {
  if (row.risk === undefined) return ['COMPLETED', 'CLOSED', 'CANCELLED'].includes(row.status) ? { kind: 'none' } : { kind: 'unknown' }
  const risk = row.risk
  if (risk === null) return { kind: 'none' }
  if (risk.state === 'BLOCKED') return { kind: 'blocked', by: risk.blockedBy }
  if (risk.state === 'LATE') return { kind: 'health', input: { computed: 'LATE', daysLate: risk.daysLate } }
  if (risk.state === 'AT_RISK') return { kind: 'health', input: { computed: risk.planAfterDue ? 'AT_RISK' : 'ON_TIME', raised: risk.raised ? { reason: risk.raised } : null, plan: risk.plannedEnd, promise: row.dueDate } }
  return { kind: 'health', input: { computed: row.dueDate ? 'ON_TIME' : 'NOT_PROMISED' } }
}

/** The Waiting on cell's input for the shared chip (finished: nobody waits; open with nothing known: "—"). */
export function waitingInputOf(row: Pick<WorkOrderRow, 'waitingOn' | 'risk' | 'status'>): { readonly who: WaitingOn | null | undefined; readonly since: string | null } {
  if (row.risk === null || ['COMPLETED', 'CLOSED', 'CANCELLED'].includes(row.status)) return { who: null, since: null }
  if (!row.waitingOn) return { who: undefined, since: null }
  return { who: row.waitingOn.on, since: row.waitingOn.since }
}

/** The Blocked by cell: its words key, or null (nothing blocks it). */
export const blockedKeyOf = (row: Pick<WorkOrderRow, 'risk'>): string | null => (row.risk?.blockedBy ? `blocked.${row.risk.blockedBy}` : null)

/**
 * A board card's marks (06-tree A.3 O-WOL-board "brand code, waiting-on mark and health"): its health when it is not on track, and
 * who it waits on with how long. Words as phrases (the view translates them).
 */
export function boardMarksOf(row: WorkOrderRow, now: number): Array<{ readonly words: readonly Phrase[]; readonly tone: Tone }> {
  const marks: Array<{ words: Phrase[]; tone: Tone }> = []
  const health = healthCellOf(row)
  if (health.kind === 'blocked') marks.push({ words: [{ key: 'risk.BLOCKED' }], tone: 'warning' })
  if (health.kind === 'health' && row.risk?.state === 'LATE') marks.push({ words: [row.risk.daysLate ? { key: 'parts.health.lateBy', params: { count: row.risk.daysLate } } : { key: 'parts.health.LATE' }], tone: 'danger' })
  if (health.kind === 'health' && row.risk?.state === 'AT_RISK') marks.push({ words: [{ key: 'parts.health.AT_RISK' }], tone: 'warning' })
  const waiting = waitingInputOf(row)
  if (waiting.who) {
    const view = waitingView('office', { who: waiting.who, since: waiting.since }, now)
    if (view && view !== 'unknown') marks.push({ words: [view.words, ...(view.age ? [view.age] : [])], tone: view.tone })
  }
  // F-PR-21 (17-web-r2 §1.1 phone: "card shows Supervisor: Me"): only the reader's own; never a name, never someone else's.
  if (row.supervisor === 'ME') marks.push({ words: [{ key: 'production-work-orders:supervisor.cardMe' }], tone: 'info' })
  return marks
}

// ---- grouped by customer ---------------------------------------------------------------------------------------------------------

/** The group of a work order made before the one-customer rule with several customers, and of one with no customer (a sample). */
export const MIXED_GROUP = '~mixed'
export const NO_CUSTOMER_GROUP = '~none'

export const groupKeyOf = (row: Pick<WorkOrderRow, 'customer' | 'mixedCustomers'>): string => (row.customer ? row.customer.id : row.mixedCustomers ? MIXED_GROUP : NO_CUSTOMER_GROUP)

export interface CustomerGroup {
  readonly key: string
  /** The customer (null: the mixed or no-customer group). */
  readonly partyId: string | null
  readonly kind: 'customer' | 'mixed' | 'none'
  /** Its name (with parties.view) or its code; null for the mixed and no-customer groups (said in words). */
  readonly name: string | null
}

/**
 * The groups of the loaded rows, in the order the list reads them (by risk: the customer with the most urgent work order first). A
 * group is only ever a customer of a row the API gave this person: never a customer of the filter's options without a row, so a
 * grouped list names no customer the rows do not (the brand wall: the rows are already the person's own).
 */
export function customerGroupsOf(rows: readonly WorkOrderRow[], names: boolean): CustomerGroup[] {
  const out = new Map<string, CustomerGroup>()
  for (const row of rows) {
    const key = groupKeyOf(row)
    if (out.has(key)) continue
    if (row.customer) out.set(key, { key, partyId: row.customer.id, kind: 'customer', name: names ? row.customer.name : row.customer.code })
    else out.set(key, { key, partyId: null, kind: row.mixedCustomers ? 'mixed' : 'none', name: null })
  }
  return [...out.values()]
}

/** The customers of the groups whose figures are still to read (each once; a failed read is tried again on the next read of the list). */
export function groupsToCount(groups: readonly CustomerGroup[], counted: Readonly<Record<string, unknown>>): string[] {
  return groups.flatMap((group) => (group.partyId && !(group.partyId in counted) ? [group.partyId] : []))
}

/** A group header's figures (the server's, for the customer's whole production), as one phrase. */
export const groupFigures = (counts: WorkOrderCounts): Phrase => ({ key: 'group.figures', params: { open: counts.open, late: counts.late, atRisk: counts.atRisk ?? 0, waiting: counts.waitingOnCustomer ?? 0 } })

/** The choices of the list's computed filters, by term, with their words keys (the Quick filters ▾ menu). */
export const FILTER_CHOICES = {
  waitingOn: WAITING_ON.map((value) => ({ value, key: `waitingChoice.${value}` })),
  risk: WORK_ORDER_RISKS.map((value) => ({ value, key: `risk.${value}` })),
  blockedBy: BLOCKED_BY.map((value) => ({ value, key: `blocked.${value}` })),
  // F-PR-18: the words keys of the `production-work-orders` catalogue (the office's, "Urgente" alone is the rush flag in Italian).
  customerUrgency: CUSTOMER_URGENCY_STATES.map((value) => ({ value, key: `urgency.choice.${value}` })),
} as const

/** A quick filter's change as terms (an unknown value turns it off). */
export function filterChange(id: string, value: string | null): Partial<ListTerms> | null {
  if (id === 'waitingOn') return { waitingOn: pick(WAITING_ON, value) }
  if (id === 'risk') return { risk: pick(WORK_ORDER_RISKS, value) }
  if (id === 'blockedBy') return { blockedBy: pick(BLOCKED_BY, value) }
  if (id === 'customerUrgency') return { customerUrgency: pick(CUSTOMER_URGENCY_STATES, value) } // F-PR-18
  // F-PR-04: the Overview's flags (a chip each; a second press takes it away).
  if (id === 'gate') return { gate: value === 'true' }
  if (id === 'mixed') return { mixed: value === 'true' }
  if (id === 'noCustomer') return { noCustomer: value === 'true' }
  if (id === 'rush') return { rush: value === 'true' }
  if (id === 'due') return { due: isRelativeDay(value) ? value : null }
  return null
}

// ---- F-PR-18: the Customer urgency column ----------------------------------------------------------------------------------------

/**
 * The Customer urgency cell (production plan §5 "Work orders: … Customer urgency"): Urgent 2 (its place in the customer's OWN Urgent
 * list, never a place in our plan) · Urgent – asked (an open ask we answer in Approvals) · Regular · Set to regular by us; none for a
 * work order of no order whose urgency counts (no customer order, no production state yet, the customer's switch off). An older
 * answer without the state reads its urgency alone. Words keys of `production-work-orders`; the tone of the DS Tag.
 */
export interface UrgencyCell {
  readonly state: CustomerUrgencyState
  readonly key: string
  readonly params?: Readonly<Record<string, number>>
  readonly tone: Tone
}

export function customerUrgencyCellOf(row: Pick<WorkOrderRow, 'urgencyState' | 'customerUrgency' | 'urgentRank'>): UrgencyCell | null {
  const state: CustomerUrgencyState | null = row.urgencyState ?? (row.customerUrgency === 'URGENT' ? 'URGENT' : row.customerUrgency === 'REGULAR' ? 'REGULAR' : null)
  if (state === null) return null
  if (state === 'URGENT') {
    const rank = row.urgentRank ?? null
    return rank !== null && rank > 0 ? { state, key: 'urgency.cell.URGENT', params: { rank }, tone: 'info' } : { state, key: 'urgency.cell.URGENT_SOME', tone: 'info' }
  }
  if (state === 'ASKED') return { state, key: 'urgency.cell.ASKED', tone: 'warning' }
  if (state === 'SET_BACK') return { state, key: 'urgency.cell.SET_BACK', tone: 'neutral' }
  return { state, key: 'urgency.cell.REGULAR', tone: 'neutral' }
}
