import { STEP_UP_CLOSED } from '../../../_shared/hooks'
import type { Check, ExportFile, ExportRecord, PackageContent, PeriodAnswer } from '../../api'
import { ADDRESS, at, canAs, COMPANY, EXPORT_DONE, HISTORY, INTRASTAT_OCTOBER, NOW, OCTOBER, OCTOBER_CHECKS, OCTOBER_CONTENTS, PERIODS_2025, PERIODS_2026, PREFIX, TODAY, type Role } from '../../demo/fixtures'
import { defaultPackages, recentMonths, type WizardStep } from '../../model'
import type { AccountingModel, LockDialogModel, LockPanelModel, WizardModel } from '../../view-model'
import type { IntegrityAnswer, IntegrityCheck } from '../api'
import type { IntegrityModel } from '../use-integrity'

/**
 * Made-up data for the accountant's bridge on the export wizard (SCR-482) and the nightly checks every 2 · Checks case
 * shows (SCR-156): October 2026 of the invented "Officina Demo S.r.l." with its cost of goods sold and variances, its VAT
 * registers, two work orders completed and not closed, three keys without an account while the journals are on; and the
 * nightly checks (all passed; two failing). Every figure worked out by hand in the comments; no real company, person,
 * document or number. Design-only.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

// ---- the nightly checks ------------------------------------------------------------------------------------------------------

const NIGHT = at(30, 3, 10)
const passed = (code: IntegrityCheck['code']): IntegrityCheck => ({
  code,
  result: 'PASSED',
  ranAt: NIGHT,
  ranBy: null,
  failureCount: 0,
  failures: [],
  history: [29, 28, 27, 26, 25].map((day) => ({ ranAt: at(day, 3, 10), result: 'PASSED' as const, failureCount: 0 })),
})

const ALL_PASSED: IntegrityCheck[] = (['INVOICE_TOTALS_EQUAL_LINES', 'SUPPLIER_INVOICE_TOTALS_EQUAL_LINES', 'ALLOCATIONS_WITHIN_PAYMENTS', 'PAYMENTS_PLACED', 'LEDGER_BALANCES', 'EXPORTED_DOCUMENTS_UNCHANGED'] as const).map(passed)

export const INTEGRITY_PASSED: IntegrityAnswer = {
  company: COMPANY,
  window: { from: '2025-10-01', to: '2026-10-30' },
  lastRunAt: NIGHT,
  failing: 0,
  checks: ALL_PASSED,
  can: { run: true },
}

/**
 * Two checks fail: a payment of 1,500.00 not placed (BONIFICO-DEMO-4471), and two documents of EXP-2026-0003 changed after
 * it was handed over (invoice FT-2026-00027 corrected, payment BONIFICO-DEMO-4410 re-dated); the second one ran by Fiona
 * Conti this morning, after the nightly run.
 */
export const INTEGRITY_FAILING: IntegrityAnswer = {
  ...INTEGRITY_PASSED,
  failing: 2,
  lastRunAt: at(30, 8, 15),
  checks: ALL_PASSED.map((check) =>
    check.code === 'PAYMENTS_PLACED'
      ? { ...check, result: 'FAILED', failureCount: 1, failures: [{ recordType: 'Payment', recordId: uid('f6f6', 1), code: 'NOT_PLACED', number: 'BONIFICO-DEMO-4471' }] }
      : check.code === 'EXPORTED_DOCUMENTS_UNCHANGED'
        ? {
            ...check,
            result: 'FAILED',
            ranAt: at(30, 8, 15),
            ranBy: { id: uid('3333', 7), name: 'Fiona Conti' },
            failureCount: 2,
            failures: [
              { recordType: 'Invoice', recordId: uid('a7a7', 27), code: 'CHANGED_AFTER_EXPORT', number: 'FT-2026-00027' },
              { recordType: 'Payment', recordId: uid('f6f6', 10), code: 'CHANGED_AFTER_EXPORT', number: 'BONIFICO-DEMO-4410' },
            ],
            history: [{ ranAt: NIGHT, result: 'PASSED', failureCount: 0 }, ...check.history.slice(0, 4)],
          }
        : check,
  ),
}

