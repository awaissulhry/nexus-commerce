import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import { BULK, DOCK, HIDE, NOW, PICK, QUA, STORE, task, TASKS } from '../mywork/warehouse/fixtures'
import type { WarehouseTask } from '../mywork/warehouse/model'
import type { InHand, MoveLast, MoveScan } from './model'
import { MoveView, type MoveViewModel } from './view/MoveView'

/**
 * SCR-177's cases (B-W2b-308; design floor.move: Scan what you move, In your hands, Scan the place; SCM-202, SCM-218, QHS-078):
 * a warehouse tablet (no station) of a made-up "Demo" plant. What waits to be moved, a lot on the dock with its suggested bin, part
 * of a lot on the pad, a hide that moves whole, a lot in several places, a hold's quarantine move, the strip after a move with its
 * two ticks and Undo, a quarantine move done, refusals in words (not released, a blocked place, a count's frozen line, another
 * site's label, not a quarantine place, too late to undo), offline (as of, never read here, kept on the tablet), loading, error,
 * notice, no permission. Made-up lots, hides and places; no money, no person.
 */

const AS_OF = '2026-11-12T09:12:00.000Z'
const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.move', { station: { name: null, site: DEMO_SITE }, ...extra })

const MOVES = TASKS.filter((entry) => entry.kind === 'PUT_AWAY' || entry.kind === 'MOVE' || entry.kind === 'QUARANTINE')

const lining: InHand = {
  kind: 'LOT',
  code: 'LOT-DEMO-0031',
  item: { id: 'item-lin', code: 'FOD-MESH', name: 'Fodera rete traspirante (demo)', kind: 'LINING', tracking: 'LOT', baseUom: 'M' },
  colour: { code: 'NERO', name: 'Nero' },
  lot: { id: 'lot-31', code: 'LOT-DEMO-0031', qualityStatus: 'RELEASED', lifecycle: 'ACTIVE' },
  hide: null,
  roll: null,
  remnant: null,
  quality: 'RELEASED',
  holdIds: [],
  whole: false,
  uom: 'M',
  onHand: '30.0000',
  lying: [{ locationId: DOCK.id, code: DOCK.code, name: DOCK.name, kind: DOCK.kind, onHand: '30.0000' }],
}

const putAwayTask = TASKS[0]!
const onDock: MoveScan = { hand: lining, from: { locationId: DOCK.id, code: DOCK.code }, suggestion: { location: BULK, why: 'DEFAULT' }, tasks: [putAwayTask] }

const hideInHand: InHand = {
  ...lining,
  kind: 'HIDE',
  code: HIDE,
  item: { id: 'item-lea', code: 'PEL-BOV-12', name: 'Pelle bovina pieno fiore 1,2 mm (demo)', kind: 'LEATHER', tracking: 'HIDE', baseUom: 'FT2' },
  lot: { id: 'lot-7', code: 'LOT-DEMO-0007', qualityStatus: 'RELEASED', lifecycle: 'ACTIVE' },
  hide: { id: 'h-1', code: HIDE, state: 'FULL' },
  whole: true,
  uom: 'FT2',
  onHand: '52.4000',
  lying: [{ locationId: STORE.id, code: STORE.code, name: STORE.name, kind: STORE.kind, onHand: '52.4000' }],
}
const moveTask = TASKS.find((entry) => entry.id === 't-move')!
const aHide: MoveScan = { hand: hideInHand, from: { locationId: STORE.id, code: STORE.code }, suggestion: null, tasks: [moveTask] }

const spread: MoveScan = {
  hand: { ...lining, onHand: '75.5000', lying: [{ locationId: BULK.id, code: BULK.code, name: BULK.name, kind: BULK.kind, onHand: '45.5000' }, { locationId: PICK.id, code: PICK.code, name: PICK.name, kind: PICK.kind, onHand: '30.0000' }] },
  from: { locationId: BULK.id, code: BULK.code },
  suggestion: null,
  tasks: [],
}

const quarantineTask = TASKS.find((entry) => entry.id === 't-qua')!
const held: MoveScan = {
  hand: { ...hideInHand, kind: 'LOT', code: 'LOT-DEMO-0009', hide: null, whole: true, lot: { id: 'lot-9', code: 'LOT-DEMO-0009', qualityStatus: 'RELEASED', lifecycle: 'ACTIVE' }, quality: 'ON_HOLD', holdIds: ['hold-1'], onHand: '204.1000', lying: [{ locationId: STORE.id, code: STORE.code, name: STORE.name, kind: STORE.kind, onHand: '204.1000' }] },
  from: { locationId: STORE.id, code: STORE.code },
  suggestion: null,
  tasks: [quarantineTask],
}

const notReleased: MoveScan = {
  hand: { ...lining, code: 'LOT-DEMO-0040', lot: { id: 'lot-40', code: 'LOT-DEMO-0040', qualityStatus: 'QUARANTINE', lifecycle: 'ACTIVE' }, quality: 'QUARANTINE' },
  from: { locationId: DOCK.id, code: DOCK.code },
  suggestion: { location: QUA, why: 'QUALITY' },
  tasks: [task('t-put-q', { lot: { id: 'lot-40', code: 'LOT-DEMO-0040' }, to: QUA })],
}

