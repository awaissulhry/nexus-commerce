import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES } from '../../../../shell/design-data'
import { ROWS } from '../list/fixtures'
import type { NewQuoteModel, QuotesListViewModel } from '../list/list-model'
import { QuotesListView } from '../list/view/QuotesListView'
import { NO_FILTERS } from '../model'
import { CAN, GRAINS, PARTY, PEOPLE, PREFIX, STYLE } from '../record/fixtures'
import type { OpenInquiry, QuoteTemplate, TemplateRow } from './api'
import { EMPTY_INQUIRY_PICK, EMPTY_TEMPLATE_PICK, type NewFromModel } from './model'

/**
 * SCR-034-new-from — New quote › Start from: Template or Inquiry (design pop:quotes.new; B-W2b-316 on B-W2b-294's templates and
 * B-W2b-295's inquiries), and the Quotes page's ⋯ (Quote templates, Planning › Promise dates). Made-up data only: an invented
 * season template of the invented jacket, invented inquiries. Each case is one state: the templates, a template whose lines are
 * chosen at use, the customer's open inquiries, a start that left lines out (said before the quote opens), a role without
 * inquiries, the page's ⋯.
 */

const TEMPLATE_ROWS: TemplateRow[] = [
  { id: '0190f0e2-7300-7000-8000-000000000001', companyId: null, company: null, name: 'Stagione moto 2027 — squadre', description: 'Giacca e pantalone, acconto 30 %', language: 'it', currency: 'EUR', validityDays: 30, acceptanceMode: 'SIGN_AND_PAY', incoterm: 'EXW', incotermPlace: 'Fabbrica demo', shipComplete: true, status: 'ACTIVE', lineCount: 3, sections: ['Giacche', 'Sviluppo'], used: 7, version: 3, updatedAt: '2026-11-02T09:00:00.000Z' },
  { id: '0190f0e2-7300-7000-8000-000000000002', companyId: DEMO_COMPANIES[0].id, company: { id: DEMO_COMPANIES[0].id, code: DEMO_COMPANIES[0].code, name: DEMO_COMPANIES[0].name }, name: 'Riordino negozi', description: null, language: 'it', currency: 'EUR', validityDays: null, acceptanceMode: 'SIGN', incoterm: null, incotermPlace: null, shipComplete: false, status: 'ACTIVE', lineCount: 1, sections: [], used: 12, version: 1, updatedAt: '2026-10-20T09:00:00.000Z' },
]
const TEMPLATE: QuoteTemplate = {
  ...TEMPLATE_ROWS[0]!,
  firmOffer: true,
  depositPct: '30',
  depositKind: 'ACCONTO',
  paymentTermsId: null,
  paymentTermsName: null,
  termsText: null,
  termsVersion: '2026-1',
  mayManage: true,
  lines: [
    { id: '0190f0e2-7310-7000-8000-000000000001', seq: 10, section: 'Giacche', kind: 'SIZE_GRID', feeKind: null, styleId: STYLE.id, style: { code: STYLE.code, name: STYLE.name, status: 'ACTIVE' }, colourwayId: STYLE.colourways[0]!.id, colourway: { code: STYLE.colourways[0]!.code, name: STYLE.colourways[0]!.name }, sizes: { '50': 2, '52': 4, '54': 2 }, pieces: 8, unitPrice: null, description: null, note: null },
    { id: '0190f0e2-7310-7000-8000-000000000002', seq: 20, section: 'Giacche', kind: 'SIZE_GRID', feeKind: null, styleId: STYLE.id, style: { code: STYLE.code, name: STYLE.name, status: 'ACTIVE' }, colourwayId: null, colourway: null, sizes: null, pieces: 0, unitPrice: null, description: null, note: null },
    { id: '0190f0e2-7310-7000-8000-000000000003', seq: 30, section: 'Sviluppo', kind: 'FEE', feeKind: 'DEVELOPMENT', styleId: STYLE.id, style: { code: STYLE.code, name: STYLE.name, status: 'ACTIVE' }, colourwayId: null, colourway: null, sizes: null, pieces: 0, unitPrice: '500', description: null, note: null },
  ],
}
const INQUIRIES: OpenInquiry[] = [
  { id: '0190f0e2-4100-7000-8000-000000000042', number: 'INQ-2026-0042', companyId: DEMO_COMPANIES[0].id, status: 'ASSIGNED', receivedAt: '2026-10-27T08:30:00.000Z', summary: 'Giacche squadra corse, logo sul petto', products: ['DEMO-JKT-01'], pieces: 24, wantedDate: '2027-02-15', version: 4 },
  { id: '0190f0e2-4100-7000-8000-000000000043', number: 'INQ-2026-0043', companyId: DEMO_COMPANIES[0].id, status: 'NEED_INFO', receivedAt: '2026-10-28T15:10:00.000Z', summary: 'Pantaloni in tinta', products: [], pieces: 10, wantedDate: null, version: 2 },
]

