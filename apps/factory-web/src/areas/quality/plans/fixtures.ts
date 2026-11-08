import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { inShell, ROLE_PERMISSIONS, type RoleCase } from '../_shared/fixtures'
import { STEP_UP_CLOSED } from '../_shared/hooks'
import { failedRead, reading, ready } from '../_shared/model'
import { ASSIGNMENTS, calcPlan, NOW_ISO, PLAN_IDS, PLAN_ROWS, PLANS, PLANS_EMPTY, PREVIEW_WORDS, PROFILES, RULES_ANSWER, STARTER } from './demo/fixtures'
import { DEFAULT_ADDRESS, NEW_PLAN, newProfile, newRule, plansCan, profileDraftOf, ruleDraftOf, type PageTab, type PlansAddress } from './model'
import { PlansView, type PlansModel } from './view/PlansView'

/**
 * SCR-077 Quality › Settings › Inspection plans & AQL — made-up data only (DEMO-… codes). Each case is a state the Owner
 * reviews: the four tabs, New plan (blank, from the starter set, a copy, with problems), the AQL profiles changed (and
 * held with why), where a profile applies, the rules reordered and a rule's dialog with its preview, the calculator (lot
 * 480 at level II; arrows that give two samples; the whole lot), the role cases, loading, failed reads, offline, the keys.
 * In the browser the tabs, the drafts and the dialogs work (the wrapper keeps them).
 */

interface DesignModel {
  readonly role: RoleCase
  readonly model: PlansModel
}

const address = (over: Partial<PlansAddress> = {}): PlansAddress => ({ ...DEFAULT_ADDRESS, ...over })
const calcOf = (model: PlansModel): PlansModel['calc'] => {
  const ask = model.address.calc
  const profile = PROFILES.profiles.find((entry) => entry.id === ask.profile) ?? null
  return ready({ profile: profile ? { code: profile.code, name: profile.name } : null, plan: calcPlan(ask.lot, ask.level, ask.major, ask.minor) })
}

function page(over: Partial<PlansModel> = {}, role: RoleCase = 'owner'): DesignModel {
  const model: PlansModel = {
    prefix: '/w/DEMO',
    companyId: PLAN_ROWS[0]!.companyId,
    can: plansCan(ROLE_PERMISSIONS[role] as readonly string[]),
    address: address(),
    live: 'live',
    asOf: NOW_ISO,
    notice: null,
    plans: ready(PLANS),
    selected: [],
    starter: ready(STARTER.map((plan, index) => ({ ...plan, missing: index !== 0 && index !== 4 }))),
    newPlan: null,
    profiles: ready(PROFILES),
    profileDrafts: PROFILES.profiles.map(profileDraftOf),
    assignments: null,
    rules: ready(RULES_ANSWER),
    ruleDrafts: RULES_ANSWER.rules.map(ruleDraftOf),
    ruleDialog: null,
    chipSearch: null,
    calc: reading(),
    busy: null,
    stepUp: STEP_UP_CLOSED,
    keysOpen: false,
    ...over,
  }
  return { role, model: { ...model, calc: over.calc ?? (model.address.tab === 'calculator' ? calcOf(model) : model.calc) } }
}

const tab = (name: PageTab, over: Partial<PlansModel> = {}, role: RoleCase = 'owner') => page({ address: address({ tab: name, ...(over.address ?? {}) }), ...over }, role)

const DRAFTS = PROFILES.profiles.map(profileDraftOf)
const PROFILES_CHANGED = [{ ...DRAFTS[0]!, isDefault: false }, { ...DRAFTS[1]!, isDefault: true, minor: '4.0' }, DRAFTS[2]!, DRAFTS[3]!, { ...newProfile(1, false), code: 'AQL-GLOVES', name: 'Gloves, small lots', level: 'S3' as const, major: '4.0', minor: '6.5' }]
const PROFILES_BAD = [{ ...DRAFTS[0]!, active: false }, DRAFTS[1]!, DRAFTS[2]!, DRAFTS[3]!, { ...newProfile(2, false), code: 'aql gloves', name: '' }]
const RULE_DRAFTS = RULES_ANSWER.rules.map(ruleDraftOf)
const RULES_MOVED = [RULE_DRAFTS[1]!, RULE_DRAFTS[0]!, { ...RULE_DRAFTS[2]!, active: true }]
const NEW_RULE = { ...newRule(1, 'GOODS_RECEIPT', PLAN_IDS.inc), chips: [{ kind: 'CATEGORY' as const, value: 'PROTECTOR', label: 'PROTECTOR' }] }

