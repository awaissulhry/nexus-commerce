import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../lib/design/design-screen'
import { onFloor, signedInFrame } from '../frame/fixtures'
import type { HideCard, WorkOrderCard } from './scan-model'
import { ScanView, type RecentScan, type ScanViewModel } from './view/ScanView'

/**
 * SCR-024's cases: one field for every label, then the card of what was scanned. Made-up codes of a made-up tenant
 * (its tag from a fixed made-up id), made-up materials and orders; no money anywhere (the floor shows none).
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const HIDE = formatScanId({ type: 'HIDE', tenantTag: TAG, ref: 4211 })
const BUNDLE = formatScanId({ type: 'BUNDLE', tenantTag: TAG, ref: 123 })
const LOT = formatScanId({ type: 'LOT', tenantTag: TAG, ref: 77 })
const OTHER = formatScanId({ type: 'HIDE', tenantTag: tenantTag('0190f0e2-0000-7000-8000-000000000001'), ref: 9 })
const AT = '2026-10-29T08:41:00.000Z'

const hide: HideCard = {
  kind: 'hide',
  code: HIDE,
  item: 'Pelle bovina pieno fiore 1,2 mm (demo)',
  colour: 'NERO',
  area: '52.40',
  areaUom: 'ft²',
  grade: 'A',
  thicknessMm: '1.2',
  shade: 'S2',
  state: 'PARTLY_CUT',
  lot: { code: 'LOT-DEMO-0007', qualityStatus: 'RELEASED', crViStatus: 'PASS', usable: true, words: null },
  onHand: [{ location: 'A1-CUT-01', quantity: '31.20' }],
  workOrders: ['WO-DEMO-0001'],
}
const workOrder: WorkOrderCard = {
  kind: 'workOrder',
  number: 'WO-DEMO-0001',
  batchNumber: 'B-26-041',
  status: 'IN_PROGRESS',
  style: 'GIA-01 · Giacca moto Demo',
  dueDate: '2026-11-06',
  pieces: 120,
  toCut: 46,
  sizesLeft: ['NERO 48', 'NERO 50', 'NERO 52'],
  colourways: ['NERO', 'MARRONE'],
}
const recent: RecentScan[] = [
  { code: HIDE, type: 'hide', at: AT },
  { code: 'WO-DEMO-0001', type: 'workOrder', at: '2026-10-29T08:37:00.000Z' },
  { code: 'XYZ-1', type: null, at: '2026-10-29T08:30:00.000Z' },
]

const scan = (result: ScanViewModel['result'], extra: Partial<ScanViewModel> = {}): ScanViewModel => ({ frame: signedInFrame('scan.title'), result, recent: result ? recent : [], ...extra })

export const designScreen = defineDesignScreen<ScanViewModel>({
  screen: 'SCR-024',
  title: 'Scan anything',
  view: onFloor(ScanView),
  cases: [
    { id: 'empty', label: 'Ready to scan', model: scan(null), note: 'Scanner first (always listening), camera button, "Type a code".' },
    { id: 'hide', label: 'A hide', model: scan(hide), note: 'Lot status and Cr VI, where it is, the work orders it can be cut for. "Cut this hide" waits for the cutting screen (held, with its reason).' },
    {
      id: 'hide-on-hold',
      label: 'A hide of a lot on hold',
      model: scan({ ...hide, state: 'FULL', lot: { ...hide.lot, qualityStatus: 'QUARANTINE', crViStatus: 'PENDING', usable: false, words: null }, workOrders: [] }),
    },
    { id: 'work-order', label: 'A work order', model: scan(workOrder), note: 'Style, batch, due date, size run left to cut. Never a price or a cost.' },
    { id: 'location', label: 'A location', model: scan({ kind: 'location', code: 'A1-STORE-01', name: 'Magazzino pelli', locationKind: 'BIN', path: ['A1-STORE', 'A1-STORE-01'] }) },
    { id: 'bundle', label: 'A bundle (not on the tablet yet)', model: scan({ kind: 'notOnFloor', type: 'bundle', code: BUNDLE }), note: 'The bundles step adds its card; until then the label is named, nothing pretends.' },
    { id: 'lot', label: 'A lot (not on the tablet yet)', model: scan({ kind: 'notOnFloor', type: 'lot', code: LOT }) },
    { id: 'no-permission', label: 'A type this role may not open', model: scan({ kind: 'noPermission', type: 'location', code: 'A1-STORE-01' }), note: 'Fail closed: the lookup is never asked.' },
    { id: 'other-factory', label: 'Another factory\'s label', model: scan({ kind: 'unknown', code: OTHER, reason: 'otherFactory' }) },
    { id: 'typo', label: 'A misread code', model: scan({ kind: 'unknown', code: 'HD-7K-0003RJ-X', reason: 'typo' }) },
    { id: 'not-found', label: 'Nothing found', model: scan({ kind: 'unknown', code: 'XYZ-1', reason: 'notFound' }) },
    { id: 'badge-refused', label: 'A badge that does not open this tablet', model: scan({ kind: 'unknown', code: '', reason: 'badge' }) },
    { id: 'loading', label: 'Looking it up', model: scan(null, { loading: HIDE, recent }) },
    { id: 'unavailable', label: 'Server not answering', model: scan({ kind: 'unavailable', code: HIDE }) },
    { id: 'held', label: 'Scans held by the worker notice', model: scan(null, { held: true }) },
  ],
})
