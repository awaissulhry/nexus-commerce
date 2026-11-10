import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { NOW, PREFIX, ROLE_PERMISSIONS, type RoleCase } from '../../../quality/_shared/fixtures'
import { failedRead, ready, reading } from '../../../quality/_shared/model'
import { demoPlans, demoRules, demoSubstances, demoVersions, LEATHER, LINING, MEMBRANE, PLANS, PROTECTOR, RULES, ZIP } from './_demo/fixtures'
import { SubstancesDesign, type SubstancesCase } from './_demo/designs/fixtures'
import { blankPlan, blankVersion, planDraftOf, substancesAddressOf, substancesCan, type SubstancesAddress } from './model'
import type { SubstancesViewModel } from './view-model'

/**
 * SCR-054-substances — Compliance › Tests & substances › Substance list, its rules and the test plan rules (B-W2b-267; design
 * compliance.tests sec:ts-rsl, page.h "Restricted substance list (W2b)" and "Test plan rules (W2b)"). The substances are public
 * law (REACH Annex XVII); everything else is made up. Cases: the list with the newest Candidate List, nothing yet (Load the
 * starter list), the starter's confirm, recording a Candidate List version, the rules with CMR and PFAS off and why (Owner
 * 11-09 Q5 A), switching a rule off (the reason) and on, the test plan rules, a new and an edited plan rule, loading, a failed
 * read, read-only and no permission.
 */

const TODAY = '2026-10-29'
const address = (over: Partial<SubstancesAddress> = {}): SubstancesAddress => ({ ...substancesAddressOf(null), ...over })
const MATERIALS = [LEATHER, LINING, ZIP, MEMBRANE, PROTECTOR]

function substancesModel(over: Partial<Omit<SubstancesViewModel, 'frame'>> = {}, role: RoleCase = 'owner'): SubstancesCase {
  return {
    role,
    model: {
      prefix: PREFIX,
      can: substancesCan([...ROLE_PERMISSIONS[role], 'imports.view']),
      online: true,
      today: TODAY,
      address: address(),
      substances: ready(demoSubstances()),
      rules: ready(demoRules()),
      versions: ready(demoVersions()),
      plans: ready(demoPlans()),
      materials: ready(MATERIALS),
      asOf: NOW,
      live: 'live',
      updates: 0,
      selected: [],
      notice: null,
      busy: false,
      switchDialog: null,
      planDialog: null,
      versionDraft: null,
      starterConfirm: false,
      keysOpen: false,
      dialogProblem: null,
      ...over,
    },
  }
}

const rules = address({ part: 'rules' })
const plans = address({ part: 'plans' })
const cmr = RULES.find((rule) => rule.code === 'CMR')!
const azo = RULES.find((rule) => rule.code === 'AZO')!

export const designScreen = defineDesignScreen<SubstancesCase>({
  screen: 'SCR-054-substances',
  title: 'Tests & substances › Substance list, rules and test plan rules',
  view: SubstancesDesign,
  cases: [
    { id: 'list', label: 'Substances with their limits, scope, method, source and Candidate List version', model: substancesModel(), note: 'Each limit is said in our words from its figure, unit and bound; an OFF rule is marked.' },
    { id: 'list-svhc', label: 'List ▾ SVHC Candidate List', model: substancesModel({ address: address({ list: 'SVHC' }), substances: ready(demoSubstances(demoSubstances().substances.filter((row) => row.lists.includes('SVHC')))) }) },
    { id: 'empty', label: 'Nothing yet: Load the starter list', model: substancesModel({ substances: ready(demoSubstances([])), versions: ready(demoVersions([])) }) },
    { id: 'starter', label: 'Load the starter list: what it adds; CMR and PFAS come in off', model: substancesModel({ substances: ready(demoSubstances([])), starterConfirm: true }) },
    { id: 'starter-done', label: 'The starter list loaded', model: substancesModel({ notice: { key: 'done.starter', params: { substances: 27, rules: 8 }, tone: 'success' } }) },
    { id: 'version', label: 'Record a Candidate List version', model: substancesModel({ address: address({ version: true }), versionDraft: { ...blankVersion(TODAY), entryCount: '256', sourceUrl: 'https://echa.europa.eu/candidate-list-table' } }) },
    { id: 'version-refused', label: 'A version of that day exists already (Record held with why)', model: substancesModel({ address: address({ version: true }), versionDraft: { ...blankVersion(TODAY), publishedOn: '2026-07-01', entryCount: '253' } }) },
    { id: 'rules', label: 'Rules: each with its law, proof and switch; CMR and PFAS off with why', model: substancesModel({ address: rules }) },
    { id: 'rule-off', label: 'Switch a rule off: the reason the next person reads', model: substancesModel({ address: { ...rules, switchId: azo.id }, switchDialog: { id: azo.id, kind: 'rule', reason: 'Lab method under review.' } }) },
    { id: 'rule-off-empty', label: 'Switch off held: no reason yet', model: substancesModel({ address: { ...rules, switchId: azo.id }, switchDialog: { id: azo.id, kind: 'rule', reason: '' } }) },
    { id: 'rule-on', label: 'Switch CMR on (it says what it was off for)', model: substancesModel({ address: { ...rules, switchId: cmr.id }, switchDialog: { id: cmr.id, kind: 'rule', reason: '' } }) },
    { id: 'plans', label: 'Test plan rules: how often each lot is tested; PFAS off with why', model: substancesModel({ address: plans }) },
    { id: 'plan-new', label: 'New test plan rule: a kind of material', model: substancesModel({ address: { ...plans, plan: 'new' }, planDialog: { id: 'new', draft: { ...blankPlan(), test: 'AZO', frequency: 'FIRST_LOT', method: 'EN ISO 17234-1' } } }) },
    { id: 'plan-new-material', label: 'New test plan rule: one material, off with its reason', model: substancesModel({ address: { ...plans, plan: 'new' }, planDialog: { id: 'new', draft: { ...blankPlan(), scope: 'MATERIAL', itemId: ZIP.id, test: 'NICKEL', switchedOn: false, offReason: 'Waits for the new zip supplier.' } } }) },
    { id: 'plan-edit', label: 'Edit a test plan rule', model: substancesModel({ address: { ...plans, plan: PLANS[1]!.id }, planDialog: { id: PLANS[1]!.id, draft: { ...planDraftOf(PLANS[1]!), frequency: 'EVERY_LOT' } } }) },
    { id: 'plan-refused', label: 'A plan rule refused (someone changed it meanwhile)', model: substancesModel({ address: { ...plans, plan: PLANS[1]!.id }, planDialog: { id: PLANS[1]!.id, draft: { ...planDraftOf(PLANS[1]!), frequency: 'EVERY_LOT' } }, dialogProblem: 'problem.plan.conflict' }) },
    { id: 'plans-empty', label: 'No test plan rules yet', model: substancesModel({ address: plans, plans: ready(demoPlans([])) }) },
    { id: 'selected', label: 'Selection: CSV of 2', model: substancesModel({ selected: demoSubstances().substances.slice(0, 2).map((row) => row.id) }) },
    { id: 'loading', label: 'Loading', model: substancesModel({ substances: reading(), versions: reading(), asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The API didn't answer", model: substancesModel({ substances: failedRead('problem.unavailable'), versions: failedRead('problem.unavailable'), asOf: null, live: 'offline' }) },
    { id: 'read-only', label: 'Read-only: reads every rule; the switches and New held with why', model: substancesModel({ address: rules }, 'readOnly') },
    { id: 'no-permission', label: 'Sales: no permission', model: substancesModel({}, 'sales') },
  ],
})
