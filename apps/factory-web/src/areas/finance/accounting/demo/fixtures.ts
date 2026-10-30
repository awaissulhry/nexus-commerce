import { createElement, type ReactNode } from 'react'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import type { Check, ExportFile, ExportRecord, ExportRow, Intrastat, MonthView, PackageContent, PeriodAnswer, PeriodLock, Periods } from '../api'
import { accountingCanOf, addressOf, type AccountingCan } from '../model'

/**
 * Made-up batches, months, checks, Intrastat rows and locks for the design cases of SCR-156 (Accounting export, its
 * wizard and its files tab): an invented company ("Officina Demo S.r.l."), customers ("Esempio Racing GmbH", "Squadra
 * Fittizia SARL") with visibly fake VAT IDs, a style "DEMO-JKT-01", people ("Fiona Conti") and numbers; every sum worked
 * out by hand (in the comments). August 2026 is EXP-2026-0001 and closed for good; September EXP-2026-0002 then its
 * re-export EXP-2026-0003, soft-locked; October has an unfinished draft and is not over (today 30 October); the next
 * number is EXP-2026-0004. Nothing here is a real company, person, invoice or number. Design-only.
 */

export const PREFIX = '/w/DEMO'
export const TODAY = '2026-10-30'
export const NOW = Date.parse('2026-10-30T08:40:00.000Z')
const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
export const COMPANY = { ...DEMO_COMPANIES[0] }
const FIONA = { id: uid('3333', 7), name: 'Fiona Conti' }
const OWNER = { id: uid('3333', 1), name: 'Alex Demo' }
export const at = (day: number, hour: number, minute = 0, month = 10) => new Date(Date.UTC(2026, month - 1, day, hour, minute)).toISOString()

// ---- roles -------------------------------------------------------------------------------------------------------------------

const BASE = ['home.view', 'threads.read', 'threads.post', 'files.read', 'invoices.view', 'payments.view']
export const ROLES = {
  owner: [...OWNER_PERMISSIONS, 'invoices.view', 'payments.view', 'inventory.stock.view', 'accounting.view', 'accounting.export', 'accounting.lock', 'accounting.unlock', 'money.price', 'money.cost', 'money.margin'],
  finance: [...BASE, 'inventory.stock.view', 'accounting.view', 'accounting.export', 'accounting.lock', 'money.price', 'money.cost', 'money.margin'],
  /** A finance person without the cost grain (a made-up custom role): the purchases journal and the year-end pack are held. */
  financePrice: [...BASE, 'accounting.view', 'accounting.export', 'accounting.lock', 'money.price'],
  /** Read only: sees the batches and the months, makes nothing. */
  reader: [...BASE, 'inventory.stock.view', 'accounting.view'],
  sales: ['home.view', 'threads.read', 'orders.view', 'quotes.view', 'money.price', 'money.margin'],
} as const
export type Role = keyof typeof ROLES
export const canAs = (role: Role): AccountingCan => accountingCanOf(ROLES[role])

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

export const ADDRESS = addressOf(null)

// ---- months and locks -------------------------------------------------------------------------------------------------------------

const MONTH_NAMES = {
  en: ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'],
  it: ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'],
}
const pad = (value: number) => String(value).padStart(2, '0')
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate()
export const periodOf = (month: string) => {
  const year = Number(month.slice(0, 4))
  const number = Number(month.slice(5, 7))
  return { month, start: `${month}-01`, end: `${month}-${pad(lastDay(year, number))}`, label: `${MONTH_NAMES.en[number - 1]} ${year}`, labelIt: `${MONTH_NAMES.it[number - 1]} ${year}` }
}

const EXP1 = uid('a1a1', 1)
const EXP2 = uid('a1a1', 2)
const EXP3 = uid('a1a1', 3)
const DRAFT_OCT = uid('a1a1', 9)
export const EXP4 = uid('a1a1', 4)

