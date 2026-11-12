import type { ApprovalRow } from '../../sales/quotes/api'
import type { TodayItem } from '../today/model'
import type { TaskRow } from './api'

/**
 * Home › Approvals in depth (B-W2b-307; PLT-085; design home.approvals): ONE inbox for every request that needs a yes, in
 * ONE filter model. Three sources, each read with the person's own rights:
 *
 *   task        the approval engine's requests (B-W2b-282, `GET /approvals/tasks`): decided here — the review, the
 *               signature its rule asks, Approve N over requests of one kind
 *   quote       W1's quote approvals (`GET /sales/quote-approvals`): decided here, as in W1
 *   attention   every other kind of approval Today knows (`GET /home/today?category=APPROVAL`): change orders, SMV changes,
 *               inspection plan versions, NCR decisions, portal requests, suppliers' changes … — decided on their own page
 *               (the row opens it)
 *
 * The tiles: Waiting for me · Overdue (past its time) · Asked by me · Decided in the last 7 days. The filters: kind and
 * words, kept in the address (`?view=&kind=&q=&changed=1&open=`). Pure, so the tests hold it.
 */

export const INBOX_VIEWS = ['waiting', 'overdue', 'mine', 'decided'] as const
export type InboxView = (typeof INBOX_VIEWS)[number]

export const inboxViewOf = (asked: string | null | undefined): InboxView => ((INBOX_VIEWS as readonly string[]).includes(asked ?? '') ? (asked as InboxView) : 'waiting')

/** The attention kinds read from another source here (the quotes' own route, the engine's own list). */
export const OWN_SOURCES: ReadonlySet<string> = new Set(['QUOTE_APPROVAL', 'APPROVAL_TASK'])

export type InboxSource = 'task' | 'quote' | 'attention'

export interface InboxRow {
  /** Unique in the list: `task:<id>`, `quote:<id>`, or Today's row key. */
  readonly key: string
  readonly source: InboxSource
  /** The engine's kind (PURCHASE_ORDER …), QUOTE_APPROVAL, or the attention kind (CHANGE_ORDER …). */
  readonly kind: string
  /** Since when it waits (or was asked). */
  readonly since: string
  /** Its time to decide: an instant (a request's rule) or a day (Today's due), or null. */
  readonly due: string | null
  readonly overdue: boolean
  readonly companyId: string | null
  /** Where its record opens (with the company prefix): a request's subject, a quote, Today's row's own page. */
  readonly href?: string | null
  readonly task?: TaskRow
  readonly quote?: ApprovalRow
  readonly item?: TodayItem
}

export const taskRow = (task: TaskRow): InboxRow => ({ key: `task:${task.id}`, source: 'task', kind: task.kind, since: task.requestedAt, due: task.dueAt, overdue: task.status === 'PENDING' && task.overdue, companyId: task.companyId, task })

export const quoteRow = (quote: ApprovalRow): InboxRow => ({ key: `quote:${quote.id}`, source: 'quote', kind: 'QUOTE_APPROVAL', since: quote.askedAt, due: null, overdue: false, companyId: quote.companyId, quote })

export const attentionRow = (item: TodayItem): InboxRow => ({
  key: item.key,
  source: 'attention',
  kind: item.kind,
  since: item.since,
  due: item.due?.date ?? null,
  overdue: item.due !== null && item.due.days < 0,
  companyId: item.companyId,
  item,
})

/** The id the address opens (`?open=`): a request's or a quote approval's id; Today's rows open their own page. */
export const openIdOf = (row: InboxRow): string | null => row.task?.id ?? row.quote?.id ?? null