function PlansDesign({ model: design }: { model: DesignModel }) {
  const [current, setCurrent] = useState<PlansModel>(design.model)
  useEffect(() => setCurrent(design.model), [design])
  const set = (change: Partial<PlansModel>) => setCurrent((model) => ({ ...model, ...change }))
  const go = (next: PlansAddress) => setCurrent((model) => {
    const moved = { ...model, address: next }
    return { ...moved, calc: next.tab === 'calculator' ? calcOf(moved) : model.calc }
  })
  return inShell(
    '/quality/plans',
    createElement(PlansView, {
      model: current,
      actions: {
        onNewPlan: () => set({ newPlan: { draft: NEW_PLAN, shown: false, problem: null } }),
        onCopyPlan: (versionId) => set({ newPlan: { draft: { ...NEW_PLAN, start: 'COPY', copyVersionId: versionId }, shown: false, problem: null } }),
        onNewPlanDraft: (draft) => current.newPlan && set({ newPlan: { ...current.newPlan, draft } }),
        onNewPlanCreate: () => current.newPlan && set({ newPlan: { ...current.newPlan, shown: true } }),
        onNewPlanClose: () => set({ newPlan: null }),
        onSelect: (ids) => set({ selected: [...ids] }),
        onStage: (stage) => go({ ...current.address, stage }),
        onStatus: (status) => go({ ...current.address, status }),
        onClearFilters: () => go({ ...current.address, stage: '', status: '', q: '' }),
        onProfiles: (drafts) => set({ profileDrafts: drafts }),
        onAddProfile: () => set({ profileDrafts: [...(current.profileDrafts ?? []), newProfile(Date.now() % 1000, false)] }),
        onDiscardProfiles: () => set({ profileDrafts: DRAFTS }),
        onOpenAssignments: (profileId) => set({ assignments: { profileId, read: ready(ASSIGNMENTS.filter((entry) => entry.profileId === profileId)), customer: null, style: null, customers: null, styles: null, problem: null } }),
        onCloseAssignments: () => set({ assignments: null }),
        onRules: (drafts) => set({ ruleDrafts: drafts }),
        onDiscardRules: () => set({ ruleDrafts: RULE_DRAFTS }),
        onRuleOpen: (key) => set({ ruleDialog: { draft: key === 'new' ? NEW_RULE : (current.ruleDrafts ?? []).find((draft) => draft.key === key) ?? NEW_RULE, shown: false, preview: null } }),
        onRuleDraft: (draft) => current.ruleDialog && set({ ruleDialog: { ...current.ruleDialog, draft, preview: null } }),
        onRuleClose: () => set({ ruleDialog: null }),
        onRuleDone: () => {
          const dialog = current.ruleDialog
          if (!dialog) return
          const drafts = current.ruleDrafts ?? []
          set({ ruleDialog: null, ruleDrafts: drafts.some((draft) => draft.key === dialog.draft.key) ? drafts.map((draft) => (draft.key === dialog.draft.key ? dialog.draft : draft)) : [...drafts, dialog.draft] })
        },
        onRulePreview: () => current.ruleDialog && set({ ruleDialog: { ...current.ruleDialog, preview: ready(PREVIEW_WORDS) } }),
        onCalc: (ask) => go({ ...current.address, calc: ask }),
        onKeys: () => set({ keysOpen: true }),
        onKeysClose: () => set({ keysOpen: false }),
        onDismissNotice: () => set({ notice: null }),
      },
    }),
    design.role,
  )
}

