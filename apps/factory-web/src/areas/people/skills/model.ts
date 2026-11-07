import { SKILL_LEVELS, SKILL_REFUSALS, type SkillLevel } from '@nexus/factory-domain/people/skills/rules'
import { isApiError, issuePath } from '../../../lib/api/errors'
import { fieldOf, problemOf, type Words } from '../_shared/model'
import type { AuthorisationCell, CellHistory, LevelBody, LevelCell, Matrix, MatrixClass, MatrixRow, Skill, TraineeState } from './api'
import type { CourseRef, DueCellValue } from './training/api'

/**
 * The pure rules of People › Skills & training (SCR-160; B-W2b-65): who may do what, the page's address (tiles = saved
 * filters, Show, sort, line, team, search), the matrix's columns and rows, what 1–4 asks, who may be the trainer, whether a
 * machine class is kept under authorisation at a site, what a dialog still holds, and the refusals in words. Rows sort
 * by team or by name only and no column sums people into a score (AI Act Annex III 4(b); Statuto dei Lavoratori art. 4): a
 * level is a person's judgement, never computed.
 */

export const SKILLS_NAMESPACES = ['people-skills', 'people-training', 'people', 'lists'] as const
export const TIME_ZONE = 'Europe/Rome'
export { SKILL_LEVELS }

// ---- rights ------------------------------------------------------------------------------------------------------------------

export interface SkillsCan {
  /** people.skills.view: the matrix, a cell, the employee's tab. */
  view: boolean
  /** people.skills.manage: levels, trainees and the list of skills. */
  manage: boolean
  /** people.authorisations.manage: machine authorisations. */
  authorise: boolean
  /** people.view: a name opens the employee's record. */
  employees: boolean
}

export function skillsCan(permissions: readonly string[]): SkillsCan {
  const held = new Set(permissions)
  return { view: held.has('people.skills.view'), manage: held.has('people.skills.manage'), authorise: held.has('people.authorisations.manage'), employees: held.has('people.view') }
}

// ---- the page's address ------------------------------------------------------------------------------------------------------

// B-W2b-146: the design's tiles about training (person × course; the held authorisations), after W2b-1's two.
export const SKILL_TILES = ['TRAINING_OVERDUE', 'TRAINING_DUE_SOON', 'TRAINEES', 'AUTHORISATIONS_HELD', 'LANGUAGE_NOT_CHECKED', 'AUTHORISATIONS_ENDING'] as const
export type SkillTile = (typeof SKILL_TILES)[number]
export const SHOWS = ['ALL', 'SKILLS', 'MACHINES', 'SAFETY'] as const
export type Show = (typeof SHOWS)[number]
export const SORTS = ['TEAM', 'NAME'] as const
export type Sort = (typeof SORTS)[number]

export interface SkillsAddress {
  tile: SkillTile | null
  show: Show
  sort: Sort
  lineId: string | null
  teamId: string | null
  q: string
}

const oneOf = <T extends string>(values: readonly T[], value: string | null | undefined, fallback: T): T => ((values as readonly string[]).includes(value ?? '') ? (value as T) : fallback)

export function skillsAddressOf(params: URLSearchParams | null): SkillsAddress {
  const tile = params?.get('tile') ?? null
  return {
    tile: (SKILL_TILES as readonly string[]).includes(tile ?? '') ? (tile as SkillTile) : null,
    show: oneOf(SHOWS, params?.get('show'), 'ALL'),
    sort: oneOf(SORTS, params?.get('sort'), 'TEAM'),
    lineId: params?.get('line') || null,
    teamId: params?.get('team') || null,
    q: params?.get('q')?.slice(0, 80) ?? '',
  }
}

