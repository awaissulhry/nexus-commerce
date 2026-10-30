import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../lib/session/session'
import { designScreen as panelsScreen } from '../../../record-panels/fixtures'
import type { RecordPanelsViewModel } from '../../../record-panels/model'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Checks, FinanceSettings, Invoice, InvoiceLine, InvoiceRow, OpenItem, Payment, PaymentRow, Queue, Related, Sdi } from '../_shared/api'
import { abilitiesOf, type FinanceAbilities } from '../_shared/model'

/**
 * Made-up invoices, payments and settings for the design cases of SCR-080 … SCR-083 (the Finance screens): an invented
 * company ("Officina Demo S.r.l."), customers ("Moto Demo S.r.l.", "Esempio Racing S.p.A.", "Squadra Fittizia S.r.l."),
 * style "DEMO-JKT-01", people ("Fiona Conti", "Sara Vendite") and numbers, every figure worked out by hand: order
 * SO-2026-0088 = 8 × 450 + 6 × 440 = 6,240.00 net, VAT 22 % 1,372.80, gross 7,612.80; its deposit 30 % of the gross =
 * 2,283.84 (TD02 FT-2026-00028: 1,872.00 + 411.84 VAT); the final TD01 FT-2026-00031 = 6,240.00 − 1,872.00 = 4,368.00
 * taxable, VAT 960.96, to pay 5,328.96. Nothing here is a real company, person, invoice or number. Design-only (only
 * fixtures and tests import it); it exports no `designScreen`, so the design index skips it.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-29'
export const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = DEMO_COMPANIES[0].id

// ---- roles ------------------------------------------------------------------------------------------------------------------

const COMMON = ['home.view', 'threads.read', 'threads.post', 'files.read', 'files.upload']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, ...COMMON, 'parties.view', 'orders.view', 'invoices.view', 'invoices.manage', 'invoices.issue', 'payments.view', 'payments.record', 'payments.void', 'companies.view', 'companies.manage', 'companies.bank.view', 'companies.bank.manage', 'integrations.view', 'numbering.view', 'money.price', 'money.cost', 'money.margin', 'email.send'],
  finance: [...COMMON, 'parties.view', 'orders.view', 'orders.close', 'invoices.view', 'invoices.manage', 'invoices.issue', 'payments.view', 'payments.record', 'payments.void', 'companies.bank.view', 'companies.bank.manage', 'numbering.view', 'money.price', 'money.cost', 'money.margin', 'email.send'],
  /** Sales see invoices and payments with their prices and change nothing here (S2: never cost). */
  sales: [...COMMON, 'parties.view', 'orders.view', 'invoices.view', 'payments.view', 'money.price', 'money.margin', 'email.send'],
} as const
export type Role = keyof typeof ROLES
export const canOf = (role: Role): FinanceAbilities => abilitiesOf(ROLES[role])

/** The Office shell around a page at this address (the role's navigation). */
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

/** What an answer holds for a role without the price grain: no amount at all (absent, never zero). */
export function withoutPrices<T>(value: T): T {
  const drop = new Set(['unitPrice', 'netAmount', 'grossAmount', 'netTotal', 'vatTotal', 'grossTotal', 'vatSummary', 'stampDutyAmount', 'paymentTerms', 'paidAmount', 'creditedAmount', 'openAmount', 'refundDueAmount', 'amount', 'allocated', 'unallocated', 'valueAmount', 'depositPaidAmount'])
  const walk = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(walk)
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).filter(([key]) => !drop.has(key)).map(([key, inner]) => [key, walk(inner)]))
    return item
  }
  return walk(value) as T
}

// ---- parties, orders, DDTs -----------------------------------------------------------------------------------------------------

