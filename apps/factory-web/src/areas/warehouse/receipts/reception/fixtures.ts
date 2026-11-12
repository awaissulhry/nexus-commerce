import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { phrase } from '../../../_shared/buying/model'
import type { ReceptionReport, Unplanned } from './api'
import { defaultChoice, namingFor, serveRows } from './model'
import { ReceptionCase, type ReceptionCaseModel } from './view/ReceptionCase'
import type { ReceptionDialogModel } from './view/ReceptionDialog'
import type { WaitingModel } from './view/WaitingPanel'

/**
 * SCR-379's cases (B-W2b-300; design warehouse.receipts pop:rc-reception "Reception report", SCM-119; and SCM-122 goods without a
 * PO on the receipt record): the report of a posted receipt — the plan's pegging and the open work orders that need the lining,
 * a lot in quarantine, a demand that needs nothing more, the rows chosen with "Reserve for 2 work orders", done with the buyer
 * told, a refusal in words, nothing waiting, not posted, loading, error, read-only (held with why); goods without a PO waiting
 * (banner, the buyer's task), the naming dialog (an order that takes every line, a leather line's hide areas), send back with
 * its reason, no order yet, posted, sent back. Made-up numbers only; no money, no customer's name.
 */

const TZ = 'Europe/Rome'
const report: ReceptionReport = {
  receipt: { id: 'gr-1', number: 'GR-2026-0042', status: 'POSTED', companyId: 'co-1', siteId: 'site-1', purchaseOrder: { id: 'po-1', number: 'PO-2026-0017', partyId: 'sup-1' } },
  held: null,
  run: { id: 'run-1', finishedAt: '2026-11-11T05:00:00.000Z' },
  buyer: { id: 'u-buyer', name: 'Giulia Demo' },
  lines: [
    {
      receiptLineId: 'grl-1',
      seq: 10,
      purchaseOrderLineId: 'pol-1',
      item: { id: 'mat-lin', code: 'DEMO-LIN-140', name: 'Mesh lining 140 cm', baseUom: 'M', tracking: 'LOT' },
      colour: { id: 'col-gry', code: 'GRY', name: 'Grey' },
      received: '120.0000',
      lots: [{ id: 'lot-1', code: 'LA-000311', qualityStatus: 'RELEASED', free: '120.0000', held: false }],
      serves: [
        { key: 'WORK_ORDER:wo-1', kind: 'WORK_ORDER', why: 'PEGGED', workOrder: { id: 'wo-1', number: 'WO-2026-0031', status: 'RELEASED', dueDate: '2026-11-20' }, orderLine: null, needDate: '2026-11-18', pegged: '60.0000', open: '54.0000', reservedHere: '0.0000', proposed: '54.0000', lots: [{ lotId: 'lot-1', quantity: '54.0000' }], held: null },
        { key: 'ORDER_LINE:sol-1', kind: 'ORDER_LINE', why: 'PEGGED', workOrder: null, orderLine: { id: 'sol-1', number: 'SO-2026-0088', seq: 20, status: 'CONFIRMED' }, needDate: '2026-11-25', pegged: '20.0000', open: '20.0000', reservedHere: '0.0000', proposed: '20.0000', lots: [{ lotId: 'lot-1', quantity: '20.0000' }], held: null },
        { key: 'WORK_ORDER:wo-2', kind: 'WORK_ORDER', why: 'NEEDS', workOrder: { id: 'wo-2', number: 'WO-2026-0035', status: 'IN_PROGRESS', dueDate: '2026-11-28' }, orderLine: null, needDate: '2026-11-28', pegged: null, open: '18.5000', reservedHere: '0.0000', proposed: '18.5000', lots: [{ lotId: 'lot-1', quantity: '18.5000' }], held: null },
        { key: 'WORK_ORDER:wo-3', kind: 'WORK_ORDER', why: 'NEEDS', workOrder: { id: 'wo-3', number: 'WO-2026-0029', status: 'RELEASED', dueDate: '2026-11-15' }, orderLine: null, needDate: '2026-11-15', pegged: null, open: '0.0000', reservedHere: '12.0000', proposed: '0.0000', lots: [], held: 'NOT_NEEDED' },
      ],
      left: '27.5000',
    },
    {
      receiptLineId: 'grl-2',
      seq: 20,
      purchaseOrderLineId: 'pol-2',
      item: { id: 'mat-lea', code: 'DEMO-LEA-12', name: 'Cowhide 1.2 mm', baseUom: 'FT2', tracking: 'HIDE' },
      colour: { id: 'col-blk', code: 'BLK', name: 'Black' },
      received: '152.5000',
      lots: [{ id: 'lot-2', code: 'LA-000312', qualityStatus: 'QUARANTINE', free: '152.5000', held: true }],
      serves: [{ key: 'WORK_ORDER:wo-1', kind: 'WORK_ORDER', why: 'PEGGED', workOrder: { id: 'wo-1', number: 'WO-2026-0031', status: 'RELEASED', dueDate: '2026-11-20' }, orderLine: null, needDate: '2026-11-18', pegged: '150.0000', open: '150.0000', reservedHere: '0.0000', proposed: '0.0000', lots: [], held: 'IN_QUARANTINE' }],
      left: '0.0000',
    },
  ],
  proposals: 3,
  can: { reserve: true, send: true },
}
const rows = serveRows(report)
const dialog = (extra: Partial<ReceptionDialogModel> = {}): ReceptionCaseModel => ({ kind: 'report', number: report.receipt.number, model: { report: { status: 'ready', value: report }, chosen: defaultChoice(rows), tellBuyer: true, note: '', busy: false, problem: null, done: null, timeZone: TZ, ...extra } })
const workOrdersOnly = rows.filter((row) => row.serve.kind === 'WORK_ORDER' && Number(row.serve.proposed) > 0).map((row) => row.id)