/** The address terms of a state (defaults left out); other terms (`mode`, `view`) are kept. */
export function skillsAddressText(address: SkillsAddress, keep?: URLSearchParams | null): string {
  const terms = new URLSearchParams()
  for (const [name, value] of keep?.entries() ?? []) if (!['tile', 'show', 'sort', 'line', 'team', 'q'].includes(name)) terms.set(name, value)
  if (address.tile) terms.set('tile', address.tile)
  if (address.show !== 'ALL') terms.set('show', address.show)
  if (address.sort !== 'TEAM') terms.set('sort', address.sort)
  if (address.lineId) terms.set('line', address.lineId)
  if (address.teamId) terms.set('team', address.teamId)
  if (address.q.trim()) terms.set('q', address.q.trim())
  const text = terms.toString()
  return text ? `?${text}` : ''
}

/** A narrowed view: an empty answer says "nothing matches", not "add your people". */
export const isNarrowed = (address: SkillsAddress): boolean => address.tile !== null || address.lineId !== null || address.teamId !== null || address.q.trim() !== ''

// ---- the matrix --------------------------------------------------------------------------------------------------------------

export const skillName = (skill: Pick<Skill, 'name' | 'nameI18n'>, locale: string): string => skill.nameI18n[locale] ?? skill.name
export const className = (entry: { labelIt: string; labelEn: string }, locale: string): string => (locale === 'it' ? entry.labelIt : entry.labelEn)

export const levelOf = (row: MatrixRow, skillId: string): LevelCell | null => row.levels.find((cell) => cell.skillId === skillId) ?? null
export const authorisationOf = (row: MatrixRow, classId: string): AuthorisationCell | null => row.authorisations.find((cell) => cell.machineClassId === classId) ?? null
/** B-W2b-146: a person's DueCell of a safety course; null when nothing is asked or held (or the caller reads no safety record). */
export const trainingOf = (row: MatrixRow, courseId: string): DueCellValue | null => row.trainings?.find((cell) => cell.courseId === courseId) ?? null

/** A tile's figure: null when the caller reads no one's safety records (said "—" with why). */
export function tileValue(tiles: Matrix['tiles'], tile: SkillTile): number | null {
  switch (tile) {
    case 'TRAINEES':
      return tiles.trainees
    case 'AUTHORISATIONS_ENDING':
      return tiles.authorisationsEnding
    case 'TRAINING_OVERDUE':
      return tiles.trainingOverdue
    case 'TRAINING_DUE_SOON':
      return tiles.trainingDueSoon
    case 'AUTHORISATIONS_HELD':
      return tiles.authorisationsHeld
    case 'LANGUAGE_NOT_CHECKED':
      return tiles.languageNotChecked
  }
}

/** The lines and teams of the rows read, for the toolbar's choices. */
export function placesOf(rows: readonly MatrixRow[]): { lines: { id: string; label: string }[]; teams: { id: string; label: string }[] } {
  const lines = new Map<string, string>()
  const teams = new Map<string, string>()
  for (const row of rows) {
    if (row.line) lines.set(row.line.id, `${row.line.code} · ${row.line.name}`)
    if (row.team) teams.set(row.team.id, `${row.team.code} · ${row.team.name}`)
  }
  const sorted = (map: Map<string, string>) => [...map].map(([id, label]) => ({ id, label })).sort((a, b) => a.label.localeCompare(b.label))
  return { lines: sorted(lines), teams: sorted(teams) }
}

/** The rows of the chosen line and team, as each row shows them (its team's line, else its home line). */
export const rowsShown = (rows: readonly MatrixRow[], address: Pick<SkillsAddress, 'lineId' | 'teamId'>): MatrixRow[] =>
  rows.filter((row) => (!address.lineId || row.line?.id === address.lineId) && (!address.teamId || row.team?.id === address.teamId))

/** "L1 › T1": the row's place; said on the first row of each group when the list goes by team. */
export const groupOf = (row: Pick<MatrixRow, 'line' | 'team'>): string => [row.line?.code, row.team?.code].filter(Boolean).join(' › ')

