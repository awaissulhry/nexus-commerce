import { createElement, type ReactNode } from 'react'
import { defineDesignScreen } from '../../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../../shell/design-data'
import { ALL_RIGHTS, customerAccess, DEMO_NOW, DEMO_TODAY, READ_ONLY } from '../../../../sales/customers/portal/demo'
import { COMPANIES, inShell, panels, PREFIX, ROLES } from '../../../shared/fixtures'
import { loaded, STEP_UP_CLOSED } from '../../../shared/model'
import type { UserRecordModel } from '../../record/model'
import { UserRecordView } from '../../record/view/UserRecordView'
import { PARTNER_USERS } from '../fixtures'
import { PartnerOrganisationView, type PartnerOrganisationModel } from './view/PartnerOrganisationView'

/**
 * SCR-011-partner — User › Partner organisation › Organisation (B-W2b-180; design admin.users rec:User/partner/org): a
 * person of a partner organisation in their user record — Profile, Partner organisation (in place of Roles & scope),
 * Activity. Made-up people of a made-up customer.
 */

interface Case {
  record: UserRecordModel
  org: PartnerOrganisationModel
}

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const CAN = { suspend: true, reactivate: true, deactivate: true, resetPassword: true, assign: true }

function caseOf(index: number, over: Partial<PartnerOrganisationModel> = {}): Case {
  const user = PARTNER_USERS[index]!
  return {
    record: { prefix: PREFIX, tab: 'partner', user, me: DEMO_USER.id, assignments: loaded([]), roles: ROLES, companies, can: CAN, lastAdmin: false, stepUp: STEP_UP_CLOSED },
    org: { prefix: PREFIX, userId: user.id, access: customerAccess(), problem: null, can: ALL_RIGHTS, today: DEMO_TODAY, now: DEMO_NOW, busy: false, dialogProblem: null, notice: null, stepUp: STEP_UP_CLOSED, ...over },
  }
}

function PartnerDesign({ model }: { model: Case }): ReactNode {
  const person = model.record.user!
  return inShell(
    `/admin/users/${person.id}`,
    createElement(UserRecordView, { model: model.record, panels: panels({ type: 'User', id: person.id, companyId: null }, person.displayName), partner: createElement(PartnerOrganisationView, { model: model.org }) }),
  )
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-011-partner',
  title: 'User › Partner organisation',
  view: PartnerDesign,
  cases: [
    { id: 'buyer', label: 'Marco Prova, Buyer of Moda Demo (its admin: Giulia Esempio)', model: caseOf(1) },
    { id: 'ends-soon', label: 'Sara Demo: access ends soon', model: caseOf(2) },
    { id: 'admin', label: 'Giulia Esempio, the admin of Moda Demo', model: caseOf(0) },
    { id: 'invited', label: 'Paolo Campione, invited: the end applies to the invitation; Remove revokes it', model: caseOf(3) },
    { id: 'change-until', label: 'A new end date typed', model: caseOf(1, { until: '2026-12-31' }) },
    { id: 'remove', label: 'Remove from organisation (with a reason)', model: caseOf(1, { confirm: true }) },
    { id: 'saved', label: 'Receipt: the end of access is saved', model: caseOf(2, { notice: { key: 'done.until', tone: 'success', params: { name: 'Sara Demo' } } }) },
    { id: 'left', label: 'Luca Passato left (deactivated): nothing to change', model: caseOf(5) },
    { id: 'read-only', label: 'partners.view only: the changes held with the right they need', model: caseOf(1, { can: READ_ONLY }) },
    { id: 'step-up', label: 'A fresh code before the change', model: caseOf(1, { stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.person', problem: null } }) },
    { id: 'loading', label: 'Loading', model: caseOf(1, { access: null }) },
    { id: 'error', label: "Couldn't load the organisation: Try again", model: caseOf(1, { access: null, problem: 'problem.unavailable' }) },
  ],
})
