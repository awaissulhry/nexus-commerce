import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import type { Shipment } from '../api'
import {
  at,
  backorder,
  canOf,
  evidence,
  freight,
  PACKING_LISTS,
  pricedFor,
  toGermany,
  trackingLabelled,
  voidedOf,
  DDT_ANNULLED,
  DDT_LIVE,
  DDT_ROW,
  documents,
  draftLoose,
  inShell,
  labelled,
  labels,
  LINKS,
  ownVan,
  panelsModel,
  PDF,
  PREFIX,
  PREVIEW_HELD,
  PREVIEW_OK,
  READY,
  SAMPLE_PDF,
  serialShipment,
  shipment,
  tracking,
  type Role,
} from '../_demo/fixtures'
import { ddtFormFor } from '../model'
import type { ShipmentRecordModel } from './record-model'
import { ShipmentRecordView } from './view/ShipmentRecordView'

/**
 * SCR-067 — a shipment (design warehouse.shipments "Record: Shipment") with made-up data only: every tab (Lines &
 * cartons with "Ready to ship", Documents with the DDT draft → issued → annulled, the Declaration of Conformity and the
 * user information, the customer's link; Carrier & label; Tracking & delivery; Activity), the states (loading, error,
 * not found, no permission, held with the reason, read-only, cancelled, shipped, changed meanwhile), each dialog (Issue
 * DDT, Annul DDT with the typed number, Buy labels and its outcome, Mark handed over, Cancel, Change delivery, Add
 * garments, a carton, Send the link), and the roles: Owner, Warehouse, Sales and Finance (read-only). B-W2a-71 (every
 * day): the order's lines and the backorder (partial, complete, a line closed short), Other documents (the packing list's
 * versions), Void labels (held, open, one parcel the carrier has, the outcome), the DDT reason with its hint, the Invoice
 * tab (the freight by the rule, by hand, not decided, without the price grain, Change freight), the Export tab (not
 * needed in Italy, awaited, partial, complete; File a paper, Mark complete, Reopen, Needs no evidence) and Finance with
 * the freight and the evidence rights.
 */

interface RecordCase {
  role: Role
  record: ShipmentRecordModel
}

const base = (role: Role, input: Shipment, over: Partial<ShipmentRecordModel> = {}): RecordCase => {
  const can = canOf(role)
  const value = pricedFor(input, role)
  // Gone with a DDT (shipped, delivered, returned); a PACKED case names its DDT itself (packedWithDdt).
  const live = value.status === 'SHIPPED' || value.status === 'DELIVERED' || value.status === 'RETURNED'
  return {
    role,
    record: {
      prefix: PREFIX,
      can,
      tab: 'lines',
      shipment: { status: 'ready', value },
      ddts: { value: live ? [DDT_ROW] : [], problem: null },
      ddt: live ? { value: DDT_LIVE, problem: null } : null,
      pdf: live ? { data: PDF, problem: null, sample: false } : value.status === 'PACKED' ? { data: SAMPLE_PDF, problem: null, sample: true } : null,
      preview: live ? null : { value: value.status === 'DRAFT' ? PREVIEW_HELD : PREVIEW_OK, problem: null },
      labels: can.pack ? { value: labels(value), problem: null } : null,
      tracking: value.parcels.some((entry) => entry.trackingNumber) ? { value: tracking(value, value.status === 'DELIVERED'), problem: null } : null,
      documents: { value: documents(value.status === 'DRAFT' ? 'onFile' : 'attached', value.status === 'SHIPPED' || value.status === 'DELIVERED' ? LINKS : []), problem: null },
      ready: value.status === 'DRAFT' && can.manage ? { value: READY[0]!, problem: null } : null,
      backorder: { value: backorder(), problem: null },
      packingLists: { value: value.status === 'DRAFT' || value.status === 'CANCELLED' ? [] : PACKING_LISTS, problem: null },
      evidence: { value: evidence(value.transportEvidence.status), problem: null },
      voided: null,
      live: 'live',
      dockOpen: false,
      changed: null,
      notice: null,
      busy: false,
      dialog: null,
      dialogProblem: null,
      ddtForm: ddtFormFor(value, PREVIEW_OK),
      bought: null,
      sent: null,
      panelsPreview: panelsModel(),
      ...over,
    },
  }
}

