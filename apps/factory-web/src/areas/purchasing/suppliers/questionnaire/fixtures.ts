import { createElement } from 'react'
import { STARTER_QUESTIONS } from '@nexus/factory-domain/purchasing/questionnaire/starter'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { inShell, panels, RECORD_CAN, recordModel, SUPPLIERS } from '../../../parties/_shared/fixtures'
import { PartyRecordView } from '../../../parties/_shared/view/PartyRecordView'
import type { AnswerView, QuestionnaireVersion, SupplierQuestionnaire } from './api'
import { EMPTY_REVIEW, sendFormOf, type QuestionnaireViewModel } from './model'
import { QuestionnaireView } from './view/QuestionnaireView'

/**
 * SCR-057-questionnaire — Supplier › Questionnaire (B-W2b-172; design purchasing.suppliers "Links › Supplier
 * questionnaire (W2b) — Onboarding"; the buyer's review of SCR-269's answers). Made-up data only: an invented factory, an
 * invented tannery and people. Every state the buyer meets: no questionnaire published yet (publish the starter set), an
 * open link and no answer, an answer to review with its documents, the answers read in full, the review (accepted, or
 * questions back on the supplier's thread), Send the questionnaire (by e-mail; a link to pass on, given once), held for a
 * role without the right, loading and a failed read.
 */

const party = SUPPLIERS[0]!
const id = (n: number) => `0190f0e2-5757-7000-8000-${String(n).padStart(12, '0')}`

const VERSION: QuestionnaireVersion = {
  id: id(1),
  companyId: id(900),
  revision: 2,
  title: 'Due diligence fornitori',
  questions: STARTER_QUESTIONS.map((question) => ({ ...question })) as QuestionnaireVersion['questions'],
  published: true,
  publishedAt: '2026-10-20T09:00:00.000Z',
  version: 2,
  updatedAt: '2026-10-20T09:00:00.000Z',
}

const CONTACT = (name: string, email: string) => ({ value: { name, email, phone: '+39 0571 000 000' } })

const ANSWER: AnswerView = {
  id: id(10),
  questionnaireId: VERSION.id,
  revision: 2,
  state: 'WAITING',
  via: 'LINK',
  linkId: id(30),
  submittedAt: '2026-11-08T15:20:00.000Z',
  signedName: 'Carla Qualità',
  signedRole: 'Responsabile qualità',
  answers: {
    'company.legal-name': { value: 'Conceria Demo S.r.l.' },
    'company.vat': { value: 'IT00000000026' },
    'company.address': { value: 'Via dei Conciatori 1, 56029 Santa Croce sull’Arno (PI)' },
    'contacts.orders': CONTACT('Anna Ordini', 'ordini@conceria-demo.example'),
    'contacts.invoices': CONTACT('Bruno Fatture', 'fatture@conceria-demo.example'),
    'contacts.quality': CONTACT('Carla Qualità', 'qualita@conceria-demo.example'),
    'certs.lwg-rating': { value: 'SILVER' },
    'certs.lwg': { value: { fileId: id(20), issuer: 'Leather Working Group', number: 'LWG-DEMO-123', issuedOn: '2026-02-01', expiresOn: '2027-01-31' } },
    'certs.reach': { value: 'YES' },
    'certs.cr6-testing': { value: 'EN ISO 17075 su ogni lotto di tintura, laboratorio esterno.' },
    'labour.id-documents': { value: 'YES' },
    'labour.recruitment-fees': { value: 'NO' },
    'labour.free-to-leave': { value: 'YES' },
    'labour.wages': { value: 'YES' },
    'labour.overtime': { value: 'YES' },
    'labour.child-labour': { value: 'NO' },
    'labour.state-imposed': { value: 'NO' },
    'labour.sub-suppliers': { value: 'NO', explain: 'La riviera partner firma il nostro codice da gennaio.' },
    'labour.grievance': { value: 'YES' },
    'labour.social-audit': { value: 'YES', explain: 'SMETA, marzo 2026.' },
    'labour.code-of-conduct': { value: 'SIGNED' },
  },
  sites: [{ name: 'Conceria Demo — rifinizione', country: 'IT', town: 'Santa Croce sull’Arno', steps: ['RETANNING', 'FINISHING'] }],
  subTierSites: [{ name: 'Riviera Demo', country: 'IT', town: 'Ponte a Egola', steps: ['BEAMHOUSE', 'TANNING'] }],
  documents: [{ key: 'certs.lwg', fileId: id(20), name: 'certificato-LWG-2026.pdf', contentType: 'application/pdf', status: 'AVAILABLE', category: 'SUPPLIER_CERTIFICATE', issuer: 'Leather Working Group', number: 'LWG-DEMO-123', issuedOn: '2026-02-01', expiresOn: '2027-01-31', inForce: false }],
  pdf: { fileId: id(21), name: 'Questionario fornitore - versione 2 - SUP-DEMO-07 - 2026-11-08.pdf' },
  review: null,
  task: { id: id(40), open: true, assigneeName: 'Paolo Esempio', dueDate: '2026-11-13' },
  version: 1,
}