export const LOCK_AUGUST: PeriodLock = {
  id: uid('b2b2', 8),
  companyId: COMPANY.id,
  period: periodOf('2026-08'),
  level: 'HARD',
  status: 'LOCKED',
  lockedAt: at(10, 9, 30, 9),
  lockedBy: OWNER,
  note: null,
  export: { id: EXP1, number: 'EXP-2026-0001', status: 'EXPORTED' },
  unlockedAt: null,
  unlockedBy: null,
  unlockReason: null,
  version: 2,
}

export const LOCK_SEPTEMBER: PeriodLock = {
  id: uid('b2b2', 9),
  companyId: COMPANY.id,
  period: periodOf('2026-09'),
  level: 'SOFT',
  status: 'LOCKED',
  lockedAt: at(8, 15, 10),
  lockedBy: FIONA,
  note: 'Consegnato allo studio il 7 ottobre.',
  export: { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED' },
  unlockedAt: null,
  unlockedBy: null,
  unlockReason: null,
  version: 1,
}

const ref = (lock: PeriodLock) => ({ id: lock.id, level: lock.level, status: lock.status, version: lock.version })

const month = (number: number, over: Partial<MonthView> = {}): MonthView => ({
  period: periodOf(`2026-${pad(number)}`),
  ended: number < 10,
  lock: null,
  exports: [],
  latest: null,
  ...over,
})

export const PERIODS_2026: Periods = {
  company: COMPANY,
  year: 2026,
  yearEndMonth: '2026-12',
  months: [
    ...Array.from({ length: 7 }, (_, index) => month(index + 1)),
    month(8, { lock: ref(LOCK_AUGUST), exports: [{ id: EXP1, number: 'EXP-2026-0001', status: 'EXPORTED', exportedAt: at(9, 16, 0, 9), supersedesId: null }], latest: { id: EXP1, number: 'EXP-2026-0001', status: 'EXPORTED' } }),
    month(9, {
      lock: ref(LOCK_SEPTEMBER),
      exports: [
        { id: EXP2, number: 'EXP-2026-0002', status: 'EXPORTED', exportedAt: at(5, 11, 0), supersedesId: null },
        { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED', exportedAt: at(7, 10, 20), supersedesId: EXP2 },
      ],
      latest: { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED' },
    }),
    month(10, { exports: [{ id: DRAFT_OCT, number: null, status: 'DRAFT', exportedAt: null, supersedesId: null }] }),
    month(11, { ended: false }),
    month(12, { ended: false }),
  ],
}

export const PERIODS_2025: Periods = { company: COMPANY, year: 2025, yearEndMonth: '2025-12', months: Array.from({ length: 12 }, (_, index) => ({ ...month(index + 1), period: periodOf(`2025-${pad(index + 1)}`), ended: true })) }

// ---- the history ---------------------------------------------------------------------------------------------------------------

const file = (n: number, pkg: ExportFile['package'], name: string, rows: number, size: number, format = 'CSV'): ExportFile => ({
  id: uid('c3c3', n),
  seq: n,
  package: pkg,
  format,
  rowCount: rows,
  file: { id: uid('d4d4', n), name, contentType: format === 'PDF' ? 'application/pdf' : 'text/csv', sizeBytes: size, sha256: '0'.repeat(64) },
})

const row = (over: Partial<ExportRow> & Pick<ExportRow, 'id' | 'period' | 'status'>): ExportRow => ({
  number: null,
  company: COMPANY,
  packages: [],
  layout: 'DEFAULT',
  supersedes: null,
  supersededBy: null,
  files: [],
  contents: [],
  madeBy: FIONA,
  createdAt: at(5, 10, 0),
  exportedAt: null,
  exportedBy: null,
  cancelledAt: null,
  cancelReason: null,
  note: null,
  changedSince: null,
  version: 1,
  ...over,
})

export const HISTORY: ExportRow[] = [
  row({ id: DRAFT_OCT, period: periodOf('2026-10'), status: 'DRAFT', packages: ['SALES_JOURNAL', 'PAYMENTS'], contents: [{ package: 'SALES_JOURNAL', new: 4, changed: 0, removed: 0 }], createdAt: at(29, 17, 5) }),
  row({
    id: EXP3,
    number: 'EXP-2026-0003',
    period: periodOf('2026-09'),
    status: 'EXPORTED',
    packages: ['SALES_JOURNAL', 'PAYMENTS'],
    supersedes: { id: EXP2, number: 'EXP-2026-0002', status: 'EXPORTED' },
    files: [file(5, 'SALES_JOURNAL', 'DEMO_2026-09_sales-journal_changes.csv', 3, 912), file(6, 'PAYMENTS', 'DEMO_2026-09_payments_changes.csv', 1, 388)],
    contents: [
      { package: 'SALES_JOURNAL', new: 1, changed: 1, removed: 0 },
      { package: 'PAYMENTS', new: 0, changed: 0, removed: 1 },
    ],
    createdAt: at(7, 10, 18),
    exportedAt: at(7, 10, 20),
    exportedBy: FIONA,
    changedSince: { count: 2, packages: [{ package: 'SALES_JOURNAL', documents: 7, new: 1, changed: 1, removed: 0, same: 5 }] },
    version: 2,
  }),
  row({
    id: EXP2,
    number: 'EXP-2026-0002',
    period: periodOf('2026-09'),
    status: 'EXPORTED',
    packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'],
    supersededBy: { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED' },
    files: [
      file(1, 'SALES_JOURNAL', 'DEMO_2026-09_sales-journal.csv', 7, 1830),
      file(2, 'PURCHASES_JOURNAL', 'DEMO_2026-09_purchases-journal.csv', 4, 1104),
      file(3, 'PAYMENTS', 'DEMO_2026-09_payments.csv', 5, 1290),
      file(4, 'INTRASTAT', 'DEMO_2026-09_intrastat.csv', 1, 402),
    ],
    contents: [
      { package: 'SALES_JOURNAL', new: 6, changed: 0, removed: 0 },
      { package: 'PURCHASES_JOURNAL', new: 3, changed: 0, removed: 0 },
      { package: 'PAYMENTS', new: 4, changed: 0, removed: 0 },
      { package: 'INTRASTAT', new: 1, changed: 0, removed: 0 },
    ],
    createdAt: at(5, 10, 58),
    exportedAt: at(5, 11, 0),
    exportedBy: FIONA,
    version: 2,
  }),
  row({
    id: EXP1,
    number: 'EXP-2026-0001',
    period: periodOf('2026-08'),
    status: 'EXPORTED',
    packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS'],
    files: [file(7, 'SALES_JOURNAL', 'DEMO_2026-08_sales-journal.csv', 5, 1402), file(8, 'PURCHASES_JOURNAL', 'DEMO_2026-08_purchases-journal.csv', 2, 760), file(9, 'PAYMENTS', 'DEMO_2026-08_payments.csv', 3, 870)],
    contents: [
      { package: 'SALES_JOURNAL', new: 5, changed: 0, removed: 0 },
      { package: 'PURCHASES_JOURNAL', new: 2, changed: 0, removed: 0 },
      { package: 'PAYMENTS', new: 3, changed: 0, removed: 0 },
    ],
    createdAt: at(9, 15, 55, 9),
    exportedAt: at(9, 16, 0, 9),
    exportedBy: OWNER,
    changedSince: { count: 0, packages: [] },
    version: 2,
  }),
]

// ---- October: the wizard's month ---------------------------------------------------------------------------------------------------

const check = (code: Check['code'], passed: boolean, count = 0, fixes: Check['fixes'] = []): Check => ({ code, passed, count, fixes, explanation: null })

export const OCTOBER_CHECKS: Check[] = [
  check('PERIOD_ENDED', false, 0),
  check('SHIPMENTS_INVOICED', false, 2, [
    { recordType: 'Ddt', recordId: uid('e5e5', 31), number: 'DDT-2026-0031', field: null },
    { recordType: 'Ddt', recordId: uid('e5e5', 33), number: 'DDT-2026-0033', field: null },
  ]),
  check('NO_INVOICE_REJECTED', true),
  check('PAYMENTS_PLACED', false, 1, [{ recordType: 'Payment', recordId: uid('f6f6', 1), number: 'BONIFICO-DEMO-4471', field: null }]),
  check('PLACEMENTS_WITHIN_PAYMENTS', true),
  check('TOTALS_EQUAL_ROWS', true),
  check('INTRASTAT_COMPLETE', false, 1, [{ recordType: 'Style', recordId: uid('7777', 1), number: 'DEMO-JKT-01', field: 'hsCode' }]),
]

const content = (pkg: PackageContent['package'], documents: number, rows: number, sums: { price?: PackageContent['priceTotals']; cost?: PackageContent['costTotals'] } = {}, diff?: Partial<PackageContent['documents']>): PackageContent => ({
  package: pkg,
  available: true,
  grain: pkg === 'PURCHASES_JOURNAL' || pkg === 'YEAR_END_STOCK' ? 'cost' : 'price',
  scope: pkg === 'INTRASTAT' || pkg === 'YEAR_END_STOCK' ? 'WHOLE' : 'DOCUMENTS',
  documents: { package: pkg, documents, new: documents, changed: 0, removed: 0, same: 0, ...diff },
  rows,
  priceTotals: sums.price ?? [],
  costTotals: sums.cost ?? [],
})

/**
 * October's contents: sales 12,400.00 taxable + 22 % VAT 2,728.00 = 15,128.00; purchases 4,800.00 + 1,056.00 = 5,856.00;
 * payments received 9,132.00 of which 1,500.00 not placed; Intrastat 5,400.00 (12 jackets × 450.00) + 1,320.00 (2 × 660.00)
 * = 6,720.00.
 */
export const OCTOBER_CONTENTS: PackageContent[] = [
  content('SALES_JOURNAL', 6, 8, { price: [{ key: 'TAXABLE', currency: 'EUR', amount: 1240000 }, { key: 'VAT', currency: 'EUR', amount: 272800 }, { key: 'GROSS', currency: 'EUR', amount: 1512800 }] }),
  content('PURCHASES_JOURNAL', 3, 4, { cost: [{ key: 'TAXABLE', currency: 'EUR', amount: 480000 }, { key: 'VAT', currency: 'EUR', amount: 105600 }, { key: 'GROSS', currency: 'EUR', amount: 585600 }] }),
  content('PAYMENTS', 4, 5, { price: [{ key: 'RECEIVED', currency: 'EUR', amount: 913200 }, { key: 'REFUNDED', currency: 'EUR', amount: 0 }, { key: 'NOT_PLACED', currency: 'EUR', amount: 150000 }] }),
  content('INTRASTAT', 2, 2, { price: [{ key: 'VALUE', currency: 'EUR', amount: 672000 }] }),
]

export const OCTOBER: PeriodAnswer = {
  company: COMPANY,
  period: periodOf('2026-10'),
  ended: false,
  yearEnd: false,
  lock: null,
  exports: [{ id: DRAFT_OCT, number: null, status: 'DRAFT', exportedAt: null }],
  reExportOf: null,
  draft: { id: DRAFT_OCT, number: null, status: 'DRAFT' },
  nextNumber: 'EXP-2026-0004',
  packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'],
  checks: OCTOBER_CHECKS,
  failing: 4,
  contents: OCTOBER_CONTENTS,
  intrastat: { rows: 2, fileRows: 2, blocking: 1, warnings: 1 },
  changes: 15,
  layout: 'DEFAULT',
}

/** The same month once the DDTs are invoiced and the payment placed (2 checks fixed). */
export const OCTOBER_FIXED: PeriodAnswer = {
  ...OCTOBER,
  checks: OCTOBER_CHECKS.map((entry) => (entry.code === 'SHIPMENTS_INVOICED' || entry.code === 'PAYMENTS_PLACED' ? { ...entry, passed: true, count: 0, fixes: [] } : entry)),
  failing: 2,
}

/** September, after EXP-2026-0003: one invoice changed and one new (a re-export carries those two; Intrastat whole again). */
export const SEPTEMBER: PeriodAnswer = {
  ...OCTOBER,
  period: periodOf('2026-09'),
  ended: true,
  lock: LOCK_SEPTEMBER,
  exports: [
    { id: EXP2, number: 'EXP-2026-0002', status: 'EXPORTED', exportedAt: at(5, 11, 0) },
    { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED', exportedAt: at(7, 10, 20) },
  ],
  reExportOf: { id: EXP3, number: 'EXP-2026-0003', status: 'EXPORTED' },
  draft: null,
  checks: OCTOBER_CHECKS.map((entry) => ({ ...entry, passed: true, count: 0, fixes: [] })),
  failing: 0,
  contents: [
    content('SALES_JOURNAL', 8, 2, { price: [{ key: 'TAXABLE', currency: 'EUR', amount: 90000 }, { key: 'VAT', currency: 'EUR', amount: 19800 }, { key: 'GROSS', currency: 'EUR', amount: 109800 }] }, { new: 1, changed: 1, removed: 0, same: 6 }),
    content('PURCHASES_JOURNAL', 3, 0, {}, { new: 0, changed: 0, removed: 0, same: 3 }),
    content('PAYMENTS', 4, 0, {}, { new: 0, changed: 0, removed: 0, same: 4 }),
    content('INTRASTAT', 1, 1, { price: [{ key: 'VALUE', currency: 'EUR', amount: 66000 }] }, { new: 0, changed: 1, removed: 0, same: 0 }),
  ],
  intrastat: { rows: 1, fileRows: 1, blocking: 0, warnings: 0 },
  changes: 3,
}

/** August, closed: nothing changed since EXP-2026-0001. */
export const AUGUST: PeriodAnswer = {
  ...SEPTEMBER,
  period: periodOf('2026-08'),
  lock: LOCK_AUGUST,
  exports: [{ id: EXP1, number: 'EXP-2026-0001', status: 'EXPORTED', exportedAt: at(9, 16, 0, 9) }],
  reExportOf: { id: EXP1, number: 'EXP-2026-0001', status: 'EXPORTED' },
  contents: [content('SALES_JOURNAL', 5, 0, {}, { new: 0, same: 5 }), content('PURCHASES_JOURNAL', 2, 0, {}, { new: 0, same: 2 }), content('PAYMENTS', 3, 0, {}, { new: 0, same: 3 })],
  intrastat: { rows: 0, fileRows: 0, blocking: 0, warnings: 0 },
  changes: 0,
}

/** What a person without the cost grain is answered: the cost sums absent. */
export function withoutCost(answer: PeriodAnswer): PeriodAnswer {
  return { ...answer, contents: answer.contents.map((entry) => ({ ...entry, costTotals: entry.costTotals.map(({ key, currency }) => ({ key, currency })) })) }
}

export const INTRASTAT_OCTOBER: Intrastat = {
  period: periodOf('2026-10'),
  rows: [
    {
      invoice: { id: uid('a7a7', 31), number: 'FT-2026-00031', docType: 'TD01', issueDate: '2026-10-20' },
      line: { id: uid('a8a8', 1), seq: 1, description: 'Giacca pelle demo DEMO-JKT-01' },
      style: { id: uid('7777', 1), code: 'DEMO-JKT-01' },
      partner: { id: uid('a9a9', 7), code: 'C-0007', name: 'Esempio Racing GmbH' },
      partnerVatId: 'DE000111222',
      destinationCountry: 'DE',
      cnCode: '420310',
      originCountry: 'IT',
      value: 540000,
      currency: 'EUR',
      netMassKg: '22.200',
      supplementaryUnits: '12',
      nature: 'SALE',
      suggestedNatureCode: '11',
      deliveryTerms: null,
      transportMode: null,
      flags: [
        { code: 'CN_CODE_SHORT', severity: 'BLOCKING', fix: { recordType: 'Style', recordId: uid('7777', 1), field: 'hsCode' } },
        { code: 'DELIVERY_TERMS_MISSING', severity: 'WARNING', fix: { recordType: 'Party', recordId: uid('a9a9', 7), field: 'incoterm' } },
      ],
    },
    {
      invoice: { id: uid('a7a7', 34), number: 'FT-2026-00034', docType: 'TD01', issueDate: '2026-10-27' },
      line: { id: uid('a8a8', 2), seq: 1, description: 'Giacca pelle demo DEMO-JKT-02' },
      style: { id: uid('7777', 2), code: 'DEMO-JKT-02' },
      partner: { id: uid('a9a9', 9), code: 'C-0009', name: 'Squadra Fittizia SARL' },
      partnerVatId: 'FR00111222333',
      destinationCountry: 'FR',
      cnCode: '42031000',
      originCountry: 'IT',
      value: 132000,
      currency: 'EUR',
      netMassKg: '3.700',
      supplementaryUnits: '2',
      nature: 'SALE',
      suggestedNatureCode: '11',
      deliveryTerms: 'DAP',
      transportMode: null,
      flags: [],
    },
  ],
  fileRows: [
    { partnerVatId: 'DE000111222', destinationCountry: 'DE', cnCode: '420310', documents: ['FT-2026-00031'] },
    { partnerVatId: 'FR00111222333', destinationCountry: 'FR', cnCode: '42031000', documents: ['FT-2026-00034'] },
  ],
  blocking: 1,
  warnings: 1,
  values: [{ currency: 'EUR', value: 672000 }],
}

export const INTRASTAT_EMPTY: Intrastat = { period: periodOf('2026-10'), rows: [], fileRows: [], blocking: 0, warnings: 0, values: [] }

/** EXP-2026-0004, just made: the three journals and Intrastat of October. */
export const EXPORT_DONE: ExportRecord = {
  ...row({
    id: EXP4,
    number: 'EXP-2026-0004',
    period: periodOf('2026-10'),
    status: 'EXPORTED',
    packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'INTRASTAT'],
    files: [
      file(11, 'SALES_JOURNAL', 'DEMO_2026-10_sales-journal.csv', 8, 2034),
      file(12, 'PURCHASES_JOURNAL', 'DEMO_2026-10_purchases-journal.csv', 4, 1120),
      file(13, 'PAYMENTS', 'DEMO_2026-10_payments.csv', 5, 1310),
      file(14, 'INTRASTAT', 'DEMO_2026-10_intrastat.csv', 2, 540),
    ],
    contents: [
      { package: 'SALES_JOURNAL', new: 6, changed: 0, removed: 0 },
      { package: 'PURCHASES_JOURNAL', new: 3, changed: 0, removed: 0 },
      { package: 'PAYMENTS', new: 4, changed: 0, removed: 0 },
      { package: 'INTRASTAT', new: 2, changed: 0, removed: 0 },
    ],
    createdAt: at(30, 8, 38),
    exportedAt: at(30, 8, 39),
    exportedBy: FIONA,
    note: 'Mese non ancora chiuso: riesportare a inizio novembre.',
    changedSince: { count: 0, packages: [] },
    version: 2,
  }),
  checks: OCTOBER_CHECKS.map((entry) =>
    entry.passed
      ? entry
      : { ...entry, explanation: entry.code === 'PERIOD_ENDED' ? 'Anticipo per lo studio: a novembre la riesportazione con il resto del mese.' : entry.code === 'SHIPMENTS_INVOICED' ? 'I due DDT si fatturano a fine mese (fattura differita).' : entry.code === 'PAYMENTS_PLACED' ? 'Bonifico in attesa del riferimento del cliente.' : 'Codice NC da confermare con lo spedizioniere.' },
  ),
  lock: null,
  actions: { reExport: { allowed: false }, cancel: { allowed: false }, lock: { allowed: true }, download: { allowed: true } },
}

export const RECORD_SEPTEMBER: ExportRecord = {
  ...HISTORY[1]!,
  checks: OCTOBER_CHECKS.map((entry) => ({ ...entry, passed: true, count: 0, fixes: [] })),
  lock: { id: LOCK_SEPTEMBER.id, level: 'SOFT', status: 'LOCKED' },
  actions: { reExport: { allowed: true }, cancel: { allowed: false }, lock: { allowed: true }, download: { allowed: true } },
}