export const PARTIES = [
  { id: uid('6666', 1), code: 'C-0001', name: 'Moto Demo S.r.l.' },
  { id: uid('6666', 2), code: 'C-0002', name: 'Esempio Racing S.p.A.' },
  { id: uid('6666', 3), code: 'C-0003', name: 'Squadra Fittizia S.r.l.' },
] as const
export const CUSTOMER = PARTIES[0]
export const ORDER = { id: uid('5151', 88), number: 'SO-2026-0088' }
export const ORDER_LINES = [uid('5252', 1), uid('5252', 2)] as const
export const DDT = { id: uid('7171', 144), number: '144/2026', date: '2026-10-27', shipmentId: uid('7272', 2), shipmentNumber: 'SH-2026-0002' }
export const DEPOSIT_REQUEST_ID = uid('4343', 12)

// ---- invoices -----------------------------------------------------------------------------------------------------------------

export const TD01_ID = uid('8181', 31)
export const TD02_ID = uid('8181', 28)
export const TD04_ID = uid('8181', 33)

const vatLine = (over: Partial<InvoiceLine>): InvoiceLine => ({
  id: uid('8282', 1),
  seq: 1,
  kind: 'GOODS',
  description: 'DEMO-JKT-01 Giacca Demo - Nero, taglia 50',
  itemCode: 'DEMO-JKT-01-BLK-50',
  quantity: '8.0000',
  uom: 'PZ',
  unitPrice: '450.000000',
  discountPct: null,
  netAmount: 360000,
  grossAmount: null,
  vatRatePct: '22.00',
  vatNature: null,
  vatLegalRef: null,
  salesOrderLineId: ORDER_LINES[0],
  size: '50',
  ddtId: DDT.id,
  depositInvoiceId: null,
  ...over,
})

export const TD01_LINES: InvoiceLine[] = [
  vatLine({}),
  vatLine({ id: uid('8282', 2), seq: 2, description: 'DEMO-JKT-01 Giacca Demo - Nero, taglia 52', itemCode: 'DEMO-JKT-01-BLK-52', quantity: '6.0000', unitPrice: '440.000000', netAmount: 264000, salesOrderLineId: ORDER_LINES[1], size: '52' }),
  vatLine({ id: uid('8282', 3), seq: 3, kind: 'DEPOSIT_DEDUCTION', description: 'Detrazione acconto fattura n. FT-2026-00028 del 15/10/2026', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '-1872.000000', netAmount: -187200, grossAmount: -228384, salesOrderLineId: null, size: null, ddtId: null, depositInvoiceId: TD02_ID }),
]

const base: Invoice = {
  id: TD01_ID,
  version: 3,
  companyId: COMPANY,
  buyerPartyId: CUSTOMER.id,
  party: { code: CUSTOMER.code, legalName: CUSTOMER.name },
  docType: 'TD01',
  status: 'DRAFT',
  number: null,
  year: null,
  issueDate: null,
  issuedAt: null,
  currency: 'EUR',
  priceBasis: 'NET',
  billTo: { name: CUSTOMER.name, kind: 'IT_BUSINESS' },
  netTotal: 436800,
  vatTotal: 96096,
  grossTotal: 532896,
  vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 436800, vat: 96096, rounding: 0 }],
  stampDutyAmount: null,
  paymentTerms: { condition: 'TP02', installments: [{ method: 'MP05', amount: 532896, dueDate: '2026-11-28', iban: 'IT60X0542811101000000123456' }] },
  causale: null,
  documentRefs: [{ kind: 'PURCHASE_ORDER', number: 'PO-ESEMPIO-88' }],
  salesOrderId: ORDER.id,
  depositRequestId: null,
  creditOfId: null,
  xmlFileId: null,
  pdfFileId: null,
  filesPending: false,
  internalNote: null,
  paidAmount: 0,
  creditedAmount: 0,
  openAmount: 0,
  refundDueAmount: 0,
  lines: TD01_LINES,
  createdAt: at(29, 9),
  updatedAt: at(29, 9, 5),
}

/** The final invoice of the order in each state. */
export function invoice(status: Invoice['status'], over: Partial<Invoice> = {}): Invoice {
  const issued = status !== 'DRAFT'
  return {
    ...base,
    status,
    ...(issued ? { number: 'FT-2026-00031', year: 2026, issueDate: TODAY, issuedAt: at(29, 10, 2), xmlFileId: uid('9191', 1), pdfFileId: uid('9191', 2), openAmount: 532896 } : {}),
    ...over,
  }
}

