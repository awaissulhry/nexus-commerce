import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import { fromListReason, type PickerList } from '../reasons/model'
import type { KitBundle, KitLine, KitOrder, KitRow } from './api'
import { bringBack, emptyBack, emptyDdt, emptyKit, rejectBack, setReturn, tickAll, toggleBundle, toggleLine, type BackDraft } from './model'
import { KitsView, type KitsViewModel } from './view/KitsView'

/**
 * SCR-181's cases (design floor.kits): the two tiles (and one held for a role), the site's orders to send and to receive
 * (loading, empty, offline), a scanned number not found or not sending, the kit list with ticks (nothing, two bundles
 * missing, complete, a material not in stock, the order not ready), the DDT's facts, the DDT full screen (opening, shown,
 * not stored), bundles back by scan, a rejection with its reason, scrapped at the workshop, the material back, Finish held
 * for a missing reason, the receipt, the problem states and no permission. A warehouse tablet (no station). Made-up
 * orders, workshops, materials, bundles and places of a made-up tenant; no fee, price or value anywhere.
 */

const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) => signedInFrame('tile.kits', { station: { name: null, site: DEMO_SITE }, ...extra })

const rows: KitRow[] = [
  { id: 'sc-1', number: 'SC-DEMO-0012', status: 'ISSUED', workshop: { code: 'TERZ-01', name: 'Laboratorio Demo Cuciture' }, workOrder: { number: 'WO-DEMO-0031', style: { code: 'GIA-DEMO-01', name: 'Giacca demo' } }, expectedBackDate: '2026-11-07', late: false, pieces: { ordered: 6, sent: 0, atWorkshop: 0, back: 0 }, kit: { planned: 2, sent: 0 } },
  { id: 'sc-2', number: 'SC-DEMO-0009', status: 'AT_WORKSHOP', workshop: { code: 'TERZ-02', name: 'Ricami Demo' }, workOrder: { number: 'WO-DEMO-0027', style: { code: 'PAN-DEMO-04', name: 'Pantalone demo' } }, expectedBackDate: '2026-10-29', late: true, pieces: { ordered: 10, sent: 6, atWorkshop: 6, back: 0 }, kit: { planned: 1, sent: 1 } },
]
const receiveRows: KitRow[] = [{ ...rows[1]!, kit: { planned: 0, sent: 2 } }, { ...rows[0]!, id: 'sc-3', number: 'SC-DEMO-0005', status: 'PARTLY_RECEIVED', pieces: { ordered: 4, sent: 4, atWorkshop: 2, back: 2 }, kit: { planned: 0, sent: 1 } }]

const store = { id: 'loc-store', code: 'A1-STORE-01', name: 'Scaffale materiali 1' }
const lining: KitLine = {
  id: 'kl-10',
  seq: 10,
  item: { id: 'item-lin', code: 'FOD-DEMO-GR', name: 'Fodera demo grigia', baseUom: 'M', tracking: 'LOT' },
  colour: { id: 'col-gry', code: 'GRY', name: 'Grigio' },
  lot: null,
  hide: null,
  quantity: '13.2300',
  uom: 'M',
  baseQuantity: '13.2300',
  status: 'PLANNED',
  sentAt: null,
  ddtNumber: null,
  sources: [
    { location: store, lot: { id: 'lot-1', code: 'LOT-DEMO-LIN-01' }, hide: null, available: '120.0000', covers: true },
    { location: { id: 'loc-store2', code: 'A1-STORE-02', name: 'Scaffale materiali 2' }, lot: { id: 'lot-2', code: 'LOT-DEMO-LIN-02' }, hide: null, available: '6.0000', covers: false },
  ],
  from: null,
  atWorkshop: null,
}
const protectors: KitLine = { ...lining, id: 'kl-20', seq: 20, item: { id: 'item-pro', code: 'PRO-DEMO-300', name: 'Protezioni spalle demo', baseUom: 'PCS', tracking: 'NONE' }, colour: null, quantity: '12.0000', uom: 'PCS', baseQuantity: '12.0000', sources: [{ location: store, lot: null, hide: null, available: '40.0000', covers: true }] }
const bundle = (n: number, extra: Partial<KitBundle> = {}): KitBundle => ({ id: `bn-${n}`, code: `BN-DEMO-00${n}`, replacedCodes: [], workOrderSizeId: n % 2 ? 'cell-50' : 'cell-52', colourway: 'NERO', size: n % 2 ? '50' : '52', part: null, quantity: n === 3 ? 1 : 2, sent: false, back: [], ...extra })
const operation = { id: 'op-10', seq: 10, code: 'SEW', name: 'Cucitura', pieces: 6, sent: 0, backGood: 0, backDefective: 0, scrapped: 0, atWorkshop: 0, cells: [] as string[] }

