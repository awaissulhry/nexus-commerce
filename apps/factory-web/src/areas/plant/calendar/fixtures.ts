import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import type { OfficeScope } from '../../../shell/scope/scope-model'
import {
  APPOINTMENT_IDS,
  calendarAnswer,
  CONTACTS,
  COUNTS,
  DEADLINE_IDS,
  drillRecord,
  ENDED,
  inSafetyShell,
  MEETING_DONE,
  MEETING_NEXT,
  NOTICE_IDS,
  notices,
  organisation,
  OWNERS,
  PEOPLE,
  PLACES,
  PREFIX,
  SAFETY_ROLES_DEMO,
  SCOPE_ALL,
  SCOPE_ONE,
  SHIFTS,
  SITE_N,
  supervisorRecord,
  TODAY,
  NOW,
  APPOINTMENTS,
  type SafetyRoleDemo,
} from './_demo/fixtures'
import { calendarCan, EMPTY_ADDRESS, EMPTY_DEADLINE, newAppointmentDraft, type CalendarAddress } from './model'
import type { CalendarPageModel } from './view-model'
import { CalendarPageView } from './view/CalendarPageView'

/**
 * SCR-267 — Plant › Health & safety › Safety calendar (B-W2b-120; design plant.calendar). Made-up data only (./_demo): an
 * invented company with two sites, invented people, an invented consultancy. Roles from factory-domain's templates: the
 * safety officer keeps everything; HR keeps the organisation; the occupational doctor, the production manager and
 * read-only look; sales has no safety.view. Health visits are counts for everyone. The labels and notes are English (the
 * design index only); the screen's words come from the catalogues in both languages.
 */

interface CalendarCase {
  role: SafetyRoleDemo
  model: CalendarPageModel
}

const ready = <T,>(value: T) => ({ status: 'ready' as const, value })

function base(role: SafetyRoleDemo, over: Partial<CalendarPageModel> = {}, address: Partial<CalendarAddress> = {}, scope: OfficeScope = SCOPE_ONE): CalendarCase {
  const can = calendarCan(SAFETY_ROLES_DEMO[role])
  const manageOrg = can.manageOrganisation
  const manageCal = can.manageCalendar
  return {
    role,
    model: {
      prefix: PREFIX,
      can,
      scope,
      companyId: scope.company?.id ?? null,
      address: { ...EMPTY_ADDRESS, month: '2026-11', ...address },
      today: TODAY,
      month: address.month ?? '2026-11',
      counts: ready(COUNTS),
      calendar: ready(calendarAnswer({ canManage: manageCal, canUpload: can.upload, items: calendarAnswer().items.map((item) => ({ ...item, editable: item.editable && manageCal })) })),
      calendarReading: false,
      readAt: NOW,
      organisation: ready(organisation({ canManage: manageOrg, canUpload: can.upload, appointments: organisation().appointments.map((row) => ({ ...row, canManage: manageOrg })) })),
      notices: ready(notices({ canManage: manageOrg, notices: notices().notices.map((notice) => ({ ...notice, canManage: manageOrg })) })),
      notice: null,
      bulkBusy: false,
      deadlineNew: null,
      deadline: null,
      appointment: null,
      filing: null,
      endTerms: null,
      ...over,
    },
  }
}

const drillOpen = (over: Partial<NonNullable<CalendarPageModel['deadline']>> = {}): NonNullable<CalendarPageModel['deadline']> => ({
  key: `DEADLINE:${DEADLINE_IDS.drill}`,
  id: DEADLINE_IDS.drill,
  read: ready(drillRecord()),
  mode: 'view',
  draft: null,
  owners: null,
  doneNote: '',
  cancelReason: '',
  busy: false,
  uploading: false,
  problem: null,
  next: null,
  saved: null,
  ...over,
})

const appointmentOpen = (over: Partial<Extract<NonNullable<CalendarPageModel['appointment']>, { mode: 'open' }>> = {}): NonNullable<CalendarPageModel['appointment']> => ({
  mode: 'open',
  id: APPOINTMENT_IDS.supervisor,
  read: ready(supervisorRecord()),
  step: 'view',
  signMethod: 'OFFICE',
  end: { untilDate: TODAY, reason: '' },
  note: '',
  busy: false,
  uploading: false,
  problem: null,
  saved: null,
  ...over,
})