export const TD02: Invoice = {
  ...base,
  id: TD02_ID,
  docType: 'TD02',
  status: 'DELIVERED',
  number: 'FT-2026-00028',
  year: 2026,
  issueDate: '2026-10-15',
  issuedAt: at(15, 9),
  priceBasis: 'GROSS',
  netTotal: 187200,
  vatTotal: 41184,
  grossTotal: 228384,
  vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 187200, vat: 41184, rounding: 0 }],
  causale: 'Fattura di acconto: pagamento ricevuto il 15/10/2026 (art. 6 c.4 DPR 633/1972)',
  depositRequestId: DEPOSIT_REQUEST_ID,
  salesOrderId: ORDER.id,
  xmlFileId: uid('9191', 3),
  pdfFileId: uid('9191', 4),
  paymentTerms: null,
  lines: [vatLine({ id: uid('8282', 9), description: 'Acconto 30% su ordine n. SO-2026-0088 del 12/10/2026', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '2283.840000', netAmount: 187200, grossAmount: 228384, salesOrderLineId: null, size: null, ddtId: null })],
}

/** A credit note of the final invoice: 50.00 + VAT off the price (abbuono). */
export const TD04: Invoice = {
  ...base,
  id: TD04_ID,
  docType: 'TD04',
  status: 'DRAFT',
  creditOfId: TD01_ID,
  netTotal: 5000,
  vatTotal: 1100,
  grossTotal: 6100,
  vatSummary: [{ rate: '22.00', nature: null, legalRef: null, taxable: 5000, vat: 1100, rounding: 0 }],
  paymentTerms: null,
  causale: 'Nota di credito: Riduzione di prezzo (abbuono) - rif. fattura n. FT-2026-00031 del 29/10/2026 (art. 26 DPR 633/1972)',
  lines: [vatLine({ id: uid('8282', 20), description: 'Abbuono su fattura FT-2026-00031', itemCode: null, quantity: '1.0000', uom: null, unitPrice: '50.000000', netAmount: 5000, salesOrderLineId: null, size: null, ddtId: null })],
}

/** An export invoice (N3.1, no Italian VAT) for the "Why no VAT?" popover. */
export const EXPORT_LINES: InvoiceLine[] = [vatLine({ vatRatePct: '0.00', vatNature: 'N3.1', vatLegalRef: 'Operazione non imponibile art. 8 c.1 lett. a) DPR 633/1972 - esportazione' })]

export const CHECKS_READY: Checks = { ready: true, problems: [], numberPreview: 'FT-2026-00031', issueDate: TODAY }
export const CHECKS_FAIL: Checks = {
  ready: false,
  problems: [
    { code: 'PARTY_WARNING', path: 'party/sdiCode', message: 'The customer has no SDI code or PEC.' },
    { code: 'FATTURAPA', path: 'lines/1/description', message: 'holds a character FatturaPA cannot carry.' },
  ],
  numberPreview: 'FT-2026-00031',
  issueDate: TODAY,
}

export const RELATED: Related = {
  ddts: [DDT],
  depositInvoices: [{ id: TD02_ID, number: 'FT-2026-00028', issueDate: '2026-10-15', status: 'DELIVERED', depositRequestId: DEPOSIT_REQUEST_ID }],
  creditOf: null,
  creditNotes: [],
  payments: [],
  orders: [ORDER],
  depositRequests: [
    {
      id: DEPOSIT_REQUEST_ID,
      orderId: ORDER.id,
      kind: 'ACCONTO',
      depositPct: '30',
      currency: 'EUR',
      amount: 228384,
      paidAmount: 228384,
      dueDate: '2026-10-19',
      fiscalDocument: 'TD02',
      status: 'PAID',
      paidAt: at(15, 8, 30),
      depositInvoices: [{ id: TD02_ID, number: 'FT-2026-00028', status: 'DELIVERED', issueDate: '2026-10-15' }],
    },
  ],
}

