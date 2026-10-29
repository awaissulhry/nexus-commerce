import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../shell/design-data'
import { at, inShell, PREFIX, USERS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { ImportJob, Importer, ImportRow, Layout } from './api'
import { blankDraft, emptyWizard, type ImportViewModel, type WizardModel } from './model'
import { ImportView } from './view/ImportView'

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

const page = (over: Partial<ImportViewModel> = {}): ImportViewModel => ({
  prefix: PREFIX,
  can: ALL,
  importers: loaded(IMPORTERS),
  jobs: loaded(JOBS),
  companies,
  people,
  asOf: at(29, 9, 42),
  wizard: null,
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
    { id: 'page', label: 'What to load, and recent imports', model: page(), note: 'Cards in our words per importer, with the last import and the opening-stock templates; every job with its counts, who and when; a stopped apply can be applied again.' },
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
    { id: 'loading', label: 'Loading', model: page({ importers: loading(), jobs: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: page({ importers: failed('problem.unavailable'), jobs: failed('problem.unavailable'), asOf: null }) },
    { id: 'no-access', label: 'No right to see imports', model: page({ can: { view: false, run: false, apply: false, people: false } }) },
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