const EARLIER: AnswerView = {
  ...ANSWER,
  id: id(11),
  linkId: id(31),
  submittedAt: '2026-10-26T15:20:00.000Z',
  state: 'QUESTIONS',
  answers: { ...ANSWER.answers, 'labour.sub-suppliers': { value: 'NO', explain: 'Solo i nostri siti.' } },
  subTierSites: [],
  documents: [],
  review: { at: '2026-10-27T10:00:00.000Z', byName: 'Paolo Esempio', note: 'Chiedere il nome della riviera partner.' },
  task: { id: id(41), open: false, assigneeName: 'Paolo Esempio', dueDate: '2026-10-31' },
  version: 2,
}

const DATA: SupplierQuestionnaire = {
  party: { id: party.id, code: party.code, name: party.tradeName ?? party.legalName, language: 'it' },
  companyId: VERSION.companyId,
  current: VERSION,
  draft: null,
  versions: [VERSION],
  links: [
    { id: id(30), state: 'ANSWERED', email: 'qualita@conceria-demo.example', note: null, sentAt: '2026-11-02T08:30:00.000Z', sentByName: 'Paolo Esempio', expiresAt: '2026-12-02T08:30:00.000Z', answerId: ANSWER.id },
    { id: id(31), state: 'ANSWERED', email: 'qualita@conceria-demo.example', note: null, sentAt: '2026-10-20T09:10:00.000Z', sentByName: 'Paolo Esempio', expiresAt: '2026-11-19T09:10:00.000Z', answerId: EARLIER.id },
  ],
  answers: [ANSWER, EARLIER],
  contacts: [
    { id: id(60), name: 'Carla Qualità', email: 'qualita@conceria-demo.example', language: 'it' },
    { id: id(61), name: 'Anna Ordini', email: 'ordini@conceria-demo.example', language: 'it' },
  ],
  may: { send: true, review: true, manage: true },
  live: { events: [] },
}

function model(overrides: Partial<QuestionnaireViewModel> = {}): QuestionnaireViewModel {
  return {
    data: DATA,
    problem: null,
    dialog: null,
    send: { form: sendFormOf(DATA), busy: false, problem: null, field: null, result: null },
    review: { form: EMPTY_REVIEW, busy: false, problem: null, field: null },
    publishing: false,
    notice: null,
    opening: null,
    timeZone: 'Europe/Rome',
    ...overrides,
  }
}

function SupplierQuestionnaireDesign({ model: tab }: { model: QuestionnaireViewModel }) {
  const record = recordModel('suppliers', party, { tab: 'questionnaire', can: { ...RECORD_CAN, questionnaire: true } })
  return inShell(`/purchasing/suppliers/${party.id}`, createElement(PartyRecordView, { model: record, panels: panels(party), questionnaire: createElement(QuestionnaireView, { model: tab }) }))
}