/** A company where the checks never ran yet (a new company: the first nightly run is tonight). */
export const INTEGRITY_NEVER: IntegrityAnswer = { ...INTEGRITY_PASSED, lastRunAt: null, checks: ALL_PASSED.map((check) => ({ ...check, result: null, ranAt: null, history: [] })) }

const shown = (value: IntegrityAnswer, over: Partial<IntegrityModel> = {}): IntegrityModel => ({ value, problem: null, running: false, runProblem: null, ...over })

/** What every 2 · Checks case of SCR-156 shows under its checks: the nightly run, all passed. */
export const INTEGRITY_SHOWN: IntegrityModel = shown(INTEGRITY_PASSED)
export const INTEGRITY_CASES = {
  failing: shown(INTEGRITY_FAILING),
  never: shown(INTEGRITY_NEVER),
  running: shown(INTEGRITY_FAILING, { running: true }),
  reader: shown({ ...INTEGRITY_FAILING, can: { run: false } }),
  loading: { value: null, problem: null, running: false, runProblem: null } satisfies IntegrityModel,
  error: { value: null, problem: 'problem.read.unavailable', running: false, runProblem: null } satisfies IntegrityModel,
}

// ---- October with the bridge -----------------------------------------------------------------------------------------------

const check = (code: Check['code'], passedIt: boolean, count = 0, fixes: Check['fixes'] = []): Check => ({ code, passed: passedIt, count, fixes, explanation: null })

/** The bridge's checks: two work orders completed and not closed, three keys with no account, every entry balanced. */
export const BRIDGE_CHECKS: Check[] = [
  check('WORK_ORDERS_CLOSED', false, 2, [
    { recordType: 'WorkOrder', recordId: uid('4260', 41), number: 'WO-2026-0041', field: null },
    { recordType: 'WorkOrder', recordId: uid('4260', 44), number: 'WO-2026-0044', field: null },
  ]),
  check('MAPPING_COMPLETE', false, 3, [
    { recordType: 'AccountMapping', recordId: 'ITEM_GROUP/SALES_FREIGHT', number: 'SALES_FREIGHT', field: 'ITEM_GROUP' },
    { recordType: 'AccountMapping', recordId: 'COST_CATEGORY/VARIANCE_SCRAP', number: 'VARIANCE_SCRAP', field: 'COST_CATEGORY' },
    { recordType: 'AccountMapping', recordId: 'PARTY_GROUP/CUSTOMERS_EU', number: 'CUSTOMERS_EU', field: 'PARTY_GROUP' },
  ]),
  check('ENTRIES_BALANCE', true),
]

const content = (pkg: PackageContent['package'], documents: number, rows: number, sums: { price?: PackageContent['priceTotals']; cost?: PackageContent['costTotals'] }, grain: 'price' | 'cost', scope: 'DOCUMENTS' | 'WHOLE'): PackageContent => ({
  package: pkg,
  available: true,
  grain,
  scope,
  documents: { package: pkg, documents, new: documents, changed: 0, removed: 0, same: 0 },
  rows,
  priceTotals: sums.price ?? [],
  costTotals: sums.cost ?? [],
})

/**
 * October's bridge packages. Cost of goods sold: 24 jackets at 310.00 = 7,440.00 over 6 entries; two work orders' variances
 * 120.00 + 66.50 = 186.50; purchase price variance +60.00 − 18.00 + 2.00 = 44.00 over 3 receipts — 11 documents. VAT
 * registers: sales VAT 2,728.00 (the sales journal's), purchases VAT 1,056.00 (the purchases journal's), VAT due 2,728.00 −
 * 1,056.00 = 1,672.00 — 9 documents on 12 rows (8 sales rows + 4 purchase rows).
 */
