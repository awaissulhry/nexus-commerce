import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Ageing, AgeingRow, Reminder, ReceivablesSettings, Statement } from '../api'
import { receivablesCanOf, type ReceivablesCan } from '../model'

/**
 * Made-up data for the design cases of SCR-151 (Finance › Receivables & credit, its statement DetailModal, the reminder
 * dialog and the statement PDF tab): an invented company ("Officina Demo S.r.l."), invented customers ("Moto Demo
 * S.r.l.", "Pista Demo S.p.A.", "Club Demo", "Gamma Demo S.n.c."), invoices and payments; every figure worked out by hand
 * (the sums are in the comments). Nothing here is a real company, customer, invoice or person. Design-only.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-31'
export const NOW = Date.parse('2026-10-31T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const COMPANY = {
  id: DEMO_COMPANIES[0].id,
  code: 'DEMO',
  name: DEMO_COMPANIES[0].name,
}

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read']
export const ROLES = {
  owner: [
    ...OWNER_PERMISSIONS,
    'receivables.view',
    'receivables.reminders.manage',
    'receivables.reminders.approve',
    'receivables.statements.send',
    'invoices.view',
    'payments.view',
    'parties.view',
    'money.price',
    'money.cost',
    'money.margin',
  ],
  /** Finance: every receivables move (the Owner's switch is the owner's). */
  finance: [
    ...BASE,
    'receivables.view',
    'receivables.reminders.manage',
    'receivables.reminders.approve',
    'receivables.statements.send',
    'invoices.view',
    'payments.view',
    'parties.view',
    'money.price',
    'money.cost',
    'money.margin',
  ],
  /** Sales (B-W2a-81): reads what customers owe, never a reminder move. */
  sales: [...BASE, 'receivables.view', 'invoices.view', 'parties.view', 'orders.view', 'money.price', 'money.margin'],
  /** Read-only: receivables.view without the price grain (no amount, no reminder text). */
  readOnly: [...BASE, 'receivables.view', 'invoices.view', 'parties.view'],
  /** Warehouse: no receivables.view. */
  warehouse: [...BASE, 'inventory.stock.view', 'orders.view'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): ReceivablesCan => receivablesCanOf(ROLES[role])

export function inShell(path: string, page: ReactNode, role: Role = 'finance'): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck(ROLES[role])),
    path,
    switcher: {
      companies: DEMO_COMPANIES,
      company: 'DEMO',
      sites: [],
      site: null,
      path,
    },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

const MOTO = { id: uid('2121', 1), code: 'C-0001', name: 'Moto Demo S.r.l.' }
const PISTA = { id: uid('2121', 2), code: 'C-0002', name: 'Pista Demo S.p.A.' }
const CLUB = { id: uid('2121', 3), code: 'C-0003', name: 'Club Demo' }
export const GAMMA = {
  id: uid('2121', 4),
  code: 'C-0004',
  name: 'Gamma Demo S.n.c.',
}

const row = (customer: typeof MOTO, over: Partial<AgeingRow>): AgeingRow => ({
  company: COMPANY,
  customer,
  currency: 'EUR',
  open: 0,
  overdue: 0,
  buckets: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 },
  invoices: 0,
  oldestDueDate: null,
  daysLate: null,
  lastPaymentOn: null,
  remindersSent: 0,
  lastReminderAt: null,
  remindersWaiting: 0,
  creditLimitUsed: null,
  ...over,
})

/**
 * Gamma Demo: 12,200.00 open = 2,440.00 not due + 3,660.00 (1–30) + 6,100.00 (61–90); overdue 9,760.00; 3 invoices.
 * Moto Demo: 8,540.00 open = 4,880.00 not due + 3,660.00 (31–60); overdue 3,660.00; 2 invoices.
 * Pista Demo: 1,830.00 over 90 days; 1 invoice. Club Demo: 610.00 not due; 1 invoice.
 * Tiles: open 23,180.00 = 12,200.00 + 8,540.00 + 1,830.00 + 610.00; overdue 15,250.00 = 9,760.00 + 3,660.00 + 1,830.00;
 * not due 7,930.00; 1–30 3,660.00; 31–60 3,660.00; 61–90 6,100.00; over 90 1,830.00 (they add up to 23,180.00).
 */