const order: KitOrder = {
  id: 'sc-1',
  number: 'SC-DEMO-0012',
  status: 'ISSUED',
  version: 4,
  workshop: { code: 'TERZ-01', name: 'Laboratorio Demo Cuciture' },
  location: { code: 'A1-TERZ-01', name: 'Presso Laboratorio Demo' },
  workOrder: { number: 'WO-DEMO-0031', style: { code: 'GIA-DEMO-01', name: 'Giacca demo' } },
  expectedBackDate: '2026-11-07',
  late: false,
  operations: [operation],
  kitLines: [lining, protectors],
  bundles: [bundle(1), bundle(2), bundle(3), bundle(4, { part: 'MANICHE', quantity: 2 })],
  places: [{ ...store, kind: 'BIN' }, { id: 'loc-store2', code: 'A1-STORE-02', name: 'Scaffale materiali 2', kind: 'BIN' }, { id: 'loc-rcv', code: 'A1-RCV', name: 'Banchina arrivi', kind: 'RECEIVING' }],
  ddts: [],
  actions: { send: null, receive: 'Nothing is at the workshop yet.' },
}

const partial = toggleLine(toggleLine(toggleBundle(emptyKit(), 'bn-1'), lining), protectors)
const complete = tickAll(order)
const noStock: KitOrder = { ...order, kitLines: [lining, { ...protectors, sources: [] }] }

/** The same order after the send: everything out, the DDT issued. */
const out: KitOrder = {
  ...order,
  status: 'AT_WORKSHOP',
  version: 6,
  operations: [{ ...operation, sent: 5, atWorkshop: 5 }],
  kitLines: [
    { ...lining, status: 'SENT', lot: { id: 'lot-1', code: 'LOT-DEMO-LIN-01' }, sources: [], from: store, atWorkshop: '13.2300', ddtNumber: '146/2026', sentAt: '2026-10-31T07:40:00.000Z' },
    { ...protectors, status: 'SENT', sources: [], from: store, atWorkshop: '12.0000', ddtNumber: '146/2026', sentAt: '2026-10-31T07:40:00.000Z' },
  ],
  bundles: order.bundles.map((entry) => ({ ...entry, sent: true })),
  ddts: [{ id: 'ddt-1', number: '146/2026', documentDate: '2026-10-31', cancelled: false, pdf: true }],
  actions: { send: null, receive: null },
}
// The REWORK list in the floor's one reason picker (B-W2a-F6): the office's codes, in its order.
const reasons: PickerList = {
  state: 'ready',
  asOf: null,
  reasons: [
    fromListReason({ id: 'r1', list: 'REWORK', code: 'OPEN_SEAM', labelIt: 'Cucitura aperta', labelEn: 'Open seam', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 10 }),
    fromListReason({ id: 'r2', list: 'REWORK', code: 'WRONG_STITCH', labelIt: 'Punto sbagliato', labelEn: 'Wrong stitch', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 20 }),
    fromListReason({ id: 'r3', list: 'REWORK', code: 'STAIN', labelIt: 'Macchia', labelEn: 'Stain', labelI18n: {}, icon: null, colour: null, needsDetail: false, sortOrder: 30 }),
  ],
}
const scanned: BackDraft = bringBack(out, bringBack(out, emptyBack(), 'bn-1'), 'bn-2')
const rejected: BackDraft = { ...rejectBack(out, scanned, 'bn-2', 1, 'defective', 'OPEN_SEAM'), ddtNumber: 'DDT-TERZ-77' }
const withMaterial: BackDraft = setReturn(rejected, out.kitLines[0]!, 2.5, store.id)
const noReason: BackDraft = rejectBack(out, scanned, 'bn-2', 1, 'defective', null)

