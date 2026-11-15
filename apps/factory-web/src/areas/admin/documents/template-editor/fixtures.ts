import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { samplePdf } from '../../../_shared/document-send/sample-pdf'
import { inShell } from '../../shared/fixtures'
import { DEMO, kindOf, PO_IT_V1, QUOTE_IT_V1, QUOTE_IT_V2, QUOTE_IT_V3 } from '../doc-templates/fixtures'
import { documentDraftOf } from './model'
import { DocTemplateEditorView, type DocEditorModel } from './view/DocTemplateEditorView'

/**
 * SCR-631 — Template: Quote (Italiano) (B-W2b-432; design admin.documents/pop:template-editor, a builder page; PLT-231) with
 * made-up words of the Demo company: the draft with its PDF beside it (a stand-in page here; the live page shows the
 * server's sample on the company's legal data), unsaved changes (the EditModeBar, ⌘S; the preview says it is behind),
 * problems in the words (Save and Publish held with why), the publish confirm, the version in use (New version held while a
 * draft is open), the purchase order in use with no draft, a retired version, read only, changed elsewhere, a refusal in
 * words, a company whose legal data is incomplete (the preview's error with its fix), reading, not found and not allowed.
 */

const PDF = samplePdf(['Officina Demo S.r.l. — ESEMPIO', 'Preventivo Q-2026-0142 del 27/10/2026', 'Gentile Moda Demo S.r.l.,', 'le inviamo la nostra offerta Q-2026-0142, valida fino al 30/11/2026.', 'Codice  Descrizione  Q.ta  Unita  Prezzo  Sconto  Importo', 'GIACCA-01  Giacca in pelle nera  10  pz  450,00  5%  4.275,00', 'Pagamento: bonifico a 30 giorni.', 'Testo di prova, da far controllare.'])
const QUOTE = kindOf('QUOTE')
const VERSIONS = [QUOTE_IT_V3, QUOTE_IT_V2, QUOTE_IT_V1]

const base = (over: Partial<DocEditorModel> = {}): DocEditorModel => ({
  prefix: '/w/DEMO',
  companyName: DEMO.legalName,
  read: { status: 'ready', template: QUOTE_IT_V3, mayManage: true },
  kind: QUOTE,
  versions: VERSIONS,
  draft: documentDraftOf(QUOTE_IT_V3),
  preview: { src: PDF, problem: null },
  busy: false,
  notice: null,
  confirm: null,
  changedElsewhere: false,
  ...over,
})

function EditorDesign({ model }: { model: DocEditorModel }) {
  const readOnly = model.read.status === 'ready' && !model.read.mayManage
  return inShell('/admin/documents/templates/x', createElement(DocTemplateEditorView, { model }), readOnly ? ['home.view', 'numbering.view', 'documents.view'] : undefined)
}

const withDelivery = { ...QUOTE_IT_V3, fieldsShown: ['code', 'unitPrice', 'delivery'] }
const changed = { ...documentDraftOf(QUOTE_IT_V3), terms: `${QUOTE_IT_V3.terms ?? ''}\nResa: franco nostro magazzino.`, fieldsShown: ['code', 'unitPrice', 'discount'] }

export const designScreen = defineDesignScreen<DocEditorModel>({
  screen: 'SCR-631',
  title: 'Template: Quote (Italiano) — the template editor',
  view: EditorDesign,
  cases: [
    { id: 'draft', label: 'A draft: sections on the left, the PDF on the right', model: base(), note: 'Header, Lines (locked columns always print), Totals & what it always prints, Terms, Footer, Versions, Used for; Publish template in the band.' },
    { id: 'unsaved', label: 'Unsaved changes: the EditModeBar (⌘S); Publish waits for the save', model: base({ draft: changed }) },
    {
      id: 'problems',
      label: 'Problems in the words: Save and Publish held with why',
      model: base({ draft: { ...documentDraftOf(QUOTE_IT_V3), header: 'Gentile {{party.name}}, la sua offerta {{ordine.numero}}', terms: 'Pagamento: {{document.paymentTerms', footer: 'x'.repeat(2010) } }),
      note: 'A name the quote does not offer, a placeholder left open, a footer over its limit: each said under its field, counted in the section strip.',
    },
    {
      id: 'dropped-column',
      label: 'A saved draft listing a column the quote does not have: left out, the save offered',
      model: base({ read: { status: 'ready', template: withDelivery, mayManage: true }, draft: documentDraftOf(withDelivery) }),
      note: 'As the seed’s draft: “delivery” is no column of the quote (the API refuses it when publishing); the editor leaves it out, says so, and Publish waits for the save.',
    },
    { id: 'confirm-publish', label: 'Publish version 3? (version 2 is retired in the same step)', model: base({ confirm: 'publish' }) },
    { id: 'published', label: 'Just published: version 3 in use, version 2 retired', model: base({ read: { status: 'ready', template: { ...QUOTE_IT_V3, status: 'ACTIVE', publishedAt: '2026-10-29T09:42:00.000Z' }, mayManage: true }, versions: [{ ...QUOTE_IT_V3, status: 'ACTIVE' }, { ...QUOTE_IT_V2, status: 'RETIRED' }, QUOTE_IT_V1], notice: { key: 'tpl.done.publishedRetired', tone: 'success', params: { revision: 3, retired: 2 } } }) },
    { id: 'in-use-draft-open', label: 'The version in use while a draft is open: New version held, Open draft', model: base({ read: { status: 'ready', template: QUOTE_IT_V2, mayManage: true }, draft: documentDraftOf(QUOTE_IT_V2) }) },
    { id: 'in-use', label: 'The purchase order in use, no draft: New version; More › Back to the fixed layout', model: base({ read: { status: 'ready', template: PO_IT_V1, mayManage: true }, kind: kindOf('PURCHASE_ORDER'), versions: [PO_IT_V1], draft: documentDraftOf(PO_IT_V1) }) },
    { id: 'retired', label: 'A retired version (kept as it printed)', model: base({ read: { status: 'ready', template: QUOTE_IT_V1, mayManage: true }, draft: documentDraftOf(QUOTE_IT_V1) }) },
    { id: 'read-only', label: 'Read only: documents.view without documents.templates.manage', model: base({ read: { status: 'ready', template: QUOTE_IT_V3, mayManage: false } }), note: 'The words read as text, the columns as Shown / Left out; Publish is held with the reason.' },
    { id: 'changed-elsewhere', label: 'Changed by someone else while open (unsaved words kept until Reload)', model: base({ draft: changed, changedElsewhere: true }) },
    { id: 'refused', label: 'A refusal in words: another version was published at the same time', model: base({ notice: { key: 'tpl.refusal.ANOTHER_IN_USE', tone: 'danger' } }) },
    { id: 'legal-missing', label: "The company's legal data is incomplete: the preview says so, with its fix", model: base({ preview: { src: null, problem: 'tpl.preview.legalMissing' } }) },
    { id: 'preview-loading', label: 'The PDF being made', model: base({ preview: { src: null, problem: null } }) },
    { id: 'loading', label: 'Reading the template', model: base({ read: { status: 'loading' }, draft: null }) },
    { id: 'not-found', label: 'A version that is not there (a deleted draft)', model: base({ read: { status: 'failed', problem: 'problem.notFound' }, draft: null }) },
    { id: 'forbidden', label: 'Not allowed: no documents.view over that company', model: base({ read: { status: 'failed', problem: 'problem.forbidden' }, draft: null }) },
  ],
})
