import type { SecurityEvent } from '../events/api'
import type { SecuritySettings } from './api'

/**
 * Made-up security settings and events for the design review (B-W2b-413): invented sites, invented people ("Anna Esempio" …),
 * made-up times and countries. Nothing here is a real company, person, address or event. Design-only.
 */

const at = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 10, day, hour, minute)).toISOString()
const id = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`

const bound = (min: number, max: number, value: number) => ({ min, max, default: value })

export const DEMO_SETTINGS: SecuritySettings = {
  version: 3,
  sessions: {
    office: { idleMinutes: 480, longestHours: 168 },
    portal: { idleMinutes: 30, longestHours: 12 },
    floor: [
      { siteId: id('5173', 1), companyId: id('5c00', 1), code: 'P1', name: 'Stabilimento Demo', idleMinutes: 10, shiftEnds: ['14:00', '22:00'] },
      { siteId: id('5173', 2), companyId: id('5c00', 1), code: 'MAG', name: 'Magazzino Esempio', idleMinutes: 15, shiftEnds: [] },
    ],
  },
  stepUp: {
    actions: [
      { key: 'bankDetails.change', permissions: ['companies.bank.manage', 'purchasing.bank.propose', 'purchasing.bank.verify', 'purchasing.bank.reveal'], on: true, canSwitchOff: true, fixed: null },
      { key: 'access.change', permissions: ['roles.assign', 'roles.manage', 'users.invite', 'users.suspend', 'users.reactivate', 'users.deactivate', 'users.resetPassword', 'workers.roles'], on: true, canSwitchOff: false, fixed: 'ACCESS' },
      { key: 'approvals.aboveLimit', permissions: ['approvals.decide'], on: true, canSwitchOff: false, fixed: 'RULE' },
      { key: 'records.erase', permissions: ['parties.erase'], on: true, canSwitchOff: true, fixed: null },
      { key: 'workers.credentials', permissions: ['workers.credentials'], on: true, canSwitchOff: true, fixed: null },
      { key: 'invoices.issue', permissions: ['invoices.issue'], on: false, canSwitchOff: true, fixed: null },
      { key: 'money.settings', permissions: ['costing.method.manage', 'costing.actuals.manage', 'invoices.tax.switch', 'accounting.unlock', 'orders.waive'], on: true, canSwitchOff: true, fixed: null },
      { key: 'reminders.switch', permissions: ['receivables.reminders.switch', 'purchasing.reminders.switch'], on: true, canSwitchOff: true, fixed: null },
      { key: 'email.identities', permissions: ['email.manage'], on: true, canSwitchOff: true, fixed: null },
      { key: 'branding.change', permissions: ['documents.branding.manage'], on: true, canSwitchOff: true, fixed: null },
      { key: 'signatures.sign', permissions: ['quality.amendments.sign', 'safety.risk.sign', 'compliance.techfiles.sign'], on: true, canSwitchOff: false, fixed: 'SIGNATURE' },
      { key: 'legal.outward', permissions: ['compliance.techfiles.share', 'compliance.recall.send', 'invoices.testMode.manage'], on: true, canSwitchOff: false, fixed: 'LEGAL' },
      { key: 'security.settings', permissions: ['security.settings.manage'], on: true, canSwitchOff: false, fixed: 'SECURITY' },
    ],
    maxFailures: 5,
    lockMinutes: 15,
    validMinutes: 5,
  },
  bounds: {
    officeIdleMinutes: bound(15, 1440, 480),
    officeLongestHours: bound(1, 720, 168),
    portalIdleMinutes: bound(5, 30, 30),
    portalLongestHours: bound(1, 12, 12),
    stepUpMaxFailures: bound(3, 10, 5),
    stepUpLockMinutes: bound(5, 1440, 15),
  },
  canChange: true,
}

const event = (n: number, over: Partial<SecurityEvent>): SecurityEvent => ({
  id: id('5e7e', n),
  at: at(13, 9, 60 - n),
  kind: 'SIGN_IN',
  surface: 'OFFICE',
  result: 'SUCCEEDED',
  actor: { kind: 'PERSON', id: id('3333', 1), name: 'Anna Esempio' },
  ipCountry: 'IT',
  siteId: null,
  partyId: null,
  record: null,
  details: { secondFactor: 'TOTP' },
  ...over,
})

export const DEMO_EVENTS: SecurityEvent[] = [
  event(1, { kind: 'SIGN_IN_FAILED', result: 'REFUSED', actor: { kind: 'NOBODY', id: null, name: null }, details: { reason: 'UNKNOWN_ACCOUNT' } }),
  event(2, { kind: 'SIGN_IN_FAILED', result: 'REFUSED', actor: { kind: 'PERSON', id: id('3333', 2), name: 'Marco Prova' }, details: { reason: 'WRONG_PASSWORD', failedAttempts: 3 } }),
  event(3, { kind: 'LOCKOUT', result: 'LOCKED', actor: { kind: 'PERSON', id: id('3333', 2), name: 'Marco Prova' }, details: { what: 'ACCOUNT', lockedUntil: at(13, 9, 15), after: 'auth.signInFailed' } }),
  event(4, { kind: 'PERMISSION_DENIED', result: 'REFUSED', actor: { kind: 'PERSON', id: id('3333', 3), name: 'Lucia Demo' }, details: { permission: 'costing.view', route: 'GET /costing/styles/:styleId/revisions/:revisionId/cost-sheet' } }),
  event(5, { kind: 'EXPORT', result: 'DONE', record: { type: 'ExportJob', id: id('e4e4', 1) }, details: { action: 'exports.request', listKey: 'admin.audit', format: 'CSV' } }),
  event(6, { kind: 'ROLE_CHANGED', result: 'DONE', record: { type: 'Role', id: id('4444', 9) }, details: { change: 'roles.update' } }),
  event(7, { kind: 'MFA_CHANGED', result: 'DONE', actor: { kind: 'PERSON', id: id('3333', 4), name: 'Paolo Fittizio' }, details: { change: 'SET_UP' } }),
  event(8, { kind: 'SIGN_IN_FAILED', surface: 'FLOOR', result: 'REFUSED', actor: { kind: 'WORKER', id: id('7070', 1), name: null }, siteId: id('5173', 1), ipCountry: null, details: { reason: 'WRONG_PIN', failedAttempts: 1 } }),
  event(9, { kind: 'STEP_UP_LOCKED', result: 'LOCKED', actor: { kind: 'PERSON', id: id('3333', 3), name: 'Lucia Demo' }, details: { result: 'WRONG_CODE', lockedUntil: at(13, 9, 40) } }),
  event(10, {}),
]
