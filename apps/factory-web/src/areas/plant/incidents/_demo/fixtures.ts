import { createElement, type ReactNode } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { INAIL_RULE_WORDS } from '@nexus/factory-domain/safety/incidents/rules'
import { permissionCheck } from '../../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../../shell/design-data'
import { isWindowPage, officeNavFor } from '../../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../../shell/office/view/OfficeShellView'
import { scopeOf, type OfficeScope } from '../../../../shell/scope/scope-model'
import { DesignClock } from '../view/parts'
import type { Countdown, CountsAnswer, IncidentAction, IncidentPerson, IncidentRecord, IncidentRow, InailFiling, InailRule, PickedMachine, PickedPerson, PlantPlaces } from '../api'

/**
 * Made-up data for SCR-210's design cases, its record and its print (B-W2b-149): an invented company ("Officina Demo"), two
 * invented sites, made-up people ("Anna Esempio", "Marco Prova", "Luca Demo"), made-up machines, incidents, certificate
 * references and protocol numbers. Nothing here is a real company, person, injury or INAIL number. Every time counts from one
 * fixed moment; a deadline says its read minutes ("due in 9 h") through DesignClock. Design-only.
 */

export const uid = (block: string, n: number) => `0190f0e2-${block.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
export const PREFIX = '/w/DEMO'
// A fixed moment (made-up data is fixed): the server's render and the browser's first render of a design case agree; the
// deadlines say the read's minutes in the design (DesignClock), never the browser's clock.
const NOW_MS = Date.parse('2026-11-03T08:00:00.000Z')
export const NOW = new Date(NOW_MS).toISOString()
export const TODAY = NOW.slice(0, 10)
const hours = (h: number) => new Date(NOW_MS + h * 3_600_000).toISOString()
const days = (d: number) => hours(d * 24)

const COMPANY = DEMO_COMPANIES[0]
export const SITE_N = { id: uid('7601', 1), code: 'STAB-N', name: 'Stabilimento Demo Nord' }
export const SITE_S = { id: uid('7601', 2), code: 'STAB-S', name: 'Stabilimento Demo Sud' }
export const SCOPE_ONE: OfficeScope = scopeOf({ company: COMPANY, sites: [SITE_N, SITE_S], everySite: true, chosen: SITE_N.id })
export const SCOPE_ALL: OfficeScope = scopeOf({ company: COMPANY, sites: [SITE_N, SITE_S], everySite: true, chosen: null })

// ---- roles -------------------------------------------------------------------------------------------------------------------

const template = (key: string): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view']

/**
 * The roles the design names: the safety officer (keeps the incidents and opens the protected data), HR (reports, opens the
 * people and keeps the filings, does not manage), the production manager (reads and reports, sees counts), read-only (reads,
 * changes nothing, never the protected data) and sales (no incidents at all).
 */
export const INCIDENT_ROLES = {
  safety: template('safety_officer'),
  hr: template('hr'),
  production: template('production_manager'),
  readOnly: [...(templateOf('read_only')?.permissions ?? []), 'home.view'],
  sales: template('sales'),
} as const
export type IncidentRoleDemo = keyof typeof INCIDENT_ROLES

/** The Office shell around a page (the role's navigation, this page's place), as the page sees it. */
export function inIncidentShell(path: string, page: ReactNode, role: IncidentRoleDemo, scope: OfficeScope = SCOPE_ONE): ReactNode {
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...INCIDENT_ROLES[role]])),
    path,
    ...(isWindowPage(path) ? { frame: 'window' as const } : {}),
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: scope.sites.map((site) => ({ id: site.id, name: site.name })), site: scope.site?.id ?? null, path },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  return createElement(OfficeShellView, { model: shell }, createElement(DesignClock, null, page))
}

// ---- deadlines ---------------------------------------------------------------------------------------------------------------

export function countdown(hoursLeft: number): Countdown {
  const minutesLeft = Math.round(hoursLeft * 60)
  return { dueAt: hours(hoursLeft), minutesLeft, hoursLeft: hoursLeft >= 0 ? Math.floor(hoursLeft) : -Math.ceil(-hoursLeft), under24h: hoursLeft >= 0 && hoursLeft < 24, late: hoursLeft < 0 }
}

// ---- the list ----------------------------------------------------------------------------------------------------------------

export const INCIDENT_IDS = { cut: uid('7602', 1), burn: uid('7602', 2), oil: uid('7602', 3), trolley: uid('7602', 4), press: uid('7602', 5), sud: uid('7602', 6) }
const AREA_CUT = { id: uid('7603', 1), code: 'TAGLIO', name: 'Reparto taglio' }
const AREA_SEW = { id: uid('7603', 2), code: 'CUCITO', name: 'Reparto cucito' }
const STATION_CUT = { id: uid('7604', 1), code: 'CUT-01', name: 'Tavolo di taglio 1' }
const STATION_SEW = { id: uid('7604', 2), code: 'SEW-02', name: 'Postazione cucito 2' }
export const MACHINE_PRESS = { id: uid('7605', 1), assetNumber: 'DEMO-PRESS-01' }
const MACHINE_IRON = { id: uid('7605', 2), assetNumber: 'DEMO-STIRO-02' }
const siteN = { code: SITE_N.code, name: SITE_N.name }
const siteS = { code: SITE_S.code, name: SITE_S.name }

const row = (over: Partial<IncidentRow> & Pick<IncidentRow, 'id' | 'number' | 'kind'>): IncidentRow => ({
  companyId: COMPANY.id,
  siteId: SITE_N.id,
  site: siteN,
  occurredAt: days(-1),
  reportedAt: days(-1),
  reportedVia: 'FLOOR',
  anonymous: false,
  area: null,
  station: null,
  machine: null,
  place: null,
  severity: null,
  status: 'OPEN',
  seen: true,
  actionsOpen: 0,
  actionsOverdue: 0,
  people: { count: 0, injured: 0 },
  inail: { open: 0, state: null, countdown: null },
  photos: 0,
  version: 2,
  ...over,
})

export const ROWS: IncidentRow[] = [
  row({ id: INCIDENT_IDS.cut, number: 'INC-2026-0012', kind: 'INJURY', occurredAt: days(-1.6), area: AREA_CUT, station: STATION_CUT, severity: 'LOST_DAYS', people: { count: 1, injured: 1 }, inail: { open: 1, state: 'DUE', countdown: countdown(9) }, actionsOpen: 2, photos: 2 }),
  row({ id: INCIDENT_IDS.burn, number: 'INC-2026-0011', kind: 'INJURY', occurredAt: days(-4), area: AREA_SEW, machine: MACHINE_IRON, severity: 'LOST_DAYS', reportedVia: 'OFFICE', people: { count: 1, injured: 1 }, inail: { open: 1, state: 'WAITING_CERTIFICATE', countdown: null }, actionsOpen: 1, actionsOverdue: 1 }),
  row({ id: INCIDENT_IDS.oil, number: 'INC-2026-0010', kind: 'HAZARD', occurredAt: hours(-5), station: STATION_SEW, anonymous: true, seen: false }),
  row({ id: INCIDENT_IDS.trolley, number: 'INC-2026-0009', kind: 'NEAR_MISS', occurredAt: days(-6), area: AREA_CUT, place: 'Corridoio tra taglio e cucito', severity: 'NONE', status: 'CLOSED', people: { count: 1, injured: 0 } }),
  row({ id: INCIDENT_IDS.press, number: 'INC-2026-0008', kind: 'HAZARD', occurredAt: days(-9), machine: MACHINE_PRESS, reportedVia: 'OFFICE', actionsOpen: 1 }),
]
export const ROW_SUD = row({ id: INCIDENT_IDS.sud, number: 'INC-2026-0007', kind: 'INJURY', siteId: SITE_S.id, site: siteS, occurredAt: days(-12), place: 'Magazzino', severity: 'FIRST_AID', people: { count: 1, injured: 1 }, inail: { open: 0, state: 'FILED', countdown: null } })

export const COUNTS: CountsAnswer = {
  now: NOW,
  tiles: { openIncidents: 4, inailOpen: 2, nearMissesThisMonth: 1, hazardsOpen: 2, actionsOverdue: 1 },
  deadline: { incidentId: INCIDENT_IDS.cut, number: 'INC-2026-0012', countdown: countdown(9), more: 0 },
  next: { incidentId: INCIDENT_IDS.cut, number: 'INC-2026-0012', countdown: countdown(9) },
  law: 'D.Lgs. 81/2008 art. 18 c.1 r',
}

// ---- the record -------------------------------------------------------------------------------------------------------------

export const RULE: InailRule = { law: 'D.Lgs. 81/2008 art. 18 c.1 r', statisticalFromDays: 1, insuranceAboveDays: 3, hoursAfterCertificate: 48, words: { en: [...INAIL_RULE_WORDS.en], it: [...INAIL_RULE_WORDS.it] } }

const action = (over: Partial<IncidentAction> & Pick<IncidentAction, 'id' | 'seq' | 'title'>): IncidentAction => ({
  owner: null,
  dueOn: null,
  status: 'OPEN',
  overdue: false,
  doneAt: null,
  doneBy: null,
  evidenceNote: null,
  cancelledAt: null,
  cancelReason: null,
  madeInto: null,
  record: null,
  version: 1,
  ...over,
})

export const ACTIONS: IncidentAction[] = [
  action({ id: uid('7606', 1), seq: 1, title: 'Sostituire la protezione della lama del tavolo 1', owner: { id: uid('7607', 1), name: 'Anna Esempio' }, dueOn: days(3).slice(0, 10), madeInto: 'MAINTENANCE_JOB', record: { type: 'MaintenanceJob', id: uid('7608', 1), label: 'MJ-2026-0031', status: 'NEW' } }),
  action({ id: uid('7606', 2), seq: 2, title: 'Rivedere la procedura di cambio lama', owner: { id: uid('7607', 2), name: 'Marco Prova' }, dueOn: days(-2).slice(0, 10), overdue: true }),
  action({ id: uid('7606', 3), seq: 3, title: 'Guanti antitaglio al tavolo 1', status: 'DONE', doneAt: hours(-20), doneBy: 'Anna Esempio', evidenceNote: 'Guanti consegnati e firmati.', madeInto: 'RISK_MEASURE', record: { type: 'RiskMeasure', id: uid('7608', 2), label: 'Guanti antitaglio al tavolo 1', status: 'DONE' } }),
]

export function record(over: Partial<IncidentRecord> = {}): IncidentRecord {
  return {
    id: INCIDENT_IDS.cut,
    number: 'INC-2026-0012',
    kind: 'INJURY',
    companyId: COMPANY.id,
    siteId: SITE_N.id,
    site: siteN,
    occurredAt: days(-1.6),
    reportedAt: days(-1.58),
    what: 'Taglio alla mano durante il cambio lama al tavolo di taglio 1.',
    area: AREA_CUT,
    station: STATION_CUT,
    machine: null,
    place: null,
    immediateAction: 'Primo soccorso in reparto; lama messa in sicurezza.',
    maintenanceRequest: null,
    severity: 'LOST_DAYS',
    status: 'OPEN',
    reportedVia: 'FLOOR',
    reporter: { kind: 'WORKER', name: null, hidden: true, device: { id: uid('7609', 1), name: 'Tablet taglio' } },
    seen: { at: days(-1.55), by: 'Anna Esempio' },
    closed: null,
    cancelled: null,
    people: { count: 1, injured: 1, canOpen: true },
    actions: ACTIONS,
    inail: { deadlines: [{ id: uid('7610', 1), state: 'DUE', status: 'DUE', countdown: countdown(9), version: 3 }], canOpen: true, law: 'D.Lgs. 81/2008 art. 18 c.1 r', rule: RULE },
    photos: [
      { id: uid('7611', 1), name: 'photo-1.jpg', contentType: 'image/jpeg', sizeBytes: 182_000, availableAt: days(-1.57) },
      { id: uid('7611', 2), name: 'photo-2.jpg', contentType: 'image/jpeg', sizeBytes: 164_000, availableAt: days(-1.57) },
    ],
    version: 4,
    canManage: true,
    canPeople: true,
    canClose: true,
    law: { incident: 'D.Lgs. 81/2008 art. 18 c.1 r', people: 'GDPR art. 9' },
    ...over,
  }
}

export const PEOPLE: IncidentPerson[] = [
  { id: uid('7612', 1), involvement: 'INJURED', employee: { id: uid('7613', 1), name: 'Luca Demo' }, outsideName: null, bodyParts: ['HAND', 'FINGER'], bodySide: 'LEFT', nature: 'CUT', firstAidGiven: true, sentToHospital: false, filings: 1, version: 2 },
]

export const FILINGS: InailFiling[] = [
  {
    id: uid('7610', 1),
    personId: uid('7612', 1),
    person: { employeeId: uid('7613', 1), name: 'Luca Demo' },
    type: 'INSURANCE',
    status: 'DUE',
    state: 'DUE',
    expectedAbsenceDays: 5,
    actualAbsenceDays: null,
    certificateReference: 'CERT-DEMO-0042',
    certificateReceivedAt: hours(-39),
    dueAt: hours(9),
    countdown: countdown(9),
    filedAt: null,
    filedBy: null,
    protocolNumber: null,
    notNeededAt: null,
    notNeededBy: null,
    receipt: null,
    version: 3,
  },
]

export const FILED: InailFiling = { ...FILINGS[0]!, status: 'FILED', state: 'FILED', filedAt: hours(-2), filedBy: 'Giulia Esempio', protocolNumber: 'DEMO-PROT-7781', countdown: null, receipt: { fileId: uid('7614', 1), name: 'ricevuta-demo.pdf' } }

// ---- pickers -----------------------------------------------------------------------------------------------------------------

export const PLACES: PlantPlaces = { sites: [{ id: SITE_N.id, companyId: COMPANY.id, code: SITE_N.code, name: SITE_N.name, stations: [STATION_CUT, STATION_SEW] }, { id: SITE_S.id, companyId: COMPANY.id, code: SITE_S.code, name: SITE_S.name, stations: [] }] }
export const MACHINES: PickedMachine[] = [MACHINE_PRESS, MACHINE_IRON]
export const STAFF: PickedPerson[] = [
  { id: uid('7613', 1), name: 'Luca Demo', employeeCode: 'D-0103', site: { id: SITE_N.id, code: SITE_N.code, name: SITE_N.name } },
  { id: uid('7613', 2), name: 'Sara Esempio', employeeCode: 'D-0104', site: { id: SITE_N.id, code: SITE_N.code, name: SITE_N.name } },
]
export const DEMO_DAYS = { hours, days }
