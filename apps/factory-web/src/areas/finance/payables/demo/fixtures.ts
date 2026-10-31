import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Candidates, InvoiceCounts, InvoiceLine, InvoiceMatch, InvoiceRow, InvoiceXml, SdiStatus, SupplierInvoice } from '../api'
import { payablesCanOf, type PayablesCan } from '../model'

/**
 * Made-up supplier invoices for the design cases of SCR-153 (Finance › Supplier invoices, the record, the XML as
 * received) and of the PO studio's Invoices tab: an invented company ("Officina Demo S.r.l."), invented suppliers
 * ("Conceria Demo S.r.l.", "Lederwerk Demo GmbH", "Laboratorio Demo s.n.c."), invented orders, receipts and numbers;
 * every figure worked out by hand (the sums are in the comments). Nothing here is a real company, supplier, article or
 * number. Design-only.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = Date.parse('2026-10-30T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = { id: DEMO_COMPANIES[0].id, code: 'DEMO', name: DEMO_COMPANIES[0].name }

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'payables.pay', 'money.cost', 'files.upload', 'purchasing.view'],
  /** Finance: registers, maps, accepts, approves, pays; sees costs. */
  finance: [...BASE, 'payables.view', 'payables.manage', 'payables.differences.accept', 'payables.approve', 'payables.pay', 'money.cost', 'files.upload'],
  /** Buyer: maps, accepts a difference in words; never approves or pays. */
  buyer: [...BASE, 'payables.view', 'payables.manage', 'payables.differences.accept', 'money.cost', 'purchasing.view'],
  /** Read-only: sees the invoices, no amount (no cost grain). */
  readonly: [...BASE, 'payables.view', 'purchasing.view'],
  /** Warehouse: no payables.view. */
  warehouse: [...BASE, 'inventory.stock.view', 'purchasing.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): PayablesCan => payablesCanOf(ROLES[role])

export function inShell(path: string, page: ReactNode, role: Role = 'finance'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const CONCERIA = { id: uid('4141', 1), code: 'SUP-CONC', name: 'Conceria Demo S.r.l.', country: 'IT' }
const LEDER = { id: uid('4141', 2), code: 'SUP-LEDER', name: 'Lederwerk Demo GmbH', country: 'DE' }
const LAB = { id: uid('4141', 3), code: 'SUB-LAB', name: 'Laboratorio Demo s.n.c.', country: 'IT' }
const PO_101 = uid('4242', 101)
const PO_LINE_10 = uid('4343', 10)
const PO_LINE_20 = uid('4343', 20)
const SCO_7 = uid('4444', 7)
export const INV_0412 = uid('4545', 412)
export const INV_0501 = uid('4545', 501)
export const INV_0398 = uid('4545', 398)
export const INV_DE77 = uid('4545', 77)
export const INV_LAB14 = uid('4545', 14)
export const INV_0350 = uid('4545', 350)
export const INV_0360 = uid('4545', 360)
export const INV_0420 = uid('4545', 420)

const row = (over: Partial<InvoiceRow> & Pick<InvoiceRow, 'id' | 'number' | 'supplier'>): InvoiceRow => ({
  company: COMPANY,
  source: 'SDI',
  kind: 'INVOICE',
  docType: 'TD01',
  issueDate: '2026-10-20',
  receivedOn: '2026-10-21',
  currency: 'EUR',
  netTotal: 0,
  vatTotal: 0,
  grossTotal: 0,
  status: 'RECEIVED',
  matchStatus: 'MATCHED',
  differencesToCheck: 0,
  approved: false,
  approvedAt: null,
  dueDate: '2026-11-30',
  paidOn: null,
  lines: 1,
  version: 1,
  createdAt: '2026-10-21T07:15:00.000Z',
  updatedAt: '2026-10-21T07:15:00.000Z',
  ...over,
})

/**
 * 2026/0412 (Conceria Demo, SDI): 105 FT2 leather at 4.30 = 451.50 + freight 15.00 = net 466.50; VAT 22 % 102.63; gross
 * 569.13. The order says 4.20/FT2: a difference of 105 × 0.10 = +10.50 waits to be accepted in words.
 * P2-2026-0501 (SDI): 24 protectors at 6.50 = 156.00; VAT 34.32; gross 190.32 — the goods have not arrived.
 * 2026/0398 (SDI): 200 FT2 at 4.20 = 840.00; VAT 184.80; gross 1,024.80 — matched, to approve.
 * DE-2026-77 (Lederwerk Demo, typed from its PDF): a service 1,200.00, VAT 0 (N2.1, reverse charge) — no PO.
 * LAB-2026-14 (Laboratorio Demo, SDI): 60 jackets stitched at 18.00 = 1,080.00; VAT 237.60; gross 1,317.60 — approved,
 * due 1 Nov (this week).
 * 2026/0350 (SDI): 300.00 + 66.00 = 366.00 — paid on 15 Oct. 2026/0360 (SDI): 90.00 + 19.80 = 109.80 — disputed.
 * 2026/0420 (SDI): a line not mapped yet (PENDING).
 */
export const ROWS: InvoiceRow[] = [
  row({
    id: INV_0420,
    number: '2026/0420',
    supplier: CONCERIA,
    issueDate: '2026-10-28',
    receivedOn: '2026-10-29',
    matchStatus: 'PENDING',
    netTotal: 25_000,
    vatTotal: 5_500,
    grossTotal: 30_500,
    dueDate: '2026-12-31',
  }),
  row({
    id: INV_0412,
    number: '2026/0412',
    supplier: CONCERIA,
    issueDate: '2026-10-24',
    receivedOn: '2026-10-25',
    matchStatus: 'DIFFERENCES',
    differencesToCheck: 1,
    netTotal: 46_650,
    vatTotal: 10_263,
    grossTotal: 56_913,
    lines: 2,
    dueDate: '2026-11-30',
  }),
  row({
    id: INV_0501,
    number: 'P2-2026-0501',
    supplier: CONCERIA,
    issueDate: '2026-10-26',
    receivedOn: '2026-10-27',
    matchStatus: 'WAITING_GOODS',
    netTotal: 15_600,
    vatTotal: 3_432,
    grossTotal: 19_032,
    dueDate: '2026-12-31',
  }),
  row({ id: INV_0398, number: '2026/0398', supplier: CONCERIA, issueDate: '2026-10-15', receivedOn: '2026-10-16', netTotal: 84_000, vatTotal: 18_480, grossTotal: 102_480, dueDate: '2026-11-15' }),
  row({
    id: INV_DE77,
    number: 'DE-2026-77',
    supplier: LEDER,
    source: 'MANUAL',
    docType: null,
    issueDate: '2026-10-22',
    receivedOn: '2026-10-23',
    matchStatus: 'NO_PO',
    netTotal: 120_000,
    vatTotal: 0,
    grossTotal: 120_000,
    dueDate: '2026-11-21',
  }),
  row({
    id: INV_LAB14,
    number: 'LAB-2026-14',
    supplier: LAB,
    issueDate: '2026-10-02',
    receivedOn: '2026-10-03',
    status: 'APPROVED',
    approved: true,
    approvedAt: '2026-10-20T09:10:00.000Z',
    netTotal: 108_000,
    vatTotal: 23_760,
    grossTotal: 131_760,
    dueDate: '2026-11-01',
    version: 3,
  }),
  row({
    id: INV_0360,
    number: '2026/0360',
    supplier: CONCERIA,
    issueDate: '2026-10-05',
    receivedOn: '2026-10-06',
    status: 'DISPUTED',
    matchStatus: 'DIFFERENCES',
    differencesToCheck: 1,
    netTotal: 9_000,
    vatTotal: 1_980,
    grossTotal: 10_980,
    dueDate: '2026-11-04',
    version: 2,
  }),
  row({
    id: INV_0350,
    number: '2026/0350',
    supplier: CONCERIA,
    issueDate: '2026-09-15',
    receivedOn: '2026-09-16',
    status: 'PAID',
    approved: true,
    approvedAt: '2026-10-01T08:00:00.000Z',
    netTotal: 30_000,
    vatTotal: 6_600,
    grossTotal: 36_600,
    dueDate: '2026-10-15',
    paidOn: '2026-10-15',
    version: 4,
  }),
]

/** New from SDI 3 (0420, 0501, 0412: received, not matched or not touched yet), differences 1, to approve 2 (0398, DE-77), due this week 1 (LAB-14). */
export const COUNTS: InvoiceCounts = { newFromSdi: 3, differences: 1, toApprove: 2, dueThisWeek: 1, weekEnds: '2026-11-01', readAt: '2026-10-30T08:40:00.000Z' }

export const SDI: SdiStatus = {
  companies: [
    {
      company: COMPANY,
      account: { id: uid('4646', 1), mode: 'FAKE', status: 'ACTIVE' },
      picksUp: true,
      lastPickup: { at: '2026-10-30T08:30:00.000Z', byPerson: false, listed: 4, recorded: 1, waiting: [] },
    },
  ],
}

const leatherLine = (over: Partial<InvoiceLine> = {}): InvoiceLine => ({
  id: uid('4747', 1),
  seq: 1,
  kind: 'GOODS',
  description: 'Pelle bovina nera 1,2 mm (demo)',
  itemCode: 'DEMO-ART-100',
  quantity: '105',
  uom: 'FT2',
  unitPrice: '4.3',
  discountPct: null,
  netAmount: 45_150,
  vatRatePct: '22',
  vatNature: null,
  siteId: uid('2222', 1),
  purchaseOrderLine: { id: PO_LINE_10, orderId: PO_101, orderNumber: 'PO-2026-0101', seq: 10, item: { code: 'DEMO-ART-100', name: 'Pelle bovina nera (demo)' }, quantity: '420', uom: 'FT2' },
  subcontractOrder: null,
  version: 2,
  ...over,
})

const baseDetail = (summary: InvoiceRow): SupplierInvoice => ({
  ...summary,
  sdiIdentifier: summary.source === 'SDI' ? `9${summary.number.replace(/\D/g, '').padStart(9, '0')}` : null,
  sdiFileName: summary.source === 'SDI' ? `IT00000002022_${summary.number.replace(/\D/g, '').slice(-5)}.xml` : null,
  withholdingAmount: null,
  stampDutyAmount: null,
  vatSummary: [{ rate: '22.00', nature: null, taxable: summary.netTotal ?? 0, vat: summary.vatTotal ?? 0 }],
  paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: summary.grossTotal ?? null, dueDate: summary.dueDate, iban: 'IT60X0542811101000000123456' }] },
  creditOf: null,
  credits: [],
  files: {
    xml: summary.source === 'SDI' ? { id: uid('4848', 1), originalName: 'fattura.xml', contentType: 'application/xml', sizeBytes: 4210, status: 'AVAILABLE', kind: 'FISCAL_ARCHIVE' } : null,
    pdf: { id: uid('4848', 2), originalName: 'fattura.pdf', contentType: 'application/pdf', sizeBytes: 81_200, status: 'AVAILABLE', kind: 'FISCAL_ARCHIVE' },
  },
  registeredBy: null,
  lines: [],
  matches: [],
  tolerance: {
    basis: 'RECEIVED',
    quantityTolerancePct: '0',
    priceTolerancePct: '0',
    decided: false,
    words: { en: 'Exact, on what was received: the tolerances are to be agreed with the accountant.', it: 'Esatto, su quanto ricevuto: le tolleranze sono da concordare con il commercialista.' },
  },
  approval: { approvedAt: null, approvedBy: null, note: null, ready: false, problems: [] },
  dispute: null,
  payment: { dueDate: summary.dueDate, paidOn: summary.paidOn, paymentRef: null },
  voided: null,
  internalNote: null,
  actions: {
    edit: 'It came through SDI: what it says never changes.',
    map: null,
    dispute: null,
    reopen: 'Only a disputed invoice is reopened.',
    withdraw: 'Only an approved invoice not paid yet has its approval withdrawn.',
    pay: 'It is received: an invoice is paid once approved.',
    void: 'It came through SDI: a fiscal document is never voided.',
  },
})

