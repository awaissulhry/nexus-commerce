import { createElement, type ReactNode } from 'react'
import type { FiguresAnswer } from '@nexus/factory-domain/receivables-figures/contracts'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { CustomerRow, OpenItem } from '../../_shared/api'
import type { BankAccount, BankLine, BankMatch, FiguresRow, ImportPlan, LineCounts } from '../api'
import { bankCanOf, EMPTY_ADDRESS, type BankCan } from '../model'
import { MATCH_IDLE } from '../view/MatchPanel'
import type { BankModel } from '../view/BankView'

/**
 * Made-up data for the design cases of Finance › Bank (SCR-152, SCR-570 … SCR-574): an invented company ("Officina Demo
 * S.r.l."), invented customers ("Moto Club Demo S.r.l.", "Racing Team Prova S.n.c.", "Pelletteria Esempio S.p.A."), an
 * invented supplier ("Conceria Demo S.r.l."), invented invoices, references and test IBANs (bank and branch code 00000).
 * Nothing here is a real company, person, account or number. Design-only.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-11-15'
export const NOW = Date.parse('2026-11-15T08:40:00.000Z')
export const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = DEMO_COMPANIES[0].id

const BASE = ['home.view', 'threads.read', 'files.read']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'payments.bank.view', 'payments.bank.import', 'payments.bank.match', 'payments.record', 'payments.void', 'payments.writeOff', 'payments.view', 'receivables.view', 'receivables.theirFigures.manage', 'parties.view', 'files.upload', 'money.price'],
  /** Finance: imports, matches, records, writes off, takes back; records customers' figures; sees prices. */
  finance: [...BASE, 'payments.bank.view', 'payments.bank.import', 'payments.bank.match', 'payments.record', 'payments.void', 'payments.writeOff', 'payments.view', 'receivables.view', 'receivables.theirFigures.manage', 'parties.view', 'files.upload', 'money.price'],
  /** Read-only: sees the bank and the figures, no amount (no price grain), no action. */
  readonly: [...BASE, 'payments.bank.view', 'payments.view', 'receivables.view'],
  /** Warehouse: no payments.bank.view. */
  warehouse: [...BASE, 'inventory.stock.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): BankCan => bankCanOf(ROLES[role])

export function inShell(page: ReactNode, role: Role = 'finance'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path: '/finance/bank',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/finance/bank' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const MCD = { id: uid('5151', 1), code: 'CUS-MCD', legalName: 'Moto Club Demo S.r.l.' }
const RTP = { id: uid('5151', 2), code: 'CUS-RTP', legalName: 'Racing Team Prova S.n.c.' }
const PES = { id: uid('5151', 3), code: 'CUS-PES', legalName: 'Pelletteria Esempio S.p.A.' }
const CONC = { id: uid('5151', 4), code: 'SUP-CONC', legalName: 'Conceria Demo S.r.l.' }
export const PARTIES = { MCD, RTP, PES, CONC }
export const STATEMENT = uid('5252', 1)
export const ACCOUNT = uid('5353', 1)

const match = (over: Partial<BankMatch> & Pick<BankMatch, 'id' | 'partyId' | 'party' | 'confidence' | 'reasons'>): BankMatch => ({
  version: 1,
  chosenByPerson: false,
  items: [],
  paymentId: null,
  payment: null,
  supplierInvoiceId: null,
  supplierInvoice: null,
  difference: null,
  stale: false,
  acceptedAt: null,
  acceptedById: null,
  reversedAt: null,
  reversedById: null,
  reverseReason: null,
  ...over,
})

const line = (over: Partial<BankLine> & Pick<BankLine, 'id' | 'bookedOn' | 'amount' | 'direction'>): BankLine => ({
  companyId: COMPANY,
  bankAccountId: ACCOUNT,
  statementId: STATEMENT,
  valueOn: null,
  currency: 'EUR',
  bankReference: null,
  referenceText: null,
  counterpartyName: null,
  counterpartyIban: null,
  state: 'TO_MATCH',
  ageDays: 0,
  accepted: null,
  suggestions: [],
  reversed: [],
  ...over,
})

export const INV_41 = uid('5454', 41)
export const INV_38 = uid('5454', 38)
export const INV_35 = uid('5454', 35)
export const INV_30 = uid('5454', 30)
export const INV_29 = uid('5454', 29)

/** 409.60 for FT-2026-00041 (open 410.00): High, 0.40 short, within the tolerance (writable). */
export const L_SURE = line({
  id: uid('5555', 1),
  bookedOn: '2026-11-12',
  valueOn: '2026-11-12',
  amount: 40960,
  direction: 'IN',
  bankReference: 'CRO-0000-4101',
  referenceText: 'Saldo FT-2026-00041 Moto Club Demo',
  counterpartyName: 'MOTO CLUB DEMO SRL',
  counterpartyIban: 'IT00A0000000000000000004101',
  ageDays: 3,
  suggestions: [
    match({
      id: uid('5656', 1),
      partyId: MCD.id,
      party: { code: MCD.code, legalName: MCD.legalName },
      confidence: 'HIGH',
      reasons: [{ code: 'AMOUNT_WITHIN_TOLERANCE' }, { code: 'NUMBER_IN_REFERENCE' }, { code: 'IBAN_KNOWN' }, { code: 'NAME_MATCHES' }],
      items: [{ kind: 'INVOICE', id: INV_41, number: 'FT-2026-00041', docType: 'TD01', openAmount: 41000 }],
      difference: { kind: 'UNDERPAYMENT', amount: 40, writable: true, refusal: null },
    }),
  ],
})
/** 1,220.00 quoting PO 7781: Medium for Racing Team Prova, Low for Pelletteria Esempio (the same amount). */
export const L_TWO = line({
  id: uid('5555', 2),
  bookedOn: '2026-11-10',
  amount: 122000,
  direction: 'IN',
  bankReference: 'CRO-0000-7781',
  referenceText: 'Bonifico ordine PO 7781',
  counterpartyName: 'RACING TEAM PROVA SNC',
  counterpartyIban: 'IT00B0000000000000000007781',
  ageDays: 5,
  suggestions: [
    match({ id: uid('5656', 2), partyId: RTP.id, party: { code: RTP.code, legalName: RTP.legalName }, confidence: 'MEDIUM', reasons: [{ code: 'AMOUNT_EQUAL' }, { code: 'NAME_MATCHES' }], items: [{ kind: 'INVOICE', id: INV_38, number: 'FT-2026-00038', docType: 'TD01', openAmount: 122000 }] }),
    match({ id: uid('5656', 3), partyId: PES.id, party: { code: PES.code, legalName: PES.legalName }, confidence: 'LOW', reasons: [{ code: 'AMOUNT_EQUAL' }], items: [{ kind: 'INVOICE', id: INV_35, number: 'FT-2026-00035', docType: 'TD01', openAmount: 122000 }] }),
  ],
})
/** Money out to the tannery: Medium, its supplier invoice by number. */
export const L_OUT = line({
  id: uid('5555', 3),
  bookedOn: '2026-11-03',
  amount: -56913,
  direction: 'OUT',
  bankReference: 'TRN-0000-0412',
  referenceText: 'Pagamento fattura 2026/0412 Conceria Demo',
  counterpartyName: 'CONCERIA DEMO SRL',
  counterpartyIban: 'IT00C0000000000000000007002',
  ageDays: 12,
  suggestions: [match({ id: uid('5656', 4), partyId: CONC.id, party: { code: CONC.code, legalName: CONC.legalName }, confidence: 'MEDIUM', reasons: [{ code: 'AMOUNT_EQUAL' }, { code: 'NUMBER_IN_REFERENCE' }], supplierInvoiceId: uid('5757', 412), supplierInvoice: { number: '2026/0412', status: 'APPROVED' } })],
})
/** Bank charges: no suggestion, waiting 13 days. */
export const L_FEES = line({ id: uid('5555', 4), bookedOn: '2026-11-02', amount: -320, direction: 'OUT', referenceText: 'Commissioni bonifico', ageDays: 13 })
/** Its only suggestion was paid meanwhile. */
export const L_STALE = line({
  id: uid('5555', 6),
  bookedOn: '2026-11-06',
  amount: 7500,
  direction: 'IN',
  referenceText: 'Acconto ordine SO-2026-0040',
  counterpartyName: 'PELLETTERIA ESEMPIO SPA',
  ageDays: 9,
  suggestions: [match({ id: uid('5656', 6), partyId: PES.id, party: { code: PES.code, legalName: PES.legalName }, confidence: 'MEDIUM', reasons: [{ code: 'AMOUNT_EQUAL' }], items: [{ kind: 'DEPOSIT_REQUEST', id: uid('5858', 40), number: 'SO-2026-0040', docType: null, openAmount: 0 }], stale: true })],
})
/** Matched: the payment recorded from it. */
export const L_MATCHED = line({
  id: uid('5555', 5),
  bookedOn: '2026-11-05',
  amount: 25000,
  direction: 'IN',
  bankReference: 'CRO-0000-3030',
  referenceText: 'Fattura FT-2026-00030',
  counterpartyName: 'PELLETTERIA ESEMPIO SPA',
  counterpartyIban: 'IT00D0000000000000000003030',
  state: 'MATCHED',
  ageDays: 10,
  accepted: match({
    id: uid('5656', 5),
    partyId: PES.id,
    party: { code: PES.code, legalName: PES.legalName },
    confidence: 'HIGH',
    reasons: [{ code: 'AMOUNT_EQUAL' }, { code: 'NUMBER_IN_REFERENCE' }, { code: 'IBAN_KNOWN' }],
    items: [{ kind: 'INVOICE', id: INV_30, number: 'FT-2026-00030', docType: 'TD01', openAmount: 0 }],
    paymentId: uid('5959', 30),
    payment: { externalRef: 'CRO-0000-3030', receivedOn: '2026-11-05', status: 'RECEIVED' },
    acceptedAt: '2026-11-06T09:12:00.000Z',
    acceptedById: DEMO_USER.id,
  }),
})

export const TO_MATCH = [L_FEES, L_OUT, L_STALE, L_TWO, L_SURE]
export const COUNTS: LineCounts = { companyId: COMPANY, today: TODAY, oldAfterDays: 7, toMatch: 5, sureMatches: 1, unmatchedOverDays: 3, lastStatementOn: '2026-11-13' }

export const ACCOUNTS: BankAccount[] = [
  { id: ACCOUNT, holder: 'Officina Demo S.r.l.', iban: 'IT00Z0000000000000000001234', bic: null, bankName: 'Banca Demo', currency: 'EUR', active: true, version: 1, lastStatementOn: '2026-11-13', statements: 4 },
  { id: uid('5353', 2), holder: 'Officina Demo S.r.l.', iban: 'IT00Y0000000000000000005678', bic: null, bankName: 'Banca Prova', currency: 'EUR', active: false, version: 2, lastStatementOn: null, statements: 0 },
]

export const CUSTOMERS: CustomerRow[] = [
  { id: MCD.id, companyId: null, code: MCD.code, legalName: MCD.legalName, tradeName: null, status: 'ACTIVE', currency: 'EUR', vatNumber: 'IT00000004101' },
  { id: RTP.id, companyId: null, code: RTP.code, legalName: RTP.legalName, tradeName: null, status: 'ACTIVE', currency: 'EUR', vatNumber: 'IT00000007781' },
]

export const OPEN_ITEMS: OpenItem[] = [
  { target: 'INVOICE', id: INV_38, number: 'FT-2026-00038', docType: 'TD01', fiscalDocument: null, stepKind: null, orderId: uid('6060', 31), orderNumber: 'SO-2026-0031', date: '2026-10-20', dueDate: '2026-11-19', currency: 'EUR', amount: 122000, openAmount: 80000 },
  { target: 'INVOICE', id: uid('5454', 39), number: 'FT-2026-00039', docType: 'TD01', fiscalDocument: null, stepKind: null, orderId: uid('6060', 32), orderNumber: 'SO-2026-0032', date: '2026-10-28', dueDate: '2026-11-27', currency: 'EUR', amount: 42000, openAmount: 42000 },
]

/** A CSV statement read with every column mapped (4 lines: 2 new, 1 imported before, 1 balance row that cannot be read). */
export const PLAN: ImportPlan = {
  fileId: uid('6161', 1),
  statementId: uid('5252', 2),
  companyId: COMPANY,
  format: 'CSV',
  account: { id: ACCOUNT, iban: ACCOUNTS[0]!.iban, currency: 'EUR' },
  fileIban: null,
  ready: true,
  period: { start: '2026-11-13', end: '2026-11-14' },
  counts: { new: 2, duplicate: 1, error: 1 },
  totals: { moneyIn: 40960, moneyOut: 320 },
  mapping: {
    headers: ['Data contabile', 'Data valuta', 'Importo', 'Causale', 'Ordinante', 'Saldo'],
    columns: [
      { index: 0, header: 'Data contabile', column: 'bookedOn' },
      { index: 1, header: 'Data valuta', column: 'valueOn' },
      { index: 2, header: 'Importo', column: 'amount' },
      { index: 3, header: 'Causale', column: 'referenceText' },
      { index: 4, header: 'Ordinante', column: 'counterpartyName' },
    ],
    ignored: [{ index: 5, header: 'Saldo' }],
    issues: [],
  },
  sheet: { name: null, names: [], encoding: 'utf-8', delimiter: ';' },
  lines: [
    { row: 2, verdict: 'NEW', bookedOn: '2026-11-14', valueOn: '2026-11-14', amount: 40960, currency: 'EUR', bankReference: null, referenceText: 'Saldo FT-2026-00041', counterpartyName: 'MOTO CLUB DEMO SRL', counterpartyIban: null, problems: [] },
    { row: 3, verdict: 'NEW', bookedOn: '2026-11-14', valueOn: null, amount: -320, currency: 'EUR', bankReference: null, referenceText: 'Commissioni', counterpartyName: null, counterpartyIban: null, problems: [] },
    { row: 4, verdict: 'DUPLICATE', bookedOn: '2026-11-13', valueOn: null, amount: 122000, currency: 'EUR', bankReference: null, referenceText: 'Bonifico ordine PO 7781', counterpartyName: 'RACING TEAM PROVA SNC', counterpartyIban: null, problems: [] },
    { row: 5, verdict: 'ERROR', bookedOn: null, valueOn: null, amount: null, currency: null, bankReference: null, referenceText: 'Saldo finale', counterpartyName: null, counterpartyIban: null, problems: [{ code: 'NO_DATE' }, { code: 'NO_AMOUNT' }] },
  ],
}

const F1 = uid('6262', 1)
const F2 = uid('6262', 2)
export const FIGURES: FiguresRow[] = [
  {
    id: F1,
    company: { id: COMPANY, code: 'DEMO', name: DEMO_COMPANIES[0].name },
    customer: { id: MCD.id, code: MCD.code, name: MCD.legalName },
    asOf: '2026-11-10',
    currency: 'EUR',
    theirs: { orders: 2, payments: 2, balance: 21000 },
    summary: { ours: 41000, difference: -20000, differences: 3, state: 'DIFFERS' },
    file: { id: uid('6363', 1), name: 'estratto-moto-club-demo-10-11.pdf' },
    note: 'Typed from their statement of 10 November (demo).',
    createdAt: '2026-11-11T10:05:00.000Z',
    createdBy: { id: DEMO_USER.id, name: DEMO_USER.displayName },
    updatedAt: '2026-11-11T10:05:00.000Z',
    can: { correct: true },
    version: 1,
  } as FiguresRow,
  {
    id: F2,
    company: { id: COMPANY, code: 'DEMO', name: DEMO_COMPANIES[0].name },
    customer: { id: RTP.id, code: RTP.code, name: RTP.legalName },
    asOf: '2026-10-31',
    currency: 'EUR',
    theirs: { orders: 1, payments: 0, balance: 122000 },
    summary: { ours: 122000, difference: 0, differences: 0, state: 'AGREES' },
    file: null,
    note: null,
    createdAt: '2026-11-02T15:40:00.000Z',
    createdBy: { id: DEMO_USER.id, name: DEMO_USER.displayName },
    updatedAt: '2026-11-02T15:40:00.000Z',
    can: { correct: true },
    version: 1,
  } as FiguresRow,
]

/** F1 compared: their order by PO is the same; an invoice they still list is paid with us; a payment we never received. */
export const F1_ANSWER = {
  figures: FIGURES[0]!,
  comparison: {
    balance: { theirs: 21000, ours: 41000, difference: -20000, state: 'DIFFERS' },
    orders: [
      { index: 0, reference: 'PO 5521', theirs: 41000, ours: { kind: 'ORDER', id: uid('6060', 21), number: 'SO-2026-0021', invoices: [{ id: INV_41, number: 'FT-2026-00041', open: 41000 }], open: 41000 }, state: 'SAME', difference: 0 },
      { index: 1, reference: 'FT-2026-00029', theirs: 20000, ours: { kind: 'INVOICE', id: INV_29, number: 'FT-2026-00029', invoices: [], open: 0 }, state: 'NOTHING_OPEN', difference: 20000 },
    ],
    payments: [
      { index: 0, reference: 'CRO 0000 5555', date: '2026-11-02', theirs: 40000, ours: { id: uid('5959', 55), reference: 'CRO-0000-5555', receivedOn: '2026-11-03', amount: 40000 }, foundBy: 'REFERENCE', state: 'SAME', difference: 0 },
      { index: 1, reference: 'Bonifico 9 novembre', date: '2026-11-09', theirs: 40000, ours: null, foundBy: null, state: 'NOT_FOUND', difference: 40000 },
    ],
    paymentsFrom: '2026-11-02',
    differences: 3,
  },
} as unknown as FiguresAnswer

export const F2_ANSWER = {
  figures: FIGURES[1]!,
  comparison: {
    balance: { theirs: 122000, ours: 122000, difference: 0, state: 'SAME' },
    orders: [{ index: 0, reference: 'PO 7781', theirs: 122000, ours: { kind: 'ORDER', id: uid('6060', 31), number: 'SO-2026-0031', invoices: [{ id: INV_38, number: 'FT-2026-00038', open: 122000 }], open: 122000 }, state: 'SAME', difference: 0 }],
    payments: [],
    paymentsFrom: null,
    differences: 0,
  },
} as unknown as FiguresAnswer

/** Without the price grain the API sends no amount (the marked fields are dropped). */
export function withoutPrice<T>(value: T): T {
  const drop = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(drop)
    if (entry && typeof entry === 'object') {
      return Object.fromEntries(
        Object.entries(entry as Record<string, unknown>)
          .filter(([key]) => !['amount', 'openAmount', 'open', 'theirs', 'ours', 'difference', 'balance', 'moneyIn', 'moneyOut'].includes(key) || typeof (entry as Record<string, unknown>)[key] === 'object')
          .map(([key, inner]) => [key, drop(inner)]),
      )
    }
    return entry
  }
  return drop(value) as T
}

/** The page as Finance sees it on the lines to match, the surest line open. */
export function bankModel(role: Role = 'finance', over: Partial<BankModel> = {}): BankModel {
  const can = canAs(role)
  const price = can.price
  const rows = price ? TO_MATCH : withoutPrice(TO_MATCH)
  return {
    prefix: PREFIX,
    can,
    today: TODAY,
    address: { ...EMPTY_ADDRESS, line: L_SURE.id },
    counts: { value: COUNTS, problem: null },
    lines: { rows, problem: null, slow: false, more: false },
    statement: null,
    current: { value: rows.find((row) => row.id === L_SURE.id) ?? null, problem: null },
    match: MATCH_IDLE,
    readAt: NOW - 60_000,
    live: 'live',
    updates: 0,
    busy: false,
    notice: null,
    review: null,
    choose: null,
    reverse: null,
    importing: null,
    figures: {
      can: { view: can.receivables, manage: can.figures, price, upload: can.upload, filesRead: can.filesRead, parties: can.parties },
      rows: can.receivables ? (price ? FIGURES : withoutPrice(FIGURES)) : null,
      problem: null,
      slow: false,
      open: null,
      editor: null,
    },
    ...over,
  }
}
