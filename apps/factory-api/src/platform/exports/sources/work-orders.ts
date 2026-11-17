import { WORK_ORDER_STATUSES, type WorkOrderStatus } from '@nexus/factory-domain/production/work-orders/machine'
import { WORKORDERS_VIEW } from '@nexus/factory-domain/production/work-orders/permissions'
import { isRelativeDay } from '@nexus/factory-domain/views/quick/relative'
import { listWorkOrders, type ListQuery } from '../../../modules/production/work-orders/work-orders'
import { defineExportSource, /* B-PR-09: shared by the walled lists */ partyTerm } from '../source'
// B-PR-34: the list by risk — its sort and computed filters in the address, the risk, waiting-on and blocked-by cells in words.
import { ValidationError } from '@nexus/factory-domain/core/errors'
import { HEALTH_REASON_CODES } from '@nexus/factory-domain/production-brand/health'
import { WAITING_ON } from '@nexus/factory-domain/production-brand/waiting'
import { HEALTH_REASON_WORDS, HEALTH_WORDS, OFFICE_WAITING_WORDS } from '@nexus/factory-domain/production-brand/words'
import { BLOCKED_BY, LIST_SORTS, WORK_ORDER_RISKS } from '../../../modules/production/work-orders/risk'
// B-PR-42a: the list's "Mine" in the address, and the supervisor cell as the list's (Me / Someone else / Not set, never a name).
import { SUPERVISOR_FILTERS } from '../../../modules/production/work-orders/work-orders'
import { SUPERVISOR_MARKS } from '@nexus/factory-domain/production-brand/supervisor'
import { SUPERVISOR_MARK_WORDS } from '@nexus/factory-domain/production-brand/words'
// B-PR-22b: the customer's urgency cell.
import { CUSTOMER_URGENCY_WORDS, URGENCY_WORDS } from '@nexus/factory-domain/production-brand/words'

/**
 * Production › Work orders (SCR-069, `/production/work-orders`): the export of the list as the screen shows it. The
 * address is the list's own (apps/factory-web areas/production/_shared model.ts viewFromAddress): `?view=open|late|
 * DRAFT|…|all`, or the API's own `?late=true` / `?status=…`, `?q=` and the quick filter `?due=<relative day>` (B-W2b-13);
 * nothing: the open ones. Read through the
 * module's listWorkOrders (workorders.view, its companies and sites). Totals per work order only: no person, no money.
 * B-PR-03 (the brand wall): the list's own wall (its customers too) and its customer filter (`?party=`, or the API's own
 * `partyId`, as Sales › Orders' file reads it); a malformed one is refused, never dropped (a file of every customer for one
 * customer's list). The customer cell names the work order's one customer, and each order with its customer PO.
 * B-PR-34 (the list by risk): the list's own sort (`?sort=risk|due|newest`) and its computed filters (`?waitingOn=`, `?risk=`,
 * `?blockedBy=`), a bad value refused in words as the list refuses it; the cells `risk` ("Late · 3 d", "At risk · raised: …"),
 * `waitingOn` (the office's words: "Waiting on the customer") and `blockedBy`, as the list's columns of the same ids.
 * B-PR-42a (the production supervisor): `?supervisor=me` ("Mine", the only value) and the cell `supervisor` — Me / Someone else /
 * Not set for the person who asked for the file, never a name (worker privacy, as the list).
 */

type Row = Awaited<ReturnType<typeof listWorkOrders>>['workOrders'][number]

const isStatus = (value: string | null): value is WorkOrderStatus => value !== null && (WORK_ORDER_STATUSES as readonly string[]).includes(value)

// ── B-PR-03 ──
// The address's customer (`party`, else the API's `partyId`): ../source partyTerm (B-PR-09 moved it there for every walled list).

/** The customer cell: the work order's customer, then each order with its customer PO ("SO-0001 (PO-42)"). */
function customerText(row: Row): string | null {
  const orders = row.orders.map((order) => `${order.number}${order.customerRef ? ` (${order.customerRef})` : ''}`).join(', ')
  const customer = row.customer?.name ?? [...new Set(row.orders.map((order) => order.partyName))].join(', ')
  return [customer, orders].filter((part) => part !== '').join(' · ') || null
}
// ── end B-PR-03 ──