export const BALANCE_PAYMENT_ID = uid('3131', 42)
export const RELATED_PAID: Related = {
  ...RELATED,
  payments: [{ allocationId: uid('3232', 1), paymentId: BALANCE_PAYMENT_ID, externalRef: 'CRO-0000-ESEMPIO-91', receivedOn: TODAY, paymentStatus: 'RECEIVED', amount: 532896, reversalOfId: null, reversed: false, note: null, createdAt: at(29, 15) }],
  creditNotes: [{ id: TD04_ID, number: 'NC-2026-00002', issueDate: TODAY, status: 'SENT', grossTotal: 6100 }],
}

// ---- SDI ----------------------------------------------------------------------------------------------------------------------

const SEND_1 = { id: uid('9292', 1), attempt: 1, fileName: 'IT01234567890_0001A.xml', createdAt: at(29, 10, 3), failure: null }

export function sdi(kind: 'notSent' | 'sending' | 'atSdi' | 'delivered' | 'notDelivered' | 'rejected' | 'resent' | 'error' | 'draft', over: Partial<Sdi> = {}): Sdi {
  const status = { draft: 'DRAFT', notSent: 'ISSUED', sending: 'ISSUED', atSdi: 'SENT', delivered: 'DELIVERED', notDelivered: 'NOT_DELIVERABLE', rejected: 'REJECTED', resent: 'DELIVERED', error: 'ERROR' }[kind] as Sdi['invoiceStatus']
  const code = { draft: 'DRAFT', notSent: 'NOT_SENT', sending: 'SENDING', atSdi: 'AT_SDI', delivered: 'DELIVERED', notDelivered: 'NOT_DELIVERED', rejected: 'REJECTED', resent: 'DELIVERED', error: 'ERROR' }[kind] as Sdi['state']['code']
  const action = { draft: 'ISSUE', notSent: 'SEND', sending: 'WAIT', atSdi: 'WAIT', delivered: 'NONE', notDelivered: 'CHECK_COPY', rejected: 'FIX_AND_RESEND', resent: 'NONE', error: 'SEND_AGAIN' }[kind] as Sdi['state']['next']['action']
  const rc = (n: number, received: string) => ({ id: uid('9393', n), type: 'RC' as const, receivedAt: received, source: 'webhook' as const, errors: [] })
  const ns = { id: uid('9393', 7), type: 'NS' as const, receivedAt: at(29, 10, 20), source: 'webhook' as const, errors: [{ code: '00305', description: 'IdFiscaleIVA del CessionarioCommittente non valido', fix: 'party' as const, known: true }] }
  const sends: Sdi['sends'] =
    kind === 'draft' || kind === 'notSent'
      ? []
      : kind === 'sending'
        ? [{ ...SEND_1, status: 'SENDING', sdiIdentifier: null, sentAt: null, outcomeAt: null, notifications: [] }]
        : kind === 'atSdi'
          ? [{ ...SEND_1, status: 'SENT', sdiIdentifier: '123456789', sentAt: at(29, 10, 3), outcomeAt: null, notifications: [] }]
          : kind === 'delivered'
            ? [{ ...SEND_1, status: 'DELIVERED', sdiIdentifier: '123456789', sentAt: at(29, 10, 3), outcomeAt: at(29, 10, 18), notifications: [rc(1, at(29, 10, 18))] }]
            : kind === 'notDelivered'
              ? [{ ...SEND_1, status: 'NOT_DELIVERABLE', sdiIdentifier: '123456789', sentAt: at(29, 10, 3), outcomeAt: at(29, 10, 30), notifications: [{ id: uid('9393', 3), type: 'MC', receivedAt: at(29, 10, 30), source: 'poll', errors: [] }] }]
              : kind === 'error'
                ? [{ ...SEND_1, status: 'FAILED', sdiIdentifier: null, sentAt: null, outcomeAt: at(29, 10, 5), failure: { code: 'NO_ANSWER', uncertain: false }, notifications: [] }]
                : kind === 'rejected'
                  ? [{ ...SEND_1, status: 'REJECTED', sdiIdentifier: '123456789', sentAt: at(29, 10, 3), outcomeAt: at(29, 10, 20), notifications: [ns] }]
                  : [
                      { ...SEND_1, status: 'REJECTED', sdiIdentifier: '123456789', sentAt: at(29, 10, 3), outcomeAt: at(29, 10, 20), notifications: [ns] },
                      { id: uid('9292', 2), attempt: 2, fileName: 'IT01234567890_0001B.xml', createdAt: at(29, 11, 40), failure: null, status: 'DELIVERED', sdiIdentifier: '123456790', sentAt: at(29, 11, 41), outcomeAt: at(29, 11, 55), notifications: [rc(8, at(29, 11, 55))] },
                    ]
  return {
    invoiceId: TD01_ID,
    number: kind === 'draft' ? null : 'FT-2026-00031',
    issueDate: kind === 'draft' ? null : TODAY,
    invoiceStatus: status,
    version: 4,
    state: { code, next: { action } },
    canSend: kind === 'notSent' || kind === 'rejected' || kind === 'error',
    deadline: kind === 'rejected' ? { deadline: '2026-11-05', workingDaysLeft: 5, overdue: false } : null,
    resend: kind === 'rejected' ? { ready: false, problems: [{ code: 'BUYER', path: 'party/vatNumber', message: "The customer's VAT number is not valid." }] } : null,
    sends,
    archive: kind === 'delivered' || kind === 'resent' ? { archiveRef: 'ARCH-DEMO-0001', archivedAt: at(29, 10, 25) } : null,
    courtesyCopies: kind === 'notDelivered' ? { queued: [{ emailId: uid('9494', 1), status: 'SENT', queuedAt: at(29, 10, 31) }], missing: null } : { queued: [], missing: null },
    ...over,
  }
}

