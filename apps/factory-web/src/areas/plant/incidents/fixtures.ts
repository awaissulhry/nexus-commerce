import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import { COUNTS, countdown, INCIDENT_IDS, INCIDENT_ROLES, inIncidentShell, MACHINES, NOW, PEOPLE, PLACES, PREFIX, ROW_SUD, ROWS, SCOPE_ALL, SCOPE_ONE, SITE_N, STAFF, TODAY, type IncidentRoleDemo } from './_demo/fixtures'
import { EMPTY_ADDRESS, incidentsCan, newPersonDraft, newReportDraft, reportHeldFirst, type IncidentsAddress } from './model'
import type { IncidentsPageModel, ReportDialogState } from './view-model'
import { IncidentsView } from './view/IncidentsView'

/**
 * SCR-210 — Plant › Health & safety › Incidents (B-W2b-149; design plant.incidents). Made-up data only (./_demo): an invented
 * company with two sites, invented people and machines. Roles from factory-domain's templates: the safety officer keeps the
 * incidents and opens the protected data; HR opens the people and keeps the filings; the production manager reads and
 * reports; read-only reads; sales has no safety.incidents.view. The labels and notes are English (the design index only);
 * the screen's words come from the catalogues in both languages.
 */

interface IncidentsCase {
  role: IncidentRoleDemo
  model: IncidentsPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })
const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

function base(role: IncidentRoleDemo, over: Partial<IncidentsPageModel> = {}, address: Partial<IncidentsAddress> = {}, scope: OfficeScope = SCOPE_ONE): IncidentsCase {
  const can = incidentsCan(INCIDENT_ROLES[role])
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      address: { ...EMPTY_ADDRESS, ...address },
      today: TODAY,
      counts: ready(COUNTS),
      list: ready({ rows: scope.allSites ? [...ROWS, ROW_SUD] : ROWS, nextCursor: null, canReport: can.report, now: NOW }),
      listMore: false,
      readAt: NOW,
      people: { state: 'hidden' },
      report: null,
      notice: null,
      bulkBusy: false,
      reportHeld: reportHeldFirst(can, scope.company?.id ?? null),
      ...over,
    },
  }
}

const report = (over: Partial<ReportDialogState> = {}): ReportDialogState => ({
  draft: newReportDraft(NOW),
  places: ready(PLACES),
  machines: ready(MACHINES),
  people: ready({ people: STAFF, complete: true }),
  peopleQuery: '',
  photos: [],
  capturing: false,
  busy: false,
  problem: null,
  siteId: SITE_N.id,
  ...over,
})

const injuryDraft = () => ({
  ...newReportDraft(NOW),
  kind: 'INJURY' as const,
  what: 'Ustione al polso toccando la piastra della pressa a caldo.',
  machineId: MACHINES[0]!.id,
  immediateAction: 'Acqua fredda e primo soccorso.',
  people: [{ ...newPersonDraft('p1', 'INJURY'), employeeId: STAFF[1]!.id, employeeName: STAFF[1]!.name, bodyParts: ['WRIST' as const], bodySide: 'RIGHT' as const, nature: 'BURN' as const, firstAidGiven: true }],
})

function IncidentsDesign({ model }: { model: IncidentsCase }) {
  return inIncidentShell('/plant/incidents', createElement(IncidentsView, { model: model.model }), model.role, model.model.scope)
}

const late = { ...COUNTS, deadline: { incidentId: INCIDENT_IDS.cut, number: 'INC-2026-0012', countdown: countdown(-3.5), more: 1 }, next: { incidentId: INCIDENT_IDS.cut, number: 'INC-2026-0012', countdown: countdown(-3.5) } }

