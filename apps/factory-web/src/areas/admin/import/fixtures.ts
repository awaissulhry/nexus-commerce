import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { at, inShell, PREFIX, USERS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { ImportJob, Importer, ImportRow, Layout } from './api'
import { blankDraft, emptyWizard, type ImportViewModel, type WizardModel } from './model'
import { ImportView } from './view/ImportView'
import type { FirstLoadStep, FirstLoadStepView } from './guided/api'
import { firstLoadLoading, type FirstLoadModel } from './guided/model'

/**
 * SCR-017 Import & export with made-up data: "Demo" companies, example.com people, invented codes, sheets and API
 * sentences. The opening-stock wizard at every step, the page's every state.
 */

const uid = (n: number) => `0190f0e2-4141-7000-8000-${String(n).padStart(12, '0')}`
const company = DEMO_COMPANIES[0].id

const column = (name: string, label: string, required = false, grain: string | null = null) => ({ name, label, aliases: [], required, grain, describe: null, values: null, description: null })
const IMPORTERS: Importer[] = [
  { key: 'parties.parties', label: 'Customers and suppliers', description: null, columns: [column('code', 'Code', true), column('legalName', 'Legal name')], keyColumns: ['code'], maxRows: 10000 },
  { key: 'product.materials', label: 'Materials', description: null, columns: [column('code', 'Code', true), column('standardCost', 'Standard cost', false, 'cost')], keyColumns: ['code'], maxRows: 10000 },
  { key: 'inventory.locations', label: 'Locations', description: null, columns: [column('site', 'Site', true), column('code', 'Code', true)], keyColumns: ['site', 'code'], maxRows: 10000 },
  { key: 'inventory.opening', label: 'Opening stock', description: null, columns: [column('line', 'Line', true), column('quantity', 'Quantity', true), column('unitCost', 'Unit cost', false, 'cost')], keyColumns: ['line'], maxRows: 10000 },
]

const LAYOUT: Layout = {
  format: 'xlsx',
  sheet: 'Giacenze',
  sheets: ['Giacenze', 'Colonne'],
  encoding: null,
  delimiter: null,
  headers: ['Riga', 'Sito', 'Ubicazione', 'Materiale', 'Colore', 'Lotto', 'Quantità', 'Unità', 'Note'],
  columns: [
    { index: 0, header: 'Riga', column: 'line' },
    { index: 1, header: 'Sito', column: 'site' },
    { index: 2, header: 'Ubicazione', column: 'location' },
    { index: 3, header: 'Materiale', column: 'item' },
    { index: 4, header: 'Colore', column: 'colour' },
    { index: 5, header: 'Lotto', column: 'lot' },
    { index: 6, header: 'Quantità', column: 'quantity' },
    { index: 7, header: 'Unità', column: 'unit' },
  ],
  ignored: [{ index: 8, header: 'Note', reason: 'Not a column of this import (ignored).' }],
}

const job = (n: number, extra: Partial<ImportJob>): ImportJob => ({
  id: uid(n),
  companyId: company,
  importerKey: 'inventory.opening',
  importerLabel: 'Opening stock',
  fileId: uid(100 + n),
  fileName: 'giacenze-iniziali-demo.xlsx',
  fileStatus: 'AVAILABLE',
  sheetName: null,
  encoding: null,
  numberFormat: 'it',
  mapping: null,
  layout: LAYOUT,
  status: 'PLANNED',
  mode: 'DRY_RUN',
  rowCount: 15,
  createCount: 12,
  updateCount: 0,
  unchangedCount: 0,
  errorCount: 3,
  appliedCount: 0,
  skippedCount: 0,
  issues: null,
  error: null,
  plannedAt: at(29, 9, 31),
  applyRequestedAt: null,
  appliedAt: null,
  cancelledAt: null,
  version: 3,
  createdAt: at(29, 9, 30),
  updatedAt: at(29, 9, 31),
  createdById: USERS[0]!.id,
  ...extra,
})

const PLANNED = job(1, {})
const CLEAN = job(2, { errorCount: 0, rowCount: 12, fileName: 'giacenze-iniziali-demo-v2.xlsx' })
const NOTHING = job(3, { createCount: 0, unchangedCount: 12, errorCount: 0, fileName: 'giacenze-iniziali-demo-v2.xlsx' })
const READING = job(4, { status: 'UPLOADED', layout: null, rowCount: 0, createCount: 0, errorCount: 0, plannedAt: null, version: 1 })
const APPLYING = job(5, { status: 'APPLYING', mode: 'DRY_RUN', errorCount: 0, appliedCount: 6, applyRequestedAt: at(29, 9, 35), version: 4 })
const APPLIED = job(6, { status: 'APPLIED', errorCount: 3, appliedCount: 10, skippedCount: 2, applyRequestedAt: at(29, 9, 35), appliedAt: at(29, 9, 36), version: 6 })
const PLAN_FAILED = job(7, {
  importerKey: 'product.materials',
  importerLabel: 'Materials',
  fileName: 'materiali-demo.csv',
  status: 'FAILED',
  layout: { ...LAYOUT, format: 'csv', sheet: null, sheets: [], encoding: 'utf-8', delimiter: ';', headers: ['Codice', 'Costo standard', 'Unita'], columns: [{ index: 0, header: 'Codice', column: 'code' }, { index: 1, header: 'Costo standard', column: 'standardCost' }], ignored: [] },
  rowCount: 0,
  createCount: 0,
  errorCount: 0,
  plannedAt: null,
  issues: [
    { path: 'column/standardCost', message: 'The column "Costo standard" holds cost values (the cost money grain), which may not be imported without that grain.' },
    { path: 'header/name', message: 'No column for "Name"; a new material needs it.' },
  ],
  error: 'The sheet cannot be imported as it is: see the issues.',
  version: 2,
  createdAt: at(28, 16, 5),
})
const APPLY_FAILED = job(8, {
  importerKey: 'parties.parties',
  importerLabel: 'Customers and suppliers',
  fileName: 'clienti-fornitori-demo.xlsx',
  status: 'FAILED',
  rowCount: 640,
  createCount: 410,
  updateCount: 180,
  unchangedCount: 46,
  errorCount: 4,
  appliedCount: 200,
  applyRequestedAt: at(27, 11, 2),
  error: 'Batch 2 stopped: the database did not answer in time.',
  version: 7,
  createdAt: at(27, 10, 50),
  createdById: USERS[1]!.id,
})
const CANCELLED = job(9, {
  importerKey: 'inventory.locations',
  importerLabel: 'Locations',
  fileName: 'ubicazioni-demo-nord.csv',
  status: 'CANCELLED',
  cancelledAt: at(26, 15, 20),
  createCount: 38,
  errorCount: 0,
  version: 4,
  createdAt: at(26, 15, 1),
  createdById: USERS[3]!.id,
})
const EARLIER = job(10, { status: 'APPLIED', errorCount: 0, createCount: 24, appliedCount: 24, appliedAt: at(20, 17, 12), createdAt: at(20, 17, 1), fileName: 'giacenze-magazzino-sud-demo.csv' })

const JOBS: ImportJob[] = [APPLIED, PLAN_FAILED, APPLY_FAILED, CANCELLED, EARLIER]
/** Recent imports with two that can still be cancelled: one being checked, one checked and not applied. */
const OPEN_JOBS: ImportJob[] = [READING, { ...PLANNED, fileName: 'ubicazioni-demo-nord.csv', importerKey: 'inventory.locations', importerLabel: 'Locations' }, ...JOBS]
const PICKED = [READING.id, PLANNED.id, APPLIED.id, APPLY_FAILED.id]

const refusedRow = (rowNumber: number, line: string, column: string, message: string): ImportRow => ({
  rowNumber,
  action: 'ERROR',
  key: JSON.stringify([line]),
  recordId: null,
  errors: [{ column, message }],
  before: undefined,
  after: undefined,
  outcome: null,
  note: null,
  appliedAt: null,
})
const REFUSED: ImportRow[] = [
  refusedRow(7, 'CS-0006', 'location', 'The location B-09 is not a location of site DN1.'),
  refusedRow(11, 'CS-0010', 'colour', 'The material PEL-DEMO-02 has colours: give its colour code.'),
  refusedRow(14, 'CS-0013', 'quantity', 'Expected a number greater than 0.'),
]
const createRow = (rowNumber: number, line: string, item: string, quantity: string, unit: string, lot: string | null): ImportRow => ({
  rowNumber,
  action: 'CREATE',
  key: JSON.stringify([line]),
  recordId: null,
  errors: null,
  before: undefined,
  after: { line, site: 'DN1', location: 'A-01', item, ...(lot ? { lot } : {}), quantity, unit },
  outcome: null,
  note: null,
  appliedAt: null,
})
const CHANGES: ImportRow[] = [
  createRow(2, 'CS-0001', 'PEL-DEMO-01', '108,1773', 'FT2', 'LT-DEMO-441'),
  createRow(3, 'CS-0002', 'FOD-DEMO-07', '120', 'M', 'LT-DEMO-102'),
  createRow(4, 'CS-0003', 'PRT-DEMO-03', '48', 'PZ', null),
]
const SKIPPED: ImportRow[] = [
  { ...createRow(5, 'CS-0004', 'PEL-DEMO-01', '96', 'FT2', 'LT-DEMO-441'), outcome: 'SKIPPED', note: 'Changed since the dry run: the lot LT-DEMO-441 was released meanwhile.' },
  { ...createRow(9, 'CS-0008', 'FOD-DEMO-07', '60', 'M', 'LT-DEMO-102'), outcome: 'SKIPPED', note: null },
]

const people = Object.fromEntries(USERS.map((user) => [user.id, user.displayName]))
const companies = DEMO_COMPANIES.map((item) => ({ id: item.id, name: item.name }))
const ALL = { view: true, run: true, apply: true, people: true }

// ---- the guided first load (B-W2a-41): made-up sheets and counts ----

const IMPORTER_OF: Readonly<Record<FirstLoadStep, string | null>> = { customers: 'parties.parties', suppliers: 'parties.parties', materials: 'product.materials', openingStock: 'inventory.opening', openOrders: null }
const stepView = (step: FirstLoadStep, over: Partial<FirstLoadStepView> = {}): FirstLoadStepView => ({
  step,
  importerKey: IMPORTER_OF[step],
  state: 'waiting',
  waitingFor: null,
  job: null,
  runningJobId: null,
  reconciliation: null,
  matches: null,
  differences: [],
  done: null,
  canImport: true,
  canMarkDone: true,
  ...over,
})
const PARTIES_JOB = { id: uid(41), fileName: 'clienti-fornitori-demo.xlsx', companyId: null, appliedAt: at(27, 11, 40), rowCount: 186 }
const PARTIES = { rows: 186, loaded: 186, refused: 0, skipped: 0, roles: { customers: 142, suppliers: 44 } }
const MATERIALS_JOB = { id: uid(42), fileName: 'materiali-demo.csv', companyId: null, appliedAt: at(28, 10, 5), rowCount: 120 }
const MATERIALS = { rows: 120, loaded: 120, refused: 0, skipped: 0 }
const OPENING_JOB = { id: uid(43), fileName: 'giacenze-iniziali-demo.xlsx', companyId: company, appliedAt: at(29, 9, 36), rowCount: 15 }
const OPENING_OFF = {
  rows: 15,
  loaded: 11,
  refused: 3,
  skipped: 1,
  quantities: [
    { unit: 'FT2', sheet: '1284.5000', loaded: '1176.3227' },
    { unit: 'M', sheet: '240.0000', loaded: '240.0000' },
  ],
  value: { sheet: 8421050, loaded: 7790310, atStandard: 41200, rowsAtStandard: 2, tolerance: 11, currency: 'EUR' },
}
const OPENING_OFF_DIFFS = [
  { path: 'difference/refused', message: '3 rows were refused: fix them in the sheet (download the refused rows) and import again.' },
  { path: 'difference/skipped', message: '1 row was skipped because the record changed after the dry run: import the sheet again.' },
  { path: 'difference/quantity/FT2', message: 'FT2: 1284.5000 in the sheet, 1176.3227 loaded.' },
  { path: 'difference/value', message: 'Stock value: 84210.50 EUR in the sheet, 77903.10 EUR loaded.' },
]
const doneOn = (day: number, hour: number, over: Partial<NonNullable<FirstLoadStepView['done']>> = {}) => ({ at: at(day, hour, 0), byId: USERS[0]!.id, nothing: false, stillMatches: true, ...over })
const PARTIES_DONE = (step: 'customers' | 'suppliers') => stepView(step, { state: 'done', job: PARTIES_JOB, reconciliation: PARTIES, matches: true, done: doneOn(27, 12) })
const MATERIALS_DONE = stepView('materials', { state: 'done', job: MATERIALS_JOB, reconciliation: MATERIALS, matches: true, done: doneOn(28, 11) })
const OPENING_DONE = stepView('openingStock', {
  state: 'done',
  job: OPENING_JOB,
  reconciliation: { rows: 15, loaded: 15, refused: 0, skipped: 0, quantities: [{ unit: 'FT2', sheet: '1284.5000', loaded: '1284.5000' }], value: { sheet: 8421050, loaded: 8421047, atStandard: 0, rowsAtStandard: 0, tolerance: 15, currency: 'EUR' } },
  matches: true,
  done: doneOn(29, 10),
})

const firstLoad = (steps: FirstLoadStepView[], over: Partial<FirstLoadModel> = {}): FirstLoadModel => ({ ...firstLoadLoading(company), steps, complete: steps.every((step) => step.done !== null), ...over })
const FIRST_START = firstLoad([
  stepView('customers', { state: 'todo' }),
  stepView('suppliers', { waitingFor: 'customers' }),
  stepView('materials', { waitingFor: 'customers' }),
  stepView('openingStock', { waitingFor: 'customers' }),
  stepView('openOrders', { waitingFor: 'customers' }),
])
const FIRST_MID = firstLoad([
  PARTIES_DONE('customers'),
  PARTIES_DONE('suppliers'),
  stepView('materials', { state: 'ready', job: MATERIALS_JOB, reconciliation: MATERIALS, matches: true }),
  stepView('openingStock', { waitingFor: 'materials' }),
  stepView('openOrders', { waitingFor: 'materials' }),
])
const MISMATCH_STEPS = [
  PARTIES_DONE('customers'),
  PARTIES_DONE('suppliers'),
  MATERIALS_DONE,
  stepView('openingStock', { state: 'mismatch', job: OPENING_JOB, reconciliation: OPENING_OFF, matches: false, differences: OPENING_OFF_DIFFS }),
  stepView('openOrders', { waitingFor: 'openingStock' }),
]
const FIRST_MISMATCH = firstLoad(MISMATCH_STEPS)
const { value: _value, ...OPENING_NO_COST } = OPENING_OFF
const FIRST_MISMATCH_NO_COST = firstLoad(MISMATCH_STEPS.map((step) => (step.step === 'openingStock' ? { ...step, reconciliation: OPENING_NO_COST, differences: OPENING_OFF_DIFFS.filter((item) => item.path !== 'difference/value') } : step)))
const FIRST_RUNNING = firstLoad(MISMATCH_STEPS.map((step) => (step.step === 'openingStock' ? stepView('openingStock', { state: 'running', runningJobId: uid(44) }) : step)))
const FIRST_OPEN_ORDERS = firstLoad([PARTIES_DONE('customers'), PARTIES_DONE('suppliers'), MATERIALS_DONE, OPENING_DONE, stepView('openOrders', { state: 'held' })])
const FIRST_DONE = firstLoad([
  PARTIES_DONE('customers'),
  PARTIES_DONE('suppliers'),
  { ...MATERIALS_DONE, reconciliation: { ...MATERIALS, loaded: 118 }, matches: false, differences: [{ path: 'difference/missing', message: "2 rows' records are not there any more (archived or moved since the import)." }], done: doneOn(28, 11, { stillMatches: false }) },
  OPENING_DONE,
  stepView('openOrders', { state: 'done', done: doneOn(29, 11, { nothing: true, stillMatches: null }) }),
])
const FIRST_NO_RIGHT = firstLoad(FIRST_START.steps!.map((step) => ({ ...step, canImport: false, canMarkDone: false })))

const page = (over: Partial<ImportViewModel> = {}): ImportViewModel => ({
  prefix: PREFIX,
  can: ALL,
  importers: loaded(IMPORTERS),
  jobs: loaded(JOBS),
  companies,
  people,
  asOf: at(29, 9, 42),
  wizard: null,
  firstLoad: FIRST_START,
  ...over,
})

const opening = blankDraft('inventory.opening', company, 'it')
const wizard = (over: Partial<WizardModel> = {}, draft = opening): WizardModel => ({ ...emptyWizard(draft), ...over })
const onJob = (value: ImportJob, over: Partial<WizardModel> = {}): WizardModel =>
  wizard({ job: value, refused: loaded(value.errorCount > 0 ? REFUSED : []), changes: loaded(value.createCount + value.updateCount > 0 ? CHANGES : []), skipped: loaded(value.skippedCount > 0 ? SKIPPED : []), ...over })

function ImportDesign({ model }: { model: ImportViewModel }) {
  return inShell('/admin/import', createElement(ImportView, { model }))
}

export const designScreen = defineDesignScreen<ImportViewModel>({
  screen: 'SCR-017',
  title: 'Import & export',
  view: ImportDesign,
  cases: [
    { id: 'page', label: 'What to load, first load and recent imports', model: page(), note: 'Cards in our words per importer, each with its last import and its template (Excel, CSV); the first load at its start; every job with its counts, who and when; a stopped apply can be applied again.' },
    { id: 'page-no-run', label: 'May see imports, not run them', model: page({ can: { ...ALL, run: false, apply: false } }), note: 'Import a sheet and each card are held with the reason.' },
    { id: 'page-recent-empty', label: 'No imports yet', model: page({ jobs: loaded([]) }) },
    { id: 'page-none-open', label: 'No importer open to this person', model: page({ importers: loaded([]), jobs: loaded([]) }) },
    { id: 'page-notice', label: 'After a cancel', model: page({ notice: { key: 'imp.notice.cancelled', tone: 'info', params: { file: 'ubicazioni-demo-nord.csv' } } }) },
    {
      id: 'recent-selected',
      label: 'Imports selected: the bulk bar says its reach',
      model: page({ jobs: loaded(OPEN_JOBS), selected: PICKED }),
      note: 'Cancel 2 imports: the one being checked and the one waiting to be applied. The applied one and the stopped one do not count.',
    },
    {
      id: 'cancel-many',
      label: 'Cancel 2 imports: one confirm',
      model: page({ jobs: loaded(OPEN_JOBS), selected: PICKED, cancelMany: PICKED }),
      note: 'What happens once, the sheets by name, each one left out with the reason.',
    },
    {
      id: 'cancelled-many',
      label: 'After cancelling several: one notice',
      model: page({
        jobs: loaded(OPEN_JOBS.map((item) => (item.id === READING.id ? { ...item, status: 'CANCELLED' as const } : item))),
        selected: [PLANNED.id],
        notice: { key: 'imp.bulk.partial', tone: 'warning', params: { count: 1, done: 1, refused: 1, total: 2 }, refusedIds: [{ id: PLANNED.id, problem: 'problem.conflict' }] },
      }),
      note: 'Each import is one call: what was cancelled, and each one refused with the reason.',
    },
    { id: 'templates', label: 'Templates (More menu): every import\'s template', model: page({ templatesOpen: true }), note: 'Excel (with a sheet that explains the columns) and CSV per importer, in the person\'s number format; money columns only with their grain.' },
    { id: 'first-start', label: 'First load: at the start', model: page({ firstLoad: FIRST_START }), note: 'Customers to load; every later step waits, held with the step it waits for.' },
    { id: 'first-mid', label: 'First load: customers and suppliers done, materials match', model: page({ firstLoad: FIRST_MID }), note: 'One parties sheet holds both; materials match, so Done is the primary action.' },
    {
      id: 'first-mismatch',
      label: 'First load: opening stock does not match',
      model: page({ firstLoad: FIRST_MISMATCH }),
      note: 'Rows, quantities per unit and the stock value (cost grain) side by side; each difference in words; Done held with the reason.',
    },
    { id: 'first-mismatch-no-cost', label: 'First load: the same, without the cost grain', model: page({ firstLoad: FIRST_MISMATCH_NO_COST }), note: 'No value line: the API sends none to a person who does not see costs.' },
    { id: 'first-running', label: 'First load: an import under way', model: page({ firstLoad: FIRST_RUNNING }), note: 'Open the import under way; Done held until it is applied.' },
    { id: 'first-open-orders', label: 'First load: open orders have no import', model: page({ firstLoad: FIRST_OPEN_ORDERS }), note: 'Import held with the reason; Nothing to load once they are entered as sales orders.' },
    { id: 'first-done', label: 'First load: all done', model: page({ firstLoad: FIRST_DONE }), note: 'When each step was done; materials no longer match since (two records archived).' },
    { id: 'first-no-right', label: 'First load: no right to import or mark done', model: page({ firstLoad: FIRST_NO_RIGHT }), note: 'Every action held with the right it needs.' },
    { id: 'first-confirm-done', label: 'First load: mark materials done', model: page({ firstLoad: { ...FIRST_MID, confirm: { step: 'materials', nothing: false, reason: '' } } }) },
    {
      id: 'first-confirm-nothing',
      label: 'First load: nothing to load for open orders',
      model: page({ firstLoad: { ...FIRST_OPEN_ORDERS, confirm: { step: 'openOrders', nothing: true, reason: 'No order is taken before the go-live.' } } }),
    },
    { id: 'first-done-notice', label: 'First load: after Done', model: page({ firstLoad: { ...FIRST_MID, notice: { key: 'imp.first.notice.done', tone: 'success', params: { n: 2 } } } }) },
    { id: 'first-loading', label: 'First load: loading', model: page({ firstLoad: firstLoadLoading(company) }) },
    { id: 'first-error', label: 'First load: could not be read (the rest works)', model: page({ firstLoad: { ...firstLoadLoading(company), problem: 'problem.unavailable' } }) },
    { id: 'loading', label: 'Loading', model: page({ importers: loading(), jobs: loading(), asOf: null, firstLoad: firstLoadLoading(company) }) },
    { id: 'error', label: 'The API did not answer', model: page({ importers: failed('problem.unavailable'), jobs: failed('problem.unavailable'), asOf: null, firstLoad: { ...firstLoadLoading(company), problem: 'problem.unavailable' } }) },
    { id: 'no-access', label: 'No right to see imports', model: page({ can: { view: false, run: false, apply: false, people: false }, firstLoad: null }), note: 'The first load is absent with the rest of the page.' },
    { id: 'upload-picker', label: 'Wizard 1: Import a sheet (choose what)', model: page({ wizard: wizard({}, blankDraft('', company, 'it')) }) },
    { id: 'upload-empty', label: 'Wizard 1: opening stock, nothing chosen yet', model: page({ wizard: wizard() }), note: 'The templates (Excel, CSV) in the person’s number format; the reports note.' },
    { id: 'upload-file', label: 'Wizard 1: a sheet chosen', model: page({ wizard: wizard({ draft: { ...opening, file: { name: 'giacenze-iniziali-demo.xlsx', size: 48213 } } }) }) },
    { id: 'upload-store-failed', label: 'Wizard 1: the store refused the bytes', model: page({ wizard: wizard({ draft: { ...opening, file: { name: 'giacenze-iniziali-demo.xlsx', size: 48213 } }, problem: 'imp.problem.store' }) }) },
    { id: 'reading', label: 'Wizard 2: reading the sheet', model: page({ wizard: onJob(READING) }), note: 'The worker reads it; the page asks every 2 s. Closing keeps the job.' },
    { id: 'checked-refused', label: 'Wizard 2: the check, 3 rows refused', model: page({ wizard: onJob(PLANNED) }), note: 'Counts, the columns read and one ignored, refused rows with the reason (the API’s words, quoted), the changes.' },
    { id: 'checked-clean', label: 'Wizard 2: the check, all good', model: page({ wizard: onJob(CLEAN) }) },
    { id: 'checked-nothing', label: 'Wizard 2: nothing to apply', model: page({ wizard: onJob(NOTHING) }), note: 'Apply held with its reason.' },
    { id: 'checked-no-apply', label: 'Wizard 3: Apply held without the right', model: page({ can: { ...ALL, apply: false }, wizard: onJob(CLEAN) }) },
    { id: 'cancel-confirm', label: 'Cancel this import?', model: page({ wizard: onJob(PLANNED, { confirmCancel: true }) }) },
    { id: 'applying', label: 'Wizard 3: applying', model: page({ wizard: onJob(APPLYING) }) },
    { id: 'result', label: 'Wizard 4: result with skipped rows', model: page({ wizard: onJob(APPLIED) }), note: 'Rows changed since the check are skipped, never overwritten; the refused rows download.' },
    { id: 'plan-failed', label: 'Wizard 2: the sheet could not be checked', model: page({ wizard: onJob(PLAN_FAILED, { draft: blankDraft('product.materials', company, 'it') }) }), note: 'A money column held without its grain, said apart; the rest as the check said it.' },
    { id: 'apply-failed', label: 'Wizard 3: the apply stopped (resumable)', model: page({ wizard: onJob(APPLY_FAILED, { draft: blankDraft('parties.parties', company, 'it') }) }) },
    { id: 'cancelled', label: 'Wizard: a cancelled import', model: page({ wizard: onJob(CANCELLED, { draft: blankDraft('inventory.locations', company, 'it') }) }) },
  ],
})
