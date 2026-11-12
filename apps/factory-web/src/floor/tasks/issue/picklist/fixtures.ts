import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../../frame/fixtures'
import type { PickLine, PickList } from '../model'
import { PickView, type PickViewModel } from '../view/PickView'
import { stopBounds, stopKey, type PickedLast, type Walk, type WalkPlace, type WalkStop } from './model'

/**
 * SCR-384 — the pick list by bin on Pick & issue (B-W2b-310; design floor.pick sec:need "W2b pick list (SCM-212): sorted by bin path,
 * reservations, scan each pick"; new review id for SCR-093's W2b part): a warehouse tablet of a made-up "Demo" plant picking a made-up
 * work order. The walk in bin order (a reserved hide first, the proposed lot, an approved substitute, a stop on hold, a blocked
 * place), the next stop, a hide taken by its scan (two ticks), a lot on the pad at its stop, a substitute taken, offline (the walk
 * from this tablet, a pick kept on it), a refusal of a held stop, everything taken, no walk. Made-up lots, hides and places; no money,
 * no person.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const hide = (ref: number) => formatScanId({ type: 'HIDE', tenantTag: TAG, ref })
export const AS_OF = '2026-11-12T09:12:00.000Z'

export const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.pick', { station: { name: null, site: DEMO_SITE }, ...extra })

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
  usable: { onHand: '312.6000', candidates: [], more: 0 },
  held: [],
  atWorkOrder: [],
}
const lining: PickLine = { ...leather, key: 'item-lining:col-black', itemId: 'item-lining', itemCode: 'FOD-MESH', itemName: 'Fodera rete traspirante (demo)', tracking: 'LOT', baseUom: 'M', planned: '96.0000', issued: '0.0000', toIssue: '96.0000', usable: { onHand: '140.0000', candidates: [], more: 0 } }
const protector: PickLine = { ...leather, key: 'item-armour:-', itemId: 'item-armour', itemColourId: null, itemCode: 'PRT-SPALLA-L1', itemName: 'Protezione spalla EN 1621-1 L1 (demo)', colourCode: null, colourName: null, tracking: 'LOT', baseUom: 'PAIR', planned: '120.0000', issued: '0.0000', toIssue: '120.0000', usable: { onHand: '0.0000', candidates: [], more: 0 } }
const thread: PickLine = { ...leather, key: 'item-thread:-', itemId: 'item-thread', itemColourId: null, itemCode: 'FIL-40', itemName: 'Filo poliestere 40 (demo)', colourCode: null, colourName: null, tracking: 'NONE', baseUom: 'CONE', planned: '12.0000', issued: '12.0000', toIssue: '0.0000', covered: true, usable: { onHand: '30.0000', candidates: [], more: 0 } }

export const LIST: PickList = {
  workOrder: { id: 'wo-1', number: 'WO-DEMO-0042', batchNumber: 'B-26-042', status: 'IN_PROGRESS', dueDate: '2026-11-06', issuable: true, style: { code: 'GIA-01', name: 'Giacca moto Demo' } },
  lines: [leather, lining, protector, thread],
  undo: null,
}
/** Every line picked in full (the kit may be checked). */
export const PICKED: PickList = { ...LIST, lines: LIST.lines.map((line) => ({ ...line, issued: line.planned, toIssue: '0.0000', covered: true })) }

const place = (code: string, path: string[], rank: number, extra: Partial<WalkPlace> = {}): WalkPlace => ({ id: `loc-${code.toLowerCase()}`, code, name: `${code} (demo)`, kind: 'BIN', labelCode: `BIN-${code}`, path, rank, blocked: false, ...extra })
const STORE1 = place('A1-STORE-01', ['A1-STORE', 'A1-STORE-01'], 1)
const STORE2 = place('A1-STORE-02', ['A1-STORE', 'A1-STORE-02'], 2)
const ROLL3 = place('A2-ROLL-03', ['A2-ROLL', 'A2-ROLL-03'], 5)
const PF1 = place('A2-PF-01', ['A2-PF', 'A2-PF-01'], 6)
const DMG = place('A3-DMG-01', ['A3', 'A3-DMG-01'], 9, { blocked: true })