const packed = shipment('PACKED')
const packedWithDdt = (role: Role, over: Partial<ShipmentRecordModel> = {}) => base(role, packed, { ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null }, preview: null, pdf: { data: PDF, problem: null, sample: false }, ...over })
const ready = labelled('PACKED')
const readyCase = (role: Role, over: Partial<ShipmentRecordModel> = {}) => base(role, ready, { ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null }, preview: null, pdf: { data: PDF, problem: null, sample: false }, labels: { value: labels(ready, 'PRINTED'), problem: null }, ...over })
const shipped = labelled('SHIPPED')
const delivered = { ...labelled('DELIVERED'), deliveredAt: at(30, 11, 42) }
// B-W2a-71: labels bought, none collected yet (the carrier has no parcel): Void labels may run.
const voidCase = (role: Role, over: Partial<ShipmentRecordModel> = {}) => readyCase(role, { tab: 'carrier', tracking: { value: trackingLabelled(ready), problem: null }, ...over })
const germanCase = (role: Role, status: 'AWAITED' | 'PARTIAL' | 'COMPLETE', over: Partial<ShipmentRecordModel> = {}) =>
  base(role, { ...toGermany('DELIVERED', status), deliveredAt: at(2, 11, 42, 11) }, { tab: 'export', ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null }, evidence: { value: evidence(status), problem: null }, ...over })

