import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { SubcontractOrder } from '../api'
import { BUNDLES, canFor, CELLS, DDT_LIVE, inShell, kitLine, LOCATIONS, MATERIALS, order, OUTSIDE, panelsModel, PREFIX, STOCK, TIME_ZONE, TODAY, withoutFees, type RoleCase } from '../demo/fixtures'
import { words, type SubcontractCan } from '../model'
import { LOADING, NO_DDT, NO_KIT_LINE, ready, receiveDraftOf, sendDraftOf, sourcesFor, type RecordDialog, type SubcontractRecordModel } from './record-model'
import { SubcontractRecordView } from './view/SubcontractRecordView'

/**
 * SCR-128 record — a subcontract order (design purchasing.subcontracting "Record: Subcontract order") with made-up data
 * only: every state (a draft saving cell by cell, a draft held by a line without a fee, sent, in work with its kit DDT,
 * partly back and late, back, closed, cancelled), each tab with its content and its empty, loading and failed parts, each
 * dialog (send kit, its DDT held without shipping.ddt.issue, receive back, cancel, close, add operation, pieces per size,
 * add kit line, remove kit lines, take back a line, annul a DDT), the changed banner and the roles: Owner, Buyer,
 * Warehouse and Planner (no money: no fee anywhere), Read-only, Sales (no purchasing.view: the page says so).
 */

export interface RecordCase {
  role: RoleCase
  record: SubcontractRecordModel
}

function recordCase(role: RoleCase, value: SubcontractOrder, over: Partial<SubcontractRecordModel> = {}, can?: SubcontractCan): RecordCase {
  const rights = can ?? canFor(role)
  const shown = rights.cost ? value : withoutFees(value)
  return {
    role,
    record: {
      prefix: PREFIX,
      can: rights,
      tab: 'ops',
      order: { status: 'ready', value: shown },
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      marks: {},
      pdf: null,
      panelsPreview: panelsModel(value.id, value.number),
      timeZone: TIME_ZONE,
      today: TODAY,
      ...over,
    },
  }
}

const draft = order('DRAFT')
const noFee = order('DRAFT', { operations: draft.operations.map((entry, index) => (index === 1 ? { ...entry, pricePerPiece: '0.000000', netAmount: 0 } : entry)), actions: { ...draft.actions, issue: 'Line 20 (TAS) has no fee per piece: type it before the order goes to the workshop.' } })
const issued = order('ISSUED')
const atWorkshop = order('AT_WORKSHOP')
const partly = order('PARTLY_RECEIVED')
const received = order('RECEIVED')
const closed = order('CLOSED')
const cancelled = order('CANCELLED')
const PDF = samplePdf(['DDT 212/2026 - ESEMPIO', 'Officina Demo S.r.l. - documento di prova', 'Causale: conto lavorazione', 'Laboratorio Cuciture Demo', 'DEMO-FOD-02 Fodera rete traspirante  42,6 m  lotto LT-DEMO-FOD-11', 'DEMO-PRT-03 Protezione spalla livello 2  60 pz'])

const STOCK_ROWS = [
  { location: { id: LOCATIONS.sewing.id, code: 'N-STORE-01', name: 'Scaffale materiali 01' }, item: { id: MATERIALS.lining.id }, colour: { id: kitLine(1).colour!.id }, lot: { id: kitLine(1).lot!.id, code: kitLine(1).lot!.code, qualityStatus: 'RELEASED' }, hide: null, available: '180.0000' },
  { location: { id: 'demo-store-02', code: 'N-STORE-02', name: 'Scaffale materiali 02' }, item: { id: MATERIALS.lining.id }, colour: { id: kitLine(1).colour!.id }, lot: { id: 'demo-lot-2', code: 'LT-DEMO-FOD-12', qualityStatus: 'RELEASED' }, hide: null, available: '24.5000' },
  { location: { id: 'demo-store-03', code: 'N-STORE-03', name: 'Scaffale materiali 03' }, item: { id: MATERIALS.protector.id }, colour: null, lot: null, hide: null, available: '240.0000' },
]

