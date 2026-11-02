import { createElement } from 'react'
import { defineDesignScreen } from '../../../lib/design/design-screen'
import { COMPANY, inShell, PREFIX, SCOPE_ALL, SCOPE_ONE, SIGHT_HR, SIGHT_OFF, SITE_N, SITE_S, TODAY, type PeopleRole, PEOPLE_ROLES } from '../_shared/fixtures'
import type { Authorisation, CellDetail, EmployeeLevel, EmployeeSkills, Matrix, MatrixRow, Skill } from './api'
import { dialogPerson, skillsAddressOf, skillsCan } from './model'
import type { SkillDialog } from './use-skill-dialogs'
import { SkillsView, type MatrixState, type SkillsModel } from './view/SkillsView'

/**
 * SCR-160 — Skills & training with made-up people and skills only: the matrix (operations, machines), a tile pressed, Show, sort
 * by name, All sites, a cell's detail (a level, a trainee, a machine), 1–4 saving, every dialog, a refusal, the page's
 * states and the roles the design names (HR, the floor supervisor who may set levels, read-only, no right). The training
 * columns come in W2b-2.
 */

const uid = (block: string, n: number) => `0190f0e2-${block}-7000-8000-${String(n).padStart(12, '0')}`
const stitchClass = { id: uid('4001', 1), code: 'LOCKSTITCH', labelEn: 'Lockstitch machine', labelIt: 'Macchina punto annodato' }
const pressClass = { id: uid('4001', 2), code: 'CLICKING_PRESS', labelEn: 'Clicking press', labelIt: 'Pressa fustellatrice' }
const skill = (n: number, code: string, it: string, en: string, kind: Skill['kind'] = 'OPERATION'): Skill => ({ id: uid('4002', n), companyId: COMPANY, code, name: en, nameI18n: { it, en }, kind, operation: null, machineClass: null, sortOrder: n, status: 'ACTIVE', version: 1 })
export const SKILLS: Skill[] = [skill(1, 'TAGLIO', 'Taglio pelle', 'Leather cutting'), skill(2, 'CUCITURA', 'Cucitura spalla', 'Shoulder seam'), skill(3, 'RIFINITURA', 'Rifinitura', 'Finishing'), skill(4, 'PRESSA', 'Uso pressa', 'Press use', 'MACHINE'), skill(5, 'PROVA', 'Controllo finale', 'Final check', 'GENERAL')]
const LINE = { id: uid('4003', 1), code: 'L-A', name: 'Linea giacche' }
const LINE_B = { id: uid('4003', 2), code: 'L-B', name: 'Linea pantaloni' }
const TEAM = { id: uid('4004', 1), code: 'A1', name: 'Squadra A1' }
const TEAM_B = { id: uid('4004', 2), code: 'B1', name: 'Squadra B1' }

const level = (n: number, skillId: string, value: MatrixRow['levels'][number]['level'], extra: Partial<MatrixRow['levels'][number]> = {}): MatrixRow['levels'][number] => ({ skillId, levelId: uid('4005', n), level: value, since: '2026-03-02', traineeUntil: null, trainee: 'NONE', signedOffOn: null, version: 1, ...extra })
const machine = (n: number, classId: string, extra: Partial<MatrixRow['authorisations'][number]> = {}): MatrixRow['authorisations'][number] => ({ machineClassId: classId, authorisationId: uid('4006', n), state: 'AUTHORISED', authorisedOn: '2026-02-16', validUntil: null, ending: false, version: 1, ...extra })
const person = (n: number, name: string, extra: Partial<MatrixRow> = {}): MatrixRow => ({ employeeId: uid('4007', n), name, displayName: name.split(' ')[0]!, companyId: COMPANY, siteId: SITE_N.id, line: LINE, team: TEAM, levels: [], authorisations: [], canManage: true, canAuthorise: true, ...extra })

