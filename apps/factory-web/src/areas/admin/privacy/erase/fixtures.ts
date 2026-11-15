import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { LOADING } from '../model'
import { ADMIN, base, DEMO_REQUESTS, open, RequestsDesign, type RequestsCase } from '../requests/fixtures'
import type { ErasurePreview } from './api'
import type { EraseModel } from './model'

/**
 * SCR-661 Anonymise …? with made-up data: an invented prospect ("Bruno Prova"), a customer's contact, a worker who still works
 * here. The dialog sits over its request (SCR-660), as it opens from Anonymise….
 */

const { LATE_ERASURE } = DEMO_REQUESTS

const PROSPECT: ErasurePreview = {
  person: { kind: 'PROSPECT', recordType: 'Inquiry', recordId: LATE_ERASURE.person.recordId, name: 'Bruno Prova', erased: false },
  blocked: null,
  anonymised: [{ recordType: 'Inquiry', method: 'ANONYMISED', count: 1, erasedFields: ['prospectName', 'prospectCompany', 'prospectEmail', 'prospectPhone', 'prospectLawfulBasis'], keptFields: [], why: null }],
  deleted: [],
  kept: [
    { recordType: 'InboundEmail', method: 'KEPT', count: 3, erasedFields: [], keptFields: ['fromAddress', 'fromName', 'subject', 'bodyText', 'bodyHtml'], why: { code: 'IMMUTABLE' } },
    { recordType: 'AuditLog', method: 'KEPT', count: 4, erasedFields: [], keptFields: ['before', 'after'], why: { code: 'IMMUTABLE' } },
  ],
  records: 8,
  action: { allowed: true, held: null },
}

const CONTACT: ErasurePreview = {
  person: { kind: 'CONTACT', recordType: 'PartyContact', recordId: LATE_ERASURE.person.recordId, name: 'Anna Esempio', erased: false },
  blocked: null,
  anonymised: [{ recordType: 'PartyContact', method: 'ANONYMISED', count: 1, erasedFields: ['name', 'email', 'phone'], keptFields: [], why: null }],
  deleted: [{ recordType: 'CustomFieldValue', method: 'DELETED', count: 2, erasedFields: [], keptFields: [], why: null }],
  kept: [
    { recordType: 'Party', method: 'KEPT', count: 1, erasedFields: [], keptFields: ['legalName', 'tradeName'], why: { code: 'CUSTOMER' } },
    { recordType: 'MeasurementProfile', method: 'KEPT', count: 1, erasedFields: [], keptFields: ['riderName', 'measurements', 'fitNotes'], why: { code: 'MEASUREMENTS' } },
    { recordType: 'Message', method: 'KEPT', count: 5, erasedFields: [], keptFields: ['authorName', 'bodyText', 'bodyHtml'], why: { code: 'IMMUTABLE' } },
    { recordType: 'EmailOutbound', method: 'KEPT', count: 2, erasedFields: [], keptFields: ['to', 'cc', 'subject'], why: { code: 'IMMUTABLE' } },
  ],
  records: 12,
  action: { allowed: true, held: null },
}

const WORKER: ErasurePreview = {
  person: { kind: 'WORKER', recordType: 'Employee', recordId: LATE_ERASURE.person.recordId, name: 'Carla Demo', erased: false },
  blocked: { code: 'STILL_ACTIVE' },
  anonymised: [],
  deleted: [],
  kept: [
    { recordType: 'Employee', method: 'KEPT', count: 1, erasedFields: [], keptFields: ['firstName', 'lastName', 'displayName'], why: { code: 'EMPLOYMENT' } },
    { recordType: 'Worker', method: 'KEPT', count: 2, erasedFields: [], keptFields: ['displayName'], why: { code: 'EMPLOYMENT' } },
    { recordType: 'WorkerNoticeAck', method: 'KEPT', count: 2, erasedFields: [], keptFields: [], why: { code: 'NOTICE_PROOF' } },
  ],
  records: 5,
  action: { allowed: true, held: null },
}

const erase = (preview: ErasurePreview | null, extra: Partial<EraseModel> = {}): EraseModel => ({
  requestId: LATE_ERASURE.id,
  version: LATE_ERASURE.version,
  preview: preview ? { value: preview, problem: null } : LOADING,
  reason: '',
  typed: '',
  busy: false,
  problem: null,
  done: null,
  ...extra,
})

const at = (model: EraseModel, extra: Parameters<typeof base>[0] = {}, permissions: readonly string[] = ADMIN): RequestsCase => base({ ...open(LATE_ERASURE), erase: model, ...extra }, permissions)
const READY = { reason: 'Asked by mail on 13 Nov to be forgotten.', typed: 'Bruno Prova' }

export const designScreen = defineDesignScreen<RequestsCase>({
  screen: 'SCR-661',
  title: 'Anonymise …?',
  view: RequestsDesign,
  cases: [
    { id: 'prospect', label: 'A prospect: what is erased, what the law keeps', model: at(erase(PROSPECT)), note: 'Anonymised: the inquiry\'s prospect columns; kept as they are, with why: the mails and the history (the database keeps them unchanged).' },
    { id: 'contact', label: 'A customer\'s contact: anonymised, deleted, kept', model: at(erase({ ...CONTACT })), note: 'The customer record stays (invoices keep the business data); the measurements stay for the legal guarantee.' },
    { id: 'armed', label: 'Reason and the typed name: Anonymise armed', model: at(erase(PROSPECT, READY)), note: 'The name exactly as shown (ConfirmPhraseField); Anonymise asks a fresh code next.' },
    { id: 'typed-wrong', label: 'The name typed wrong', model: at(erase(PROSPECT, { reason: READY.reason, typed: 'bruno' })), note: 'Held: "Type the person\'s name exactly as shown."' },
    { id: 'step-up', label: 'Anonymise asks a fresh code', model: at(erase(PROSPECT, { ...READY, busy: true }), { stepUp: { open: true, busy: false, sentence: 'dp.stepUp.erase', problem: null } }) },
    { id: 'step-up-wrong', label: 'A wrong code', model: at(erase(PROSPECT, { ...READY, busy: true }), { stepUp: { open: true, busy: false, sentence: 'dp.stepUp.erase', problem: 'stepUp.problem.wrong' } }) },
    { id: 'blocked', label: 'Blocked: still works here', model: at(erase(WORKER)), note: 'Said with what to do first; the employment records stay 5 years after the end (UNVERIFIED).' },
    { id: 'refused', label: 'Refused: a portal user still signs in', model: at(erase(CONTACT, { reason: READY.reason, typed: 'Anna Esempio', problem: 'dp.erase.blocked.PORTAL_USER' })), note: 'A 409 privacy/PORTAL_USER, said in the page\'s words.' },
    { id: 'no-right', label: 'Without privacy.erase: held', model: at(erase(PROSPECT, READY), {}, ADMIN.filter((permission) => permission !== 'privacy.erase')) },
    { id: 'loading', label: 'Loading the preview', model: at(erase(null)) },
    { id: 'error', label: 'The preview did not load', model: at(erase(null, { preview: { value: null, problem: 'dp.problem.unavailable' } })) },
    { id: 'done', label: 'Anonymised', model: at(erase(PROSPECT, { ...READY, done: { anonymised: 1, deleted: 0, kept: 7 } })) },
  ],
})