const match = (over: Partial<InvoiceMatch> & Pick<InvoiceMatch, 'id' | 'invoiceLineId' | 'lineSeq'>): InvoiceMatch => ({
  purchaseOrderLineId: PO_LINE_10,
  subcontractOrderId: null,
  order: { kind: 'PURCHASE_ORDER', id: PO_101, number: 'PO-2026-0101', lineSeq: 10, item: { code: 'DEMO-ART-100', name: 'Pelle bovina nera (demo)' } },
  receipt: { receiptLineId: uid('4949', 1), receiptId: uid('4949', 2), number: 'GR-2026-0031', supplierDdtNumber: 'DDT 812', supplierDdtDate: '2026-10-22' },
  unit: 'FT2',
  orderedQuantity: '420',
  orderedUnitPrice: '4.2',
  receivedQuantity: '105',
  invoicedQuantity: '105',
  invoicedUnitPrice: '4.2',
  differenceAmount: 0,
  quantityTolerancePct: '0',
  priceTolerancePct: '0',
  withinTolerance: true,
  verdict: 'WITHIN',
  words: { en: 'Matched', it: 'Corrisponde' },
  stale: false,
  accepted: null,
  version: 1,
  ...over,
})

const freight: InvoiceLine = leatherLine({
  id: uid('4747', 2),
  seq: 2,
  kind: 'CHARGE',
  description: 'Spese di trasporto (demo)',
  itemCode: null,
  quantity: null,
  uom: null,
  unitPrice: null,
  netAmount: 1_500,
  purchaseOrderLine: null,
  siteId: null,
})

