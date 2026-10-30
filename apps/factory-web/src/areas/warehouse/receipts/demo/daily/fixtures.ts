import { documentRequestMail } from '@nexus/factory-domain/inventory/receipts/document-request'
import { samplePdf } from '../../../../_shared/document-send/sample-pdf'
import { at, COLOURS, MATERIALS, SUPPLIERS, uid, type Role } from '../../../../_shared/buying/fixtures'
import { ROLES } from '../../../../_shared/buying/fixtures'
import type { PickerReason } from '../../../../_shared/reasons/api'
import { blankDraft, emptyWizard } from '../../../../admin/import/model'
import { standInImporter, type SheetImport } from '../../../../products/styles/import/sheet-import'
import type { Discrepancy, HideListSummary, ReportCheck, RequestCheck, StoredPhoto } from '../../daily-api'
import { dailyCan, wantedDocuments, type ReceiptDailyCan } from '../../daily-model'
import type { ReceiptDailyModel } from '../../daily-state'
import { LOTS, receipt } from '../fixtures'

/**
 * Made-up data for the receipt's W2a parts (B-W2a-63) in the SCR-063 design cases: discrepancies "No. 10 … 40" of
 * GR-2026-0022 (short leather, a damaged hide with its photo, a wrong colour agreed, one closed), the DISCREPANCY and
 * CLAIM reason lists (the standard ones, plus a company's own "STAINS"), the report's check with two contacts of the
 * made-up tannery, its sample PDF, a hide list's totals and photos drawn as plain shapes. Nothing here is a real company,
 * person, address or number. Design-only; it exports no `designScreen`.
 */

/** The W2a permissions each role's real template holds (factory-domain auth/roles/templates.ts). */
const W2A: Record<Role, readonly string[]> = {
  owner: ['inventory.discrepancies.manage', 'inventory.discrepancies.report', 'inventory.receipts.documents.request', 'purchasing.claims.manage', 'purchasing.claims.return', 'email.send', 'imports.run', 'imports.apply', 'imports.view'],
  buyer: ['inventory.discrepancies.manage', 'inventory.discrepancies.report', 'inventory.receipts.documents.request', 'purchasing.claims.manage', 'email.send', 'imports.run', 'imports.apply', 'imports.view'],
  planner: [],
  // B-W2a-F4: the request for missing documents is its own permission; the warehouse still has no email.send.
  warehouse: ['inventory.discrepancies.manage', 'inventory.discrepancies.report', 'inventory.receipts.documents.request', 'purchasing.claims.manage', 'purchasing.claims.return', 'imports.run', 'imports.apply', 'imports.view'],
  sales: [],
  readOnly: ['imports.view'],
}
export const permissionsOf = (role: Role): string[] => [...ROLES[role], ...W2A[role]]
export const dailyCanOf = (role: Role): ReceiptDailyCan => dailyCan(permissionsOf(role))

const R = receipt()
const leatherLine = R.lines[0]!
const protectorLine = R.lines[1]!

/** A made-up photo: a plain shape drawn in SVG (no real picture). */
export const PHOTO_ADDRESS = `data:image/svg+xml;utf8,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="160" height="120" viewBox="0 0 160 120"><rect width="160" height="120" fill="#8a6a4f"/><ellipse cx="80" cy="60" rx="58" ry="40" fill="#6d4f38"/><circle cx="104" cy="48" r="9" fill="none" stroke="#f3e3c3" stroke-width="3"/></svg>')}`

const photo = (n: number, over: Partial<StoredPhoto> = {}): StoredPhoto => ({ id: uid('6801', n), originalName: `GR-2026-0022-${n}.jpg`, contentType: 'image/jpeg', sizeBytes: 182_000 + n, status: 'AVAILABLE', createdAt: at(29, 8, 40 + n), ...over })

const lineRef = (line: typeof leatherLine) => ({ id: line.id, seq: line.seq, purchaseOrderLineId: line.purchaseOrderLineId, item: { id: line.item.id, code: line.item.code, name: line.item.name, baseUom: line.item.baseUom }, colour: line.colour })