// A made-up one-page PDF ("DDT DEMO"), for the full-screen DDT step.
const DEMO_PDF =
  'JVBERi0xLjQKMSAwIG9iago8PCAvVHlwZSAvQ2F0YWxvZyAvUGFnZXMgMiAwIFIgPj4KZW5kb2JqCjIgMCBvYmoKPDwgL1R5cGUgL1BhZ2VzIC9LaWRzIFszIDAgUl0gL0NvdW50IDEgPj4KZW5kb2JqCjMgMCBvYmoKPDwgL1R5cGUgL1BhZ2UgL1BhcmVudCAyIDAgUiAvTWVkaWFCb3ggWzAgMCA1OTUgODQyXSAvQ29udGVudHMgNCAwIFIgL1Jlc291cmNlcyA8PCAvRm9udCA8PCAvRjEgNSAwIFIgPj4gPj4gPj4KZW5kb2JqCjQgMCBvYmoKPDwgL0xlbmd0aCA5NCA+PgpzdHJlYW0KQlQgL0YxIDE4IFRmIDYwIDc4MCBUZCAoRERUIERFTU8gLSBjb250byBsYXZvcmF6aW9uZSkgVGogMCAtMzAgVGQgKERvY3VtZW50byBkaSBlc2VtcGlvKSBUaiBFVAplbmRzdHJlYW0KZW5kb2JqCjUgMCBvYmoKPDwgL1R5cGUgL0ZvbnQgL1N1YnR5cGUgL1R5cGUxIC9CYXNlRm9udCAvSGVsdmV0aWNhID4+CmVuZG9iagp4cmVmCjAgNgowMDAwMDAwMDAwIDY1NTM1IGYgCjAwMDAwMDAwMDkgMDAwMDAgbiAKMDAwMDAwMDA1OCAwMDAwMCBuIAowMDAwMDAwMTE1IDAwMDAwIG4gCjAwMDAwMDAyNDEgMDAwMDAgbiAKMDAwMDAwMDM4NSAwMDAwMCBuIAp0cmFpbGVyCjw8IC9TaXplIDYgL1Jvb3QgMSAwIFIgPj4Kc3RhcnR4cmVmCjQ1NQolJUVPRgo='
const pdfBytes = Uint8Array.from(atob(DEMO_PDF), (char) => char.charCodeAt(0))

const may = { send: true, receive: true }
const base = (extra: Partial<KitsViewModel>): KitsViewModel => ({ frame: frame(), online: true, stage: 'kit', may, mode: 'send', order, kit: emptyKit(), ddt: emptyDdt(), ...extra })
const backBase = (extra: Partial<KitsViewModel>): KitsViewModel => ({ frame: frame(), online: true, stage: 'back', may, mode: 'receive', order: out, back: emptyBack(), reasons, ...extra })
const refused = (code: string, shown: string | null) => ({ problem: { kind: 'refused' as const, code, message: code, fix: null }, code: shown })

