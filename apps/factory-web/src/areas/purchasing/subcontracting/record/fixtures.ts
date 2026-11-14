import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import type { SubcontractOrder } from '../api'
import { BUNDLES, canFor, CELLS, DDT_LIVE, inShell, kitLine, LOCATIONS, MATERIALS, order, OUTSIDE, panelsModel, PREFIX, STOCK, TIME_ZONE, TODAY, withoutFees, type RoleCase } from '../demo/fixtures'
import { words, type SubcontractCan } from '../model'
import { LOADING, NO_DDT, NO_KIT_LINE, ready, receiveDraftOf, sendDraftOf, sourcesFor, type RecordDialog, type SubcontractRecordModel } from './record-model'
import { SubcontractRecordView } from './view/SubcontractRecordView'
// B-W2b-344: the written terms link, the Material balance and Cost tabs (../depth), with made-up data.
import type { OrderBalance, OrderCost, OrderTerms } from '../depth/api'
import { BALANCE_BACK, BALANCE_NOTHING_SENT, BALANCE_PARTLY, COST, COST_DRAFT, COST_NONE, COST_OTHER_CURRENCY, COST_WITH_INVOICES, costWithoutMoney, depthFor, termsOf } from '../depth/fixtures'
import { adjustDraftOf, bookDraftOf, declareDraftOf, type BalanceModel, type CostModel, type DepthCan, type TermsModel } from '../depth/model'
import { BalanceTabView } from '../depth/view/BalanceTabView'
import { CostTabView } from '../depth/view/CostTabView'
import { TermsLinkView } from '../depth/view/TermsLinkView'