/** 2026/0412: the price differs by +0.10/FT2 → +10.50 (105 × 0.10), not accepted yet: approval waits for it. */
export const DETAIL_0412: SupplierInvoice = {
  ...baseDetail(ROWS[1]!),
  lines: [leatherLine(), freight],
  matches: [
    match({
      id: uid('5050', 1),
      invoiceLineId: uid('4747', 1),
      lineSeq: 1,
      invoicedUnitPrice: '4.3',
      differenceAmount: 1_050,
      withinTolerance: false,
      verdict: 'DIFFERENCE',
      words: { en: 'Price differs +0.10/FT2', it: 'Prezzo diverso +0,10/FT2' },
    }),
  ],
  approval: { approvedAt: null, approvedBy: null, note: null, ready: false, problems: [{ code: 'DIFFERENCES', message: 'A difference outside the tolerance must be accepted in words.' }] },
}

/** The same, as a reader without the cost grain receives it: no amount, no price, words without prices. */
export const MATCH_WORDS_WITHOUT_COST: Readonly<Record<string, { en: string; it: string }>> = { [uid('5050', 1)]: { en: 'Price differs', it: 'Prezzo diverso' } }

/** P2-2026-0501: 24 protectors invoiced, nothing received yet (WAITING). */
export const DETAIL_0501: SupplierInvoice = {
  ...baseDetail(ROWS[2]!),
  lines: [
    leatherLine({
      id: uid('4747', 3),
      description: 'Paraspalla livello 2 (demo)',
      itemCode: 'DEMO-ART-300',
      quantity: '24',
      uom: 'PZ',
      unitPrice: '6.5',
      netAmount: 15_600,
      purchaseOrderLine: { id: PO_LINE_20, orderId: PO_101, orderNumber: 'PO-2026-0101', seq: 20, item: { code: 'DEMO-ART-300', name: 'Paraspalla (demo)' }, quantity: '24', uom: 'PZ' },
    }),
  ],
  matches: [
    match({
      id: uid('5050', 2),
      invoiceLineId: uid('4747', 3),
      lineSeq: 1,
      purchaseOrderLineId: PO_LINE_20,
      order: { kind: 'PURCHASE_ORDER', id: PO_101, number: 'PO-2026-0101', lineSeq: 20, item: { code: 'DEMO-ART-300', name: 'Paraspalla (demo)' } },
      receipt: null,
      unit: 'PZ',
      orderedQuantity: '24',
      orderedUnitPrice: '6.5',
      receivedQuantity: '0',
      invoicedQuantity: '24',
      invoicedUnitPrice: '6.5',
      differenceAmount: 15_600,
      withinTolerance: false,
      verdict: 'WAITING',
      words: { en: 'Waiting for goods: 0 PZ of 24 received', it: 'In attesa della merce: ricevuti 0 PZ su 24' },
    }),
  ],
  approval: { approvedAt: null, approvedBy: null, note: null, ready: false, problems: [{ code: 'WAITING_GOODS', message: 'The goods invoiced have not all arrived yet.' }] },
}

