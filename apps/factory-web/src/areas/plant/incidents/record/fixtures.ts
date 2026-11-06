import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { ACTIONS, countdown, DEMO_DAYS, FILED, FILINGS, INCIDENT_IDS, INCIDENT_ROLES, inIncidentShell, MACHINES, NOW, PEOPLE, PREFIX, record, RULE, type IncidentRoleDemo } from '../_demo/fixtures'
import { editDraftOf, filingDraftOf, incidentsCan, newActionDraft } from '../model'
import type { IncidentRecordModel, RecordTab } from '../view-model'
import { IncidentRecordView } from './view/IncidentRecordView'

/**
 * SCR-210-record — an incident (B-W2b-149; design plant.incidents "Record: Incident", tabs Report, Actions, Authority notice;
 * pop:filing, pop:close). Made-up data only: an injury at the cutting table with its insurance report due in 9 h, three
 * actions (one made into a maintenance job, one overdue, one done into the improvement plan).
 */

interface RecordCase {
  role: IncidentRoleDemo
  model: IncidentRecordModel
}

const ready = (over: Parameters<typeof record>[0] = {}) => ({ status: 'ready' as const, value: { now: NOW, incident: record(over) } })
const open = <T,>(value: T) => ({ state: 'open' as const, value, at: NOW })
const filingsOpen = (filings = FILINGS) => open({ filings, rule: RULE, now: NOW })

function base(role: IncidentRoleDemo, tab: RecordTab, over: Partial<IncidentRecordModel> = {}, incident: Parameters<typeof record>[0] = {}): RecordCase {
  const can = incidentsCan(INCIDENT_ROLES[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      tab,
      loaded: ready({ canManage: can.manage, canPeople: can.people, canClose: can.manage, people: { count: 1, injured: 1, canOpen: can.people }, ...incident }),
      live: 'live',
      asOf: NOW,
      people: { state: 'closed' },
      filings: { state: 'closed' },
      edit: null,
      dialog: null,
      notice: null,
      photoUrls: {},
      bulkBusy: false,
      userId: 'design-user',
      ...over,
    },
  }
}

function RecordDesign({ model }: { model: RecordCase }) {
  return inIncidentShell(`/plant/incidents/${INCIDENT_IDS.cut}`, createElement(IncidentRecordView, { model: model.model }), model.role)
}

const closable = { actions: ACTIONS.map((action) => ({ ...action, status: 'DONE' as const, overdue: false })), inail: { deadlines: [{ id: FILED.id, state: 'FILED' as const, status: 'FILED' as const, countdown: null, version: 4 }], canOpen: true, law: RULE.law, rule: RULE } }

