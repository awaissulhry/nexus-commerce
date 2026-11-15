import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, OWNER_PERMISSIONS } from '../../../../shell/design-data'
import { STEP_UP_CLOSED } from '../../shared/model'
import { inShell } from '../../shared/fixtures'
import { designScreen as privacyScreen } from '../fixtures'
import { LOADING, privacyCan, type PrivacyViewModel } from '../model'
import { PrivacyView } from '../view/PrivacyView'
import type { DataRequest, PersonOption } from './api'
import { DepthDutiesView, type DepthDutiesModel } from './DepthDuties'
import { emptyDraft, requestsCan, type NewRequestModel, type RequestDialogModel, type RequestsViewModel } from './model'
import { NewRequestButtonView } from './view/NewRequestButton'
import { RequestsView } from './view/RequestsView'

/**
 * SCR-660 Admin › Privacy › Data requests with made-up data: invented people ("Anna Esempio", "Bruno Prova" …) of the two Demo
 * companies, an invented package. Nothing here is a real person, request or file. The section is drawn where it lives: the
 * fourth list of Privacy & notices (SCR-086), with its two duty lines and New data request in the head.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const [demo, esempio] = DEMO_COMPANIES as unknown as [{ id: string; code: string; name: string }, { id: string; code: string; name: string }]
/** The read's clock: 15 Nov 2026, 10:00 in Rome. */
export const NOW = Date.UTC(2026, 10, 15, 9, 0)
const hours = (n: number) => new Date(NOW + n * 3_600_000).toISOString()

export const ADMIN = [...OWNER_PERMISSIONS, 'privacy.view', 'privacy.manage', 'privacy.requests.view', 'privacy.requests.manage', 'privacy.erase', 'privacy.retention.manage', 'parties.view', 'sales.inquiries.view', 'sales.safety.view', 'users.view', 'people.view', 'files.read']
const READER = [...OWNER_PERMISSIONS, 'privacy.view', 'privacy.requests.view']
const NO_REQUESTS = [...OWNER_PERMISSIONS, 'privacy.view']

const allowed = { allowed: true, held: null }
const held = (code: NonNullable<DataRequest['actions']['close']['held']>['code']) => ({ allowed: false, held: { code } })

function request(n: number, extra: Partial<DataRequest>): DataRequest {
  const base: DataRequest = {
    id: uid('4141', n),
    company: demo,
    person: { kind: 'CONTACT', recordType: 'PartyContact', recordId: uid('5151', n), name: 'Anna Esempio', erased: false },
    kind: 'ACCESS',
    receivedAt: hours(-24 * 10),
    dueAt: hours(24 * 20),
    originalDueAt: hours(24 * 20),
    extended: false,
    extensionReason: null,
    overdue: false,
    hoursLeft: 24 * 20,
    note: null,
    identityCheckedAt: null,
    identityCheckedBy: null,
    status: 'RECEIVED',
    decidedAt: null,
    decidedBy: null,
    refusalReason: null,
    package: null,
    collect: { state: 'NONE', at: null },
    erasure: null,
    version: 1,
    actions: { checkIdentity: allowed, extend: allowed, collect: held('NOT_STARTED'), openPackage: held('NO_PACKAGE'), erase: held('NOT_ERASURE'), close: held('NOT_STARTED'), refuse: allowed, withdraw: allowed },
  }
  return { ...base, ...extra }
}

const checked = { identityCheckedAt: hours(-24 * 9), identityCheckedBy: { id: uid('3333', 1), name: 'Alex Demo' }, status: 'IN_PROGRESS' as const }

