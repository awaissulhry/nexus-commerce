import { alertRuleSentence, QUALITY_ALERT_EVENTS, type AlertAudience, type AlertChannel, type QualityAlertEvent } from '@nexus/factory-domain/quality/rules/alerts'
import { SEPARATION_IDS } from '@nexus/factory-domain/quality/rules/duties'
import type { AlertRule, AlertRules, Customer, Rules } from './api'

// Local made-up ids and times (the design-only `_shared/fixtures` may be imported by fixtures and tests alone).
const uid = (family: string, n: number): string => `0190f0e2-${family.padStart(4, '0').slice(-4)}-7000-8000-${String(n).padStart(12, '0')}`
const at = (day: number, hour = 9, minute = 0): string => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
/** The company of the review's address (made up). */
export const COMPANY_ID = uid('qrk', 1)

/**
 * Made-up data for the SCR-260 design cases (DEMO-… codes, invented names). Nothing here is a real company, customer, site or
 * person; the rule sentences are factory-domain's own words.
 */

export const DEMO_TENANT_ID = uid('qr', 1)
const role = (n: number, key: string, name: string) => ({ id: uid('qrr', n), key, name })
export const ROLES = [role(1, 'quality_inspector', 'Quality inspector'), role(2, 'floor_supervisor', 'Floor supervisor'), role(3, 'production_manager', 'Production manager'), role(4, 'owner', 'Owner')]
const QUALITY = ROLES[0]!
const SUPERVISOR = ROLES[1]!

export const CUSTOMERS: Customer[] = [
  { id: uid('qrc', 1), code: 'DEMO-BRAND', legalName: 'Demo Brand Srl', tradeName: 'Demo Brand' },
  { id: uid('qrc', 2), code: 'DEMO-RACE', legalName: 'Demo Racing Team Srl', tradeName: null },
  { id: uid('qrc', 3), code: 'DEMO-SHOP', legalName: 'Demo Moto Shop Snc', tradeName: 'Demo Shop' },
]

const separations = (broken: Partial<Record<(typeof SEPARATION_IDS)[number], { name: string; permissions: string[] }[]>> = {}): Rules['separations'] =>
  SEPARATION_IDS.map((id) => ({ id, kept: !broken[id], roles: (broken[id] ?? []).map((entry, index) => ({ id: uid('qrx', index + 1), key: `custom.${entry.name.toLowerCase().replace(/\s+/g, '_')}`, name: entry.name, permissions: entry.permissions })) }))

const SITES: Rules['monitoring'] = [
  { siteId: uid('qrs', 1), code: 'DEMO-P1', name: 'Demo plant 1', scanSubject: 'WORKER' },
  { siteId: uid('qrs', 2), code: 'DEMO-P2', name: 'Demo plant 2', scanSubject: 'STATION' },
]

/** Every company's rules: the defaults saved once (Q19 (a), both conditions, someone else releases a hold). */
export const TENANT_RULES: Rules = {
  companyId: null,
  company: null,
  version: 3,
  updatedAt: at(27, 10, 42),
  mayChange: true,
  duties: {
    own: { releaseFourEyes: 'WHEN_REQUIRED', fourEyesConditions: ['CUSTOMER', 'OVERRIDE'], secondPersonPartyIds: [CUSTOMERS[0]!.id], placerMayRelease: false },
    inForce: { releaseFourEyes: { rule: 'WHEN_REQUIRED', source: 'TENANT' }, conditions: ['CUSTOMER', 'OVERRIDE'], conditionsFromTenant: [], placerMayRelease: { value: false, source: 'TENANT' } },
    customers: [{ id: CUSTOMERS[0]!.id, code: CUSTOMERS[0]!.code, name: 'Demo Brand', listedOn: 'TENANT' }],
  },
  results: {
    own: { stopAtRejectNumber: false, benchUndoSeconds: 10 },
    inForce: { stopAtRejectNumber: { value: false, source: 'TENANT' }, benchUndoSeconds: { value: 10, source: 'TENANT' } },
    limits: { benchUndoMin: 0, benchUndoMax: 300 },
  },
  monitoring: SITES,
  separations: separations(),
}

/** The company of the address: it lists one more customer and lets the placer release (its own), follows the rest. */
export const COMPANY_RULES: Rules = {
  ...TENANT_RULES,
  companyId: COMPANY_ID,
  company: { id: COMPANY_ID, code: 'DEMO', name: 'Demo Factory Srl' },
  version: 2,
  updatedAt: at(28, 15, 5),
  duties: {
    own: { releaseFourEyes: null, fourEyesConditions: [], secondPersonPartyIds: [CUSTOMERS[1]!.id], placerMayRelease: true },
    inForce: { releaseFourEyes: { rule: 'WHEN_REQUIRED', source: 'TENANT' }, conditions: ['CUSTOMER', 'OVERRIDE'], conditionsFromTenant: ['CUSTOMER', 'OVERRIDE'], placerMayRelease: { value: true, source: 'COMPANY' } },
    customers: [
      { id: CUSTOMERS[1]!.id, code: CUSTOMERS[1]!.code, name: CUSTOMERS[1]!.legalName, listedOn: 'COMPANY' },
      { id: CUSTOMERS[0]!.id, code: CUSTOMERS[0]!.code, name: 'Demo Brand', listedOn: 'TENANT' },
    ],
  },
  results: {
    own: { stopAtRejectNumber: null, benchUndoSeconds: 30 },
    inForce: { stopAtRejectNumber: { value: false, source: 'TENANT' }, benchUndoSeconds: { value: 30, source: 'COMPANY' } },
    limits: { benchUndoMin: 0, benchUndoMax: 300 },
  },
}

