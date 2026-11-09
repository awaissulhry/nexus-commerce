import { STARTER_QUESTIONS } from '@nexus/factory-domain/purchasing/questionnaire/starter'
import { defineDesignScreen } from '../../lib/design/design-screen'
import type { OnboardPage, QuestionView } from './api'
import { EMPTY_FORM, prefilled, type OnboardForm, type OnboardViewModel } from './model'
import { OnboardView } from './view/OnboardView'

/**
 * SCR-269 Supplier questionnaire — made-up data only (PLAN §3.1): an invented factory ("Officina Demo"), an invented
 * tannery, invented people, sites and certificates. One case per step of the form (each kind of question), the VAT number
 * checked in VIES (valid with the name, valid under another name, not checked for an Italian number), a document
 * uploading, held and failed, the review with something to fix, the server's refusals, the draft (restored, saving,
 * failed, kept for later), Sent, and the link's own states (loading, error, gone, the wrong person).
 */

const id = (n: number) => `0190f0e2-7272-7000-8000-${String(n).padStart(12, '0')}`
const TODAY = '2026-11-10'

const PAGE: OnboardPage = {
  sender: { companyName: 'Officina Demo' },
  reviewer: { name: 'Paolo Esempio' },
  note: 'Grazie! Ci serve entro fine mese per il nuovo ordine di pelle nera.',
  supplier: { code: 'SUP-DEMO-07', legalName: 'Conceria Demo S.r.l.', vatNumber: 'IT00000000026', address: 'Via dei Conciatori 1, 56029 Santa Croce sull’Arno (PI), IT', website: null },
  questionnaire: { id: id(1), revision: 2, title: 'Due diligence fornitori', questions: STARTER_QUESTIONS as unknown as QuestionView[], hasCode: true },
  uploaded: [],
  link: { expiresAt: '2026-12-10T17:00:00.000Z', usesLeft: 1 },
  locale: 'it',
}

const CONTACT = (name: string, email: string) => ({ value: { name, email, phone: '+39 0571 000 000' } })

/** A whole answer to the starter set. */
const FULL: OnboardForm = {
  answers: {
    ...prefilled(PAGE).answers,
    'company.website': { value: 'www.conceria-demo.example' },
    'contacts.orders': CONTACT('Anna Ordini', 'ordini@conceria-demo.example'),
    'contacts.invoices': CONTACT('Bruno Fatture', 'fatture@conceria-demo.example'),
    'contacts.quality': CONTACT('Carla Qualità', 'qualita@conceria-demo.example'),
    'certs.lwg-rating': { value: 'SILVER' },
    'certs.lwg': { value: { fileId: id(20), issuer: 'Leather Working Group', number: 'LWG-DEMO-123', issuedOn: '2026-02-01', expiresOn: '2027-01-31' } },
    'certs.reach': { value: 'YES' },
    'certs.cr6-testing': { value: 'EN ISO 17075 su ogni lotto di tintura, laboratorio esterno accreditato.' },
    'certs.cr6-report': { value: { fileId: id(21), issuer: 'Laboratorio Demo', number: 'RP-2026-118', issuedOn: '2026-10-02', expiresOn: null } },
    'labour.id-documents': { value: 'YES' },
    'labour.recruitment-fees': { value: 'NO' },
    'labour.free-to-leave': { value: 'YES' },
    'labour.wages': { value: 'YES' },
    'labour.overtime': { value: 'YES' },
    'labour.child-labour': { value: 'NO' },
    'labour.state-imposed': { value: 'NO' },
    'labour.sub-suppliers': { value: 'YES' },
    'labour.grievance': { value: 'YES' },
    'labour.social-audit': { value: 'YES', explain: 'SMETA 4 pilastri, marzo 2026, ente di audit demo.' },
    'labour.code-of-conduct': { value: 'SIGNED' },
  },
  sites: [{ name: 'Conceria Demo — rifinizione', country: 'IT', town: 'Santa Croce sull’Arno', steps: ['RETANNING', 'FINISHING'] }],
  subTierSites: [
    { name: 'Riviera Demo', country: 'IT', town: 'Ponte a Egola', steps: ['BEAMHOUSE', 'TANNING'] },
    { name: 'Wet blue Demo', country: 'BR', town: null, steps: ['TANNING'] },
  ],
  signedName: '',
  signedRole: 'Responsabile qualità',
  truthful: false,
}

