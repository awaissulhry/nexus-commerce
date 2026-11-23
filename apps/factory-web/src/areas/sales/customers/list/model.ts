import type { CardFieldRole } from '@nexus/ui/grid/card-list/index'
import { BATCH_MAX } from '../../../../record-panels/tasks/model'
import type { PartyRow, PartyWorkBand, PartyWorkGroup } from '../../../parties/_shared/api'
import { BULK_MAX, partyName, type ListSort } from '../../../parties/_shared/model'
import type { CustomerWork, OrderPhase } from './api' // F-CL-202
import type { WorkDoorTerm } from './doors' // F-CL-202

/**
 * Sales › Customers, the list's own rules (customers list plan §1, 10-design §3, 13-backend §8; F-CL-102…104), pure: what the
 * Customer cell says the office still owes, which columns start hidden, where each column sits on the phone card and what each
 * reader may do on the list. The words are `customers-list` keys (its root groups never a `parties` prefix: 13-backend §8.8).
 */

/** The list's own words (`messages/<locale>/customers-list.json`). */
export const CUSTOMERS_LIST_NS = 'customers-list'

// ---- F-CL-102: the Customer cell ------------------------------------------------------------------------------------------

/** What the office still owes on a customer, as the cell's one chip "Needs office data" says it (its hint lists them). */
export type OfficeData = 'VIES' | 'SDI' | 'TAX'

/**
 * The row's own warnings read as office data (a `parties` warning code each): the VIES check not valid (VIES_NOT_PROVEN), the SDI
 * code or PEC missing (FISCAL_DRAWER), the tax data missing (NO_TAX_IDENTITY, or any warning that stops an invoice). Empty: no chip.
 */
export function officeDataOf(row: Pick<PartyRow, 'attention' | 'invoiceBlocked'>): OfficeData[] {
  const out: OfficeData[] = []
  if (row.attention.includes('VIES_NOT_PROVEN')) out.push('VIES')
  if (row.attention.includes('FISCAL_DRAWER')) out.push('SDI')
  if (row.attention.includes('NO_TAX_IDENTITY') || row.invoiceBlocked) out.push('TAX')
  return out
}

/**
 * The identity columns start hidden (settle T15, T28): still in Customise and in the full file for re-import. Status moves into
 * the Customer cell (shown only when not Active).
 */
export const CUSTOMER_HIDDEN_COLUMNS: readonly string[] = Object.freeze(['roles', 'status', 'country', 'taxMode', 'vies', 'sdi', 'language'])

/**
 * The phone card (10-design §4): the Customer cell is the card's title (name, code, status, office chip), the thread door sits
 * beside it with the row's ⋯ as the card's actions (the shared list pins it right), Overdue is a line; the rest stays off the card.
 */
export const CARD_ROLES: Readonly<Record<string, CardFieldRole>> = Object.freeze({ name: 'title', messages: 'aside', overdue: 'field' })

// ---- F-CL-102 / F-CL-104: what the reader may do on the list (each act reads its OWN right) ----------------------------------

export interface CustomerRights {
  /** threads.read: the New messages column and the thread doors. */
  readonly threads: boolean
  /** orders.view: the Work tab door. */
  readonly orders: boolean
  /** tasks.manage + threads.post: Add task (a task on a record is written in its thread). */
  readonly tasks: boolean
  /** production.brand.manage + partners.view: Set production supervisor (the customer card's own gate). */
  readonly supervisor: boolean
}

export function customerRightsOf(permissions: Iterable<string>): CustomerRights {
  const held = new Set(permissions)
  return {
    threads: held.has('threads.read'),
    orders: held.has('orders.view'),
    tasks: held.has('tasks.manage') && held.has('threads.post'),
    supervisor: held.has('production.brand.manage') && held.has('partners.view'),
  }
}

// ---- F-CL-104: the customers' own acts on a selection (the bar, 13-backend §8.2) -----------------------------------------------

/** Their places in the bar: Add task first, Set production supervisor second (then the shared VIES 40 · Block 50 · Archive 60). */
export const CUSTOMER_ACT_ORDER = Object.freeze({ task: 10, supervisor: 20 })
/** Set production supervisor runs one customer at a time: at most this many at once (the shared cap). */
export const SUPERVISOR_MAX = BULK_MAX

/** The customers' acts a reader may use on N ticked customers (left out without the right; held only by the cap, with its numbers). */
export function customerActsOf(rights: Pick<CustomerRights, 'tasks' | 'supervisor'>, count: number): Array<{ readonly id: 'task' | 'supervisor'; readonly order: number; readonly held: { readonly max: number } | null }> {
  return [
    ...(rights.tasks ? [{ id: 'task' as const, order: CUSTOMER_ACT_ORDER.task, held: count > BATCH_MAX ? { max: BATCH_MAX } : null }] : []),
    ...(rights.supervisor ? [{ id: 'supervisor' as const, order: CUSTOMER_ACT_ORDER.supervisor, held: count > SUPERVISOR_MAX ? { max: SUPERVISOR_MAX } : null }] : []),
  ]
}

