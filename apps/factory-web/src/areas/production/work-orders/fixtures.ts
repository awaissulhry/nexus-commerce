import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OpenLines, OrderOption } from '../_shared/api'
import { at, canOf, COUNTS, inShell, LIST_ROWS, OPEN_ROWS, PREFIX, type Role } from '../_shared/fixtures'
import { NO_NEW_ORDER, type NewWorkOrderModel, type WorkOrdersListModel } from './list-model'
import { WorkOrdersListView } from './view/WorkOrdersListView'
import { DAILY_ROLE_OF, dailyDemo } from './daily/demo/fixtures'
import type { ReadinessRow } from './daily/api'
import type { ReleasePreviewRow } from './every-shift/api'

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
  ],
})
