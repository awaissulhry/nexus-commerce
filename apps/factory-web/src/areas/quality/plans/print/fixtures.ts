import { createElement, useEffect, useState } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { NOW, PREFIX } from '../../_shared/fixtures'
import { CHECKLIST_DRAFT_EN, CHECKLIST_IT, PLAN_IDS } from '../demo/fixtures'
import { PlanPrintView, type PlanPrintModel } from './view/PlanPrintView'

/**
 * SCR-077-print — the plans' checklists on paper (design tab:pl-print), made-up data only: one approved checklist in
 * Italian, a draft in English with sample columns (the "not in force" warning), two plans, still reading, one failed, no
 * plan asked, no permission. In the browser the language picker works on the made-up sheets.
 */

const model = (over: Partial<PlanPrintModel> = {}): PlanPrintModel => ({
  prefix: PREFIX,
  person: 'Alex Demo',
  at: NOW,
  company: 'Demo Factory Srl',
  can: true,
  sheets: [{ planId: PLAN_IDS.fin, checklist: CHECKLIST_IT, problem: null }],
  language: 'it',
  languages: ['it', 'en', 'ro'],
  nothing: false,
  ...over,
})

function PrintDesign({ model: given }: { model: PlanPrintModel }) {
  const [current, setCurrent] = useState(given)
  useEffect(() => setCurrent(given), [given])
  return createElement(PlanPrintView, {
    model: current,
    actions: { onLanguage: (language) => setCurrent((value) => ({ ...value, language, sheets: value.sheets.map((sheet) => (sheet.checklist ? { ...sheet, checklist: language === 'it' ? CHECKLIST_IT : { ...CHECKLIST_DRAFT_EN, notInForce: null, sampleColumns: 0 } } : sheet)) })) },
  })
}

export const designScreen = defineDesignScreen<PlanPrintModel>({
  screen: 'SCR-077-print',
  title: 'Inspection checklist (print)',
  view: PrintDesign,
  cases: [
    { id: 'one', label: 'DEMO-FIN-JACKET v1, in force, in Italian (the bench’s language picker)', model: model() },
    { id: 'draft', label: 'A draft in English: "not the one in force", 5 sample columns', model: model({ language: 'en', sheets: [{ planId: PLAN_IDS.fin, checklist: CHECKLIST_DRAFT_EN, problem: null }] }) },
    { id: 'several', label: 'Two plans picked on the list: one page each', model: model({ sheets: [{ planId: PLAN_IDS.fin, checklist: CHECKLIST_IT, problem: null }, { planId: PLAN_IDS.inc, checklist: { ...CHECKLIST_IT, title: 'DEMO-INC-LEATHER · Incoming leather, hide by hide' }, problem: null }] }) },
    { id: 'reading', label: 'Still reading (Print held with why)', model: model({ sheets: [{ planId: PLAN_IDS.fin, checklist: null, problem: null }] }) },
    { id: 'failed', label: 'One of two could not be read', model: model({ sheets: [{ planId: PLAN_IDS.fin, checklist: CHECKLIST_IT, problem: null }, { planId: PLAN_IDS.inc, checklist: null, problem: 'problem.unavailable' }] }) },
    { id: 'nothing', label: 'No plan asked (Print held)', model: model({ sheets: [], nothing: true }) },
    { id: 'no-permission', label: 'No permission to see plans', model: model({ can: false, sheets: [] }) },
  ],
})
