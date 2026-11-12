import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import type { DesignCase } from '../../../../lib/design/design-screen'
import { DEMO_SITE, signedInFrame } from '../../../frame/fixtures'
import type { MyWorkViewModel } from '../view/MyWorkView'
import type { KindCounts, TaskInbox, WarehouseTask } from './model'
import type { InboxViewModel } from './view/InboxView'

/**
 * SCR-089's warehouse cases (B-W2b-308; design floor.mywork sec:queue "Variants: warehouse task inbox"): made-up tasks of a
 * made-up "Demo" plant on a warehouse tablet (no station) — receive, put away, pick, move, count and a hold's quarantine move,
 * next first; never another person, never a name, no money.
 */

export const NOW = '2026-11-12T09:30:00.000Z'
const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
/** A made-up hide tag of the made-up tenant. */
export const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const AS_OF = '2026-11-12T09:12:00.000Z'

const place = (code: string, kind: string, name: string) => ({ id: `loc-${code.toLowerCase()}`, code, name, kind })
export const DOCK = place('A1-RCV', 'RECEIVING', 'Ricevimento merci (demo)')
export const BULK = place('A1-BULK-01', 'BULK', 'Scaffale scorta 1 (demo)')
export const QUA = place('A1-QUA', 'QUARANTINE', 'Quarantena qualità (demo)')
export const STORE = place('A1-STORE-01', 'BIN', 'Cella pelli 1 (demo)')
export const PICK = place('A1-PF-01', 'PICK_FACE', 'Fronte di prelievo 1 (demo)')

export const task = (id: string, extra: Partial<WarehouseTask>): WarehouseTask => ({
  id,
  kind: 'PUT_AWAY',
  status: 'OPEN',
  source: null,
  item: { id: 'item-lin', code: 'FOD-MESH', name: 'Fodera rete traspirante (demo)', baseUom: 'M' },
  colour: { code: 'NERO', name: 'Nero' },
  lot: { id: 'lot-31', code: 'LOT-DEMO-0031' },
  hide: null,
  from: DOCK,
  to: BULK,
  quantity: '30.0000',
  uom: 'M',
  dueAt: null,
  note: null,
  version: 1,
  createdAt: '2026-11-12T08:05:00.000Z',
  audience: 'ANYONE',
  mine: false,
  ...extra,
})

export const TASKS: WarehouseTask[] = [
  task('t-put', { mine: true, status: 'TAKEN', audience: 'ROLE', source: { type: 'GoodsReceipt', id: 'gr-1' } }),
  task('t-qua', { kind: 'QUARANTINE', lot: { id: 'lot-9', code: 'LOT-DEMO-0009' }, item: { id: 'item-lea', code: 'PEL-BOV-12', name: 'Pelle bovina pieno fiore 1,2 mm (demo)', baseUom: 'FT2' }, colour: { code: 'NERO', name: 'Nero' }, from: STORE, to: QUA, quantity: '204.1000', uom: 'FT2', dueAt: '2026-11-12T09:00:00.000Z', source: { type: 'QualityHold', id: 'hold-1' } }),
  task('t-rcv', { kind: 'RECEIVE', lot: null, item: null, colour: null, from: null, to: DOCK, quantity: null, uom: null, dueAt: '2026-11-12T11:00:00.000Z', source: { type: 'PurchaseOrder', id: 'po-1' }, note: 'Consegna attesa in mattinata (demo)' }),
  task('t-pick', { kind: 'PICK', lot: null, item: null, colour: null, from: PICK, to: null, quantity: null, uom: null, audience: 'MINE', source: { type: 'WorkOrder', id: 'wo-1' }, dueAt: '2026-11-12T13:00:00.000Z' }),
  task('t-move', { kind: 'MOVE', hide: { id: 'h-1', code: HIDE }, lot: { id: 'lot-7', code: 'LOT-DEMO-0007' }, item: { id: 'item-lea', code: 'PEL-BOV-12', name: 'Pelle bovina pieno fiore 1,2 mm (demo)', baseUom: 'FT2' }, from: STORE, to: PICK, quantity: '52.4000', uom: 'FT2' }),
  task('t-count', { kind: 'COUNT', lot: null, item: null, colour: null, from: place('A1-CNT-01', 'BIN', 'Baia conta (demo)'), to: null, quantity: null, uom: null, source: { type: 'CountSchedule', id: 'cs-1' }, dueAt: '2026-11-12T07:00:00.000Z' }),
]

const counts = (tasks: readonly WarehouseTask[]): KindCounts => ({
  RECEIVE: tasks.filter((entry) => entry.kind === 'RECEIVE').length,
  PUT_AWAY: tasks.filter((entry) => entry.kind === 'PUT_AWAY').length,
  PICK: tasks.filter((entry) => entry.kind === 'PICK').length,
  MOVE: tasks.filter((entry) => entry.kind === 'MOVE').length,
  COUNT: tasks.filter((entry) => entry.kind === 'COUNT').length,
  QUARANTINE: tasks.filter((entry) => entry.kind === 'QUARANTINE').length,
})

export const inboxOf = (tasks: readonly WarehouseTask[], extra: Partial<TaskInbox> = {}): TaskInbox => ({ asOf: NOW, tasks, counts: counts(tasks), more: false, ...extra })

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.mywork', { station: { name: null, site: DEMO_SITE }, ...extra })