export const discrepancy = (n: number, over: Partial<Discrepancy> = {}): Discrepancy => ({
  id: uid('6701', n),
  receiptId: R.id,
  seq: n * 10,
  status: 'OPEN',
  kind: 'SHORT',
  reasonCode: 'SHORT',
  reason: { code: 'SHORT', labelIt: 'Quantità mancante', labelEn: 'Short', active: true },
  receiptLine: lineRef(leatherLine),
  quantity: '18.4000',
  uom: 'FT2',
  note: null,
  sentAt: null,
  sentById: null,
  closedAt: null,
  resolutionNote: null,
  photos: [],
  claims: [],
  version: 1,
  createdAt: at(29, 8, 35),
  createdById: uid('1111', 3),
  ...over,
})

export const DISCREPANCIES: Discrepancy[] = [
  discrepancy(1, { note: 'Two hides fewer than the delivery note says' }),
  discrepancy(2, { kind: 'DAMAGED', reasonCode: 'DAMAGED', reason: { code: 'DAMAGED', labelIt: 'Danneggiato', labelEn: 'Damaged', active: true }, quantity: '1.0000', uom: 'HIDE', note: 'Hole near the belly of tag HD-DEMO-001043-3', photos: [photo(1), photo(2)], version: 3 }),
  discrepancy(3, {
    status: 'AGREED',
    kind: 'WRONG_COLOUR',
    reasonCode: null,
    reason: null,
    receiptLine: lineRef(protectorLine),
    quantity: '4.0000',
    uom: 'PCS',
    note: 'Grey instead of black',
    sentAt: at(29, 10, 5),
    sentById: uid('1111', 3),
    claims: [{ id: uid('6901', 1), number: 'CLM-2026-0007', status: 'ACCEPTED' }],
    version: 4,
  }),
  discrepancy(4, { status: 'CLOSED', kind: 'MISSING_DOCUMENT', reasonCode: null, reason: null, receiptLine: null, quantity: null, uom: null, note: 'The LWG certificate was not with the goods', sentAt: at(29, 10, 5), closedAt: at(29, 15, 20), resolutionNote: 'Certificate arrived by e-mail the same day.', version: 5 }),
]

const reason = (list: 'DISCREPANCY' | 'CLAIM', code: string, labelIt: string, labelEn: string, sortOrder: number, needsDetail = false): PickerReason => ({ id: uid(list === 'CLAIM' ? '6902' : '6702', sortOrder), list, code, labelIt, labelEn, labelI18n: {}, icon: null, colour: null, needsDetail, sortOrder })

export const REASONS: PickerReason[] = [
  reason('DISCREPANCY', 'SHORT', 'Quantità mancante', 'Short', 1),
  reason('DISCREPANCY', 'OVER', 'Quantità in eccesso', 'Over', 2),
  reason('DISCREPANCY', 'WRONG_ITEM', 'Articolo errato', 'Wrong item', 3),
  reason('DISCREPANCY', 'DAMAGED', 'Danneggiato', 'Damaged', 4),
  reason('DISCREPANCY', 'STAINS', 'Macchie sul fiore', 'Stains on the grain', 5, true),
  reason('CLAIM', 'QUALITY', 'Difetto di qualità', 'Quality defect', 1),
  reason('CLAIM', 'SHORT_DELIVERY', 'Fornitura incompleta', 'Short delivery', 2),
  reason('CLAIM', 'WRONG_ITEM', 'Articolo errato', 'Wrong item', 3),
  reason('CLAIM', 'OTHER', 'Altro', 'Other', 4, true),
]

export const CHECK: ReportCheck = {
  ready: true,
  problems: [],
  discrepancyIds: [DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id],
  sendsIds: [DISCREPANCIES[0]!.id, DISCREPANCIES[1]!.id],
  recipients: [
    { contactId: uid('6061', 1), name: 'Ufficio qualità Demo', email: 'qualita@conceria-demo.example', roles: ['QUALITY'], language: 'it', suggested: true },
    { contactId: uid('6061', 2), name: 'Ufficio ordini Demo', email: 'ordini@conceria-demo.example', roles: ['ORDERS'], language: 'it', suggested: false },
  ],
  language: 'it',
  subject: 'Difformità della consegna GR-2026-0022 (vs. DDT DDT-DEMO-562)',
  message: 'Buongiorno, in allegato la segnalazione delle 2 difformità riscontrate alla consegna GR-2026-0022.',
}

