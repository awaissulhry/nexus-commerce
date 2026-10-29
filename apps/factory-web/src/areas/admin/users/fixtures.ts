import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { DEMO_USER } from '../../../shell/design-data'
import { COMPANIES, inShell, NOW, PREFIX, ROLES, SITES, USERS, WORKERS } from '../shared/fixtures'
import { failed, loaded, loading, STEP_UP_CLOSED } from '../shared/model'
import type { UsersViewModel } from './model'
import { UsersView } from './view/UsersView'

/** SCR-010 Users with made-up people (example.com) and floor workers (invented names and employee numbers). */

const CAN = { viewUsers: true, invite: true, assign: true, viewWorkers: true, manageWorkers: true, workerRoles: true, suspend: true, reactivate: true, deactivate: true }
const companies = COMPANIES.map((company) => ({ id: company.id, name: company.legalName, sites: company.sites.map((site) => ({ id: site.id, name: site.name })) }))
const sites = SITES.map((site) => ({ id: site.id, name: site.name, companyId: site.companyId }))
const ids = (rows: ReadonlyArray<{ id: string }>, ...indexes: number[]) => indexes.map((index) => rows[index]!.id)
/** Carlo and Dora (active) and Fabia (suspended): Suspend 2, Reactivate 1, Deactivate 3. */
const PICKED = ids(USERS, 2, 3, 5)
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
  pages: 1,
  asOf: NOW,
  me: DEMO_USER.id,
  can: CAN,
  stepUp: STEP_UP_CLOSED,
  ...over,
})

/** 120 made-up people (example.com) for the footer's "Show 50 more". */
const MANY = Array.from({ length: 120 }, (_, index) => ({ ...USERS[2]!, id: `0190f0e2-3939-7000-8000-${String(index + 1).padStart(12, '0')}`, displayName: `Persona Demo ${String(index + 1).padStart(3, '0')}`, email: `persona.${index + 1}@example.com` }))

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
    { id: 'viewer', label: 'A viewer: invite and add held', model: users({ can: { ...CAN, invite: false, assign: false, manageWorkers: false, workerRoles: false, suspend: false, reactivate: false, deactivate: false } }) },
    {
      id: 'office-selected',
      label: 'Office: three people ticked, the bulk actions say their reach',
      model: users({ selected: PICKED }),
      note: 'Two active and one suspended: Suspend 2, Reactivate 1, Deactivate 3. Shift-click ticks a range; x ticks the focused row.',
    },
    {
      id: 'office-selected-held',
      label: 'Office: myself and an invited person ticked',
      model: users({ selected: ids(USERS, 0, 4) }),
      note: 'Nobody suspends themselves and an invited person is not active: Suspend and Reactivate are held with their reason; Deactivate reaches the invited one.',
    },
    { id: 'office-bulk-confirm', label: 'Office: suspend 2, one confirm', model: users({ selected: PICKED, bulk: { audience: 'office', action: 'suspend' } }), note: 'Count, consequence, who, who is left out; an optional reason kept in each history. A fresh code first, once for all.' },
    { id: 'office-bulk-deactivate', label: 'Office: deactivate 3', model: users({ selected: PICKED, bulk: { audience: 'office', action: 'deactivate' } }) },
    { id: 'office-bulk-step-up', label: 'Office: the fresh code before the first call', model: users({ selected: PICKED, bulk: { audience: 'office', action: 'suspend' }, busy: true, stepUp: { open: true, busy: false, sentence: 'stepUp.sentence.suspend', problem: null } }) },
    {
      id: 'office-bulk-result',
      label: 'Office: the result notice, one refused',
      model: users({ notice: { key: 'users.bulk.done.suspend', tone: 'warning', params: { count: 1 }, refused: [{ name: 'Dora Campione', problem: 'problem.conflict' }] } }),
      note: 'One notice for the run: how many were done, how many refused and why, each by name.',
    },
    { id: 'office-bulk-done', label: 'Office: the result notice, all done', model: users({ notice: { key: 'users.bulk.done.reactivate', tone: 'success', params: { count: 2 } } }) },
    { id: 'floor-selected', label: 'Floor: two workers ticked', model: users({ audience: 'floor', selected: ids(WORKERS, 0, 1) }), note: 'Both active: Deactivate 2; Reactivate is held (none is inactive).' },
    { id: 'floor-bulk-confirm', label: 'Floor: deactivate 2', model: users({ audience: 'floor', selected: ids(WORKERS, 0, 1), bulk: { audience: 'floor', action: 'deactivate' } }) },
    { id: 'floor-inactive-selected', label: 'Floor: inactive workers, reactivate', model: users({ audience: 'floor', tile: 'inactive', selected: ids(WORKERS, 5), bulk: { audience: 'floor', action: 'reactivate' } }) },
    { id: 'more-pages', label: 'More than 50 people: Show 50 more', model: users({ users: loaded(MANY) }), note: '120 made-up people: the footer adds 50 at a time.' },
  ],
})