// ---- the list -------------------------------------------------------------------------------------------------------------------

const row = (n: number, over: Partial<InvoiceRow>): InvoiceRow => ({
  id: uid('8181', n),
  docType: 'TD01',
  status: 'DELIVERED',
  number: `FT-2026-${String(n).padStart(5, '0')}`,
  issueDate: '2026-10-20',
  companyId: COMPANY,
  buyerPartyId: PARTIES[n % 3]!.id,
  partyName: PARTIES[n % 3]!.name,
  currency: 'EUR',
  netTotal: 270000,
  vatTotal: 59400,
  grossTotal: 329400,
  depositRequestId: null,
  creditOfId: null,
  salesOrderId: null,
  filesPending: false,
  paidAmount: 0,
  creditedAmount: 0,
  openAmount: 329400,
  dueDate: '2026-11-20',
  version: 4,
  createdAt: at(20, 9),
  ...over,
})

export const LIST_ROWS: InvoiceRow[] = [
  row(31, { status: 'DRAFT', number: null, issueDate: null, buyerPartyId: CUSTOMER.id, partyName: CUSTOMER.name, netTotal: 436800, vatTotal: 96096, grossTotal: 532896, openAmount: 0, dueDate: '2026-11-28', salesOrderId: ORDER.id, createdAt: at(29, 9) }),
  row(30, { status: 'REJECTED', issueDate: '2026-10-28', docType: 'TD24' }),
  row(29, { status: 'SENT', issueDate: '2026-10-28' }),
  row(28, { docType: 'TD02', status: 'DELIVERED', issueDate: '2026-10-15', buyerPartyId: CUSTOMER.id, partyName: CUSTOMER.name, netTotal: 187200, vatTotal: 41184, grossTotal: 228384, openAmount: 0, dueDate: null, depositRequestId: DEPOSIT_REQUEST_ID }),
  row(27, { status: 'NOT_DELIVERABLE', issueDate: '2026-10-14', paidAmount: 100000, openAmount: 229400 }),
  row(26, { status: 'DELIVERED', issueDate: '2026-10-02', dueDate: '2026-10-17', openAmount: 329400 }),
  row(25, { status: 'DELIVERED', issueDate: '2026-09-30', paidAmount: 329400, openAmount: 0 }),
  row(24, { docType: 'TD04', status: 'DELIVERED', number: 'NC-2026-00001', issueDate: '2026-09-28', netTotal: 5000, vatTotal: 1100, grossTotal: 6100, openAmount: 0, dueDate: null, creditOfId: uid('8181', 25) }),
  row(23, { status: 'ISSUED', issueDate: TODAY, filesPending: true }),
]

