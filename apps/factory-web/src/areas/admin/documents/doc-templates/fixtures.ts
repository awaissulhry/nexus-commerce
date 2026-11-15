import { createElement } from 'react'
import { DOCUMENT_LAYOUTS, MANDATORY_COLUMNS, optionalColumnsOf } from '@nexus/factory-domain/documents/layouts'
import { DOCUMENT_PLACEHOLDERS, mandatoryPartsOf } from '@nexus/factory-domain/templates/documents'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { at, COMPANIES, inShell } from '../../shared/fixtures'
import type { DocumentKind, DocumentSlot, DocumentTemplate, DocumentTemplateKind, DocumentTemplatesAnswer, TemplateLanguage } from './api'
import { DocTemplatesView } from './view/DocTemplatesView'
import { rowId, rowsOf, type DocTemplatesModel } from './model'

/**
 * Made-up document templates of the two Demo companies (B-W2b-432), shared by the design cases of the list (SCR-630, below)
 * and the editor (SCR-631): invented words, people with example.com names, dates in October 2026.
 */

export const [DEMO, ESEMPIO] = COMPANIES as [(typeof COMPANIES)[number], (typeof COMPANIES)[number]]
export const tid = (n: number) => `0190f0e2-7c10-7000-8000-${String(n).padStart(12, '0')}`
const LUCIA = { id: '0190f0e2-1111-7000-8000-000000000031', name: 'Lucia Esempio' }
const MARCO = { id: '0190f0e2-1111-7000-8000-000000000032', name: 'Marco Prova' }

export function docTemplate(n: number, over: Partial<DocumentTemplate>): DocumentTemplate {
  return {
    id: tid(n),
    companyId: DEMO.id,
    kind: 'QUOTE',
    language: 'it',
    revision: 1,
    status: 'DRAFT',
    header: null,
    terms: null,
    footer: null,
    fieldsShown: ['code', 'uom', 'unitPrice', 'discount'],
    layout: 'QUOTE/2',
    publishedAt: null,
    publishedBy: null,
    retiredAt: null,
    createdAt: at(10, 9),
    createdBy: LUCIA,
    updatedAt: at(12, 9),
    version: 1,
    ...over,
  }
}

const QUOTE_HEADER = 'Gentile {{party.name}},\nle inviamo la nostra offerta {{quote.number}} del {{quote.date}}, valida fino al {{quote.validUntil}}.'
const QUOTE_TERMS = 'Pagamento: {{document.paymentTerms}}.\nConsegna: {{document.deliveryTerms}}.\nI prezzi si intendono IVA esclusa. Testo di prova, da far controllare.'

export const QUOTE_IT_V1 = docTemplate(1, { revision: 1, status: 'RETIRED', header: 'Gentile {{party.name}},', layout: 'QUOTE/2+t1', publishedAt: at(5, 10), publishedBy: LUCIA, retiredAt: at(14, 11), updatedAt: at(14, 11), version: 3 })
export const QUOTE_IT_V2 = docTemplate(2, { revision: 2, status: 'ACTIVE', header: QUOTE_HEADER, terms: QUOTE_TERMS, fieldsShown: ['code', 'uom', 'unitPrice'], layout: 'QUOTE/2+t2', publishedAt: at(14, 11), publishedBy: MARCO, updatedAt: at(14, 11), version: 2 })
export const QUOTE_IT_V3 = docTemplate(3, { revision: 3, status: 'DRAFT', header: QUOTE_HEADER, terms: QUOTE_TERMS, footer: 'Officina Demo · offerta di prova', fieldsShown: ['code', 'uom', 'unitPrice', 'discount'], layout: 'QUOTE/2+t3', updatedAt: at(27, 15, 20), createdBy: LUCIA, version: 4 })
export const PO_IT_V1 = docTemplate(4, { kind: 'PURCHASE_ORDER', revision: 1, status: 'ACTIVE', header: 'Ordine {{order.number}} — consegna entro {{order.deliveryDate}}.', fieldsShown: ['code', 'uom', 'unitPrice'], layout: 'PURCHASE_ORDER/1+t1', publishedAt: at(20, 9), publishedBy: LUCIA, updatedAt: at(20, 9), version: 2 })
export const INVOICE_EN_V1 = docTemplate(5, { kind: 'INVOICE_COPY', language: 'en', revision: 1, status: 'DRAFT', terms: 'Courtesy copy: the invoice is the one sent through SDI. Test words.', fieldsShown: ['code', 'uom', 'discount'], layout: 'INVOICE_COPY/1+t1', updatedAt: at(28, 10), version: 1 })

export const DEMO_TEMPLATES: DocumentTemplate[] = [QUOTE_IT_V3, QUOTE_IT_V2, QUOTE_IT_V1, PO_IT_V1, INVOICE_EN_V1]

const KINDS: DocumentTemplateKind[] = ['QUOTE', 'ORDER_CONFIRMATION', 'PURCHASE_ORDER', 'DDT', 'INVOICE_COPY', 'PACKING_LIST']

/** The slots of a set of versions, as `GET /templates/documents` answers them (kind by kind, Italian then English). */
export function slotsOf(templates: readonly DocumentTemplate[]): DocumentSlot[] {
  return KINDS.flatMap((kind) =>
    (['it', 'en'] as TemplateLanguage[]).map((language) => {
      const series = templates.filter((template) => template.kind === kind && template.language === language)
      const active = series.find((template) => template.status === 'ACTIVE') ?? null
      const draft = series.find((template) => template.status === 'DRAFT') ?? null
      const last = series.map((template) => template.updatedAt).sort().at(-1) ?? null
      return {
        kind,
        language,
        layout: active?.layout ?? DOCUMENT_LAYOUTS[kind].id,
        active: active ? { id: active.id, revision: active.revision, at: active.publishedAt ?? active.updatedAt } : null,
        draft: draft ? { id: draft.id, revision: draft.revision, at: draft.updatedAt } : null,
        versions: series.length,
        lastChangedAt: last,
      }
    }),
  )
}

