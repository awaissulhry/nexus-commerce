import { createElement } from 'react'
import { defineDesignScreen } from '../../../../lib/design/design-screen'
import { DEMO_USER } from '../../../../shell/design-data'
import { ASSIGNMENTS, COMPANIES, inShell, panels, PREFIX, ROLES, SITES, USERS, WORKERS } from '../../shared/fixtures'
import { failed, loaded, loading, STEP_UP_CLOSED } from '../../shared/model'
import type { UserRecordModel, WorkerRecordModel } from './model'
import { UserRecordView } from './view/UserRecordView'
import { WorkerRecordView } from './view/WorkerRecordView'

/** SCR-011 a person's record: an office person (made-up, example.com) and a floor worker (invented name and badge). */

type Case = { kind: 'user'; model: UserRecordModel } | { kind: 'worker'; model: WorkerRecordModel }

const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const CAN = { suspend: true, reactivate: true, deactivate: true, resetPassword: true, assign: true }
const dora = USERS[3]!
const user = (over: Partial<UserRecordModel> = {}): Case => ({
  kind: 'user',
  model: { prefix: PREFIX, tab: 'roles', user: dora, me: DEMO_USER.id, assignments: loaded(ASSIGNMENTS), roles: ROLES, companies, can: CAN, lastAdmin: false, stepUp: STEP_UP_CLOSED, ...over },
})
const anna = WORKERS[0]!
const worker = (over: Partial<WorkerRecordModel> = {}): Case => ({
  kind: 'worker',
  model: { prefix: PREFIX, tab: 'badge', worker: anna, siteName: SITES[0]!.name, floorRoles: ROLES.filter((role) => role.audience === 'floor'), me: DEMO_USER.id, can: { manage: true, credentials: true, roles: true }, stepUp: STEP_UP_CLOSED, ...over },
})

function RecordDesign({ model }: { model: Case }) {
  if (model.kind === 'user') {
    const person = model.model.user
    const panel = person ? panels({ type: 'User', id: person.id, companyId: null }, person.displayName) : null
    return inShell(`/admin/users/${person?.id ?? 'x'}`, createElement(UserRecordView, { model: model.model, panels: panel }))
  }
  const person = model.model.worker
  const panel = person ? panels({ type: 'Worker', id: person.id, companyId: SITES[0]!.companyId, siteId: person.siteId }, person.displayName) : null
  return inShell(`/admin/users/floor/${person?.id ?? 'x'}`, createElement(WorkerRecordView, { model: model.model, panels: panel }))
}

export const designScreen = defineDesignScreen<Case>({
  screen: 'SCR-011',
  title: "A person's record: roles and scope, badge and PIN",
  view: RecordDesign,
  cases: [
    { id: 'roles', label: 'Office: roles & scope', model: user(), note: 'Role × where × when; what they can do in sentences with their money sight; an ended role stays listed.' },
    { id: 'give-role', label: 'Office: give a role', model: user({ dialog: 'give-role' }), note: 'The summary says when the role raises rights: the API then asks for a fresh code.' },
    { id: 'give-role-step-up', label: 'Office: give a role, fresh code', model: user({ dialog: 'give-role', busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.giveRole', problem: null } }) },
    { id: 'end-role', label: 'Office: end a role', model: user({ dialog: 'end-role', endId: ASSIGNMENTS[0]!.id }) },
    { id: 'profile', label: 'Office: profile and danger zone', model: user({ tab: 'profile' }) },
    { id: 'last-admin', label: 'Office: the last administrator', model: user({ tab: 'profile', user: USERS[1]!, lastAdmin: true, assignments: loaded([]) }), note: 'Suspend and Deactivate are held before the click: the tenant keeps one administrator.' },
    { id: 'self', label: 'Office: my own record', model: user({ tab: 'profile', user: USERS[0]!, assignments: loaded([]) }), note: 'Nobody suspends, deactivates or gives roles to themselves.' },
    { id: 'suspend', label: 'Office: suspend', model: user({ tab: 'profile', dialog: 'suspend' }) },
    { id: 'deactivate', label: 'Office: deactivate', model: user({ tab: 'profile', dialog: 'deactivate' }) },
    { id: 'suspended', label: 'Office: a suspended person', model: user({ tab: 'profile', user: USERS[5]! }) },
    { id: 'invited', label: 'Office: invited, not joined', model: user({ tab: 'profile', user: USERS[4]!, assignments: loaded([]) }) },
    { id: 'no-role', label: 'Office: no role', model: user({ user: USERS[6]!, assignments: loaded([]) }) },
    { id: 'activity', label: 'Office: activity', model: user({ tab: 'activity' }) },
    { id: 'given', label: 'Office: role given', model: user({ notice: { key: 'user.done.given', tone: 'success', params: { role: 'Planner' } } }) },
    { id: 'not-found', label: 'Office: not found', model: user({ user: null, problem: 'problem.notFound', assignments: failed('problem.notFound') }) },
    { id: 'loading', label: 'Office: loading', model: user({ user: null, assignments: loading() }) },
    { id: 'worker-badge', label: 'Floor: badge & PIN', model: worker(), note: 'Only the badge\'s last 4; the PIN never shown, only its state.' },
    { id: 'worker-reveal-badge', label: 'Floor: a new badge, shown once', model: worker({ reveal: { kind: 'badge', value: 'DEMOBADGE0000000000000000000', printed: 'DEMO-BADG-E000-0000', owner: anna.displayName } }), note: 'Made-up code. Close is held until "I printed it" is ticked: the API keeps only a hash.' },
    { id: 'worker-reveal-pin', label: 'Floor: a reset PIN, shown once', model: worker({ reveal: { kind: 'pin', value: '000000', owner: anna.displayName } }) },
    { id: 'worker-pin-confirm', label: 'Floor: reset the PIN', model: worker({ dialog: 'pin' }) },
    { id: 'worker-roles', label: 'Floor: change floor roles', model: worker({ dialog: 'roles' }) },
    { id: 'worker-locked', label: 'Floor: locked out, no badge', model: worker({ worker: { ...WORKERS[2]!, badge: null } }) },
    { id: 'worker-profile', label: 'Floor: profile', model: worker({ tab: 'profile' }) },
    { id: 'worker-no-rights', label: 'Floor: without credentials rights', model: worker({ can: { manage: false, credentials: false, roles: false } }) },
    { id: 'worker-own', label: 'Floor: my own worker', model: worker({ worker: { ...anna, userId: DEMO_USER.id } }) },
    { id: 'worker-inactive', label: 'Floor: an inactive worker', model: worker({ tab: 'profile', worker: WORKERS[5]! }) },
  ],
})