const OPEN_ONLY: SupplierQuestionnaire = { ...DATA, answers: [], links: [{ id: id(32), state: 'OPEN', email: 'qualita@conceria-demo.example', note: 'Grazie!', sentAt: '2026-11-09T08:30:00.000Z', sentByName: 'Paolo Esempio', expiresAt: '2026-12-09T08:30:00.000Z', answerId: null }] }
const NONE: SupplierQuestionnaire = { ...DATA, current: null, versions: [], answers: [], links: [] }
const READ_ONLY: SupplierQuestionnaire = { ...DATA, may: { send: false, review: false, manage: false } }

export const designScreen = defineDesignScreen<QuestionnaireViewModel>({
  screen: 'SCR-057-questionnaire',
  title: 'Supplier › Questionnaire (the buyer’s review)',
  view: SupplierQuestionnaireDesign,
  cases: [
    { id: 'to-review', label: 'An answer to review, an earlier one with questions sent', model: model(), note: 'The version a link asks, Send the questionnaire, the answers newest first (state, signer, sites, documents, review task, PDF) and the links sent beside; fills the tab at 1440 and 1920.' },
    { id: 'answer', label: 'The answers read in full', model: model({ dialog: { kind: 'answer', id: ANSWER.id } }), note: 'By step, each question in the reader’s language with the answer and its words; the documents with their dates and state, each opened in a new tab.' },
    { id: 'review', label: 'Review · choose', model: model({ dialog: { kind: 'review', id: ANSWER.id } }) },
    { id: 'review-questions', label: 'Review · questions back on the supplier’s thread', model: model({ dialog: { kind: 'review', id: ANSWER.id }, review: { form: { decision: 'QUESTIONS', questions: 'Chi fa la riviera per voi e in quale paese?', note: '' }, busy: false, problem: null, field: null } }) },
    { id: 'review-check', label: 'Review · questions back without words (refused by the page)', model: model({ dialog: { kind: 'review', id: ANSWER.id }, review: { form: { decision: 'QUESTIONS', questions: '', note: '' }, busy: false, problem: 'review.check.questions', field: 'questions' } }) },
    { id: 'accepted', label: 'Accepted: its document in force', model: model({ data: { ...DATA, answers: [{ ...ANSWER, state: 'ACCEPTED', review: { at: '2026-11-09T10:00:00.000Z', byName: 'Paolo Esempio', note: null }, documents: ANSWER.documents.map((document) => ({ ...document, inForce: true })), task: { ...ANSWER.task!, open: false } }, EARLIER] }, notice: { key: 'notice.accepted', tone: 'success', params: { count: 1 } } }) },
    { id: 'send', label: 'Send the questionnaire · by e-mail', model: model({ dialog: { kind: 'send' } }) },
    { id: 'send-link', label: 'Send · a link to pass on', model: model({ dialog: { kind: 'send' }, send: { form: { ...sendFormOf(DATA), mode: 'link' }, busy: false, problem: null, field: null, result: null } }) },
    { id: 'send-given', label: 'Send · the link given once', model: model({ dialog: { kind: 'send' }, send: { form: { ...sendFormOf(DATA), mode: 'link' }, busy: false, problem: null, field: null, result: { link: { id: id(33), expiresAt: '2026-12-10T09:00:00.000Z', email: null, withdrawn: 1 }, url: 'https://factory.example/l#token=demo-only', delivery: null } } }) },
    { id: 'send-refused', label: 'Send · the address bounced (refused by the server)', model: model({ dialog: { kind: 'send' }, send: { form: sendFormOf(DATA), busy: false, problem: 'problem.suppressed', field: 'email', result: null } }) },
    { id: 'open-link', label: 'A link open, no answer yet', model: model({ data: OPEN_ONLY }) },
    { id: 'no-version', label: 'No questionnaire published yet', model: model({ data: NONE }), note: 'Send is held with why; Publish the starter questionnaire (the due-diligence set for Regulation (EU) 2024/3015).' },
    { id: 'read-only', label: 'A role without send, review or manage: held with the missing right', model: model({ data: READ_ONLY }) },
    { id: 'loading', label: 'Loading', model: model({ data: null }), note: 'Skeleton in the tab’s shape; "Still loading…" after about a second.' },
    { id: 'error', label: 'Couldn’t load the questionnaire: our words and Try again (never drawn as empty)', model: model({ data: null, problem: 'problem.read' }) },
  ],
})