function ShipmentDesign({ model }: { model: RecordCase }) {
  return inShell('/warehouse/shipments', createElement(ShipmentRecordView, { model: model.record }), model.role)
}

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-067',
  title: 'A shipment (Warehouse): lines and cartons, the DDT, the carrier label, tracking, documents',
  view: ShipmentDesign,
  cases: [
    { id: 'draft', label: 'Draft being packed (Warehouse): Ready to ship lists what is open; Mark packed held with the count', model: base('warehouse', draftLoose()), note: 'Change a quantity, put a line in a carton, weigh a carton. ⌘↵ runs the next step when nothing holds it.' },
    { id: 'draft-ready', label: 'Draft packed in weighed cartons: Mark packed', model: base('warehouse', shipment('DRAFT', { packingProblems: [], parcels: shipment('PACKED').parcels, lines: shipment('PACKED').lines })) },
    { id: 'serials', label: 'A serial-tracked style: the serials on the shipment', model: base('warehouse', serialShipment()) },
    { id: 'packed', label: 'Packed: the next step is Issue DDT (d)', model: base('warehouse', packed) },
    { id: 'docs-draft', label: 'Documents: the DDT draft with every field, the number it would take, the SAMPLE PDF', model: base('warehouse', packed, { tab: 'documents' }) },
    { id: 'docs-held', label: 'Documents: the draft with its checks open (held "Issue DDT · 2 checks")', model: base('warehouse', shipment('DRAFT'), { tab: 'documents', pdf: { data: null, problem: 'docs.pdf.draftHeld', sample: true } }) },
    { id: 'issue-dialog', label: 'Issue DDT: "Number 158/2026 is taken and kept for 10 years"', model: base('warehouse', packed, { dialog: { kind: 'issueDdt' } }) },
    { id: 'issue-own-van', label: 'Issue DDT for our own van: issue and hand over together', model: base('warehouse', ownVan(), { dialog: { kind: 'issueDdt' }, ddtForm: { ...ddtFormFor(ownVan(), PREVIEW_OK), ship: true } }) },
    { id: 'issue-refused', label: 'Issue DDT refused by the API (said inside the dialog, what was typed stays)', model: base('warehouse', packed, { dialog: { kind: 'issueDdt' }, dialogProblem: { words: { key: 'problem.write.state' }, detail: 'The shipment has a live DDT already.' } }) },
    { id: 'issued', label: 'DDT issued: frozen, its PDF from the fiscal archive; next step Buy labels (l)', model: packedWithDdt('warehouse', { tab: 'documents' }) },
    { id: 'annul-dialog', label: 'Annul DDT 158/2026: a reason and the number typed', model: packedWithDdt('warehouse', { tab: 'documents', dialog: { kind: 'annulDdt', ddtId: DDT_LIVE.id } }) },
    { id: 'annulled', label: 'An annulled DDT keeps its number; the draft of the new one', model: base('warehouse', packed, { tab: 'documents', ddts: { value: [DDT_ANNULLED], problem: null } }) },
    { id: 'docs-missing', label: 'Documents: no DoC or user information on file (the goods cannot leave)', model: packedWithDdt('warehouse', { tab: 'documents', documents: { value: documents('missing'), problem: null } }) },
    { id: 'docs-fallback', label: 'Documents: the user information travels in English (warning)', model: packedWithDdt('warehouse', { tab: 'documents', documents: { value: documents('fallback'), problem: null } }) },
    { id: 'carrier', label: 'Carrier & label: Buy 2 labels', model: packedWithDdt('warehouse', { tab: 'carrier' }) },
    { id: 'carrier-held', label: 'Carrier & label before the DDT: Buy labels held ("Issue the DDT first")', model: base('warehouse', packed, { tab: 'carrier' }) },
    { id: 'buy-dialog', label: 'Buy labels: outside the building, the account is charged', model: packedWithDdt('warehouse', { tab: 'carrier', dialog: { kind: 'buyLabels' } }) },
    { id: 'buy-partial', label: 'Buy labels: parcel 2 refused by the carrier (partial)', model: packedWithDdt('warehouse', { tab: 'carrier', dialog: { kind: 'buyLabels' }, bought: { ...labels({ ...packed, parcels: [ready.parcels[0]!, packed.parcels[1]!] }), outcomes: [{ parcelId: packed.parcels[0]!.id, seq: 1, ok: true }, { parcelId: packed.parcels[1]!.id, seq: 2, ok: false, problem: 'The carrier refuses 31.5 kg for this service.' }], problem: 'Parcel 2 still needs its label.' } }) },
    { id: 'labels', label: 'Labels bought and printed: Mark handed over', model: readyCase('warehouse', { tab: 'carrier' }) },
    { id: 'labels-failed', label: 'A label print failed (said with its word, never colour alone)', model: readyCase('warehouse', { tab: 'carrier', labels: { value: labels(ready, 'FAILED'), problem: null } }) },
    { id: 'ready', label: 'Ready to hand over: every check green', model: readyCase('warehouse') },
    { id: 'hand-over', label: 'Mark handed over', model: readyCase('warehouse', { dialog: { kind: 'handOver' } }) },
    { id: 'link-dialog', label: 'Send the document link to the customer\'s contacts', model: readyCase('warehouse', { tab: 'documents', dialog: { kind: 'sendLink' } }) },
    { id: 'shipped', label: 'Shipped: tracking in transit; the link sent when the goods left', model: base('warehouse', shipped, { tab: 'tracking' }) },
    { id: 'shipped-docs', label: 'Shipped: the documents attached and the links (one withdrawn)', model: base('warehouse', shipped, { tab: 'documents' }) },
    { id: 'delivered', label: 'Delivered: the carrier\'s events and the proof of delivery', model: base('owner', delivered, { tab: 'tracking' }) },
    { id: 'own-van', label: 'Own van: no carrier label, Issue DDT and hand over together', model: base('warehouse', ownVan(), { tab: 'carrier' }) },
    { id: 'cancelled', label: 'Cancelled (with its reason)', model: base('warehouse', shipment('CANCELLED', { lines: [], parcels: [], garments: 0 })) },
    { id: 'add-lines', label: 'Add garments to the draft (from what the order can still ship)', model: base('warehouse', draftLoose(), { dialog: { kind: 'addLines' } }) },
    { id: 'carton', label: 'A carton: weight and size', model: base('warehouse', draftLoose(), { dialog: { kind: 'parcel', parcelId: draftLoose().parcels[1]!.id } }) },
    { id: 'cancel-dialog', label: 'Cancel shipment', model: base('warehouse', draftLoose(), { dialog: { kind: 'cancel' } }) },
    { id: 'delivery-dialog', label: 'Change delivery', model: base('warehouse', packed, { dialog: { kind: 'delivery' } }) },
    { id: 'sales', label: 'Sales: read-only (no labels view), the order linked', model: readyCase('sales') },
    { id: 'finance', label: 'Finance: read-only, shipped', model: base('finance', shipped, { tab: 'documents' }) },
    { id: 'owner-dock', label: 'Owner with the thread beside the tab (⌘J, wide screens)', model: readyCase('owner', { dockOpen: true }) },
    { id: 'activity', label: 'Activity: the record panels', model: readyCase('warehouse', { tab: 'activity' }) },
    { id: 'changed', label: 'Changed by someone else while a dialog was open: Reload', model: readyCase('warehouse', { changed: { at: at(29, 11, 20) } }) },
    { id: 'notice', label: 'A refused write said above the tab', model: base('warehouse', draftLoose(), { notice: { tone: 'danger', words: { key: 'problem.write.state' }, detail: 'Parcel 2 holds garments: move them first.' } }) },
    { id: 'part-failed', label: 'A part could not be read (Documents): in words with Try again', model: base('warehouse', packed, { tab: 'documents', documents: { value: null, problem: 'problem.read.unavailable' } }) },
    // ---- B-W2a-71 (every day) ----
    { id: 'backorder-partial', label: 'Lines: the order on this shipment, 2 garments stay on backorder (1 ready, 1 to make)', model: base('warehouse', packed) },
    { id: 'backorder-complete', label: 'Lines: this shipment completes the order', model: base('warehouse', packed, { backorder: { value: backorder('complete'), problem: null } }) },
    { id: 'backorder-closed', label: 'Lines: a line closed short (its rest never ships)', model: base('warehouse', packed, { backorder: { value: backorder('closed'), problem: null } }) },
    { id: 'backorder-failed', label: 'Lines: the backorder could not be read (Try again)', model: base('warehouse', packed, { backorder: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'other-documents', label: 'Documents: Other documents — the packing list\'s versions, Print all (the driver\'s pack)', model: packedWithDdt('warehouse', { tab: 'documents' }) },
    { id: 'other-none', label: 'Documents: no packing list made yet', model: packedWithDdt('warehouse', { tab: 'documents', packingLists: { value: [], problem: null } }) },
    { id: 'issue-reason', label: 'Issue DDT: the reason Repair with its hint', model: base('warehouse', packed, { dialog: { kind: 'issueDdt' }, ddtForm: { ...ddtFormFor(packed, PREVIEW_OK), reason: 'REPAIR' } }) },
    { id: 'void-menu', label: 'Carrier & label: labels bought, Labels ⋯ Void labels', model: voidCase('warehouse') },
    { id: 'void-dialog', label: 'Void labels: "voiding one parcel voids all 2 parcels"', model: voidCase('warehouse', { dialog: { kind: 'voidLabels' } }) },
    { id: 'void-collected', label: 'Void labels: the carrier has parcel 2 already (its label stays)', model: voidCase('warehouse', { dialog: { kind: 'voidLabels' }, tracking: { value: trackingLabelled(ready, [2]), problem: null } }) },
    { id: 'void-done', label: 'Void labels: the outcome per parcel (cancelled, queued)', model: voidCase('warehouse', { dialog: { kind: 'voidLabels' }, voided: voidedOf(ready) }) },
    { id: 'void-partial', label: 'Void labels: the carrier refused parcel 2 (it keeps its label)', model: voidCase('warehouse', { dialog: { kind: 'voidLabels' }, voided: voidedOf(ready, 2) }) },
    { id: 'void-held', label: 'Sales: Void labels held (no right), shown in the menu', model: voidCase('sales') },
    { id: 'invoice-rule', label: 'Invoice: the freight by the site\'s rule (7,00 € a parcel), shipped', model: base('finance', shipped, { tab: 'invoice', ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null } }) },
    { id: 'invoice-open', label: 'Invoice: freight not decided yet (the rule sets it when the goods leave)', model: base('finance', packed, { tab: 'invoice' }) },
    { id: 'invoice-hand', label: 'Invoice: the freight typed by hand (Owner)', model: base('owner', { ...shipped, freight: freight(900, { byHand: true }) }, { tab: 'invoice', ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null } }) },
    { id: 'invoice-collects', label: 'Invoice: the customer collects (no freight)', model: base('finance', { ...ownVan(), transportBy: 'RECIPIENT', freight: freight(null, { byRule: { charge: 0, basis: 'CUSTOMER_COLLECTS', words: '' } }) }, { tab: 'invoice' }) },
    { id: 'invoice-no-price', label: 'Invoice: Warehouse without the price grain (no amount, never 0)', model: base('warehouse', shipped, { tab: 'invoice', ddts: { value: [DDT_ROW], problem: null }, ddt: { value: DDT_LIVE, problem: null } }) },
    { id: 'freight-dialog', label: 'Change freight: type 9,00 €, or back to the rule', model: base('finance', { ...shipped, freight: freight(900, { byHand: true }) }, { tab: 'invoice', dialog: { kind: 'freight' } }) },
    { id: 'export-italy', label: 'Export: delivered in Italy — not needed', model: base('warehouse', shipped, { tab: 'export' }) },
    { id: 'export-awaited', label: 'Export: a zero-rated sale to Germany, the proof awaited (File a paper)', model: germanCase('warehouse', 'AWAITED') },
    { id: 'export-partial', label: 'Export: one paper on file (proof of delivery), a second one missing', model: germanCase('warehouse', 'PARTIAL') },
    { id: 'export-complete', label: 'Export: complete (POD and signed CMR), checked by finance', model: germanCase('finance', 'COMPLETE') },
    { id: 'export-before', label: 'Export: packed for Germany, decided when the goods leave', model: base('warehouse', toGermany('PACKED', 'NOT_NEEDED'), { tab: 'export', evidence: { value: evidence('NOT_NEEDED', { neededBySale: true, shipmentStatus: 'PACKED' }), problem: null } }) },
    { id: 'export-sales', label: 'Export: Sales reads it (no evidence right: held)', model: germanCase('sales', 'PARTIAL') },
    { id: 'export-failed', label: 'Export: the evidence could not be read (Try again)', model: germanCase('warehouse', 'AWAITED', { evidence: { value: null, problem: 'problem.read.unavailable' } }) },
    { id: 'paper-dialog', label: 'File a paper: its kind and the file', model: germanCase('warehouse', 'PARTIAL', { dialog: { kind: 'evidenceFile' } }) },
    { id: 'complete-dialog', label: 'Mark complete: the person checks the papers are independent', model: germanCase('finance', 'PARTIAL', { dialog: { kind: 'evidenceComplete' }, evidence: { value: evidence('PARTIAL', { papers: evidence('COMPLETE').papers }), problem: null } }) },
    { id: 'complete-short', label: 'Mark complete held: one paper only', model: germanCase('finance', 'PARTIAL', { dialog: { kind: 'evidenceComplete' } }) },
    { id: 'reopen-dialog', label: 'Reopen the evidence (a paper found wrong)', model: germanCase('finance', 'COMPLETE', { dialog: { kind: 'evidenceReopen' } }) },
    { id: 'need-dialog', label: 'Needs no evidence (with the reason)', model: germanCase('finance', 'AWAITED', { dialog: { kind: 'evidenceNeed', needed: false } }) },
    { id: 'loading', label: 'Loading', model: base('warehouse', packed, { shipment: { status: 'loading' } }) },
    { id: 'not-found', label: 'Not found (or another company)', model: base('warehouse', packed, { shipment: { status: 'not_found' } }) },
    { id: 'no-permission', label: 'No permission', model: base('warehouse', packed, { shipment: { status: 'forbidden' } }) },
    { id: 'error', label: 'The read failed: Try again', model: base('warehouse', packed, { shipment: { status: 'error', problem: 'problem.read.unavailable' } }) },
  ],
})