export const designScreen = defineDesignScreen<IncidentsCase>({
  screen: 'SCR-210',
  title: 'Incidents (Plant › Health & safety)',
  view: IncidentsDesign,
  cases: [
    {
      id: 'list',
      label: 'Safety officer: the banner, the tiles, the anonymised list',
      model: base('safety'),
      note: 'The critical banner: INC-2026-0012, insurance report due in 9 h → Open goes to its Authority notice. The band chip counts down to the nearest deadline. Tiles filter the list (Actions overdue says where to look). No person in any row; "Show people" asks first and is recorded. Keys: c reports.',
    },
    { id: 'deadline-late', label: 'A deadline already late, and one more', model: base('safety', { counts: ready(late) }), note: 'Late by 3 h, "1 more deadline under 24 hours or late".' },
    { id: 'no-deadline', label: 'No deadline under 24 h: the banner hides', model: base('safety', { counts: ready({ ...COUNTS, deadline: null, next: { incidentId: INCIDENT_IDS.cut, number: 'INC-2026-0012', countdown: countdown(40) } }) }), note: 'The band chip still counts down to the nearest one (40 h).' },
    { id: 'rows-inail', label: 'Rows ▾ INAIL due (the tile)', model: base('safety', { list: ready({ rows: ROWS.filter((row) => row.inail.open > 0), nextCursor: null, canReport: true, now: NOW }) }, { rows: 'INAIL_DUE' }), note: 'A tile is a filter of the list; Clear filters takes it off.' },
    { id: 'all-sites', label: 'All sites: Site column and chip', model: base('safety', {}, {}, SCOPE_ALL), note: '"All sites" in the top bar: a Site column; the report dialog asks for the site.' },
    {
      id: 'people-confirm',
      label: 'Show people: said before anything is read',
      model: base('hr', { people: { state: 'confirm' } }),
      note: 'The PrivacyNote (protected, recorded, GDPR art. 9) and how many incidents it opens; nothing is read until Show people.',
    },
    {
      id: 'people-shown',
      label: 'Show people (HR): Person and Injury columns, recorded',
      model: base('hr', { people: { state: 'shown', byIncident: { [INCIDENT_IDS.cut]: PEOPLE }, at: NOW, count: ROWS.length } }),
      note: 'The names and injuries live in the page only; never in the export (no such column), the print or a saved view. Hide people forgets them.',
    },
    { id: 'selected', label: 'Rows chosen: Mark seen N, Export N', model: base('safety', { selected: [INCIDENT_IDS.oil, INCIDENT_IDS.cut] }), note: 'Mark seen marks the unseen ones "seen by safety"; Export N writes the chosen rows, anonymised.' },
    { id: 'seen-result', label: 'Mark seen N: one refused', model: base('safety', { notice: { tone: 'warning', key: 'notice.seen', params: { count: 1 }, refused: [{ label: 'INC-2026-0008', key: 'problem.conflict' }] } }) },
    {
      id: 'report',
      label: 'Report an incident: an injury with the person hurt',
      model: base('safety', { report: report({ draft: injuryDraft(), photos: [] }) }, { report: true }),
      note: 'Kind · what · when · where (station, machine or words) · immediate action · photos (no faces) · people: a person of the company, body parts, side, nature, first aid. People are written with the report, never read back here.',
    },
    { id: 'report-empty', label: 'Report an incident: empty (held)', model: base('production', { report: report({ people: null }) }, { report: true }), note: 'Send report is held until a kind is chosen ("Choose what happened"). The production manager has no staff list: someone from outside by name, or the safety office adds the person.' },
    {
      id: 'report-refused',
      label: 'Report an incident: refused at its field',
      model: base('safety', { report: report({ draft: { ...newReportDraft(NOW), kind: 'NEAR_MISS', what: 'Carrello quasi urtato una persona.', place: 'Corridoio' }, problem: { key: 'refusal.WHERE_OTHER_SITE', field: 'where' } }) }, { report: true }),
      note: 'The API refused it: said at the Where fields, in our words.',
    },
    { id: 'report-sent', label: 'Report sent: the notice opens it', model: base('safety', { notice: { tone: 'success', key: 'notice.reported', params: { number: 'INC-2026-0013', count: 0 }, open: { id: INCIDENT_IDS.oil, number: 'INC-2026-0013' } } }) },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('safety', { counts: loading, list: loading, readAt: null }), note: '"Still loading…" shows after about a second.' },
    { id: 'error', label: "Couldn't load: each section on its own", model: base('safety', { counts: failed, list: failed, readAt: null }), note: 'The deadline check and the list say so with Try again; a failed read is never drawn as empty.' },
    { id: 'empty', label: 'Nothing recorded yet', model: base('safety', { counts: ready({ ...COUNTS, tiles: { openIncidents: 0, inailOpen: 0, nearMissesThisMonth: 0, hazardsOpen: 0, actionsOverdue: 0 }, deadline: null, next: null }), list: ready({ rows: [], nextCursor: null, canReport: true, now: NOW }) }), note: '"No incidents recorded." Anyone reports from a station or a phone in three taps.' },
    { id: 'none-match', label: 'Nothing matches the filters', model: base('safety', { list: ready({ rows: [], nextCursor: null, canReport: true, now: NOW }) }, { rows: 'HAZARD', status: 'CLOSED' }) },
    { id: 'production-manager', label: 'Production manager: reads and reports', model: base('production'), note: 'Show people held with its reason; no Mark seen (Export N only).' },
    { id: 'read-only', label: 'Read-only: reads, every write held', model: base('readOnly'), note: 'Report an incident held "needs safety.incidents.report"; never the protected data.' },
    { id: 'no-permission', label: 'Sales: no safety.incidents.view', model: base('sales', { counts: loading, list: loading, readAt: null }), note: 'The page says so and reads nothing.' },
    { id: 'keys', label: 'Keyboard shortcuts', model: base('safety', { keysOpen: true }) },
  ],
})