export const ROWS: AgeingRow[] = [
  row(GAMMA, {
    open: 1220000,
    overdue: 976000,
    buckets: {
      NOT_DUE: 244000,
      D1_30: 366000,
      D31_60: 0,
      D61_90: 610000,
      OVER_90: 0,
    },
    invoices: 3,
    oldestDueDate: '2026-08-31',
    daysLate: 61,
    lastPaymentOn: '2026-09-15',
    remindersSent: 2,
    lastReminderAt: '2026-10-07T07:00:00.000Z',
    remindersWaiting: 1,
  }),
  row(MOTO, {
    open: 854000,
    overdue: 366000,
    buckets: {
      NOT_DUE: 488000,
      D1_30: 0,
      D31_60: 366000,
      D61_90: 0,
      OVER_90: 0,
    },
    invoices: 2,
    oldestDueDate: '2026-09-30',
    daysLate: 31,
    lastPaymentOn: '2026-10-20',
    remindersSent: 1,
    lastReminderAt: '2026-10-07T07:00:00.000Z',
    remindersWaiting: 1,
  }),
  row(PISTA, {
    open: 183000,
    overdue: 183000,
    buckets: { NOT_DUE: 0, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 183000 },
    invoices: 1,
    oldestDueDate: '2026-07-31',
    daysLate: 92,
    remindersSent: 3,
    lastReminderAt: '2026-09-30T07:00:00.000Z',
  }),
  row(CLUB, {
    open: 61000,
    overdue: 0,
    buckets: { NOT_DUE: 61000, D1_30: 0, D31_60: 0, D61_90: 0, OVER_90: 0 },
    invoices: 1,
    oldestDueDate: '2026-11-30',
    daysLate: null,
  }),
]

export const AGEING: Ageing = {
  asOf: TODAY,
  readAt: '2026-10-31T08:40:00.000Z',
  tiles: [
    {
      currency: 'EUR',
      customers: 4,
      invoices: 7,
      open: 2318000,
      overdue: 1525000,
      buckets: {
        NOT_DUE: 793000,
        D1_30: 366000,
        D31_60: 366000,
        D61_90: 610000,
        OVER_90: 183000,
      },
    },
  ],
  customers: ROWS,
  count: 4,
  next: null,
}

const reminder = (n: number, customer: typeof MOTO, over: Partial<Reminder>): Reminder => ({
  id: uid('3131', n),
  company: COMPANY,
  customer,
  level: 2,
  step: {
    offsetDays: 7,
    words: { en: '7 days late', it: '7 giorni di ritardo' },
  },
  action: 'EMAIL',
  status: 'PREPARED',
  byHand: false,
  invoices: [],
  amountDue: 0,
  interestAmount: null,
  currency: 'EUR',
  oldestDueDate: '2026-09-30',
  language: 'it',
  text: { subject: null, body: null },
  held: [],
  preparedAt: '2026-10-31T05:00:00.000Z',
  preparedBy: null,
  approvedAt: null,
  approvedBy: null,
  sentAt: null,
  callNote: null,
  skippedAt: null,
  skippedBy: null,
  skipReason: null,
  cancelledAt: null,
  cancelReason: null,
  email: null,
  letterFileId: null,
  actions: { edit: true, approve: true, send: false, skip: true, cancel: true },
  version: 1,
  ...over,
})