// ── B-PR-34 ──
/** One of `values` from the address term `name` (absent: undefined); another value is refused, never dropped. */
function termOf<Value extends string>(address: URLSearchParams, name: string, values: readonly Value[]): Value | undefined {
  const value = address.get(name)?.trim()
  if (!value) return undefined
  if ((values as readonly string[]).includes(value)) return value as Value
  throw new ValidationError('The file cannot follow this list: one of its terms is not known.', [{ path: `query/${name}`, message: `Expected one of ${values.join(', ')}.` }])
}

/** The risk cell: its state, the days late, a person's raise with its reason. */
function riskText(row: Row, words: (code: string) => string): string | null {
  const risk = row.risk
  if (!risk) return null
  const parts = [words(`risk.${risk.state}`)]
  if (risk.daysLate !== null) parts.push(`${risk.daysLate} ${words('days')}`)
  if (risk.raised !== null) parts.push(`${words('raised')}: ${words(`reason.${risk.raised}`)}`)
  return parts.join(' · ')
}

/** The office's words of a risk (the customer's health chips where they say the same) and of what blocks a work order. */
const RISK_WORDS = { LATE: HEALTH_WORDS.LATE, AT_RISK: HEALTH_WORDS.AT_RISK, BLOCKED: { it: 'Bloccato', en: 'Blocked' }, ON_TRACK: HEALTH_WORDS.ON_TRACK } as const
const BLOCKED_WORDS = {
  HOLD: { it: 'Blocco', en: 'Hold' },
  CUSTOMER: { it: 'Cliente', en: 'Customer' },
  MATERIAL: { it: 'Materiale', en: 'Material' },
} as const

const wordsOf = (locale: 'it' | 'en'): Record<string, string> => ({
  ...Object.fromEntries(WORK_ORDER_RISKS.map((state) => [`risk.${state}`, RISK_WORDS[state][locale]])),
  ...Object.fromEntries(HEALTH_REASON_CODES.map((code) => [`reason.${code}`, HEALTH_REASON_WORDS[code][locale]])),
  ...Object.fromEntries(WAITING_ON.map((on) => [`waiting.${on}`, OFFICE_WAITING_WORDS[on][locale]])),
  ...Object.fromEntries(BLOCKED_BY.map((by) => [`blocked.${by}`, BLOCKED_WORDS[by][locale]])),
  days: locale === 'it' ? 'gg' : 'd',
  raised: locale === 'it' ? 'segnalato' : 'raised',
  ...Object.fromEntries(SUPERVISOR_MARKS.map((mark) => [`supervisor.${mark}`, SUPERVISOR_MARK_WORDS[mark][locale]])), // B-PR-42a
})
// ── end B-PR-34 ──

