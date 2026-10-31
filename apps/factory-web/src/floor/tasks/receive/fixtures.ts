import { formatScanId, tenantTag } from '@nexus/factory-domain/numbering/scan-id'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_SITE, onFloor, signedInFrame } from '../../frame/fixtures'
import type { ExpectedOrder, FloorReceipt, OrderLine, OrderToReceive, TagJob } from './api'
import { addHide, addLot, emptyDelivery, firstHideForm, formAfter, nextHideForm, setOver, setQuantity, type Delivery, type HideForm } from './model'
import { ReceiveView, type ReceiveViewModel } from './view/ReceiveView'

/**
 * SCR-092's cases (design floor.receive): which delivery (scan the PO or the delivery note, or tap an expected order),
 * what we expect, hide by hide with the pad and "same as last", a lot line and a quantity line, quality hold, over the
 * tolerance, the summary before posting, done with the hide tags printing (queued, printed, failed with Retry, reprint),
 * refusals in words (order cancelled meanwhile, changed meanwhile, changes proposed), offline held, error, no permission.
 * A warehouse device (no station). Made-up orders, suppliers, materials, lots and hides of a made-up tenant; no money.
 */

const TAG = tenantTag('0190f0e2-4c1d-7a3b-9e55-2f1c8d7a6b10')
const hide = (ref: number) => formatScanId({ type: 'HIDE', tenantTag: TAG, ref })
const AS_OF = '2026-10-30T07:42:00.000Z'
const frame = (extra: Parameters<typeof signedInFrame>[1] = {}) =>
  signedInFrame('tile.receive', {
    station: { name: null, site: DEMO_SITE },
    ...extra,
  })

const supplier = { id: 'sup-1', name: 'Conceria Demo Valdarno' }

const expected: ExpectedOrder[] = [
  {
    id: 'po-1',
    number: 'PO-DEMO-0101',
    status: 'CONFIRMED',
    supplier,
    due: '2026-11-03',
    openLines: 3,
    lines: 3,
    receivedBefore: true,
  },
  {
    id: 'po-2',
    number: 'PO-DEMO-0104',
    status: 'SENT',
    supplier: { id: 'sup-2', name: 'Protezioni Demo Srl' },
    due: '2026-11-05',
    openLines: 1,
    lines: 1,
    receivedBefore: false,
  },
  {
    id: 'po-3',
    number: 'PO-DEMO-0108',
    status: 'PARTLY_RECEIVED',
    supplier: { id: 'sup-3', name: 'Filati Demo Nord' },
    due: null,
    openLines: 2,
    lines: 4,
    receivedBefore: true,
  },
]

const leather: OrderLine = {
  id: 'pol-10',
  seq: 10,
  item: {
    id: 'item-leather',
    code: 'PEL-BOV-12',
    name: 'Pelle bovina pieno fiore 1,2 mm (demo)',
    tracking: 'HIDE',
    baseUom: 'FT2',
    isPpeComponent: false,
  },
  colour: { code: 'NERO', name: 'Nero' },
  quantity: '1200.0000',
  uom: 'FT2',
  expected: '1200.0000',
  received: '400.0000',
  open: '800.0000',
  tolerancePct: '5',
  upTo: '860.0000',
  needDate: '2026-11-03',
  confirmedDate: '2026-11-03',
  estimatedHides: 24,
  hidesReceived: 8,
  grade: 'A',
  thicknessMinMm: '1.10',
  thicknessMaxMm: '1.30',
  oneDyeBatch: true,
  holds: ['CR_VI_TEST'],
  areaUnits: ['FT2', 'M2', 'DM2'],
}
const protectors: OrderLine = {
  id: 'pol-20',
  seq: 20,
  item: {
    id: 'item-armour',
    code: 'PRT-SPALLA-L1',
    name: 'Protezione spalla EN 1621-1 L1 (demo)',
    tracking: 'LOT',
    baseUom: 'PAIR',
    isPpeComponent: true,
  },
  colour: null,
  quantity: '120.0000',
  uom: 'PAIR',
  expected: '120.0000',
  received: '0.0000',
  open: '120.0000',
  tolerancePct: null,
  upTo: '120.0000',
  needDate: '2026-11-05',
  confirmedDate: null,
  estimatedHides: null,
  hidesReceived: 0,
  grade: null,
  thicknessMinMm: null,
  thicknessMaxMm: null,
  oneDyeBatch: false,
  holds: ['PPE_CERTIFICATE'],
  areaUnits: [],
}
const thread: OrderLine = {
  ...protectors,
  id: 'pol-30',
  seq: 30,
  item: {
    id: 'item-thread',
    code: 'FIL-40',
    name: 'Filo poliestere 40 (demo)',
    tracking: 'NONE',
    baseUom: 'CONE',
    isPpeComponent: false,
  },
  quantity: '12.0000',
  uom: 'CONE',
  expected: '12.0000',
  open: '12.0000',
  upTo: '12.0000',
  holds: [],
}