export const designScreen = defineDesignScreen<RecordCase>({
  screen: 'SCR-210-record',
  title: 'Incidents: an incident (record)',
  view: RecordDesign,
  cases: [
    {
      id: 'report',
      label: 'Safety officer: Report tab',
      model: base('safety', 'report'),
      note: 'What happened (the floor worker who reported it is not named: the site records no workers), the photos, People involved: "1 person involved, 1 hurt" behind Show (recorded). Record INAIL filing is the primary (f); Close is held while actions are open.',
    },
    { id: 'people-open', label: 'People involved opened (recorded)', model: base('safety', 'report', { people: open(PEOPLE) }), note: 'Name, involvement, body parts, side, nature, first aid; "Opening it is recorded" with the time. Hide forgets it.' },
    { id: 'people-restricted', label: 'Production manager: "One person involved"', model: base('production', 'report'), note: 'Restricted: who may see it is said; the page never holds the names.' },
    { id: 'edit', label: 'Edit the report (EditModeBar)', model: base('safety', 'report', { edit: { draft: { ...editDraftOf(record()), severity: 'LOST_DAYS', immediateAction: 'Primo soccorso; lama protetta e tavolo fermo.' }, busy: false, problem: null } }) },
    {
      id: 'anonymous',
      label: 'A hazard sent without a name',
      model: base('safety', 'report', {}, { id: INCIDENT_IDS.oil, number: 'INC-2026-0010', kind: 'HAZARD', what: 'Olio sul pavimento vicino alla postazione di cucito 2.', severity: null, area: null, reporter: { kind: 'ANONYMOUS', name: null, hidden: false, device: null }, seen: null, people: { count: 0, injured: 0, canOpen: false }, actions: [], inail: { deadlines: [], canOpen: false, law: RULE.law, rule: RULE }, photos: [] }),
      note: '"Sent without a name": no worker, no tablet. Not seen yet (the page marks it seen for a safety role).',
    },
    { id: 'actions', label: 'Actions tab', model: base('safety', 'actions'), note: 'Made into: a maintenance job (its link), a measure of the improvement plan; one overdue. Mark done N; Enter opens one.' },
    {
      id: 'action-new-job',
      label: 'New action made into a maintenance job in one step',
      model: base('safety', 'actions', { dialog: { kind: 'action', actionId: 'new', mode: 'edit', draft: { ...newActionDraft('MAINTENANCE_JOB', null), title: 'Controllare il carter della pressa', priority: 'P2' }, machines: { status: 'ready', value: MACHINES }, busy: false, problem: null } }),
      note: 'Plain · Make a job · Add to improvement plan · Plan training (held: the safety courses come with their page).',
    },
    {
      id: 'action-view',
      label: 'An action: make it, mark it done, cancel it',
      model: base('safety', 'actions', { dialog: { kind: 'action', actionId: ACTIONS[1]!.id, mode: 'view', draft: newActionDraft(), machines: null, busy: false, problem: null } }),
    },
    {
      id: 'action-refused',
      label: 'Add to improvement plan: refused (no active assessment)',
      model: base('safety', 'actions', { dialog: { kind: 'action', actionId: ACTIONS[1]!.id, mode: 'make', draft: { ...newActionDraft('RISK_MEASURE'), title: ACTIONS[1]!.title }, machines: null, busy: false, problem: { key: 'refusal.NO_ASSESSMENT', field: null } } }),
    },
    { id: 'actions-empty', label: 'No actions yet', model: base('safety', 'actions', {}, { actions: [] }) },
    {
      id: 'authority',
      label: 'Authority notice: the rule and the deadline',
      model: base('safety', 'authority'),
      note: 'What the law asks (D.Lgs. 81/2008 art. 18 c.1 r) in plain words, Open the INAIL portal (new tab); the deadline counts down for everyone; the filing itself behind Show (recorded).',
    },
    { id: 'authority-open', label: 'Authority notice: the filing opened', model: base('hr', 'authority', { filings: filingsOpen() }), note: 'Type, expected days, the certificate (starts the 48 h clock), the deadline, filed at/by, protocol, receipt; Not needed.' },
    { id: 'authority-filed', label: 'Filed with its protocol and receipt', model: base('hr', 'authority', { filings: filingsOpen([FILED]) }, closable) },
    { id: 'authority-restricted', label: 'Production manager: the deadline only', model: base('production', 'authority'), note: 'The countdown is the company\'s duty: everyone sees it; the type and the person are restricted.' },
    {
      id: 'note',
      label: 'Record INAIL filing: said before the protected read',
      model: base('hr', 'authority', { dialog: { kind: 'peopleNote', then: 'filings' } }),
    },
    {
      id: 'filing',
      label: 'Record INAIL filing: filed with the protocol',
      model: base('hr', 'authority', { filings: filingsOpen(), people: open(PEOPLE), dialog: { kind: 'filing', draft: { ...filingDraftOf(FILINGS[0]!, PEOPLE), filedAt: DEMO_DAYS.hours(-0.25), protocolNumber: 'DEMO-PROT-7781' }, busy: false, problem: null, done: [] } }),
      note: 'Type decided by the absence (read only); certificate received at → due by (48 h); filed at, protocol number, INAIL\'s receipt (PDF).',
    },
    {
      id: 'filing-new',
      label: 'Record INAIL filing: a new one from the absence',
      model: base('hr', 'authority', { filings: filingsOpen([]), people: open(PEOPLE), dialog: { kind: 'filing', draft: { ...filingDraftOf(null, PEOPLE), expectedAbsenceDays: '2' }, busy: false, problem: null, done: [] } }, { inail: { deadlines: [], canOpen: false, law: RULE.law, rule: RULE } }),
      note: '2 days: "calls for the statistical communication"; 0 days needs no filing (said, held).',
    },
    {
      id: 'filing-refused',
      label: 'Record INAIL filing: refused (filed before the certificate)',
      model: base('hr', 'authority', { filings: filingsOpen(), people: open(PEOPLE), dialog: { kind: 'filing', draft: { ...filingDraftOf(FILINGS[0]!, PEOPLE), filedAt: DEMO_DAYS.hours(-40), protocolNumber: 'DEMO-PROT-7781' }, busy: false, problem: { key: 'refusal.FILED_BEFORE_CERTIFICATE', field: 'filedAt' }, done: [] } }),
    },
    { id: 'close-held', label: 'Close incident: held (actions open, filing due)', model: base('safety', 'report', { dialog: { kind: 'close', busy: false, problem: null } }), note: 'Held with the reason; what is left is listed.' },
    { id: 'close', label: 'Close incident: everything done', model: base('safety', 'report', { dialog: { kind: 'close', busy: false, problem: null } }, closable) },
    { id: 'closed', label: 'A closed incident: Reopen', model: base('safety', 'report', { notice: { tone: 'success', key: 'notice.closed', params: { number: 'INC-2026-0012' } } }, { ...closable, status: 'CLOSED', closed: { at: NOW, by: 'Anna Esempio' } }) },
    { id: 'cancel', label: 'Cancel the report (with the reason)', model: base('safety', 'report', { dialog: { kind: 'cancel', reason: 'Doppione di INC-2026-0011.', busy: false, problem: null } }, closable) },
    { id: 'photo', label: 'Add a photo (no faces)', model: base('safety', 'report', { dialog: { kind: 'photo', busy: false, problem: null } }) },
    { id: 'late', label: 'A deadline late', model: base('safety', 'authority', {}, { inail: { deadlines: [{ id: FILINGS[0]!.id, state: 'OVERDUE', status: 'DUE', countdown: countdown(-2), version: 3 }], canOpen: true, law: RULE.law, rule: RULE } }) },
    { id: 'loading', label: 'Loading', model: base('safety', 'report', { loaded: { status: 'loading' }, asOf: null }) },
    { id: 'error', label: "Couldn't load", model: base('safety', 'report', { loaded: { status: 'error', problem: 'problem.unavailable' }, asOf: null }) },
    { id: 'not-found', label: 'Not found (or not yours to see)', model: base('safety', 'report', { loaded: { status: 'notFound' }, asOf: null }), note: 'An incident of a site the person does not reach answers "not found", as the API does.' },
    { id: 'read-only', label: 'Read-only: every write held', model: base('readOnly', 'report', {}, { canManage: false, canPeople: false, canClose: false }) },
    { id: 'keys', label: 'Keyboard shortcuts', model: base('safety', 'report', { keysOpen: true }) },
  ],
})
