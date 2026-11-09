import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { Locale } from '../../../lib/i18n/locales'
import { CATALOGUE, createTranslator } from '../../../lib/i18n/messages'
import { PREFIX, shellOf } from '../orders/design-data'
import type { AskedRow, DocumentRow, SupplierDocuments } from './api'
import { documentsBandOf } from './band'
import { askItems, docRows, emptyDraft, NS, uploadProblems, type SendFacts, type UploadDraft, type UploadTarget } from './model'
import { DocumentsCase, type DocumentsCaseBuilder } from './view/DocumentsCase'
import { heldText, type DocumentsViewModel } from './view/DocumentsView'
import type { UploadDialogModel } from './view/UploadDialog'

/**
 * SCR-190 — the supplier's Documents (B-W2b-193; design portal.supplier.documents), every state with MADE-UP data only: the
 * invented buying company Officina Demo and the invented tannery Conceria Prova S.p.A. (its Admin Luca Prova), purchase
 * order PO-2026-0101, ship notice ASN-2026-0011, dye batch 2231. "We ask for" in each of its groups (needed for our work,
 * renewals, to send again, asked by us; one already with us), "Your documents" in every state (accepted with the
 * countdown, waiting, being checked, held, expired, refused with the reason), a workshop's job, nothing asked and nothing
 * sent, loading, still loading, a failed read, an office preview, a colleague without the right to upload, no connection,
 * two chosen for Download 2, a receipt, a refused open, and the upload pop-up (empty, from a request, with problems,
 * sending, refused, replacing). Never a real company, person or number; never a price.
 */