const order: OrderToReceive = {
  serverTime: AS_OF,
  order: {
    id: 'po-1',
    number: 'PO-DEMO-0101',
    status: 'CONFIRMED',
    version: 4,
    supplier,
    requestedDate: '2026-11-03',
  },
  refusal: null,
  lines: [leather, protectors, thread],
  dock: { id: 'loc-rcv', code: 'A1-RCV', name: 'Ricevimento A1' },
  hold: { id: 'loc-q1', code: 'Q1', name: 'Scaffale blocco qualità' },
  printer: { id: 'prn-1', code: 'LBL-RCV', name: 'Etichette ricevimento' },
}

// The delivery as the tablet holds it: three hides of one dye batch, then a lot of protectors, then thread.
const start = emptyDelivery(order, '4512/26')
const form0: HideForm = {
  ...firstHideForm(leather),
  supplierCode: 'T-88121',
  area: 52.4,
  dyeBatch: 'DB-118',
  shade: 'N2',
  thicknessMm: 1.2,
}
const after1 = addHide(start, leather, form0)
const form1 = { ...nextHideForm(form0), supplierCode: 'T-88122', area: 51.8 }
const after2 = addHide(after1, leather, form1)
const form2 = {
  ...nextHideForm(form1),
  supplierCode: 'T-88123',
  area: 50.9,
  defects: ['scar' as const],
}
const threeHides = addHide(after2, leather, form2)
const withLot = addLot(threeHides, protectors.id, {
  quantity: 120,
  supplierLotRef: 'PS-2611-A',
  hold: null,
})
const withAll = setQuantity(withLot, thread.id, 10)

// Over the tolerance: the line had 1150 received before, three more hides take it past 1260.
const leatherNearlyIn: OrderLine = {
  ...leather,
  received: '1150.0000',
  open: '50.0000',
  upTo: '110.0000',
  hidesReceived: 22,
}
const orderNearlyIn: OrderToReceive = {
  ...order,
  lines: [leatherNearlyIn, protectors, thread],
}
const overDelivery = addHide(addHide(addHide(emptyDelivery(orderNearlyIn), leatherNearlyIn, form0), leatherNearlyIn, form1), leatherNearlyIn, form2)

const base = (extra: Partial<ReceiveViewModel> = {}): ReceiveViewModel => ({
  frame: frame(),
  online: true,
  stage: 'lines',
  order,
  delivery: start,
  ...extra,
})
const hideStep = (delivery: Delivery, form: HideForm, extra: Partial<ReceiveViewModel> = {}): ReceiveViewModel =>
  base({
    stage: 'line',
    lineId: leather.id,
    delivery,
    hideForm: form,
    ...extra,
  })

// After the post: the receipt with its lots, hides and their tags.
const tags = (states: readonly (TagJob['status'] | 'none')[]): TagJob[] =>
  states.map((status, index) => ({
    hideId: `hide-${index + 1}`,
    code: hide(4300 + index),
    jobId: status === 'none' ? null : `job-${index + 1}`,
    status: status === 'none' ? null : status,
    version: status === 'none' ? null : 1,
    problem: status === 'FAILED' ? 'Printer LBL-RCV: out of labels' : status === 'none' ? 'No label printer at this station.' : null,
  }))