/** 2026/0398: matched, ready for approval. */
export const DETAIL_0398: SupplierInvoice = {
  ...baseDetail(ROWS[3]!),
  lines: [leatherLine({ id: uid('4747', 4), quantity: '200', unitPrice: '4.2', netAmount: 84_000 })],
  matches: [match({ id: uid('5050', 3), invoiceLineId: uid('4747', 4), lineSeq: 1, receivedQuantity: '200', invoicedQuantity: '200', stale: true })],
  approval: { approvedAt: null, approvedBy: null, note: null, ready: true, problems: [] },
}

/** DE-2026-77: typed by the person reading it (Alex Demo) from its PDF; a service without PO; someone else approves it. */
export const DETAIL_DE77: SupplierInvoice = {
  ...baseDetail(ROWS[4]!),
  vatSummary: [{ rate: '0.00', nature: 'N2.1', taxable: 120_000, vat: 0 }],
  paymentTerms: null,
  files: { xml: null, pdf: { id: uid('4848', 3), originalName: 'DE-2026-77.pdf', contentType: 'application/pdf', sizeBytes: 64_000, status: 'AVAILABLE', kind: 'FISCAL_ARCHIVE' } },
  registeredBy: { id: DEMO_USER.id, name: DEMO_USER.displayName },
  lines: [
    leatherLine({
      id: uid('4747', 5),
      kind: 'SERVICE',
      description: 'Rifinitura campioni (demo)',
      itemCode: null,
      quantity: '1',
      uom: 'PZ',
      unitPrice: '1200',
      netAmount: 120_000,
      vatRatePct: '0',
      vatNature: 'N2.1',
      purchaseOrderLine: null,
      siteId: null,
    }),
  ],
  approval: { approvedAt: null, approvedBy: null, note: null, ready: false, problems: [{ code: 'OWN_INVOICE', message: 'You entered this invoice, so someone else approves it.' }] },
  actions: { ...baseDetail(ROWS[4]!).actions, edit: null, void: null },
}