/** The words a name may hide behind (R-47): shorter than 3 letters, a name names nothing. */
const MIN_NAME = 3
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * R-47 for "Add task to N customers…": the ticked customers the text names — its code, its trade name or its legal name, as a whole
 * word, any case (a code inside a longer word is no match; fewer than 3 letters count as no name). With two customers or more, any
 * name is another customer's for every other thread the task lands in. The server has no such check on a batch yet (LATER).
 */
export function namesOtherCustomer(text: string, ticked: ReadonlyArray<Pick<PartyRow, 'code' | 'tradeName' | 'legalName'>>): string[] {
  const named: string[] = []
  for (const customer of ticked) {
    const terms = [customer.code, customer.tradeName, customer.legalName].filter((term): term is string => !!term && term.trim().length >= MIN_NAME)
    const hit = terms.some((term) => new RegExp(`(^|[^\\p{L}\\p{N}])${escape(term.trim())}(?=$|[^\\p{L}\\p{N}])`, 'iu').test(text))
    if (hit && !named.includes(partyName(customer))) named.push(partyName(customer))
  }
  return named
}

// ---- F-CL-201 / F-CL-202 / F-CL-203: where each customer's work stands (customers list plan §1, 10-design §2 / §3, settles T2 / T7 /
// T13 / T23–T25 / T30) -------------------------------------------------------------------------------------------------------------

/** The live changes after which the work facts and the band are read again (the Work strip's own sources, and the quotes'). */
export function workTouchedBy(type: string): boolean {
  return (
    type.startsWith('sales_order.') ||
    type.startsWith('deposit_request.') ||
    type === 'payment.deposit_paid' ||
    type.startsWith('quote.') ||
    type.startsWith('inquiry.') ||
    type.startsWith('order_change_request.') ||
    type.startsWith('brand_production.') ||
    type === 'thread.message_posted' ||
    type.startsWith('thread.waiting')
  )
}

/** The list's order (13-backend §8.1): with orders.view Most urgent first (Code, Name A–Z); without it Code (Name A–Z). */
export function customerSortOf(rights: Pick<CustomerRights, 'orders'>): ListSort {
  return rights.orders ? { choices: ['needs', 'code', 'name'], fallback: 'needs' } : { choices: ['code', 'name'], fallback: 'code' }
}

/** A word of another catalogue, by key (one word per thing: the Work tab's, the orders', the parties'). */
export interface WordRef {
  readonly ns: 'customers-list' | 'parties' | 'orders'
  readonly key: string
}

/** A band group's or a phase's words: the Work tab's (cw) — Not sent / Not started / Done are said here until cw's catalogue is on main. */
export function groupWordOf(group: PartyWorkGroup | OrderPhase): WordRef {
  switch (group) {
    case 'NEEDS_US':
      return { ns: 'customers-list', key: 'band.needsNow' }
    case 'IN_PRODUCTION':
    case 'READY':
    case 'SHIPPED':
    case 'CANCELLED':
      return { ns: 'orders', key: `rows.${group}` }
    default:
      return { ns: 'customers-list', key: `work.phase.${group}` }
  }
}

/** How a chip is drawn: a count that waits on us, red when late, a tag (the customer's urgency, our priority), quiet, a group, Done. */
export type ChipTone = 'warn' | 'red' | 'tag' | 'tagred' | 'quiet' | 'group' | 'done'

/** One chip of a row: its count, its words, its tone and its door (every chip is a door; one where for count and rows). */
export interface WorkChip {
  readonly id: string
  readonly count: number
  readonly label: WordRef | { readonly priority: 'URGENT' | 'HIGH' }
  readonly tone: ChipTone
  readonly door: WorkDoorTerm
}

/**
 * Needs us, strongest first (T23: cw's exact words): requests to answer · to answer (cq) · replies waiting on us · late · waiting for a
 * yes · the customer's own Urgent · our Priority: Top · High — then "Waiting for deposit", quiet (it waits on the customer: T25). Zero
 * makes no chip; a part the reader has no right for is absent (replies null, before-order parts absent).
 */
export function needsChipsOf(work: CustomerWork): WorkChip[] {
  const chips: WorkChip[] = []
  const add = (count: number | null | undefined, chip: Omit<WorkChip, 'count'>) => {
    if (count && count > 0) chips.push({ ...chip, count })
  }
  add(work.requests.open, { id: 'requests', label: { ns: 'parties', key: 'customers.work.tile.requests' }, tone: 'warn', door: { kind: 'requests', firstId: work.requests.firstId } })
  add(work.beforeOrder?.toAnswer, { id: 'toAnswer', label: { ns: 'customers-list', key: 'needs.toAnswer' }, tone: 'warn', door: { kind: 'quotes', group: 'TO_ANSWER' } })
  add(work.replies, { id: 'replies', label: { ns: 'parties', key: 'customers.work.tile.replies' }, tone: 'warn', door: { kind: 'replies' } })
  add(work.late, { id: 'late', label: { ns: 'parties', key: 'customers.work.tile.late' }, tone: 'red', door: { kind: 'late' } })
  add(work.waitsForYes, { id: 'waitsForYes', label: { ns: 'orders', key: 'rows.PENDING_APPROVAL' }, tone: 'warn', door: { kind: 'waitsForYes' } })
  add(work.customerUrgent.count, { id: 'customerUrgent', label: { ns: 'orders', key: 'board.customerUrgent' }, tone: 'tag', door: { kind: 'customerUrgent' } })
  add(work.priority.top, { id: 'top', label: { priority: 'URGENT' }, tone: 'tagred', door: { kind: 'priority', level: 'URGENT' } })
  add(work.priority.high, { id: 'high', label: { priority: 'HIGH' }, tone: 'tag', door: { kind: 'priority', level: 'HIGH' } })
  add(work.depositOpen, { id: 'deposit', label: { ns: 'parties', key: 'customers.work.tile.deposit' }, tone: 'quiet', door: { kind: 'deposit' } })
  return chips
}

