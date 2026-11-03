import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { APPOINTMENTS, ENDED, inSafetyShell, NOW, organisation, SCOPE_ALL, TODAY, type SafetyRoleDemo } from '../_demo/fixtures'
import { OrganisationPrintView, type OrganisationPrintModel } from './view/OrganisationPrintView'

/**
 * SCR-267-org-print — the safety organisation chart for the notice board (design new tab "Organisation chart (print)"),
 * made-up data: per company and site, each role with its holder; an outside contact with its organisation, e-mail and
 * phone; the roles nobody holds.
 */

interface OrgPrintCase {
  role: SafetyRoleDemo
  model: OrganisationPrintModel
}

const model = (over: Partial<OrganisationPrintModel> = {}, role: SafetyRoleDemo = 'safety'): OrgPrintCase => ({
  role,
  model: { person: DEMO_USER.displayName, at: NOW, company: 'Officina Demo S.r.l.', site: 'Stabilimento Demo Nord', today: TODAY, canView: true, organisation: { value: organisation({ appointments: [...APPOINTMENTS, ENDED] }), problem: null }, ...over },
})

function OrgPrintDesign({ model: value }: { model: OrgPrintCase }) {
  return inSafetyShell('/plant/calendar/organisation', createElement(OrganisationPrintView, { model: value.model }), value.role, value.model.site ? undefined : SCOPE_ALL)
}

export const designScreen = defineDesignScreen<OrgPrintCase>({
  screen: 'SCR-267-org-print',
  title: 'Safety calendar: organisation chart (print)',
  view: OrgPrintDesign,
  cases: [
    { id: 'chart', label: 'The chart', model: model(), note: 'Only the terms in force today (the ended ASPP is left out); the employees appear without any private contact.' },
    { id: 'all-sites', label: 'All sites', model: model({ site: null }) },
    { id: 'loading', label: 'Loading (Print held)', model: model({ organisation: { value: null, problem: null } }) },
    { id: 'error', label: 'The read failed', model: model({ organisation: { value: null, problem: 'problem.read' } }) },
    { id: 'no-permission', label: 'Sales: no safety.view', model: model({ canView: false, organisation: { value: null, problem: null } }, 'sales') },
  ],
})
