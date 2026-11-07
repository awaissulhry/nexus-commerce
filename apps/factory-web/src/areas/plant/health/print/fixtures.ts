import { createElement } from 'react'
import { PROTECTED_HEALTH_LAW } from '@nexus/factory-domain/safety/health/rules'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { inHealthShell, LATER_VISIT, NOW, PRINT_ROWS, SCOPE_ALL, type HealthRoleDemo } from '../_demo/fixtures'
import type { VisitListPrintModel } from '../view-model'
import { VisitListPrintView } from './view/VisitListPrintView'

/**
 * SCR-212-visits — the visit list for the occupational doctor (design tab:visit-list "Visit list for the doctor (print)": names,
 * roles, visit type, risks; no judgements), made-up data only.
 */

interface PrintCase {
  role: HealthRoleDemo
  model: VisitListPrintModel
}

const model = (over: Partial<VisitListPrintModel> = {}, role: HealthRoleDemo = 'hr'): PrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', allSites: false, chosen: 0, canView: true, list: { rows: PRINT_ROWS, problem: null, law: PROTECTED_HEALTH_LAW }, ...over },
})

function PrintDesign({ model: value }: { model: PrintCase }) {
  return inHealthShell('/plant/health/print', createElement(VisitListPrintView, { model: value.model }), value.role, value.model.allSites ? SCOPE_ALL : undefined)
}

export const designScreen = defineDesignScreen<PrintCase>({
  screen: 'SCR-212-visits',
  title: 'Health surveillance: the visit list for the doctor (print)',
  view: PrintDesign,
  cases: [
    { id: 'list', label: 'Every open visit of the site: names, roles, types, due, booked, risks', model: model(), note: 'Never a judgement, an outcome, a limit or an absence\'s reason. The opening is recorded (a PRINT view).' },
    { id: 'chosen', label: 'The chosen visits only', model: model({ chosen: 2, list: { rows: PRINT_ROWS.slice(0, 2), problem: null, law: PROTECTED_HEALTH_LAW } }) },
    { id: 'all-sites', label: 'All sites: each row says its site', model: model({ site: null, allSites: true, list: { rows: [...PRINT_ROWS, { ...LATER_VISIT, risks: [] }], problem: null, law: PROTECTED_HEALTH_LAW } }) },
    { id: 'empty', label: 'Nothing to visit', model: model({ list: { rows: [], problem: null, law: PROTECTED_HEALTH_LAW } }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ list: { rows: null, problem: null, law: null } }) },
    { id: 'error', label: 'The read failed', model: model({ list: { rows: null, problem: 'problem.read', law: null } }) },
    { id: 'no-permission', label: 'Safety officer: no access to person-level health data', model: model({ canView: false, list: { rows: null, problem: null, law: null } }, 'safety') },
  ],
})
