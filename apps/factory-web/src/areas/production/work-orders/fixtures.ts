import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OpenLines, OrderOption, WorkOrderRow } from '../_shared/api'
import { at, canOf, COUNTS, inShell, LIST_ROWS, OPEN_ROWS, PREFIX, type Role } from '../_shared/fixtures'
import { NO_NEW_ORDER, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'
import { DAILY_ROLE_OF, dailyDemo } from './daily/demo/fixtures'
import type { ReadinessRow } from './daily/api'
import type { ReleasePreviewRow } from './every-shift/api'
// F-PR-03: the list by risk (made-up customers, orders, POs, risks and waits).
import type { CustomerFilterState } from '../_shared/customer/model'
// F-PR-21
import { targetsOfRows, type AssignSupervisorModel } from '../../_shared/production-supervisor/model'

/**
 * SCR-069 — Work orders (design production.workorders) with made-up data only: every state of the list (loading, error,
 * empty, nothing matching, short, more pages, live updates), the selection and its bulk actions (Export N, Release N held
 * or not, the release results), the New work order dialog step by step, and the roles: Owner, Production manager, Team
 * leader (floor supervisor in the Office) and Sales (read-only). Ticks, the header box, shift-click, j / k / x / Enter and
 * ? work for real in the review.
 */

interface ListCase {
  role: Role
  list: WorkOrdersListModel
}

// ---- F-PR-03: each row with its customer, its orders' POs, its risk and what it waits on (B-PR-34's row), sorted by risk ----
const ALPHA = { id: '0190f0e2-6666-7000-8000-000000000001', code: 'ALPHA', name: 'Moto Demo S.r.l.' }
const BETA = { id: '0190f0e2-6666-7000-8000-000000000002', code: 'BETA', name: 'Esempio Racing S.p.A.' }
const CUSTOMERS: CustomerFilterState = { options: [ALPHA, BETA], party: null, everyCustomer: true, names: true }
const NOW = Date.parse('2026-10-29T09:42:00Z')
const RISK_OF: Record<string, Pick<WorkOrderRow, 'risk' | 'waitingOn'>> = {
  'WO-00008': { risk: { state: 'LATE', daysLate: 5, plannedEnd: '2026-10-31', planAfterDue: true, raised: null, blockedBy: null }, waitingOn: { on: 'US', since: '2026-10-27T08:00:00Z' } },
  'WO-00003': { risk: { state: 'LATE', daysLate: 2, plannedEnd: null, planAfterDue: false, raised: null, blockedBy: 'CUSTOMER' }, waitingOn: { on: 'BRAND', since: '2026-10-26T15:00:00Z' } },
  'WO-00009': { risk: { state: 'AT_RISK', daysLate: null, plannedEnd: '2026-11-09', planAfterDue: true, raised: null, blockedBy: null }, waitingOn: { on: 'WORKSHOP', since: '2026-10-28T10:00:00Z' } },
  'WO-00012': { risk: { state: 'AT_RISK', daysLate: null, plannedEnd: null, planAfterDue: false, raised: 'MATERIAL_LATE', blockedBy: 'MATERIAL' }, waitingOn: { on: 'SUPPLIER', since: '2026-10-24T09:00:00Z' } },
  'WO-00011': { risk: { state: 'BLOCKED', daysLate: null, plannedEnd: null, planAfterDue: false, raised: null, blockedBy: 'CUSTOMER' }, waitingOn: { on: 'BRAND', since: '2026-10-28T16:30:00Z' } },
  'WO-00010': { risk: { state: 'ON_TRACK', daysLate: null, plannedEnd: '2026-11-14', planAfterDue: false, raised: null, blockedBy: null }, waitingOn: { on: 'US', since: '2026-10-29T07:00:00Z' } },
  'WO-00007': { risk: { state: 'ON_TRACK', daysLate: null, plannedEnd: '2026-11-10', planAfterDue: false, raised: null, blockedBy: null }, waitingOn: null },
}
const RANK = ['LATE', 'AT_RISK', 'BLOCKED', 'ON_TRACK']
/** The list rows as B-PR-34 answers them: the customer (one per work order), the orders' POs, the risk, the wait; by risk. */
export const RISK_ROWS: WorkOrderRow[] = LIST_ROWS.map((row) => {
  const customer = row.orders[0]?.partyName === BETA.name ? BETA : ALPHA
  const facts = RISK_OF[row.number] ?? { risk: null, waitingOn: null }
  return { ...row, customer, mixedCustomers: false, orders: row.orders.map((order) => ({ ...order, customerRef: customer === ALPHA ? 'PO-ESEMPIO-7' : null })), ...facts }
})
  .map((row, index) => ({ row, index }))
  .sort((a, b) => (a.row.risk ? RANK.indexOf(a.row.risk.state) : 9) - (b.row.risk ? RANK.indexOf(b.row.risk.state) : 9) || a.index - b.index)
  .map((entry) => entry.row)
export const RISK_OPEN = RISK_ROWS.filter((row) => ['DRAFT', 'RELEASED', 'IN_PROGRESS'].includes(row.status))
/** A work order made before the one-customer rule (two customers), seen only by a person of every customer. */
const MIXED_ROW: WorkOrderRow = { ...RISK_OPEN[RISK_OPEN.length - 1]!, id: '0190f0e2-9191-7000-8000-000000000099', number: 'WO-00002', customer: null, mixedCustomers: true, risk: { state: 'ON_TRACK', daysLate: null, plannedEnd: null, planAfterDue: false, raised: null, blockedBy: null }, waitingOn: null }
const RISK_COUNTS = { ...COUNTS, onHold: 1, atRisk: 2, waitingOnCustomer: 2 }
const GROUP_COUNTS = { [ALPHA.id]: { draft: 1, released: 1, inProgress: 3, completed: 1, open: 5, late: 1, onHold: 0, atRisk: 2, waitingOnCustomer: 0 }, [BETA.id]: { draft: 1, released: 0, inProgress: 1, completed: 0, open: 2, late: 1, onHold: 0, atRisk: 0, waitingOnCustomer: 2 } }
// ---- end F-PR-03

const base = (role: Role, over: Partial<WorkOrdersListModel> = {}): ListCase => ({
  role,
  list: {
    prefix: PREFIX,
    can: canOf(role),
    view: 'open',
    q: '',
    rows: { items: OPEN_ROWS, more: false, problem: null },
    counts: { ...COUNTS, onHold: 1 },
    asOf: at(29, 9, 42),
    live: 'live',
    updates: 0,
    notice: null,
    newOrder: null,
    release: null,
    // B-W2a-46: the readiness word per row, Hold N.
    readiness: READINESS_ROWS,
    daily: dailyDemo(DAILY_ROLE_OF[role]),
    ...over,
  },
})

/** F-PR-03: a case of the list by risk (rows with their risk, the customer filter, the tiles with At risk and Waiting on customer). */
const risky = (role: Role, over: Partial<WorkOrdersListModel> = {}): ListCase => base(role, { sort: 'risk', rows: { items: RISK_OPEN, more: false, problem: null }, counts: RISK_COUNTS, customers: CUSTOMERS, now: NOW, ...over })

// ---- F-PR-21: the production supervisor on Work orders (made-up): the column says Me / Someone else / Not set (never a name), the
// Mine tile (`?supervisor=me`), "Assign supervisor…" on a selection of two customers' work orders, THE assign dialog's states.
const MARKS = ['ME', 'SOMEONE_ELSE', 'NOT_SET'] as const
const SUPERVISED_ROWS: WorkOrderRow[] = RISK_OPEN.map((row, index) => ({ ...row, supervisor: row.customer ? MARKS[index % MARKS.length]! : null }))
const SUPERVISED_COUNTS = { ...RISK_COUNTS, mine: SUPERVISED_ROWS.filter((row) => row.supervisor === 'ME').length }
const PICKED = [SUPERVISED_ROWS.find((row) => row.customer?.id === ALPHA.id)!, SUPERVISED_ROWS.find((row) => row.customer?.id === BETA.id)!]
const PICKED_TARGETS = targetsOfRows(PICKED, true).targets
const ME = { id: '0190f0e2-7777-7000-8000-000000000001', name: 'Alex Demo', me: true }
const BEA = { id: '0190f0e2-7777-7000-8000-000000000002', name: 'Bea Esempio', me: false }
const assignOf = (over: Partial<AssignSupervisorModel> = {}): AssignSupervisorModel => ({ targets: PICKED_TARGETS, leftOut: 0, current: null, people: { status: 'ready', people: [ME, BEA], complete: true }, busy: false, problem: null, result: null, ...over })
const supervised = (role: Role, over: Partial<WorkOrdersListModel> = {}): ListCase => risky(role, { rows: { items: SUPERVISED_ROWS, more: false, problem: null }, counts: SUPERVISED_COUNTS, supervisorCan: { manage: role === 'manager' || role === 'owner' }, ...over })
// ---- end F-PR-21


const WORDS: ReadinessRow['word'][] = ['NOT_BOOKED', 'EXPECTED', 'NOT_ENOUGH', 'RECEIVED', 'REQUESTED', 'DELAYED', 'NOT_PLANNED']
const READINESS_ROWS: Record<string, ReadinessRow> = Object.fromEntries(
  LIST_ROWS.map((row, index) => [row.id, { workOrderId: row.id, word: WORDS[index % WORDS.length]!, date: WORDS[index % WORDS.length] === 'EXPECTED' ? '2026-11-04' : null, open: index % 3, materials: [], asOf: '2026-10-30' }]),
)
const HELD_ROWS = [{ ...OPEN_ROWS[1]!, status: 'ON_HOLD' as const }]

const ORDER_OPTIONS: OrderOption[] = [
  { id: '0190f0e2-5151-7000-8000-000000000001', number: 'SO-DEMO-0042', partyName: 'Moto Demo S.r.l.', customerRef: 'PO-ESEMPIO-7', status: 'IN_PRODUCTION', units: 64 },
  { id: '0190f0e2-5151-7000-8000-000000000002', number: 'SO-DEMO-0043', partyName: 'Esempio Racing S.p.A.', customerRef: null, status: 'CONFIRMED', units: 30 },
]
const OPEN_LINES: OpenLines = {
  salesOrder: { id: ORDER_OPTIONS[0]!.id, number: 'SO-DEMO-0042', status: 'IN_PRODUCTION' },
  numberPreview: 'WO-00013',
  lines: [
    { id: 'line-1', seq: 1, kind: 'SIZE_GRID', styleId: 'style-1', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourwayId: 'cw-1', colourwayCode: 'BLK', madeToMeasure: false, sizes: [{ size: '48', ordered: 6, onWorkOrders: 4, open: 2 }, { size: '50', ordered: 10, onWorkOrders: 6, open: 4 }, { size: '52', ordered: 10, onWorkOrders: 6, open: 4 }, { size: '54', ordered: 6, onWorkOrders: 4, open: 2 }] },
    { id: 'line-2', seq: 2, kind: 'SIZE_GRID', styleId: 'style-1', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourwayId: 'cw-2', colourwayCode: 'RED', madeToMeasure: false, sizes: [{ size: '50', ordered: 6, onWorkOrders: 3, open: 3 }, { size: '52', ordered: 6, onWorkOrders: 3, open: 3 }] },
    // B-W2b-368: a made-to-measure unit reads as one piece of its base size.
    { id: 'line-3', seq: 3, kind: 'MADE_TO_MEASURE', styleId: 'style-1', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourwayId: 'cw-1', colourwayCode: 'BLK', madeToMeasure: true, sizes: [{ size: '52', ordered: 1, onWorkOrders: 0, open: 1 }] },
    { id: 'line-4', seq: 4, kind: 'SIZE_GRID', styleId: 'style-2', styleCode: 'DEMO-PNT-02', styleName: 'Pantalone pelle demo', colourwayId: 'cw-3', colourwayCode: 'BLK', madeToMeasure: false, sizes: [{ size: '50', ordered: 4, onWorkOrders: 0, open: 4 }] },
  ],
}
const chosen = (over: Partial<NewWorkOrderModel> = {}): NewWorkOrderModel => ({
  ...NO_NEW_ORDER,
  orders: ORDER_OPTIONS,
  chosen: ORDER_OPTIONS[0]!,
  lines: OPEN_LINES,
  styleId: 'style-1',
  picked: ['line-1', 'line-2'],
  grid: { 'line-1': { '48': 2, '50': 4, '52': 4, '54': 2 }, 'line-2': { '50': 3, '52': 3 } },
  ...over,
})

const drafts = OPEN_ROWS.filter((row) => row.status === 'DRAFT')
const REVIEW_ROWS = drafts.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode }))
const released = OPEN_ROWS.find((row) => row.status === 'RELEASED') ?? OPEN_ROWS[2]!
const PREVIEW: ReleasePreviewRow[] = [
  { id: drafts[0]!.id, label: drafts[0]!.number, version: 1, changes: [{ field: 'status', now: 'DRAFT', next: 'RELEASED' }], refusal: null },
  { id: drafts[1]!.id, label: drafts[1]!.number, version: 1, changes: [], refusal: { code: 'held', field: 'status', status: 'DRAFT', reasons: ['DEPOSIT', 'MATERIAL'] } },
  { id: released.id, label: released.number, version: 3, changes: [], refusal: null },
]
const RUSH_ROWS = OPEN_ROWS.map((row, index) => (index % 3 === 0 ? { ...row, rush: true, priority: index + 2 } : row))

