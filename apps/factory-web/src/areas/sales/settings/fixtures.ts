import { createElement, useEffect, useState } from 'react'
import { templateOf } from '@nexus/factory-domain/auth/roles/templates'
import { fieldsOf, REASON_LIST_GROUPS, sourceOf, type ReasonList } from '@nexus/factory-domain/reasons/lists'
import { missingStandardReasons, standardReasonsOf } from '@nexus/factory-domain/reasons/standard'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { permissionCheck } from '../../../lib/session/session'
import { DEMO_COMPANIES, DEMO_TAG, DEMO_USER } from '../../../shell/design-data'
import { officeNavFor } from '../../../shell/nav/office-nav'
import { OfficeShellView, type OfficeShellViewModel } from '../../../shell/office/view/OfficeShellView'
import type { Reason, ReasonListView } from '../../_shared/reasons/api'
import { ReasonListsView, type ReasonListsModel } from '../../_shared/reasons/view/ReasonListsView'
import type { PolicyAnswer, SalesSettings, Series } from './api'
import { policyDraftOf, quoteDraftOf, settingsCan } from './model'
import { SalesSettingsView, type SalesSettingsModel } from './view/SalesSettingsView'

/**
 * Design cases of Sales › Settings (SCR-235): the quote approval rules (read back as a sentence), the quote defaults,
 * the return policy (a company that follows the group's), the return and cancel reasons (the shared editor's view) and
 * the numbering, in each state the design names and the role cases (finance changes them, sales reads, read-only).
 * Made-up data only.
 */

const PREFIX = '/w/DEMO'
const COMPANY_ID = DEMO_COMPANIES[0].id
const NOW = '2026-10-31T09:42:00.000Z'
const templatePermissions = (key: string, grains: readonly string[] = []): string[] => [...(templateOf(key)?.permissions ?? []), 'home.view', ...grains.map((grain) => `money.${grain}`)]

const ROLE_PERMISSIONS = {
  finance: templatePermissions('finance', ['price', 'cost', 'margin']),
  owner: ['home.view', 'quotes.view', 'sales.returns.view', 'sales.settings.manage', 'numbering.view', 'reasons.view', 'reasons.manage', 'money.price', 'money.margin'],
  sales: templatePermissions('sales', ['price', 'margin']),
  readOnly: ['home.view', 'quotes.view', 'sales.returns.view', 'reasons.view'],
  none: ['home.view'],
} as const
type RoleCase = keyof typeof ROLE_PERMISSIONS

