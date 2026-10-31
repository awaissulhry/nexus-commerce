import { KINDS, RULE_KINDS, type RuleKind } from '@nexus/factory-domain/alerts/kinds'
import { ruleSentence } from '@nexus/factory-domain/alerts/rules'
import type { AlertRule, RuleChoices, RuleKindInfo, RulesList, RuleTimer } from './api'

/**
 * Made-up rules for the design cases of Home › Alerts (SCR-234) and Admin › Approvals, automation & AI (SCR-167) — invented
 * companies, sites and records, never real business data (PLAN §3.1). The sentences are factory-domain's own words for the
 * made-up numbers, so a case reads exactly as the API would say it.
 */

export const DEMO_AT = (day: number, hour: number, minute = 0) => new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString()
export const DEMO_NOW = Date.UTC(2026, 9, 31, 9, 40)

const ROLES = {
  planner: { roleId: '0190f0e2-7777-7000-8000-000000000001', name: 'Planner' },
  quality: { roleId: '0190f0e2-7777-7000-8000-000000000002', name: 'Quality inspector' },
  finance: { roleId: '0190f0e2-7777-7000-8000-000000000003', name: 'Finance' },
  buyer: { roleId: '0190f0e2-7777-7000-8000-000000000004', name: 'Buyer' },
  // B-W2b-24: INTEGRATION_FAILING tells the administrators.
  admin: { roleId: '0190f0e2-7777-7000-8000-000000000005', name: 'Administrator' },
}
const COMPANY = { id: '0190f0e2-6666-7000-8000-000000000001', name: 'Demo Pelletteria' }
const SITE = { id: '0190f0e2-6666-7000-8000-000000000101', name: 'Demo plant A1' }

const rid = (n: number) => `0190f0e2-8888-7000-8000-${String(n).padStart(12, '0')}`

export function demoRule(n: number, kind: RuleKind, extra: Partial<AlertRule> = {}): AlertRule {
  const spec = KINDS[kind]
  const recipient = extra.recipient !== undefined ? extra.recipient : ({ planner: ROLES.planner, quality_inspector: ROLES.quality, finance: ROLES.finance, buyer: ROLES.buyer, admin: ROLES.admin } as Record<string, { roleId: string; name: string }>)[spec.builtIn.recipientRole]!
  const place = extra.place ?? { companyId: null, siteId: null, label: null }
  const base: AlertRule = {
    id: rid(n),
    ruleKind: kind,
    trigger: spec.trigger,
    name: spec.builtIn.name.en,
    sentence: { en: '', it: '' },
    threshold: { ...spec.builtIn.threshold },
    severity: spec.builtIn.severity,
    place,
    recipient,
    channels: ['IN_APP'],
    cooldownMinutes: spec.builtIn.cooldownMinutes,
    enabled: true,
    builtIn: true,
    lastFiredAt: DEMO_AT(30, 14, 5),
    fired7Days: 3,
    openAlerts: 1,
    timers: spec.trigger === 'DATE' ? { pending: 4, nextFireAt: DEMO_AT(31, 23, 0) } : null,
    canChange: true,
    version: 2,
    ...extra,
  }
  const words = { place: base.place.label, recipient: base.recipient?.name ?? null }
  const input = { ruleKind: kind, threshold: base.threshold, channels: base.channels, cooldownMinutes: base.cooldownMinutes }
  return { ...base, sentence: { en: ruleSentence(input, words, 'en'), it: ruleSentence(input, words, 'it') } }
}