/** The rows of a view, oldest first for the queue (waiting, overdue), newest first for my requests and the decided. */
export function rowsOf(view: InboxView, sources: { readonly tasks: readonly TaskRow[]; readonly quotes: readonly ApprovalRow[]; readonly items: readonly TodayItem[] }): InboxRow[] {
  const items = view === 'waiting' || view === 'overdue' ? sources.items.filter((item) => !OWN_SOURCES.has(item.kind)).map(attentionRow) : []
  const rows = [...sources.tasks.map(taskRow), ...sources.quotes.map(quoteRow), ...items].filter((row) => view !== 'overdue' || row.overdue)
  const oldest = view === 'waiting' || view === 'overdue'
  return rows.sort((a, b) => (oldest ? a.since.localeCompare(b.since) : b.since.localeCompare(a.since)) || (a.key < b.key ? -1 : 1))
}

export interface InboxFilter {
  /** One kind, or null for every kind. */
  readonly kind: string | null
  /** Words in the request, its record or who asked. */
  readonly q: string
  /** Only the requests that changed since they were asked (the notice's link). */
  readonly changed: boolean
}

/** The rows under the filter. `text` is the row's words as the screen says them (the sentence, the record, who asked). */
export function filterRows(rows: readonly InboxRow[], filter: InboxFilter, text: (row: InboxRow) => string): InboxRow[] {
  const needle = filter.q.trim().toLocaleLowerCase()
  return rows.filter((row) => (filter.kind === null || row.kind === filter.kind) && (!filter.changed || row.task?.recheck === 'CHANGED') && (needle === '' || text(row).toLocaleLowerCase().includes(needle)))
}

/** Every kind among the rows with its count, in the order first met (the kind filter's options). */
export function kindsOf(rows: readonly InboxRow[]): { readonly kind: string; readonly count: number }[] {
  const counts = new Map<string, number>()
  for (const row of rows) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1)
  return [...counts].map(([kind, count]) => ({ kind, count }))
}

// ---- deciding --------------------------------------------------------------------------------------------------------------

/**
 * Why the person may not decide the row here now (a `held.` key of approvals-depth), or null. In order: decided on its own
 * page, not waiting, their own request (four eyes, the Owner included), changed since asked, gone, not theirs to decide,
 * offline, busy.
 */
export function heldOf(row: InboxRow, state: { readonly offline: boolean; readonly busy: boolean }): string | null {
  if (row.source === 'attention') return 'inbox.held.ownPage'
  if (row.task) {
    const task = row.task
    if (task.status !== 'PENDING') return 'inbox.held.notWaiting'
    if (task.requester.me) return 'inbox.held.own'
    // A changed or gone request is refused by the engine whoever decides it (its `approve` says so too): said first.
    if (task.recheck === 'CHANGED') return 'inbox.held.changed'
    if (task.recheck === 'GONE') return 'inbox.held.gone'
    if (!task.approve.allowed) return 'inbox.held.notYours'
  }
  if (row.quote) {
    const quote = row.quote
    if (quote.status !== 'PENDING') return 'inbox.held.notWaiting'
    if (quote.held === 'OWN_REQUEST') return 'inbox.held.own'
    if (!quote.mayDecide) return quote.held === 'NEEDS_MARGIN' ? 'inbox.held.needsMargin' : 'inbox.held.notYours'
  }
  if (state.offline) return 'inbox.held.offline'
  if (state.busy) return 'inbox.held.busy'
  return null
}

/**
 * Whether the row may be ticked for Approve N, and why not (a key): one the person may decide here now, with no signature
 * meaning (design: "Releases are signed one by one").
 */
export function selectHeld(row: InboxRow, state: { readonly offline: boolean; readonly busy: boolean }): string | null {
  const held = heldOf(row, { offline: false, busy: false })
  if (held) return held
  if (row.task && row.task.signatureMeaning !== null) return 'inbox.held.signedOneByOne'
  if (row.task && row.task.requireStepUp) return 'inbox.held.codeOneByOne'
  return state.offline ? 'inbox.held.offline' : null
}