const LATE_ERASURE = request(1, {
  kind: 'ERASURE',
  person: { kind: 'PROSPECT', recordType: 'Inquiry', recordId: uid('6161', 1), name: 'Bruno Prova', erased: false },
  receivedAt: hours(-24 * 32),
  dueAt: hours(-48),
  originalDueAt: hours(-48),
  overdue: true,
  hoursLeft: -48,
  ...checked,
  collect: null,
  erasure: { records: 0, anonymised: 0, deleted: 0, kept: 0 },
  note: 'Asked by mail to be forgotten after a quote he did not accept.',
  actions: { checkIdentity: held('IDENTITY_CHECKED'), extend: held('TOO_LATE_TO_EXTEND'), collect: held('NOT_ACCESS'), openPackage: held('NOT_ACCESS'), erase: allowed, close: held('NOT_ERASED'), refuse: allowed, withdraw: allowed },
})
const SOON_ACCESS = request(2, { receivedAt: hours(-24 * 28), dueAt: hours(40), originalDueAt: hours(40), hoursLeft: 40, note: 'Wants a copy of the measurements and orders on file.' })
const COLLECTING = request(3, {
  person: { kind: 'WORKER', recordType: 'Employee', recordId: uid('7171', 3), name: 'Carla Demo', erased: false },
  ...checked,
  collect: { state: 'RUNNING', at: hours(-0.05) },
  actions: { checkIdentity: held('IDENTITY_CHECKED'), extend: allowed, collect: allowed, openPackage: held('NO_PACKAGE'), erase: held('NOT_ERASURE'), close: held('NO_PACKAGE'), refuse: allowed, withdraw: allowed },
})
const READY = request(4, {
  person: { kind: 'USER', recordType: 'User', recordId: uid('3333', 9), name: 'Dario Esempio', erased: false },
  company: esempio,
  ...checked,
  package: { fileId: uid('8181', 4), name: 'data-request-2026-11-14.zip', sizeBytes: 1_284_000, sha256: 'a3f1c9e07b5d2e8f'.repeat(4), madeAt: hours(-20) },
  collect: { state: 'READY', at: hours(-20) },
  actions: { checkIdentity: held('IDENTITY_CHECKED'), extend: allowed, collect: allowed, openPackage: allowed, erase: held('NOT_ERASURE'), close: allowed, refuse: allowed, withdraw: allowed },
})
const CORRECTION = request(5, { kind: 'CORRECTION', person: { kind: 'REPORTER', recordType: 'ProductSafetyReport', recordId: uid('9191', 5), name: 'Elena Prova', erased: false }, collect: null, receivedAt: hours(-24 * 2), dueAt: hours(24 * 28), originalDueAt: hours(24 * 28), hoursLeft: 24 * 28, actions: { checkIdentity: allowed, extend: allowed, collect: held('NOT_ACCESS'), openPackage: held('NOT_ACCESS'), erase: held('NOT_ERASURE'), close: held('NOT_STARTED'), refuse: allowed, withdraw: allowed } })
const EXTENDED = request(6, {
  person: { kind: 'CONTACT', recordType: 'PartyContact', recordId: uid('5151', 6), name: 'Franco Esempio', erased: false },
  receivedAt: hours(-24 * 40),
  originalDueAt: hours(-24 * 10),
  dueAt: hours(24 * 50),
  hoursLeft: 24 * 50,
  extended: true,
  extensionReason: 'Many orders across two companies: the copy needs the archive of 2019.',
  ...checked,
  actions: { checkIdentity: held('IDENTITY_CHECKED'), extend: held('EXTENDED'), collect: allowed, openPackage: held('NO_PACKAGE'), erase: held('NOT_ERASURE'), close: held('NO_PACKAGE'), refuse: allowed, withdraw: allowed },
})
const ERASED_DONE = request(7, {
  kind: 'ERASURE',
  person: { kind: 'CONTACT', recordType: 'PartyContact', recordId: uid('5151', 7), name: 'Erased person', erased: true },
  receivedAt: hours(-24 * 60),
  dueAt: hours(-24 * 30),
  originalDueAt: hours(-24 * 30),
  hoursLeft: -24 * 30,
  ...checked,
  status: 'DONE',
  decidedAt: hours(-24 * 35),
  decidedBy: { id: uid('3333', 1), name: 'Alex Demo' },
  collect: null,
  erasure: { records: 9, anonymised: 1, deleted: 0, kept: 8 },
  actions: { checkIdentity: held('CLOSED'), extend: held('CLOSED'), collect: held('CLOSED'), openPackage: held('NOT_ACCESS'), erase: held('CLOSED'), close: held('CLOSED'), refuse: held('CLOSED'), withdraw: held('CLOSED') },
})
const REFUSED = request(8, {
  person: { kind: 'PROSPECT', recordType: 'Inquiry', recordId: uid('6161', 8), name: 'Gina Prova', erased: false },
  receivedAt: hours(-24 * 50),
  dueAt: hours(-24 * 20),
  originalDueAt: hours(-24 * 20),
  hoursLeft: -24 * 20,
  status: 'REFUSED',
  decidedAt: hours(-24 * 25),
  decidedBy: { id: uid('3333', 1), name: 'Alex Demo' },
  refusalReason: 'The same request for the fourth time this month, already answered in full.',
  actions: { checkIdentity: held('CLOSED'), extend: held('CLOSED'), collect: held('CLOSED'), openPackage: held('NO_PACKAGE'), erase: held('NOT_ERASURE'), close: held('CLOSED'), refuse: held('CLOSED'), withdraw: held('CLOSED') },
})

const OPEN = [LATE_ERASURE, SOON_ACCESS, COLLECTING, CORRECTION, READY, EXTENDED]
const ALL = [...OPEN, ERASED_DONE, REFUSED]
export const DEMO_REQUESTS = { LATE_ERASURE, SOON_ACCESS, COLLECTING, READY, CORRECTION, EXTENDED, ERASED_DONE, REFUSED }