function WorkOrdersDesign({ model }: { model: ListCase }) {
  return inShell('/production/work-orders', createElement(WorkOrdersListView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<ListCase>({
  screen: 'SCR-069',
  title: 'Work orders (Production)',
  view: WorkOrdersDesign,
  cases: [
    { id: 'open', label: 'Production manager: the open work orders (the default view), live', model: base('manager'), note: 'Tick a row: the toolbar swaps to Export N and Release N. Press a tile: its saved view.' },
    { id: 'all', label: 'Owner: every work order (Rows ▾ All)', model: base('owner', { view: 'all', rows: { items: LIST_ROWS, more: false, problem: null } }) },
    { id: 'late', label: 'The Late tile pressed', model: base('manager', { view: 'late', rows: { items: LIST_ROWS.filter((row) => (row.daysLate ?? 0) > 0), more: false, problem: null } }) },
    { id: 'drafts-selected', label: 'Two drafts selected: Release 2 can go', model: base('manager', { selected: drafts.map((row) => row.id) }) },
    { id: 'mixed-selected', label: 'A draft and an in-progress one selected: Release opens the review, which says what each row does', model: base('manager', { selected: [drafts[0]!.id, OPEN_ROWS.find((row) => row.status === 'IN_PROGRESS')!.id] }) },
    {
      id: 'release-confirm',
      label: 'Release 2: the review of the rows as they are now',
      model: base('manager', { selected: drafts.map((row) => row.id), release: { rows: REVIEW_ROWS, preview: PREVIEW.slice(0, 2), state: { phase: 'ready' } } }),
    },
    {
      id: 'release-blockers',
      label: 'Release 3: one goes, one is released already, one held with what holds it',
      model: base('manager', { selected: drafts.map((row) => row.id), release: { rows: REVIEW_ROWS, preview: PREVIEW, state: { phase: 'ready' } } }),
    },
    { id: 'release-reading', label: 'Release: reading the rows as they are now', model: base('manager', { selected: drafts.map((row) => row.id), release: { rows: REVIEW_ROWS, preview: null, state: { phase: 'reading' } } }) },
    { id: 'release-failed', label: 'Release: the read failed, Try again', model: base('manager', { selected: drafts.map((row) => row.id), release: { rows: REVIEW_ROWS, preview: null, state: { phase: 'failed', words: { key: 'error.offline' } } } }) },
    {
      id: 'release-results',
      label: 'Release: one released, one refused at Save (the stock changed since the review)',
      model: base('manager', {
        selected: drafts.map((row) => row.id),
        release: {
          rows: REVIEW_ROWS,
          preview: PREVIEW.slice(0, 2),
          state: { phase: 'done', results: [{ id: PREVIEW[0]!.id, label: PREVIEW[0]!.label, ok: true, refusal: null, version: 2 }, { id: PREVIEW[1]!.id, label: PREVIEW[1]!.label, ok: false, refusal: { code: 'held', field: 'status', status: 'DRAFT', reasons: ['MATERIAL'] }, version: 1 }] },
        },
      }),
    },
    { id: 'live-updates', label: 'Live: 3 changes wait behind Show (rows never move under the cursor)', model: base('manager', { updates: 3 }) },
    { id: 'more', label: 'More pages: Show 50 more in the footer', model: base('manager', { rows: { items: OPEN_ROWS, more: true, problem: null } }) },
    { id: 'short', label: 'A short list: two rows, no empty band', model: base('manager', { rows: { items: OPEN_ROWS.slice(0, 2), more: false, problem: null } }) },
    { id: 'no-match', label: 'A search that matches nothing', model: base('manager', { q: 'XYZ-404', rows: { items: [], more: false, problem: null } }) },
    { id: 'empty', label: 'No work orders yet (the manager may make one)', model: base('manager', { rows: { items: [], more: false, problem: null }, counts: { draft: 0, released: 0, inProgress: 0, completed: 0, open: 0, late: 0 } }) },
    { id: 'loading', label: 'Loading', model: base('manager', { rows: { items: null, more: false, problem: null }, counts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The read failed: in words, with Try again (never drawn as empty)', model: base('manager', { rows: { items: null, more: false, problem: 'error.offline' }, counts: null, live: 'offline' }) },
    { id: 'no-permission', label: 'No permission: the API refused the read (workorders.view)', model: base('sales', { rows: { items: null, more: false, problem: 'error.forbidden' }, counts: null }) },
    { id: 'notice', label: 'After a write: a notice above the list', model: base('manager', { notice: { tone: 'success', words: { key: 'notice.released', params: { batch: 'BA-00052' } } } }) },
    { id: 'sales', label: 'Sales (read-only): sees the work orders of its orders; New and Release held with the reason', model: base('sales', { selected: [drafts[0]!.id] }) },
    { id: 'team-leader', label: 'Team leader (floor supervisor in the Office): reads, releases nothing', model: base('teamLeader') },
    { id: 'help', label: '? the keys of this list', model: base('manager', { helpOpen: true }) },
    // B-W2b-13: the W2b list frame on this list (the design's own example, "Edit 12 work orders").
    { id: 'w2b-board', label: 'W2b · Board by state (lanes with the tiles’ counts): a state changes through its own step, said on the board', model: base('manager', { mode: 'board', view: 'all', rows: { items: LIST_ROWS, more: false, problem: null }, today: '2026-10-30' }) },
    { id: 'w2b-calendar', label: 'W2b · Calendar by due date: work orders per day, the day’s list, the ones without a due date', model: base('manager', { mode: 'calendar', view: 'all', rows: { items: LIST_ROWS, more: false, problem: null }, today: '2026-10-30' }) },
    { id: 'w2b-cards', label: 'W2b · Cards (a phone draws these by itself): the same columns and Select mode', model: base('manager', { mode: 'cards' }) },
    { id: 'w2b-due', label: 'W2b · Quick filter “Due: This week” as a chip (the word stays in the address; the API resolves it)', model: base('manager', { due: 'this-week', rows: { items: OPEN_ROWS.slice(0, 2), more: false, problem: null } }) },
    { id: 'w2b-due-none', label: 'W2b · Quick filter “Due: Overdue” matching nothing: Clear filters', model: base('manager', { due: 'overdue', rows: { items: [], more: false, problem: null } }) },
    { id: 'new-search', label: 'New work order: the open sales orders', model: base('manager', { newOrder: { ...NO_NEW_ORDER, orders: ORDER_OPTIONS } }) },
    { id: 'new-lines', label: 'New work order: an order chosen, its open lines of one style, the pieces per size, the number it will get', model: base('manager', { newOrder: chosen() }) },
    {
      id: 'new-two-styles',
      label: 'New work order: the order makes two styles (one work order makes one)',
      model: base('manager', { newOrder: chosen({ styleId: 'style-2', picked: ['line-4'], grid: { 'line-4': { '50': 4 } } }) }),
    },
    { id: 'new-over', label: 'New work order: a size asks more than is open: Create held, the cell says why', model: base('manager', { newOrder: chosen({ grid: { 'line-1': { '48': 5, '50': 4, '52': 4, '54': 2 }, 'line-2': { '50': 3, '52': 3 } } }) }) },
    // B-W2b-368 (XF1:01): a made-to-measure unit ticked alone (its own work order, one piece of its base size).
    { id: 'new-unit', label: 'New work order: a made-to-measure unit ticked — alone, one piece of its base size (its own work order)', model: base('manager', { newOrder: chosen({ picked: ['line-3'], grid: { 'line-3': { '52': 1 } } }) }) },
    { id: 'new-failed', label: 'New work order: the API refused it (the order changed meanwhile)', model: base('manager', { newOrder: chosen({ problem: { key: 'error.conflict' } }) }) },
    { id: 'new-none', label: 'New work order: no confirmed order matches', model: base('manager', { newOrder: { ...NO_NEW_ORDER, query: 'ZZZ', orders: [] } }) },
    // ---- B-W2a-46: readiness word, On hold, Hold N ----
    // ---- B-W2b-59: rush, Release N, Print travellers ----
    { id: 'w2b-rush', label: 'W2b · Rush beside the priority (Edit N changes both; the quick filter Rush)', model: base('manager', { rows: { items: RUSH_ROWS, more: false, problem: null } }) },
    { id: 'w2b-rush-filter', label: 'W2b · The quick filter “Rush” as a chip (`?rush=true`)', model: base('manager', { rush: true, rows: { items: RUSH_ROWS.filter((row) => row.rush), more: false, problem: null } }) },
    { id: 'w2b-no-draft', label: 'W2b · Selected rows with no draft: Release held with the reason', model: base('manager', { selected: [released.id] }) },
    { id: 'w2a-readiness', label: 'W2a · The Readiness column (the plan’s word per work order) and the On hold tile', model: base('manager') },
    { id: 'w2a-on-hold', label: 'W2a · The On hold view (tile pressed)', model: base('manager', { view: 'ON_HOLD', rows: { items: HELD_ROWS, more: false, problem: null } }) },
    { id: 'w2a-hold-many', label: 'W2a · Two rows selected: Hold 2 — one hold over both, the reason asked', model: base('manager', { selected: OPEN_ROWS.slice(0, 2).map((row) => row.id), daily: { ...dailyDemo('manager'), dialog: { kind: 'hold', workOrderIds: OPEN_ROWS.slice(0, 2).map((row) => row.id), numbers: OPEN_ROWS.slice(0, 2).map((row) => row.number) }, draft: { reasonCode: 'CUSTOMER_REQUEST', note: 'Il cliente sospende la stagione' } } }) },
    { id: 'w2a-hold-many-held', label: 'W2a · Hold N held: a selected work order is not open (completed), in words', model: base('manager', { view: 'all', rows: { items: LIST_ROWS, more: false, problem: null }, selected: LIST_ROWS.filter((row) => ['COMPLETED', 'IN_PROGRESS'].includes(row.status)).slice(0, 2).map((row) => row.id) }) },
    { id: 'w2a-hold-many-no-right', label: 'W2a · Sales: Hold N held (quality.holds.place)', model: base('sales', { selected: OPEN_ROWS.slice(0, 1).map((row) => row.id) }) },
    { id: 'w2a-held-notice', label: 'W2a · After Hold 2: the notice', model: base('manager', { notice: { tone: 'success', words: { key: 'production-work-orders:notice.heldMany', params: { count: 2 } } } }) },
    // ---- F-PR-03: the list by risk ----
    { id: 'risk', label: 'F-PR-03 · Sorted by risk (the default): Customer with its order and PO, Stage, Done, Health, Waiting on, Blocked by', model: risky('manager'), note: 'Sort ▾ Risk first · Due date · Newest first; Quick filters ▾ Waiting on, Health, Blocked by; Group ▾ By customer.' },
    { id: 'risk-tile', label: 'F-PR-03 · The At risk tile pressed (`?risk=AT_RISK`): its chip, the export follows', model: risky('manager', { risk: 'AT_RISK', rows: { items: RISK_OPEN.filter((row) => row.risk?.state === 'AT_RISK'), more: false, problem: null } }) },
    { id: 'risk-waiting', label: 'F-PR-03 · Waiting on customer (`?waitingOn=BRAND`) with Blocked by Customer (two chips)', model: risky('manager', { waitingOn: 'BRAND', blockedBy: 'CUSTOMER', rows: { items: RISK_OPEN.filter((row) => row.waitingOn?.on === 'BRAND'), more: false, problem: null } }) },
    { id: 'risk-customer', label: 'F-PR-03 · One customer picked (`?party=`): its rows and its tiles only', model: risky('manager', { customers: { ...CUSTOMERS, party: BETA.id }, counts: GROUP_COUNTS[BETA.id], rows: { items: RISK_OPEN.filter((row) => row.customer?.id === BETA.id), more: false, problem: null } }) },
    { id: 'risk-grouped', label: 'F-PR-03 · Grouped by customer: each header the server’s figures for that customer; a mixed work order said apart', model: risky('owner', { group: 'party', rows: { items: [...RISK_OPEN, MIXED_ROW], more: false, problem: null }, groupCounts: GROUP_COUNTS }) },
    { id: 'risk-grouped-reading', label: 'F-PR-03 · Grouped by customer: one customer’s figures still read, one failed (Try again)', model: risky('manager', { group: 'party', groupCounts: { [ALPHA.id]: 'reading', [BETA.id]: 'failed' } }) },
    { id: 'risk-limited', label: 'F-PR-03 · An office person limited to one customer: All my customers, its code (no parties.view), nothing of the other', model: risky('sales', { customers: { options: [BETA], party: null, everyCustomer: false, names: false }, counts: GROUP_COUNTS[BETA.id], rows: { items: RISK_OPEN.filter((row) => row.customer?.id === BETA.id), more: false, problem: null } }) },
    { id: 'risk-board', label: 'F-PR-03 · Board by state: each card the customer code, its health and who it waits on', model: risky('manager', { mode: 'board', view: 'all', rows: { items: RISK_ROWS, more: false, problem: null }, today: '2026-10-29' }) },
    { id: 'risk-no-match', label: 'F-PR-03 · Blocked by Hold matches nothing: Clear filters (the sort and the grouping stay)', model: risky('manager', { blockedBy: 'HOLD', rows: { items: [], more: false, problem: null } }) },
    // ---- F-PR-21 ----
    { id: 'supervisor-column', label: 'F-PR-21 · The Supervisor column: Me / Someone else / Not set (names only inside one record); the Mine tile', model: supervised('manager') },
    { id: 'supervisor-mine', label: 'F-PR-21 · Mine pressed (`?supervisor=me`): the work orders I supervise; the export and a saved view follow it', model: supervised('manager', { supervisor: 'me', rows: { items: SUPERVISED_ROWS.filter((row) => row.supervisor === 'ME'), more: false, problem: null } }) },
    { id: 'supervisor-selected', label: 'F-PR-21 · Two customers\u2019 work orders selected: Assign supervisor… in the bar', model: supervised('manager', { selected: PICKED.map((row) => row.id) }) },
    { id: 'supervisor-held', label: 'F-PR-21 · Without production.brand.manage: Assign supervisor… held in words', model: supervised('sales', { selected: PICKED.map((row) => row.id) }) },
    { id: 'supervisor-assign', label: 'F-PR-21 · THE assign dialog: the orders named, 2 customers, only people allowed on both, Customer default', model: supervised('manager', { selected: PICKED.map((row) => row.id), assign: assignOf() }) },
    { id: 'supervisor-assign-loading', label: 'F-PR-21 · The assign dialog while it reads who may supervise', model: supervised('manager', { assign: assignOf({ people: { status: 'loading' } }) }) },
    { id: 'supervisor-assign-failed', label: 'F-PR-21 · The assign dialog: who may supervise could not be read (Try again)', model: supervised('manager', { assign: assignOf({ people: { status: 'error', problem: 'problem.people' } }) }) },
    { id: 'supervisor-assign-nobody', label: 'F-PR-21 · Nobody may take both customers: what a supervisor needs, in words; Customer default still offered', model: supervised('manager', { assign: assignOf({ people: { status: 'ready', people: [], complete: true } }) }) },
    {
      id: 'supervisor-assign-result',
      label: 'F-PR-21 · After Send: one result per order (Done, Already so, Not done: why), one more counted, never named',
      model: supervised('manager', {
        assign: assignOf({
          result: {
            supervisor: { name: BEA.name, active: true },
            lines: [
              { orderId: PICKED_TARGETS[0]!.orderId, number: PICKED_TARGETS[0]!.number, state: 'changed' },
              { orderId: PICKED_TARGETS[1]!.orderId, number: PICKED_TARGETS[1]!.number, state: 'skipped', key: 'skip.NO_MEASUREMENTS' },
            ],
            unknown: 1,
          },
        }),
      }),
    },
    // ---- end F-PR-21
  ],
})