export const REPORT_PDF = samplePdf(['ESEMPIO — Segnalazione difformità della consegna', 'Ricevimento GR-2026-0022 · DDT DDT-DEMO-562', 'N. 10 Quantità mancante · 18,4 ft²', 'N. 20 Danneggiato · 1 pelle', 'Nessun prezzo'])

/** The request's check (B-W2a-F4) for GR-2026-0022 without a DDT: the Cr VI report, the delivery note; the tannery's contacts. */
export const REQUEST_CHECK: RequestCheck = {
  ready: true,
  problems: [],
  receipt: { id: R.id, number: R.number, status: 'POSTED', supplierDdtNumber: null, supplierDdtDate: null },
  wanted: wantedDocuments({ supplierDdtNumber: null, ddtPhotos: [] }, LOTS),
  recipients: CHECK.recipients,
  language: 'it',
  ...documentRequestMail({ language: 'it', receiptNumber: R.number, supplierDdtNumber: null, supplierDdtDate: null, asked: wantedDocuments({ supplierDdtNumber: null, ddtPhotos: [] }, LOTS) }),
}

export const DDT_PHOTOS: StoredPhoto[] = [photo(9, { id: uid('6802', 1), originalName: 'GR-2026-0022-ddt.jpg' })]

export const PHOTO_ADDRESSES: Record<string, string> = Object.fromEntries([...DISCREPANCIES.flatMap((row) => row.photos), ...DDT_PHOTOS].map((entry) => [entry.id, PHOTO_ADDRESS]))

export function dailyModel(role: Role, over: Partial<ReceiptDailyModel> = {}): ReceiptDailyModel {
  return { can: dailyCanOf(role), discrepancies: { value: DISCREPANCIES, problem: null }, reasons: { value: REASONS, problem: null }, dialog: null, busy: false, problem: null, notice: null, open: null, photos: PHOTO_ADDRESSES, ddtStep: false, uploading: false, ...over }
}

// ---- the tannery hide list ------------------------------------------------------------------------------------------------------

export const HIDE_LIST_ID = uid('6990', 1)

export const hideListSummary = (over: Partial<HideListSummary> = {}): HideListSummary => ({
  importId: HIDE_LIST_ID,
  status: 'PLANNED',
  counts: { rows: 12, toReceive: 11, receivedBefore: 0, errors: 1 },
  order: { id: uid('5801', 3), number: 'PO-2026-0003', status: 'PARTLY_RECEIVED', siteId: R.siteId },
  lines: [
    { purchaseOrderLineId: uid('5803', 31), seq: 10, itemCode: MATERIALS.leather.code, baseUom: 'FT2', hides: 11, lots: 2, baseArea: '201.3000', expected: '420.0000', receivedBefore: '212.4000', after: '413.7000', difference: '-6.3000', tolerancePct: '5', upTo: '441.0000', kind: 'WITHIN_TOLERANCE', needsReason: false },
  ],
  receipt: null,
  ...over,
})

export function hideListSheet(company: { id: string; name: string }): SheetImport {
  return {
    wizard: emptyWizard(blankDraft('inventory.hideList', company.id, 'it')),
    importers: [standInImporter('inventory.hideList')],
    rights: { view: true, run: true, apply: true, people: false },
    companies: [company],
  }
}

/** The receipt's own counts of the made-up discrepancies (the band's tab count and dot). */
export const DISCREPANCY_COUNTS = { count: DISCREPANCIES.length, open: DISCREPANCIES.filter((row) => row.status !== 'CLOSED').length, unsent: DISCREPANCIES.filter((row) => row.status === 'OPEN').length }

export { COLOURS, SUPPLIERS, LOTS }
