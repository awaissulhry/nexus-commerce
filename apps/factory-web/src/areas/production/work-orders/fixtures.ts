import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OpenLines, OrderOption } from '../_shared/api'
import { at, canOf, COUNTS, inShell, LIST_ROWS, OPEN_ROWS, PREFIX, type Role } from '../_shared/fixtures'
import { NO_NEW_ORDER, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'
import { DAILY_ROLE_OF, dailyDemo } from './daily/demo/fixtures'
import type { ReadinessRow } from './daily/api'

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
    { id: 'line-3', seq: 3, kind: 'MADE_TO_MEASURE', styleId: 'style-1', styleCode: 'DEMO-JKT-01', styleName: 'Giacca pelle demo', colourwayId: 'cw-1', colourwayCode: 'BLK', madeToMeasure: true, sizes: [] },
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
    { id: 'mixed-selected', label: 'A draft and an in-progress one selected: Release is held with its reason', model: base('manager', { selected: [drafts[0]!.id, OPEN_ROWS.find((row) => row.status === 'IN_PROGRESS')!.id] }) },
    {
      id: 'release-confirm',
      label: 'Release 2: the confirm with what it does',
      model: base('manager', { selected: drafts.map((row) => row.id), release: { rows: drafts.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode })), running: false, done: false, results: {} } }),
    },
    {
      id: 'release-results',
      label: 'Release 2: one released with its batch, one still a draft with what holds it',
      model: base('manager', {
        selected: drafts.map((row) => row.id),
        release: {
          rows: drafts.map((row) => ({ id: row.id, number: row.number, styleCode: row.styleCode })),
          running: false,
          done: true,
          results: { [drafts[0]!.id]: { state: 'released', batchNumber: 'BA-00052' }, [drafts[1]!.id]: { state: 'held', codes: ['DEPOSIT', 'MATERIAL'] } },
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
    { id: 'new-search', label: 'New work order: the open sales orders', model: base('manager', { newOrder: { ...NO_NEW_ORDER, orders: ORDER_OPTIONS } }) },
    { id: 'new-lines', label: 'New work order: an order chosen, its open lines of one style, the pieces per size, the number it will get', model: base('manager', { newOrder: chosen() }) },
    {
      id: 'new-two-styles',
      label: 'New work order: the order makes two styles (one work order makes one)',
      model: base('manager', { newOrder: chosen({ styleId: 'style-2', picked: ['line-4'], grid: { 'line-4': { '50': 4 } } }) }),
    },
    { id: 'new-over', label: 'New work order: a size asks more than is open: Create held, the cell says why', model: base('manager', { newOrder: chosen({ grid: { 'line-1': { '48': 5, '50': 4, '52': 4, '54': 2 }, 'line-2': { '50': 3, '52': 3 } } }) }) },
    { id: 'new-failed', label: 'New work order: the API refused it (the order changed meanwhile)', model: base('manager', { newOrder: chosen({ problem: { key: 'error.conflict' } }) }) },
    { id: 'new-none', label: 'New work order: no confirmed order matches', model: base('manager', { newOrder: { ...NO_NEW_ORDER, query: 'ZZZ', orders: [] } }) },
    // ---- B-W2a-46: readiness word, On hold, Hold N ----
    { id: 'w2a-readiness', label: 'W2a · The Readiness column (the plan’s word per work order) and the On hold tile', model: base('manager') },
    { id: 'w2a-on-hold', label: 'W2a · The On hold view (tile pressed)', model: base('manager', { view: 'ON_HOLD', rows: { items: HELD_ROWS, more: false, problem: null } }) },
    { id: 'w2a-hold-many', label: 'W2a · Two rows selected: Hold 2 — one hold over both, the reason asked', model: base('manager', { selected: OPEN_ROWS.slice(0, 2).map((row) => row.id), daily: { ...dailyDemo('manager'), dialog: { kind: 'hold', workOrderIds: OPEN_ROWS.slice(0, 2).map((row) => row.id), numbers: OPEN_ROWS.slice(0, 2).map((row) => row.number) }, draft: { reasonCode: 'CUSTOMER_REQUEST', note: 'Il cliente sospende la stagione' } } }) },
    { id: 'w2a-hold-many-held', label: 'W2a · Hold N held: a selected work order is not open (completed), in words', model: base('manager', { view: 'all', rows: { items: LIST_ROWS, more: false, problem: null }, selected: LIST_ROWS.filter((row) => ['COMPLETED', 'IN_PROGRESS'].includes(row.status)).slice(0, 2).map((row) => row.id) }) },
    { id: 'w2a-hold-many-no-right', label: 'W2a · Sales: Hold N held (quality.holds.place)', model: base('sales', { selected: OPEN_ROWS.slice(0, 1).map((row) => row.id) }) },
    { id: 'w2a-held-notice', label: 'W2a · After Hold 2: the notice', model: base('manager', { notice: { tone: 'success', words: { key: 'production-work-orders:notice.heldMany', params: { count: 2 } } } }) },
  ],
})