const stop = (turn: number, extra: Partial<WalkStop>): WalkStop => ({
  turn,
  workOrderId: 'wo-1',
  workOrderNumber: 'WO-DEMO-0042',
  lineKey: 'item-leather|col-black',
  itemId: 'item-leather',
  itemCode: 'PEL-BOV-12',
  itemName: 'Pelle bovina pieno fiore 1,2 mm (demo)',
  colourCode: 'NERO',
  baseUom: 'FT2',
  tracking: 'HIDE',
  location: STORE1,
  lotId: 'lot-7',
  lotCode: 'LOT-DEMO-0007',
  hideId: null,
  hideCode: null,
  quantity: '0.0000',
  source: 'PROPOSED',
  reservationId: null,
  substitutionId: null,
  quality: 'RELEASED',
  issuable: true,
  ...extra,
})
const LINING_STOP = stop(3, { lineKey: 'item-lining|col-black', itemId: 'item-lining', itemCode: 'FOD-MESH', itemName: 'Fodera rete traspirante (demo)', baseUom: 'M', tracking: 'LOT', location: ROLL3, lotId: 'lot-31', lotCode: 'LOT-DEMO-0031', quantity: '96.0000' })
const SUB_STOP = stop(4, { lineKey: 'item-armour|-', itemId: 'item-armour-alt', itemCode: 'PRT-SPALLA-L2', itemName: 'Protezione spalla EN 1621-1 L2 (demo)', colourCode: null, baseUom: 'PAIR', tracking: 'LOT', location: PF1, lotId: 'lot-52', lotCode: 'LOT-DEMO-0052', quantity: '40.0000', source: 'SUBSTITUTE', substitutionId: 'sub-1' })
export const STOPS: WalkStop[] = [
  stop(1, { hideId: 'h-1', hideCode: hide(4211), quantity: '52.4000', source: 'RESERVED', reservationId: 'res-1' }),
  stop(2, { hideId: 'h-2', hideCode: hide(4212), location: STORE2, quantity: '49.8000' }),
  LINING_STOP,
  SUB_STOP,
  stop(5, { lineKey: 'item-armour|-', itemId: 'item-armour', itemCode: 'PRT-SPALLA-L1', itemName: 'Protezione spalla EN 1621-1 L1 (demo)', colourCode: null, baseUom: 'PAIR', tracking: 'LOT', location: PF1, lotId: 'lot-40', lotCode: 'LOT-DEMO-0040', quantity: '80.0000', quality: 'ON_HOLD', issuable: false }),
  stop(6, { hideId: 'h-6', hideCode: hide(4230), location: DMG, quantity: '50.1000', issuable: false }),
]

export const WALK: Walk = {
  asOf: AS_OF,
  workOrder: { id: 'wo-1', number: 'WO-DEMO-0042', status: 'IN_PROGRESS', issuable: true },
  kit: { location: { id: 'loc-a1-cut', code: 'A1-CUT', name: 'Zona kit taglio (demo)' }, checkedAt: null, version: 2 },
  task: { id: 'task-pick-1', status: 'OPEN', version: 1 },
  lines: [
    { key: 'item-leather|col-black', itemId: 'item-leather', itemCode: 'PEL-BOV-12', itemName: 'Pelle bovina pieno fiore 1,2 mm (demo)', itemColourId: 'col-black', colourCode: 'NERO', baseUom: 'FT2', toIssue: '253.8000', reserved: '52.4000', substituted: '0.0000', toPick: '253.8000', covered: false },
    { key: 'item-lining|col-black', itemId: 'item-lining', itemCode: 'FOD-MESH', itemName: 'Fodera rete traspirante (demo)', itemColourId: 'col-black', colourCode: 'NERO', baseUom: 'M', toIssue: '96.0000', reserved: '0.0000', substituted: '0.0000', toPick: '96.0000', covered: false },
    { key: 'item-armour|-', itemId: 'item-armour', itemCode: 'PRT-SPALLA-L1', itemName: 'Protezione spalla EN 1621-1 L1 (demo)', itemColourId: null, colourCode: null, baseUom: 'PAIR', toIssue: '120.0000', reserved: '0.0000', substituted: '40.0000', toPick: '80.0000', covered: false },
  ],
  stops: STOPS,
  places: [STORE1, STORE2, ROLL3, PF1, DMG].map((entry) => ({ ...entry, stops: STOPS.filter((row) => row.location.id === entry.id).length })),
}

