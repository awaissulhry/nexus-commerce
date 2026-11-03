import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inPreventiveShell, NOW, RESULTS, SCOPE_ALL, SCOPE_ONE, type PreventiveRoleDemo } from '../_demo/fixtures'
import { RegisterPrintView, type RegisterPrintModel } from './view/RegisterPrintView'

/**
 * SCR-266-register-print — the check register for an inspector (design new tab "Check register (print)"), made-up data:
 * the last three years by machine and day, with the reports on file or missing.
 */

interface PrintCase {
  role: PreventiveRoleDemo
  model: RegisterPrintModel
}

const north = RESULTS.filter((result) => result.site.id === SCOPE_ONE.site?.id)

const model = (over: Partial<RegisterPrintModel> = {}, role: PreventiveRoleDemo = 'maintenance'): PrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', allSites: false, window: { from: '2023-11-04', to: '2026-11-03' }, chosen: null, canView: true, results: { value: north, problem: null, truncated: false }, ...over },
})

function PrintDesign({ model: value }: { model: PrintCase }) {
  return inPreventiveShell('/plant/preventive/register', createElement(RegisterPrintView, { model: value.model }), value.role, value.model.allSites ? SCOPE_ALL : SCOPE_ONE)
}

export const designScreen = defineDesignScreen<PrintCase>({
  screen: 'SCR-266-register-print',
  title: 'Preventive & statutory checks: check register (print)',
  view: PrintDesign,
  cases: [
    { id: 'three-years', label: 'The last three years, by machine', model: model(), note: 'The period in the strip (held past three years); each machine’s checks by day, the report on file or "Missing", the correction named.' },
    { id: 'chosen', label: 'Print N: the results chosen', model: model({ chosen: 2, window: { from: '2026-09-28', to: '2026-10-30' }, results: { value: north.slice(0, 2), problem: null, truncated: false } }) },
    { id: 'all-sites', label: 'All sites: each check says its site', model: model({ site: null, allSites: true, results: { value: RESULTS, problem: null, truncated: false } }) },
    { id: 'truncated', label: 'More results than one paper', model: model({ results: { value: north, problem: null, truncated: true } }) },
    { id: 'empty', label: 'No result in the period', model: model({ window: { from: '2020-01-01', to: '2020-12-31' }, results: { value: [], problem: null, truncated: false } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ results: { value: null, problem: null, truncated: false } }) },
    { id: 'error', label: 'The read failed', model: model({ results: { value: null, problem: 'problem.read', truncated: false } }) },
    { id: 'no-permission', label: 'Sales: no plant.view', model: model({ canView: false, results: { value: null, problem: null, truncated: false } }, 'sales') },
  ],
})