/** A company that never saved its own rules. */
export const COMPANY_FRESH: Rules = {
  ...COMPANY_RULES,
  version: 0,
  updatedAt: null,
  duties: { ...COMPANY_RULES.duties, own: null, inForce: { ...COMPANY_RULES.duties.inForce, placerMayRelease: { value: false, source: 'TENANT' } }, customers: [COMPANY_RULES.duties.customers[1]!] },
  results: { ...COMPANY_RULES.results, own: null, inForce: { stopAtRejectNumber: { value: false, source: 'TENANT' }, benchUndoSeconds: { value: 10, source: 'TENANT' } } },
}

export const BROKEN_SEPARATIONS: Rules = {
  ...COMPANY_RULES,
  separations: separations({ QUALITY_MAKES_NOTHING: [{ name: 'Demo quality and cutting', permissions: ['quality.inspections.record', 'production.cut'] }], ONLY_MAINTENANCE_SIGNS_SAFE: [{ name: 'Demo line lead', permissions: ['plant.signSafe'] }] }),
}

let ruleN = 0
function rule(event: QualityAlertEvent, audience: AlertAudience, over: Partial<AlertRule> & { roleName?: string } = {}): AlertRule {
  ruleN += 1
  const roleRef = over.roleName ? (ROLES.find((entry) => entry.name === over.roleName) ?? null) : null
  const channels: AlertChannel[] = over.channels ?? ['IN_APP']
  const shape = { event, audience, withinMinutes: over.withinMinutes ?? 0, daysBefore: over.daysBefore ?? [], channels }
  return {
    id: uid('qra', ruleN),
    companyId: over.companyId ?? null,
    company: over.company ?? null,
    event,
    audience,
    roleId: roleRef?.id ?? null,
    role: roleRef,
    withinMinutes: shape.withinMinutes,
    daysBefore: shape.daysBefore,
    channels,
    enabled: over.enabled ?? true,
    inForce: over.inForce ?? true,
    sentence: { it: alertRuleSentence(shape, roleRef?.name ?? null, 'it'), en: alertRuleSentence(shape, roleRef?.name ?? null, 'en') },
    lastFiredAt: over.lastFiredAt ?? null,
    fired7d: over.fired7d ?? 0,
    version: over.version ?? 1,
    createdAt: at(20, 9),
    updatedAt: at(27, 10, 42),
  }
}

export const RULES_LIST: AlertRule[] = [
  rule('HOLD_PLACED', 'OWNER', { lastFiredAt: at(29, 8, 15), fired7d: 4 }),
  rule('HOLD_PLACED', 'OWNER_AND_ROLE', { roleName: QUALITY.name, withinMinutes: 240, companyId: COMPANY_ID, company: { id: COMPANY_ID, code: 'DEMO', name: 'Demo Factory Srl' }, lastFiredAt: at(28, 16, 0), fired7d: 1 }),
  rule('CRITICAL_NCR', 'ROLE', { roleName: QUALITY.name, lastFiredAt: at(24, 11, 30), fired7d: 1 }),
  rule('SAFETY_COMPLAINT', 'OWNER_AND_ROLE', { roleName: QUALITY.name, channels: ['IN_APP', 'EMAIL'] }),
  rule('INSPECTION_WAITING', 'ROLE', { roleName: SUPERVISOR.name, withinMinutes: 240, lastFiredAt: at(29, 7, 0), fired7d: 6 }),
  rule('CERTIFICATE_EXPIRING', 'ROLE', { roleName: QUALITY.name, daysBefore: [180, 90, 30], lastFiredAt: at(21, 7, 0), fired7d: 1 }),
  rule('RELEASE_WAITING_SECOND_PERSON', 'ROLE', { roleName: QUALITY.name, withinMinutes: 60, enabled: false }),
  rule('CAPA_ACTION_OVERDUE', 'OWNER_AND_ROLE', { roleName: QUALITY.name, withinMinutes: 1440 }),
]

/** For the company of the address: every company's hold rule is replaced there by the company's own. */
export const RULES_FOR_COMPANY: AlertRule[] = RULES_LIST.map((entry, index) => (index === 0 ? { ...entry, inForce: false } : entry))

const EVENTS: AlertRules['events'] = QUALITY_ALERT_EVENTS.map((event) => ({ event, timing: event === 'CERTIFICATE_EXPIRING' ? 'DAYS' : event === 'CAPA_ACTION_OVERDUE' ? 'ESCALATION' : event === 'INSPECTION_WAITING' || event === 'RELEASE_WAITING_SECOND_PERSON' ? 'WAIT' : 'EVENT', ownerNamed: event !== 'CERTIFICATE_EXPIRING' }))

export const ALERTS: AlertRules = {
  companyId: COMPANY_ID,
  rules: RULES_FOR_COMPANY,
  events: EVENTS,
  roles: ROLES,
  places: { everywhere: true, companies: [{ id: COMPANY_ID, code: 'DEMO', name: 'Demo Factory Srl' }] },
  starterMissing: [],
  mayManage: true,
}

export const ALERTS_STARTER: AlertRules = { ...ALERTS, rules: RULES_FOR_COMPANY.filter((entry) => entry.event !== 'RELEASE_WAITING_SECOND_PERSON' && entry.event !== 'SAFETY_COMPLAINT'), starterMissing: ['SAFETY_COMPLAINT', 'RELEASE_WAITING_SECOND_PERSON'] }
export const ALERTS_EMPTY: AlertRules = { ...ALERTS, rules: [], starterMissing: [...QUALITY_ALERT_EVENTS] }
export const ALERTS_READ_ONLY: AlertRules = { ...ALERTS, places: { everywhere: false, companies: [] }, mayManage: false }
