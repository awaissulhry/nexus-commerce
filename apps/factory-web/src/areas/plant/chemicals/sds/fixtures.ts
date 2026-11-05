import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_PDF, GLUE, glueRecord, inChemicalsShell, type ChemicalRoleDemo } from '../_demo/fixtures'
import { SdsTabView, type SdsTabModel } from './view/SdsTabView'

/** SCR-213-sds — a sheet's PDF in its own tab (design plant.chemicals/tab:sds). Made-up data and a made-up one-page PDF. */

interface SdsCase {
  role: ChemicalRoleDemo
  model: SdsTabModel
}

const superseded = glueRecord().sheets.find((row) => row.status === 'SUPERSEDED')!
const ready = (over: Partial<SdsTabModel> = {}): SdsTabModel => ({ canView: true, chemical: GLUE, sheet: GLUE.current[0]!, pdf: { bytes: DEMO_PDF, fileName: GLUE.current[0]!.fileName }, problem: null, ...over })

function SdsDesign({ model }: { model: SdsCase }) {
  return inChemicalsShell('/plant/chemicals/sds', createElement(SdsTabView, { model: model.model }), model.role)
}

export const designScreen = defineDesignScreen<SdsCase>({
  screen: 'SCR-213-sds',
  title: 'Chemicals & waste › SDS (PDF), new tab',
  view: SdsDesign,
  cases: [
    { id: 'current', label: 'The current sheet', model: { role: 'safety', model: ready() } },
    { id: 'superseded', label: 'A superseded sheet: says to follow the current one', model: { role: 'safety', model: ready({ sheet: superseded, pdf: { bytes: DEMO_PDF, fileName: superseded.fileName } }) } },
    { id: 'loading', label: 'Reading', model: { role: 'safety', model: ready({ chemical: null, sheet: null, pdf: null }) } },
    { id: 'error', label: 'Failed: said in words', model: { role: 'safety', model: ready({ pdf: null, problem: 'problem.notFound' }) } },
    { id: 'no-permission', label: 'Sales: no safety.view', model: { role: 'sales', model: ready({ canView: false, chemical: null, sheet: null, pdf: null }) } },
  ],
})