/** LAB-2026-14: the workshop's work on subcontract order SCO-2026-0007, approved, due 1 Nov. */
export const DETAIL_LAB14: SupplierInvoice = {
  ...baseDetail(ROWS[5]!),
  lines: [
    leatherLine({
      id: uid('4747', 6),
      kind: 'SUBCONTRACT',
      description: 'Cucitura giacche (demo)',
      itemCode: null,
      quantity: '60',
      uom: 'PZ',
      unitPrice: '18',
      netAmount: 108_000,
      purchaseOrderLine: null,
      subcontractOrder: { id: SCO_7, number: 'SCO-2026-0007', workOrderId: uid('5151', 1) },
    }),
  ],
  matches: [
    match({
      id: uid('5050', 4),
      invoiceLineId: uid('4747', 6),
      lineSeq: 1,
      purchaseOrderLineId: null,
      subcontractOrderId: SCO_7,
      order: { kind: 'SUBCONTRACT_ORDER', id: SCO_7, number: 'SCO-2026-0007', lineSeq: null, item: null },
      receipt: null,
      unit: 'PZ',
      orderedQuantity: '60',
      orderedUnitPrice: '18',
      receivedQuantity: '60',
      invoicedQuantity: '60',
      invoicedUnitPrice: '18',
    }),
  ],
  approval: {
    approvedAt: '2026-10-20T09:10:00.000Z',
    approvedBy: { id: uid('3333', 2), name: 'Sam Demo' },
    note: null,
    ready: false,
    problems: [{ code: 'NOT_RECEIVED', message: 'Invoice LAB-2026-14 is approved.' }],
  },
  actions: {
    ...baseDetail(ROWS[5]!).actions,
    map: 'It is approved: its lines are mapped while it is received or disputed.',
    dispute: 'It is approved: only a received invoice is disputed.',
    withdraw: null,
    pay: null,
  },
}

