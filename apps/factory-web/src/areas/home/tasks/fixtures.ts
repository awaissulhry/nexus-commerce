import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { TaskItem } from '../../../record-panels/tasks/model'
import type { TaskRow, TasksList, TasksViewModel } from './model'
import { TasksView } from './view/TasksView'

/**
 * SCR-233 My tasks — made-up data only (PLAN §3.1): invented people at no real company, invented records and dates. Each
 * case is one state the Owner reviews: my tasks, a tile pressed, made by me, the selection with its bulk actions, the
 * popup, New task, Reassign, Set due, a task just ticked done (Undo), live updates waiting, a read-only person (no
 * tasks.manage), offline, empty, loading, an error and no permission.
 */

const PREFIX = '/w/DEMO'
const ME = { id: '0190f0e2-3333-7000-8000-000000000001', name: 'Alex Demo', me: true }
const BEA = { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Bea Esempio', me: false }
const CARLO = { id: '0190f0e2-3333-7000-8000-000000000003', name: 'Carlo Prova', me: false }
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
const tid = (n: number) => `0190f0e2-4444-7000-8000-${String(n).padStart(12, '0')}`
const NOW = Date.UTC(2026, 9, 29, 9, 42)

function task(n: number, extra: Partial<TaskItem>): TaskRow {
  const base: TaskItem = {
    id: tid(n),
    title: 'Attività di esempio',
    description: null,
    record: null,
    companyId: null,
    siteId: null,
    partyId: null,
    assignee: ME,
    assignedBy: null,
    assignedAt: null,
    dueDate: null,
    dueTime: null,
    due: null,
    checklist: [],
    progress: null,
    status: 'OPEN',
    tile: 'NO_DATE',
    closedAt: null,
    closedBy: null,
    snoozedUntil: null,
    snoozed: false,
    createdBy: ME,
    createdAt: at(20, 8),
    updatedAt: at(20, 8),
    version: 1,
    relation: 'ASSIGNEE',
    canChange: true,
    ...extra,
  }
  return { ...base, href: `${PREFIX}/home/tasks?open=${base.id}`, recordHref: base.record ? `${PREFIX}/records/${base.record.type}/${base.record.id}` : null }
}

const QUOTE = { type: 'Quote', id: '0190f0e2-5555-7000-8000-000000000142', label: 'Q-2026-0142' }
const LOT = { type: 'Lot', id: '0190f0e2-5555-7000-8000-000000000088', label: 'L-0088' }
const PO = { type: 'PurchaseOrder', id: '0190f0e2-5555-7000-8000-000000000031', label: 'PO-2026-0031' }

const ROWS: TaskRow[] = [
  task(1, {
    title: 'Chiamare la Conceria Esempio per il lotto L-0088',
    record: LOT,
    dueDate: '2026-10-27',
    due: { date: '2026-10-27', days: -2, word: 'OVERDUE' },
    tile: 'OVERDUE',
    assignedBy: BEA,
    assignedAt: at(26, 15),
    createdBy: BEA,
    relation: 'ASSIGNEE',
    description: 'Il lotto è arrivato con due pelli fuori spessore. Chiedere sostituzione o nota di credito.',
    checklist: [
      { id: 'c1', text: 'Foto delle pelli allegate al lotto', done: true, doneAt: at(27, 10), doneBy: { id: BEA.id, name: BEA.name } },
      { id: 'c2', text: 'Telefonata al commerciale', done: false, doneAt: null, doneBy: null },
      { id: 'c3', text: 'Nota sul lotto con l’esito', done: false, doneAt: null, doneBy: null },
    ],
    progress: { done: 1, total: 3 },
    version: 4,
  }),
  task(2, { title: 'Verificare il margine del preventivo Q-2026-0142', record: QUOTE, dueDate: '2026-10-29', dueTime: '16:00', due: { date: '2026-10-29', days: 0, word: 'TODAY' }, tile: 'TODAY', version: 2 }),
  task(3, { title: 'Sollecitare la conferma del PO-2026-0031', record: PO, dueDate: '2026-11-02', due: { date: '2026-11-02', days: 4, word: 'SOON' }, tile: 'THIS_WEEK', snoozedUntil: at(30, 7), snoozed: true, version: 3 }),
  task(4, { title: 'Preparare la lista delle taglie per il campionario', tile: 'NO_DATE' }),
  task(5, { title: 'Aggiornare il listino accessori', record: null, dueDate: '2026-11-20', due: { date: '2026-11-20', days: 22, word: null }, tile: null, createdBy: CARLO, assignedBy: CARLO, assignedAt: at(25, 9) }),
]
const TILES: TasksList['tiles'] = [
  { tile: 'OVERDUE', count: 1 },
  { tile: 'TODAY', count: 1 },
  { tile: 'THIS_WEEK', count: 1 },
  { tile: 'NO_DATE', count: 1 },
  { tile: 'DONE_7D', count: 3 },
]
const ready = (rows: readonly TaskRow[], extra: Partial<TasksList> = {}): TasksViewModel['list'] => ({ status: 'ready', data: { asOf: at(29, 9, 40), tiles: TILES, total: rows.length, complete: true, rows, more: false, loadingMore: false, ...extra } })

function model(overrides: Partial<TasksViewModel> = {}): TasksViewModel {
  return {
    access: 'open',
    now: NOW,
    prefix: PREFIX,
    me: ME.id,
    canManage: true,
    live: 'live',
    scope: 'MINE',
    tile: null,
    q: '',
    list: ready(ROWS),
    updates: 0,
    selected: [],
    open: null,
    dialog: null,
    busy: false,
    notice: null,
    ...overrides,
  }
}

const PEOPLE = { status: 'ready' as const, data: [ME, BEA, CARLO] }
const DONE: TaskRow[] = [
  task(11, { title: 'Inviare il certificato al marchio', record: QUOTE, status: 'DONE', tile: 'DONE_7D', closedAt: at(28, 11), closedBy: ME, dueDate: '2026-10-28', due: { date: '2026-10-28', days: -1, word: 'OVERDUE' } }),
  task(12, { title: 'Controllare le etichette del lotto', record: LOT, status: 'DONE', tile: 'DONE_7D', closedAt: at(27, 16), closedBy: ME }),
]

export const designScreen = defineDesignScreen<TasksViewModel>({
  screen: 'SCR-233',
  title: 'My tasks: tiles, mine or made by me, the list, the popup, bulk actions',
  view: TasksView,
  cases: [
    { id: 'mine', label: 'My tasks', model: model(), note: 'Overdue, today, this week, no date, later; the due day in words with an icon; the record as a link; the checklist; a snoozed task says until when.' },
    { id: 'tile-overdue', label: 'Overdue tile pressed', model: model({ tile: 'OVERDUE', list: ready(ROWS.slice(0, 1)) }), note: 'A tile is a filter of the list (aria-pressed); pressing it again clears it.' },
    { id: 'done-7d', label: 'Done in 7 days', model: model({ tile: 'DONE_7D', list: ready(DONE) }), note: 'Done tasks with their box ticked: unticking reopens one.' },
    { id: 'created', label: 'Created by me', model: model({ scope: 'CREATED', list: ready([task(21, { title: 'Chiedere a Bea il campione taglia 52', assignee: BEA, relation: 'CREATOR', dueDate: '2026-10-30', due: { date: '2026-10-30', days: 1, word: 'SOON' }, tile: 'THIS_WEEK' }), task(22, { title: 'Controllare il PO del filo', assignee: null, relation: 'CREATOR', record: PO })]) }), note: 'Tasks I gave to others (or to nobody yet). My team\'s is held: teams come with People.' },
    { id: 'selected', label: 'Three tasks selected', model: model({ selected: [ROWS[0]!.id, ROWS[1]!.id, ROWS[3]!.id], focusRow: 0 }), note: 'Mark 3 done · Reassign 3 · Set due for 3 in the toolbar, in place of the search.' },
    { id: 'popup', label: 'The task’s popup', model: model({ open: { id: ROWS[0]!.id, task: { status: 'ready', data: ROWS[0]! }, people: PEOPLE } }), note: 'For whom and the due day save at once; tick the checklist; Mark done (E), Snooze; J / K step through the list.' },
    { id: 'popup-done', label: 'A done task’s popup (Reopen)', model: model({ tile: 'DONE_7D', list: ready(DONE), open: { id: DONE[0]!.id, task: { status: 'ready', data: DONE[0]! }, people: null } }) },
    { id: 'new-task', label: 'New task', model: model({ dialog: { kind: 'new', people: PEOPLE } }), note: 'Title, for whom (me by default), due day, checklist one per line, description; ⌘Enter creates.' },
    { id: 'reassign', label: 'Reassign 2 tasks', model: model({ selected: [ROWS[1]!.id, ROWS[3]!.id], dialog: { kind: 'reassign', ids: [ROWS[1]!.id, ROWS[3]!.id], people: PEOPLE } }), note: 'Whom to, then each task with whose it is now and whose it becomes; all or none.' },
    { id: 'set-due', label: 'Set due for 2 tasks', model: model({ selected: [ROWS[1]!.id, ROWS[3]!.id], dialog: { kind: 'due', ids: [ROWS[1]!.id, ROWS[3]!.id] } }) },
    { id: 'snooze', label: 'Snooze a task', model: model({ open: { id: ROWS[1]!.id, task: { status: 'ready', data: ROWS[1]! }, people: PEOPLE }, dialog: { kind: 'snooze', id: ROWS[1]!.id } }), note: 'Later today 16:00 · Tomorrow 08:00 · Monday 08:00 · Pick a date: it leaves Today until then.' },
    { id: 'done-undo', label: 'Just ticked done (Undo)', model: model({ list: ready(ROWS.map((row, index) => (index === 1 ? { ...row, status: 'DONE' as const, tile: 'DONE_7D' as const } : row))), notice: { key: 'notice.done', tone: 'success', params: { title: ROWS[1]!.title }, undo: true } }), note: 'At once, with Undo in the notice.' },
    { id: 'updates', label: 'Live: 2 updates waiting', model: model({ updates: 2 }), note: 'Rows never move under the cursor: "2 updates · Show".' },
    { id: 'read-only', label: 'No tasks.manage (read only)', model: model({ canManage: false, list: ready(ROWS.map((row) => ({ ...row, canChange: false }))) }), note: 'New task, the Done box and the bulk actions say why they are held; the list reads.' },
    { id: 'offline', label: 'Offline', model: model({ live: 'offline' }), note: 'Changes are held: "Offline — change it when back online."' },
    { id: 'empty', label: 'No tasks', model: model({ list: ready([], { tiles: TILES.map((tile) => ({ ...tile, count: 0 })) }) }) },
    { id: 'empty-filtered', label: 'Nothing matches the search', model: model({ q: 'campione', list: ready([]) }) },
    { id: 'loading', label: 'Loading', model: model({ list: { status: 'loading' } }) },
    { id: 'error', label: 'Could not be read', model: model({ list: { status: 'error', problem: 'tasks.problem.offline' } }) },
    { id: 'no-permission', label: 'No permission (no Home)', model: model({ access: 'refused', list: { status: 'loading' } }) },
  ],
})