const COMPANIES = [demo, esempio].map((company) => ({ id: company.id, name: company.name }))
const CUSTOMERS: PersonOption[] = [
  { recordType: 'Party', recordId: uid('2121', 1), label: 'C-0001 · Moto Club Esempio', companyId: demo.id },
  { recordType: 'Party', recordId: uid('2121', 2), label: 'C-0002 · Rider Demo Store', companyId: null },
]
const CONTACTS: PersonOption[] = [
  { recordType: 'PartyContact', recordId: uid('5151', 11), label: 'Anna Esempio', companyId: demo.id },
  { recordType: 'PartyContact', recordId: uid('5151', 12), label: 'Ugo Demo', companyId: demo.id },
]

export type RequestsCase = { model: RequestsViewModel; permissions: readonly string[]; duties?: DepthDutiesModel }
type Case = RequestsCase

export function base(extra: Partial<RequestsViewModel> = {}, permissions: readonly string[] = ADMIN): Case {
  return {
    permissions,
    model: {
      prefix: '/w/DEMO',
      can: requestsCan(permissions),
      address: { view: 'open', kind: null, request: null, creating: false },
      companyId: demo.id,
      companies: COMPANIES,
      list: { value: { requests: OPEN, counts: { open: OPEN.length, overdue: 1 } }, problem: null },
      selected: [],
      updates: 0,
      now: NOW,
      timeZone: 'Europe/Rome',
      dialog: null,
      creating: null,
      erase: null,
      stepUp: STEP_UP_CLOSED,
      notice: null,
      ...extra,
    },
  }
}

export const open = (found: DataRequest, extra: Partial<RequestDialogModel> = {}): Partial<RequestsViewModel> => ({
  address: { view: 'open', kind: null, request: found.id, creating: false },
  dialog: { requestId: found.id, read: { value: found, problem: null }, form: null, busy: false, problem: null, done: null, ...extra },
})

const creating = (extra: Partial<NewRequestModel> = {}): Partial<RequestsViewModel> => ({
  address: { view: 'open', kind: null, request: null, creating: true },
  creating: { draft: emptyDraft(demo.id, new Date(NOW).toISOString()), found: null, contacts: null, busy: false, problem: null, ...extra },
})

/** The page around the section (SCR-086's owner case), its fourth list open. */
const PAGE = privacyScreen.cases.find((item) => item.id === 'owner')!.model.model