const SETTINGS: SalesSettings = {
  tenant: { id: 'demo-tenant', companyId: null, marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', version: 4, updatedAt: NOW },
  company: { id: COMPANY_ID, companyId: COMPANY_ID, marginFloorPct: '22', discountLimitPct: '12', defaultValidityDays: 45, defaultDepositPct: '30', version: 7, updatedAt: NOW },
  inForce: { marginFloorPct: '22', discountLimitPct: '12', defaultValidityDays: 45, defaultDepositPct: '30', source: 'COMPANY' },
  defaults: { marginFloorPct: '20', discountLimitPct: '15', defaultValidityDays: 30, defaultDepositPct: '30', source: 'DEFAULT' },
}
const POLICY: PolicyAnswer = {
  tenant: { id: 'demo-tenant', companyId: null, windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: 'Unworn, with labels and in the original bag (made-up).', version: 4, updatedAt: NOW },
  company: { id: COMPANY_ID, companyId: COMPANY_ID, windowDays: 14, goodsDueDays: null, freightPaidBy: null, restockingFeePct: null, conditions: null, version: 7, updatedAt: NOW },
  inForce: { windowDays: 14, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: 'Unworn, with labels and in the original bag (made-up).' },
  followsTenant: false,
  canManage: true,
}
const SERIES: Series[] = [
  { id: 's1', companyId: COMPANY_ID, kind: 'QUOTE', code: 'QT-2026', year: 2026, nextNumber: 'QT-2026-0042', status: 'ACTIVE' },
  { id: 's2', companyId: COMPANY_ID, kind: 'SALES_ORDER', code: 'SO-2026', year: 2026, nextNumber: 'SO-2026-0018', status: 'ACTIVE' },
  { id: 's3', companyId: COMPANY_ID, kind: 'RETURN', code: 'RMA-2026', year: 2026, nextNumber: 'RMA-2026-0004', status: 'ACTIVE' },
]

/** The shared reason editor's view with the standard RETURN and CANCEL lists (the page mounts the editor itself). */
function reasonsModel(canManage: boolean): ReasonListsModel {
  const at = '2026-10-30T08:00:00.000Z'
  const rows = (list: ReasonList, offset: number): Reason[] =>
    standardReasonsOf(list).map((reason, index) => ({ id: `0190f1a2-0000-7000-8000-${String(offset + index).padStart(12, '0')}`, list, code: reason.code, labelIt: reason.labelIt, labelEn: reason.labelEn, labelI18n: {}, icon: reason.icon, colour: reason.colour, needsDetail: reason.needsDetail, sortOrder: (index + 1) * 10, active: true, usedCount: index === 0 ? 4 : 0, version: 1, createdAt: at, updatedAt: at }))
  const reasons = rows('RETURN', 900)
  const view: ReasonListView = { list: 'RETURN', source: sourceOf('RETURN'), fields: { ...fieldsOf('RETURN') }, active: reasons.length, inactive: 0, standardMissing: missingStandardReasons('RETURN', reasons.map((row) => row.code)).map((reason) => reason.code), reasons }
  return { lists: REASON_LIST_GROUPS.sales, list: 'RETURN', load: { status: 'ready' }, view, languages: [], canManage, marks: {}, notice: null, changedElsewhere: false, busy: false, dialog: null } as ReasonListsModel
}

interface DesignModel {
  readonly role: RoleCase
  readonly page: SalesSettingsModel
}

function pageModel(role: RoleCase, over: Partial<SalesSettingsModel> = {}): SalesSettingsModel {
  return {
    prefix: PREFIX,
    can: settingsCan(ROLE_PERMISSIONS[role]),
    company: { code: 'DEMO', name: 'Demo company' },
    scope: 'company',
    settings: { value: settingsCan(ROLE_PERMISSIONS[role]).margin ? SETTINGS : stripMargin(SETTINGS), problem: null },
    policy: { value: { ...POLICY, canManage: settingsCan(ROLE_PERMISSIONS[role]).manage }, problem: null },
    series: settingsCan(ROLE_PERMISSIONS[role]).numberingView ? { value: SERIES, problem: null } : null,
    edit: null,
    asOf: NOW,
    live: 'live',
    offline: false,
    changedAt: null,
    receipt: null,
    ...over,
  }
}

/** The API leaves the margin floor out for a reader without the margin grain. */
function stripMargin(settings: SalesSettings): SalesSettings {
  const drop = <T extends { marginFloorPct?: string }>(row: T | null): T | null => (row ? { ...row, marginFloorPct: undefined } : null)
  return { tenant: drop(settings.tenant), company: drop(settings.company), inForce: drop(settings.inForce)!, defaults: drop(settings.defaults)! }
}

function SettingsDesign({ model }: { model: DesignModel }) {
  const [page, setPage] = useState<SalesSettingsModel>(model.page)
  useEffect(() => setPage(model.page), [model.page])
  const shell: OfficeShellViewModel = {
    nav: officeNavFor(permissionCheck([...ROLE_PERMISSIONS[model.role]])),
    path: '/sales/settings',
    switcher: { companies: DEMO_COMPANIES, company: 'DEMO', sites: [], site: null, path: '/sales/settings' },
    user: { displayName: DEMO_USER.displayName, email: DEMO_USER.email },
    tenantTag: DEMO_TAG,
    banners: [],
  }
  const reasons = page.can.reasonsView ? createElement(ReasonListsView, { model: reasonsModel(ROLE_PERMISSIONS[model.role].includes('reasons.manage' as never)) }) : undefined
  return createElement(
    OfficeShellView,
    { model: shell },
    createElement(SalesSettingsView, {
      model: page,
      reasons,
      actions: {
        onScope: (scope) => setPage((current) => ({ ...current, scope, series: scope === 'group' ? null : current.series })),
        onEdit: (card) => setPage((current) => ({ ...current, edit: card && current.settings.value && current.policy.value ? { card, quote: quoteDraftOf(current.settings.value, current.scope), policy: policyDraftOf(current.policy.value, current.scope), busy: false, problem: null, showProblems: false } : null })),
        onQuoteDraft: (patch) => setPage((current) => (current.edit ? { ...current, edit: { ...current.edit, quote: { ...current.edit.quote, ...patch } } } : current)),
        onPolicyDraft: (patch) => setPage((current) => (current.edit ? { ...current, edit: { ...current.edit, policy: { ...current.edit.policy, ...patch } } } : current)),
        onSave: () => setPage((current) => (current.edit ? { ...current, edit: { ...current.edit, showProblems: true } } : current)),
        onDismissReceipt: () => setPage((current) => ({ ...current, receipt: null })),
      },
    }),
  )
}

const editing = (card: 'approval' | 'quote' | 'policy', patch: Partial<NonNullable<SalesSettingsModel['edit']>> = {}): NonNullable<SalesSettingsModel['edit']> => ({ card, quote: quoteDraftOf(SETTINGS, 'company'), policy: policyDraftOf(POLICY, 'company'), busy: false, problem: null, showProblems: false, ...patch })

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-235',
  title: 'Sales settings (quote rules and defaults, return policy and reasons, numbering)',
  view: SettingsDesign,
  cases: [
    { id: 'finance', label: 'Finance: this company’s own settings, every card editable', model: { role: 'finance', page: pageModel('finance') } },
    { id: 'group', label: 'The whole group (group-wide row)', model: { role: 'finance', page: pageModel('finance', { scope: 'group', series: null }) } },
    { id: 'edit-approval', label: 'Editing the approval rules: the rule read back as a sentence', model: { role: 'finance', page: pageModel('finance', { edit: editing('approval', { quote: { ...quoteDraftOf(SETTINGS, 'company'), marginFloorPct: '25' } }) }) } },
    // B-W2b-16: raising a limit asks a fresh code (design ssettings.approval "Raising a limit asks for step-up").
    { id: 'edit-approval-step-up', label: 'Raising the discount limit: the fresh code asked before the save', model: { role: 'finance', page: pageModel('finance', { edit: editing('approval', { quote: { ...quoteDraftOf(SETTINGS, 'company'), discountLimitPct: '25' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence', problem: null } }) } },
    { id: 'edit-approval-step-up-wrong', label: 'Raising the margin floor’s limit: a wrong code, said in the dialog', model: { role: 'finance', page: pageModel('finance', { edit: editing('approval', { quote: { ...quoteDraftOf(SETTINGS, 'company'), marginFloorPct: '10' }, busy: true }), stepUp: { open: true, busy: false, sentence: 'stepUp.sentence', problem: 'stepUp.problem.wrong' } }) } },
    { id: 'edit-approval-step-up-cancelled', label: 'The code not given: nothing saved, said on the card', model: { role: 'finance', page: pageModel('finance', { edit: editing('approval', { quote: { ...quoteDraftOf(SETTINGS, 'company'), discountLimitPct: '25' }, problem: { key: 'stepUp.cancelled' } }) }) } },
    { id: 'edit-problems', label: 'Apply pressed with a wrong percent and validity', model: { role: 'finance', page: pageModel('finance', { edit: editing('quote', { quote: { ...quoteDraftOf(SETTINGS, 'company'), validityDays: '400', depositPct: '0' }, showProblems: true }) }) } },
    { id: 'edit-policy', label: 'Editing the return policy', model: { role: 'finance', page: pageModel('finance', { edit: editing('policy') }) } },
    { id: 'follows-group', label: 'A company that follows the group’s policy (Give it its own settings)', model: { role: 'finance', page: pageModel('finance', { settings: { value: { ...SETTINGS, company: null, inForce: { ...SETTINGS.inForce, source: 'TENANT' } }, problem: null }, policy: { value: { ...POLICY, company: null, followsTenant: true, inForce: { windowDays: 30, goodsDueDays: 15, freightPaidBy: 'BY_CAUSE', restockingFeePct: '10', conditions: POLICY.tenant!.conditions } }, problem: null } }) } },
    { id: 'sales', label: 'Sales: reads; changing is held with its reason', model: { role: 'sales', page: pageModel('sales') } },
    { id: 'read-only', label: 'Read-only: values as text with why; no margin floor without the margin right', model: { role: 'readOnly', page: pageModel('readOnly') } },
    { id: 'no-permission', label: 'No permission: which one and who grants it', model: { role: 'none', page: pageModel('none') } },
    { id: 'loading', label: 'Loading', model: { role: 'finance', page: pageModel('finance', { settings: { value: null, problem: null }, policy: { value: null, problem: null }, series: { value: null, problem: null }, asOf: null, live: 'connecting' }) } },
    { id: 'error', label: "Couldn't load (Try again on each card)", model: { role: 'finance', page: pageModel('finance', { settings: { value: null, problem: 'quality:problem.unavailable' }, policy: { value: null, problem: 'quality:problem.unavailable' }, series: { value: null, problem: 'quality:problem.unavailable' }, live: 'offline' }) } },
    { id: 'offline', label: 'Offline: Apply held', model: { role: 'finance', page: pageModel('finance', { offline: true, live: 'offline' }) } },
    { id: 'changed', label: 'Changed by someone else · Reload; a receipt', model: { role: 'finance', page: pageModel('finance', { changedAt: NOW, receipt: { tone: 'success', words: { key: 'done.policy' } } }) } },
  ],
})
