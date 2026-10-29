import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANIES, inShell, NOW, PREFIX, ROLES, SITES, USERS, WORKERS } from '../shared/fixtures'
import { failed, loaded, loading, STEP_UP_CLOSED } from '../shared/model'
import type { UsersViewModel } from './model'
import { UsersView } from './view/UsersView'

/** SCR-010 Users with made-up people (example.com) and floor workers (invented names and employee numbers). */

const CAN = { viewUsers: true, invite: true, assign: true, viewWorkers: true, manageWorkers: true, workerRoles: true }
const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const sites = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId }))
const users = (over: Partial<UsersViewModel> = {}): UsersViewModel => ({
  prefix: PREFIX,
  audience: 'office',
  users: loaded(USERS),
  workers: loaded(WORKERS),
  roles: ROLES,
  companies,
  sites,
  tile: null,
  query: '',
  page: 1,
  asOf: NOW,
  can: CAN,
  stepUp: STEP_UP_CLOSED,
  ...over,
})

function UsersDesign({ model }: { model: UsersViewModel }) {
  return inShell('/admin/users', createElement(UsersView, { model }))
}

export const designScreen = defineDesignScreen<UsersViewModel>({
  screen: 'SCR-010',
  title: 'Users: office people and floor workers',
  view: UsersDesign,
  cases: [
    { id: 'office', label: 'Office people', model: users(), note: 'Roles, where they apply and what money each person sees (price · cost · margin · wages), at a glance.' },
    { id: 'office-tile', label: 'Tile: two-factor off', model: users({ tile: 'noTwoFactor' }), note: 'A tile is a saved filter: its chip says what filters the list.' },
    { id: 'floor', label: 'Floor workers', model: users({ audience: 'floor' }), note: 'No e-mail: a badge (only its last 4) and a PIN state; never who is on which tablet.' },
    { id: 'floor-locked', label: 'Floor: locked out', model: users({ audience: 'floor', tile: 'locked' }) },
    { id: 'invite', label: 'Invite people', model: users({ dialog: 'invite' }), note: 'Role cards in plain words with their money sight; where they apply; the invite works for 7 days. A fresh code first.' },
    {
      id: 'invite-results',
      label: 'Invite: one of three refused',
      model: users({
        dialog: 'invite',
        inviteResults: [
          { email: 'nuovo.uno@example.com', outcome: 'sent' },
          { email: 'nuovo.due@example.com', outcome: 'sent' },
          { email: 'carlo.prova@example.com', outcome: 'refused', problem: 'users.invite.exists' },
        ],
      }),
    },
    { id: 'invite-step-up', label: 'Invite: the fresh code', model: users({ dialog: 'invite', busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.invite', problem: null } }) },
    { id: 'invite-step-up-wrong', label: 'Invite: wrong code', model: users({ dialog: 'invite', busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.invite', problem: 'stepUp.problem.wrong' } }) },
    { id: 'add-worker', label: 'Add a floor worker', model: users({ audience: 'floor', dialog: 'add-worker' }), note: 'The least data the work needs (GDPR art. 5(1)(c)): name, site, language, an optional employee number.' },
    { id: 'worker-made', label: 'Worker added: what next', model: users({ audience: 'floor', dialog: 'add-worker', workerMade: WORKERS[3]! }) },
    { id: 'done', label: 'Invitations sent', model: users({ notice: { key: 'users.invite.done', tone: 'success', params: { count: 3 } } }) },
    { id: 'loading', label: 'Loading', model: users({ users: loading(), workers: loading(), roles: null, asOf: null }) },
    { id: 'error', label: 'The API did not answer', model: users({ users: failed('problem.unavailable'), asOf: null }) },
    { id: 'empty-floor', label: 'No floor worker yet', model: users({ audience: 'floor', workers: loaded([]) }) },
    { id: 'no-match', label: 'Search finds nobody', model: users({ query: 'zzz' }) },
    { id: 'viewer', label: 'A viewer: invite and add held', model: users({ can: { ...CAN, invite: false, assign: false, manageWorkers: false, workerRoles: false } }) },
  ],
})
