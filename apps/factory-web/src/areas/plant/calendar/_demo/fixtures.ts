import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import type { Appointment, AppointmentRecord, CalendarAnswer, CalendarItem, CountsAnswer, Deadline, DeadlineRecord, NoticesAnswer, Organisation, OrgContact, OrgPerson, Owner, RlsNotice } from '../api'

/**
 * Made-up data for SCR-267's design cases and its two prints (B-W2b-120): an invented company ("Officina Demo"), two
 * invented sites, made-up people ("Anna Esempio", "Marco Prova", "Luca Demo", "Sara Esempio", "Giulia Esempio"), an
 * invented consultancy ("Studio Sicurezza Demo") with example.com contacts, made-up machines, incidents and references.
 * Nothing here is a real company, person, doctor or number. Design-only (only fixtures and tests import it).
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const TODAY = '2026-11-03'
export const NOW = '2026-11-03T08:42:00.000Z'
export const PREFIX = '/w/DEMO'

const COMPANY = DEMO_COMPANIES[0]
const company = { code: COMPANY.code, name: COMPANY.name }
export const SITE_N = { id: uid('7101', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('7101', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
const siteN = { code: SITE_N.code, name: SITE_N.name }
const siteS = { code: SITE_S.code, name: SITE_S.name }
export const SITES = [SITE_N, SITE_S]

export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: SITES, everySite: true, chosen: null })

// ---- roles -------------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design names: the safety officer (RSPP / ASPP: keeps the organisation and the calendar), HR (keeps the
 * organisation, reads the calendar), the occupational doctor (reads; health visits stay counts), the production manager
 * (reads), read-only (reads, changes nothing) and sales (no safety.view: the page says so).
 */