export const TILE_COUNTS = { drafts: 1, atSdi: 1, rejected: 1, notDelivered: 1 }

export const QUEUE: Queue = {
  asOf: TODAY,
  customers: [
    {
      partyId: CUSTOMER.id,
      companyId: COMPANY,
      code: CUSTOMER.code,
      legalName: CUSTOMER.name,
      valueAmount: 624000,
      oldestDate: DDT.date,
      months: [{ month: '2026-10', ddtIds: [DDT.id], suggested: 'TD01', allowed: ['TD01', 'TD24'], deadline: { docType: 'TD01', dueBy: '2026-11-08', daysLeft: 10, state: 'OPEN' } }],
      ddts: [
        {
          ddtId: DDT.id,
          number: DDT.number,
          date: DDT.date,
          companyId: COMPANY,
          partyId: CUSTOMER.id,
          shipmentId: DDT.shipmentId,
          shipmentNumber: DDT.shipmentNumber,
          orders: [ORDER],
          lines: [
            { salesOrderLineId: ORDER_LINES[0], orderNumber: ORDER.number, description: 'DEMO-JKT-01 Giacca Demo - Nero', size: '50', shipped: '8', invoiced: '0', inDraft: '0', notInvoiced: '8', unitPrice: '450', netAmount: 360000, drafts: [] },
            { salesOrderLineId: ORDER_LINES[1], orderNumber: ORDER.number, description: 'DEMO-JKT-01 Giacca Demo - Nero', size: '52', shipped: '6', invoiced: '0', inDraft: '0', notInvoiced: '6', unitPrice: '440', netAmount: 264000, drafts: [] },
          ],
          valueAmount: 624000,
          depositPaidAmount: 228384,
          drafts: [],
          immediate: { docType: 'TD01', dueBy: '2026-11-08', daysLeft: 10, state: 'OPEN' },
        },
      ],
    },
    {
      partyId: PARTIES[2].id,
      companyId: COMPANY,
      code: PARTIES[2].code,
      legalName: PARTIES[2].name,
      valueAmount: 810000,
      oldestDate: '2026-10-06',
      months: [{ month: '2026-10', ddtIds: [uid('7171', 131), uid('7171', 137)], suggested: 'TD24', allowed: ['TD24'], deadline: { docType: 'TD24', dueBy: '2026-11-15', daysLeft: 17, state: 'OPEN' } }],
      ddts: [131, 137].map((n, index) => ({
        ddtId: uid('7171', n),
        number: `${n}/2026`,
        date: index === 0 ? '2026-10-06' : '2026-10-13',
        companyId: COMPANY,
        partyId: PARTIES[2].id,
        shipmentId: uid('7272', n),
        shipmentNumber: `SH-2026-00${n - 100}`,
        orders: [{ id: uid('5151', 70 + index), number: `SO-2026-00${70 + index}` }],
        lines: [{ salesOrderLineId: uid('5252', 30 + n), orderNumber: `SO-2026-00${70 + index}`, description: 'DEMO-PNT-02 Pantalone Demo - Grigio', size: '48', shipped: '9', invoiced: '0', inDraft: '0', notInvoiced: '9', unitPrice: '450', netAmount: 405000, drafts: [] }],
        valueAmount: 405000,
        depositPaidAmount: 0,
        drafts: [],
        immediate: { docType: 'TD01' as const, dueBy: index === 0 ? '2026-10-18' : '2026-10-25', daysLeft: index === 0 ? -11 : -4, state: 'LATE' as const },
      })),
    },
  ],
}