const FILES = [
  { id: id(20), name: 'certificato-LWG-2026.pdf', contentType: 'application/pdf', sizeBytes: 412_000, status: 'AVAILABLE' },
  { id: id(21), name: 'rapporto-cromo-VI.pdf', contentType: 'application/pdf', sizeBytes: 230_000, status: 'AVAILABLE' },
]

function model(overrides: Partial<OnboardViewModel> = {}): OnboardViewModel {
  return {
    link: 'valid',
    page: PAGE,
    problem: null,
    form: prefilled(PAGE),
    step: 'company',
    checked: [],
    issues: [],
    draft: { status: { kind: 'idle' }, restoredAt: null, later: false },
    vat: { status: 'idle', for: '', result: null },
    uploads: {},
    files: [],
    send: 'idle',
    done: null,
    code: 'idle',
    today: TODAY,
    timeZone: 'Europe/Rome',
    ...overrides,
  }
}

const full = (overrides: Partial<OnboardViewModel> = {}) => model({ form: FULL, files: FILES, draft: { status: { kind: 'saved', at: '2026-11-10T09:12:00.000Z' }, restoredAt: null, later: false }, ...overrides })
const DE_VAT = { ...FULL, answers: { ...FULL.answers, 'company.vat': { value: 'DE123456789' }, 'company.legal-name': { value: 'Gerberei Demo GmbH' } } }