const none: ReadonlySet<string> = new Set()
const base = (extra: Partial<PickViewModel> = {}): PickViewModel => ({ frame: frame(), online: true, stage: 'list', list: LIST, walk: { walk: WALK, taken: none }, ...extra })
const picked = (extra: Partial<PickedLast>): PickedLast => ({ kind: 'picked', code: hide(4211), place: 'A1-STORE-01', quantity: '52.4000', uom: 'FT2', substitute: false, ticks: 'recorded', clientEventId: null, ...extra })
const afterFirst: Walk = { ...WALK, stops: STOPS.slice(1).map((entry, index) => ({ ...entry, turn: index + 1 })) }
const liningPad = { code: 'LOT-DEMO-0031', lineKey: 'item-lining:col-black', value: 96, bounds: stopBounds(LINING_STOP), uom: 'M', stop: stopKey(LINING_STOP) }
const subPad = { code: 'LOT-DEMO-0052', lineKey: 'item-armour-alt:-', value: 40, bounds: stopBounds(SUB_STOP), uom: 'PAIR', stop: stopKey(SUB_STOP) }

export const designScreen = defineDesignScreen<PickViewModel>({
  screen: 'SCR-384',
  title: 'Floor Pick list by bin',
  view: onFloor(PickView),
  cases: [
    { id: 'walk', label: 'The pick list by bin', model: base(), note: 'One walk through the store in the order of the site\'s bins: the reserved hide first, then what W2a proposes, an approved substitute, a lot on a quality hold and a blocked place (not taken now, in words). The scan of what is taken at a stop issues it from that place.' },
    { id: 'walk-taken', label: 'A reserved hide taken by its scan', model: base({ walk: { walk: afterFirst, taken: none }, last: picked({}) }), note: 'Zero taps: the hide\'s tag scanned at its stop issues it whole; the walk moves on to the next stop.' },
    { id: 'walk-pad', label: 'A lot on the pad at its stop', model: base({ pad: liningPad }), note: 'Defaulted to what the walk takes at this stop; never more than that here.' },
    { id: 'walk-substitute', label: 'An approved substitute at its stop', model: base({ walk: { walk: afterFirst, taken: none }, pad: subPad }), note: 'The substitute was approved in the office (MES-139); its lot is issued by the substitution\'s own issue.' },
    { id: 'walk-substitute-taken', label: 'The substitute taken', model: base({ last: picked({ code: 'LOT-DEMO-0052', place: 'A2-PF-01', quantity: '40.0000', uom: 'PAIR', substitute: true }) }) },
    { id: 'walk-refused-hold', label: 'Refused: a stop on a quality hold', model: base({ problem: { problem: { kind: 'refused', code: 'STOP_ON_HOLD', message: '', fix: null }, code: 'LOT-DEMO-0040' } }) },
    { id: 'walk-refused-blocked', label: 'Refused: a blocked place', model: base({ problem: { problem: { kind: 'refused', code: 'STOP_BLOCKED', message: '', fix: null }, code: hide(4230) } }) },
    { id: 'walk-offline', label: 'Offline: the walk from this tablet', model: base({ frame: frame({ online: false }), online: false, asOf: AS_OF }), note: 'With the walk on this tablet a stop\'s scan is kept in the queue and sent when the network is back; anything else waits.' },
    { id: 'walk-offline-kept', label: 'Offline: a pick kept on this tablet', model: base({ frame: frame({ online: false, pending: 1 }), online: false, asOf: AS_OF, walk: { walk: WALK, taken: new Set([stopKey(STOPS[0]!)]) }, last: picked({ quantity: null, ticks: 'saved', clientEventId: 'c-1' }) }), note: 'One tick: kept here; the stop shows taken on this tablet until the office reads it back.' },
    { id: 'walk-sending', label: 'A kept pick being sent', model: base({ last: picked({ quantity: null, ticks: 'sending', clientEventId: 'c-1' }), walk: { walk: WALK, taken: new Set([stopKey(STOPS[0]!)]) } }) },
    { id: 'walk-refused-queue', label: 'The office refused a kept pick', model: base({ last: picked({ quantity: null, ticks: 'refused', clientEventId: 'c-1' }) }), note: 'Waiting to send holds the reason and the fix (F31: the refusal\'s own words).' },
    { id: 'walk-done', label: 'Every stop taken', model: base({ list: PICKED, walk: { walk: { ...WALK, stops: [], places: [] }, taken: none } }) },
    { id: 'walk-none', label: 'No walk on this tablet', model: base({ walk: null }), note: 'The walk could not be read (or this tablet never read it offline): Pick & issue works as before; Kit waits and says why.' },
  ],
})