export const ROWS: MatrixRow[] = [
  person(1, 'Giulia Esempio', { levels: [level(1, SKILLS[0]!.id, 'TRAINER'), level(2, SKILLS[1]!.id, 'EXPERT')], authorisations: [machine(1, pressClass.id)] }),
  person(2, 'Paolo Prova', { levels: [level(3, SKILLS[0]!.id, 'LEARNING', { traineeUntil: '2026-12-01', trainee: 'TRAINEE' }), level(4, SKILLS[2]!.id, 'CAN_DO')], authorisations: [machine(2, stitchClass.id, { validUntil: '2026-12-10', ending: true })] }),
  person(3, 'Ion Campione', { levels: [level(5, SKILLS[1]!.id, 'CAN_DO', { traineeUntil: '2026-10-15', trainee: 'OVERDUE' })], authorisations: [machine(3, stitchClass.id, { state: 'EXPIRED', validUntil: '2026-09-30' })] }),
  person(4, 'Sara Demo', { line: LINE_B, team: TEAM_B, levels: [level(6, SKILLS[2]!.id, 'EXPERT'), level(7, SKILLS[4]!.id, 'CAN_DO')] }),
  person(5, 'Davide Modello', { line: LINE_B, team: TEAM_B, levels: [level(8, SKILLS[1]!.id, 'TRAINER')], authorisations: [machine(4, pressClass.id, { state: 'NOT_YET', authorisedOn: '2026-11-16' })] }),
]
const SOUTH = person(6, 'Chiara Copia', { siteId: SITE_S.id, line: { id: uid('4003', 3), code: 'L-S1', name: 'Linea guanti' }, team: { id: uid('4004', 3), code: 'S1', name: 'Squadra S1' }, levels: [level(9, SKILLS[0]!.id, 'CAN_DO')] })

export const MATRIX: Matrix = {
  rows: ROWS,
  complete: true,
  skills: SKILLS,
  machineClasses: [
    { ...stitchClass, active: true, keptAtSites: [SITE_N.id] },
    { ...pressClass, active: true, keptAtSites: [] },
  ],
  sites: [SITE_N, SITE_S],
  tiles: { trainees: 2, traineesOverdue: 1, authorisationsEnding: 1 },
  today: TODAY,
}

const levelRow = (over: Partial<EmployeeLevel> = {}): EmployeeLevel => ({
  id: uid('4005', 3),
  employeeId: ROWS[1]!.employeeId,
  skill: { id: SKILLS[0]!.id, code: SKILLS[0]!.code, name: SKILLS[0]!.nameI18n.it!, kind: 'OPERATION', status: 'ACTIVE' },
  level: 'LEARNING',
  since: '2026-09-01',
  assessedAt: '2026-09-01T08:00:00.000Z',
  assessedBy: 'Anna Esempio',
  traineeUntil: '2026-12-01',
  trainee: 'TRAINEE',
  signedOffOn: null,
  signedOffBy: null,
  trainer: null,
  removedAt: null,
  removedBy: null,
  removeReason: null,
  version: 2,
  ...over,
})
const authorisationRow = (over: Partial<Authorisation> = {}): Authorisation => ({ id: uid('4006', 2), employeeId: ROWS[1]!.employeeId, machineClass: stitchClass, authorisedOn: '2026-02-16', validUntil: '2026-12-10', state: 'AUTHORISED', authorisedBy: 'Anna Esempio', revokedAt: null, revokedBy: null, revokeReason: null, version: 1, ...over })

const LEVEL_DETAIL: CellDetail = {
  employee: { id: ROWS[1]!.employeeId, name: ROWS[1]!.name },
  levels: [levelRow()],
  authorisations: [],
  history: [
    { id: uid('4008', 2), at: '2026-09-15T09:10:00.000Z', action: 'people.setSkillLevel', recordId: uid('4005', 3), by: 'Anna Esempio', before: { level: 'LEARNING' }, after: { level: 'LEARNING', traineeUntil: '2026-12-01' }, reason: null },
    { id: uid('4008', 1), at: '2026-09-01T08:00:00.000Z', action: 'people.setSkillLevel', recordId: uid('4005', 3), by: 'Anna Esempio', before: null, after: { level: 'LEARNING' }, reason: null },
  ],
  canManage: true,
  canAuthorise: true,
  today: TODAY,
}
const MACHINE_DETAIL: CellDetail = { ...LEVEL_DETAIL, levels: [], authorisations: [authorisationRow()], history: [{ id: uid('4008', 3), at: '2026-02-16T08:00:00.000Z', action: 'people.authoriseMachine', recordId: uid('4006', 2), by: 'Anna Esempio', before: null, after: null, reason: null }] }