export const designScreen = defineDesignScreen<OnboardViewModel>({
  screen: 'SCR-269',
  title: 'Supplier questionnaire (a supplier’s SUPPLIER_ONBOARD link)',
  view: OnboardView,
  cases: [
    { id: 'company', label: '1 · Company · filled from what we hold', model: model(), note: 'Why we ask (the regulation, about 20 minutes, saved with us, who reads it, the buyer’s note), the band (Stepper 1 of 6, SaveStatus, Finish later held until something is answered), the company’s questions with our data as the start.' },
    { id: 'vat-valid', label: '1 · Company · VIES: valid, name matches', model: full({ form: DE_VAT, vat: { status: 'done', for: 'DE123456789', result: { result: 'VALID', nameMatches: true, vatNumber: 'DE123456789' } } }), note: 'An EU number outside Italy, checked live in VIES ("Valid — name matches").' },
    { id: 'vat-other-name', label: '1 · Company · VIES: valid under another name', model: full({ form: DE_VAT, vat: { status: 'done', for: 'DE123456789', result: { result: 'VALID', nameMatches: false, vatNumber: 'DE123456789' } } }) },
    { id: 'vat-italian', label: '1 · Company · an Italian number (format only)', model: full({ vat: { status: 'done', for: 'IT00000000026', result: { result: 'NOT_CHECKED', nameMatches: null, vatNumber: 'IT00000000026' } } }) },
    { id: 'vat-checking', label: '1 · Company · VIES checking', model: full({ form: DE_VAT, vat: { status: 'checking', for: 'DE123456789', result: null } }) },
    { id: 'company-check', label: '1 · Company · Continue with something missing', model: model({ form: { ...EMPTY_FORM }, checked: ['company'] }), note: 'Continue checks the step: each field says what to fix (our words for the check), the focus goes to the first.' },
    { id: 'contacts', label: '2 · Contacts', model: full({ step: 'contacts' }) },
    { id: 'contacts-check', label: '2 · Contacts · a wrong e-mail', model: full({ step: 'contacts', checked: ['contacts'], form: { ...FULL, answers: { ...FULL.answers, 'contacts.quality': { value: { name: 'Carla Qualità', email: 'qualita-at-demo', phone: '' } } } } }) },
    { id: 'sites', label: '3 · Sites and sub-suppliers', model: full({ step: 'sites' }), note: 'Your sites and, for leather, who does each step (beamhouse, tanning, retanning, finishing) and where; Add a site.' },
    { id: 'sites-empty', label: '3 · Sites · none yet, checked', model: full({ step: 'sites', checked: ['sites'], form: { ...FULL, sites: [], subTierSites: [] } }) },
    { id: 'certifications', label: '4 · Certifications and tests', model: full({ step: 'certifications' }), note: 'The LWG rating, documents with their issue and expiry day (uploaded as they are chosen), REACH, the chromium VI practice.' },
    { id: 'certifications-upload', label: '4 · A document uploading, one failed', model: full({ step: 'certifications', uploads: { 'certs.iso-9001': { kind: 'uploading', name: 'ISO9001.pdf' }, 'certs.iso-14001': { kind: 'failed', name: 'ISO14001.heic', key: 'upload.type' } } }) },
    { id: 'certifications-expired', label: '4 · An expired certificate', model: full({ step: 'certifications', checked: ['certifications'], form: { ...FULL, answers: { ...FULL.answers, 'certs.lwg': { value: { fileId: id(20), issuer: 'Leather Working Group', number: 'LWG-DEMO-123', issuedOn: '2025-01-10', expiresOn: '2026-01-09' } } } } }) },
    { id: 'uploads-closed', label: '4 · Uploads held (no virus scanner in a live environment)', model: full({ step: 'certifications', uploads: { 'certs.iso-9001': { kind: 'failed', name: 'ISO9001.pdf', key: 'upload.closed' } } }), note: 'GATE-SPEND: the API refuses uploads from outside while the scanner is off; the page says so in words and the questionnaire can still go.' },
    { id: 'labour', label: '5 · Labour and social', model: full({ step: 'labour' }), note: 'Yes / No with words where the answer needs them; the code of conduct opens in a new tab (a PDF) and is signed with a tick.' },
    { id: 'labour-explain', label: '5 · An answer that needs words', model: full({ step: 'labour', checked: ['labour'], form: { ...FULL, answers: { ...FULL.answers, 'labour.recruitment-fees': { value: 'YES' } } } }) },
    { id: 'code-failed', label: '5 · The code of conduct did not open', model: full({ step: 'labour', code: 'failed' }) },
    { id: 'review', label: '6 · Review and send', model: full({ step: 'sign' }), note: 'Every answer by step with Change, the signer’s role, the SignBlock (name, "true to the best of my knowledge"): Sign and send.' },
    { id: 'review-fix', label: '6 · Review with something to fix', model: full({ step: 'sign', form: { ...FULL, sites: [] } }), note: 'The step to fix is marked; Sign and send goes there and says why.' },
    { id: 'sending', label: '6 · Sending', model: full({ step: 'sign', send: 'busy', form: { ...FULL, signedName: 'Carla Qualità', truthful: true } }) },
    { id: 'refused-fields', label: 'Refused by the server: a document not arrived', model: full({ step: 'certifications', problem: 'problem.fields', issues: [{ step: 'certifications', path: 'answers/certs.lwg/value', code: 'file' }] }) },
    { id: 'refused-changed', label: 'Refused by the server: a new version', model: full({ step: 'sign', problem: 'problem.changed' }) },
    { id: 'refused-server', label: 'Refused by the server: try again', model: full({ step: 'sign', problem: 'problem.server' }) },
    { id: 'draft-restored', label: 'The draft kept with us, restored', model: full({ step: 'certifications', draft: { status: { kind: 'saved', at: '2026-11-09T16:40:00.000Z' }, restoredAt: '2026-11-09T16:40:00.000Z', later: false } }) },
    { id: 'draft-saving', label: 'The draft saving', model: full({ step: 'sites', draft: { status: { kind: 'saving' }, restoredAt: null, later: false } }) },
    { id: 'draft-failed', label: 'The draft could not be saved', model: full({ step: 'sites', draft: { status: { kind: 'failed', count: 1 }, restoredAt: null, later: false } }) },
    { id: 'finish-later', label: 'Finish later: kept until the link expires', model: full({ step: 'labour', draft: { status: { kind: 'saved', at: '2026-11-10T09:14:00.000Z' }, restoredAt: null, later: true } }) },
    { id: 'done', label: 'Sent — Paolo reviews it', model: full({ step: 'sign', form: { ...FULL, signedName: 'Carla Qualità', truthful: true }, done: { sent: { id: id(50), revision: 2, submittedAt: '2026-11-10T09:20:00.000Z', documents: 2 }, reviewer: { name: 'Paolo Esempio' }, sender: { companyName: 'Officina Demo' } } }), note: 'EndState: who reviews it, "We write if anything is missing", what happens next, the receipt.' },
    { id: 'loading', label: 'Loading the questionnaire', model: model({ page: null }), note: 'Skeleton in the shape of the form; "Still loading…" after about a second.' },
    { id: 'error', label: 'Error reading the questionnaire', model: model({ page: null, problem: 'problem.read' }), note: 'Our words and Try again; never an empty form.' },
    { id: 'gone', label: 'The link no longer opens (answered, withdrawn or expired)', model: model({ link: 'unavailable', page: null }) },
    { id: 'wrong-person', label: 'The wrong person', model: model({ link: 'wrong_person', page: null }) },
  ],
})