export const BRIDGE_CONTENTS: PackageContent[] = [
  content('COST_OF_SALES', 11, 11, { cost: [{ key: 'COST_OF_SALES', currency: 'EUR', amount: 744000 }, { key: 'VARIANCE', currency: 'EUR', amount: 18650 }, { key: 'PPV', currency: 'EUR', amount: 4400 }] }, 'cost', 'DOCUMENTS'),
  content('VAT_REGISTERS', 9, 12, { price: [{ key: 'SALES_VAT', currency: 'EUR', amount: 272800 }, { key: 'VAT_DUE', currency: 'EUR', amount: 167200 }], cost: [{ key: 'PURCHASES_VAT', currency: 'EUR', amount: 105600 }] }, 'price', 'WHOLE'),
]

/** October read with every package, the journals off: the bridge's packages offered, "work orders closed" with them. */
export const OCTOBER_BRIDGE: PeriodAnswer = {
  ...OCTOBER,
  packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS', 'INTRASTAT'],
  checks: [...OCTOBER_CHECKS, ...BRIDGE_CHECKS.filter((entry) => entry.code === 'WORK_ORDERS_CLOSED')],
  failing: 5,
  contents: [...OCTOBER_CONTENTS.slice(0, 3), ...BRIDGE_CONTENTS, ...OCTOBER_CONTENTS.slice(3)],
}

/** The same month with the journals switched on: "Every account mapped" (3 keys) and "Journal entries balance" join. */
export const OCTOBER_JOURNALS: PeriodAnswer = { ...OCTOBER_BRIDGE, journals: { on: true }, checks: [...OCTOBER_CHECKS, ...BRIDGE_CHECKS], failing: 6 }

/** What a person without the cost grain is answered: the cost sums absent. */
export const withoutCostSums = (answer: PeriodAnswer): PeriodAnswer => ({ ...answer, contents: answer.contents.map((entry) => ({ ...entry, costTotals: entry.costTotals.map(({ key, currency }) => ({ key, currency })) })) })

const file = (n: number, pkg: ExportFile['package'], name: string, rows: number, size: number): ExportFile => ({
  id: uid('4261', n),
  seq: n,
  package: pkg,
  format: 'CSV',
  rowCount: rows,
  file: { id: uid('4262', n), name, contentType: 'text/csv', sizeBytes: size, sha256: '0'.repeat(64) },
})

/** EXP-2026-0004 made with the bridge: each journal with its entries file, the cost of goods sold, the VAT registers. */
export const EXPORT_DONE_BRIDGE: ExportRecord = {
  ...EXPORT_DONE,
  packages: ['SALES_JOURNAL', 'PURCHASES_JOURNAL', 'PAYMENTS', 'COST_OF_SALES', 'VAT_REGISTERS'],
  files: [
    file(1, 'SALES_JOURNAL', 'DEMO_2026-10_sales-journal.csv', 8, 2034),
    file(2, 'SALES_JOURNAL', 'DEMO_2026-10_sales-journal_entries.csv', 24, 3110),
    file(3, 'PURCHASES_JOURNAL', 'DEMO_2026-10_purchases-journal.csv', 4, 1120),
    file(4, 'PURCHASES_JOURNAL', 'DEMO_2026-10_purchases-journal_entries.csv', 12, 1650),
    file(5, 'PAYMENTS', 'DEMO_2026-10_payments.csv', 5, 1310),
    file(6, 'PAYMENTS', 'DEMO_2026-10_payments_entries.csv', 10, 1290),
    file(7, 'COST_OF_SALES', 'DEMO_2026-10_cost-of-sales.csv', 11, 1480),
    file(8, 'COST_OF_SALES', 'DEMO_2026-10_cost-of-sales_entries.csv', 22, 2210),
    file(9, 'VAT_REGISTERS', 'DEMO_2026-10_vat-registers_sales.csv', 8, 1720),
    file(10, 'VAT_REGISTERS', 'DEMO_2026-10_vat-registers_purchases.csv', 4, 980),
    file(11, 'VAT_REGISTERS', 'DEMO_2026-10_vat-registers_totals.csv', 3, 420),
  ],
  contents: [
    { package: 'SALES_JOURNAL', new: 6, changed: 0, removed: 0 },
    { package: 'PURCHASES_JOURNAL', new: 3, changed: 0, removed: 0 },
    { package: 'PAYMENTS', new: 4, changed: 0, removed: 0 },
    { package: 'COST_OF_SALES', new: 11, changed: 0, removed: 0 },
    { package: 'VAT_REGISTERS', new: 9, changed: 0, removed: 0 },
  ],
  checks: [...EXPORT_DONE.checks, ...BRIDGE_CHECKS.map((entry) => (entry.passed ? entry : { ...entry, explanation: entry.code === 'WORK_ORDERS_CLOSED' ? 'Chiusura costi dei due ordini a inizio novembre.' : 'Conti da confermare con lo studio.' }))],
}

