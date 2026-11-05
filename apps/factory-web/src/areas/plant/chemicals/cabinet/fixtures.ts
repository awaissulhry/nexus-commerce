import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { CABINET_SHEET, inChemicalsShell, NOW, ORIGIN, type ChemicalRoleDemo } from '../_demo/fixtures'
import { CabinetTabView, type CabinetTabModel } from './view/CabinetTabView'

/** SCR-213-cabinet — a cabinet's sheet for the wall, with its QR (design plant.chemicals/tab:cabinet). Made-up data. */

interface CabinetCase {
  role: ChemicalRoleDemo
  model: CabinetTabModel
}

const model = (over: Partial<CabinetTabModel> = {}): CabinetTabModel => ({ canView: true, person: 'Anna Esempio', at: NOW, origin: ORIGIN, cabinet: { value: CABINET_SHEET, problem: null }, ...over })

function CabinetDesign({ model: entry }: { model: CabinetCase }) {
  return inChemicalsShell('/plant/chemicals/cabinet', createElement(CabinetTabView, { model: entry.model }), entry.role)
}

export const designScreen = defineDesignScreen<CabinetCase>({
  screen: 'SCR-213-cabinet',
  title: 'Chemicals & waste › Cabinet sheet (print), new tab',
  view: CabinetDesign,
  cases: [
    { id: 'normal', label: 'The cabinet sheet with its QR and products', model: { role: 'safety', model: model() }, note: 'The QR holds https://factory.example.com/floor/sds?cabinet=CAB-TAG-1; Print is not printed.' },
    { id: 'loading', label: 'Reading', model: { role: 'safety', model: model({ cabinet: { value: null, problem: null } }) } },
    { id: 'error', label: 'Not found: said in words', model: { role: 'safety', model: model({ cabinet: { value: null, problem: 'problem.notFound' } }) } },
    { id: 'no-permission', label: 'Sales: no safety.view', model: { role: 'sales', model: model({ canView: false }) } },
  ],
})
