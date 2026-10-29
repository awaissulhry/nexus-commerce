import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, COMPANIES, inShell, NOW, panels, PREFIX, ROLES, USERS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { RoleRecordModel, RolesViewModel } from './model'
import { RoleRecordView } from './view/RoleRecordView'
import { RolesView } from './view/RolesView'

/** SCR-012 Roles & permissions with the ready-made roles and one made-up custom copy; a short made-up catalogue. */

type Case = { page: 'list'; model: RolesViewModel } | { page: 'role'; model: RoleRecordModel; dock?: boolean }

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const list = (over: Partial<RolesViewModel> = {}): Case => ({ page: 'list', model: { prefix: PREFIX, roles: loaded(ROLES), catalogue: CATALOGUE, asOf: NOW, query: '', audience: 'all', ...over } })
const role = (index: number, over: Partial<RoleRecordModel> = {}, dock = false): Case => ({
  page: 'role',
  dock,
  model: { prefix: PREFIX, tab: 'permissions', role: ROLES[index]!, catalogue: CATALOGUE, holders: loaded(USERS), companies, ...over },
})

function RolesDesign({ model }: { model: Case }) {
  if (model.page === 'list') return inShell('/admin/roles', createElement(RolesView, { model: model.model }))
  const record = model.model.role
  const panel = record ? panels({ type: 'Role', id: record.id, companyId: null }, record.name, 'history') : null
  return inShell(`/admin/roles/${record?.id ?? 'x'}`, createElement(RoleRecordView, { model: { ...model.model, dockOpen: model.dock }, panels: panel }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-012',
  title: 'Roles & permissions, and the Role record',
  view: RolesDesign,
  cases: [
    { id: 'list', label: 'Every role, in plain words', model: list(), note: 'What each role does, its people, its money sight, two-factor; Finance is out of date (a sync updates it), the copy lacks one permission its template gained.' },
    { id: 'floor', label: 'Floor roles only', model: list({ audience: 'floor' }) },
    { id: 'compare', label: 'Compare two roles', model: list({ compare: [ROLES[2]!.id, ROLES[5]!.id] }), note: 'Rows where they differ are marked.' },
    { id: 'compare-pick', label: 'Compare: pick roles', model: list({ compare: [] }) },
    { id: 'loading', label: 'Loading', model: list({ roles: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: list({ roles: failed('problem.unavailable'), asOf: null }) },
    { id: 'role-permissions', label: 'Role: what it can do', model: role(3), note: 'Sentences first, then every permission by area with its risk mark; ready-made roles are read-only.' },
    { id: 'role-custom', label: 'Role: a custom copy behind its template', model: role(5) },
    { id: 'role-rules', label: 'Role: rules that always apply', model: role(3, { tab: 'rules' }) },
    { id: 'role-users', label: 'Role: who has it', model: role(2, { tab: 'users' }) },
    { id: 'role-users-none', label: 'Role: nobody has it', model: role(3, { tab: 'users', holders: loaded([]) }) },
    { id: 'role-floor', label: 'Role: a floor role', model: role(9, { tab: 'users' }) },
    { id: 'role-activity', label: 'Role: activity', model: role(4, { tab: 'activity' }) },
    { id: 'role-dock', label: 'Role: history beside the permissions (≥ 1280 px)', model: role(3, {}, true) },
    { id: 'role-not-found', label: 'Role: not found', model: { page: 'role', model: { prefix: PREFIX, tab: 'permissions', role: null, problem: 'problem.notFound', catalogue: null, holders: loading(), companies } } },
  ],
})