export const SAFETY_ROLES_DEMO = {
  safety: template('safety_officer'),
  hr: template('hr'),
  doctor: template('company_doctor'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type SafetyRoleDemo = keyof typeof SAFETY_ROLES_DEMO

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inSafetyShell(path: string, page: ReactNode, role: SafetyRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...SAFETY_ROLES_DEMO[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, page)
}

// ---- people ------------------------------------------------------------------------------------------------------------------

const ANNA = { id: uid('7201', 1), name: 'Anna Esempio' }
const MARCO = { id: uid('7201', 2), name: 'Marco Prova' }
const LUCA = { id: uid('7201', 3), name: 'Luca Demo' }
const SARA = { id: uid('7201', 4), name: 'Sara Esempio' }
const GIULIA = { id: uid('7201', 5), name: 'Giulia Esempio' }

export const OWNERS: Owner[] = [
  { id: uid('7301', 1), name: 'Anna Esempio', me: true },
  { id: uid('7301', 2), name: 'Marco Prova', me: false },
  { id: uid('7301', 3), name: 'Giulia Esempio', me: false },
]

export const PEOPLE: { people: OrgPerson[]; complete: boolean } = {
  people: [ANNA, MARCO, LUCA, SARA, GIULIA].map((person, index) => ({ ...person, employeeCode: `D-${String(index + 101)}`, site: { id: SITE_N.id, code: SITE_N.code, name: SITE_N.name } })),
  complete: true,
}

export const CONTACTS: { contacts: OrgContact[]; complete: boolean } = {
  contacts: [
    { partyId: uid('7401', 1), partyName: 'Studio Sicurezza Demo S.r.l.', contactId: uid('7402', 1), name: 'Paolo Consulente', email: 'rspp@studio-demo.example.com', phone: '+39 000 000 0001' },
    { partyId: uid('7401', 2), partyName: 'Organismo Paritetico Demo', contactId: uid('7402', 2), name: 'Elena Territorio', email: 'rlst@paritetico-demo.example.com', phone: '+39 000 000 0002' },
  ],
  complete: true,
}

export const SHIFTS = [
  { id: uid('7501', 1), code: 'A', name: 'Turno A (06–14)' },
  { id: uid('7501', 2), code: 'B', name: 'Turno B (14–22)' },
]

// ---- the calendar ------------------------------------------------------------------------------------------------------------

const MACHINE_ID = uid('7601', 1)

const item = (over: Partial<CalendarItem> & Pick<CalendarItem, 'key' | 'kind' | 'dueOn' | 'state'>): CalendarItem => ({
  recordType: null,
  recordId: null,
  companyId: COMPANY.id,
  company,
  siteId: SITE_N.id,
  site: siteN,
  toConfirm: false,
  count: null,
  params: {},
  ownerId: null,
  owner: null,
  evidence: null,
  law: null,
  source: { page: null, recordType: null, recordId: null, parentType: null, parentId: null },
  editable: false,
  ...over,
})

export const DEADLINE_IDS = { drill: uid('7701', 1), meeting: uid('7701', 2), renewal: uid('7701', 3), next: uid('7701', 4) }
export const APPOINTMENT_IDS = { employer: uid('7801', 1), rspp: uid('7801', 2), firstAid: uid('7801', 3), rls: uid('7801', 4), supervisor: uid('7801', 5), fire: uid('7801', 6), aspp: uid('7801', 7) }
export const NOTICE_IDS = { pending: uid('7901', 1), filed: uid('7901', 2) }

const typed = (key: keyof typeof DEADLINE_IDS) => ({ recordType: 'SafetyDeadline', recordId: DEADLINE_IDS[key], source: { page: 'plant.calendar', recordType: 'SafetyDeadline', recordId: DEADLINE_IDS[key], parentType: null, parentId: null } })

export const ITEMS: CalendarItem[] = [
  item({ key: `DEADLINE:${DEADLINE_IDS.drill}`, kind: 'DEADLINE', dueOn: '2026-10-20', state: 'OVERDUE', params: { title: 'Prova di evacuazione semestrale', kind: 'DRILL' }, owner: ANNA.name, ownerId: OWNERS[0]!.id, evidence: { required: true, onFile: false }, editable: true, ...typed('drill') }),
  item({ key: `MACHINE_CHECK:${uid('7602', 1)}`, kind: 'MACHINE_CHECK', dueOn: '2026-10-28', state: 'OVERDUE', params: { checkIt: 'Verifica periodica del carrello elevatore', checkEn: 'Periodic forklift inspection', asset: 'DEMO-FLT-01', machine: 'Carrello elevatore' }, owner: MARCO.name, law: 'D.Lgs. 81/2008 art. 71 c.11', source: { page: 'plant.preventive', recordType: 'MachineCheckPlan', recordId: uid('7602', 1), parentType: 'Machine', parentId: MACHINE_ID } }),
  item({ key: `RLS_NOTICE:${NOTICE_IDS.pending}`, kind: 'RLS_NOTICE', dueOn: TODAY, state: 'TO_CONFIRM', toConfirm: true, siteId: null, site: null, recordType: 'RlsNotice', recordId: NOTICE_IDS.pending, params: { role: 'RLS', person: SARA.name }, law: 'D.Lgs. 81/2008 art. 18 c.1 aa', source: { page: 'plant.calendar', recordType: 'RlsNotice', recordId: NOTICE_IDS.pending, parentType: null, parentId: null } }),
  item({ key: `INAIL_REPORT:${uid('7603', 1)}`, kind: 'INAIL_REPORT', dueOn: '2026-11-05', state: 'DUE_SOON', count: 1, params: { incident: 'INC-D-0007' }, law: 'D.Lgs. 81/2008 art. 18 c.1 r', source: { page: 'plant.incidents', recordType: 'IncidentFiling', recordId: uid('7603', 1), parentType: 'Incident', parentId: uid('7604', 1) } }),
  item({ key: 'HEALTH_VISIT:2026-11', kind: 'HEALTH_VISIT', dueOn: '2026-11-10', state: 'DUE_SOON', count: 6, law: 'D.Lgs. 81/2008 art. 41', source: { page: 'plant.health', recordType: null, recordId: null, parentType: null, parentId: null } }),
  item({ key: `DEADLINE:${DEADLINE_IDS.meeting}`, kind: 'DEADLINE', dueOn: '2026-11-18', state: 'DUE_SOON', siteId: null, site: null, params: { title: 'Riunione periodica di prevenzione', kind: 'MEETING' }, owner: GIULIA.name, ownerId: OWNERS[2]!.id, evidence: { required: true, onFile: true }, editable: true, ...typed('meeting') }),
  item({ key: `TRAINING_REFRESHER:${uid('7605', 1)}`, kind: 'TRAINING_REFRESHER', dueOn: '2026-11-25', state: 'DUE_SOON', count: 4, params: { course: 'Formazione specifica, rischio medio' }, law: 'D.Lgs. 81/2008 art. 37', source: { page: 'people.skills', recordType: null, recordId: null, parentType: null, parentId: null } }),
  item({ key: `APPOINTMENT_END:${APPOINTMENT_IDS.firstAid}`, kind: 'APPOINTMENT_END', dueOn: '2026-11-30', state: 'DUE_SOON', recordType: 'SafetyAppointment', recordId: APPOINTMENT_IDS.firstAid, params: { role: 'FIRST_AID', person: LUCA.name }, source: { page: 'plant.calendar', recordType: 'SafetyAppointment', recordId: APPOINTMENT_IDS.firstAid, parentType: null, parentId: null } }),
  item({ key: `SDS_REVIEW:${uid('7606', 1)}`, kind: 'SDS_REVIEW', dueOn: '2026-12-01', state: 'PLANNED', params: { title: 'Schede di sicurezza dei collanti' }, source: { page: 'plant.chemicals', recordType: null, recordId: null, parentType: null, parentId: null } }),
  item({ key: `DVR_REVIEW:${uid('7607', 1)}`, kind: 'DVR_REVIEW', dueOn: '2026-12-15', state: 'PLANNED', params: { assessment: 'DVR Stabilimento Demo Nord, rev. 3' }, owner: ANNA.name, law: 'D.Lgs. 81/2008 art. 29 c.3', source: { page: 'plant.risk', recordType: null, recordId: null, parentType: null, parentId: null } }),
  item({ key: `RLS_TRAINING:${uid('7608', 1)}`, kind: 'RLS_TRAINING', dueOn: '2027-01-20', state: 'PLANNED', count: 1, siteId: null, site: null, params: { course: 'Aggiornamento annuale RLS' }, law: 'D.Lgs. 81/2008 art. 37 c.11', source: { page: 'people.skills', recordType: null, recordId: null, parentType: null, parentId: null } }),
  item({ key: `DEADLINE:${DEADLINE_IDS.renewal}`, kind: 'DEADLINE', dueOn: '2026-10-02', state: 'DONE', params: { title: 'Rinnovo del certificato prevenzione incendi', kind: 'RENEWAL' }, owner: ANNA.name, evidence: { required: true, onFile: true }, editable: false, ...typed('renewal') }),
  item({ key: `DEADLINE:${uid('7701', 9)}`, kind: 'DEADLINE', dueOn: '2026-11-12', state: 'PLANNED', siteId: SITE_S.id, site: siteS, params: { title: 'Sopralluogo del medico competente', kind: 'INSPECTION' }, owner: MARCO.name, evidence: { required: false, onFile: false }, editable: true, recordType: 'SafetyDeadline', recordId: uid('7701', 9), source: { page: 'plant.calendar', recordType: 'SafetyDeadline', recordId: uid('7701', 9), parentType: null, parentId: null } }),
]

export const calendarAnswer = (over: Partial<CalendarAnswer> = {}): CalendarAnswer => ({ items: ITEMS, from: '2026-10-01', to: '2026-12-31', today: TODAY, failed: [], canManage: true, canUpload: true, ...over })
export const COUNTS: CountsAnswer = { overdue: 2, dueSoon: 6, rolesWithoutPerson: 3, rlsPending: 1, failed: [], today: TODAY }

// ---- the organisation --------------------------------------------------------------------------------------------------------

const appointee = (person: { id: string; name: string }) => ({ kind: 'EMPLOYEE' as const, employeeId: person.id, name: person.name, partyId: null, partyName: null, contactId: null, email: null, phone: null })

const appointment = (over: Partial<Appointment> & Pick<Appointment, 'id' | 'role' | 'law' | 'appointee'>): Appointment => ({
  companyId: COMPANY.id,
  company,
  siteId: null,
  site: null,
  shift: null,
  fromDate: '2025-01-15',
  untilDate: null,
  endReason: null,
  inForce: true,
  ended: false,
  signature: null,
  letter: null,
  training: { state: 'NOT_TRACKED', validUntil: null, course: null },
  note: null,
  version: 1,
  canManage: true,
  ...over,
})

export const APPOINTMENTS: Appointment[] = [
  appointment({ id: APPOINTMENT_IDS.employer, role: 'EMPLOYER', law: 'D.Lgs. 81/2008 art. 2 c.1 b', appointee: appointee(GIULIA), fromDate: '2024-03-01', signature: { signedAt: '2024-03-01T10:00:00.000Z', method: 'OFFICE', signedName: GIULIA.name, signedBy: 'Alex Demo' }, letter: { fileId: uid('7811', 1), name: 'Nomina datore di lavoro.pdf' } }),
  appointment({
    id: APPOINTMENT_IDS.rspp,
    role: 'RSPP',
    law: 'D.Lgs. 81/2008 artt. 17, 31-32',
    appointee: { kind: 'OUTSIDE', employeeId: null, name: 'Paolo Consulente', partyId: CONTACTS.contacts[0]!.partyId, partyName: 'Studio Sicurezza Demo S.r.l.', contactId: CONTACTS.contacts[0]!.contactId, email: 'rspp@studio-demo.example.com', phone: '+39 000 000 0001' },
    fromDate: '2025-02-01',
    signature: { signedAt: '2025-02-03T09:00:00.000Z', method: 'PAPER', signedName: 'Paolo Consulente', signedBy: 'Alex Demo' },
    letter: { fileId: uid('7811', 2), name: 'Nomina RSPP firmata.pdf' },
  }),
  appointment({ id: APPOINTMENT_IDS.rls, role: 'RLS', law: 'D.Lgs. 81/2008 art. 47', appointee: appointee(SARA), fromDate: TODAY, training: { state: 'EXPIRED', validUntil: '2026-09-30', course: 'Corso RLS' } }),
  appointment({ id: APPOINTMENT_IDS.supervisor, role: 'SUPERVISOR', law: 'D.Lgs. 81/2008 artt. 2 c.1 e, 19', appointee: appointee(MARCO), siteId: SITE_N.id, site: siteN, letter: { fileId: uid('7811', 3), name: 'Nomina preposto linea giacche.pdf' }, training: { state: 'NONE', validUntil: null, course: null }, version: 3 }),
  appointment({ id: APPOINTMENT_IDS.firstAid, role: 'FIRST_AID', law: 'D.Lgs. 81/2008 artt. 18 c.1 b, 45', appointee: appointee(LUCA), siteId: SITE_N.id, site: siteN, shift: SHIFTS[0]!, untilDate: '2026-11-30', training: { state: 'VALID', validUntil: '2027-03-31', course: 'Primo soccorso, gruppo B' } }),
  appointment({ id: APPOINTMENT_IDS.fire, role: 'FIRE_EMERGENCY', law: 'D.Lgs. 81/2008 artt. 18 c.1 b, 46', appointee: appointee(ANNA), siteId: SITE_N.id, site: siteN, shift: SHIFTS[0]!, training: { state: 'VALID', validUntil: '2027-06-30', course: 'Antincendio, livello 2' }, letter: { fileId: uid('7811', 4), name: 'Nomina addetta antincendio.pdf' }, signature: { signedAt: '2025-01-16T11:00:00.000Z', method: 'OFFICE', signedName: ANNA.name, signedBy: 'Alex Demo' } }),
]

export const ENDED: Appointment = appointment({ id: APPOINTMENT_IDS.aspp, role: 'ASPP', law: 'D.Lgs. 81/2008 art. 31', appointee: appointee(GIULIA), fromDate: '2023-01-10', untilDate: '2025-12-31', endReason: 'Incarico passato allo studio esterno', inForce: false, ended: true, letter: { fileId: uid('7811', 5), name: 'Nomina ASPP.pdf' } })

export const PLACES = [{ id: COMPANY.id, code: COMPANY.code, name: COMPANY.name, sites: SITES }]

export const organisation = (over: Partial<Organisation> = {}): Organisation => ({
  appointments: APPOINTMENTS,
  missing: [
    { companyId: COMPANY.id, siteId: null, role: 'DOCTOR' },
    { companyId: COMPANY.id, siteId: SITE_S.id, role: 'FIRST_AID' },
    { companyId: COMPANY.id, siteId: SITE_S.id, role: 'FIRE_EMERGENCY' },
  ],
  companies: PLACES,
  canManage: true,
  canUpload: true,
  law: 'D.Lgs. 81/2008 art. 18 c.1 b; art. 28 c.2 e',
  today: TODAY,
  ...over,
})

// ---- the RLS notices ---------------------------------------------------------------------------------------------------------

export const PENDING: RlsNotice = {
  id: NOTICE_IDS.pending,
  companyId: COMPANY.id,
  company,
  appointmentId: APPOINTMENT_IDS.rls,
  role: 'RLS',
  appointee: SARA.name,
  site: null,
  appointedFrom: TODAY,
  dueOn: TODAY,
  status: 'PENDING',
  filedOn: null,
  reference: null,
  filedBy: null,
  cancelledAt: null,
  cancelReason: null,
  receipt: null,
  note: null,
  version: 1,
  canManage: true,
}

export const FILED: RlsNotice = { ...PENDING, id: NOTICE_IDS.filed, appointmentId: uid('7801', 9), appointee: 'Giorgio Esempio', appointedFrom: '2023-02-20', dueOn: '2023-02-20', status: 'FILED', filedOn: '2023-03-10', reference: 'INAIL-DEMO-0001', filedBy: 'Alex Demo', receipt: { fileId: uid('7911', 1), name: 'Ricevuta INAIL comunicazione RLS.pdf' }, version: 2 }

export const notices = (over: Partial<NoticesAnswer> = {}): NoticesAnswer => ({ notices: [PENDING, FILED], canManage: true, law: 'D.Lgs. 81/2008 art. 18 c.1 aa', today: TODAY, ...over })

// ---- one deadline, one appointment -------------------------------------------------------------------------------------------

export const DRILL: Deadline = {
  id: DEADLINE_IDS.drill,
  companyId: COMPANY.id,
  company,
  siteId: SITE_N.id,
  site: siteN,
  title: 'Prova di evacuazione semestrale',
  kind: 'DRILL',
  dueOn: '2026-10-20',
  repeatEvery: 6,
  repeatUnit: 'MONTH',
  ownerId: OWNERS[0]!.id,
  owner: ANNA.name,
  evidenceRequired: true,
  evidence: [],
  status: 'OPEN',
  state: 'OVERDUE',
  doneAt: null,
  doneBy: null,
  doneNote: null,
  cancelledAt: null,
  cancelReason: null,
  previousId: null,
  nextId: null,
  note: null,
  version: 2,
  canManage: true,
}

export const drillRecord = (over: Partial<Deadline> = {}): DeadlineRecord => ({ deadline: { ...DRILL, ...over }, earlier: [{ id: uid('7701', 7), dueOn: '2026-04-20', status: 'DONE', doneAt: '2026-04-18T09:00:00.000Z' }], canUpload: true, today: TODAY })

export const MEETING_DONE: Deadline = {
  ...DRILL,
  id: DEADLINE_IDS.meeting,
  siteId: null,
  site: null,
  title: 'Riunione periodica di prevenzione',
  kind: 'MEETING',
  dueOn: '2026-11-18',
  repeatEvery: 1,
  repeatUnit: 'YEAR',
  owner: GIULIA.name,
  evidence: [{ fileId: uid('7712', 1), name: 'Verbale riunione periodica 2026.pdf', kind: 'ATTACHMENT', at: '2026-11-03T08:30:00.000Z' }],
  status: 'DONE',
  state: 'DONE',
  doneAt: '2026-11-03T08:40:00.000Z',
  doneBy: 'Alex Demo',
  doneNote: 'Verbale firmato da tutti i partecipanti.',
  nextId: DEADLINE_IDS.next,
  version: 4,
}
export const MEETING_NEXT: Deadline = { ...MEETING_DONE, id: DEADLINE_IDS.next, dueOn: '2027-11-18', status: 'OPEN', state: 'PLANNED', evidence: [], doneAt: null, doneBy: null, doneNote: null, previousId: DEADLINE_IDS.meeting, nextId: null, version: 1 }

export const supervisorRecord = (over: Partial<Appointment> = {}): AppointmentRecord => ({ appointment: { ...APPOINTMENTS.find((row) => row.id === APPOINTMENT_IDS.supervisor)!, ...over }, notices: [], today: TODAY })
export const rlsRecord = (): AppointmentRecord => ({ appointment: APPOINTMENTS.find((row) => row.id === APPOINTMENT_IDS.rls)!, notices: [PENDING], today: TODAY })