// ---- cells -------------------------------------------------------------------------------------------------------------------

export type CellRef = { employeeId: string; kind: 'skill'; skillId: string } | { employeeId: string; kind: 'machine'; classId: string } | { employeeId: string; kind: 'course'; courseId: string }

export const cellKey = (cell: CellRef): string => `${cell.employeeId}:${cell.kind === 'skill' ? cell.skillId : cell.kind === 'machine' ? cell.classId : cell.courseId}`

/** 1–4 on a skill cell: the level asked, or null for another key. */
export function levelOfKey(key: string): SkillLevel | null {
  return /^[1-4]$/.test(key) ? (SKILL_LEVELS[Number(key) - 1] ?? null) : null
}

/** What setting a level sends: the version of the level in force when there is one; null when nothing would change. */
export function levelChange(employeeId: string, skillId: string, current: Pick<LevelCell, 'level' | 'version'> | null, level: SkillLevel): LevelBody | null {
  if (current?.level === level) return null
  return { employeeId, skillId, level, ...(current ? { version: current.version } : {}) }
}

export const isTrainee = (state: TraineeState): boolean => state === 'TRAINEE' || state === 'OVERDUE'

/**
 * Who may sign as the trainer: another person of the same company who holds this skill at TRAINER and is not a trainee on
 * it themselves (the API checks each again). Only the rows read are offered; an outside trainer is left empty.
 */
export function trainersFor(rows: readonly MatrixRow[], person: { employeeId: string; companyId: string }, skillId: string): MatrixRow[] {
  return rows.filter((row) => {
    if (row.employeeId === person.employeeId || row.companyId !== person.companyId) return false
    const cell = levelOf(row, skillId)
    return cell?.level === 'TRAINER' && !isTrainee(cell.trainee)
  })
}

/** The class is kept under authorisation at this site (a first authorisation there starts holding everyone else). */
export const classKept = (entry: Pick<MatrixClass, 'keptAtSites'>, siteId: string): boolean => entry.keptAtSites.includes(siteId)

/** One person of a dialog. */
export interface DialogPerson {
  employeeId: string
  name: string
  companyId: string
  siteId: string
}

export const dialogPerson = (row: MatrixRow): DialogPerson => ({ employeeId: row.employeeId, name: row.name, companyId: row.companyId, siteId: row.siteId })

/** The sites where this class is not kept yet among the people chosen: a first authorisation there holds the others. */
export const firstAtSites = (entry: Pick<MatrixClass, 'keptAtSites'> | null, people: readonly Pick<DialogPerson, 'siteId'>[]): string[] =>
  entry ? [...new Set(people.map((person) => person.siteId))].filter((siteId) => !classKept(entry, siteId)) : []

// ---- what a dialog still holds -----------------------------------------------------------------------------------------------

export interface AuthoriseDraft {
  classId: string | null
  from: string
  until: string | null
}

/** Why Authorise is held, as a message key; null: it may go. */
export function authoriseHeld(people: readonly unknown[], draft: AuthoriseDraft): string | null {
  if (people.length === 0) return 'held.choosePerson'
  if (!draft.classId) return 'held.chooseClass'
  if (!draft.from) return 'held.chooseDate'
  if (draft.until && draft.until < draft.from) return 'held.untilBeforeFrom'
  return null
}

export interface SignOffDraft {
  on: string
  trainerId: string | null
  level: SkillLevel | null
}

/** Why Sign off is held, as a message key; null: it may go. */
export function signOffHeld(draft: SignOffDraft, facts: { since: string; today: string }): string | null {
  if (!draft.on) return 'held.chooseDate'
  if (draft.on > facts.today) return 'held.signOffFuture'
  if (draft.on < facts.since) return 'held.signOffBefore'
  return null
}

const REASON_MIN = 3
export const reasonHeld = (reason: string): string | null => (reason.trim().length < REASON_MIN ? 'held.needReason' : null)