const last = (extra: Partial<MoveLast>): MoveLast => ({ kind: 'moved', code: 'LOT-DEMO-0031', purpose: 'PUT_AWAY', quantity: '30.0000', uom: 'M', from: DOCK.code, to: BULK.code, ticks: 'recorded', clientEventId: null, moveId: 'mv-1', at: NOW, ...extra })

const base = (extra: Partial<MoveViewModel> = {}): MoveViewModel => ({ frame: frame(), online: true, step: { kind: 'what' }, tasks: MOVES, now: NOW, ...extra })
const inHand = (scan: MoveScan | null, extra: Partial<MoveViewModel> = {}): MoveViewModel => base({ step: { kind: 'hand' }, scan, code: scan?.hand.code ?? 'LOT-DEMO-0050', value: scan && !scan.hand.whole ? Number(scan.hand.lying[0]?.onHand ?? 0) : null, ...extra })
const refused = (code: string, scan: MoveScan | null, extra: Partial<MoveViewModel['problem'] & object> = {}, model: Partial<MoveViewModel> = {}): MoveViewModel =>
  inHand(scan, { problem: { problem: { kind: 'refused', code, message: 'The API said no (made up).', fix: null }, code: scan?.hand.code ?? null, ...extra }, ...model })

const quarantineNoCode: WarehouseTask = { ...quarantineTask, id: 't-qua-2', lot: null, hide: null, item: null, colour: null, from: null, quantity: null, uom: null }