export function RequestsDesign({ model }: { model: Case }) {
  const page: PrivacyViewModel = { ...PAGE, can: privacyCan(model.permissions), view: 'requests' }
  const duties = model.duties ?? { requests: { open: 6, late: 1 }, retention: { rules: 6, applying: 0 } }
  return inShell(
    '/admin/privacy',
    createElement(PrivacyView, {
      model: page,
      slots: {
        requests: createElement(RequestsView, { model: model.model }),
        duties: createElement(DepthDutiesView, { model: { ...duties, requests: model.model.can.view ? duties.requests : null } }),
        newRequest: model.model.can.manage ? createElement(NewRequestButtonView) : null,
      },
    }),
    model.permissions,
  )
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-660',
  title: 'Data requests',
  view: RequestsDesign,
  cases: [
    { id: 'normal', label: 'Administrator: open requests with their clock', model: base(), note: 'Open first by due time; one is late (danger, a banner says so), one due in under 3 days. The duty lines read the same counts. New data request is the head\'s primary.' },
    { id: 'all', label: 'All requests, closed too', model: base({ address: { view: 'all', kind: null, request: null, creating: false }, list: { value: { requests: ALL, counts: { open: OPEN.length, overdue: 1 } }, problem: null } }), note: 'A closed request says when it closed; an erased person is "Erased person".' },
    { id: 'kind', label: 'Erasure requests only', model: base({ address: { view: 'open', kind: 'ERASURE', request: null, creating: false }, list: { value: { requests: [LATE_ERASURE], counts: { open: OPEN.length, overdue: 1 } }, problem: null } }) },
    { id: 'selected', label: 'Two selected: Export 2', model: base({ selected: [SOON_ACCESS.id, READY.id] }), note: 'The CSV has the clock and the outcome, never a name.' },
    { id: 'updates', label: 'Changed meanwhile: "2 updates · Show"', model: base({ updates: 2 }) },
    { id: 'empty', label: 'No open request', model: base({ list: { value: { requests: [], counts: { open: 0, overdue: 0 } }, problem: null } }), note: 'Show all opens the closed ones too.' },
    { id: 'loading', label: 'Loading', model: base({ list: LOADING }) },
    { id: 'error', label: 'The requests did not load', model: base({ list: { value: null, problem: 'dp.problem.unavailable' } }), note: 'A failed read is never drawn as an empty list.' },
    { id: 'no-permission', label: 'privacy.view only: the list is absent', model: base({}, NO_REQUESTS), note: 'A request names a person: without privacy.requests.view the fourth list is not offered at all (never a locked box).' },
    { id: 'request-received', label: 'A request just received: check the identity first', model: base(open(SOON_ACCESS)), note: 'Collect and Mark done are held with why (GDPR art. 12(6)).' },
    { id: 'identity-form', label: 'Identity checked: how', model: base(open(SOON_ACCESS, { form: { name: 'identity', how: '' } })) },
    { id: 'request-collecting', label: 'Access: the package is being collected', model: base(open(COLLECTING)), note: 'JobProgress while the worker builds the ZIP; live privacy.request_changed (or a read every few seconds when the stream is away) brings it.' },
    { id: 'request-ready', label: 'Access: the package is ready', model: base(open(READY, { done: 'dp.done.collecting' })), note: 'Download the package (a 60-second link the read log records); Mark done is allowed.' },
    { id: 'request-failed', label: 'Access: the package could not be made', model: base(open({ ...COLLECTING, collect: { state: 'FAILED', at: hours(-1) } })) },
    { id: 'request-erasure', label: 'Erasure, late: Anonymise…', model: base(open(LATE_ERASURE)), note: 'Extend is held: the first month passed.' },
    { id: 'request-erased', label: 'Erasure done', model: base({ ...open(ERASED_DONE), address: { view: 'all', kind: null, request: ERASED_DONE.id, creating: false } }), note: 'What it did, in counts; the history never holds the name.' },
    { id: 'request-correction', label: 'Correction: made in the person\'s record', model: base(open(CORRECTION)) },
    { id: 'request-extended', label: 'Extended once', model: base(open(EXTENDED)), note: 'The first due day and why it was extended; Extend held: once only.' },
    { id: 'extend-form', label: 'Extend: by how much and why', model: base(open(SOON_ACCESS, { form: { name: 'extend', months: 2, reason: '' } })) },
    { id: 'refuse-form', label: 'Refuse: why', model: base(open(SOON_ACCESS, { form: { name: 'refuse', reason: 'Asked four times this month' } })) },
    { id: 'request-refused', label: 'A refused request', model: base({ ...open(REFUSED), address: { view: 'all', kind: null, request: REFUSED.id, creating: false } }) },
    { id: 'request-conflict', label: 'Someone changed it meanwhile', model: base(open(READY, { problem: 'dp.problem.conflict' })) },
    { id: 'request-reader', label: 'A reader (privacy.requests.view only): every step held', model: base(open(READY), READER), note: 'Each held button says the right it needs.' },
    { id: 'request-error', label: 'The request did not load', model: base({ address: { view: 'open', kind: null, request: SOON_ACCESS.id, creating: false }, dialog: { requestId: SOON_ACCESS.id, read: { value: null, problem: 'dp.problem.notFound' }, form: null, busy: false, problem: null, done: null } }) },
    { id: 'new', label: 'New data request', model: base(creating()), note: 'Who asks, what they ask, the person found through the list of their kind, when it came in, a note.' },
    { id: 'new-contact', label: 'New data request: a customer\'s contact picked', model: base(creating({ draft: { ...emptyDraft(demo.id, new Date(NOW).toISOString()), kind: 'ERASURE', search: 'esempio', partyId: CUSTOMERS[0]!.recordId, person: CONTACTS[0]! }, found: { value: CUSTOMERS, problem: null }, contacts: { value: CONTACTS, problem: null } })) },
    { id: 'new-none', label: 'New data request: nobody found', model: base(creating({ draft: { ...emptyDraft(demo.id, new Date(NOW).toISOString()), personKind: 'USER', search: 'zzz' }, found: { value: [], problem: null } })) },
    { id: 'new-no-lookup', label: 'New data request: no right to look up workers', model: base(creating({ draft: { ...emptyDraft(demo.id, new Date(NOW).toISOString()), personKind: 'WORKER' } }), [...ADMIN.filter((permission) => permission !== 'people.view')]), note: 'Said with the right it needs; never a dead field.' },
    { id: 'new-refused', label: 'New data request: refused', model: base(creating({ draft: { ...emptyDraft(demo.id, new Date(NOW).toISOString()), personKind: 'USER', person: { recordType: 'User', recordId: uid('3333', 9), label: 'Dario Esempio', companyId: null } }, found: { value: [], problem: null }, problem: 'dp.problem.invalid' })) },
    { id: 'created', label: 'Recorded: due in 30 days', model: base({ notice: { tone: 'success', key: 'dp.done.created', params: { due: '15/12/2026' } } }) },
  ],
})
