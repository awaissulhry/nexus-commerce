import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { CUTTER, inRiskShell, NOW, sheetsAnswer, type RiskRoleDemo } from '../_demo/fixtures'
import { RoleSheetsPrintView, type RoleSheetsPrintModel } from './view/RoleSheetsPrintView'

/** SCR-209-role-sheet — "Role sheet (print)", given to the worker at induction (design plant.risk/tab:role-sheet). Made-up data. */

interface SheetPrintCase {
  role: RiskRoleDemo
  model: RoleSheetsPrintModel
}

const machinist = { ...CUTTER, id: 'demo-machinist', code: 'CUC', name: 'Cucitrice', nameI18n: { it: 'Cucitrice', en: 'Machinist' }, description: null, items: CUTTER.items.slice(0, 1), kit: CUTTER.kit.slice(2), requirements: CUTTER.requirements.slice(0, 1), plan: { needed: false, frequencyMonths: null, endOfEmploymentVisit: false, setOn: null } }
const model = (over: Partial<RoleSheetsPrintModel> = {}, role: RiskRoleDemo = 'safety'): SheetPrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', canView: true, sheets: [CUTTER, machinist], law: sheetsAnswer().law, problem: null, ...over },
})

function SheetPrintDesign({ model: value }: { model: SheetPrintCase }) {
  return inRiskShell('/plant/risk/role-sheets', createElement(RoleSheetsPrintView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<SheetPrintCase>({
  screen: 'SCR-209-role-sheet',
  title: 'Risk assessment › Role sheet (print), new tab',
  view: SheetPrintDesign,
  cases: [
    { id: 'two', label: 'Two roles, one page each, with the lines the worker signs', model: model() },
    { id: 'one', label: 'One role', model: model({ sheets: [CUTTER] }) },
    { id: 'loading', label: 'Reading (Print held)', model: model({ sheets: null }) },
    { id: 'error', label: 'The read failed', model: model({ sheets: null, problem: 'problem.read' }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ canView: false, sheets: null }, 'sales') },
  ],
})
