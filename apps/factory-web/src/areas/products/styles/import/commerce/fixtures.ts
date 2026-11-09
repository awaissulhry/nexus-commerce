import { COMMERCE_IMPORTER_KEY } from '@nexus/factory-domain/product/commerce-import/importer'
import { commerceImportInfo, type StartedStylesView } from '@nexus/factory-domain/product/commerce-import/source'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import type { ImportJob, ImportRow, Importer } from '../../../../admin/import/api'
import { blankDraft, emptyWizard } from '../../../../admin/import/model'
import type { SheetImport } from '../sheet-import'
import type { CommerceImportModel } from './commerce-model'
import { CommerceImportDesign, type CommerceImportProps } from './view/CommerceImport'

/**
 * SCR-273 Start from a Nexus Commerce product (B-W2b-209; PRD-265; design products.styles pop:styles.new "Start from …
 * Nexus Commerce product (W2b)" and page.h "Import (W2b: from Nexus Commerce or a sheet)"): the source step (the file
 * chosen, the live read OFF waiting for the Owner's word), the import wizard on `product.commerceStyles`, and the styles
 * the file started. Made-up data only: an invented export of the demo touring jacket, codes, names and barcodes invented.
 */

const PREFIX = '/w/0190f0e2-1111-7000-8000-000000000001'
const COMPANY = '0190f0e2-1111-7000-8000-000000000001'
const uid = (n: number) => `0190f0e2-2090-7000-8000-${String(n).padStart(12, '0')}`
const INFO = commerceImportInfo()

const source = (extra: Partial<CommerceImportModel> = {}): CommerceImportModel => ({ step: 'source', info: { status: 'ready', value: INFO }, held: null, done: null, ...extra })

const STARTED: StartedStylesView = {
  jobId: uid(1),
  status: 'APPLIED',
  styles: [{ id: uid(11), code: 'DEMO-TOUR', name: 'Giacca Touring Demo', status: 'DRAFT', lifecycle: 'CONCEPT', started: true, skus: 4 }],
  hidden: 0,
}
const MANY: StartedStylesView = {
  jobId: uid(2),
  status: 'APPLIED',
  styles: [
    { id: uid(11), code: 'DEMO-TOUR', name: 'Giacca Touring Demo', status: 'DRAFT', lifecycle: 'DEVELOPMENT', started: false, skus: 2 },
    { id: uid(12), code: 'DEMO-PNT-TOUR', name: 'Pantalone Touring Demo', status: 'DRAFT', lifecycle: 'CONCEPT', started: true, skus: 8 },
    { id: uid(13), code: 'DEMO-GLV-ESTATE', name: 'Guanto Estivo Demo', status: 'DRAFT', lifecycle: 'CONCEPT', started: true, skus: 3 },
  ],
  hidden: 1,
}
type StylesRead = NonNullable<CommerceImportModel['done']>['styles']
const done = (styles: StylesRead): CommerceImportModel => ({
  step: 'done',
  info: { status: 'loading' },
  held: null,
  done: { jobId: uid(1), styles },
})

const IMPORTER: Importer = { key: COMMERCE_IMPORTER_KEY, label: 'Styles from a Nexus Commerce export', description: null, columns: [], keyColumns: ['sku'], maxRows: INFO.maxRows }
const HEADERS = ['SKU', 'Parent SKU', 'Name', 'Color', 'Size', 'EAN', 'Category', 'Season', 'Stock']
const at = (minute: number) => `2026-11-09T09:${String(minute).padStart(2, '0')}:00.000Z`

function job(step: 'planned' | 'applied'): ImportJob {
  return {
    id: uid(1),
    companyId: COMPANY,
    importerKey: COMMERCE_IMPORTER_KEY,
    importerLabel: IMPORTER.label,
    fileId: uid(21),
    fileName: 'commerce-export-demo.csv',
    fileStatus: 'AVAILABLE',
    sheetName: null,
    encoding: 'utf-8',
    numberFormat: 'it',
    mapping: null,
    layout: {
      format: 'csv',
      sheet: null,
      sheets: [],
      encoding: 'utf-8',
      delimiter: ';',
      headers: HEADERS,
      columns: [
        { index: 0, header: 'SKU', column: 'sku' },
        { index: 1, header: 'Parent SKU', column: 'family' },
        { index: 2, header: 'Name', column: 'name' },
        { index: 3, header: 'Color', column: 'colour' },
        { index: 4, header: 'Size', column: 'size' },
        { index: 5, header: 'EAN', column: 'gtin' },
        { index: 6, header: 'Category', column: 'productType' },
        { index: 7, header: 'Season', column: 'season' },
      ],
      ignored: [{ index: 8, header: 'Stock', reason: 'Not a column of this import (ignored).' }],
    },
    status: step === 'applied' ? 'APPLIED' : 'PLANNED',
    mode: 'DRY_RUN',
    rowCount: 8,
    createCount: 5,
    updateCount: 0,
    unchangedCount: 0,
    errorCount: 3,
    appliedCount: step === 'applied' ? 5 : 0,
    skippedCount: 0,
    issues: null,
    error: null,
    plannedAt: at(2),
    applyRequestedAt: step === 'applied' ? at(4) : null,
    appliedAt: step === 'applied' ? at(5) : null,
    cancelledAt: null,
    version: step === 'applied' ? 5 : 3,
    createdAt: at(1),
    updatedAt: at(5),
    createdById: null,
  }
}

