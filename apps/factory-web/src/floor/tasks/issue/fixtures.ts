import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import { padBounds, type PickLine, type PickList, type PickWorkOrderRow } from './model'
import { returnRows } from './returns'
import { PickView, type PickViewModel } from './view/PickView'
import type { PickReturnModel, ReturnTag } from './view/ReturnStep'

/**
 * SCR-093's cases (design floor.pick): for which work order, what it needs, the scan that issues (a hide whole, a lot on
 * the pad), undo, refusals in words, offline (held, the tablet's copy with its time), no permission. A warehouse device
 * (no station). Made-up work orders, materials, lots and hides of a made-up tenant; no money anywhere.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const hide = (ref: number) => formatScanId({ type: 'HIDE', tenantTag: TAG, ref })
const LOT = 'LOT-DEMO-0031'
const AS_OF = '2026-10-29T07:52:00.000Z'

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.pick', { station: { name: null, site: DEMO_SITE }, ...extra })

const workOrders: PickWorkOrderRow[] = [
  { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', status: 'RELEASED', dueDate: '2026-11-06', style: { code: 'GIA-01', name: 'Giacca moto Demo' }, pieces: 120, colourways: ['NERO', 'MARRONE'] },
  { id: 'wo-2', number: 'WO-DEMO-0043', batchNumber: null, status: 'IN_PROGRESS', dueDate: '2026-11-10', style: { code: 'PAN-02', name: 'Pantalone Demo Touring' }, pieces: 40, colourways: ['NERO'] },
  { id: 'wo-3', number: 'WO-DEMO-0047', batchNumber: 'B-26-047', status: 'RELEASED', dueDate: null, style: { code: 'GIL-03', name: 'Gilet Demo' }, pieces: 1, colourways: ['ROSSO'] },
]

const leather: PickLine = {
  key: 'item-leather:col-black',
  itemId: 'item-leather',
  itemColourId: 'col-black',
  itemCode: 'PEL-BOV-12',
  itemName: 'Pelle bovina pieno fiore 1,2 mm (demo)',
  colourCode: 'NERO',
  colourName: 'Nero',
  tracking: 'HIDE',
  baseUom: 'FT2',
  planned: '410.0000',
  issued: '156.2000',
  toIssue: '253.8000',
  covered: false,
  usable: {
    onHand: '312.6000',
    candidates: [
      { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-1', hideCode: hide(4211), hideState: 'FULL', grade: 'A', locationCode: 'A1-STORE-01', onHand: '52.4000' },
      { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-2', hideCode: hide(4212), hideState: 'FULL', grade: 'A', locationCode: 'A1-STORE-01', onHand: '49.8000' },
    ],
    more: 4,
  },
  held: [{ reason: 'CR_VI_PENDING', lotCode: 'LOT-DEMO-0009', onHand: '204.1000', hides: 4 }],
  atWorkOrder: [{ lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-0', hideCode: hide(4208), quantity: '51.1000', cut: '0.0000', returnable: '51.1000' }],
}
const lining: PickLine = {
  key: 'item-lining:col-black',
  itemId: 'item-lining',
  itemColourId: 'col-black',
  itemCode: 'FOD-MESH',
  itemName: 'Fodera rete traspirante (demo)',
  colourCode: 'NERO',
  colourName: 'Nero',
  tracking: 'LOT',
  baseUom: 'M',
  planned: '96.0000',
  issued: '0.0000',
  toIssue: '96.0000',
  covered: false,
  usable: { onHand: '140.0000', candidates: [{ lotId: 'lot-31', lotCode: LOT, hideId: null, hideCode: null, hideState: null, grade: null, locationCode: 'A2-ROLL-03', onHand: '140.0000' }], more: 0 },
  held: [],
  atWorkOrder: [],
}
const thread: PickLine = {
  key: 'item-thread:-',
  itemId: 'item-thread',
  itemColourId: null,
  itemCode: 'FIL-40',
  itemName: 'Filo poliestere 40 (demo)',
  colourCode: null,
  colourName: null,
  tracking: 'NONE',
  baseUom: 'CONE',
  planned: '12.0000',
  issued: '12.0000',
  toIssue: '0.0000',
  covered: true,
  usable: { onHand: '30.0000', candidates: [], more: 0 },
  held: [],
  atWorkOrder: [],
}
const protector: PickLine = {
  key: 'item-armour:-',
  itemId: 'item-armour',
  itemColourId: null,
  itemCode: 'PRT-SPALLA-L1',
  itemName: 'Protezione spalla EN 1621-1 L1 (demo)',
  colourCode: null,
  colourName: null,
  tracking: 'LOT',
  baseUom: 'PAIR',
  planned: '120.0000',
  issued: '0.0000',
  toIssue: '120.0000',
  covered: false,
  usable: { onHand: '0.0000', candidates: [], more: 0 },
  held: [{ reason: 'QUALITY_HOLD', lotCode: 'LOT-DEMO-0040', onHand: '150.0000', hides: 0 }],
  atWorkOrder: [],
}

const list: PickList = {
  workOrder: { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', status: 'IN_PROGRESS', dueDate: '2026-11-06', issuable: true, style: { code: 'GIA-01', name: 'Giacca moto Demo' } },
  lines: [leather, lining, protector, thread],
  undo: null,
}
const afterHide: PickList = {
  ...list,
  lines: [{ ...leather, issued: '208.6000', toIssue: '201.4000', usable: { ...leather.usable, onHand: '260.2000', candidates: leather.usable.candidates.slice(1) } }, lining, protector, thread],
  undo: { issueId: 'iss-1', itemId: 'item-leather', itemColourId: 'col-black', lotId: 'lot-7', hideId: 'h-1', baseQuantity: '52.4000', occurredAt: '2026-10-29T08:12:00.000Z' },
}
const withHeldHide: PickList = { ...afterHide, lines: [{ ...afterHide.lines[0]!, atWorkOrder: [...leather.atWorkOrder, { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-1', hideCode: hide(4211), quantity: '52.4000', cut: '0.0000', returnable: '52.4000' }] }, lining, protector, thread] }

const base = (extra: Partial<PickViewModel> = {}): PickViewModel => ({ frame: frame(), online: true, stage: 'list', list, ...extra })
const pad = (line: PickLine, code: string, onHand: number, value?: number) => {
  const bounds = padBounds(line, onHand)
  return { code, lineKey: line.key, value: value ?? bounds.suggested, bounds, uom: line.baseUom }
}
const shortLining: PickLine = { ...lining, usable: { onHand: '8.0000', candidates: [{ ...lining.usable.candidates[0]!, onHand: '8.0000' }], more: 0 } }

// ---- B-W2a-75: Return unused (design floor.pick sec "return"; SCM-216) ----
const cutHide = { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-0', hideCode: hide(4208), quantity: '51.1000', cut: '32.5000', returnable: '18.6000' }
const wholeHide = { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-1', hideCode: hide(4211), quantity: '52.4000', cut: '0.0000', returnable: '52.4000' }
const liningLot = { lotId: 'lot-31', lotCode: LOT, hideId: null, hideCode: null, quantity: '96.0000', cut: '0.0000', returnable: '12.0000' }
const withReturns: PickList = { ...list, lines: [{ ...leather, atWorkOrder: [cutHide, wholeHide] }, { ...lining, issued: '96.0000', toIssue: '0.0000', covered: true, atWorkOrder: [liningLot] }, protector, thread] }
const RETURN_ROWS = returnRows(withReturns)
const PLACES = [
  { id: 'loc-1', code: 'A1-STORE-01', name: 'Scaffale pelli 1 (demo)' },
  { id: 'loc-2', code: 'A1-STORE-02', name: 'Scaffale pelli 2 (demo)' },
  { id: 'loc-3', code: 'A2-ROLL-03', name: 'Rotoli fodere (demo)' },
]
const ret = (extra: Partial<PickReturnModel> = {}): PickReturnModel => ({ workOrder: list.workOrder.number, rows: RETURN_ROWS, picked: null, places: PLACES, placeId: null, ...extra })
const returning = (extra: Partial<PickReturnModel> = {}, model: Partial<PickViewModel> = {}): PickViewModel => base({ list: withReturns, stage: 'return', ret: ret(extra), ...model })
const remnantDone = (tag: ReturnTag | null) => ({ row: RETURN_ROWS[0]!, quantity: 18.6, place: 'A1-STORE-01', as: 'remnant' as const, tag })

export const designScreen = defineDesignScreen<PickViewModel>({
  screen: 'SCR-093',
  title: 'Pick & issue',
  view: onFloor(PickView),
  cases: [
    { id: 'choose', label: 'For which work order', model: { frame: frame(), online: true, stage: 'choose', workOrders }, note: 'Scan the traveller (here or on Home), or tap a released work order of this site. The count and the keys sit in the list\'s footer.' },
    { id: 'choose-empty', label: 'Nothing to pick for', model: { frame: frame(), online: true, stage: 'choose', workOrders: [] } },
    { id: 'choose-loading', label: 'Reading the work orders', model: { frame: frame(), online: true, stage: 'choose', workOrders: null } },
    { id: 'pick-list', label: 'What it needs', model: base(), note: 'Per material and colour: the need big, what is issued, a tick when covered; the oldest usable hide or lot and where it lies; held stock with why. A material without lots (thread) opens its pad with a tap.' },
    {
      id: 'issued-hide',
      label: 'A hide issued by its scan',
      model: base({ list: withHeldHide, last: { kind: 'issued', code: hide(4211), quantity: 52.4, uom: 'FT2', workOrder: 'WO-DEMO-0042' } }),
      note: 'Zero taps: the scan is the action. Recorded by the office at once (two ticks); Undo is one tap until the next stock action.',
    },
    { id: 'pad-lot', label: 'A lot: how much (defaulted)', model: base({ pad: pad(lining, LOT, 140) }), note: 'The pad starts at what the work order still needs; the main action issues it in one tap. Over-issue is the office\'s.' },
    { id: 'pad-on-hand', label: 'Less usable than needed', model: base({ list: { ...list, lines: [leather, shortLining, protector, thread] }, pad: pad(shortLining, LOT, 8) }), note: 'The pad stops at what is on hand: a digit past it buzzes amber with the range in words.' },
    { id: 'pad-covered', label: 'A material already covered', model: base({ pad: pad(thread, 'FIL-40', 30, undefined) }), note: 'Nothing more is issued on the floor: an over-issue needs the office and a reason.' },
    {
      id: 'refused-already-issued',
      label: 'Refused: hide already issued',
      model: base({ problem: { problem: { kind: 'refused', code: 'ALREADY_ISSUED', message: `Hide ${hide(4199)} is already issued to work order WO-DEMO-0041 (2026-10-29 07:12 UTC).`, fix: null }, code: hide(4199) } }),
      note: 'No double use (SCM-194): the API names the work order and the time, never who.',
    },
    { id: 'refused-cr-vi', label: 'Refused: no chromium VI result', model: base({ problem: { problem: { kind: 'refused', code: 'CR_VI_PENDING', message: 'Lot LOT-DEMO-0009: no chromium VI test result yet.', fix: null }, code: hide(4301) } }) },
    { id: 'refused-quality-hold', label: 'Refused: lot on quality hold', model: base({ problem: { problem: { kind: 'refused', code: 'QUALITY_HOLD', message: 'Lot LOT-DEMO-0040: on quality hold.', fix: null }, code: 'LOT-DEMO-0040' } }) },
    { id: 'refused-not-stock', label: 'Not stock of this site', model: base({ problem: { problem: { kind: 'refused', code: 'NOT_STOCK', message: 'This is no hide, lot or material of this site.', fix: 'Scan the stock\'s own label, or ask your team leader.' }, code: 'XYZ-77' } }) },
    {
      id: 'not-open',
      label: 'Work order not open',
      model: base({ list: { ...list, workOrder: { ...list.workOrder, status: 'COMPLETED', issuable: false } } }),
      note: 'The scan is held with the reason; the pick list stays readable.',
    },
    { id: 'undone', label: 'After Undo', model: base({ last: { kind: 'undone', code: hide(4211), quantity: 52.4, uom: 'FT2' } }), note: 'The hide is back in stock; the line shows it again.' },
    {
      id: 'offline-list',
      label: 'Offline: the tablet\'s copy',
      model: base({ frame: frame({ online: false }), online: false, list: afterHide, asOf: AS_OF }),
      note: 'Issuing is not one of the queue\'s actions: the scan is held and says so; the pick list shows with its time.',
    },
    { id: 'offline-nothing', label: 'Offline, nothing on this tablet', model: { frame: frame({ online: false }), online: false, stage: 'choose', workOrders: [], notOnTablet: true } },
    { id: 'offline-choose', label: 'Offline: work orders from the tablet', model: { frame: frame({ online: false }), online: false, stage: 'choose', workOrders, asOf: AS_OF } },
    { id: 'error', label: 'Server not answering', model: { frame: frame(), online: true, stage: 'choose', workOrders: [], problem: { problem: { kind: 'unavailable' }, code: null } } },
    { id: 'no-permission', label: 'No permission', model: { frame: frame(), online: true, stage: 'noPermission' }, note: 'A person without inventory.issue (the tile is not shown to them either): fail closed.' },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: { frame: frame(), online: true, stage: 'choose', workOrders, held: true } },
    // ---- B-W2a-75: Return unused (W2a; design floor.pick "Secondary: Return unused", sec "return") ----
    { id: 'pick-list-returns', label: 'Return unused, beside Done', model: base({ list: withReturns }), note: 'W2a: the secondary action opens Return unused (held with the reason when nothing can come back or offline).' },
    {
      id: 'return-list',
      label: 'Return unused: what can come back',
      model: returning(),
      note: 'What the work order holds less what was cut: a cut hide (its remnant), a whole hide, a lot\'s rest. Scan its tag or tap a row.',
    },
    {
      id: 'return-remnant',
      label: 'A cut hide: the remnant\'s area, where it goes',
      model: returning({ picked: { rowKey: RETURN_ROWS[0]!.key, value: 18.6 }, placeId: 'loc-1' }),
      note: 'The pad starts at all that can come back (area as issued less cut); measure and type the remnant. The store place, then Return.',
    },
    { id: 'return-whole', label: 'A hide nothing was cut from', model: returning({ picked: { rowKey: RETURN_ROWS[1]!.key, value: 52.4 }, placeId: 'loc-2' }), note: '"The whole hide" in one tap: it comes back whole, no new tag.' },
    { id: 'return-lot', label: 'A lot\'s rest', model: returning({ picked: { rowKey: RETURN_ROWS[2]!.key, value: 12 }, placeId: null }), note: 'Held until a place is picked.' },
    { id: 'return-places-loading', label: 'Reading the store places', model: returning({ picked: { rowKey: RETURN_ROWS[0]!.key, value: 18.6 }, places: null }) },
    { id: 'return-places-held', label: 'The store places not readable', model: returning({ picked: { rowKey: RETURN_ROWS[0]!.key, value: 18.6 }, places: null, placesHeld: 'noPermission' }) },
    {
      id: 'return-refused',
      label: 'Refused: more than it holds',
      model: returning({ picked: { rowKey: RETURN_ROWS[0]!.key, value: 18.6 }, placeId: 'loc-1', problem: { problem: { kind: 'refused', code: 'MORE_THAN_AT_WORK_ORDER', message: 'More than the work order holds.', fix: null }, code: hide(4208) } }),
      note: 'Another tablet returned part of it meanwhile: the API refuses in words; the pad stays as typed.',
    },
    { id: 'return-unknown', label: 'A code it does not hold', model: returning({ problem: { problem: { kind: 'refused', code: 'NOT_AT_WORK_ORDER', message: 'Not held.', fix: null }, code: hide(4999) } }) },
    { id: 'return-empty', label: 'Nothing can come back', model: returning({ rows: [] }) },
    { id: 'return-offline', label: 'Offline: returning waits', model: returning({}, { frame: frame({ online: false }), online: false, asOf: AS_OF }), note: 'Returning is not one of the queue\'s actions: held with the reason.' },
    {
      id: 'return-done-print',
      label: 'Back as a remnant: print its new tag',
      model: returning({ done: remnantDone({ kind: 'printer', printer: { kind: 'site', id: 'p-1', name: 'Etichette magazzino (demo)' }, picked: 'p-1' }) }),
      note: '"Label reprint": the HIDE tag with the new area, on the station\'s printer (else the site\'s only one).',
    },
    { id: 'return-done-printing', label: 'The new tag on its way', model: returning({ done: remnantDone({ kind: 'job', printer: 'Etichette magazzino (demo)', status: 'SENT', detail: null }) }) },
    { id: 'return-done-failed', label: 'The new tag did not print', model: returning({ done: remnantDone({ kind: 'job', printer: 'Etichette magazzino (demo)', status: 'FAILED', detail: 'Rotolo finito (demo)' }) }) },
    {
      id: 'return-done-choose',
      label: 'Two printers: pick one',
      model: returning({ done: remnantDone({ kind: 'printer', printer: { kind: 'choose', printers: [{ id: 'p-1', name: 'Etichette magazzino (demo)' }, { id: 'p-2', name: 'Etichette taglio (demo)' }] }, picked: null }) }),
    },
    { id: 'return-done-no-printer', label: 'No label printer', model: returning({ done: remnantDone({ kind: 'printer', printer: { kind: 'none' }, picked: null }) }), note: 'Said plainly: write the new area on the tag.' },
    { id: 'return-done-old-tag', label: 'An older tag code', model: returning({ done: remnantDone({ kind: 'notOurs' }) }) },
    { id: 'return-done-lot', label: 'A lot back to stock', model: returning({ done: { row: RETURN_ROWS[2]!, quantity: 12, place: 'A2-ROLL-03', as: 'part', tag: null } }), note: 'A lot keeps its label.' },
  ],
})