/** Gamma Demo, level 3 (30 days late), a letter: FT-2026-00141 6,100.00 open. Moto Demo, level 2 (7 days late): FT-2026-00166 3,660.00. */
export const REMINDERS: Reminder[] = [
  reminder(1, GAMMA, {
    level: 3,
    step: {
      offsetDays: 30,
      words: { en: '30 days late', it: '30 giorni di ritardo' },
    },
    action: 'LETTER',
    invoices: [
      {
        id: uid('4141', 141),
        number: 'FT-2026-00141',
        issueDate: '2026-07-31',
        dueDate: '2026-08-31',
        openNow: 610000,
      },
    ],
    amountDue: 610000,
    oldestDueDate: '2026-08-31',
    text: {
      subject: 'Sollecito di pagamento — fattura FT-2026-00141',
      body: 'Gentile cliente,\n\nla fattura FT-2026-00141 del 31/07/2026 risulta ancora aperta per 6.100,00 €, scaduta il 31/08/2026.\nLa preghiamo di provvedere al pagamento.\n\nCordiali saluti\nOfficina Demo S.r.l.',
    },
    held: [
      {
        code: 'UNPLACED_PAYMENT',
        words: 'The customer has money on account that is not allocated to an invoice yet.',
      },
    ],
  }),
  reminder(2, MOTO, {
    invoices: [
      {
        id: uid('4141', 166),
        number: 'FT-2026-00166',
        issueDate: '2026-08-31',
        dueDate: '2026-09-30',
        openNow: 366000,
      },
    ],
    amountDue: 366000,
    language: 'en',
    text: {
      subject: 'Payment reminder — invoice FT-2026-00166',
      body: 'Dear customer,\n\ninvoice FT-2026-00166 of 31/08/2026 is still open for €3,660.00, due on 30/09/2026.\nPlease arrange the payment.\n\nKind regards\nOfficina Demo S.r.l.',
    },
  }),
  reminder(3, PISTA, {
    level: 4,
    step: {
      offsetDays: 60,
      words: { en: '60 days late', it: '60 giorni di ritardo' },
    },
    action: 'CALL',
    byHand: true,
    invoices: [
      {
        id: uid('4141', 120),
        number: 'FT-2026-00120',
        issueDate: '2026-06-30',
        dueDate: '2026-07-31',
        openNow: 183000,
      },
    ],
    amountDue: 183000,
    oldestDueDate: '2026-07-31',
    preparedBy: { id: uid('5151', 1), name: 'Anna Demo' },
  }),
]

export const SWITCH_OFF: ReceivablesSettings = {
  companyId: COMPANY.id,
  source: 'COMPANY',
  switch: {
    on: false,
    words: 'Reminders are switched off.',
    blockers: [
      {
        code: 'INTEREST_UNDECIDED',
        words: 'The late-payment interest rule is not decided yet.',
      },
    ],
    mayChange: false,
  },
  interest: { mode: 'UNDECIDED', words: 'Not decided.' },
  wording: { toConfirm: true, words: 'Placeholders.' },
  mayManage: true,
}
export const SWITCH_ON: ReceivablesSettings = {
  ...SWITCH_OFF,
  switch: {
    on: true,
    words: 'Reminders are switched on.',
    blockers: [],
    mayChange: false,
  },
  interest: { mode: 'NONE', words: 'No interest.' },
}

/**
 * Gamma Demo's statement, 1 January → 31 October: opening 0; invoices 2,440.00 + 3,660.00 + 6,100.00 + 4,880.00 = 17,080.00;
 * payment 4,880.00 (15 September, FT-2026-00098 paid); closing 12,200.00 = 17,080.00 − 4,880.00.
 */
