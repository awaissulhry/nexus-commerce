import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import type { QuoteTemplate, TemplateRow } from '../../quotes/new-from/api'
import { ROWS } from '../../quotes/list/fixtures'
import { STYLE, STYLE_ROWS } from '../../quotes/record/fixtures'
import { draftOf, emptyDraft } from './model'
import type { TemplateDialogModel } from './view/TemplateDialog'
import { TemplatesView, type TemplatesModel } from './view/TemplatesView'

/**
 * SCR-235-templates — Sales settings › Quote templates (design sales.settings sec:ssettings.templates, SAL-144; B-W2b-316 on
 * B-W2b-294's API), made-up data only: invented templates of the invented jacket. Each case is one state: the list, archived,
 * two selected, a role without the right, empty, an error, the template's dialog (edit, new empty with a line being added,
 * new from a quote, archived read only).
 */

const COMPANY = DEMO_COMPANIES[0]
const row = (n: number, extra: Partial<TemplateRow>): TemplateRow => ({ id: `0190f0e2-7300-7000-8000-00000000000${n}`, companyId: null, company: null, name: 'Modello demo', description: null, language: 'it', currency: 'EUR', validityDays: 30, acceptanceMode: 'SIGN', incoterm: null, incotermPlace: null, shipComplete: false, status: 'ACTIVE', lineCount: 2, sections: [], used: 0, version: 1, updatedAt: '2026-11-02T09:00:00.000Z', ...extra })
const ROWS_T: TemplateRow[] = [
  row(1, { name: 'Stagione moto 2027 — squadre', description: 'Giacca e pantalone, acconto 30 %', acceptanceMode: 'SIGN_AND_PAY', incoterm: 'EXW', incotermPlace: 'Fabbrica demo', shipComplete: true, lineCount: 3, sections: ['Giacche', 'Sviluppo'], used: 7, version: 3 }),
  row(2, { companyId: COMPANY.id, company: { id: COMPANY.id, code: COMPANY.code, name: COMPANY.name }, name: 'Riordino negozi', lineCount: 1, used: 12 }),
  row(3, { name: 'Campionario 2026', status: 'ARCHIVED', used: 3, updatedAt: '2026-06-10T09:00:00.000Z' }),
]
const TEMPLATE: QuoteTemplate = {
  ...ROWS_T[0]!,
  firmOffer: true,
  depositPct: '30',
  depositKind: 'ACCONTO',
  paymentTermsId: null,
  paymentTermsName: null,
  termsText: null,
  termsVersion: '2026-1',
  mayManage: true,
  lines: [
    { id: '0190f0e2-7310-7000-8000-000000000001', seq: 10, section: 'Giacche', kind: 'SIZE_GRID', feeKind: null, styleId: STYLE.id, style: { code: STYLE.code, name: STYLE.name, status: 'ACTIVE' }, colourwayId: STYLE.colourways[0]!.id, colourway: { code: STYLE.colourways[0]!.code, name: STYLE.colourways[0]!.name }, sizes: { '50': 2, '52': 4, '54': 2 }, pieces: 8, unitPrice: '450', description: null, note: null },
    { id: '0190f0e2-7310-7000-8000-000000000002', seq: 20, section: 'Giacche', kind: 'SIZE_GRID', feeKind: null, styleId: STYLE.id, style: { code: STYLE.code, name: STYLE.name, status: 'ACTIVE' }, colourwayId: null, colourway: null, sizes: null, pieces: 0, unitPrice: null, description: null, note: null },
  ],
}
const COMPANIES = DEMO_COMPANIES.map((company) => ({ id: company.id, code: company.code, name: company.name }))
const dialog = (extra: Partial<TemplateDialogModel>): TemplateDialogModel => {
  const draft = draftOf(TEMPLATE)
  return { mode: 'edit', start: 'empty', reading: false, readProblem: null, archived: false, draft, before: draft, companies: COMPANIES, mayKeep: true, grains: { price: true }, currency: 'EUR', saving: false, problem: null, composer: { query: '', results: null, style: null, colourwayId: '', sizes: {}, section: '', unitPrice: '' }, fromQuote: { query: '', results: null, chosenId: '', name: '', everyCompany: false }, ...extra }
}
const model = (extra: Partial<TemplatesModel> = {}): TemplatesModel => ({ rows: { status: 'ready', value: ROWS_T }, status: 'ACTIVE', selected: [], mayCreate: true, busy: false, notice: null, dialog: null, ...extra })
const empty = emptyDraft(COMPANY.id)

export const designScreen = defineDesignScreen<TemplatesModel>({
  screen: 'SCR-235-templates',
  title: 'Sales settings › Quote templates (B-W2b-316)',
  view: TemplatesView,
  cases: [
    { id: 'list', label: 'Sales · Quote templates (active)', model: model(), note: 'Template, Company (every company or one), Lines, Used; a row opens it; c makes a new one.' },
    { id: 'all', label: 'All, the archived one included', model: model({ status: 'ALL' }) },
    { id: 'selected', label: 'Two selected: Archive 2', model: model({ selected: [ROWS_T[0]!.id, ROWS_T[1]!.id] }) },
    { id: 'no-right', label: 'A role without the right: New and Archive held', model: model({ mayCreate: false, selected: [ROWS_T[0]!.id] }) },
    { id: 'empty', label: 'No template yet', model: model({ rows: { status: 'ready', value: [] } }) },
    { id: 'loading', label: 'Loading', model: model({ rows: { status: 'loading' } }) },
    { id: 'error', label: 'The list could not be read', model: model({ rows: { status: 'error', problem: 'problem.read.unavailable' } }) },
    { id: 'done', label: 'Saved (receipt)', model: model({ notice: { words: { key: 'tpl.done.saved' }, tone: 'success' } }) },
    { id: 'dialog-edit', label: 'The template: header and lines in sections', model: model({ dialog: dialog({}) }), note: 'A line\'s colourway or pieces may be left to choose when the quote is made; a price is optional (price grain).' },
    { id: 'dialog-new', label: 'New template, empty: a line being added', model: model({ dialog: dialog({ mode: 'new', draft: { ...empty, name: 'Riordino squadre', lines: draftOf(TEMPLATE).lines.slice(0, 1) }, before: empty, composer: { query: 'demo', results: STYLE_ROWS, style: STYLE, colourwayId: '', sizes: { '52': '6' }, section: 'Giacche', unitPrice: '' } }) }) },
    { id: 'dialog-from-quote', label: 'New template from a quote (a quote in template mode)', model: model({ dialog: dialog({ mode: 'new', start: 'quote', draft: empty, before: empty, fromQuote: { query: 'Q-2026', results: ROWS.slice(0, 3), chosenId: ROWS[0]!.id, name: 'Come Q-2026-0142', everyCompany: false } }) }) },
    { id: 'dialog-archived', label: 'An archived template: read only, restore first', model: model({ status: 'ALL', dialog: dialog({ archived: true }) }) },
    { id: 'dialog-problem', label: 'The template with what stops the save', model: model({ dialog: dialog({ draft: { ...draftOf(TEMPLATE), acceptanceMode: 'SIGN_AND_PAY', depositPct: '', incotermPlace: '' } }) }) },
  ],
})