/** 2026/0350: paid on 15 Oct with the bank's reference. */
export const DETAIL_0350: SupplierInvoice = {
  ...baseDetail(ROWS[7]!),
  lines: [leatherLine({ id: uid('4747', 7), quantity: '71.4286', unitPrice: '4.2', netAmount: 30_000 })],
  matches: [match({ id: uid('5050', 5), invoiceLineId: uid('4747', 7), lineSeq: 1 })],
  approval: {
    approvedAt: '2026-10-01T08:00:00.000Z',
    approvedBy: { id: uid('3333', 2), name: 'Sam Demo' },
    note: null,
    ready: false,
    problems: [{ code: 'NOT_RECEIVED', message: 'Invoice 2026/0350 is paid.' }],
  },
  payment: { dueDate: '2026-10-15', paidOn: '2026-10-15', paymentRef: 'CRO 0000-DEMO-4411' },
  actions: { ...baseDetail(ROWS[7]!).actions, map: 'It is paid.', dispute: 'It is paid.', pay: 'It is paid.' },
}

/** 2026/0420: its line names no order yet (PENDING): the Match tab asks to choose the PO or mark it without PO. */
export const DETAIL_0420: SupplierInvoice = {
  ...baseDetail(ROWS[0]!),
  lines: [
    leatherLine({
      id: uid('4747', 8),
      description: 'Fodera tessuto (demo)',
      itemCode: 'DEMO-ART-200',
      quantity: '50',
      uom: 'M',
      unitPrice: '5',
      netAmount: 25_000,
      purchaseOrderLine: null,
      siteId: null,
    }),
  ],
  matches: [],
  approval: { approvedAt: null, approvedBy: null, note: null, ready: false, problems: [{ code: 'NOT_MATCHED', message: 'Map every goods line first.' }] },
}

export const CANDIDATES: Candidates = {
  purchaseOrderLines: [
    {
      id: PO_LINE_10,
      orderId: PO_101,
      orderNumber: 'PO-2026-0101',
      orderStatus: 'PARTLY_RECEIVED',
      seq: 10,
      siteId: uid('2222', 1),
      item: { code: 'DEMO-ART-100', name: 'Pelle bovina nera (demo)' },
      supplierArticleCode: 'C-100',
      quantity: '420',
      uom: 'FT2',
    },
    {
      id: PO_LINE_20,
      orderId: PO_101,
      orderNumber: 'PO-2026-0101',
      orderStatus: 'PARTLY_RECEIVED',
      seq: 20,
      siteId: uid('2222', 1),
      item: { code: 'DEMO-ART-300', name: 'Paraspalla (demo)' },
      supplierArticleCode: null,
      quantity: '24',
      uom: 'PZ',
    },
  ],
  subcontractOrders: [],
}