function sendDialog(value: SubcontractOrder, can: SubcontractCan, filled: boolean): RecordDialog {
  const base = sendDraftOf(value, can)
  const sources = Object.fromEntries(value.kitLines.filter((line) => line.status === 'PLANNED').map((line) => [line.id, sourcesFor(STOCK_ROWS, line)]))
  return {
    kind: 'send',
    draft: {
      ...base,
      sources: ready(sources),
      lines: base.lines.map((line) => ({ ...line, source: filled ? (sources[line.lineId]?.[0]?.key ?? '') : '' })),
      bundles: can.workOrders ? ready(BUNDLES) : null,
      bundleIds: filled ? BUNDLES.slice(0, 3).map((bundle) => bundle.id) : [],
      ddt: filled && can.ddtIssue ? { ...NO_DDT, packages: '3', grossWeightKg: '18.5', appearance: 'Scatole di cartone' } : { ...NO_DDT, issue: can.ddtIssue },
    },
  }
}

function receiveDialog(value: SubcontractOrder, can: SubcontractCan, over: { good?: string; defective?: string; reason?: string } = {}): RecordDialog {
  const base = receiveDraftOf(value, TODAY, can)
  return {
    kind: 'receive',
    draft: {
      ...base,
      ddtNumber: 'LCD-95/26',
      ddtDate: TODAY,
      lines: base.lines.map((line, index) => (index === 0 ? { ...line, bundleId: can.workOrders ? BUNDLES[0]!.id : '', good: over.good ?? '3', defective: over.defective ?? '1', reason: over.reason ?? 'Cucitura tasca aperta' } : line)),
      bundles: can.workOrders ? ready(BUNDLES) : null,
      stock: ready(STOCK.rows.filter((row) => row.location.id === LOCATIONS.sewing.id)),
      returns: { [`${MATERIALS.lining.id}|${kitLine(1).colour!.id}|${kitLine(1).lot!.id}|`]: { quantity: '2.5', toLocationId: 'demo-store-01' } },
      locations: ready([
        { id: 'demo-store-01', code: 'N-STORE-01', name: 'Scaffale materiali 01' },
        { id: 'demo-store-02', code: 'N-STORE-02', name: 'Scaffale materiali 02' },
      ]),
    },
  }
}

const LINING_OPTION = { id: MATERIALS.lining.id, code: MATERIALS.lining.code, name: MATERIALS.lining.name, kind: 'LINING', tracking: 'LOT', baseUom: 'M', purchaseUom: 'M', defaultSupplier: null, requiresCrViTest: false, colourCount: 2, status: 'ACTIVE' }
const LINING_DETAIL = {
  ...LINING_OPTION,
  colours: [
    { id: kitLine(1).colour!.id, code: 'BLK', name: 'Nero', supplierColourCode: null, status: 'ACTIVE' },
    { id: 'demo-colour-grey', code: 'GRY', name: 'Grigio', supplierColourCode: null, status: 'ACTIVE' },
  ],
  units: { base: { uom: 'M', factor: '1', fixed: true }, purchase: { uom: 'M', factor: '1', fixed: true }, consumption: { uom: 'CM', factor: '0.01', fixed: true } },
}

const grid = (sizes: SubcontractOrder['operations'][number]['sizes']) => {
  const value: Record<string, Record<string, number>> = {}
  for (const size of sizes) value[size.colourway] = { ...(value[size.colourway] ?? {}), [size.size]: size.pieces }
  return value
}
const warehouse = canFor('warehouse')
const noDdtRight: SubcontractCan = { ...warehouse, ddtIssue: false, ddtCancel: false }

