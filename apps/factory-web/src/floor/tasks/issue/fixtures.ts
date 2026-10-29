import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import { padBounds, type PickLine, type PickList, type PickWorkOrderRow } from './model'
import { PickView, type PickViewModel } from './view/PickView'

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
  atWorkOrder: [{ lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-0', hideCode: hide(4208), quantity: '51.1000' }],
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
const withHeldHide: PickList = { ...afterHide, lines: [{ ...afterHide.lines[0]!, atWorkOrder: [...leather.atWorkOrder, { lotId: 'lot-7', lotCode: 'LOT-DEMO-0007', hideId: 'h-1', hideCode: hide(4211), quantity: '52.4000' }] }, lining, protector, thread] }

const base = (extra: Partial<PickViewModel> = {}): PickViewModel => ({ frame: frame(), online: true, stage: 'list', list, ...extra })
const pad = (line: PickLine, code: string, onHand: number, value?: number) => {
  const bounds = padBounds(line, onHand)
  return { code, lineKey: line.key, value: value ?? bounds.suggested, bounds, uom: line.baseUom }
}
const shortLining: PickLine = { ...lining, usable: { onHand: '8.0000', candidates: [{ ...lining.usable.candidates[0]!, onHand: '8.0000' }], more: 0 } }

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
  ],
})
