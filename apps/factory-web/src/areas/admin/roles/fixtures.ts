import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { CATALOGUE, COMPANIES, inShell, NOW, panels, PREFIX, ROLES, USERS } from '../shared/fixtures'
import { failed, loaded, loading } from '../shared/model'
import type { RoleRecordModel, RolesViewModel } from './model'
import type { TwoFactorRole } from '../security/api'
import type { RoleTwoFactorModel } from '../security/view/RoleTwoFactor'
import { RoleRecordView } from './view/RoleRecordView'
import { RolesView } from './view/RolesView'

/** SCR-012 Roles & permissions with the ready-made roles and one made-up custom copy; a short made-up catalogue. */

type Case = { page: 'list'; model: RolesViewModel } | { page: 'role'; model: RoleRecordModel; dock?: boolean }

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const list = (over: Partial<RolesViewModel> = {}): Case => ({ page: 'list', model: { prefix: PREFIX, roles: loaded(ROLES), catalogue: CATALOGUE, asOf: NOW, query: '', audience: 'all', pages: 1, ...over } })
const role = (index: number, over: Partial<RoleRecordModel> = {}, dock = false): Case => ({
  page: 'role',
  dock,
  model: { prefix: PREFIX, tab: 'permissions', role: ROLES[index]!, catalogue: CATALOGUE, holders: loaded(USERS), companies, ...over },
})

// B-W2a-36: Scope rules › Two-factor, made-up holders.
const twoFactorOf = (index: number, over: Partial<TwoFactorRole> = {}): TwoFactorRole => {
  const base = ROLES[index]!
  return {
    id: base.id,
    key: base.key,
    name: base.name,
    system: base.system,
    requireMfa: base.requireMfa,
    requireMfaSince: null,
    lock: null,
    templateAsks: false,
    version: base.version,
    holders: [
      { userId: USERS[3]!.id, name: USERS[3]!.displayName, twoFactor: false },
      { userId: USERS[1]!.id, name: USERS[1]!.displayName, twoFactor: true },
    ],
    heldByMe: false,
    ...over,
  }
}
const tf = (role: TwoFactorRole, over: Partial<RoleTwoFactorModel> = {}): RoleTwoFactorModel => ({ role: { state: 'ok', value: role }, canChange: true, dialog: { kind: 'none' }, ...over })

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
    { id: 'compare-selected', label: 'Two roles ticked: Compare 2', model: list({ selected: [ROLES[2]!.id, ROLES[5]!.id] }), note: 'The ticks are the pick: two or three roles.' },
    { id: 'compare-one', label: 'One role ticked: Compare held', model: list({ selected: [ROLES[2]!.id] }), note: 'Held with its reason until a second role is ticked; more than three is held too.' },
    { id: 'compare', label: 'Compare two roles', model: list({ selected: [ROLES[2]!.id, ROLES[5]!.id], compare: [ROLES[2]!.id, ROLES[5]!.id] }), note: 'Rows where they differ are marked.' },
    { id: 'compare-three', label: 'Compare three roles', model: list({ selected: [ROLES[1]!.id, ROLES[2]!.id, ROLES[4]!.id], compare: [ROLES[1]!.id, ROLES[2]!.id, ROLES[4]!.id] }) },
    { id: 'loading', label: 'Loading', model: list({ roles: loading(), asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: list({ roles: failed('problem.unavailable'), asOf: null }) },
    { id: 'role-permissions', label: 'Role: what it can do', model: role(3), note: 'Sentences first, then every permission by area with its risk mark; ready-made roles are read-only.' },
    { id: 'role-custom', label: 'Role: a custom copy behind its template', model: role(5) },
    { id: 'role-rules', label: 'Role: rules that always apply, and two-factor', model: role(3, { tab: 'rules', twoFactor: tf(twoFactorOf(3)) }), note: 'B-W2a-36: the switch, the people without two-factor, Save (who it affects first, then a fresh code).' },
    { id: 'role-two-factor-on', label: 'Role: two-factor switched on, not saved yet', model: role(3, { tab: 'rules', twoFactor: tf(twoFactorOf(3), { draft: true }) }) },
    { id: 'role-two-factor-fixed', label: 'Role: a ready-made role that always asks', model: role(1, { tab: 'rules', twoFactor: tf(twoFactorOf(1, { requireMfa: true, lock: 'template', templateAsks: true })) }), note: 'Held with its reason.' },
    { id: 'role-two-factor-mine', label: 'Role: a role you hold', model: role(3, { tab: 'rules', twoFactor: tf(twoFactorOf(3, { heldByMe: true })) }) },
    // B-W2b-24: since when the role asks (Role.requireMfaSince), and a role that asked before the date was kept.
    { id: 'role-two-factor-since', label: 'Role: asks for two-factor, since a day', model: role(3, { tab: 'rules', twoFactor: tf(twoFactorOf(3, { requireMfa: true, requireMfaSince: '2026-10-28T13:05:00.000Z' })) }), note: 'B-W2b-24: "Asked since" the day in the site zone.' },
    { id: 'role-two-factor-since-unknown', label: 'Role: asked before the date was kept', model: role(3, { tab: 'rules', twoFactor: tf(twoFactorOf(3, { requireMfa: true })) }), note: 'B-W2b-24: a role that asked before Nexus kept the date (requireMfaSince null).' },
    {
      id: 'role-two-factor-dialog',
      label: 'Role: asking two-factor, who it affects',
      model: role(3, {
        tab: 'rules',
        twoFactor: tf(twoFactorOf(3), {
          draft: true,
          dialog: { kind: 'twoFactor', requireMfa: true, changes: [{ roleId: ROLES[3]!.id, version: ROLES[3]!.version, requireMfa: true }], preview: { state: 'ok', value: { affected: [{ userId: USERS[3]!.id, name: USERS[3]!.displayName, twoFactor: false }], openSessions: 1, refusals: [] } }, busy: false, problem: null, reason: '' },
        }),
      }),
    },
    { id: 'role-two-factor-loading', label: 'Role: two-factor loading', model: role(3, { tab: 'rules', twoFactor: { role: { state: 'loading' }, canChange: true, dialog: { kind: 'none' } } }) },
    { id: 'role-users', label: 'Role: who has it', model: role(2, { tab: 'users' }) },
    { id: 'role-users-none', label: 'Role: nobody has it', model: role(3, { tab: 'users', holders: loaded([]) }) },
    { id: 'role-floor', label: 'Role: a floor role', model: role(9, { tab: 'users' }) },
    { id: 'role-activity', label: 'Role: activity', model: role(4, { tab: 'activity' }) },
    { id: 'role-dock', label: 'Role: history beside the permissions (≥ 1280 px)', model: role(3, {}, true) },
    { id: 'role-not-found', label: 'Role: not found', model: { page: 'role', model: { prefix: PREFIX, tab: 'permissions', role: null, problem: 'problem.notFound', catalogue: null, holders: loading(), companies } } },
  ],
})
