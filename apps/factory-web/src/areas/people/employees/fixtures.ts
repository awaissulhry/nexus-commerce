import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { canAs, COUNTS, EMPLOYEE_LIST, inShell, LEAVER, LINE_B, LINES, NO_COUNTS, ORIGIN, PEOPLE, PREFIX, SCOPE_ALL, SCOPE_ONE, SIGHT_HR, SIGHT_OFF, SIGHT_REQUEST, SITES, TEAMS, TODAY, UNLINKED, type PeopleRole } from '../_shared/fixtures'
import type { EmployeesAddress } from '../_shared/model'
import { blankNewDraft } from './use-dialogs'
import { personOf, type EmployeesDialog, type EmployeesListModel } from './view-model'
import { EmployeesView } from './view/EmployeesView'

/**
 * SCR-084 — Employees (People › Main) with made-up data only: the register (inline team and home line; one cell saving,
 * one saved), each tile pressed, the data notice one at a time, Rows ▾, All sites (Site column and chip), the Teams view
 * with today's loans, the floor workers with no record, leavers in progress, every pop-up (New employee empty / filled /
 * refused, Import's leavers, Loan with its skill check, Start leaver steps with its consequences, Print badges, Change
 * team → review → done, Add team, Skip a step), and the page's states. Roles: HR (keeps the register), the production
 * manager (teams and loans), the floor supervisor (loans), a lead with My team only, read-only, sales (no People).
 */

interface EmployeesCase {
  role: PeopleRole
  list: EmployeesListModel
}

const ADDRESS: EmployeesListModel['address'] = { tile: null, rows: 'ACTIVE', q: '', view: 'people', isNew: false, isImport: false, lineId: null, teamId: null }

function list(role: PeopleRole, over: Partial<EmployeesListModel> = {}, address: Partial<EmployeesAddress & { teamId: string | null }> = {}): EmployeesCase {
  return {
    role,
    list: {
      prefix: PREFIX,
      origin: ORIGIN,
      can: canAs(role),
      address: { ...ADDRESS, ...address },
      scope: SCOPE_ONE,
      sight: SIGHT_OFF,
      rows: { items: EMPLOYEE_LIST, more: false, problem: null },
      counts: COUNTS,
      myTeam: null,
      teamOnly: null,
      unlinked: { items: UNLINKED, problem: null, complete: true },
      teams: { items: TEAMS, problem: null },
      leavers: { items: [LEAVER], problem: null },
      lines: LINES,
      sites: SITES,
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      updates: 0,
      cells: {},
      dismissed: [],
      noticeIndex: 0,
      dialog: null,
      notice: null,
      today: TODAY,
      timeZone: 'Europe/Rome',
      ...over,
    },
  }
}

const filledNew: EmployeesDialog = {
  kind: 'new',
  draft: { ...blankNewDraft(SITES[0]!.id, TODAY), firstName: 'Nadia', lastName: 'Esempio', employeeCode: 'D-0091', jobRole: 'Cucitrice', floorSignIn: true },
  agencies: null,
  busy: false,
  problem: null,
  field: null,
}
const loan = (over: Partial<Extract<EmployeesDialog, { kind: 'loan' }>> = {}): EmployeesDialog => ({
  kind: 'loan',
  person: personOf(PEOPLE.paolo),
  toLineId: LINE_B.id,
  toTeamId: null,
  startsAt: '2026-11-02T08:00:00.000Z',
  endsAt: '2026-11-02T17:00:00.000Z',
  reason: 'Picco sulla linea pantaloni',
  check: { line: { id: LINE_B.id, code: LINE_B.code, name: LINE_B.name }, canDo: 3, asTrainee: 1, kept: 5, notKept: 1 },
  busy: false,
  problem: null,
  field: null,
  ...over,
})
const leaver: EmployeesDialog = {
  kind: 'leaver',
  person: personOf(PEOPLE.paolo),
  lastWorkingDay: '2026-11-30',
  exitVisit: true,
  preview: {
    steps: [],
    consequences: { floorSignIns: 1, activeBadges: 1, officeAccount: false, openTasks: 3, openMaintenanceJobs: 1, shiftsAfter: 4, loansAfter: 0 },
    refusal: null,
  },
  reading: false,
  busy: false,
  problem: null,
}
const teamRows = [PEOPLE.paolo, PEOPLE.sara, PEOPLE.rita].map((person) => ({
  employeeId: person.id,
  name: person.name,
  from: person.team ? { team: { id: person.team.id, code: person.team.code, name: person.team.name }, lead: person.lead?.name ?? null } : null,
  to: { team: { id: TEAMS[1]!.id, code: TEAMS[1]!.code, name: TEAMS[1]!.name }, lead: TEAMS[1]!.lead?.name ?? null },
  change: person.team?.id === TEAMS[1]!.id ? ('NONE' as const) : ('MOVE' as const),
  conflict: person.status === 'LEFT' ? ('NOT_ACTIVE' as const) : null,
  leavesLead: false,
}))