// ---- the page builders the bridge's design cases share (SCR-481, SCR-482) ------------------------------------------------------

export const lockPanelOf = (month: string | null, over: Partial<LockPanelModel> = {}): LockPanelModel => ({
  month,
  current: null,
  level: 'SOFT',
  phrase: '',
  note: '',
  busy: false,
  problem: null,
  done: null,
  liftReason: '',
  liftBusy: false,
  liftProblem: null,
  lifted: null,
  hardOpen: false,
  closeProblems: [],
  ...over,
})

export const lockDialogOf = (month: string | null, over: Partial<LockDialogModel> = {}): LockDialogModel => ({
  ...lockPanelOf(month),
  months: recentMonths(TODAY, [PERIODS_2026, PERIODS_2025], 12).map((entry) => ({ month: entry.month, state: entry.state })),
  readProblem: null,
  ...over,
})

/** The export page as a role sees it (the history, unless a wizard is given). */
export const accountingPageOf = (role: Role, over: Partial<AccountingModel> = {}): AccountingModel => ({
  prefix: PREFIX,
  can: canAs(role),
  today: TODAY,
  address: ADDRESS,
  live: 'live',
  now: NOW,
  recent: recentMonths(TODAY, [PERIODS_2026, PERIODS_2025]),
  history: { rows: HISTORY, more: false, problem: null, slow: false, readAt: NOW - 90_000 },
  updates: 0,
  wizard: null,
  lockDialog: null,
  cancelDialog: null,
  stepUp: STEP_UP_CLOSED,
  notice: null,
  ...over,
})

/** Every failing check of October explained (the bridge's too), so a later step is not held. */
export const EXPLAINED_ALL = {
  PERIOD_ENDED: 'Anticipo per lo studio: a novembre la riesportazione con il resto del mese.',
  SHIPMENTS_INVOICED: 'I due DDT si fatturano a fine mese (fattura differita).',
  PAYMENTS_PLACED: 'Bonifico in attesa del riferimento del cliente.',
  INTRASTAT_COMPLETE: 'Codice NC da confermare con lo spedizioniere.',
  WORK_ORDERS_CLOSED: 'Chiusura costi dei due ordini a inizio novembre.',
  MAPPING_COMPLETE: 'Conti da confermare con lo studio.',
}

/** The wizard on October at a step (the month read with every package; the given packages chosen). */
export const wizardPageOf = (role: Role, step: WizardStep, over: Partial<WizardModel> = {}, answer: PeriodAnswer = OCTOBER_BRIDGE): AccountingModel => {
  const month = over.month === undefined ? '2026-10' : over.month
  const wizard: WizardModel = {
    step,
    month,
    year: 2026,
    periods: { value: PERIODS_2026, problem: null },
    period: { value: answer, problem: null },
    pending: null,
    chosen: defaultPackages(answer, canAs(role)),
    explanations: {},
    intrastat: { value: INTRASTAT_OCTOBER, problem: null },
    language: 'it',
    note: '',
    exporting: { busy: false, startedAt: null, problem: null, done: null },
    lock: lockPanelOf(month),
    heldNote: null,
    integrity: INTEGRITY_SHOWN,
    ...over,
  }
  return accountingPageOf(role, { address: { ...ADDRESS, wizard: true, month, step }, wizard })
}
