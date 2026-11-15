import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_COMPANIES, DEMO_USER } from '../../../../shell/design-data'
import { inShell } from '../../../home/reports/digest/fixtures'
import type { RuleRoutes } from './api'
import { newRouteDraft } from './model'
import { RoutesPanel, type RoutesModel } from './view/RoutesPanel'

/**
 * SCR-645 — a rule's routes in the rule dialog (B-W2b-435; ANA-041 "alert routing by place and role"), with made-up data only:
 * three routes (a site to a role, a line to a person, a customer to a role), none yet, adding (and held), a refused route,
 * read only, loading and failing.
 */

const RULE = '0190f0e2-8888-7000-8000-000000000001'
const SITE = { id: '0190f0e2-2222-7000-8000-000000000001', code: 'NORD', name: 'Stabilimento Demo Nord', lines: [{ id: '0190f0e2-6666-7000-8000-000000000001', code: 'L1', name: 'Linea Demo 1' }] }
const CHOICES: NonNullable<RuleRoutes['choices']> = {
  roles: [
    { id: '0190f0e2-9999-7000-8000-000000000001', name: 'Quality inspector', key: 'quality_inspector' },
    { id: '0190f0e2-9999-7000-8000-000000000002', name: 'Planner', key: 'planner' },
  ],
  people: [
    { id: DEMO_USER.id, name: DEMO_USER.displayName },
    { id: '0190f0e2-3333-7000-8000-000000000002', name: 'Sam Esempio' },
  ],
  companies: [{ id: DEMO_COMPANIES[0]!.id, code: DEMO_COMPANIES[0]!.code, name: DEMO_COMPANIES[0]!.name, whole: true, sites: [SITE] }],
  customers: [{ id: '0190f0e2-4444-7000-8000-000000000001', code: 'DEMO-C1', name: 'Cliente Demo Moto' }],
  customersComplete: true,
}

const ROUTES: RuleRoutes = {
  ruleId: RULE,
  canChange: true,
  max: 50,
  choices: CHOICES,
  routes: [
    { id: '0190f0e2-aaaa-7000-8000-000000000001', ruleId: RULE, scope: 'SITE', scopeId: SITE.id, place: { label: SITE.name, code: SITE.code }, who: { kind: 'ROLE', id: CHOICES.roles[0]!.id, name: 'Quality inspector' }, createdAt: '2026-11-12T08:00:00.000Z' },
    { id: '0190f0e2-aaaa-7000-8000-000000000002', ruleId: RULE, scope: 'LINE', scopeId: SITE.lines[0]!.id, place: { label: 'Linea Demo 1', code: 'L1' }, who: { kind: 'PERSON', id: '0190f0e2-3333-7000-8000-000000000002', name: 'Sam Esempio' }, createdAt: '2026-11-12T08:05:00.000Z' },
    { id: '0190f0e2-aaaa-7000-8000-000000000003', ruleId: RULE, scope: 'CUSTOMER', scopeId: CHOICES.customers[0]!.id, place: { label: 'Cliente Demo Moto', code: 'DEMO-C1' }, who: { kind: 'ROLE', id: CHOICES.roles[1]!.id, name: 'Planner' }, createdAt: '2026-11-12T08:10:00.000Z' },
  ],
}

const base: RoutesModel = { read: { status: 'ready', data: ROUTES }, draft: newRouteDraft(CHOICES), busy: null, offline: false, notice: null }

function RoutesDesign({ model }: { model: RoutesModel }) {
  return inShell('/home/alerts', createElement(RoutesPanel, { model }), 'owner')
}

export const designScreen = defineDesignScreen<RoutesModel>({
  screen: 'SCR-645',
  title: 'Alert routing by place and role (the rule dialog)',
  view: RoutesDesign,
  cases: [
    { id: 'routes', label: 'Three routes', model: base, note: 'A site to Quality, a line to one person, a customer to the planners; elsewhere the rule’s own role.' },
    { id: 'none', label: 'No route yet', model: { ...base, read: { status: 'ready', data: { ...ROUTES, routes: [] } } } },
    { id: 'person', label: 'Adding: one person at a line', model: { ...base, draft: { ...base.draft!, scope: 'LINE', scopeId: SITE.lines[0]!.id, who: 'PERSON' } } },
    { id: 'adding', label: 'Adding', model: { ...base, busy: 'add' } },
    { id: 'added', label: 'Added', model: { ...base, notice: { key: 'routes.done.added', tone: 'success' } } },
    { id: 'refused', label: 'Refused (already told there)', model: { ...base, notice: { key: 'routes.error.duplicate', tone: 'danger' } } },
    { id: 'full', label: 'At the limit — Add held', model: { ...base, read: { status: 'ready', data: { ...ROUTES, max: 3 } } } },
    { id: 'read-only', label: 'Read only (no right to change the rule)', model: { ...base, read: { status: 'ready', data: { ...ROUTES, canChange: false, choices: null } } } },
    { id: 'offline', label: 'Offline — held with why', model: { ...base, offline: true } },
    { id: 'loading', label: 'Loading', model: { ...base, read: { status: 'loading' } } },
    { id: 'error', label: 'Failed', model: { ...base, read: { status: 'error', problem: 'routes.error.read' } } },
  ],
})