function EmployeesDesign({ model }: { model: EmployeesCase }) {
  return inShell('/people/employees', createElement(EmployeesView, { model: model.list }), model.role)
}

export const designScreen = defineDesignScreen<EmployeesCase>({
  screen: 'SCR-084',
  title: 'Employees (the HR register, teams and leavers)',
  view: EmployeesDesign,
  cases: [
    { id: 'hr', label: 'HR: the register, the notice, the tiles, leavers in progress', model: list('hr'), note: 'c makes an employee; t switches to Teams; a name opens the record.' },
    { id: 'cells', label: 'Inline team and home line: one saving, one saved', model: list('hr', { cells: { [`${PEOPLE.paolo.id}:teamId`]: { state: 'saving' }, [`${PEOPLE.sara.id}:homeLineId`]: { state: 'saved' } } }) },
    { id: 'gate-open', label: 'Privacy note: the worker and HR see one person\'s figures here', model: list('hr', { sight: SIGHT_HR }) },
    { id: 'gate-request', label: 'Privacy note: one person\'s figures on request', model: list('hr', { sight: SIGHT_REQUEST }) },
    { id: 'all-sites', label: 'All sites: the Site column and chip; the note asks for a site', model: list('hr', { scope: SCOPE_ALL, sight: { status: 'allSites' }, rows: { items: [...EMPLOYEE_LIST, PEOPLE.chiara], more: false, problem: null } }) },
    { id: 'tile-leaving', label: 'Tile pressed: Leaving — steps open (its chip in the filter row)', model: list('hr', { rows: { items: [PEOPLE.marta], more: false, problem: null } }, { tile: 'LEAVING' }) },
    { id: 'tile-agency', label: 'Tile pressed: agency contracts ending in 30 days', model: list('hr', { rows: { items: [PEOPLE.ion], more: false, problem: null } }, { tile: 'AGENCY_ENDING' }) },
    { id: 'unlinked', label: 'Tile: floor workers with no employee record (Make N records)', model: list('hr', { selected: [UNLINKED[0]!.id] }, { tile: 'UNLINKED_WORKERS' }) },
    { id: 'rows-missing', label: 'Rows ▾ Missing data (no employee code)', model: list('hr', { rows: { items: [PEOPLE.elena], more: false, problem: null } }, { rows: 'MISSING_DATA' }) },
    { id: 'rows-left', label: 'Rows ▾ Left: kept, no inline edits', model: list('hr', { rows: { items: [PEOPLE.rita], more: false, problem: null } }, { rows: 'LEFT' }) },
    { id: 'notice-next', label: 'The data notice: the second of three, one dismissed', model: list('hr', { noticeIndex: 1, dismissed: ['NO_EMPLOYEE_CODE:3'] }) },
    { id: 'selected', label: 'Three selected: Change team for 3, Print 3 badges, Export 3', model: list('hr', { selected: [PEOPLE.paolo.id, PEOPLE.sara.id, PEOPLE.ion.id] }) },
    { id: 'teams', label: 'Teams view: lines, teams and leads with today\'s loans', model: list('hr', {}, { view: 'teams' }), note: 'x selects members, m moves them.' },
    { id: 'teams-line', label: 'Teams view on one line (a loan row\'s link)', model: list('hr', {}, { view: 'teams', lineId: LINE_B.id }) },
    { id: 'teams-selected', label: 'Teams view: two members selected → Move 2 to…', model: list('hr', { selected: [`${TEAMS[0]!.id}:${PEOPLE.paolo.id}`, `${TEAMS[0]!.id}:${PEOPLE.luca.id}`] }, { view: 'teams' }) },
    { id: 'teams-empty', label: 'Teams view: no teams yet', model: list('hr', { teams: { items: [], problem: null } }, { view: 'teams' }) },
    { id: 'new', label: 'New employee: empty', model: list('hr', { dialog: { kind: 'new', draft: blankNewDraft(SITES[0]!.id, TODAY), agencies: null, busy: false, problem: null, field: null } }) },
    { id: 'new-filled', label: 'New employee filled, with the floor sign-in', model: list('hr', { dialog: filledNew }) },
    { id: 'new-agency', label: 'New employee: an agency worker (agency and contract end)', model: list('hr', { dialog: { ...filledNew, draft: { ...(filledNew as Extract<EmployeesDialog, { kind: 'new' }>).draft, kind: 'AGENCY', endDate: '2027-02-28' }, agencies: [{ id: PEOPLE.ion.agency!.id, code: PEOPLE.ion.agency!.code, name: PEOPLE.ion.agency!.name }] } as EmployeesDialog }) },
    { id: 'new-refused', label: 'New employee refused: the employee code is taken (at the field)', model: list('hr', { dialog: { ...filledNew, problem: { key: 'refusal.CODE_TAKEN' }, field: 'employeeCode' } as EmployeesDialog }) },
    { id: 'loan', label: 'Loan to another line: the skill check, "Loan until 18:00"', model: list('hr', { dialog: loan() }) },
    { id: 'loan-refused', label: 'Loan refused: already lent in those hours', model: list('hr', { dialog: loan({ problem: { key: 'refusal.LOAN_OVERLAP' } }) }) },
    { id: 'leaver', label: 'Start leaver steps: the consequences and the reversal', model: list('hr', { dialog: leaver }) },
    { id: 'leaver-refused', label: 'Start leaver steps refused: the last day before the start', model: list('hr', { dialog: { ...leaver, preview: { ...(leaver as Extract<EmployeesDialog, { kind: 'leaver' }>).preview!, refusal: { code: 'BEFORE_START', message: '' } } } as EmployeesDialog }) },
    { id: 'badges', label: 'Print badges: the badge faces, the sheet in a new tab', model: list('hr', { dialog: { kind: 'badges', people: [PEOPLE.paolo, PEOPLE.sara, PEOPLE.ion].map(personOf) } }) },
    { id: 'team-change', label: 'Change team for 3: choose the team', model: list('hr', { dialog: { kind: 'teamChange', people: [PEOPLE.paolo, PEOPLE.sara, PEOPLE.rita].map(personOf), teamId: TEAMS[1]!.id, rows: null, state: { phase: 'reading' }, reviewing: false } }) },
    { id: 'team-review', label: 'Change team: the review (old → new, one already so, one refused)', model: list('hr', { dialog: { kind: 'teamChange', people: [PEOPLE.paolo, PEOPLE.sara, PEOPLE.rita].map(personOf), teamId: TEAMS[1]!.id, rows: teamRows, state: { phase: 'ready' }, reviewing: true } }) },
    { id: 'add-team', label: 'Add a team', model: list('hr', { dialog: { kind: 'addTeam', siteId: SITES[0]!.id, lineId: LINE_B.id, code: 'B2', name: 'Pantaloni B2', busy: false, problem: null, field: null } }, { view: 'teams' }) },
    { id: 'skip-step', label: 'Skip a leaver step: the reason', model: list('hr', { dialog: { kind: 'skip', leaver: LEAVER, step: LEAVER.steps[2]!, reason: '', busy: false, problem: null } }) },
    { id: 'production', label: 'Production manager: teams and loans; New employee and leaver steps held', model: list('production') },
    { id: 'supervisor', label: 'Floor supervisor: loans only', model: list('supervisor') },
    { id: 'lead', label: 'A lead with My team only: "Showing your team (4)"', model: list('lead', { teamOnly: { employeeId: PEOPLE.giulia.id, teams: [{ ...TEAMS[0]!, mine: 'LEAD' }] } }) },
    { id: 'read-only', label: 'Read-only: no inline edits, writes held', model: list('readOnly') },
    { id: 'updates', label: 'Live changes waiting: "2 updates · Show"', model: list('hr', { updates: 2 }) },
    { id: 'loading', label: 'Loading', model: list('hr', { rows: { items: null, more: false, problem: null }, counts: null, leavers: { items: null, problem: null }, asOf: null, sight: { status: 'loading' } }) },
    { id: 'error', label: "The employees couldn't be read", model: list('hr', { rows: { items: null, more: false, problem: 'problem.unavailable' }, counts: null }) },
    { id: 'empty', label: 'No employees yet: "Add your people" and "Link them"', model: list('hr', { rows: { items: [], more: false, problem: null }, counts: { ...NO_COUNTS, tiles: { ...NO_COUNTS.tiles, UNLINKED_WORKERS: 12 } }, leavers: { items: [], problem: null } }) },
    { id: 'no-match', label: 'Nothing matches the search', model: list('hr', { rows: { items: [], more: false, problem: null } }, { q: 'ZZZ' }) },
    { id: 'keys', label: 'The keys (footer icon, ?)', model: list('hr', { helpOpen: true }) },
    { id: 'sales', label: 'Sales: no People (the page says so)', model: list('sales') },
  ],
})