export const STATEMENT: Statement = {
  company: COMPANY,
  customer: { ...GAMMA, language: 'it' },
  currency: 'EUR',
  currencies: [],
  from: '2026-01-01',
  to: TODAY,
  opening: 0,
  closing: 1220000,
  totals: { invoiced: 1708000, credited: 0, paid: 488000, refunded: 0 },
  lines: [
    {
      kind: 'INVOICE',
      date: '2026-06-30',
      recordType: 'Invoice',
      recordId: uid('4141', 98),
      reference: 'FT-2026-00098',
      docType: 'TD01',
      dueDate: '2026-07-31',
      label: 'Invoice FT-2026-00098',
      debit: 488000,
      credit: 0,
      balance: 488000,
    },
    {
      kind: 'INVOICE',
      date: '2026-07-31',
      recordType: 'Invoice',
      recordId: uid('4141', 141),
      reference: 'FT-2026-00141',
      docType: 'TD01',
      dueDate: '2026-08-31',
      label: 'Invoice FT-2026-00141',
      debit: 610000,
      credit: 0,
      balance: 1098000,
    },
    {
      kind: 'PAYMENT',
      date: '2026-09-15',
      recordType: 'Payment',
      recordId: uid('6161', 1),
      reference: 'CRO 0001-DEMO',
      docType: null,
      dueDate: null,
      label: 'Payment CRO 0001-DEMO',
      debit: 0,
      credit: 488000,
      balance: 610000,
    },
    {
      kind: 'INVOICE',
      date: '2026-09-30',
      recordType: 'Invoice',
      recordId: uid('4141', 172),
      reference: 'FT-2026-00172',
      docType: 'TD01',
      dueDate: '2026-10-30',
      label: 'Invoice FT-2026-00172',
      debit: 366000,
      credit: 0,
      balance: 976000,
    },
    {
      kind: 'INVOICE',
      date: '2026-10-31',
      recordType: 'Invoice',
      recordId: uid('4141', 190),
      reference: 'FT-2026-00190',
      docType: 'TD01',
      dueDate: '2026-11-30',
      label: 'Invoice FT-2026-00190',
      debit: 244000,
      credit: 0,
      balance: 1220000,
    },
  ],
  openItems: [
    {
      invoiceId: uid('4141', 141),
      number: 'FT-2026-00141',
      docType: 'TD01',
      issueDate: '2026-07-31',
      dueDate: '2026-08-31',
      dueDateKnown: true,
      open: 610000,
      bucket: 'D61_90',
      daysLate: 61,
    },
    {
      invoiceId: uid('4141', 172),
      number: 'FT-2026-00172',
      docType: 'TD01',
      issueDate: '2026-09-30',
      dueDate: '2026-10-30',
      dueDateKnown: true,
      open: 366000,
      bucket: 'D1_30',
      daysLate: 1,
    },
    {
      invoiceId: uid('4141', 190),
      number: 'FT-2026-00190',
      docType: 'TD01',
      issueDate: '2026-10-31',
      dueDate: '2026-11-30',
      dueDateKnown: true,
      open: 244000,
      bucket: 'NOT_DUE',
      daysLate: 0,
    },
  ],
  ageing: {
    open: 1220000,
    overdue: 976000,
    buckets: {
      NOT_DUE: 244000,
      D1_30: 366000,
      D31_60: 0,
      D61_90: 610000,
      OVER_90: 0,
    },
  },
  remindersSent: 2,
  recipients: [
    {
      name: 'Ufficio amministrazione Gamma Demo',
      email: 'amministrazione@gamma-demo.example',
    },
  ],
}

const PRICE_KEYS = new Set(['open', 'overdue', 'buckets', 'debit', 'credit', 'balance', 'opening', 'closing', 'totals', 'ageing', 'amountDue', 'interestAmount', 'openNow', 'text'])

/** What the API sends a person without the price grain: every amount (and a reminder's text) left out. */
export function withoutPrice<T>(value: T): T {
  const strip = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(strip)
    if (entry === null || typeof entry !== 'object') return entry
    return Object.fromEntries(
      Object.entries(entry as Record<string, unknown>)
        .filter(([key]) => !PRICE_KEYS.has(key))
        .map(([key, inner]) => [key, strip(inner)]),
    )
  }
  return strip(value) as T
}