const inbox = (extra: Partial<InboxViewModel> = {}): InboxViewModel => ({
  frame: frame(),
  online: true,
  step: { kind: 'list' },
  inbox: inboxOf(TASKS),
  screens: { move: true, receive: true, pick: true },
  now: NOW,
  ...extra,
})

/** The warehouse cases, as SCR-089's (the station's queue's own fixtures pass their model helper). */
export function warehouseCases(model: (extra?: Partial<MyWorkViewModel>) => MyWorkViewModel): DesignCase<MyWorkViewModel>[] {
  const at = (id: string, label: string, warehouse: InboxViewModel, note?: string): DesignCase<MyWorkViewModel> => ({ id: `w2b-308-${id}`, label: `W2b: ${label}`, model: model({ mode: 'warehouse', warehouse }), ...(note ? { note } : {}) })
  return [
    at('inbox', 'the warehouse inbox: Next big, then the rest', inbox(), 'A warehouse tablet (no station): the person\'s tasks, in hand first, then due, then the oldest (the API\'s order). Next shows where the goods are, where they go and how it is done (confirm by scan, MES-188); the main action opens the screen that does it. Never a name: for you, your role or anyone here.'),
    at('inbox-quarantine-next', 'a hold\'s quarantine move first', inbox({ inbox: inboxOf([TASKS[1]!, TASKS[0]!, ...TASKS.slice(2)]) }), 'Done waits, and says why: only the scan of the quarantine place confirms the move (the office\'s confirm itself). "Move to quarantine" opens Move & put away on its card.'),
    at('inbox-changed', 'List changed · Show', inbox({ changed: 2 }), 'A fresher list waits behind the button: rows never move under a gloved finger.'),
    at('inbox-more', 'more tasks than shown', inbox({ inbox: inboxOf(TASKS, { more: true }) })),
    at('card-put-away', 'a put-away\'s card, in your hands', inbox({ step: { kind: 'task', taskId: 't-put' } }), 'Give it back, Done (the API answers "still there" while goods lie on the dock), Move it.'),
    at('card-move-open', 'a move between bins, open to anyone', inbox({ step: { kind: 'task', taskId: 't-move' } }), 'Take it puts it in your hands; a hide moves whole.'),
    at('card-receive', 'a delivery to receive', inbox({ step: { kind: 'task', taskId: 't-rcv' } }), 'The receipt on Receive closes it; Done is one tap for a delivery taken in another way.'),
    at('card-pick', 'a pick list for a work order', inbox({ step: { kind: 'task', taskId: 't-pick' } })),
    at('card-count', 'a count that is due (late)', inbox({ step: { kind: 'task', taskId: 't-count' } }), 'A count is done by one tap: the floor count screen is B-W2b-310\'s.'),
    at('card-quarantine', 'a hold\'s quarantine move', inbox({ step: { kind: 'task', taskId: 't-qua' } })),
    at('card-gone', 'a task no longer in the list', inbox({ step: { kind: 'task', taskId: 't-gone' } })),
    at('step-taken', 'taken: recorded by the office', inbox({ inbox: inboxOf([{ ...TASKS[4]!, mine: true, status: 'TAKEN' }, TASKS[0]!, ...TASKS.slice(1, 4)]), line: { taskId: 't-move', kind: 'MOVE', code: HIDE, step: 'take', ticks: 'recorded' } })),
    at('step-done-saved', 'done offline: saved on this tablet', inbox({ frame: frame({ online: false, pending: 1 }), online: false, asOf: AS_OF, inbox: inboxOf(TASKS.filter((entry) => entry.id !== 't-rcv')), line: { taskId: 't-rcv', kind: 'RECEIVE', code: null, step: 'done', ticks: 'saved' } }), 'One tick: the tap waits on this tablet and goes when the network is back; the row left the list at once.'),
    at('step-refused-still-there', 'Done refused: the goods still lie on the dock', inbox({ step: { kind: 'task', taskId: 't-put' }, line: { taskId: 't-put', kind: 'PUT_AWAY', code: 'LOT-DEMO-0031', step: 'done', ticks: 'refused', refusal: 'STILL_THERE' } })),
    at('step-refused-taken', 'Take refused: someone else took it', inbox({ step: { kind: 'task', taskId: 't-move' }, line: { taskId: 't-move', kind: 'MOVE', code: HIDE, step: 'take', ticks: 'refused', refusal: 'TAKEN_BY_OTHER' } })),
    at('offline', 'offline: the list from this tablet', inbox({ frame: frame({ online: false }), online: false, asOf: AS_OF })),
    at('offline-none', 'offline, never read on this tablet', inbox({ frame: frame({ online: false }), online: false, inbox: null, problem: 'offline' })),
    at('error', 'the office did not answer', inbox({ inbox: null, problem: 'error' })),
    at('loading', 'reading the tasks', inbox({ inbox: null })),
    at('empty', 'nothing waits', inbox({ inbox: inboxOf([]) })),
    at('notice-held', 'scans held by the worker notice', inbox({ held: true })),
    at('no-permission', 'no permission', inbox({ step: { kind: 'noPermission' } }), 'A person without floor.work: fail closed.'),
    at('no-screen', 'a task whose screen is not open to the person', inbox({ screens: { move: false, receive: true, pick: true }, step: { kind: 'task', taskId: 't-move' } }), 'The main action waits and says why (a held button says why).'),
  ]
}