/** Approve N is held unless every ticked row is of one kind (design: "bulk Approve N only for the same kind"). */
export function bulkHeld(rows: readonly InboxRow[]): string | null {
  if (rows.length === 0) return 'inbox.held.pickSome'
  return new Set(rows.map((row) => row.kind)).size === 1 ? null : 'inbox.held.oneKind'
}

/** After a decision: the next request that opens a review here, else the one before, else none. */
export function nextReview(rows: readonly InboxRow[], decided: string): string | null {
  const ids = rows.map(openIdOf).filter((id): id is string => id !== null)
  const index = ids.indexOf(decided)
  if (index < 0) return ids[0] ?? null
  return ids[index + 1] ?? ids[index - 1] ?? null
}

// ---- the tiles -------------------------------------------------------------------------------------------------------------

export interface InboxCounts {
  readonly waiting: number | null
  readonly overdue: number | null
  readonly mine: number | null
  readonly decided: number | null
}

/**
 * Each tile's number from its sources (null: a source not read yet, shown as "—", never 0): the engine's tiles, the quotes'
 * counts, and Today's approvals of the other kinds (counted on the rows read with `category=APPROVAL`, at most 200).
 */
export function countsOf(sources: {
  readonly tasks: Readonly<Record<'WAITING_FOR_ME' | 'OVERDUE' | 'ASKED_BY_ME' | 'DECIDED_7_DAYS', number>> | null
  readonly quotes: { readonly waiting: number; readonly mine: number; readonly decided: number } | null
  readonly today: { readonly items: readonly Pick<TodayItem, 'kind' | 'due'>[] } | null
  /** Which sources this person reads at all (a source they may not read counts 0). */
  readonly reads: { readonly tasks: boolean; readonly quotes: boolean; readonly today: boolean }
}): InboxCounts {
  const part = <T,>(reads: boolean, value: T | null, pick: (value: T) => number): number | null => (!reads ? 0 : value === null ? null : pick(value))
  const sum = (...parts: (number | null)[]) => (parts.some((value) => value === null) ? null : parts.reduce<number>((total, value) => total + (value ?? 0), 0))
  // Today's approvals of the other kinds, as read (`category=APPROVAL`; its tiles' byKind counts every category).
  const others = (items: readonly Pick<TodayItem, 'kind'>[]) => items.filter((item) => !OWN_SOURCES.has(item.kind)).length
  return {
    waiting: sum(part(sources.reads.tasks, sources.tasks, (tiles) => tiles.WAITING_FOR_ME), part(sources.reads.quotes, sources.quotes, (counts) => counts.waiting), part(sources.reads.today, sources.today, (today) => others(today.items))),
    overdue: sum(
      part(sources.reads.tasks, sources.tasks, (tiles) => tiles.OVERDUE),
      part(sources.reads.today, sources.today, (today) => today.items.filter((item) => !OWN_SOURCES.has(item.kind) && item.due !== null && item.due.days < 0).length),
    ),
    mine: sum(part(sources.reads.tasks, sources.tasks, (tiles) => tiles.ASKED_BY_ME), part(sources.reads.quotes, sources.quotes, (counts) => counts.mine)),
    decided: sum(part(sources.reads.tasks, sources.tasks, (tiles) => tiles.DECIDED_7_DAYS), part(sources.reads.quotes, sources.quotes, (counts) => counts.decided)),
  }
}

// ---- the address -----------------------------------------------------------------------------------------------------------

export interface InboxControls extends InboxFilter {
  readonly view: InboxView
  readonly open: string | null
}

export function controlsOf(params: { get(name: string): string | null } | null | undefined): InboxControls {
  return {
    view: inboxViewOf(params?.get('view')),
    kind: params?.get('kind') || null,
    q: params?.get('q') ?? '',
    changed: params?.get('changed') === '1',
    open: params?.get('open') || null,
  }
}