const TODAY = '2026-11-09'
const NOW = Date.parse(`${TODAY}T09:30:00Z`)
const words = (locale: Locale) => createTranslator(locale, CATALOGUE[locale][NS] ?? {})
const id = (n: number) => `0190f0e2-7777-7000-8000-${String(n).padStart(12, '0')}`
const addDays = (days: number) => new Date(Date.parse(`${TODAY}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10)

const PARTY = { type: 'Party', id: id(900), label: 'CONCERIA-PROVA' }
const PO = { type: 'PurchaseOrder', id: id(1), label: 'PO-2026-0101' }
const PO2 = { type: 'PurchaseOrder', id: id(2), label: 'PO-2026-0104' }
const ASN = { type: 'ShipNotice', id: id(14), label: 'ASN-2026-0011' }
const JOB = { type: 'SubcontractOrder', id: id(30), label: 'JOB-2026-0042' }

const ask = (over: Partial<AskedRow> & Pick<AskedRow, 'key' | 'source'>): AskedRow => ({ category: null, record: PARTY, forRecords: [PARTY], dueOn: null, level: null, state: null, taskId: null, askedBy: null, waiting: false, ...over })

const ASKED: AskedRow[] = [
  ask({ key: 'rule:TEST_REPORT:PurchaseOrder:1', source: 'RULE', category: 'TEST_REPORT', record: PO, forRecords: [PO], dueOn: addDays(-1), level: 'BLOCK', state: 'MISSING' }),
  ask({ key: 'rule:SUPPLIER_CERTIFICATE:Party', source: 'RULE', category: 'SUPPLIER_CERTIFICATE', record: PARTY, forRecords: [PO, PO2], dueOn: addDays(4), level: 'BLOCK', state: 'EXPIRED' }),
  ask({ key: 'rule:DECLARATION:Party', source: 'RULE', category: 'DECLARATION', record: PARTY, forRecords: [ASN], dueOn: addDays(12), level: 'WARN', state: 'MISSING', waiting: true }),
  ask({ key: 'task:1', source: 'EXPIRY', category: 'SUPPLIER_CERTIFICATE', record: PARTY, forRecords: [PARTY], dueOn: addDays(18), taskId: id(501) }),
  ask({ key: 'task:2', source: 'REFUSED', category: 'TEST_REPORT', record: PO2, forRecords: [PO2], dueOn: addDays(9), taskId: id(502), askedBy: 'Giulia Demo' }),
  ask({ key: 'task:3', source: 'ASKED', record: PARTY, forRecords: [PARTY], dueOn: addDays(0), taskId: id(503), askedBy: 'Marco Esempio' }),
]

const doc = (n: number, over: Partial<DocumentRow> & Pick<DocumentRow, 'state' | 'category' | 'name'>): DocumentRow => ({
  fileId: id(600 + n),
  uploadFileId: id(700 + n),
  contentType: 'application/pdf',
  sizeBytes: 240_000 + n * 1000,
  record: PARTY,
  issuer: null,
  number: null,
  issuedOn: null,
  expiresOn: null,
  daysLeft: null,
  articles: [],
  lots: [],
  sentAt: `${addDays(-3)}T10:00:00Z`,
  decidedAt: null,
  reason: null,
  canReplace: false,
  ...over,
})

const DOCUMENTS: DocumentRow[] = [
  doc(1, { state: 'REJECTED', category: 'TEST_REPORT', name: 'cr-vi-2230.pdf', record: PO2, issuer: 'Laboratorio Prova', number: 'LP-4471', issuedOn: addDays(-12), lots: ['2230'], decidedAt: `${addDays(-2)}T15:00:00Z`, reason: 'Il rapporto è per la partita 2230, non la 2231.' }),
  doc(2, { state: 'HELD', category: 'DECLARATION', name: 'reach-2026.pdf', sentAt: `${addDays(-1)}T08:30:00Z` }),
  doc(3, { state: 'EXPIRED', category: 'SUPPLIER_CERTIFICATE', name: 'iso-9001-2023.pdf', issuer: 'Ente Certificatore Demo', number: 'IT-9001-0007', issuedOn: addDays(-1100), expiresOn: addDays(-6), daysLeft: -6, decidedAt: `${addDays(-700)}T09:00:00Z`, canReplace: true }),
  doc(4, { state: 'CHECKING', category: 'DECLARATION', name: 'reach-svhc-2026.pdf', sentAt: `${addDays(0)}T07:45:00Z` }),
  doc(5, { state: 'WAITING', category: 'DECLARATION', name: 'dichiarazione-conformita.pdf', issuer: 'Conceria Prova S.p.A.', issuedOn: addDays(-2), sentAt: `${addDays(-1)}T16:10:00Z` }),
  doc(6, { state: 'ACCEPTED', category: 'SUPPLIER_CERTIFICATE', name: 'lwg-audit-gold.pdf', issuer: 'Audit Pelle Demo', number: 'LWG-0000-12', issuedOn: addDays(-340), expiresOn: addDays(22), daysLeft: 22, decidedAt: `${addDays(-330)}T11:00:00Z`, canReplace: true }),
  doc(7, { state: 'ACCEPTED', category: 'TEST_REPORT', name: 'cr-vi-2231.pdf', record: PO, issuer: 'Laboratorio Prova', number: 'LP-4502', issuedOn: addDays(-5), lots: ['2231'], articles: ['NAPPA-NERO-12'], decidedAt: `${addDays(-4)}T09:00:00Z`, canReplace: true }),
  doc(8, { state: 'ACCEPTED', category: 'SUPPLIER_CERTIFICATE', name: 'iso-14001.pdf', issuer: 'Ente Certificatore Demo', number: 'IT-14001-0003', issuedOn: addDays(-200), expiresOn: addDays(530), daysLeft: 530, decidedAt: `${addDays(-190)}T11:00:00Z`, canReplace: true }),
]

function read(over: Partial<SupplierDocuments> = {}): SupplierDocuments {
  return {
    today: TODAY,
    mayUpload: true,
    categories: ['SUPPLIER_CERTIFICATE', 'TEST_REPORT', 'DECLARATION'],
    requested: ASKED,
    documents: DOCUMENTS,
    counts: { requested: 5, waiting: 2, expiring: 2, refused: 1 },
    live: { events: ['supplier_document.accepted'] },
    ...over,
  }
}

const ADMINS = ['Luca Prova']

function page(over: { read?: SupplierDocuments; facts?: Partial<SendFacts>; model?: Partial<DocumentsViewModel> } = {}): DocumentsViewModel {
  const value = over.read ?? read()
  const facts: SendFacts = { preview: false, offline: false, mayUpload: value.mayUpload, ...over.facts }
  const held = facts.preview ? 'held.preview' : facts.offline ? 'held.offline' : facts.mayUpload ? null : 'held.mayNotUpload'
  return {
    state: 'ready',
    slow: false,
    now: NOW,
    prefix: PREFIX,
    kinds: ['SUPPLIER'],
    asks: askItems(value, facts),
    rows: docRows(value),
    selected: [],
    busy: null,
    held,
    admins: ADMINS,
    receipt: null,
    problem: null,
    dialog: null,
    ...over.model,
  }
}

function pageCase(build: (locale: Locale) => { read?: SupplierDocuments; facts?: Partial<SendFacts>; model?: Partial<DocumentsViewModel>; preview?: boolean; kinds?: readonly ('SUPPLIER' | 'SUBCONTRACTOR')[] }): DocumentsCaseBuilder {
  return (locale) => {
    const t = words(locale)
    const input = build(locale)
    const model = page(input)
    const shell = shellOf(locale, { path: '/documents', preview: input.preview ?? false, band: documentsBandOf({ t, locale, asOf: model.state === 'ready' ? NOW : null, uploadHeld: model.state === 'ready' ? heldText(t, model.held, model.admins) : t('held.loading') }) })
    return { shell, body: { kind: 'page', model: input.kinds ? { ...model, kinds: input.kinds } : model } }
  }
}

const dialogOf = (target: UploadTarget, over: Partial<UploadDialogModel> = {}, draft: Partial<UploadDraft> = {}): UploadDialogModel => {
  const full = { ...emptyDraft(target.category), ...draft }
  const file = over.file ?? null
  return { target, draft: full, file, problems: uploadProblems(full, file, TODAY), showProblems: false, sending: false, failed: null, held: null, today: TODAY, ...over }
}
const FREE: UploadTarget = { category: null, for: { key: 'documents.for.Party' } }
const FROM_RULE: UploadTarget = { category: 'TEST_REPORT', recordType: 'PurchaseOrder', recordId: PO.id, for: { key: 'documents.for.PurchaseOrder', params: { label: PO.label } } }
const REPLACE: UploadTarget = { replacesFileId: id(606), category: 'SUPPLIER_CERTIFICATE', for: { key: 'documents.for.Party' }, replaces: 'lwg-audit-gold.pdf' }
const PDF = { name: 'cr-vi-2231-rev1.pdf', size: 318_000, type: 'application/pdf' }
const TYPED: Partial<UploadDraft> = { issuer: 'Laboratorio Prova', number: 'LP-4502', issuedOn: addDays(-5), lots: '2231', articles: 'NAPPA-NERO-12' }

export const designScreen = defineDesignScreen<DocumentsCaseBuilder>({
  screen: 'SCR-190',
  title: 'Documents (supplier portal)',
  view: DocumentsCase,
  cases: [
    { id: 'normal', label: 'We ask for + Your documents', model: pageCase(() => ({})), note: 'We ask for: needed for our work (a test report for PO-2026-0101, overdue; the company certificate that expired, for two orders), a renewal, one to send again with our reason, one asked by Marco; one already with us (Upload held: "we are checking it"). Your documents: refused with the reason + Upload again, held, expired, checking, waiting, accepted with the countdown ("expires in 22 d"); Open in a new tab, ⋯ Download, Replace. No price anywhere.' },
    { id: 'workshop', label: 'A workshop: a job asks for a report', model: pageCase(() => ({ kinds: ['SUBCONTRACTOR'], read: read({ requested: [ask({ key: 'rule:TEST_REPORT:SubcontractOrder:30', source: 'RULE', category: 'TEST_REPORT', record: JOB, forRecords: [JOB], dueOn: addDays(3), level: 'BLOCK', state: 'MISSING' })], documents: DOCUMENTS.slice(5) }) })) },
    { id: 'empty', label: 'Nothing asked, nothing sent', model: pageCase(() => ({ read: read({ requested: [], documents: [] }) })), note: '"We need nothing right now." and "No documents yet." + Upload a document.' },
    { id: 'all-with-us', label: 'Everything asked is with us', model: pageCase(() => ({ read: read({ requested: ASKED.filter((row) => row.source === 'RULE').map((row) => ({ ...row, waiting: true })) }) })) },
    { id: 'loading', label: 'Loading', model: pageCase(() => ({ model: { state: 'loading', asks: [], rows: [] } })) },
    { id: 'loading-slow', label: 'Still loading after a second', model: pageCase(() => ({ model: { state: 'loading', slow: true, asks: [], rows: [] } })) },
    { id: 'error', label: 'The page could not be read', model: pageCase(() => ({ model: { state: 'error', asks: [], rows: [] } })), note: 'Each section says the problem with Try again; a failed read is never drawn as empty.' },
    { id: 'no-permission', label: 'Not part of the person’s access', model: (locale) => ({ shell: shellOf(locale, { path: '/documents', band: { title: words(locale)('documents.title') } }), body: { kind: 'noAccess', admins: ADMINS } }), note: 'A typed or old address (a customer, a role without the page): who to ask, and Home. Not in the navigation (fails closed).' },
    { id: 'preview', label: 'An office preview', model: pageCase(() => ({ preview: true, facts: { preview: true } })), note: 'Every Upload, Replace and Upload again is held: "This is a preview of the portal: nothing can be sent here."' },
    { id: 'viewer', label: 'A colleague without the right to upload', model: pageCase(() => ({ read: read({ mayUpload: false }) })), note: '"Your access lets you read our requests, not send documents: ask Luca Prova for the right to send files."' },
    { id: 'offline', label: 'No connection', model: pageCase(() => ({ facts: { offline: true } })), note: 'The frame says it once; every send is held with "No connection".' },
    { id: 'selected', label: 'Two documents chosen: Download 2', model: pageCase(() => ({ model: { selected: [id(606), id(607)] } })), note: 'Only what we shared back can be chosen; a waiting or refused one says why on its box.' },
    { id: 'receipt', label: 'After sending a document', model: pageCase(() => ({ model: { receipt: { tone: 'success', words: { key: 'receipt.sent', params: { name: 'cr-vi-2231-rev1.pdf' } } } } })) },
    { id: 'open-failed', label: 'A document could not be opened', model: pageCase(() => ({ model: { problem: 'documents.openFailed' } })) },
    { id: 'keys', label: 'Keyboard: a row focused', model: pageCase(() => ({ model: { focusRow: 5 } })), note: 'Enter opens it in a new tab; u uploads; the keys are in the footer’s info icon.' },
    { id: 'upload', label: 'Pop-up: Upload a document', model: pageCase(() => ({ model: { dialog: dialogOf(FREE) } })), note: 'Kind · the file (PDF, JPG or PNG, at most 20 MB) · issuer · number · issued · expires · articles and lots · a note; "We check it before it counts."' },
    { id: 'upload-row', label: 'Pop-up: from a request (test report for PO-2026-0101)', model: pageCase(() => ({ model: { dialog: dialogOf(FROM_RULE, { file: PDF }, TYPED) } })) },
    {
      id: 'upload-problems',
      label: 'Pop-up: with problems',
      model: pageCase(() => ({ model: { dialog: dialogOf(FREE, { showProblems: true }, { issuedOn: addDays(3), expiresOn: addDays(-10), lots: 'A-CODE-LONGER-THAN-SIXTY-CHARACTERS-WHICH-IS-NOT-ONE-CODE-AT-ALL-0001' }) } })),
    },
    { id: 'upload-sending', label: 'Pop-up: sending', model: pageCase(() => ({ model: { dialog: dialogOf(FROM_RULE, { file: PDF, sending: true }, TYPED) } })) },
    { id: 'upload-refused', label: 'Pop-up: the send refused', model: pageCase(() => ({ model: { dialog: dialogOf(FROM_RULE, { file: PDF, failed: 'upload.failed.answered' }, TYPED) } })), note: 'The request was answered meanwhile (by a colleague): said in our words; the page reads again.' },
    { id: 'upload-replace', label: 'Pop-up: Replace with a new version', model: pageCase(() => ({ model: { dialog: dialogOf(REPLACE, { file: { name: 'lwg-audit-gold-2027.pdf', size: 412_000, type: 'application/pdf' } }, { issuer: 'Audit Pelle Demo', number: 'LWG-0000-12', issuedOn: addDays(-1), expiresOn: addDays(364) }) } })), note: 'The accepted one stays in force until we accept the new one.' },
  ],
})