export const UNPLANNED_DEMO: Unplanned = {
  receipt: {
    id: 'gr-9',
    number: 'GR-2026-0044',
    status: 'OPEN',
    state: 'WAITING',
    version: 2,
    companyId: 'co-1',
    site: { id: 'site-1', code: 'A1', name: 'Demo plant' },
    supplier: { id: 'sup-1', code: 'SUP-TAN', name: 'Conceria Demo Valdarno' },
    holding: { id: 'loc-hold', code: 'A1-HOLD', name: 'Goods without a PO' },
    supplierDdtNumber: '4512',
    supplierDdtDate: '2026-11-12',
    receivedAt: '2026-11-12T08:14:00.000Z',
    note: null,
    purchaseOrder: null,
    ddtPhotos: [{ id: 'f-1', originalName: 'GR-2026-0044-ddt.jpg' }],
  },
  lines: [
    { id: 'grl-9', seq: 10, item: { id: 'mat-lin', code: 'DEMO-LIN-140', name: 'Mesh lining 140 cm', baseUom: 'M', tracking: 'LOT' }, colour: { id: 'col-gry', code: 'GRY', name: 'Grey' }, quantity: '45.0000', uom: 'M', baseQuantity: '45.0000', hideCount: null, note: null },
    { id: 'grl-10', seq: 20, item: { id: 'mat-lea', code: 'DEMO-LEA-12', name: 'Cowhide 1.2 mm', baseUom: 'FT2', tracking: 'HIDE' }, colour: { id: 'col-blk', code: 'BLK', name: 'Black' }, quantity: '152.5000', uom: 'FT2', baseQuantity: '152.5000', hideCount: 3, note: null },
  ],
  buyerTask: { id: 't-1', title: 'Goods without a PO: GR-2026-0044 from Conceria Demo Valdarno', status: 'OPEN', dueDate: '2026-11-12', assignee: { id: 'u-buyer', name: 'Giulia Demo' } },
  orders: [
    {
      id: 'po-2',
      number: 'PO-2026-0019',
      status: 'CONFIRMED',
      version: 3,
      requestedDate: '2026-11-10',
      lines: [
        { id: 'pol-9', seq: 10, item: { id: 'mat-lin', code: 'DEMO-LIN-140', name: 'Mesh lining 140 cm', baseUom: 'M', tracking: 'LOT' }, colour: { id: 'col-gry', code: 'GRY', name: 'Grey' }, quantity: '100.0000', uom: 'M', openBase: '100.0000', tolerancePct: null },
        { id: 'pol-10', seq: 20, item: { id: 'mat-lea', code: 'DEMO-LEA-12', name: 'Cowhide 1.2 mm', baseUom: 'FT2', tracking: 'HIDE' }, colour: { id: 'col-blk', code: 'BLK', name: 'Black' }, quantity: '300.0000', uom: 'FT2', openBase: '300.0000', tolerancePct: '5' },
      ],
      fits: [
        { receiptLineId: 'grl-9', purchaseOrderLineIds: ['pol-9'] },
        { receiptLineId: 'grl-10', purchaseOrderLineIds: ['pol-10'] },
      ],
    },
    { id: 'po-3', number: 'PO-2026-0021', status: 'SENT', version: 2, requestedDate: '2026-11-30', lines: [], fits: [{ receiptLineId: 'grl-9', purchaseOrderLineIds: [] }, { receiptLineId: 'grl-10', purchaseOrderLineIds: [] }] },
  ],
  can: { decide: true, askBuyer: false },
}
const unplanned = UNPLANNED_DEMO
const waiting = (extra: Partial<WaitingModel> = {}, over: Partial<Unplanned> = {}): ReceptionCaseModel => ({ kind: 'waiting', model: { unplanned: { ...unplanned, ...over }, dialog: null, busy: false, problem: null, prefix: '/w/DEMO', timeZone: TZ, ...extra } })
const naming = namingFor(unplanned, 'po-2')

