import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { DONE_MEASURE, inRiskShell, MEASURES, NOW, SITE_S, SOUTH, withoutCost, type RiskRoleDemo } from '../_demo/fixtures'
import { PlanPrintView, type PlanPrintModel } from './view/PlanPrintView'

/** SCR-209-plan-print — "Improvement plan (print)", for the periodic safety meeting (design plant.risk/tab:plan-print). Made-up data. */

interface PlanPrintCase {
  role: RiskRoleDemo
  model: PlanPrintModel
}

const model = (over: Partial<PlanPrintModel> = {}, role: RiskRoleDemo = 'safety'): PlanPrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', canView: true, seesCost: false, view: 'open', measures: withoutCost(MEASURES), problem: null, ...over },
})

const south = { ...MEASURES[2]!, id: 'south-print', assessmentId: SOUTH.id, assessment: SOUTH.name, siteId: SITE_S.id, site: { code: SITE_S.code, name: SITE_S.name } }

function PlanPrintDesign({ model: value }: { model: PlanPrintCase }) {
  return inRiskShell('/plant/risk/plan', createElement(PlanPrintView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<PlanPrintCase>({
  screen: 'SCR-209-plan-print',
  title: 'Risk assessment › Improvement plan (print), new tab',
  view: PlanPrintDesign,
  cases: [
    { id: 'open', label: 'The open measures of one site', model: model() },
    { id: 'cost', label: 'With the cost grain: the cost column', model: model({ seesCost: true, measures: [...MEASURES], view: 'all' }, 'safetyCost') },
    { id: 'all-sites', label: 'Two assessments: one section each', model: model({ site: null, measures: [...withoutCost(MEASURES), south, DONE_MEASURE], view: 'all' }) },
    { id: 'empty', label: 'Nothing in the view', model: model({ measures: [] }) },
    { id: 'loading', label: 'Reading (Print held)', model: model({ measures: null }) },
    { id: 'error', label: 'The read failed', model: model({ measures: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ canView: false, measures: null }, 'sales') },
  ],
})