interface SkillsCase {
  role: PeopleRole
  page: SkillsModel
}

const common = { busy: false, problem: null }
const paolo = dialogPerson(ROWS[1]!)

function page(role: PeopleRole, over: Partial<SkillsModel> = {}, terms = ''): SkillsCase {
  const dialogs = over.dialogs
  return {
    role,
    page: {
      prefix: PREFIX,
      scope: SCOPE_ONE,
      can: skillsCan(PEOPLE_ROLES[role]),
      address: skillsAddressOf(new URLSearchParams(terms)),
      sight: SIGHT_OFF,
      matrix: { status: 'ready', value: MATRIX },
      asOf: '2026-11-02T09:42:00.000Z',
      live: 'live',
      updates: 0,
      notice: null,
      cell: null,
      saving: [],
      ...over,
      dialogs: { dialog: null, rows: ROWS, classes: MATRIX.machineClasses, skills: SKILLS, sites: MATRIX.sites, today: TODAY, signer: 'Anna Esempio', stepUp: { open: false, busy: false, sentence: '', problem: null }, ...dialogs },
    },
  }
}

const withDialog = (dialog: SkillDialog, extra: Partial<SkillsModel['dialogs']> = {}) => page('hr', { dialogs: { dialog, ...extra } as SkillsModel['dialogs'] })
const ready = (value: Matrix): MatrixState => ({ status: 'ready', value })
const authorise = (over: Partial<Extract<SkillDialog, { kind: 'authorise' }>> = {}): SkillDialog => ({ kind: 'authorise', people: [paolo], fixed: true, draft: { classId: pressClass.id, from: TODAY, until: null }, refused: [], done: 0, ...common, ...over })
const signoff = (over: Partial<Extract<SkillDialog, { kind: 'signoff' }>> = {}): SkillDialog => ({ kind: 'signoff', person: paolo, skillId: SKILLS[0]!.id, skillLabel: 'Taglio pelle', levelId: uid('4005', 3), version: 2, since: '2026-09-01', draft: { on: TODAY, trainerId: null, level: null }, ...common, ...over })

function SkillsDesign({ model }: { model: SkillsCase }) {
  return inShell('/people/skills', createElement(SkillsView, { model: model.page }), model.role)
}