const receipt = (states: readonly (TagJob['status'] | 'none')[], printer: boolean = true): FloorReceipt => ({
  id: 'gr-1',
  number: 'GR-DEMO-0042',
  status: 'POSTED',
  receivedAt: '2026-10-30T08:14:00.000Z',
  supplierDdtNumber: '4512/26',
  supplierDdtDate: '2026-10-30',
  order: { ...order.order, status: 'PARTLY_RECEIVED', version: 6 },
  lines: [
    {
      seq: 10,
      purchaseOrderLineId: leather.id,
      item: {
        code: leather.item.code,
        name: leather.item.name,
        tracking: 'HIDE',
      },
      colour: leather.colour,
      quantity: '155.1000',
      uom: 'FT2',
      baseQuantity: '155.1000',
      hideCount: 3,
      difference: {
        kind: 'SHORT',
        expected: '1200.0000',
        after: '555.1000',
        open: '644.9000',
        difference: '-644.9000',
        upTo: '1260.0000',
      },
    },
    {
      seq: 20,
      purchaseOrderLineId: protectors.id,
      item: {
        code: protectors.item.code,
        name: protectors.item.name,
        tracking: 'LOT',
      },
      colour: null,
      quantity: '120.0000',
      uom: 'PAIR',
      baseQuantity: '120.0000',
      hideCount: null,
      difference: {
        kind: 'EXACT',
        expected: '120.0000',
        after: '120.0000',
        open: '0.0000',
        difference: '0.0000',
        upTo: '120.0000',
      },
    },
    {
      seq: 30,
      purchaseOrderLineId: thread.id,
      item: {
        code: thread.item.code,
        name: thread.item.name,
        tracking: 'NONE',
      },
      colour: null,
      quantity: '10.0000',
      uom: 'CONE',
      baseQuantity: '10.0000',
      hideCount: null,
      difference: {
        kind: 'SHORT',
        expected: '12.0000',
        after: '10.0000',
        open: '2.0000',
        difference: '-2.0000',
        upTo: '12.0000',
      },
    },
  ],
  lots: [
    {
      id: 'lot-1',
      code: 'LA-DEMO-0042',
      lineSeq: 10,
      supplierLotRef: null,
      dyeBatch: 'DB-118',
      qualityStatus: 'QUARANTINE',
      holds: ['CR_VI_TEST'],
      requiresCrViTest: true,
      crViStatus: 'PENDING',
      baseQuantity: '155.1000',
      hideCount: 3,
      location: { id: 'loc-q1', code: 'Q1', name: 'Scaffale blocco qualità' },
    },
    {
      id: 'lot-2',
      code: 'LA-DEMO-0043',
      lineSeq: 20,
      supplierLotRef: 'PS-2611-A',
      dyeBatch: null,
      qualityStatus: 'QUARANTINE',
      holds: ['PPE_CERTIFICATE'],
      requiresCrViTest: false,
      crViStatus: 'NOT_REQUIRED',
      baseQuantity: '120.0000',
      hideCount: 0,
      location: { id: 'loc-q1', code: 'Q1', name: 'Scaffale blocco qualità' },
    },
  ],
  hides: [
    {
      id: 'hide-1',
      code: hide(4300),
      lotId: 'lot-1',
      lotCode: 'LA-DEMO-0042',
      supplierCode: 'T-88121',
      area: '52.4000',
      areaUom: 'FT2',
      grade: 'A',
      shade: 'N2',
      thicknessMm: '1.20',
    },
    {
      id: 'hide-2',
      code: hide(4301),
      lotId: 'lot-1',
      lotCode: 'LA-DEMO-0042',
      supplierCode: 'T-88122',
      area: '51.8000',
      areaUom: 'FT2',
      grade: 'A',
      shade: 'N2',
      thicknessMm: '1.20',
    },
    {
      id: 'hide-3',
      code: hide(4302),
      lotId: 'lot-1',
      lotCode: 'LA-DEMO-0042',
      supplierCode: 'T-88123',
      area: '50.9000',
      areaUom: 'FT2',
      grade: 'A',
      shade: 'N2',
      thicknessMm: '1.20',
    },
  ],
  tags: { printer: printer ? order.printer : null, jobs: tags(states) },
})
const NOTES = [
  {
    code: 'SHORT',
    seq: 10,
    message: 'Line 10 (PEL-BOV-12 NERO): 555.1 ft² received of 1200 ft² expected; 644.9 ft² still open.',
  },
  {
    code: 'HIDE_COUNT',
    seq: 10,
    message: 'Line 10: 11 hides of the 24 the buyer expects.',
  },
  { code: 'SHORT', seq: 30, message: 'Line 30 (FIL-40): 10 cones of 12.' },
  { code: 'QUARANTINE', seq: 10, message: 'Lot LA-DEMO-0042: in quarantine.' },
]
const done = (states: readonly (TagJob['status'] | 'none')[], extra: Partial<ReceiveViewModel> = {}, printer = true): ReceiveViewModel =>
  base({
    stage: 'done',
    delivery: withAll,
    posted: { receipt: receipt(states, printer), notes: NOTES },
    selectedHideId: 'hide-1',
    ...extra,
  })