export const designScreen = defineDesignScreen<MoveViewModel>({
  screen: 'SCR-177',
  title: 'Floor Move & put away',
  view: onFloor(MoveView),
  cases: [
    { id: 'scan-what', label: 'Scan what you move, what waits', model: base(), note: 'The person\'s put-aways, moves and a hold\'s quarantine move, next first; a row opens its card. Scanning any lot, hide, roll or remnant label starts a move.' },
    { id: 'scan-what-empty', label: 'Nothing waits to be moved', model: base({ tasks: [] }) },
    { id: 'scan-what-changed', label: 'List changed · Show', model: base({ tasksChanged: 1 }) },
    { id: 'reading', label: 'Reading the label', model: base({ step: { kind: 'reading', code: 'LOT-DEMO-0031' } }) },
    { id: 'put-away', label: 'In your hands: a lot on the dock, its suggested bin', model: inHand(onDock), note: 'Two scans and no taps: the pad starts at all of it; the bin scanned confirms where it goes (the suggestion is only a hint: the default place for linings).' },
    { id: 'put-away-part', label: 'Part of a lot: 2 digits on the pad', model: inHand(onDock, { value: 12 }), note: 'Move part of a lot: scan → 2 digits → scan the bin (3 taps). Only a lot counted by quantity opens the pad.' },
    { id: 'hide-whole', label: 'A hide moves whole', model: inHand(aHide), note: 'No pad: a hide (and its remnant, a roll, a lot tracked hide by hide) moves whole. The move task asks for the pick face.' },
    { id: 'several-places', label: 'It lies in two places: where from?', model: inHand(spread), note: 'Neither a task nor a single dock says where it is taken from: tap the place; the scan of the bin waits and says why.' },
    { id: 'several-places-picked', label: 'Taken from the bulk rack', model: inHand(spread, { picked: BULK.id, value: 45.5 }) },
    { id: 'quarantine-task', label: 'A hold asks the quarantine move', model: inHand(held), note: 'QHS-078: the hold\'s task shows here; scanning the quarantine place confirms the move (every held balance moves in, the office\'s confirm itself).' },
    { id: 'not-released', label: 'Not released: only into quarantine', model: inHand(notReleased), note: 'A lot waiting for quality goes only into a quarantine place: the screen says so before the scan.' },
    { id: 'task-card', label: 'A waiting task\'s card', model: base({ step: { kind: 'task', task: putAwayTask } }), note: 'Confirm by scan, not by reading (MES-188): the goods\' label starts it.' },
    { id: 'task-card-quarantine', label: 'A quarantine move of several lots', model: base({ step: { kind: 'task', task: quarantineNoCode } }), note: 'A hold of several lots names no single label: the quarantine place\'s scan is the only one.' },
    { id: 'moved', label: 'Put away: recorded, Undo for 2 minutes', model: base({ last: last({}), undo: 'open' }) },
    { id: 'moved-part', label: 'Part of a lot moved between bins', model: base({ last: last({ purpose: 'MOVE', quantity: '12.0000', from: BULK.code, to: PICK.code }), undo: 'open' }) },
    { id: 'moved-saved', label: 'Offline: kept on this tablet', model: base({ frame: frame({ online: false, pending: 1 }), online: false, tasksAsOf: AS_OF, last: last({ ticks: 'saved', clientEventId: 'c-1', moveId: null, at: null }) }), note: 'One tick: the move waits on this tablet and goes when the network is back; Undo waits for the network and the office\'s record.' },
    { id: 'moved-sending', label: 'Being sent', model: base({ last: last({ ticks: 'sending', clientEventId: 'c-1', moveId: null, at: null }) }) },
    { id: 'moved-refused-queue', label: 'The office refused a kept move', model: base({ last: last({ ticks: 'refused', clientEventId: 'c-1', moveId: null, at: null, refusal: 'CONFLICT' }) }), note: 'Waiting to send holds the reason and the fix.' },
    { id: 'quarantined', label: 'Moved to quarantine: what moved, what stays', model: base({ last: last({ kind: 'quarantined', code: 'LOT-DEMO-0009', purpose: null, quantity: null, uom: null, from: null, to: QUA.code, moveId: null, moved: [{ fromCode: STORE.code, onHand: '150.0000', uom: 'FT2' }, { fromCode: PICK.code, onHand: '54.1000', uom: 'FT2' }], stays: [{ atCode: 'TERZ-DEMO', onHand: '20.0000', uom: 'FT2' }] }) }) },
    { id: 'quarantined-hold', label: 'A hold of several lots moved to quarantine', model: base({ last: last({ kind: 'quarantined', code: '', purpose: null, quantity: null, uom: null, from: null, to: QUA.code, moveId: null, moved: [{ fromCode: STORE.code, onHand: '204.1000', uom: 'FT2' }], stays: [] }) }) },
    { id: 'undone', label: 'Undone', model: base({ last: last({ kind: 'undone' }) }) },
    { id: 'refused-quarantine-only', label: 'Refused: not released, an open shelf scanned', model: refused('QUARANTINE_ONLY', notReleased, { place: BULK.code }) },
    { id: 'refused-blocked', label: 'Refused: the place is blocked', model: refused('LOCATION_BLOCKED', onDock, { place: 'A1-DMG-01' }) },
    { id: 'refused-frozen', label: 'Refused: a count\'s frozen line', model: refused('COUNT_FROZEN', aHide, { place: PICK.code }) },
    { id: 'refused-other-site', label: 'Refused: a place of another site', model: refused('NOT_A_PLACE', onDock, { place: 'B2-BULK-04' }), note: 'Design scan-where "error: A place of another site: refusal."' },
    { id: 'refused-same-place', label: 'Refused: it is there already', model: refused('SAME_PLACE', aHide, { place: STORE.code }) },
    { id: 'refused-not-quarantine', label: 'Refused: not the quarantine place', model: refused('NOT_A_QUARANTINE_PLACE', held, { place: BULK.code, asked: QUA.code }) },
    { id: 'refused-does-not-hold', label: 'Refused: the place does not take these goods', model: refused('DOES_NOT_HOLD', onDock, { place: 'A1-FG-01' }) },
    { id: 'refused-not-stock', label: 'Nothing here carries the label', model: base({ problem: { problem: { kind: 'refused', code: 'NOT_STOCK', message: '', fix: null }, code: 'XYZ-123' } }) },
    { id: 'refused-too-late', label: 'Undo refused: after 2 minutes', model: base({ last: last({}), problem: { problem: { kind: 'refused', code: 'TOO_LATE', message: '', fix: null }, code: 'LOT-DEMO-0031' } }) },
    { id: 'offline-hand', label: 'Offline: in your hands from this tablet', model: inHand(onDock, { frame: frame({ online: false }), online: false, handAsOf: AS_OF, tasksAsOf: AS_OF }), note: 'Read earlier in this visit: the move is kept on this tablet with the same body.' },
    { id: 'offline-blind', label: 'Offline: a label never read on this tablet', model: inHand(null, { frame: frame({ online: false }), online: false, code: 'LOT-DEMO-0050' }), note: 'The code alone: the place\'s scan keeps the move here; the office checks it when it arrives (a refusal waits on Waiting to send).' },
    { id: 'offline-tasks', label: 'Offline: what waits, from this tablet', model: base({ frame: frame({ online: false }), online: false, tasksAsOf: AS_OF }) },
    { id: 'offline-tasks-none', label: 'Offline: the tasks never read', model: base({ frame: frame({ online: false }), online: false, tasks: null, tasksProblem: 'offline' }) },
    { id: 'error', label: 'The office not answering', model: base({ problem: { problem: { kind: 'unavailable' }, code: 'LOT-DEMO-0031' } }) },
    { id: 'tasks-error', label: 'The tasks could not be read', model: base({ tasks: null, tasksProblem: 'error' }) },
    { id: 'loading', label: 'Reading the tasks', model: base({ tasks: null }) },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: base({ held: true }) },
    { id: 'no-permission', label: 'No permission', model: base({ step: { kind: 'noPermission' } }), note: 'A person without inventory.transfer (the tile is not shown to them either): fail closed.' },
  ],
})