export const DEMO_RULES: AlertRule[] = [
  demoRule(1, 'ORDER_LATE_RISK', { fired7Days: 6, openAlerts: 2 }),
  demoRule(2, 'HOLD_TOO_LONG', { place: { companyId: COMPANY.id, siteId: SITE.id, label: SITE.name }, fired7Days: 4 }),
  demoRule(3, 'MATERIAL_SHORT', { fired7Days: 2 }),
  demoRule(4, 'APPROVAL_OVERDUE', { fired7Days: 0, openAlerts: 0, lastFiredAt: null }),
  demoRule(5, 'PO_NOT_CONFIRMED', { fired7Days: 1, channels: ['IN_APP', 'EMAIL'] }),
  demoRule(6, 'CERTIFICATE_EXPIRING', { fired7Days: 1 }),
  demoRule(7, 'CERTIFICATE_EXPIRING', { builtIn: false, threshold: { daysBefore: 90, workingDays: false }, name: 'Certificate expiring (90 days)', fired7Days: 0, openAlerts: 0, lastFiredAt: null, timers: { pending: 2, nextFireAt: DEMO_AT(31, 23, 0) } }),
  demoRule(8, 'INVOICE_DEADLINE', { fired7Days: 2, openAlerts: 2, timers: { pending: 3, nextFireAt: DEMO_AT(31, 23, 0) } }),
  // B-W2b-24: the connections' health (made up: nothing failed this week).
  demoRule(9, 'INTEGRATION_FAILING', { fired7Days: 0, openAlerts: 0, lastFiredAt: null }),
]

export const DEMO_KINDS: RuleKindInfo[] = RULE_KINDS.map((kind) => ({ kind, trigger: KINDS[kind].trigger, recordType: KINDS[kind].recordType, defaults: { ...KINDS[kind].builtIn.threshold } }))

export const demoRules = (rules: readonly AlertRule[] = DEMO_RULES, canAdd = true): RulesList => ({ asOf: DEMO_AT(31, 9, 38), rules: [...rules], kinds: DEMO_KINDS, canAdd })

export const DEMO_CHOICES: RuleChoices = {
  roles: (Object.entries(ROLES) as [string, { roleId: string; name: string }][]).map(([key, role]) => ({ id: role.roleId, name: role.name, key: key === 'quality' ? 'quality_inspector' : key })).sort((a, b) => a.name.localeCompare(b.name)),
  everywhere: true,
  companies: [{ id: COMPANY.id, name: COMPANY.name, wholeCompany: true, sites: [SITE, { id: '0190f0e2-6666-7000-8000-000000000102', name: 'Demo plant B2' }] }],
}

const tid = (n: number) => `0190f0e2-9999-7000-8000-${String(n).padStart(12, '0')}`
export const DEMO_TIMERS: RuleTimer[] = [
  { id: tid(1), timerKey: 'CERTIFICATE_EXPIRY:-30d', record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000201', label: 'CERT-DEMO-0007' }, dueAt: DEMO_AT(30, 23), fireAt: DEMO_AT(31, 23), status: 'PENDING', firedAt: null, cancelledAt: null, cancelReason: null },
  { id: tid(2), timerKey: 'CERTIFICATE_EXPIRY:-30d', record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000202', label: 'CERT-DEMO-0011' }, dueAt: DEMO_AT(36, 23), fireAt: DEMO_AT(36, 23), status: 'PENDING', firedAt: null, cancelledAt: null, cancelReason: null },
  { id: tid(3), timerKey: 'CERTIFICATE_EXPIRY:-30d', record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000203', label: 'CERT-DEMO-0003' }, dueAt: DEMO_AT(20, 23), fireAt: DEMO_AT(20, 23), status: 'FIRED', firedAt: DEMO_AT(21, 0, 1), cancelledAt: null, cancelReason: null },
  { id: tid(4), timerKey: 'CERTIFICATE_EXPIRY:-30d', record: { type: 'Certificate', id: '0190f0e2-5555-7000-8000-000000000204', label: 'CERT-DEMO-0002' }, dueAt: DEMO_AT(18, 23), fireAt: DEMO_AT(18, 23), status: 'CANCELLED', firedAt: null, cancelledAt: DEMO_AT(17, 9), cancelReason: 'MOVED' },
]
