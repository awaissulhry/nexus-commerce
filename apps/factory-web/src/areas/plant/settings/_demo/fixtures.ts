import { ANONYMOUS_KINDS, EMERGENCY_NUMBER, INAIL_REMINDER_HOURS, INAIL_RULE, INAIL_RULE_WORDS, INCIDENT_LAW, INCIDENT_LIMITS, PROTECTED_LAW } from '@nexus/factory-domain/safety/incidents/rules'
import { LEAST_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { STEP_UP_CLOSED } from '../../_shared/parts'
import { at, CLASSES, PLANT_ROLES, SITE, SITE_SOUTH, uid, type PlantRole } from '../../_shared/fixtures'
import type { CheckType, EmployeePick, IncidentRules, LockRead, RoutingRule, TeamPick } from '../depth-api'
import type { DepthModel, SiteChoice } from '../depth-view-model'

/**
 * Made-up data for SCR-241's W2b sections (B-W2b-141): the Plant pages' invented site ("STAB-N"), teams ("L1 Squadra
 * giacche"), people ("Marco Prova", "Anna Esempio", "Giulia Campione"), routing rules and check types. The check types'
 * legal bases say "(esempio)" and their intervals are invented: nothing here is a law's number. The incident rules and the
 * least retention are the domain's own constants, exactly as the API answers them. Design-only (a fixtures file: only fixtures and tests
 * import it); it exports no `designScreen`.
 */

const AT = at(30, 8, 15)
export const DEMO_SITES: SiteChoice[] = [
  { id: SITE.id, code: SITE.code, name: SITE.name },
  { id: SITE_SOUTH.id, code: SITE_SOUTH.code, name: SITE_SOUTH.name },
]

const person = (n: number, name: string) => ({ id: uid('3535', n), name, active: true })
export const DEMO_PEOPLE = { marco: person(1, 'Marco Prova'), anna: person(2, 'Anna Esempio'), giulia: person(3, 'Giulia Campione') }
export const DEMO_TEAMS: TeamPick[] = [
  { id: uid('3636', 1), code: 'L1', name: 'Squadra giacche', status: 'ACTIVE' },
  { id: uid('3636', 2), code: 'L2', name: 'Squadra pantaloni', status: 'ACTIVE' },
  { id: uid('3636', 3), code: 'MAN', name: 'Manutenzione', status: 'ACTIVE' },
]
export const DEMO_EMPLOYEES: EmployeePick[] = Object.values(DEMO_PEOPLE).map((entry) => ({ id: entry.id, displayName: entry.name, status: 'ACTIVE', site: { id: SITE.id, code: SITE.code, name: SITE.name } }))

const cls = (entry: { id: string; code: string; labelIt: string; labelEn: string }) => ({ id: entry.id, code: entry.code, labelIt: entry.labelIt, labelEn: entry.labelEn })
const rule = (n: number, over: Partial<RoutingRule>): RoutingRule => ({
  id: uid('3737', n),
  siteId: SITE.id,
  seq: n - 1,
  machineClass: null,
  target: { kind: 'TEAM', id: DEMO_TEAMS[0]!.id, name: 'L1 Squadra giacche', active: true },
  push: true,
  escalateAfterMinutes: null,
  escalateTo: null,
  escalateAgainAfterMinutes: null,
  escalateAgainTo: null,
  active: true,
  requests: 0,
  version: 1,
  updatedAt: AT,
  ...over,
})

export const DEMO_RULES: RoutingRule[] = [
  rule(1, { machineClass: cls(CLASSES.lockstitch), escalateAfterMinutes: 10, escalateTo: DEMO_PEOPLE.marco, escalateAgainAfterMinutes: 30, escalateAgainTo: DEMO_PEOPLE.anna, requests: 14, version: 3 }),
  rule(2, { machineClass: cls(CLASSES.clickingPress), target: { kind: 'TECHNICIAN', id: DEMO_PEOPLE.giulia.id, name: DEMO_PEOPLE.giulia.name, active: true }, escalateAfterMinutes: 5, escalateTo: DEMO_PEOPLE.anna, requests: 4 }),
  rule(3, { machineClass: cls(CLASSES.heatPress), target: { kind: 'TEAM', id: DEMO_TEAMS[1]!.id, name: 'L2 Squadra pantaloni', active: true }, push: false, active: false }),
  rule(4, { target: { kind: 'TEAM', id: DEMO_TEAMS[2]!.id, name: 'MAN Manutenzione', active: true }, escalateAfterMinutes: 15, escalateTo: DEMO_PEOPLE.marco, requests: 31, version: 2 }),
]

export const DEMO_LOCK: LockRead = { siteId: SITE.id, lockBy: 'ANYONE_AT_STATION', signSafeBy: 'TECHNICIANS', hazardReportOnLock: true, version: 2, canManage: true }

const type = (n: number, over: Partial<CheckType>): CheckType => ({
  id: uid('3838', n),
  code: 'CODE',
  labelIt: '',
  labelEn: '',
  labelI18n: {},
  legalBasis: 'D.Lgs. 81/2008 art. 71 (esempio)',
  machineClass: null,
  defaultInterval: 12,
  defaultIntervalUnit: 'MONTH',
  outsideBody: false,
  retentionYears: LEAST_RETENTION_YEARS,
  keptYears: LEAST_RETENTION_YEARS,
  sortOrder: n,
  active: true,
  plans: 0,
  results: 0,
  version: 1,
  updatedAt: AT,
  ...over,
})

export const DEMO_TYPES: CheckType[] = [
  type(1, { code: 'PRESS_GUARDS', labelIt: 'Protezioni della trancia', labelEn: 'Clicking press guards', machineClass: cls(CLASSES.clickingPress), defaultInterval: 6, plans: 2, results: 7 }),
  type(2, { code: 'EARTHING', labelIt: 'Impianto di messa a terra', labelEn: 'Earthing system', legalBasis: 'DPR 462/2001 (esempio)', defaultInterval: 2, defaultIntervalUnit: 'YEAR', outsideBody: true, retentionYears: 10, keptYears: 10, plans: 1, results: 2 }),
  type(3, { code: 'COMPRESSOR_VESSEL', labelIt: 'Serbatoio del compressore', labelEn: 'Compressor vessel', machineClass: cls(CLASSES.compressor), defaultInterval: 1, defaultIntervalUnit: 'YEAR', outsideBody: true, plans: 1, results: 3, version: 2 }),
  type(4, { code: 'HEAT_PRESS_THERMO', labelIt: 'Termostato della pressa', labelEn: 'Heat press thermostat', machineClass: cls(CLASSES.heatPress), defaultInterval: 3, active: false, results: 4, version: 3 }),
]

/** The incident rules as `GET /safety/incidents/rules` answers them: the domain's constants, nothing of our own. */
export const DEMO_INCIDENT_RULES: IncidentRules = {
  rule: { law: INCIDENT_LAW, ...INAIL_RULE, words: { en: [...INAIL_RULE_WORDS.en], it: [...INAIL_RULE_WORDS.it] } },
  reminders: { hoursBefore: [...INAIL_REMINDER_HOURS] },
  floor: { anonymousKinds: [...ANONYMOUS_KINDS], photos: INCIDENT_LIMITS.floorPhotos, photoMinutes: INCIDENT_LIMITS.floorPhotoMinutes, emergencyNumber: EMERGENCY_NUMBER },
  law: { incident: INCIDENT_LAW, people: PROTECTED_LAW },
}

const holds = (role: PlantRole, permission: string) => (PLANT_ROLES[role] as readonly string[]).includes(permission)

/** The W2b sections as a role sees them with every read answered (the cases change what they show). */
export function demoDepth(role: PlantRole, over: Partial<DepthModel> = {}): DepthModel {
  const manageSettings = holds(role, 'plant.settings.manage')
  const manageChecks = holds(role, 'plant.checks.manage')
  return {
    can: { people: holds(role, 'people.view'), audit: holds(role, 'audit.read'), incidents: holds(role, 'safety.incidents.view') },
    site: DEMO_SITES[0]!,
    sites: DEMO_SITES,
    siteFromTopBar: true,
    live: 'live',
    asOf: AT,
    save: { kind: 'saved', at: at(30, 8, 12) },
    changedElsewhere: false,
    notice: null,
    routing: { read: { status: 'ready', value: { siteId: SITE.id, rules: DEMO_RULES, canManage: manageSettings } }, busy: false, preview: { classId: CLASSES.lockstitch.id, read: { status: 'ready', value: { rule: DEMO_RULES[0]! } } } },
    lock: { read: { status: 'ready', value: { ...DEMO_LOCK, canManage: manageSettings } }, draft: null, busy: false, problem: null },
    checks: { read: { status: 'ready', value: { types: DEMO_TYPES, canManage: manageChecks, leastRetentionYears: LEAST_RETENTION_YEARS } }, rows: 'active', busy: false },
    incidents: holds(role, 'safety.incidents.view') ? { status: 'ready', value: DEMO_INCIDENT_RULES } : { status: 'forbidden' },
    dialog: null,
    stepUp: STEP_UP_CLOSED,
    leaving: null,
    historyHref: '/w/DEMO/plant/settings/history',
    ...over,
  }
}