export function inboxAddress(controls: InboxControls): string {
  const query = new URLSearchParams()
  if (controls.view !== 'waiting') query.set('view', controls.view)
  if (controls.kind) query.set('kind', controls.kind)
  if (controls.q.trim()) query.set('q', controls.q.trim())
  if (controls.changed) query.set('changed', '1')
  if (controls.open) query.set('open', controls.open)
  const text = query.toString()
  return text ? `?${text}` : ''
}

// ---- values in words --------------------------------------------------------------------------------------------------------

/** A fact's or a change's value as text: a number or a word as it came, yes / no, a list joined; nothing: "—". */
export function valueText(value: unknown, yesNo: { readonly yes: string; readonly no: string }): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'boolean') return value ? yesNo.yes : yesNo.no
  if (Array.isArray(value)) return value.map((entry) => valueText(entry, yesNo)).join(', ')
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

/** A request's money fact for the Amount column: the first fact with a grain the reader was given, with the currency fact. */
export function amountOf(task: Pick<TaskRow, 'facts'>): { readonly value: string; readonly currency: string | null } | null {
  const money = task.facts.find((fact) => fact.grain !== null && fact.value !== null && fact.value !== undefined)
  if (!money) return null
  const currency = task.facts.find((fact) => fact.field === 'currency')?.value
  return { value: String(money.value), currency: typeof currency === 'string' ? currency : null }
}

/** A decimal amount ("6000.5") with its currency in the person's language; without a currency the number alone. */
export function decimalMoney(value: string, currency: string | null, locale: 'it' | 'en'): string {
  const number = Number(value)
  if (!Number.isFinite(number)) return value
  const tag = locale === 'it' ? 'it-IT' : 'en-GB'
  return currency ? new Intl.NumberFormat(tag, { style: 'currency', currency }).format(number) : new Intl.NumberFormat(tag).format(number)
}

// ---- refusals -------------------------------------------------------------------------------------------------------------

/** The approval engine's refusal code of an API error (`refusal/STALE` → STALE), or null. */
export function refusalOf(error: { readonly issues?: readonly { readonly path?: unknown }[] } | null | undefined): string | null {
  for (const issue of error?.issues ?? []) {
    const path = typeof issue.path === 'string' ? issue.path : Array.isArray(issue.path) ? issue.path.join('.') : ''
    if (path.startsWith('refusal/')) return path.slice('refusal/'.length)
  }
  return null
}

/** The refusals this page words itself (approvals-depth `refusal.<code>`); another code reads as a generic refusal. */
export const KNOWN_REFUSALS: ReadonlySet<string> = new Set(['STALE', 'SUBJECT_GONE', 'NOT_PENDING', 'OWN_REQUEST', 'NOT_APPROVER', 'NO_KIND', 'NOT_REQUESTER'])

/** A decision's failure as a notice key of approvals-depth, and whether the inbox reads again (a changed or gone request). */
export function decisionProblem(error: { readonly kind?: string; readonly issues?: readonly { readonly path?: unknown }[] } | null | undefined): { readonly key: string; readonly reload: boolean } {
  const refusal = refusalOf(error)
  if (refusal) return { key: KNOWN_REFUSALS.has(refusal) ? `refusal.${refusal}` : 'refusal.other', reload: true }
  switch (error?.kind) {
    case 'step_up':
      return { key: 'sign.codeAgain', reload: false }
    case 'conflict':
      return { key: 'refusal.moved', reload: true }
    case 'forbidden':
    case 'invalid':
    case 'unavailable':
    case 'rate_limited':
    case 'signed_out':
      return { key: `problem.${error.kind}`, reload: false }
    default:
      return { key: 'problem.internal', reload: false }
  }
}

/** The engine's tile a view reads. */
export const TILE_OF: Readonly<Record<InboxView, 'WAITING_FOR_ME' | 'OVERDUE' | 'ASKED_BY_ME' | 'DECIDED_7_DAYS'>> = Object.freeze({ waiting: 'WAITING_FOR_ME', overdue: 'OVERDUE', mine: 'ASKED_BY_ME', decided: 'DECIDED_7_DAYS' })
