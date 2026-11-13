import { createElement } from 'react'
import type { ImportJob, ImportRow, Importer } from '../../../admin/import/api'
import { blankDraft, emptyWizard } from '../../../admin/import/model'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import type { SheetImport } from '../../../products/styles/import/sheet-import'
import { inShell, type PriceListRole } from '../_demo/fixtures'
import { PriceListImportView, type PriceListImportModel } from './view/PriceListImportView'

/**
 * SCR-419 — Import prices (design sales.pricelists pop:pricelists.import, band "Import (W2b)"; B-W2b-343 on B-W2b-325's
 * importer `sales.priceLists`), made-up data only: an invented sheet "listino-demo-2027.xlsx" for the invented list
 * MODA-DEMO — the upload, the dry run with what each row changes (a price raised, a dated price added, quantity breaks)
 * and the refused rows, the result, and the button held for a role without the rights.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const IMPORTER: Importer = { key: 'sales.priceLists', label: 'Price lists', description: null, columns: [], keyColumns: ['list', 'style', 'colourway', 'validFrom'], maxRows: 20000 }
const COMPANY = DEMO_COMPANIES[0]!

function sheet(step: 'upload' | 'planned' | 'applied', rights: { run: boolean; apply: boolean } = { run: true, apply: true }): SheetImport {
  const draft = blankDraft('sales.priceLists', COMPANY.id, 'it')
  const job: ImportJob = {
    id: uid('4919', 1),
    companyId: COMPANY.id,
    importerKey: 'sales.priceLists',
    importerLabel: 'Price lists',
    fileId: uid('4919', 11),
    fileName: 'listino-demo-2027.xlsx',
    fileStatus: 'AVAILABLE',
    sheetName: 'Prezzi',
    encoding: 'utf-8',
    numberFormat: 'it',
    mapping: null,
    layout: {
      format: 'xlsx',
      sheet: 'Prezzi',
      sheets: ['Prezzi', 'Columns'],
      encoding: 'utf-8',
      delimiter: ';',
      headers: ['Listino', 'Modello', 'Colore', 'Dal', 'Al', 'Prezzo unitario', 'Scaglioni'],
      columns: [
        { index: 0, header: 'Listino', column: 'list' },
        { index: 1, header: 'Modello', column: 'style' },
        { index: 2, header: 'Colore', column: 'colourway' },
        { index: 3, header: 'Dal', column: 'validFrom' },
        { index: 4, header: 'Al', column: 'validTo' },
        { index: 5, header: 'Prezzo unitario', column: 'unitPrice' },
        { index: 6, header: 'Scaglioni', column: 'breaks' },
      ],
      ignored: [],
    },
    status: step === 'applied' ? 'APPLIED' : 'PLANNED',
    mode: step === 'applied' ? 'APPLY' : 'DRY_RUN',
    rowCount: 6,
    createCount: 1,
    updateCount: 2,
    unchangedCount: 2,
    errorCount: 1,
    appliedCount: step === 'applied' ? 3 : 0,
    skippedCount: 0,
    issues: null,
    error: null,
    plannedAt: at(13, 9, 2),
    applyRequestedAt: step === 'applied' ? at(13, 9, 4) : null,
    appliedAt: step === 'applied' ? at(13, 9, 5) : null,
    cancelledAt: null,
    version: step === 'applied' ? 5 : 3,
    createdAt: at(13, 9, 1),
    updatedAt: at(13, 9, 5),
    createdById: null,
  }
  const changes: ImportRow[] = [
    { rowNumber: 2, action: 'UPDATE', key: '["MODA-DEMO","JKT-DEMO-01","*","-"]', recordId: uid('6109', 11), errors: null, before: { unitPrice: '436.8', breaks: '10=425; 50=415' }, after: { unitPrice: '440', breaks: '10=430; 50=415' }, outcome: null, note: null, appliedAt: null },
    { rowNumber: 3, action: 'UPDATE', key: '["MODA-DEMO","JKT-DEMO-02","*","-"]', recordId: uid('6109', 13), errors: null, before: { unitPrice: '414.96' }, after: { unitPrice: '419' }, outcome: null, note: null, appliedAt: null },
    { rowNumber: 5, action: 'CREATE', key: '["MODA-DEMO","GLV-DEMO-01","*","2027-03-01"]', recordId: null, errors: null, after: { validTo: null, unitPrice: '74.9' }, outcome: null, note: null, appliedAt: null },
  ]
  const refused: ImportRow[] = [{ rowNumber: 6, action: 'ERROR', key: '["MODA-DEMO","PNT-DEMO-09","*","-"]', recordId: null, errors: [{ column: 'style', message: 'No style with this code.' }], outcome: null, note: null, appliedAt: null }]
  const wizard = step === 'upload' ? emptyWizard({ ...draft, file: { name: job.fileName, size: 12288 } }) : { ...emptyWizard(draft, job), refused: { items: refused, problem: null }, changes: { items: step === 'planned' ? changes : [], problem: null } }
  return { wizard, importers: [IMPORTER], rights: { view: true, run: rights.run, apply: rights.apply, people: false }, companies: [{ id: 'every-company', name: 'Ogni azienda' }, { id: COMPANY.id, name: COMPANY.name }] }
}

interface ImportCase {
  role: PriceListRole
  importer: PriceListImportModel
}

function ImportDesign({ model }: { model: ImportCase }) {
  return inShell('/sales/price-lists', createElement('div', { className: 'fw-pl' }, createElement(PriceListImportView, { model: model.importer })), model.role)
}

const c = (role: PriceListRole, importer: Partial<PriceListImportModel>): ImportCase => ({ role, importer: { held: null, sheet: null, button: true, inline: true, ...importer } })

export const designScreen = defineDesignScreen<ImportCase>({
  screen: 'SCR-419',
  title: 'Import prices (B-W2b-343)',
  view: ImportDesign,
  cases: [
    { id: 'upload', label: 'Sales · Import prices: the sheet (the company of the list)', model: c('sales', { sheet: sheet('upload') }), note: 'Rows by list code, style, colourway (or every colourway) and first day; they go into each list\'s draft; nothing is written before Apply.' },
    { id: 'check', label: 'The dry run: a price raised with its breaks, a dated price added, a row refused', model: c('sales', { sheet: sheet('planned') }) },
    { id: 'result', label: 'Applied: the result', model: c('sales', { sheet: sheet('applied') }) },
    { id: 'no-apply', label: 'A role that runs the dry run but may not apply it', model: c('sales', { sheet: sheet('planned', { run: true, apply: false }) }) },
    { id: 'button', label: 'The band\'s button (closed)', model: c('sales', {}) },
    { id: 'held-manage', label: 'Finance: Import held (pricelists.manage)', model: c('finance', { held: 'import.held.manage' }) },
    { id: 'held-run', label: 'A role without imports.run: Import held with the reason', model: c('sales', { held: 'import.held.run' }) },
    { id: 'held-record', label: 'The record\'s ⋯ Import prices asked without the right: the reason in a dialog', model: c('finance', { held: 'import.held.manage', button: false, refusedOpen: true }) },
  ],
})