const CHANGES: ImportRow[] = [
  { rowNumber: 2, action: 'CREATE', key: '["DEMO-TOUR"]', recordId: null, errors: null, after: { sku: 'DEMO-TOUR', name: 'Giacca Touring Demo', productType: 'Giacche moto', season: 'FW27', style: 'DEMO-TOUR' }, outcome: null, note: null, appliedAt: null },
  { rowNumber: 3, action: 'CREATE', key: '["DEMO-TOUR-NER-50"]', recordId: null, errors: null, after: { sku: 'DEMO-TOUR-NER-50', family: 'DEMO-TOUR', colour: 'Nero', colourCode: 'NERO', size: '50', gtin: '2009001000017', style: 'DEMO-TOUR' }, outcome: null, note: null, appliedAt: null },
  { rowNumber: 4, action: 'CREATE', key: '["DEMO-TOUR-NER-52"]', recordId: null, errors: null, after: { sku: 'DEMO-TOUR-NER-52', family: 'DEMO-TOUR', colour: 'Nero', colourCode: 'NERO', size: '52', gtin: '2009001000024', style: 'DEMO-TOUR' }, outcome: null, note: null, appliedAt: null },
]
const REFUSED: ImportRow[] = [
  {
    rowNumber: 7,
    action: 'ERROR',
    key: '["DEMO-PNT-NER-XXL"]',
    recordId: null,
    errors: [{ column: 'size', message: 'No size scale holds every size of the family (S, M, XXL): add them to a scale in Products › Sizes & measurements, or name the scale in a Size scale column.' }],
    outcome: null,
    note: null,
    appliedAt: null,
  },
  { rowNumber: 8, action: 'ERROR', key: '["DEMO-PNT-NER-S"]', recordId: null, errors: [{ column: 'family', message: 'Family DEMO-PNT is started whole or not at all: row 7 has a problem.' }], outcome: null, note: null, appliedAt: null },
]

function sheet(step: 'upload' | 'planned' | 'applied'): SheetImport {
  const draft = blankDraft(COMMERCE_IMPORTER_KEY, COMPANY, 'it')
  const wizard =
    step === 'upload'
      ? emptyWizard({ ...draft, file: { name: 'commerce-export-demo.csv', size: 3072 } })
      : { ...emptyWizard(draft, job(step)), refused: { items: REFUSED, problem: null }, changes: { items: step === 'planned' ? CHANGES : [], problem: null } }
  return { wizard, importers: [IMPORTER], rights: { view: true, run: true, apply: true, people: false }, companies: [{ id: 'every-company', name: 'Every company' }, { id: COMPANY, name: 'Officina Demo S.r.l.' }] }
}

const view = (model: CommerceImportModel | null, wizard: SheetImport | null = null): CommerceImportProps => ({ model, sheet: wizard, prefix: PREFIX })

export const designScreen = defineDesignScreen<CommerceImportProps>({
  screen: 'SCR-273',
  title: 'Start from a Nexus Commerce product',
  view: CommerceImportDesign,
  cases: [
    { id: 'source', label: 'Product office: where the styles come from', model: view(source()), note: 'The export file is chosen; reading Commerce live is OFF with the server\'s reason (the Owner\'s word, 11-09). What the import makes; nothing goes back to Commerce. ⌘↵ = Choose the file.' },
    { id: 'source-loading', label: 'Reading the sources', model: view(source({ info: { status: 'loading' } })), note: 'Choose the file is held: "Reading where the styles can come from…".' },
    { id: 'source-error', label: 'The sources could not be read', model: view(source({ info: { status: 'error', problem: 'fault.unavailable' } })), note: 'Try again in the banner; Choose the file held with its reason.' },
    { id: 'source-no-manage', label: 'Sales (reads styles)', model: view(source({ held: 'hold.noManage' })), note: 'Held: "Your role can view styles, not start them."' },
    { id: 'source-no-import', label: 'No right to import files', model: view(source({ held: 'hold.noImport' })), note: 'Held with the rights it needs (imports.run, files upload).' },
    { id: 'upload', label: 'The import: upload', model: view(null, sheet('upload')), note: 'Admin › Import & export\'s wizard on the one importer, named in our words; the template links give the columns.' },
    { id: 'planned', label: 'The import: the dry run', model: view(null, sheet('planned')), note: 'Nothing written yet: 5 new rows (one family, its own row and its SKUs with the codes they make), 3 refused in the API\'s words (a family is started whole or not at all), the Stock column ignored.' },
    { id: 'applied', label: 'The import: applied', model: view(null, sheet('applied')), note: 'Done closes the wizard and opens the styles the file started.' },
    { id: 'done', label: 'Done: one new style', model: view(done({ status: 'ready', value: STARTED })), note: 'A new draft in Concept with its 4 SKUs; Open DEMO-TOUR is the primary.' },
    { id: 'done-many', label: 'Done: several styles', model: view(done({ status: 'ready', value: MANY })), note: 'Two new drafts, one style that took new colours or sizes; one more outside the person\'s companies, counted, never named.' },
    { id: 'done-none', label: 'Done: nothing written', model: view(done({ status: 'ready', value: { jobId: uid(3), status: 'APPLIED', styles: [], hidden: 0 } })) },
    { id: 'done-loading', label: 'Done: reading the styles', model: view(done({ status: 'loading' })) },
    { id: 'done-error', label: 'Done: the styles could not be read', model: view(done({ status: 'error', problem: 'fault.unavailable' })), note: 'The import is done; the styles are in the list. Try again.' },
    { id: 'no-permission', label: 'No access to the import', model: view(done({ status: 'error', problem: 'fault.not_found' })), note: 'A job the person may not see reads as not found.' },
  ],
})

export const COMMERCE_DEMO = Object.freeze({ source, done, sheet, STARTED, MANY, INFO, PREFIX })
