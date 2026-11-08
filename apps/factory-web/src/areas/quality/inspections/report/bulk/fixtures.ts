import { createElement } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { demoPdf } from '../../../../../shell/design-data'
import { uid, type RoleCase } from '../../../_shared/fixtures'
import { inDepthShell } from '../../depth/demo/fixtures'
import { InspectionReportsView, type ReportsModel } from '../view/InspectionReportsView'

/** SCR-076-reports — Print N reports (design qi-grid selection row "Print 6 reports" (W2b), a new tab), made-up data. */

interface ReportsCase {
  readonly role: RoleCase
  readonly model: ReportsModel
}

const report = (n: number, over: Partial<ReportsModel['reports'][number]> = {}) => ({ id: uid('7701', n), number: `DEMO-INS-${String(n).padStart(4, '0')}`, pdf: demoPdf([`Rapporto di ispezione DEMO-INS-${String(n).padStart(4, '0')}`]), problem: null, ...over })
const model = (reports: ReportsModel['reports'], over: Partial<ReportsModel> = {}, role: RoleCase = 'owner'): ReportsCase => ({ role, model: { allowed: true, language: 'it', reports, ...over } })

function ReportsDesign({ model: value }: { model: ReportsCase }) {
  return inDepthShell('/quality/inspections/reports', createElement(InspectionReportsView, { model: value.model }), value.role)
}

export const designScreen = defineDesignScreen<ReportsCase>({
  screen: 'SCR-076-reports',
  title: 'Inspections: Print N reports',
  view: ReportsDesign,
  cases: [
    { id: 'three', label: 'Three reports read, Print all', model: model([report(10), report(6), report(4)]) },
    { id: 'reading', label: 'Still making two of them: Print all held with the reason', model: model([report(10), report(6, { pdf: null }), report(4, { pdf: null, number: null })]) },
    { id: 'one-failed', label: 'One report could not be made (Try again for it alone)', model: model([report(10), report(6, { pdf: null, problem: 'problem.unavailable' })]) },
    { id: 'english', label: 'In English', model: model([report(10, { pdf: demoPdf(['Inspection report DEMO-INS-0010']) })], { language: 'en' }) },
    { id: 'none', label: 'An address with no inspection', model: model([]) },
    { id: 'no-permission', label: 'Sales: no quality.inspections.view', model: model([], { allowed: false }, 'sales') },
  ],
})