export const answerOf = (templates: readonly DocumentTemplate[], mayManage = true): DocumentTemplatesAnswer => ({ templates: [...templates], slots: slotsOf(templates), mayManage })

/** A kind's sections as `GET /templates/documents/kinds` answers them (factory-domain's own rules). */
export const kindOf = (kind: DocumentTemplateKind): DocumentKind => ({
  kind,
  layout: DOCUMENT_LAYOUTS[kind].id,
  optionalColumns: [...optionalColumnsOf(kind)],
  mandatoryColumns: [...MANDATORY_COLUMNS[kind]],
  mandatoryParts: mandatoryPartsOf(kind),
  placeholders: [...DOCUMENT_PLACEHOLDERS[kind]],
  limits: { header: 2000, terms: 20000, footer: 2000 },
})

/**
 * SCR-630 — Admin › Documents & numbering › Document templates (B-W2b-432; design admin.documents/sec:doc-templates,
 * PLT-231, a W2b section of a W0 page) with made-up versions of the Demo company: the quote in Italian in use (version 2)
 * with a draft (3), the purchase order in use, the invoice copy in English as a first draft, everything else on the fixed
 * layout; ticked rows with their bulk actions (each says its reach), the confirm, the notice after a partial run, a company
 * whose legal data is incomplete, read only (documents.view without documents.templates.manage), live updates waiting,
 * reading and failed. Without documents.view the Documents and E-mails lists are absent (the page opens on Numbers).
 */

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName }))
const ANSWER = answerOf(DEMO_TEMPLATES)
const ROWS = rowsOf(ANSWER)
const row = (id: string) => ROWS.find((entry) => entry.id === id)!

const base = (over: Partial<DocTemplatesModel> = {}): DocTemplatesModel => ({
  prefix: '/w/DEMO',
  companies,
  companyId: DEMO.id,
  read: { status: 'ready', answer: ANSWER },
  selected: [],
  confirm: null,
  busy: false,
  notice: null,
  asOf: at(29, 9, 42),
  updates: 0,
  legalMissing: 0,
  ...over,
})

function DocTemplatesDesign({ model }: { model: DocTemplatesModel }) {
  const readOnly = model.read.status === 'ready' && !model.read.answer.mayManage
  return inShell('/admin/documents', createElement(DocTemplatesView, { model }), readOnly ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

const SELECTED = [rowId('QUOTE', 'it'), rowId('PURCHASE_ORDER', 'it'), rowId('INVOICE_COPY', 'en')]

export const designScreen = defineDesignScreen<DocTemplatesModel>({
  screen: 'SCR-630',
  title: 'Documents & numbering › Document templates',
  view: DocTemplatesDesign,
  cases: [
    { id: 'company', label: "A company's templates: in use, drafts, fixed layouts", model: base(), note: 'One row per document and language; Preview opens what prints now (a PDF, new tab); a row opens its editor (SCR-631); "Write a template" starts the first draft.' },
    { id: 'selected', label: 'Three rows ticked: Publish 2, Back to the fixed layout 2, Delete 2', model: base({ selected: SELECTED }), note: 'A fixed-layout row without a draft cannot be ticked (its box says why).' },
    { id: 'confirm-publish', label: 'Publish 2 drafts? (the DS ActionConfirm)', model: base({ selected: SELECTED, confirm: { action: 'publish', rows: [row(rowId('QUOTE', 'it')), row(rowId('INVOICE_COPY', 'en'))] } }) },
    { id: 'confirm-retire', label: 'Back to the fixed layout for 2 documents?', model: base({ selected: SELECTED, confirm: { action: 'retire', rows: [row(rowId('QUOTE', 'it')), row(rowId('PURCHASE_ORDER', 'it'))] } }) },
    {
      id: 'partial',
      label: 'After a bulk run: one published, one refused (in words)',
      model: base({ notice: { key: 'tpl.bulk.partial', tone: 'warning', params: { count: 1, refused: 1 }, refused: [{ id: rowId('INVOICE_COPY', 'en'), said: { key: 'tpl.refusal.ANOTHER_IN_USE' } }] } }),
    },
    { id: 'done', label: 'After a bulk run: every draft deleted', model: base({ notice: { key: 'tpl.bulk.done.delete', tone: 'success', params: { count: 2 } } }) },
    { id: 'not-ready', label: 'A company whose legal data is incomplete', model: base({ companyId: ESEMPIO.id, read: { status: 'ready', answer: answerOf([]) }, legalMissing: 4 }), note: 'Every document prints the fixed layout; the previews refuse until the legal data is complete (the banner says where).' },
    { id: 'updates', label: 'Changed elsewhere: 2 updates waiting behind Show', model: base({ updates: 2 }) },
    { id: 'read-only', label: 'Read only: documents.view without documents.templates.manage', model: base({ read: { status: 'ready', answer: answerOf(DEMO_TEMPLATES, false) } }), note: 'Rows cannot be ticked; "Write a template" is held with the reason; each row still opens read-only.' },
    { id: 'loading', label: 'Reading the templates', model: base({ read: { status: 'loading' }, asOf: null }) },
    { id: 'failed', label: 'The templates could not be read', model: base({ read: { status: 'failed', problem: 'problem.unavailable' } }) },
    { id: 'no-company', label: 'No company to show', model: base({ companyId: null, read: { status: 'ready', answer: answerOf([]) } }) },
  ],
})