// ---- B-W2a-75: the supplier's delivery note (number, date, photo) ----
const TODAY = '2026-10-30'
const YESTERDAY = '2026-10-29'
/** A made-up drawing of a delivery note (never a real photo). */
const DDT_DRAWING = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200"><rect width="320" height="200" fill="#f4f1ea"/><rect x="16" y="16" width="120" height="14" fill="#9a958a"/><rect x="16" y="44" width="288" height="6" fill="#c9c4b8"/><rect x="16" y="58" width="260" height="6" fill="#c9c4b8"/><rect x="16" y="72" width="280" height="6" fill="#c9c4b8"/><rect x="16" y="150" width="96" height="30" fill="#5a564d"/><text x="200" y="30" font-family="sans-serif" font-size="14" fill="#5a564d">DDT DEMO</text></svg>')}`
const ddtModel = (extra: Partial<NonNullable<ReceiveViewModel['ddt']>> = {}): NonNullable<ReceiveViewModel['ddt']> => ({ today: TODAY, moreDays: false, camera: false, photo: null, ...extra })
const ddtStage = (delivery: Partial<Delivery>, ddt: Partial<NonNullable<ReceiveViewModel['ddt']>> = {}): ReceiveViewModel => base({ stage: 'ddt', delivery: { ...start, ...delivery }, ddt: ddtModel(ddt) })

const problem = (code: string, shown: string | null = 'PO-DEMO-0101'): ReceiveViewModel['problem'] => ({
  problem: { kind: 'refused', code, message: code, fix: null },
  code: shown,
})