/** The phases a row's Work cell draws: the Work tab's groups in their order, non-zero only, Done quiet, Cancelled never. */
const WORK_PHASES: readonly OrderPhase[] = ['NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE']

/** Work: its open quotes (before an order, cq's rule), then its orders by where they are. */
export function workChipsOf(work: CustomerWork): WorkChip[] {
  const chips: WorkChip[] = []
  const quotes = work.beforeOrder?.openQuotes
  if (quotes && quotes > 0) chips.push({ id: 'openQuotes', count: quotes, label: { ns: 'parties', key: 'numbers.openQuotes' }, tone: 'quiet', door: { kind: 'quotes', group: 'OPEN_QUOTES' } })
  for (const phase of WORK_PHASES) {
    const count = work.phases.find((entry) => entry.phase === phase)?.count ?? 0
    if (count > 0) chips.push({ id: phase, count, label: groupWordOf(phase), tone: phase === 'DONE' ? 'done' : 'group', door: { kind: 'phase', phase } })
  }
  return chips
}

/** Days from one business date to another (YYYY-MM-DD). */
export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000)
}

/**
 * Next promise (T2, T30): the earliest promise from today on — never a past date (a passed promise is said by "Late n" only);
 * open orders without one ahead: "No promise ahead"; orders, none open: "No open order"; no order: "—".
 */
export type NextPromise = { readonly kind: 'date'; readonly date: string; readonly days: number } | { readonly kind: 'noneAhead' } | { readonly kind: 'noOpen' } | { readonly kind: 'none' }

export function nextPromiseOf(work: Pick<CustomerWork, 'orders' | 'nextPromise' | 'phases'>, today: string): NextPromise {
  if (work.orders === 0) return { kind: 'none' }
  if (work.nextPromise && work.nextPromise >= today) return { kind: 'date', date: work.nextPromise, days: daysBetween(today, work.nextPromise) }
  const open = work.phases.filter((entry) => entry.phase === 'NOT_SENT' || entry.phase === 'NOT_STARTED' || entry.phase === 'IN_PRODUCTION' || entry.phase === 'READY').reduce((sum, entry) => sum + entry.count, 0)
  return open > 0 ? { kind: 'noneAhead' } : { kind: 'noOpen' }
}

/**
 * The fold (T24, measured never guessed): how many chips a cell of `room` px holds in `lines` lines when the rest fold into "+n more"
 * (`more` px wide); the widths are the chips' own, measured in the page. All fit: all; else as many as leave room for "+n more".
 */
export function foldOf(widths: readonly number[], room: number, more: number, lines = 2, gap = 4): number {
  const linesOf = (items: readonly number[]) => {
    let line = 1
    let x = 0
    for (const width of items) {
      const need = x === 0 ? width : x + gap + width
      if (x === 0 || need <= room) x = need
      else {
        line += 1
        x = width
      }
    }
    return line
  }
  if (linesOf(widths) <= lines) return widths.length
  for (let count = widths.length - 1; count > 0; count -= 1) if (linesOf([...widths.slice(0, count), more]) <= lines) return count
  return 0
}

/** The band's groups in their order (Needs us now, then the six phases; Cancelled never), each with its customers and orders. */
export function bandGroupsOf(band: PartyWorkBand): ReadonlyArray<{ readonly group: PartyWorkGroup; readonly customers: number; readonly orders: number | null }> {
  const order: readonly PartyWorkGroup[] = ['NEEDS_US', 'NOT_SENT', 'NOT_STARTED', 'IN_PRODUCTION', 'READY', 'SHIPPED', 'DONE']
  return order.map((group) => band.groups.find((entry) => entry.group === group) ?? { group, customers: 0, orders: group === 'NEEDS_US' ? null : 0 })
}

/** At this page width the list room is wide (≥ 1500 px of list at 1920): Last order and Overdue show at first (T15). */
export const WIDE_ROOM_QUERY = '(min-width: 1700px)'
/** The columns that show at first only in the wide room (else in Customise). */
export const WIDE_ONLY_COLUMNS: readonly string[] = Object.freeze(['lastOrder', 'overdue'])