export const designScreen = defineDesignScreen<SkillsCase>({
  screen: 'SCR-160',
  title: 'Skills matrix (skills and machine authorisations)',
  view: SkillsDesign,
  holdsPage: true,
  cases: [
    { id: 'hr', label: 'HR: the matrix grouped line › team, the tiles, the privacy note', model: page('hr'), note: 'Arrows move between cells, Enter opens one, 1–4 set a level. The training columns come in W2b-2.' },
    { id: 'gate-open', label: 'Privacy note: the worker and HR see one person\'s figures here', model: page('hr', { sight: SIGHT_HR }) },
    { id: 'tile-trainees', label: 'Tile pressed: trainees not signed off', model: page('hr', { matrix: ready({ ...MATRIX, rows: ROWS.slice(1, 3) }) }, 'tile=TRAINEES') },
    { id: 'tile-ending', label: 'Tile pressed: machine authorisations ending in 60 days', model: page('hr', { matrix: ready({ ...MATRIX, rows: [ROWS[1]!] }) }, 'tile=AUTHORISATIONS_ENDING') },
    { id: 'show-skills', label: 'Show: skills only', model: page('hr', {}, 'show=SKILLS') },
    { id: 'show-machines', label: 'Show: machines only', model: page('hr', {}, 'show=MACHINES') },
    { id: 'sort-name', label: 'Rows by name (the only other order: nothing ranks people)', model: page('hr', { matrix: ready({ ...MATRIX, rows: [...ROWS].sort((a, b) => a.name.localeCompare(b.name)) }) }, 'sort=NAME') },
    { id: 'line', label: 'One line chosen', model: page('hr', {}, `line=${LINE_B.id}`) },
    { id: 'all-sites', label: 'All sites: the Site column and chip; the note asks for a site', model: page('hr', { scope: SCOPE_ALL, sight: { status: 'allSites' }, matrix: ready({ ...MATRIX, rows: [...ROWS, SOUTH] }) }) },
    { id: 'saving', label: '2 pressed on a cell: saving', model: page('hr', { saving: [`${ROWS[3]!.employeeId}:${SKILLS[0]!.id}`] }) },
    { id: 'cell-level', label: 'Cell detail: a trainee, with the actions and the history', model: page('hr', { cell: { cell: { employeeId: ROWS[1]!.employeeId, kind: 'skill', skillId: SKILLS[0]!.id }, title: 'Taglio pelle', detail: LEVEL_DETAIL, problem: null } }) },
    { id: 'cell-machine', label: 'Cell detail: a machine authorisation', model: page('hr', { cell: { cell: { employeeId: ROWS[1]!.employeeId, kind: 'machine', classId: stitchClass.id }, title: 'Macchina punto annodato', detail: MACHINE_DETAIL, problem: null } }) },
    { id: 'cell-read-only', label: 'Cell detail without the right: every action held with why', model: page('readOnly', { cell: { cell: { employeeId: ROWS[1]!.employeeId, kind: 'skill', skillId: SKILLS[0]!.id }, title: 'Taglio pelle', detail: { ...LEVEL_DETAIL, canManage: false, canAuthorise: false }, problem: null } }) },
    { id: 'authorise', label: 'Authorise a machine: the first at this site (others are held from then on)', model: withDialog(authorise()) },
    { id: 'authorise-kept', label: 'Authorise a machine: a class already kept here', model: withDialog(authorise({ draft: { classId: stitchClass.id, from: TODAY, until: '2027-11-02' } })) },
    { id: 'authorise-band', label: 'Authorise a machine from the band: choose the person', model: withDialog(authorise({ people: [], fixed: false, draft: { classId: null, from: TODAY, until: null } })) },
    { id: 'authorise-many', label: 'Authorise 3 people: one refused, the others done', model: withDialog(authorise({ people: [dialogPerson(ROWS[2]!)], done: 2, refused: [{ name: ROWS[2]!.name, problem: { ns: 'skills', words: { key: 'refusal.AUTHORISATION_OPEN' } } }] })) },
    { id: 'signoff', label: 'Sign off a trainee: trainer, date, typed name', model: withDialog(signoff()) },
    { id: 'signoff-refused', label: 'Sign off refused: the trainer does not hold the skill as Trainer', model: withDialog(signoff({ problem: { ns: 'skills', words: { key: 'refusal.TRAINER_NOT_TRAINER' } } })) },
    { id: 'signoff-code', label: 'Sign off: the fresh code', model: withDialog(signoff({ busy: true }), { stepUp: { open: true, busy: false, sentence: 'stepUp.signOff', problem: null } }) },
    { id: 'trainee', label: 'A trainee period on a level', model: withDialog({ kind: 'level', person: paolo, skillId: SKILLS[2]!.id, skillLabel: 'Rifinitura', level: 'CAN_DO', until: '', version: 1, hasTrainee: false, ...common }) },
    { id: 'remove', label: 'Remove a level: the reason', model: withDialog({ kind: 'removeLevel', person: paolo, skillLabel: 'Rifinitura', levelId: uid('4005', 4), version: 1, reason: '', ...common }) },
    { id: 'valid-until', label: 'Change the end date of an authorisation', model: withDialog({ kind: 'validUntil', person: paolo, classLabel: 'Macchina punto annodato', id: uid('4006', 2), version: 1, from: '2026-02-16', until: '2026-12-10', ...common }) },
    { id: 'revoke', label: 'Revoke an authorisation: the reason, final', model: withDialog({ kind: 'revoke', person: paolo, classLabel: 'Macchina punto annodato', id: uid('4006', 2), version: 1, reason: '', ...common }) },
    { id: 'catalogue', label: 'The list of skills (the matrix\'s columns)', model: withDialog({ kind: 'catalogue', skills: SKILLS, operations: [{ id: uid('4009', 1), label: 'OP-10 · Taglio pelle' }], draft: { code: '', nameIt: '', nameEn: '', kind: 'OPERATION', targetId: null }, adding: true, ...common }) },
    { id: 'refused-self', label: 'A refusal in words: nobody decides about themselves', model: page('hr', { notice: { tone: 'danger', ns: 'skills', key: 'refusal.SELF_DECISION' } }) },
    { id: 'updates', label: 'Someone else changed a level: N updates · Show', model: page('hr', { updates: 3 }) },
    { id: 'supervisor', label: 'Floor supervisor: sets levels, authorises', model: page('supervisor') },
    { id: 'read-only', label: 'Read-only: sees, changes nothing; band action held', model: page('readOnly', { matrix: ready({ ...MATRIX, rows: ROWS.map((row) => ({ ...row, canManage: false, canAuthorise: false })) }) }) },
    { id: 'no-right', label: 'Sales: no right (no navigation row either)', model: page('sales') },
    { id: 'loading', label: 'Loading', model: page('hr', { matrix: { status: 'loading' }, asOf: null, live: 'connecting' }) },
    { id: 'error', label: "The matrix couldn't be read", model: page('hr', { matrix: { status: 'error', problem: 'problem.unavailable' }, asOf: null }) },
    { id: 'empty-people', label: 'No people yet', model: page('hr', { matrix: ready({ ...MATRIX, rows: [], tiles: { trainees: 0, traineesOverdue: 0, authorisationsEnding: 0 } }) }) },
    { id: 'empty-skills', label: 'No skills yet', model: page('hr', { matrix: ready({ ...MATRIX, skills: [], machineClasses: [] }) }) },
    { id: 'no-match', label: 'Nothing matches', model: page('hr', { matrix: ready({ ...MATRIX, rows: [] }) }, 'q=zzz') },
    { id: 'cut', label: 'More than 500 people: the list says so', model: page('hr', { matrix: ready({ ...MATRIX, complete: false }) }) },
  ],
})