export const XML_0412: InvoiceXml = {
  fileName: 'IT00000002022_00412.xml',
  fileId: uid('4848', 1),
  xml: [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<p:FatturaElettronica versione="FPR12" xmlns:p="http://ivaservizi.agenziaentrate.gov.it/docs/xsd/fatture/v1.2">',
    '  <FatturaElettronicaHeader>',
    '    <CedentePrestatore><DatiAnagrafici><IdFiscaleIVA><IdPaese>IT</IdPaese><IdCodice>00000002022</IdCodice></IdFiscaleIVA>',
    '      <Anagrafica><Denominazione>Conceria Demo S.r.l.</Denominazione></Anagrafica></DatiAnagrafici></CedentePrestatore>',
    '  </FatturaElettronicaHeader>',
    '  <FatturaElettronicaBody>',
    '    <DatiGenerali><DatiGeneraliDocumento><TipoDocumento>TD01</TipoDocumento><Divisa>EUR</Divisa><Data>2026-10-24</Data><Numero>2026/0412</Numero></DatiGeneraliDocumento>',
    '      <DatiOrdineAcquisto><RiferimentoNumeroLinea>1</RiferimentoNumeroLinea><IdDocumento>PO-2026-0101</IdDocumento></DatiOrdineAcquisto>',
    '      <DatiDDT><NumeroDDT>DDT 812</NumeroDDT><DataDDT>2026-10-22</DataDDT></DatiDDT></DatiGenerali>',
    '    <DatiBeniServizi><DettaglioLinee><NumeroLinea>1</NumeroLinea><Descrizione>Pelle bovina nera 1,2 mm (demo)</Descrizione><Quantita>105.00</Quantita><PrezzoUnitario>4.30</PrezzoUnitario><PrezzoTotale>451.50</PrezzoTotale><AliquotaIVA>22.00</AliquotaIVA></DettaglioLinee></DatiBeniServizi>',
    '  </FatturaElettronicaBody>',
    '</p:FatturaElettronica>',
  ].join('\n'),
  read: {
    format: 'FPR12',
    supplier: { vatNumber: 'IT00000002022', fiscalCode: null, name: 'Conceria Demo S.r.l.' },
    buyer: { vatNumber: 'IT00000003038', fiscalCode: null, name: 'Officina Demo S.r.l.' },
    documents: [
      {
        docType: 'TD01',
        number: '2026/0412',
        issueDate: '2026-10-24',
        causale: ['Fornitura pelli ottobre (demo)'],
        orders: [{ document: 'PO-2026-0101', date: null, lines: [1] }],
        ddts: [{ number: 'DDT 812', date: '2026-10-22', lines: [1] }],
        lines: 2,
        attachments: ['fattura.pdf'],
      },
    ],
  },
}

const COST = new Set([
  'netTotal',
  'vatTotal',
  'grossTotal',
  'unitPrice',
  'netAmount',
  'orderedUnitPrice',
  'invoicedUnitPrice',
  'differenceAmount',
  'withholdingAmount',
  'stampDutyAmount',
  'vatSummary',
  'amount',
  'xml',
])

/** What the API sends a reader without the cost grain: every amount and price dropped; the match's words without prices. */
export function asSeenBy<T extends object>(value: T, can: Pick<PayablesCan, 'cost'>): T {
  if (can.cost) return value
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(strip)
    if (entry === null || typeof entry !== 'object') return entry
    const record = entry as Record<string, unknown>
    const out = Object.fromEntries(
      Object.entries(record)
        .filter(([key]) => !COST.has(key))
        .map(([key, inner]) => [key, strip(inner)]),
    )
    if (typeof record.id === 'string' && MATCH_WORDS_WITHOUT_COST[record.id]) out.words = MATCH_WORDS_WITHOUT_COST[record.id]
    return out
  }
  return strip(value) as T
}

export { CONCERIA, LEDER, LAB, PO_101 }