function CalendarDesign({ model }: { model: CalendarCase }) {
  const path = '/plant/calendar'
  return inSafetyShell(path, createElement(CalendarPageView, { model: model.model }), model.role, model.model.scope)
}

const loading = { status: 'loading' as const }
const failed = { status: 'error' as const, problem: 'problem.read' }

export const designScreen = defineDesignScreen<CalendarCase>({
  screen: 'SCR-267',
  title: 'Safety calendar (Plant › Health & safety)',
  view: CalendarDesign,
  cases: [
    {
      id: 'month',
      label: 'Safety officer: the month',
      model: base('safety'),
      note: 'Tiles · the month with each day as its worst state (overdue, due soon, planned or to confirm, done) and the chosen day (today) on the right · the organisation with "Nobody holds" · the RLS notice pending (day to confirm, never late). Keys: c adds a deadline, [ / ] move the month.',
    },
    {
      id: 'month-day',
      label: 'Another day chosen',
      model: base('safety', {}, { day: '2026-10-28' }),
      note: 'The statutory forklift check: kept on Preventive & statutory checks, a page not built yet: the item says so and links to its machine.',
    },
    {
      id: 'list',
      label: 'List: every item of the window',
      model: base('safety', {}, { view: 'list' }),
      note: 'Due · What · Owner · Evidence · State · Kept on. A training refresher opens Skills (built); a typed deadline, an appointment ending and the RLS notice open here. At phone width (390) the list becomes cards.',
    },
    { id: 'list-overdue', label: 'Tile "Overdue": the List filtered', model: base('safety', {}, { view: 'list', tile: 'overdue' }), note: 'A tile is a filter of the List (?tile=overdue); the chip clears it.' },
    { id: 'selected', label: 'List: rows chosen, Mark done N', model: base('safety', { selected: [`DEADLINE:${DEADLINE_IDS.meeting}`, `DEADLINE:${DEADLINE_IDS.drill}`] }, { view: 'list' }), note: 'Only open deadlines typed here may be chosen (others say why on their box). The drill asks for evidence that is not on file: it stays, said in words.' },
    {
      id: 'bulk-result',
      label: 'Mark done N: one row refused',
      model: base('safety', { notice: { tone: 'warning', key: 'bulk.doneResult', params: { count: 1 }, refused: [{ label: 'Prova di evacuazione semestrale', key: 'held.evidenceFirst' }] } }, { view: 'list' }),
    },
    { id: 'all-sites', label: 'All sites: Site column and chip', model: base('safety', {}, { view: 'list' }, SCOPE_ALL), note: '"All sites" in the top bar: a Site column, "All sites · Site from the top bar" beside the switch.' },
    { id: 'all-sites-month', label: 'All sites: the month', model: base('safety', {}, {}, SCOPE_ALL), note: 'Each agenda item names its site.' },
    {
      id: 'failed-source',
      label: 'A source could not be read',
      model: base('safety', { calendar: ready(calendarAnswer({ failed: ['MACHINE_CHECK'], items: calendarAnswer().items.filter((item) => item.kind !== 'MACHINE_CHECK') })), counts: ready({ ...COUNTS, overdue: 1, failed: ['MACHINE_CHECK'] }) }),
      note: '"Machine checks could not be read": never drawn as nothing due; the tiles say their count may be short.',
    },
    { id: 'loading', label: 'Loading: each section in its shape', model: base('safety', { counts: loading, calendar: loading, organisation: loading, notices: loading, readAt: null }), note: '"Still loading…" shows after about a second.' },
    { id: 'loading-list', label: 'Loading the List', model: base('safety', { calendar: loading, readAt: null }, { view: 'list' }) },
    {
      id: 'error',
      label: "Couldn't load: each section on its own",
      model: base('safety', { counts: failed, calendar: failed, organisation: failed, notices: failed, readAt: null }),
      note: 'Each says so with Try again; a failed read is never drawn as empty.',
    },
    {
      id: 'empty',
      label: 'Nothing yet',
      model: base('safety', {
        counts: ready({ ...COUNTS, overdue: 0, dueSoon: 0, rolesWithoutPerson: 6, rlsPending: 0 }),
        calendar: ready(calendarAnswer({ items: [] })),
        organisation: ready(organisation({ appointments: [], missing: [{ companyId: PLACES[0]!.id, siteId: null, role: 'EMPLOYER' }, { companyId: PLACES[0]!.id, siteId: null, role: 'RSPP' }, { companyId: PLACES[0]!.id, siteId: null, role: 'DOCTOR' }, { companyId: PLACES[0]!.id, siteId: null, role: 'RLS' }, { companyId: PLACES[0]!.id, siteId: SITE_N.id, role: 'FIRST_AID' }, { companyId: PLACES[0]!.id, siteId: SITE_N.id, role: 'FIRE_EMERGENCY' }] })),
        notices: ready(notices({ notices: [] })),
      }),
      note: '"Fills itself from the other pages; Add deadline for anything else." · "Name your RSPP and occupational doctor first" · RLS "Nothing pending".',
    },
    { id: 'ended-terms', label: 'Show ended terms', model: base('safety', { organisation: ready(organisation({ appointments: [...APPOINTMENTS, ENDED] })) }, { ended: true }), note: '?ended=1: the history too; an ended term may not be chosen.' },
    { id: 'no-permission', label: 'Sales: no safety.view', model: base('sales', { counts: loading, calendar: loading, organisation: loading, notices: loading, readAt: null }), note: 'The page says so and reads nothing.' },
    { id: 'read-only', label: 'Read-only: every write held with its reason', model: base('readOnly'), note: 'Add deadline, Appoint, Record filing held with the reason; no selection boxes.' },
    { id: 'production-manager', label: 'Production manager: looks', model: base('production') },
    { id: 'hr', label: 'HR: keeps the organisation, reads the calendar', model: base('hr'), note: 'Appoint, End term N and Record filing open; Add deadline held (safety.calendar.manage).' },
    { id: 'company-doctor', label: 'Occupational doctor: health visits stay counts', model: base('doctor', {}, { view: 'list' }), note: '"Health surveillance: 6 visits due": a count, never a name, for everyone.' },
    {
      id: 'add-deadline',
      label: 'Add deadline: a refusal at its field',
      model: base('safety', { deadlineNew: { draft: { ...EMPTY_DEADLINE, title: 'Verifica impianto di messa a terra', kind: 'INSPECTION', dueOn: '2037-01-15', repeat: 'YEAR', every: '2', ownerId: OWNERS[0]!.id, evidenceRequired: true }, owners: ready(OWNERS), busy: false, problem: { key: 'refusal.DUE_TOO_FAR', field: 'dueOn' } } }, { newDeadline: true }),
      note: 'Title · type · due · repeat · owner · evidence required; the site from the top bar. The API refused the day: said at the field.',
    },
    { id: 'add-deadline-new', label: 'Add deadline: empty (held)', model: base('safety', { deadlineNew: { draft: { ...EMPTY_DEADLINE, ownerId: OWNERS[0]!.id }, owners: ready(OWNERS), busy: false, problem: null } }, { newDeadline: true }), note: 'Add deadline is held until a title and a day are given.' },
    {
      id: 'appoint-rls',
      label: 'Appointment: a new RLS with the notice due',
      model: base('safety', { appointment: { mode: 'new', draft: { ...newAppointmentDraft('RLS', null, TODAY), employeeId: PEOPLE.people[3]!.id }, people: ready(PEOPLE), contacts: ready(CONTACTS), shifts: ready(SHIFTS), busy: false, problem: null } }, { appoint: 'new', role: 'RLS' }),
      note: 'An RLS is a person of the company; the notice to INAIL is due by the first day, "to confirm" (the plan gives no fixed number of days), or already filed.',
    },
    {
      id: 'appoint-rlst-held',
      label: 'Appointment: an RLST as a person (held)',
      model: base('safety', { appointment: { mode: 'new', draft: { ...newAppointmentDraft('RLST', null, TODAY), who: 'person', employeeId: PEOPLE.people[0]!.id }, people: ready(PEOPLE), contacts: ready(CONTACTS), shifts: ready(SHIFTS), busy: false, problem: null } }, { appoint: 'new', role: 'RLST' }),
      note: 'Save appointment is held with the reason: a territorial RLS is an outside contact.',
    },
    {
      id: 'appoint-team',
      label: 'Appointment: first aid at a site, per shift',
      model: base('safety', { appointment: { mode: 'new', draft: { ...newAppointmentDraft('FIRST_AID', SITE_N.id, TODAY), employeeId: PEOPLE.people[2]!.id, shiftId: SHIFTS[1]!.id }, people: ready(PEOPLE), contacts: ready(CONTACTS), shifts: ready(SHIFTS), busy: false, problem: null } }, { appoint: 'new', role: 'FIRST_AID', at: SITE_N.id }),
      note: 'Opened from "Nobody holds: First aid (…) · Appoint".',
    },
    { id: 'appoint-open', label: 'Appointment: letter on file, the signature', model: base('safety', { appointment: appointmentOpen() }, { appoint: APPOINTMENT_IDS.supervisor }), note: 'The letter (FileRow), the appointee types their own name (SignBlock), End term, the note.' },
    {
      id: 'sign-refused',
      label: 'Signature refused: not the appointee’s name',
      model: base('safety', { appointment: appointmentOpen({ problem: { key: 'refusal.NAME_MISMATCH', field: 'signedName' } }) }, { appoint: APPOINTMENT_IDS.supervisor }),
      note: 'refusal.NAME_MISMATCH in our words on the SignBlock.',
    },
    {
      id: 'sign-paper-held',
      label: 'Paper signature without the signed letter (held)',
      model: base('safety', { appointment: appointmentOpen({ read: ready(supervisorRecord({ letter: null })), signMethod: 'PAPER' }) }, { appoint: APPOINTMENT_IDS.supervisor }),
      note: 'Held: upload the signed letter first.',
    },
    { id: 'appoint-end', label: 'Appointment: End term', model: base('safety', { appointment: appointmentOpen({ step: 'end', end: { untilDate: '2026-11-30', reason: 'Trasferito ad altra linea' } }) }, { appoint: APPOINTMENT_IDS.supervisor }) },
    {
      id: 'end-terms',
      label: 'End term N',
      model: base('safety', { orgSelected: [APPOINTMENT_IDS.firstAid, APPOINTMENT_IDS.fire], endTerms: { ids: [APPOINTMENT_IDS.firstAid, APPOINTMENT_IDS.fire], draft: { untilDate: '2026-11-30', reason: '' }, busy: false, problem: null } }),
      note: 'One last day and one reason for each term chosen; held until the reason is given.',
    },
    {
      id: 'filing',
      label: 'Record RLS notice',
      model: base('safety', { filing: { id: NOTICE_IDS.pending, latest: null, step: 'file', draft: { filedOn: TODAY, reference: 'INAIL-DEMO-0042', dueOn: TODAY, cancelReason: '' }, busy: false, uploading: false, problem: null, saved: null } }, { filing: NOTICE_IDS.pending }),
      note: 'Filed on (today or before) · INAIL reference · the receipt. The send is manual on the INAIL portal.',
    },
    {
      id: 'filing-refused',
      label: 'Record RLS notice: filed before the appointment',
      model: base('safety', { filing: { id: NOTICE_IDS.pending, latest: null, step: 'file', draft: { filedOn: '2026-10-30', reference: 'INAIL-DEMO-0042', dueOn: TODAY, cancelReason: '' }, busy: false, uploading: false, problem: null, saved: null } }, { filing: NOTICE_IDS.pending }),
      note: 'Record held: a notice is filed on or after the day the RLS was elected or designated.',
    },
    {
      id: 'deadline-evidence',
      label: 'Deadline: evidence asked and missing (Mark done held)',
      model: base('safety', { deadline: drillOpen() }, { open: `DEADLINE:${DEADLINE_IDS.drill}` }),
      note: 'J / K move across the List’s deadlines. Mark done says "Upload the evidence first".',
    },
    {
      id: 'deadline-done-next',
      label: 'Deadline done: the next one',
      model: base('safety', { deadline: drillOpen({ key: `DEADLINE:${DEADLINE_IDS.meeting}`, id: DEADLINE_IDS.meeting, read: ready({ deadline: MEETING_DONE, earlier: [], canUpload: true, today: TODAY }), next: MEETING_NEXT, saved: 'done.deadlineDone' }) }, { open: `DEADLINE:${DEADLINE_IDS.meeting}` }),
      note: 'A done repeating deadline says "Next on 18 Nov 2027".',
    },
    {
      id: 'deadline-read-only',
      label: 'Deadline: read-only',
      model: base('readOnly', { deadline: drillOpen({ read: ready({ ...drillRecord({ canManage: false }), canUpload: false }) }) }, { open: `DEADLINE:${DEADLINE_IDS.drill}` }),
      note: 'Edit, Cancel, Mark done and the upload say why they are held.',
    },
    { id: 'keys', label: 'The keys', model: base('safety', { keysOpen: true }) },
  ],
})