export const workOrders = defineExportSource<Omit<ListQuery, 'cursor' | 'limit'>, Row>({
  listKey: 'production.work-orders',
  permission: WORKORDERS_VIEW,
  query(address) {
    const q = address.get('q')?.trim().slice(0, 100) || undefined
    // B-W2b-13 (PLT-167): the quick filter's relative day, as the list reads it.
    const dueWord = address.get('due')
    const due = isRelativeDay(dueWord) ? dueWord : undefined
    // B-W2b-51 (MES-009): the rush quick filter, as the list reads it.
    const rushWord = address.get('rush')
    const rush = rushWord === 'true' ? true : rushWord === 'false' ? false : undefined
    const partyId = partyTerm(address) // B-PR-03
    // B-PR-34: the list's sort and computed filters.
    const ranked = {
      sort: termOf(address, 'sort', LIST_SORTS),
      waitingOn: termOf(address, 'waitingOn', WAITING_ON),
      risk: termOf(address, 'risk', WORK_ORDER_RISKS),
      blockedBy: termOf(address, 'blockedBy', BLOCKED_BY),
      /* B-PR-42a */ supervisor: termOf(address, 'supervisor', SUPERVISOR_FILTERS),
      // B-PR-33: the Overview's "blocked by a gate" and "made before the rule" (the file follows the screen).
      gate: address.get('gate') === 'true' ? true : undefined,
      mixed: address.get('mixed') === 'true' ? true : undefined,
    }
    const view = address.get('view') ?? (address.get('late') === 'true' ? 'late' : (address.get('status') ?? 'open'))
    if (view === 'late') return { late: true, q, due, rush, partyId, ...ranked }
    if (view === 'all') return { q, due, rush, partyId, ...ranked }
    if (isStatus(view)) return { status: view, q, due, rush, partyId, ...ranked }
    return { open: true, q, due, rush, partyId, ...ranked }
  },
  async read(caller, query, cursor, limit) {
    const page = await listWorkOrders(caller, { ...query, cursor: cursor ?? undefined, limit })
    return { rows: page.workOrders, next: page.nextCursor }
  },
  columns: {
    number: { value: (row) => row.number },
    status: { value: (row, words) => words(`status.${row.status}`) },
    style: { value: (row) => `${row.styleCode} · ${row.styleName}${row.revision !== null ? ` r${row.revision}` : ''}` },
    customer: { value: (row) => customerText(row) }, // B-PR-03
    pieces: { value: (row) => row.pieces },
    progress: { value: (row) => row.progress?.finished ?? null },
    due: { value: (row) => (row.dueDate ? { day: row.dueDate } : null) },
    priority: { value: (row) => row.priority },
    // B-W2b-51: the rush flag.
    rush: { value: (row, words) => (row.rush ? words('rush') : null) },
    site: { value: (row) => row.siteCode },
    // B-PR-34: its risk, what it waits on (the office's words) and what blocks it.
    risk: { value: (row, words) => riskText(row, words) },
    waitingOn: { value: (row, words) => (row.waitingOn ? words(`waiting.${row.waitingOn.on}`) : null) },
    blockedBy: { value: (row, words) => (row.risk?.blockedBy ? words(`blocked.${row.risk.blockedBy}`) : null) },
    // B-PR-42a: the production supervisor for the person who asked for the file (Me / Someone else / Not set).
    supervisor: { value: (row, words) => (row.supervisor ? words(`supervisor.${row.supervisor}`) : null) },
    // B-PR-22b: its customer's urgency that counts ("Urgent (customer) 2" / "Regular"; empty: none, or the switch off).
    customerUrgency: { value: (row, words) => (row.customerUrgency === 'URGENT' ? `${words('customerUrgent')}${row.urgentRank !== null ? ` ${row.urgentRank}` : ''}` : row.customerUrgency === 'REGULAR' ? words('customerRegular') : null) },
  },
  words: {
    it: {
      ...wordsOf('it'), // B-PR-34
      customerUrgent: CUSTOMER_URGENCY_WORDS.chip.it, // B-PR-22b
      customerRegular: URGENCY_WORDS.REGULAR.it, // B-PR-22b
      'status.DRAFT': 'Bozza',
      'status.RELEASED': 'Rilasciato',
      'status.IN_PROGRESS': 'In lavorazione',
      'status.COMPLETED': 'Completato',
      'status.CLOSED': 'Chiuso',
      'status.CANCELLED': 'Annullato',
      'status.ON_HOLD': 'In sospeso',
      rush: 'Urgente',
    },
    en: {
      ...wordsOf('en'), // B-PR-34
      customerUrgent: CUSTOMER_URGENCY_WORDS.chip.en, // B-PR-22b
      customerRegular: URGENCY_WORDS.REGULAR.en, // B-PR-22b
      'status.DRAFT': 'Draft',
      'status.RELEASED': 'Released',
      'status.IN_PROGRESS': 'In progress',
      'status.COMPLETED': 'Completed',
      'status.CLOSED': 'Closed',
      'status.CANCELLED': 'Cancelled',
      'status.ON_HOLD': 'On hold',
      rush: 'Rush',
    },
  },
})