// ---- words of API answers ----------------------------------------------------------------------------------------------------

export function skillRefusalOf(error: unknown): (typeof SKILL_REFUSALS)[number] | null {
  if (!isApiError(error)) return null
  for (const issue of error.issues) {
    const path = issuePath(issue)
    if (!path.startsWith('refusal/')) continue
    const code = path.slice('refusal/'.length)
    if ((SKILL_REFUSALS as readonly string[]).includes(code)) return code as (typeof SKILL_REFUSALS)[number]
  }
  return null
}

/**
 * The words of a failed call. `ns` says the catalogue: `skills` for this page's refusals and fields, `people` for the
 * People words every page shares (a stale version, no right, offline).
 */
export function skillsProblem(error: unknown): { ns: 'skills' | 'people'; words: Words } {
  const refusal = skillRefusalOf(error)
  if (refusal) return { ns: 'skills', words: { key: `refusal.${refusal}` } }
  const field = isApiError(error) && error.kind === 'invalid' ? fieldOf(error) : null
  if (field && ['code', 'name', 'reason', 'validUntil', 'authorisedOn', 'signedOffOn', 'traineeUntil'].includes(field)) return { ns: 'skills', words: { key: `field.${field}` } }
  return { ns: 'people', words: problemOf(error) }
}

// ---- a cell's history --------------------------------------------------------------------------------------------------------

export const HISTORY_ACTIONS = ['setSkillLevel', 'signOffTrainee', 'removeSkillLevel', 'authoriseMachine', 'changeMachineAuthorisation', 'revokeMachineAuthorisation', 'endMachineAuthorisation'] as const

export const historyAction = (entry: Pick<CellHistory, 'action'>): string => {
  const name = entry.action.replace(/^people\./, '')
  return (HISTORY_ACTIONS as readonly string[]).includes(name) ? `history.${name}` : 'history.other'
}

/** The level a history entry set, when it names one. */
export function historyLevel(entry: Pick<CellHistory, 'after'>): SkillLevel | null {
  const level = entry.after?.level
  return (SKILL_LEVELS as readonly unknown[]).includes(level) ? (level as SkillLevel) : null
}

// ---- the print ---------------------------------------------------------------------------------------------------------------

/** The print's address: this view's terms; `ids` = the rows chosen. */
export function printAddress(prefix: string, address: SkillsAddress, ids: readonly string[] = []): string {
  const text = new URLSearchParams(skillsAddressText(address).slice(1))
  if (ids.length > 0) text.set('ids', ids.join(','))
  const query = text.toString()
  return `${prefix}/people/skills/print${query ? `?${query}` : ''}`
}

export const printIdsOf = (params: URLSearchParams | null): string[] => (params?.get('ids') ?? '').split(',').filter(Boolean).slice(0, 500)

/** A column of the matrix (print and screen read the same list). */
export type MatrixColumn = { kind: 'skill'; id: string; skill: Skill } | { kind: 'machine'; id: string; entry: Matrix['machineClasses'][number] } | { kind: 'course'; id: string; course: CourseRef }

/** The matrix's columns in the design's order: operations (skills), machines, then the safety courses (B-W2b-146). */
export function matrixColumns(matrix: Pick<Matrix, 'skills' | 'machineClasses'> & { courses?: Matrix['courses'] }, show: Show): MatrixColumn[] {
  const skills = show === 'ALL' || show === 'SKILLS' ? matrix.skills.map((skill) => ({ kind: 'skill' as const, id: skill.id, skill })) : []
  const machines = show === 'ALL' || show === 'MACHINES' ? matrix.machineClasses.map((entry) => ({ kind: 'machine' as const, id: entry.id, entry })) : []
  const courses = show === 'ALL' || show === 'SAFETY' ? (matrix.courses ?? []).map((course) => ({ kind: 'course' as const, id: course.id, course })) : []
  return [...skills, ...machines, ...courses]
}