const CAN_INQUIRIES = { view: true, manage: true }
const from = (extra: Partial<NewFromModel>): NewFromModel => ({ active: null, template: null, inquiry: null, done: null, inquiries: CAN_INQUIRIES, ...extra })
const NEW: NewQuoteModel = { companies: DEMO_COMPANIES, companyId: DEMO_COMPANIES[0].id, results: [], searchProblem: null, party: PARTY, partyProblem: null, contactId: PARTY.contacts[0]!.id, customerRef: 'RFQ-0042', number: 'Q-2026-0143', busy: false, problem: null }
const STYLE_PICKS = { [STYLE.id]: { colourways: STYLE.colourways, sizes: STYLE.sizes } }

function model(newFrom: NewFromModel | null, extra: Partial<QuotesListViewModel> = {}, held: NewQuoteModel['newFromHeld'] = null): QuotesListViewModel {
  return {
    prefix: PREFIX,
    me: PEOPLE.sales,
    grains: GRAINS.sales,
    can: CAN.sales,
    filters: NO_FILTERS,
    rows: { items: ROWS, more: false, problem: null },
    tiles: { myDrafts: { count: 3, more: false }, waiting: { count: 1, more: false }, sent: { count: 2, more: false }, expiring: { count: 1, more: false }, accepted: { count: 4, more: false, value: 9120000 } },
    asOf: '2026-10-29T10:00:00.000Z',
    today: '2026-10-29',
    updates: 0,
    newQuote: newFrom ? { ...NEW, newFrom, newFromHeld: held } : null,
    notice: null,
    pageLinks: { prefix: PREFIX, promiseDates: true },
    ...extra,
  }
}

export const designScreen = defineDesignScreen<QuotesListViewModel>({
  screen: 'SCR-034-new-from',
  title: 'New quote from a template or an inquiry, and the Quotes page ⋯ (B-W2b-316)',
  view: QuotesListView,
  cases: [
    { id: 'options', label: 'Start from: Blank · Past quote · Template · Inquiry', model: model(from({})), note: 'The W2b choices beside W1\'s Blank and W2a\'s Past quote.' },
    { id: 'templates', label: 'Template: the company\'s and every company\'s', model: model(from({ active: 'template', template: { ...EMPTY_TEMPLATE_PICK, results: TEMPLATE_ROWS } }), {}, { key: 'from.held.template' }), note: 'Create is held until a template is picked.' },
    { id: 'template-open-lines', label: 'Template picked: a line chosen at use', model: model(from({ active: 'template', template: { ...EMPTY_TEMPLATE_PICK, results: TEMPLATE_ROWS, chosenId: TEMPLATE.id, template: { status: 'ready', value: TEMPLATE }, styles: STYLE_PICKS, picks: { '0190f0e2-7310-7000-8000-000000000002': { colourwayId: STYLE.colourways[1]!.id, sizes: { '50': '1', '52': '2' }, skip: false } } } })), note: 'Its colourway and pieces are picked here, or the line is left out; the fee line goes on as a fee.' },
    { id: 'inquiries', label: 'Inquiry: the customer\'s open inquiries', model: model(from({ active: 'inquiry', inquiry: { ...EMPTY_INQUIRY_PICK, results: INQUIRIES, chosenId: INQUIRIES[0]!.id } })) },
    { id: 'inquiries-none', label: 'Inquiry: none open for this customer', model: model(from({ active: 'inquiry', inquiry: { ...EMPTY_INQUIRY_PICK, results: [] } }), {}, { key: 'from.held.inquiry' }) },
    { id: 'inquiries-no-right', label: 'A role without inquiries: the choice says why', model: model(from({ inquiries: { view: false, manage: false } })) },
    {
      id: 'done-left-out',
      label: 'Made from the template: what was left out, before it opens',
      model: model(from({ active: 'template', done: { quoteId: '0190f0e2-9999-7000-8000-000000000143', number: 'Q-2026-0143', from: TEMPLATE.name, lines: 2, leftOut: [{ seq: 20, size: null, reason: 'Its colourway is chosen when the quote is made: pick one, or add the line on the quote.' }, { seq: 10, size: '56', reason: 'Size 56 is not offered in this colourway.' }], warnings: 0 } })),
    },
    { id: 'page-links', label: 'The Quotes page ⋯: Quote templates, Promise dates', model: model(null), note: 'Open the ⋯ beside New quote: Quote templates opens Sales › Sales settings; Promise dates opens Planning › Promise dates.' },
    { id: 'page-links-no-planning', label: 'The ⋯ without the planning right', model: model(null, { pageLinks: { prefix: PREFIX, promiseDates: false } }) },
  ],
})