export const QUEUE_IN_DRAFT: Queue = {
  ...QUEUE,
  customers: [{ ...QUEUE.customers[0]!, ddts: QUEUE.customers[0]!.ddts.map((ddt) => ({ ...ddt, drafts: [TD01_ID], lines: ddt.lines.map((line) => ({ ...line, inDraft: line.notInvoiced, drafts: [TD01_ID] })) })) }, QUEUE.customers[1]!],
}

// ---- payments -------------------------------------------------------------------------------------------------------------------

const payRow = (n: number, over: Partial<PaymentRow>): PaymentRow => ({
  id: uid('3131', n),
  companyId: COMPANY,
  partyId: PARTIES[n % 3]!.id,
  partyName: PARTIES[n % 3]!.name,
  method: 'BANK_TRANSFER',
  amount: 329400,
  allocated: 329400,
  unallocated: 0,
  currency: 'EUR',
  receivedOn: '2026-10-21',
  externalRef: `CRO-0000-ESEMPIO-${n}`,
  status: 'RECEIVED',
  placedOn: [{ target: 'INVOICE', targetId: uid('8181', 25), amount: 329400, number: 'FT-2026-00025', docType: 'TD01', orderNumber: null }],
  createdAt: at(21, 9),
  ...over,
})

export const PAYMENT_ROWS: PaymentRow[] = [
  payRow(43, { receivedOn: TODAY, amount: 200000, allocated: 0, unallocated: 200000, placedOn: [], createdAt: at(29, 11) }),
  payRow(42, { receivedOn: TODAY, partyId: CUSTOMER.id, partyName: CUSTOMER.name, amount: 532896, allocated: 532896, placedOn: [{ target: 'INVOICE', targetId: TD01_ID, amount: 532896, number: 'FT-2026-00031', docType: 'TD01', orderNumber: ORDER.number }], createdAt: at(29, 15) }),
  payRow(41, { receivedOn: '2026-10-24', amount: 150000, allocated: 100000, unallocated: 50000, placedOn: [{ target: 'INVOICE', targetId: uid('8181', 27), amount: 100000, number: 'FT-2026-00027', docType: 'TD01', orderNumber: null }] }),
  payRow(40, { receivedOn: '2026-10-15', partyId: CUSTOMER.id, partyName: CUSTOMER.name, amount: 228384, allocated: 228384, placedOn: [{ target: 'DEPOSIT_REQUEST', targetId: DEPOSIT_REQUEST_ID, amount: 228384, number: null, docType: null, orderNumber: ORDER.number }] }),
  payRow(39, {}),
  payRow(38, { status: 'VOIDED', allocated: 0, unallocated: 0, placedOn: [], receivedOn: '2026-10-08' }),
]

export const OPEN_ITEMS: OpenItem[] = [
  { target: 'INVOICE', id: uid('8181', 26), number: 'FT-2026-00026', docType: 'TD01', fiscalDocument: null, orderId: null, orderNumber: null, date: '2026-10-02', dueDate: '2026-10-17', currency: 'EUR', amount: 329400, openAmount: 329400 },
  { target: 'DEPOSIT_REQUEST', id: uid('4343', 14), number: null, docType: null, fiscalDocument: 'TD02', orderId: uid('5151', 90), orderNumber: 'SO-2026-0090', date: '2026-10-22', dueDate: '2026-10-29', currency: 'EUR', amount: 120000, openAmount: 120000 },
  { target: 'INVOICE', id: TD01_ID, number: 'FT-2026-00031', docType: 'TD01', fiscalDocument: null, orderId: ORDER.id, orderNumber: ORDER.number, date: TODAY, dueDate: '2026-11-28', currency: 'EUR', amount: 532896, openAmount: 532896 },
]