export const EMPLOYEE_SKILLS: EmployeeSkills = {
  employee: { id: ROWS[1]!.employeeId, name: ROWS[1]!.name, companyId: COMPANY, siteId: SITE_N.id, status: 'ACTIVE' },
  levels: [levelRow(), levelRow({ id: uid('4005', 4), skill: { id: SKILLS[2]!.id, code: SKILLS[2]!.code, name: SKILLS[2]!.nameI18n.it!, kind: 'OPERATION', status: 'ACTIVE' }, level: 'CAN_DO', traineeUntil: '2026-05-01', trainee: 'SIGNED_OFF', signedOffOn: '2026-04-20', signedOffBy: 'Anna Esempio', since: '2026-02-01' })],
  authorisations: [authorisationRow()],
  history: { levels: [levelRow({ id: uid('4005', 5), skill: { id: SKILLS[4]!.id, code: SKILLS[4]!.code, name: SKILLS[4]!.nameI18n.it!, kind: 'GENERAL', status: 'ACTIVE' }, level: 'CAN_DO', trainee: 'NONE', traineeUntil: null, removedAt: '2026-06-01T10:00:00.000Z', removedBy: 'Anna Esempio', removeReason: 'Livello segnato per errore' })], authorisations: [] },
  canManage: true,
  canAuthorise: true,
  today: TODAY,
}
