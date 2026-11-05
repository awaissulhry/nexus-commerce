import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inIncidentShell, NOW, ROW_SUD, ROWS, SCOPE_ALL, type IncidentRoleDemo } from '../_demo/fixtures'
import { EMPTY_ADDRESS } from '../model'
import { IncidentsPrintView, type IncidentsPrintModel } from './view/IncidentsPrintView'

/**
 * SCR-210-print — the incident list for the safety meeting (design tab:print "Incident list (anonymised print)"), made-up data:
 * no person, no injury, no filing's type on the paper.
 */

interface PrintCase {
  role: IncidentRoleDemo
  model: IncidentsPrintModel
}

const model = (over: Partial<IncidentsPrintModel> = {}, role: IncidentRoleDemo = 'safety'): PrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', allSites: false, address: EMPTY_ADDRESS, canView: true, list: { rows: ROWS, problem: null, more: false }, ...over },
})

function PrintDesign({ model: value }: { model: PrintCase }) {
  return inIncidentShell('/plant/incidents/print', createElement(IncidentsPrintView, { model: value.model }), value.role, value.model.allSites ? SCOPE_ALL : undefined)
}

export const designScreen = defineDesignScreen<PrintCase>({
  screen: 'SCR-210-print',
  title: 'Incidents: the anonymised list (print)',
  view: PrintDesign,
  cases: [
    { id: 'list', label: 'The list as filtered, anonymised', model: model(), note: 'Number, kind, when, where, machine, severity, INAIL state, status, open actions: never a person.' },
    { id: 'filtered', label: 'Filtered: injuries, open', model: model({ address: { ...EMPTY_ADDRESS, rows: 'INJURY', status: 'OPEN' }, list: { rows: ROWS.filter((row) => row.kind === 'INJURY'), problem: null, more: false } }) },
    { id: 'all-sites', label: 'All sites: each row says its site', model: model({ site: null, allSites: true, list: { rows: [...ROWS, ROW_SUD], problem: null, more: false } }) },
    { id: 'more', label: 'More than the paper takes', model: model({ list: { rows: ROWS, problem: null, more: true } }), note: 'The first 200 are printed; the rest is said.' },
    { id: 'empty', label: 'Nothing to print', model: model({ list: { rows: [], problem: null, more: false } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ list: { rows: null, problem: null, more: false } }) },
    { id: 'error', label: 'The read failed', model: model({ list: { rows: null, problem: 'problem.read', more: false } }) },
    { id: 'no-permission', label: 'Sales: no safety.incidents.view', model: model({ canView: false, list: { rows: null, problem: null, more: false } }, 'sales') },
  ],
})
