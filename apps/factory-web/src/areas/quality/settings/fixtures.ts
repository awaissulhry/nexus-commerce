import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, NOW, ROLE_PERMISSIONS, type RoleCase } from '../_shared/fixtures'
import { STEP_UP_CLOSED } from '../_shared/hooks'
import type { AlertRules, Rules } from './api'
import { ALERTS, ALERTS_EMPTY, ALERTS_READ_ONLY, ALERTS_STARTER, BROKEN_SEPARATIONS, COMPANY_FRESH, COMPANY_RULES, CUSTOMERS, RULES_FOR_COMPANY, TENANT_RULES } from './demo'
import { dutiesDraftOf, dutiesLooseningsOf, removedCustomers, resultsDraftOf, ruleDraftOf, withEvent, type Address, type DutiesDraft, type ResultsDraft, type RuleDraft } from './model'
import { RulesView, type RulesModel } from './view/RulesView'

/**
 * SCR-260 Quality › Settings › Quality rules — made-up data only (DEMO-… codes). Each case is a state the Owner reviews:
 * this company and every company, a company that never saved, the duties card changed (tighter: no code; looser: the
 * warning, the confirm in words with the reason, the code), saving, saved, a change elsewhere, the result rules (a wrong
 * undo window held), custom roles that break a separation, a station-only site, the alert rules (selected, suggested rules
 * missing, none yet, the rule dialog new / edit / with problems / a certificate rule, remove, a test sent), the role cases,
 * loading, a card that failed, offline, the keys. In the browser the scope, the cards and the dialogs work (the wrapper
 * keeps them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: RulesModel
}

const sees = (role: RoleCase) => (ROLE_PERMISSIONS[role] as readonly string[]).includes('quality.rules.view')
const changes = (role: RoleCase) => (ROLE_PERMISSIONS[role] as readonly string[]).includes('quality.settings.manage')

const address = (over: Partial<Address> = {}): Address => ({ scope: 'company', rule: null, ...over })

function page(over: Partial<RulesModel> = {}, role: RoleCase = 'owner'): DesignModel {
  const rules: Rules = { ...(over.address?.scope === 'all' ? TENANT_RULES : COMPANY_RULES), mayChange: changes(role) }
  const alerts: AlertRules = role === 'owner' || role === 'inspector' ? ALERTS : ALERTS_READ_ONLY
  return {
    role,
    model: {
      prefix: '/w/DEMO',
      address: address(),
      companyName: 'Demo Factory Srl',
      canView: sees(role),
      rules: { value: rules, problem: null },
      tenant: { value: { ...TENANT_RULES, mayChange: changes(role) }, problem: null },
      alerts: { value: alerts, problem: null },
      duties: dutiesDraftOf(rules),
      results: resultsDraftOf(rules),
      customers: null,
      canPickCustomers: true,
      busy: null,
      selected: [],
      notice: null,
      loosen: null,
      ruleDialog: null,
      remove: null,
      stepUp: STEP_UP_CLOSED,
      live: 'live',
      asOf: NOW,
      changedElsewhere: false,
      keysOpen: false,
      ...over,
    },
  }
}

const allScope = (over: Partial<RulesModel> = {}, role: RoleCase = 'owner') => page({ address: address({ scope: 'all' }), rules: { value: TENANT_RULES, problem: null }, duties: dutiesDraftOf(TENANT_RULES), results: resultsDraftOf(TENANT_RULES), ...over }, role)

const COMPANY_DRAFT = dutiesDraftOf(COMPANY_RULES)
/** Tighter: every release needs a second person (no code asked). */
const TIGHTER: DutiesDraft = { ...COMPANY_DRAFT, releaseFourEyes: 'ALWAYS' }
/** Looser, every company: overrides alone, the placer releases, a customer off the list. */
const TENANT_DRAFT = dutiesDraftOf(TENANT_RULES)
const LOOSER: DutiesDraft = { ...TENANT_DRAFT, conditions: ['CUSTOMER'], customers: [], placerMayRelease: true }
const looseCodes = dutiesLooseningsOf(TENANT_RULES, TENANT_RULES, LOOSER)
const RESULTS_BAD: ResultsDraft = { ...resultsDraftOf(COMPANY_RULES), benchUndoSeconds: 400 }
const RESULTS_STOP: ResultsDraft = { ...resultsDraftOf(COMPANY_RULES), stopAtRejectNumber: true }