export const designScreen = defineDesignScreen<KitsViewModel>({
  screen: 'SCR-181',
  title: 'Subcontract kits',
  view: onFloor(KitsView),
  cases: [
    { id: 'mode', label: 'Send or receive?', model: { frame: frame(), online: true, stage: 'mode', may }, note: 'Two tiles. No fee, price or value on the floor.' },
    { id: 'mode-receive-only', label: 'Role that only receives', model: { frame: frame(), online: true, stage: 'mode', may: { send: false, receive: true } }, note: 'Send a kit is held with the reason (no purchasing.subcontract.kit).' },
    { id: 'pick-send', label: 'Kits to send', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: rows }, note: 'Scan the order number or tap an order of this site.' },
    { id: 'pick-loading', label: 'Reading the orders', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: null } },
    { id: 'pick-empty', label: 'No kit to send', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: [] } },
    { id: 'pick-receive', label: 'Goods at the workshops', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'receive', orders: receiveRows } },
    { id: 'pick-offline', label: 'Offline: opening waits', model: { frame: frame({ online: false }), online: false, stage: 'pick', may, mode: 'send', orders: rows } },
    { id: 'refused-not-found', label: 'Refused: number not found', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: rows, problem: refused('NOT_FOUND', 'SC-DEMO-9999') } },
    { id: 'refused-not-sending', label: 'Refused: order not ready', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: rows, problem: refused('NOT_SENDING', 'SC-DEMO-0003') }, note: 'A draft or closed order: its state in words.' },
    { id: 'kit', label: 'The kit list', model: base({}), note: 'From the bill of materials (each line from the place that holds it) and the cut bundles; scan each bundle or material.' },
    { id: 'kit-missing', label: 'Kit not complete', model: base({ kit: partial }), note: "Held in the design's words: 'Kit not complete: 2 bundles missing.' Partial kits go from the office dialog." },
    { id: 'kit-complete', label: 'Kit complete', model: base({ kit: complete }) },
    { id: 'kit-no-stock', label: 'A material not in stock here', model: base({ order: noStock, kit: toggleLine(emptyKit(), lining) }) },
    { id: 'kit-state', label: 'Order not ready to send', model: base({ order: { ...order, actions: { send: 'The work order is on hold.', receive: null } } }), note: 'The office’s reason holds the send; the tablet shows its own words.' },
    { id: 'refused-not-in-kit', label: 'Refused: label not in the kit', model: base({ kit: partial, problem: refused('NOT_IN_KIT', 'LOT-DEMO-XX-99') }) },
    { id: 'ddt', label: 'The DDT’s facts', model: base({ stage: 'ddt', kit: complete }), note: 'Who carries, parcels, gross weight, appearance: the DDT says conto lavorazione.' },
    { id: 'ddt-filled', label: 'Ready to send', model: base({ stage: 'ddt', kit: complete, ddt: { transportBy: 'SENDER', packages: 2, grossWeightKg: 6.5, appearance: 'BOXES' } }) },
    { id: 'ddt-offline', label: 'Offline: Send waits', model: base({ stage: 'ddt', kit: complete, ddt: { transportBy: 'RECIPIENT', packages: 1, grossWeightKg: 3.2, appearance: 'BAGS' }, online: false, frame: frame({ online: false }) }) },
    { id: 'ddt-busy', label: 'Sending', model: base({ stage: 'ddt', kit: complete, ddt: { transportBy: 'SENDER', packages: 2, grossWeightKg: 6.5, appearance: 'BOXES' }, busy: 'send' }) },
    { id: 'sent-loading', label: 'Opening the DDT', model: base({ stage: 'sent', order: out, sent: { number: '146/2026', pdf: 'loading' } }) },
    { id: 'sent', label: 'The DDT full screen', model: base({ stage: 'sent', order: out, sent: { number: '146/2026', pdf: pdfBytes } }), note: 'A made-up one-page PDF; Print sends it to the tablet’s printer.' },
    { id: 'sent-missing', label: 'DDT issued, PDF not stored', model: base({ stage: 'sent', order: out, sent: { number: '146/2026', pdf: 'missing' } }) },
    { id: 'back', label: 'Receive back', model: backBase({}), note: 'Scan each bundle (no tap): its garments still out come back good. Rows per bundle and size: out / back / rejected.' },
    { id: 'back-scanned', label: 'Two bundles back, one rejected', model: backBase({ back: rejected }) },
    { id: 'back-reject', label: 'Reject garments of a bundle', model: backBase({ back: scanned, reject: { bundleId: 'bn-2', kind: 'defective', count: 1, reason: 'OPEN_SEAM' } }), note: 'Why, in the floor\'s one reason picker (SCR-091, pick mode) over the office\'s REWORK list: what it is about, the choice, the tiles.' },
    { id: 'back-scrapped', label: 'Scrapped at the workshop', model: backBase({ back: scanned, reject: { bundleId: 'bn-1', kind: 'scrapped', count: 1, reason: null } }), note: 'The reason is asked before Confirm ("Choose a reason first").' },
    { id: 'back-reasons-loading', label: 'Reading the reasons', model: backBase({ back: scanned, reasons: { state: 'loading', reasons: [], asOf: null }, reject: { bundleId: 'bn-2', kind: 'defective', count: 1, reason: null } }) },
    { id: 'back-no-reasons', label: 'Reasons not readable', model: backBase({ back: scanned, reasons: { state: 'error', reasons: [], asOf: null }, reject: { bundleId: 'bn-2', kind: 'defective', count: 1, reason: null } }), note: 'The picker\'s failed state with Try again; meanwhile the rejection goes without a reason (Confirm does not wait).' },
    { id: 'back-reasons-none', label: 'No rework reasons set', model: backBase({ back: scanned, reasons: { state: 'ready', reasons: [], asOf: null }, reject: { bundleId: 'bn-2', kind: 'defective', count: 1, reason: null } }), note: 'The office keeps no REWORK reasons: the picker says whom to ask; the rejection goes without one.' },
    { id: 'back-material', label: 'Material back', model: backBase({ back: rejected, material: { lineId: 'kl-10', quantity: 2.5, toLocationId: store.id } }), note: 'By quantity, to the place it left from unless another is picked.' },
    { id: 'back-with-material', label: 'Bundles and material on the receipt', model: backBase({ back: withMaterial }) },
    { id: 'back-reason-held', label: 'Finish held: a reason missing', model: backBase({ back: noReason }) },
    { id: 'back-offline', label: 'Offline: Finish receipt waits', model: backBase({ back: rejected, online: false, frame: frame({ online: false }) }) },
    { id: 'refused-not-out', label: 'Refused: bundle did not go out', model: backBase({ back: scanned, problem: refused('NOT_OUT', 'BN-DEMO-0099') }) },
    { id: 'received', label: 'Receipt recorded', model: backBase({ stage: 'received', received: { good: 3, defective: 1, scrapped: 0, returned: 1 } }) },
    { id: 'error', label: 'Server not answering', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: [], problem: { problem: { kind: 'unavailable' }, code: null } } },
    { id: 'no-permission', label: 'No permission', model: { frame: frame(), online: true, stage: 'noPermission', may: { send: false, receive: false } }, note: 'Without the kit permission the tile is not shown either: fail closed.' },
    { id: 'notice-held', label: 'Scans held by the worker notice', model: { frame: frame(), online: true, stage: 'pick', may, mode: 'send', orders: rows, held: true } },
  ],
})