export const PAYMENT: Payment = {
  id: uid('3131', 41),
  version: 2,
  companyId: COMPANY,
  partyId: PARTIES[2].id,
  party: { code: PARTIES[2].code, legalName: PARTIES[2].name },
  method: 'BANK_TRANSFER',
  amount: 150000,
  currency: 'EUR',
  receivedOn: '2026-10-24',
  externalRef: 'CRO-0000-ESEMPIO-41',
  status: 'RECEIVED',
  voidedAt: null,
  voidReason: null,
  internalNote: null,
  allocated: 100000,
  unallocated: 50000,
  allocations: [
    { id: uid('3232', 11), target: 'INVOICE', targetId: uid('8181', 27), amount: 100000, reversalOfId: null, reversed: false, note: null, createdAt: at(24, 10), createdById: uid('3333', 2), label: { number: 'FT-2026-00027', docType: 'TD01', orderNumber: null } },
  ],
  placedOn: [{ target: 'INVOICE', targetId: uid('8181', 27), amount: 100000, number: 'FT-2026-00027', docType: 'TD01', orderNumber: null }],
  createdAt: at(24, 10),
  createdById: uid('3333', 2),
  people: [{ id: uid('3333', 2), name: 'Fiona Conti' }],
}

export const PAYMENT_REVERSED: Payment = {
  ...PAYMENT,
  allocated: 0,
  unallocated: 150000,
  allocations: [
    { ...PAYMENT.allocations[0]!, reversed: true },
    { id: uid('3232', 12), target: 'INVOICE', targetId: uid('8181', 27), amount: -100000, reversalOfId: uid('3232', 11), reversed: false, note: 'Placed on the wrong invoice.', createdAt: at(25, 9), createdById: uid('3333', 2), label: { number: 'FT-2026-00027', docType: 'TD01', orderNumber: null } },
  ],
  placedOn: [],
}

// ---- settings ---------------------------------------------------------------------------------------------------------------------

export const SETTINGS: FinanceSettings = {
  asOf: TODAY,
  companies: [
    {
      id: COMPANY,
      code: 'DEMO',
      legalName: DEMO_COMPANIES[0].name,
      identity: { vatNumber: 'IT01234567890', fiscalCode: '01234567890', regimeFiscale: 'RF01', reaOffice: 'MI', reaNumber: '1234567', shareCapital: '10000.00', soleShareholder: false, inLiquidation: false, address: { line1: 'Via Esempio 1', line2: null, postalCode: '20100', city: 'Milano', province: 'MI', country: 'IT' } },
      seller: { ready: true, problems: [] },
      sdi: { state: 'ACTIVE', accounts: [{ id: uid('6161', 1), label: 'SDI (prova)', mode: 'FAKE', status: 'ACTIVE' }] },
      archive: { archivedSends: 12, lastArchivedAt: at(29, 10, 25) },
      series: [
        { kind: 'INVOICE', next: 'FT-2026-00032' },
        { kind: 'DEPOSIT_INVOICE', next: null },
        { kind: 'CREDIT_NOTE', next: 'NC-2026-00003' },
      ],
    },
  ],
}

export const SETTINGS_MISSING: FinanceSettings = {
  ...SETTINGS,
  companies: [{ ...SETTINGS.companies[0]!, identity: { ...SETTINGS.companies[0]!.identity!, regimeFiscale: null, address: null }, seller: { ready: false, problems: [{ path: 'company/regimeFiscale' }, { path: 'company/address' }] }, sdi: { state: 'NONE', accounts: [] }, archive: { archivedSends: 0, lastArchivedAt: null } }],
}

export const BANK = { companyId: COMPANY, bank: { accountHolder: DEMO_COMPANIES[0].name, iban: 'IT60X0542811101000000123456', bic: 'BPMOIT22XXX', bankName: 'Banca Esempio' }, version: 3, updatedAt: at(20, 9) }

// ---- record panels --------------------------------------------------------------------------------------------------------------

const conversation = panelsScreen.cases.find((item) => item.id === 'conversation')!.model as RecordPanelsViewModel

export function panelsModel(title = 'FT-2026-00031 · Moto Demo S.r.l.'): RecordPanelsViewModel {
  return { ...conversation, record: { type: 'Invoice', id: TD01_ID, companyId: COMPANY, siteId: null }, title, party: null }
}