function RecordDesign({ model }: { model: RecordCase }) {
  const value = model.record.order.status === 'ready' ? model.record.order.value : null
  const path = `/purchasing/subcontracting/${value?.id ?? 'demo'}`
  return inShell(path, createElement(SubcontractRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-128-record',
  title: 'Subcontract order',
  view: RecordDesign,
  cases: [
    { id: 'draft', label: 'Draft: operations saving cell by cell, the fee and amount (buyer)', model: recordCase('buyer', draft, { marks: { [`${draft.operations[0]!.id}:pricePerPiece`]: { state: 'saved' }, [`${draft.operations[0]!.id}:expectedBackDate`]: { state: 'saving' } } }) },
    { id: 'draft-not-saved', label: 'Draft: a cell not saved, said beside it', model: recordCase('buyer', draft, { marks: { [`${draft.operations[1]!.id}:pricePerPiece`]: { state: 'failed', words: words('ops.cell.feeNumber') } } }) },
    { id: 'draft-no-fee', label: 'Draft held: a line without a fee (Send to the workshop says why)', model: recordCase('buyer', noFee) },
    { id: 'draft-empty', label: 'Draft with no operation yet', model: recordCase('buyer', order('DRAFT', { operations: [], kitLines: [], netAmount: 0, services: [], actions: { ...draft.actions, issue: 'no operation' } })) },
    { id: 'sizes', label: 'Pieces per size: the size grid editor', model: recordCase('buyer', draft, { dialog: { kind: 'sizes', draft: { operationId: draft.operations[0]!.id, cells: ready(CELLS), value: grid(draft.operations[0]!.sizes) } } }) },
    { id: 'sizes-loading', label: 'Pieces per size: the work order’s sizes loading', model: recordCase('buyer', draft, { dialog: { kind: 'sizes', draft: { operationId: draft.operations[0]!.id, cells: LOADING, value: {} } } }) },
    { id: 'add-operation', label: 'Add operation from the work order’s routing', model: recordCase('buyer', draft, { dialog: { kind: 'addOperation', draft: { outside: ready(OUTSIDE), operationId: OUTSIDE.operations[3]!.id, pieces: '0' } } }) },
    { id: 'add-operation-loading', label: 'Add operation: the routing loading', model: recordCase('buyer', draft, { dialog: { kind: 'addOperation', draft: { outside: LOADING, operationId: '', pieces: '' } } }) },
    { id: 'remove-operation', label: 'Remove an operation', model: recordCase('buyer', draft, { dialog: { kind: 'removeOperation', operationId: draft.operations[1]!.id } }) },
    { id: 'issued', label: 'Sent to the workshop: operations frozen, Back to draft while nothing is out', model: recordCase('buyer', issued) },
    { id: 'issued-kit', label: 'Sent: the kit to send (warehouse, no money)', model: recordCase('warehouse', issued, { tab: 'kit' }) },
    { id: 'kit-selection', label: 'Kit: planned lines selected, Remove N (buyer)', model: recordCase('buyer', issued, { tab: 'kit', selected: issued.kitLines.slice(0, 2).map((line) => line.id) }) },
    { id: 'kit-empty', label: 'Kit not sent yet: no kit line', model: recordCase('warehouse', order('ISSUED', { kitLines: [], kit: { state: 'NONE', planned: 0, sent: 0, cancelled: 0 } }), { tab: 'kit' }) },
    { id: 'add-kit-line', label: 'Add kit line: a material, its colour, the quantity', model: recordCase('buyer', issued, { tab: 'kit', dialog: { kind: 'kitLine', draft: { ...NO_KIT_LINE, query: 'fod', materials: [LINING_OPTION], material: LINING_DETAIL, itemColourId: kitLine(1).colour!.id, quantity: '12', uom: 'M' } } }) },
    { id: 'add-kit-line-search', label: 'Add kit line: nothing matches the search', model: recordCase('buyer', issued, { tab: 'kit', dialog: { kind: 'kitLine', draft: { ...NO_KIT_LINE, query: 'zzz', materials: [] } } }) },
    { id: 'remove-kit', label: 'Remove kit lines', model: recordCase('buyer', issued, { tab: 'kit', dialog: { kind: 'removeKit', lineIds: issued.kitLines.slice(0, 2).map((line) => line.id) } }) },
    { id: 'send', label: 'Send kit: from where, the pieces, the bundles and the DDT for work on our behalf', model: recordCase('warehouse', issued, { tab: 'kit', dialog: sendDialog(issued, warehouse, true) }) },
    { id: 'send-held', label: 'Send kit held: where each line leaves from not picked yet', model: recordCase('warehouse', issued, { tab: 'kit', dialog: sendDialog(issued, warehouse, false) }) },
    { id: 'send-no-ddt-right', label: 'Send kit without shipping.ddt.issue: the DDT held, the kit goes without one', model: recordCase('warehouse', issued, { tab: 'kit', dialog: sendDialog(issued, noDdtRight, true) }, noDdtRight) },
    { id: 'send-loading', label: 'Send kit: where the material is, loading', model: recordCase('warehouse', issued, { tab: 'kit', dialog: { kind: 'send', draft: { ...sendDraftOf(issued, warehouse), sources: LOADING } } }) },
    { id: 'send-refused', label: 'Send kit refused: a lot that is not released (in words)', model: recordCase('warehouse', issued, { tab: 'kit', dialog: sendDialog(issued, warehouse, true), dialogProblem: words('send.refused.lotNotReleased') }) },
    { id: 'at-workshop', label: 'In work: the kit sent with its DDT, a line still to send (warehouse)', model: recordCase('warehouse', atWorkshop, { tab: 'kit', notice: { tone: 'success', words: words('send.done.ddt', { number: DDT_LIVE.number }) } }) },
    { id: 'return-line', label: 'Take back a line: held while its DDT is live', model: recordCase('warehouse', atWorkshop, { tab: 'kit', dialog: { kind: 'returnLine', lineId: atWorkshop.kitLines[0]!.id, reason: '' } }) },
    { id: 'ops-at-workshop', label: 'In work: the counts per operation (owner, with costs)', model: recordCase('owner', atWorkshop) },
    { id: 'back', label: 'Partly back and late: receipts by bundle, unused material back', model: recordCase('warehouse', partly, { tab: 'back' }) },
    { id: 'back-empty', label: 'Nothing back yet — due on the return date', model: recordCase('warehouse', atWorkshop, { tab: 'back' }) },
    { id: 'receive', label: 'Receive back: per bundle, defective with the reason, lining returned', model: recordCase('warehouse', partly, { tab: 'back', dialog: receiveDialog(partly, warehouse) }) },
    { id: 'receive-held', label: 'Receive back held: more than is at the workshop', model: recordCase('warehouse', partly, { tab: 'back', dialog: receiveDialog(partly, warehouse, { good: '60', defective: '0', reason: '' }) }) },
    { id: 'received', label: 'Back: every piece is back, Close order', model: recordCase('buyer', received, { tab: 'back' }) },
    { id: 'close', label: 'Close the order', model: recordCase('buyer', received, { dialog: { kind: 'close', note: '' } }) },
    { id: 'closed', label: 'Closed', model: recordCase('buyer', closed) },
    { id: 'cancel', label: 'Cancel a sent order (the reason)', model: recordCase('buyer', issued, { dialog: { kind: 'cancel', reason: 'Il cliente ha spostato la consegna.' } }) },
    { id: 'cancelled', label: 'Cancelled, with its reason', model: recordCase('buyer', cancelled) },
    { id: 'documents', label: 'Documents: job sheet, the live kit DDT shown inline, an annulled one', model: recordCase('warehouse', partly, { tab: 'documents', pdf: { ddtId: DDT_LIVE.id, data: PDF, problem: null } }) },
    { id: 'documents-loading', label: 'Documents: the DDT’s PDF loading', model: recordCase('warehouse', atWorkshop, { tab: 'documents', pdf: { ddtId: DDT_LIVE.id, data: null, problem: null } }) },
    { id: 'documents-missing', label: 'Documents: the DDT issued, its PDF not stored — Print again', model: recordCase('warehouse', atWorkshop, { tab: 'documents', pdf: { ddtId: DDT_LIVE.id, data: null, problem: 'docs.pdf.missing' } }) },
    { id: 'documents-none', label: 'Documents of a draft: the job sheet only', model: recordCase('buyer', draft, { tab: 'documents' }) },
    { id: 'annul', label: 'Annul a kit DDT: the reason and its number typed', model: recordCase('warehouse', atWorkshop, { tab: 'documents', dialog: { kind: 'annul', ddtId: DDT_LIVE.id, reason: 'Colli sbagliati', typed: '212/2026' } }) },
    { id: 'activity', label: 'Activity: changes, messages and mails in one thread', model: recordCase('buyer', atWorkshop, { tab: 'activity' }) },
    { id: 'dock', label: 'The thread beside a tab (⌘J, wide screens)', model: recordCase('buyer', atWorkshop, { dockOpen: true }) },
    { id: 'changed', label: 'Changed by someone else while a dialog is open', model: recordCase('buyer', issued, { changed: { at: '2026-11-18T09:42:00.000Z' }, dialog: { kind: 'cancel', reason: '' } }) },
    { id: 'owner', label: 'Owner: everything, with costs', model: recordCase('owner', issued) },
    { id: 'planner', label: 'Planner: reads, no money, every act held with the permission', model: recordCase('planner', atWorkshop) },
    { id: 'read-only', label: 'Read-only: reads, nothing written', model: recordCase('readOnly', partly, { tab: 'back' }) },
    { id: 'sales', label: 'Sales: no purchasing.view — the page says so', model: recordCase('sales', issued) },
    { id: 'not-found', label: 'Not found (or another company’s)', model: recordCase('buyer', issued, { order: { status: 'not_found' } }) },
    { id: 'forbidden', label: 'Not this role’s workshop or site', model: recordCase('buyer', issued, { order: { status: 'forbidden' } }) },
    { id: 'loading', label: 'Loading', model: recordCase('buyer', issued, { order: { status: 'loading' }, live: 'connecting' }) },
    { id: 'error', label: "The order couldn't be read", model: recordCase('buyer', issued, { order: { status: 'error', problem: 'problem.offline' }, live: 'offline' }) },
  ],
})