export const designScreen = defineDesignScreen<DesignModel>({
  screen: 'SCR-077',
  title: 'Inspection plans & AQL',
  view: PlansDesign,
  cases: [
    { id: 'plans', label: 'Owner: the plans of every stage (one waits for approval)', model: page(), note: 'A row opens the plan record; ⋯ prints its checklist or copies it as a new plan.' },
    { id: 'plans-selected', label: 'Two plans ticked: Print 2 checklists · Export 2', model: page({ selected: [PLAN_IDS.inc, PLAN_IDS.fin] }) },
    { id: 'plans-filtered', label: 'Filtered by a stage with no match (Clear filters)', model: page({ address: address({ stage: 'RETURN', status: 'APPROVED' }), plans: ready({ ...PLANS, plans: [] }) }) },
    { id: 'plans-empty', label: 'No plans yet: New plan, or the leather-apparel starter set (6 plans)', model: page({ plans: ready(PLANS_EMPTY), starter: ready(STARTER) }) },
    { id: 'plans-starter-added', label: 'The starter set added as drafts (the receipt)', model: page({ notice: { key: 'done.starter', params: { count: 4 }, tone: 'success' } }) },
    { id: 'new-plan', label: 'New plan: blank (stage, start from, code, name, owner)', model: page({ newPlan: { draft: NEW_PLAN, shown: false, problem: null } }) },
    { id: 'new-plan-starter', label: 'New plan from the starter set (one of this stage, the code and name filled)', model: page({ newPlan: { draft: { ...NEW_PLAN, stage: 'CUTTING', start: 'STARTER', starterCode: 'CUT-PANELS', code: 'CUT-PANELS', name: 'Pezzi tagliati sul modello' }, shown: false, problem: null } }) },
    { id: 'new-plan-copy', label: 'New plan as a copy of DEMO-FIN-JACKET v1 (from the row’s Copy)', model: page({ newPlan: { draft: { ...NEW_PLAN, start: 'COPY', copyVersionId: PLAN_ROWS[4]!.approved!.id, code: 'DEMO-FIN-GILET', name: 'Final check, vest' }, shown: false, problem: null } }) },
    { id: 'new-plan-problems', label: 'New plan refused at its fields: a code taken, no name (Create held)', model: page({ newPlan: { draft: { ...NEW_PLAN, code: 'DEMO-FIN-JACKET', name: '' }, shown: true, problem: null } }) },
    { id: 'new-plan-refused', label: 'New plan refused by the API (the code was taken meanwhile)', model: page({ newPlan: { draft: { ...NEW_PLAN, code: 'DEMO-FIN-GLOVES', name: 'Final check, gloves' }, shown: true, problem: 'refusal.CODE_TAKEN' } }) },
    { id: 'aql', label: 'AQL profiles: the default, an export profile, one for a style of one customer, a retired one; critical locked with the law', model: tab('aql') },
    { id: 'aql-changed', label: 'AQL profiles changed: a new profile, the default moved, a minor AQL (Save 3 changes, ⌘S)', model: tab('aql', { profileDrafts: PROFILES_CHANGED }) },
    { id: 'aql-problems', label: 'AQL profiles held: the default retired, a code with spaces, no name (Save held with why)', model: tab('aql', { profileDrafts: PROFILES_BAD }) },
    { id: 'aql-where', label: 'Where AQL-EXM applies: its customer, End, assign to a customer or a style', model: tab('aql', { assignments: { profileId: PROFILES.profiles[1]!.id, read: ready(ASSIGNMENTS), customer: null, style: null, customers: null, styles: null, problem: null } }) },
    { id: 'aql-saved', label: 'AQL profiles saved (the receipt)', model: tab('aql', { notice: { key: 'done.profiles', params: { count: 3 }, tone: 'success' } }) },
    { id: 'triggers', label: 'When inspections are created: three rules in order, what each opened, why one skipped; packing and returns held in words', model: tab('triggers') },
    { id: 'triggers-moved', label: 'Rules reordered and one switched on (Save 2 changes)', model: tab('triggers', { ruleDrafts: RULES_MOVED }) },
    { id: 'rule-new', label: 'New rule: protectors received → DEMO-INC-LEATHER every lot, with the preview of last month', model: tab('triggers', { ruleDialog: { draft: NEW_RULE, shown: false, preview: ready(PREVIEW_WORDS) } }) },
    { id: 'rule-problems', label: 'A rule with problems: a plan with no approved version kept on, a share of 0% (Done held)', model: tab('triggers', { ruleDialog: { draft: { ...newRule(2, 'OPERATION_FINISHED', PLAN_IDS.cut), frequency: 'PERCENT_OF_OPERATIONS', frequencyValue: '' }, shown: true, preview: null } }) },
    { id: 'calculator', label: 'AQL calculator: lot 480 · general II → H → 50; critical locked', model: tab('calculator', { address: address({ tab: 'calculator', calc: { lot: 480, level: 'II', profile: null, major: '2.5', minor: '4.0' } }) }) },
    { id: 'calculator-arrows', label: 'Calculator: lot 50 with AQL-EXM — the arrows give two samples, the larger is inspected', model: tab('calculator', { address: address({ tab: 'calculator', calc: { lot: 50, level: 'II', profile: PROFILES.profiles[1]!.id, major: '1.5', minor: '2.5' } }) }) },
    { id: 'calculator-whole', label: 'Calculator: a lot of 6 at level II — the whole lot', model: tab('calculator', { address: address({ tab: 'calculator', calc: { lot: 6, level: 'II', profile: null, major: '0.65', minor: '1.0' } }) }) },
    { id: 'calculator-error', label: 'Calculator: the answer could not be read (Try again)', model: tab('calculator', { calc: failedRead('problem.unavailable') }) },
    { id: 'production', label: 'Production manager: reads plans, approves versions, reads profiles and rules, changes neither', model: page({}, 'production') },
    { id: 'supervisor', label: 'Floor supervisor: plans and rules read-only; AQL tabs say which permission they need', model: tab('aql', {}, 'supervisor') },
    { id: 'sales', label: 'Sales: only the AQL profiles and the calculator (the plans tab says why)', model: tab('aql', {}, 'sales') },
    { id: 'no-permission', label: 'Read-only role without the plans: which permission, who grants it', model: page({}, 'readOnly') },
    { id: 'loading', label: 'Loading (skeleton rows; each tab its skeleton)', model: page({ plans: reading(), profiles: reading(), profileDrafts: null, rules: reading(), ruleDrafts: null, asOf: null, live: 'connecting' }) },
    { id: 'error', label: 'The plans could not be read (Try again; the other tabs still work)', model: page({ plans: failedRead('problem.unavailable') }) },
    { id: 'aql-error', label: 'The AQL profiles could not be read', model: tab('aql', { profiles: failedRead('problem.unavailable'), profileDrafts: null }) },
    { id: 'offline', label: 'Offline: the last copy, New plan and every save held', model: tab('aql', { live: 'offline', profileDrafts: PROFILES_CHANGED }) },
    { id: 'keys', label: 'The keys', model: page({ keysOpen: true }) },
  ],
})