/**
 * SCR-128 record — a subcontract order (design purchasing.subcontracting "Record: Subcontract order") with made-up data
 * only: every state (a draft saving cell by cell, a draft held by a line without a fee, sent, in work with its kit DDT,
 * partly back and late, back, closed, cancelled), each tab with its content and its empty, loading and failed parts, each
 * dialog (send kit, its DDT held without shipping.ddt.issue, receive back, cancel, close, add operation, pieces per size,
 * add kit line, remove kit lines, take back a line, annul a DDT), the changed banner and the roles: Owner, Buyer,
 * Warehouse and Planner (no money: no fee anywhere), Read-only, Sales (no purchasing.view: the page says so). B-W2b-344's
 * cases (`w2b-344-*`): the written terms link on Operations & quantities, the Material balance and the Cost tabs.
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

// ---- B-W2b-344: the written terms link, the Material balance and Cost tabs ----------------------------------------------------

type Read<T> = { status: 'loading' } | { status: 'ready'; value: T } | { status: 'error'; problem: string }
const readyOf = <T,>(value: T): Read<T> => ({ status: 'ready', value })

function termsCase(role: RoleCase, value: SubcontractOrder, terms: Read<OrderTerms>, over: Partial<TermsModel> = {}): RecordCase {
  const model: TermsModel = { terms, can: depthFor(role), problem: null, timeZone: TIME_ZONE, ...over }
  return recordCase(role, value, { tab: 'ops', depth: { terms: createElement(TermsLinkView, { model }) } })
}

function balanceCase(role: RoleCase, value: SubcontractOrder, balance: Read<OrderBalance>, over: Partial<BalanceModel> = {}): RecordCase {
  const model: BalanceModel = { balance, can: depthFor(role), workOrder: value.workOrder.number, busy: false, dialog: null, problem: null, notice: null, timeZone: TIME_ZONE, ...over }
  return recordCase(role, value, { tab: 'balance', depth: { balance: createElement(BalanceTabView, { model }) } })
}

function costCase(role: RoleCase, value: SubcontractOrder, cost: Read<OrderCost>, over: Partial<CostModel> = {}): RecordCase {
  const can = over.can ?? depthFor(role)
  const shown: Read<OrderCost> = cost.status === 'ready' && !can.cost ? { status: 'ready', value: costWithoutMoney(cost.value) } : cost
  const model: CostModel = { cost: shown, can, receipts: value.receipts.map((receipt, index) => ({ id: receipt.id, seq: index + 1, receivedAt: receipt.receivedAt })), busy: false, dialog: null, problem: null, notice: null, timeZone: TIME_ZONE, ...over }
  return recordCase(role, value, { tab: 'cost', depth: { cost: createElement(CostTabView, { model }) } })
}

const noFiles = (role: RoleCase): DepthCan => ({ ...depthFor(role), files: false })
const lining = BALANCE_BACK.lines[0]!
const declareFilled = declareDraftOf(BALANCE_PARTLY)
const transport = { ...bookDraftOf(COST), unitPrice: '35', reason: 'Ritiro dei capi con il corriere del terzista.' }
const fee = { ...bookDraftOf(COST, 'FEE'), quantity: '3', unitPrice: '6.50', receiptId: COST.entries[0]!.receipt!.id, reason: 'Fattura del terzista: prezzo concordato.' }

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
    // B-W2b-344: the written terms link (Operations & quantities).
    { id: 'w2b-344-terms', label: 'B-W2b-344 · Written terms: revision 2 signed, covers the order’s date, Download (buyer)', model: termsCase('buyer', atWorkshop, readyOf(termsOf('covered'))) },
    { id: 'w2b-344-terms-ending', label: 'B-W2b-344 · Written terms in force end in 22 days', model: termsCase('buyer', atWorkshop, readyOf(termsOf('ending'))) },
    { id: 'w2b-344-terms-superseded', label: 'B-W2b-344 · An older order: covered by revision 1, replaced since', model: termsCase('buyer', closed, readyOf(termsOf('superseded'))) },
    { id: 'w2b-344-terms-draft', label: 'B-W2b-344 · No signed terms cover the order: revision 1 waits for its signature (the law beside it)', model: termsCase('buyer', issued, readyOf(termsOf('draft'))) },
    { id: 'w2b-344-terms-none', label: 'B-W2b-344 · No terms written with this workshop yet', model: termsCase('buyer', draft, readyOf(termsOf('none'))) },
    { id: 'w2b-344-terms-other-days', label: 'B-W2b-344 · The signed terms cover other days', model: termsCase('buyer', issued, readyOf(termsOf('otherDays'))) },
    { id: 'w2b-344-terms-no-file', label: 'B-W2b-344 · Covered, but no signed file kept: Download held with why', model: termsCase('buyer', atWorkshop, readyOf(termsOf('noFile'))) },
    { id: 'w2b-344-terms-no-right', label: 'B-W2b-344 · A role without files.read: Download held with the permission', model: termsCase('planner', atWorkshop, readyOf(termsOf('covered')), { can: noFiles('planner') }) },
    { id: 'w2b-344-terms-refused', label: 'B-W2b-344 · Download refused: the file is no longer there', model: termsCase('buyer', atWorkshop, readyOf(termsOf('covered')), { problem: words('terms.fileGone') }) },
    { id: 'w2b-344-terms-loading', label: 'B-W2b-344 · Written terms loading (the slow note after a second)', model: termsCase('buyer', atWorkshop, { status: 'loading' }, { slow: true }) },
    { id: 'w2b-344-terms-error', label: 'B-W2b-344 · Written terms couldn’t be read (never drawn as “no terms”)', model: termsCase('buyer', atWorkshop, { status: 'error', problem: 'problem.offline' }) },
    // B-W2b-344: the Material balance tab.
    { id: 'w2b-344-balance', label: 'B-W2b-344 · Material balance, partly back: the lining counted short, not declared, 3.4 m back; protectors declared (warehouse)', model: balanceCase('warehouse', partly, readyOf(BALANCE_PARTLY)) },
    { id: 'w2b-344-balance-back', label: 'B-W2b-344 · Every piece back: 2.7 m of lining still out (flagged), the declaration and an adjustment with who and why (buyer)', model: balanceCase('buyer', received, readyOf(BALANCE_BACK)) },
    { id: 'w2b-344-balance-declare', label: 'B-W2b-344 · Book the workshop’s declaration: prefilled from the goods back, naming receipt 1, what moves', model: balanceCase('warehouse', partly, readyOf(BALANCE_PARTLY), { dialog: { kind: 'declare', draft: declareFilled } }) },
    { id: 'w2b-344-balance-declare-held', label: 'B-W2b-344 · The declaration held: more than is still open on line 10', model: balanceCase('warehouse', partly, readyOf(BALANCE_PARTLY), { dialog: { kind: 'declare', draft: { ...declareFilled, lines: declareFilled.lines.map((entry, index) => (index === 0 ? { ...entry, used: '45' } : entry)) } } }) },
    { id: 'w2b-344-balance-declare-refused', label: 'B-W2b-344 · The declaration refused: a closed accounting period (in words)', model: balanceCase('warehouse', partly, readyOf(BALANCE_PARTLY), { dialog: { kind: 'declare', draft: declareFilled }, problem: words('balance.refused.period') }) },
    // B-W2b-408 (follow-up GL1:01): a soft-locked month asks why the booking goes in anyway.
    { id: 'w2b-408-balance-declare-soft-lock', label: 'B-W2b-408 · The declaration refused: the month is soft-locked, so it asks why it goes in anyway', model: balanceCase('warehouse', partly, readyOf(BALANCE_PARTLY), { dialog: { kind: 'declare', draft: { ...declareFilled, lockReason: '' } }, problem: words('balance.refused.periodSoft') }) },
    { id: 'w2b-408-balance-adjust-soft-lock', label: 'B-W2b-408 · The adjustment with its reason for the soft-locked month (kept in the audit trail)', model: balanceCase('buyer', received, readyOf(BALANCE_BACK), { dialog: { kind: 'adjust', draft: { ...adjustDraftOf(lining.kitLineId), scrapped: '0.5', reason: 'Ritagli scartati dal terzista.', lockReason: 'Bolla del terzista arrivata dopo la chiusura del mese.' } } }) },
    { id: 'w2b-344-balance-adjust', label: 'B-W2b-344 · Book over- or under-consumption: +2.2 m used, +0.5 m scrapped, the line before and after, what moves', model: balanceCase('buyer', received, readyOf(BALANCE_BACK), { dialog: { kind: 'adjust', draft: { ...adjustDraftOf(lining.kitLineId), used: '2.2', scrapped: '0.5', reason: 'Il terzista ha usato 2,2 m in più per due giacche rifatte; 0,5 m di ritagli scartati.' } } }) },
    { id: 'w2b-344-balance-adjust-held', label: 'B-W2b-344 · The adjustment held: no reason yet', model: balanceCase('buyer', received, readyOf(BALANCE_BACK), { dialog: { kind: 'adjust', draft: { ...adjustDraftOf(lining.kitLineId), used: '-0.5' } } }) },
    { id: 'w2b-344-balance-booked', label: 'B-W2b-344 · Booked: the notice says how many stock moves followed', model: balanceCase('buyer', received, readyOf(BALANCE_BACK), { notice: { tone: 'success', words: words('balance.booked', { count: 2 }) } }) },
    { id: 'w2b-344-balance-empty', label: 'B-W2b-344 · Nothing sent yet: the balance starts with the kit (declaration held)', model: balanceCase('buyer', issued, readyOf(BALANCE_NOTHING_SENT)) },
    { id: 'w2b-344-balance-planner', label: 'B-W2b-344 · Planner: reads the balance, every booking held with the permission', model: balanceCase('planner', received, readyOf(BALANCE_BACK)) },
    { id: 'w2b-344-balance-loading', label: 'B-W2b-344 · Material balance loading (the slow note)', model: balanceCase('buyer', partly, { status: 'loading' }, { slow: true }) },
    { id: 'w2b-344-balance-error', label: 'B-W2b-344 · Material balance couldn’t be read, Try again', model: balanceCase('buyer', partly, { status: 'error', problem: 'problem.offline' }) },
    // B-W2b-344: the Cost tab.
    { id: 'w2b-344-cost', label: 'B-W2b-344 · Cost to the work order: the bridge, per operation, charges (one taken back), the workshop’s invoice (owner)', model: costCase('owner', received, readyOf(COST_WITH_INVOICES)) },
    { id: 'w2b-344-cost-buyer', label: 'B-W2b-344 · Cost for the buyer: books and takes back charges; the workshop’s invoice (payables.view)', model: costCase('buyer', received, readyOf(COST_WITH_INVOICES)) },
    { id: 'w2b-344-cost-warehouse', label: 'B-W2b-344 · Cost for the warehouse: pieces only, no price or amount drawn, booking held, no invoice section (no payables.view)', model: costCase('warehouse', received, readyOf(COST)) },
    { id: 'w2b-344-cost-empty', label: 'B-W2b-344 · No cost yet — booked when goods come back', model: costCase('buyer', atWorkshop, readyOf(COST_NONE)) },
    { id: 'w2b-344-cost-currency', label: 'B-W2b-344 · An order in another currency: nothing posts on the work order yet (in words)', model: costCase('buyer', received, readyOf(COST_OTHER_CURRENCY)) },
    { id: 'w2b-344-cost-book', label: 'B-W2b-344 · Book a charge: transport 1 × 35.00 onto WO-DEMO-0101', model: costCase('buyer', received, readyOf(COST), { dialog: { kind: 'book', draft: transport } }) },
    { id: 'w2b-344-cost-book-fee', label: 'B-W2b-344 · Book a fee at the workshop’s price: 3 pieces of line 10 at 6.50, paid once', model: costCase('buyer', received, readyOf(COST), { dialog: { kind: 'book', draft: fee } }) },
    { id: 'w2b-344-cost-book-held', label: 'B-W2b-344 · Book a charge held: another charge says what it is for', model: costCase('buyer', received, readyOf(COST), { dialog: { kind: 'book', draft: { ...bookDraftOf(COST, 'OTHER'), unitPrice: '12' } } }) },
    { id: 'w2b-344-cost-book-refused', label: 'B-W2b-344 · Book a fee refused: more pieces than are back good (in words)', model: costCase('buyer', received, readyOf(COST), { dialog: { kind: 'book', draft: fee }, problem: words('cost.refused.bookable') }) },
    { id: 'w2b-344-cost-reverse', label: 'B-W2b-344 · Take a charge back: its reason, −35.00 on the work order', model: costCase('buyer', received, readyOf(COST), { dialog: { kind: 'reverse', entryId: COST.entries[1]!.id, reason: 'Il trasporto era a carico del terzista.' } }) },
    { id: 'w2b-344-cost-booked', label: 'B-W2b-344 · Booked: the notice', model: costCase('buyer', received, readyOf(COST), { notice: { tone: 'success', words: words('cost.done.booked', { kind: '@cost.kind.TRANSPORT' }) } }) },
    { id: 'w2b-344-cost-draft', label: 'B-W2b-344 · A draft: its work costs nothing, Book a charge held', model: costCase('buyer', draft, readyOf(COST_DRAFT)) },
    { id: 'w2b-344-cost-loading', label: 'B-W2b-344 · Cost loading (the slow note)', model: costCase('buyer', received, { status: 'loading' }, { slow: true }) },
    { id: 'w2b-344-cost-error', label: 'B-W2b-344 · Cost couldn’t be read, Try again', model: costCase('buyer', received, { status: 'error', problem: 'problem.offline' }) },
  ],
})