const ruleOf = (index: number) => RULES_FOR_COMPANY[index]!
const dialog = (draft: RuleDraft, shown = false, problem: string | null = null): RulesModel['ruleDialog'] => ({ draft, problem, shown })
const NEW_RULE = ruleDraftOf(null, { companyId: null, roleId: null })
const CERT_RULE = withEvent(NEW_RULE, 'CERTIFICATE_EXPIRING', ALERTS.roles[0]!.id)

function RulesDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<RulesModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<RulesModel>) => setCurrent((model) => ({ ...model, ...change }))
  return inShell(
    '/quality/settings',
    createElement(RulesView, {
      model: current,
      actions: {
        onScope: (scope) => (scope === 'all' ? setCurrent(allScope({}, design.role).model) : setCurrent(page({}, design.role).model)),
        onDuties: (duties) => set({ duties }),
        onDiscardDuties: () => current.rules.value && set({ duties: dutiesDraftOf(current.rules.value) }),
        onApplyDuties: () => {
          if (!current.rules.value || !current.duties) return
          const codes = dutiesLooseningsOf(current.rules.value, current.tenant.value, current.duties)
          set(codes.length > 0 ? { loosen: { reason: '', codes, removed: removedCustomers(current.rules.value, current.duties) } } : { notice: { key: 'done.duties', tone: 'success' }, duties: dutiesDraftOf(current.rules.value) })
        },
        onLoosenReason: (reason) => current.loosen && set({ loosen: { ...current.loosen, reason } }),
        onLoosenConfirm: () => set({ loosen: null, stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: null } }),
        onLoosenCancel: () => set({ loosen: null }),
        onStepUpCancel: () => set({ stepUp: STEP_UP_CLOSED }),
        onResults: (results) => set({ results }),
        onDiscardResults: () => current.rules.value && set({ results: resultsDraftOf(current.rules.value) }),
        onPickCustomers: () => set({ customers: { value: CUSTOMERS, problem: null } }),
        onSelect: (ids) => set({ selected: [...ids] }),
        onRuleOpen: (id) => set({ ruleDialog: dialog(ruleDraftOf(id === 'new' ? null : (current.alerts.value?.rules.find((entry) => entry.id === id) ?? null), { companyId: null, roleId: null })) }),
        onRuleDraft: (draft) => current.ruleDialog && set({ ruleDialog: { ...current.ruleDialog, draft } }),
        onRuleClose: () => set({ ruleDialog: null }),
        onRuleRemove: (ids) => set({ remove: { ids: [...ids] } }),
        onCancelRemove: () => set({ remove: null }),
        onKeys: () => set({ keysOpen: true }),
        onKeysClose: () => set({ keysOpen: false }),
        onDismissNotice: () => set({ notice: null }),
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-260',
  title: 'Quality rules',
  view: RulesDesign,
  cases: [
    { id: 'company', label: 'Owner, this company: who may sign what (own and inherited), result rules, the fixed rules, the alert rules', model: page(), note: 'The company lists one more customer and lets the placer release; everything else as for every company.' },
    { id: 'all', label: 'Every company: the rules a company follows when it keeps none of its own', model: allScope() },
    { id: 'company-fresh', label: 'A company that never saved its own rules (everything inherited)', model: page({ rules: { value: COMPANY_FRESH, problem: null }, duties: dutiesDraftOf(COMPANY_FRESH), results: resultsDraftOf(COMPANY_FRESH) }) },
    { id: 'tighter', label: 'Changed, tighter: every release needs a second person (Save, no code)', model: page({ duties: TIGHTER }) },
    { id: 'looser', label: 'Changed, looser (every company): what it loosens, said before Save', model: allScope({ duties: LOOSER }) },
    { id: 'loosen-confirm', label: 'Confirm a looser rule: each loosening from now on, the reason (empty: Apply held)', model: allScope({ duties: LOOSER, loosen: { reason: '', codes: looseCodes, removed: 1 } }) },
    { id: 'loosen-reason', label: 'Confirm a looser rule with the reason typed', model: allScope({ duties: LOOSER, loosen: { reason: 'One quality person on the night shift', codes: looseCodes, removed: 1 } }) },
    { id: 'step-up', label: 'The fresh code for the looser rule', model: allScope({ duties: LOOSER, stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: null } }) },
    { id: 'step-up-wrong', label: 'The code refused', model: allScope({ duties: LOOSER, stepUp: { open: true, busy: false, sentence: 'stepUp.loosen', problem: 'stepUp.problem.wrong' } }) },
    { id: 'saving', label: 'Saving (the bar busy, every change held)', model: page({ duties: TIGHTER, busy: 'duties' }) },
    { id: 'saved', label: 'Saved: the looser rule with its reason', model: page({ notice: { key: 'done.dutiesLoosened', tone: 'success' } }) },
    { id: 'stale', label: 'Refused: someone changed the rules meanwhile (read again)', model: page({ notice: { key: 'problem.stale', tone: 'danger' } }) },
    { id: 'changed-elsewhere', label: 'Live: changed on another screen while this one holds a change', model: page({ duties: TIGHTER, changedElsewhere: true }) },
    { id: 'customers', label: 'Add a customer to the list (the customers read)', model: page({ customers: { value: CUSTOMERS, problem: null } }) },
    { id: 'results-stop', label: 'Result rules changed: stop at the reject number', model: page({ results: RESULTS_STOP }) },
    { id: 'results-problem', label: 'Result rules: an undo window of 400 s held with why', model: page({ results: RESULTS_BAD }) },
    { id: 'separations-broken', label: 'Two custom roles break a separation (named, with where to fix them)', model: page({ rules: { value: BROKEN_SEPARATIONS, problem: null } }) },
    { id: 'alerts-selected', label: 'Alert rules: two ticked (Switch on held: both on · Switch off 2 · Remove 2)', model: page({ selected: [ruleOf(2).id, ruleOf(4).id] }) },
    { id: 'alerts-starter', label: 'Alert rules: 2 suggested rules missing', model: page({ alerts: { value: ALERTS_STARTER, problem: null } }) },
    { id: 'alerts-empty', label: 'Alert rules: none yet (start from the suggested ones)', model: page({ alerts: { value: ALERTS_EMPTY, problem: null } }) },
    { id: 'rule-new', label: 'Add rule: when, for, who, how fast, the e-mail, the sentence as typed', model: page({ ruleDialog: dialog(NEW_RULE) }) },
    { id: 'rule-edit', label: 'Edit a rule: the event and the company fixed', model: page({ ruleDialog: dialog(ruleDraftOf(ruleOf(4), { companyId: null, roleId: null })) }) },
    { id: 'rule-problems', label: 'A rule with problems at its fields (no role, a wait too long)', model: page({ ruleDialog: dialog({ ...NEW_RULE, event: 'CRITICAL_NCR', audience: 'ROLE', roleId: null, wait: '45', unit: 'days' }, true) }) },
    { id: 'rule-certificate', label: 'A certificate rule: a role, days before the date', model: page({ ruleDialog: dialog(CERT_RULE) }) },
    { id: 'rule-refused', label: 'A rule refused by the API (changed meanwhile)', model: page({ ruleDialog: dialog(ruleDraftOf(ruleOf(2), { companyId: null, roleId: null }), true, 'problem.stale') }) },
    { id: 'remove', label: 'Remove 2 rules (the audit trail keeps them)', model: page({ selected: [ruleOf(2).id, ruleOf(4).id], remove: { ids: [ruleOf(2).id, ruleOf(4).id] } }) },
    { id: 'tested', label: 'A test sent to my bell', model: page({ notice: { key: 'done.tested', tone: 'success' } }) },
    { id: 'inspector', label: 'Quality inspector: reads who may sign what (held with why), keeps the alert rules', model: page({}, 'inspector') },
    { id: 'production', label: 'Production manager: reads everything, changes nothing', model: page({}, 'production') },
    { id: 'supervisor', label: 'Floor supervisor: reads everything, changes nothing', model: page({}, 'supervisor') },
    { id: 'no-permission', label: 'Sales: no permission (which permission, who grants it)', model: page({}, 'sales') },
    { id: 'loading', label: 'Loading (each card its skeleton)', model: page({ rules: { value: null, problem: null }, tenant: { value: null, problem: null }, alerts: { value: null, problem: null }, duties: null, results: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The rules could not be read (the alert rules still work)', model: page({ rules: { value: null, problem: 'problem.offline' }, duties: null, results: null }) },
    { id: 'alerts-error', label: 'The alert rules could not be read (the cards still work)', model: page({ alerts: { value: null, problem: 'problem.read' } }) },
    { id: 'offline', label: 'Offline: the last copy, every change held', model: page({ live: 'offline' }) },
    { id: 'keys', label: 'The keys', model: page({ keysOpen: true }) },
  ],
})