export const designScreen = defineDesignScreen<ReceptionCaseModel>({
  screen: 'SCR-379',
  title: 'Reception report and goods without a PO',
  view: ReceptionCase,
  cases: [
    { id: 'report', label: 'Reception report: what the goods serve', model: dialog(), note: 'Receipt ⋯ › Reception report. The plan\'s pegging first, then open work orders that need the material. Rows with something to take are chosen; a held row says why on its box.' },
    { id: 'report-work-orders', label: 'Only work orders chosen', model: dialog({ chosen: workOrdersOnly }) },
    { id: 'report-none-chosen', label: 'Nothing chosen (held)', model: dialog({ chosen: [] }) },
    { id: 'report-done', label: 'Reserved, buyer told', model: dialog({ done: { reserved: 3, skipped: 0, told: true }, chosen: [] }) },
    { id: 'report-refused', label: 'Refused: reserved meanwhile', model: dialog({ problem: phrase('reception.problem.refused') }) },
    { id: 'report-busy', label: 'Reserving', model: dialog({ busy: true }) },
    { id: 'report-read-only', label: 'Read-only (held with why)', model: { kind: 'report', number: report.receipt.number, model: { report: { status: 'ready', value: { ...report, can: { reserve: false, send: false } } }, chosen: [], tellBuyer: false, note: '', busy: false, problem: null, done: null, timeZone: TZ } } },
    { id: 'report-empty', label: 'Nothing waits for these goods', model: { kind: 'report', number: report.receipt.number, model: { report: { status: 'ready', value: { ...report, lines: report.lines.map((line) => ({ ...line, serves: [] })), proposals: 0, run: null } }, chosen: [], tellBuyer: true, note: '', busy: false, problem: null, done: null, timeZone: TZ } } },
    { id: 'report-not-posted', label: 'Not posted (held)', model: { kind: 'report', number: 'GR-2026-0044', model: { report: { status: 'ready', value: { ...report, held: 'NOT_POSTED', lines: [], proposals: 0, can: { reserve: false, send: false } } }, chosen: [], tellBuyer: false, note: '', busy: false, problem: null, done: null, timeZone: TZ } } },
    { id: 'report-loading', label: 'Loading', model: { kind: 'report', number: report.receipt.number, model: { report: { status: 'loading' }, chosen: [], tellBuyer: true, note: '', busy: false, problem: null, done: null, timeZone: TZ } } },
    { id: 'report-error', label: 'Error (Try again)', model: { kind: 'report', number: report.receipt.number, model: { report: { status: 'error', problem: 'reception.problem.offline' }, chosen: [], tellBuyer: true, note: '', busy: false, problem: null, done: null, timeZone: TZ } } },
    { id: 'waiting', label: 'Goods without a PO waiting', model: waiting(), note: 'On the receipt record: where they wait, since when, the buyer\'s task, nothing used until an order names them.' },
    { id: 'waiting-name', label: 'Name the purchase order', model: waiting({ dialog: { kind: 'name', draft: naming } }), note: 'The order that takes every line is picked; each line on the one line that fits it; leather needs each hide\'s area.' },
    { id: 'waiting-name-ready', label: 'Naming ready to post', model: waiting({ dialog: { kind: 'name', draft: { ...naming, lines: { ...naming.lines, 'grl-10': { purchaseOrderLineId: 'pol-10', supplierLotRef: 'TAN-77', hideAreas: '52.3 48.9\n51.3' } } } } }) },
    { id: 'waiting-name-refused', label: 'Naming refused: over tolerance', model: waiting({ dialog: { kind: 'name', draft: naming }, problem: phrase('waiting.problem.tolerance') }) },
    { id: 'waiting-back', label: 'Send back with the reason', model: waiting({ dialog: { kind: 'back', reason: 'Not ours: another customer\'s delivery' } }) },
    { id: 'waiting-no-order', label: 'No open order of the supplier yet', model: waiting({}, { orders: [] }) },
    { id: 'waiting-no-buyer', label: 'No buyer asked yet', model: waiting({}, { buyerTask: null, can: { decide: true, askBuyer: true } }) },
    { id: 'waiting-read-only', label: 'Read-only (held with why)', model: waiting({}, { can: { decide: false, askBuyer: false } }) },
    { id: 'waiting-named', label: 'Posted with its order', model: waiting({}, { receipt: { ...unplanned.receipt, status: 'POSTED', state: 'ORDER_NAMED', purchaseOrder: { id: 'po-2', number: 'PO-2026-0019' } } }) },
    { id: 'waiting-sent-back', label: 'Sent back', model: waiting({}, { receipt: { ...unplanned.receipt, status: 'CANCELLED', state: 'SENT_BACK', note: 'Sent back to the supplier (goods without a PO): Not ours' } }) },
  ],
})