export const designScreen = defineDesignScreen<ReceiveViewModel>({
  screen: 'SCR-092',
  title: 'Receive goods',
  view: onFloor(ReceiveView),
  cases: [
    {
      id: 'scan',
      label: 'Which delivery',
      model: { frame: frame(), online: true, stage: 'scan', expected },
      note: 'Scan our PO number (on the PO, or as the supplier quotes it on the delivery note), or tap an order the site expects. No prices anywhere on the floor.',
    },
    {
      id: 'scan-empty',
      label: 'Nothing expected',
      model: { frame: frame(), online: true, stage: 'scan', expected: [] },
    },
    {
      id: 'scan-loading',
      label: 'Reading what is expected',
      model: { frame: frame(), online: true, stage: 'scan', expected: null },
    },
    {
      id: 'scan-ddt',
      label: 'A delivery note scanned',
      model: {
        frame: frame(),
        online: true,
        stage: 'scan',
        expected,
        ddtCode: '4512/26',
      },
      note: "The code is no PO number of ours: it is kept as the delivery note's number while the order it brings is tapped.",
    },
    {
      id: 'lines',
      label: 'What we expect',
      model: base(),
      note: "The order's lines: what is still to come as a big number, how each is received (hide by hide, by lot, by quantity), which go to quality hold. A row opens its step; an order of one line opens it at once.",
    },
    {
      id: 'lines-entered',
      label: 'Lines with entries',
      model: base({ delivery: withAll }),
      note: 'What this delivery holds of each line beside it; Finish delivery opens the summary.',
    },
    {
      id: 'hide-first',
      label: 'First hide',
      model: hideStep(start, firstHideForm(leather)),
      note: "Scan the tannery's ticket (or type it), type the area on the pad, pick the grade (the order's grade is preselected). Tags print when the delivery is posted: the office numbers them.",
    },
    {
      id: 'hide-entry',
      label: 'Hide by hide, same as last',
      model: hideStep(threeHides, { ...nextHideForm(form2), area: 49.6 }),
      note: 'Grade, thickness, dye batch and shade stay from the last hide: most hides need only the area (3–4 digits, Save). Running totals against what is still to come and the most taken without a reason. Undo takes the last hide back.',
    },
    {
      id: 'hide-thickness',
      label: 'Thickness on the pad',
      model: hideStep(threeHides, { ...nextHideForm(form2), pad: 'thickness' }),
    },
    {
      id: 'hide-dye-batch',
      label: 'A new dye batch',
      model: hideStep(threeHides, { ...nextHideForm(form2), text: 'dyeBatch' }),
      note: 'The next scan or typed code is the dye batch: a new dye batch starts a new lot.',
    },
    {
      id: 'hide-hold',
      label: 'Hold a lot for a check',
      model: hideStep(threeHides, formAfter(leather, threeHides.entries[leather.id]!), { holdAsk: true }),
      note: 'The receiver may hold a lot with a reason; only quality releases it (never the receiver).',
    },
    {
      id: 'hide-over',
      label: 'Over the tolerance',
      model: {
        ...hideStep(overDelivery, nextHideForm(form2)),
        order: orderNearlyIn,
      },
      note: 'Amber: the line now brings more than its tolerance allows; the reason is asked before posting.',
    },
    {
      id: 'lot-line',
      label: 'A lot line',
      model: base({
        stage: 'line',
        lineId: protectors.id,
        quantityForm: {
          quantity: 120,
          supplierLotRef: 'PS-2611-A',
          hold: null,
        },
      }),
      note: "The pad starts at what is still to come; the supplier's batch is scanned. A PPE part goes to quality hold for its certificate check.",
    },
    {
      id: 'quantity-line',
      label: 'A quantity line',
      model: base({
        stage: 'line',
        lineId: thread.id,
        delivery: withLot,
        quantityForm: { quantity: 12, supplierLotRef: null, hold: null },
      }),
      note: 'Receive a line that arrived complete: two taps after the scan.',
    },
    {
      id: 'finish',
      label: 'Finish the delivery',
      model: base({ stage: 'finish', delivery: withAll }),
      note: 'Lines received, short and over, lots, hides and what is on hold before posting; where held lots go.',
    },
    {
      id: 'finish-over',
      label: 'Over: give the reason',
      model: {
        ...base({ stage: 'finish', delivery: overDelivery }),
        order: orderNearlyIn,
      },
      note: "More than the tolerance allows: the line asks why before the post (the API's own rule, factory-domain lineDifference).",
    },
    {
      id: 'finish-over-given',
      label: 'Over: reason given',
      model: {
        ...base({
          stage: 'finish',
          delivery: setOver(overDelivery, leather.id, 'supplierSent'),
        }),
        order: orderNearlyIn,
      },
    },
    {
      id: 'finish-offline',
      label: 'Offline: held with the reason',
      model: base({
        frame: frame({ online: false, pending: 2 }),
        online: false,
        stage: 'finish',
        delivery: withAll,
      }),
      note: 'A receipt and its lots take their numbers from the office: Post waits for the network; nothing is queued, nothing is lost.',
    },
    {
      id: 'finish-posting',
      label: 'Posting',
      model: base({ stage: 'finish', delivery: withAll, busy: 'post' }),
    },
    {
      id: 'done-queued',
      label: 'Posted: tags on their way',
      model: done(['SENT', 'QUEUED', 'QUEUED']),
      note: "Recorded by the office (two ticks). Each hide tag is a print job on the station's label printer, read again every few seconds.",
    },
    {
      id: 'done-printed',
      label: 'Posted: tags printed',
      model: done(['PRINTED', 'PRINTED', 'PRINTED']),
      note: 'The order is now part received; lots in quality hold with why and where.',
    },
    {
      id: 'done-failed',
      label: 'A tag did not print',
      model: done(['PRINTED', 'FAILED', 'PRINTED'], {
        selectedHideId: 'hide-2',
      }),
      note: 'The failed tag says why; Retry sends it again.',
    },
    {
      id: 'done-reprint',
      label: 'Reprint a tag',
      model: done(['PRINTED', 'PRINTED', 'PRINTED'], {
        reprintAsk: true,
        selectedHideId: 'hide-3',
      }),
      note: 'Scan or tap the tag, then a reason tile: the reprint is logged with its reason.',
    },
    {
      id: 'done-no-printer',
      label: 'No label printer',
      model: done(['none', 'none', 'none'], {}, false),
    },
    {
      id: 'refused-cancelled',
      label: 'Refused: order cancelled meanwhile',
      model: base({ delivery: withAll, problem: problem('STATUS_CANCELLED') }),
      note: 'The buyer cancelled the order while the goods were being received: the post is refused in words.',
    },
    {
      id: 'refused-changed',
      label: 'Refused: order changed meanwhile',
      model: base({
        stage: 'finish',
        delivery: withAll,
        problem: problem('ORDER_CHANGED'),
      }),
      note: 'A newer version of the order: it was read again; what was typed stays.',
    },
    {
      id: 'refused-proposed',
      label: 'Refused: supplier proposed changes',
      model: {
        frame: frame(),
        online: true,
        stage: 'scan',
        expected,
        problem: problem('STATUS_CHANGES_PROPOSED', 'PO-DEMO-0110'),
      },
    },
    {
      id: 'refused-received',
      label: 'Refused: received in full',
      model: {
        frame: frame(),
        online: true,
        stage: 'scan',
        expected,
        problem: problem('STATUS_RECEIVED', 'PO-DEMO-0099'),
      },
    },
    {
      id: 'offline-scan',
      label: "Offline: the tablet's copy",
      model: {
        frame: frame({ online: false }),
        online: false,
        stage: 'scan',
        expected,
        asOf: AS_OF,
      },
      note: "Receiving is held while offline (it needs the office's numbers); what is expected shows as of the last read.",
    },
    {
      id: 'offline-hides',
      label: 'Offline while entering hides',
      model: hideStep(threeHides, { ...nextHideForm(form2), area: 48.2 }, { frame: frame({ online: false }), online: false }),
      note: 'Hides can still be entered; the post waits for the network.',
    },
    {
      id: 'error',
      label: 'Server not answering',
      model: {
        frame: frame(),
        online: true,
        stage: 'scan',
        expected: [],
        problem: { problem: { kind: 'unavailable' }, code: null },
      },
    },
    {
      id: 'no-permission',
      label: 'No permission',
      model: { frame: frame(), online: true, stage: 'noPermission' },
      note: 'A person without inventory.receive (the tile is not shown to them either): fail closed.',
    },
    {
      id: 'notice-held',
      label: 'Scans held by the worker notice',
      model: {
        frame: frame(),
        online: true,
        stage: 'scan',
        expected,
        held: true,
      },
    },
    {
      id: 'leave-ask',
      label: 'Leave a delivery with entries',
      model: base({ delivery: withAll, leaveAsk: true }),
    },
    // ---- B-W2a-75: the supplier's delivery note (design floor.receive sec "ddt"; SCM-115) ----
    {
      id: 'ddt',
      label: 'Delivery note: number and date',
      model: ddtStage({ ddtNumber: '4512/26', ddtDate: TODAY }),
      note: 'The number as scanned on the lines step (the pad types a number of digits only; a scan or the keyboard any other), the date as a tile (today, yesterday, another day of the week), a photo. All optional: the office asks a supplier for what is missing.',
    },
    { id: 'ddt-empty', label: 'Delivery note: nothing given yet', model: ddtStage({ ddtNumber: null }), note: 'The lines step offers "Delivery note: number, date, photo".' },
    { id: 'ddt-digits', label: 'A number of digits, yesterday, with a photo', model: ddtStage({ ddtNumber: '88123', ddtDate: YESTERDAY }, { photo: { url: DDT_DRAWING } }), note: 'The pad shows the digits; the photo stays on this tablet until the post.' },
    { id: 'ddt-another-day', label: 'Another day of the week', model: ddtStage({ ddtNumber: '4512/26', ddtDate: '2026-10-27' }, { moreDays: true }) },
    { id: 'ddt-camera', label: 'Taking the photo', model: ddtStage({ ddtNumber: '4512/26', ddtDate: TODAY }, { camera: true }), note: 'The DS photo capture: the camera or a file, no markup (a document), faces kept out.' },
    {
      id: 'lines-ddt',
      label: 'Lines with the delivery note given',
      model: base({ delivery: { ...withAll, ddtDate: TODAY }, ddt: ddtModel({ photo: { url: DDT_DRAWING } }) }),
      note: 'The button says what is given; the order card shows number and date.',
    },
    { id: 'finish-ddt', label: 'Finish: number, date and photo', model: base({ stage: 'finish', delivery: { ...withAll, ddtDate: TODAY }, ddt: ddtModel({ photo: { url: DDT_DRAWING } }) }) },
    { id: 'done-photo-sending', label: 'Posted: the photo on its way', model: done(['SENT', 'QUEUED', 'QUEUED'], { photoSend: 'sending' }) },
    { id: 'done-photo-sent', label: 'Posted: the photo sent', model: done(['PRINTED', 'PRINTED', 'PRINTED'], { photoSend: 'sent' }) },
    { id: 'done-photo-failed', label: 'Posted: the photo not sent', model: done(['PRINTED', 'PRINTED', 'PRINTED'], { photoSend: 'failed' }), note: 'The receipt stands; Send the photo again tries once more.' },
  ],
})
