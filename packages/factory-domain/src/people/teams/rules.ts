import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'

/**
 * Lines, teams and leads, loans to another line, and the site › area › line › station tree (B-W2b-26; MES-210, PLT-020,
 * PLT-005; design people.employees "Teams view", "Loan to another line", "Change team"; admin.org "Lines and stations").
 * Pure: the API (apps/factory-api modules/people/teams) reads the facts in its command and writes the rows; the
 * …_people_w2b_guards triggers stay the last word for every login.
 *
 *   team        a site's crew or group: a code (unique on the site), a name, an optional line of the site. Archived
 *               only with nobody in it.
 *   membership  dated history (TeamMember since / until): a person is in one team at a time (the row without an end).
 *               A move ends the old row the day before and starts the new one today; a row that began today is
 *               removed instead (it never began before today: the database allows it).
 *   lead        one per team: the flag on a current member's row; setting a new lead takes it off the old one first.
 *   loan        a person works on another line of their site for some hours or days (a reason, who decided); two loans
 *               of one person never overlap; only the end moves, and only a loan that has not begun is removed.
 *   area        a site's hall or room (OrgArea): lines sit in one; archived only with no active line in it.
 *
 * Statuto dei Lavoratori art. 4 (Owner answers W1, F2): a team holds names, never a figure about one person's work.
 */

export const TEAM_LIMITS = { code: 24, name: 80, reason: 300, moves: 200 } as const
export const AREA_LIMITS = { code: 24, name: 80, sortOrder: { min: 0, max: 9999 } } as const
export const LOAN_LIMITS = { reason: 300, maxDays: 31 } as const

/** A team's or area's code: capitals, digits and . _ -, no spaces (printed on boards and lists). */
export const STRUCTURE_CODE = /^[A-Z0-9][A-Z0-9._-]*$/

/** A code as stored: trimmed and in capitals. */
export const cleanStructureCode = (value: string): string => value.trim().toUpperCase()

function codeProblems(code: string | undefined, max: number): Issue[] {
  if (code === undefined) return []
  if (code.length === 0) return [{ path: 'code', message: 'Required.' }]
  if (code.length > max) return [{ path: 'code', message: `At most ${max} characters.` }]
  if (!STRUCTURE_CODE.test(code)) return [{ path: 'code', message: 'Capitals, digits and . _ - only, no spaces.' }]
  return []
}

function nameProblems(name: string | undefined, max: number): Issue[] {
  if (name === undefined) return []
  const trimmed = name.trim()
  if (trimmed.length === 0) return [{ path: 'name', message: 'Required.' }]
  if (trimmed.length > max) return [{ path: 'name', message: `At most ${max} characters.` }]
  return []
}

/** A team's code (stored in capitals) and name. */
export const teamProblems = (draft: { readonly code?: string; readonly name?: string }): Issue[] => [...codeProblems(draft.code === undefined ? undefined : cleanStructureCode(draft.code), TEAM_LIMITS.code), ...nameProblems(draft.name, TEAM_LIMITS.name)]

/** An area's code, name and place in the list. */
export function areaProblems(draft: { readonly code?: string; readonly name?: string; readonly sortOrder?: number }): Issue[] {
  const problems = [...codeProblems(draft.code === undefined ? undefined : cleanStructureCode(draft.code), AREA_LIMITS.code), ...nameProblems(draft.name, AREA_LIMITS.name)]
  if (draft.sortOrder !== undefined && (!Number.isInteger(draft.sortOrder) || draft.sortOrder < AREA_LIMITS.sortOrder.min || draft.sortOrder > AREA_LIMITS.sortOrder.max)) {
    problems.push({ path: 'sortOrder', message: `A whole number from ${AREA_LIMITS.sortOrder.min} to ${AREA_LIMITS.sortOrder.max}.` })
  }
  return problems
}

// ---- memberships --------------------------------------------------------------------------------------------------------

/** A person's current membership (the row without an end). */
export interface Membership {
  readonly id: string
  readonly teamId: string
  readonly isLead: boolean
  readonly since: BusinessDate
}

/** What a move does to the person's rows, effective today. */
export type MovePlan =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'MOVE'; readonly end: { readonly id: string; readonly until: BusinessDate } | null; readonly remove: string | null; readonly start: { readonly teamId: string; readonly since: BusinessDate } | null; readonly wasLead: boolean }

/** The day before a calendar day. */
export function dayBefore(date: BusinessDate): BusinessDate {
  const [year, month, day] = date.split('-').map(Number) as [number, number, number]
  return new Date(Date.UTC(year, month - 1, day - 1)).toISOString().slice(0, 10)
}

/**
 * A person's move to `teamId` (null: out of every team), effective today: the current row ends yesterday (or, when it
 * began today, is removed: a row that has not begun before today may be deleted), the new row starts today. NONE when
 * the person is already in that team.
 */
export function movePlan(current: Membership | null, teamId: string | null, today: BusinessDate): MovePlan {
  if ((current?.teamId ?? null) === teamId) return { kind: 'NONE' }
  const startsToday = current !== null && current.since >= today
  return {
    kind: 'MOVE',
    end: current !== null && !startsToday ? { id: current.id, until: dayBefore(today) } : null,
    remove: current !== null && startsToday ? current.id : null,
    start: teamId === null ? null : { teamId, since: today },
    wasLead: current?.isLead ?? false,
  }
}

/** Why a move of one person is refused (the review lists it beside the person). */
export const MOVE_CONFLICTS = ['NOT_ACTIVE', 'OTHER_SITE', 'TEAM_ARCHIVED', 'TEAM_OTHER_SITE', 'DUPLICATE', 'LEAD_MOVES'] as const
export type MoveConflict = (typeof MOVE_CONFLICTS)[number]

// ---- loans --------------------------------------------------------------------------------------------------------------

export const LOAN_STATES = ['PLANNED', 'RUNNING', 'ENDED'] as const
export type LoanState = (typeof LOAN_STATES)[number]

export interface LoanDraft {
  readonly startsAt: Date
  readonly endsAt: Date
  readonly reason: string
  readonly fromLineId: string | null
  readonly toLineId: string
}

/** What is wrong with a loan as it would be stored. */
export function loanProblems(draft: LoanDraft): Issue[] {
  const problems: Issue[] = []
  if (draft.endsAt.getTime() <= draft.startsAt.getTime()) problems.push({ path: 'endsAt', message: 'The loan ends after it starts.' })
  else if (draft.endsAt.getTime() - draft.startsAt.getTime() > LOAN_LIMITS.maxDays * 86_400_000) problems.push({ path: 'endsAt', message: `A loan lasts at most ${LOAN_LIMITS.maxDays} days: a longer move is a change of home line or team.` })
  const reason = draft.reason.trim()
  if (reason.length === 0) problems.push({ path: 'reason', message: 'Say why the person is lent (the line is short, a peak, training).' })
  else if (reason.length > LOAN_LIMITS.reason) problems.push({ path: 'reason', message: `At most ${LOAN_LIMITS.reason} characters.` })
  if (draft.fromLineId !== null && draft.fromLineId === draft.toLineId) problems.push({ path: 'toLineId', message: 'This is already the person\'s home line: lend them to another line.' })
  return problems
}

/** A loan's state at an instant. */
export function loanStateOf(loan: { readonly startsAt: Date; readonly endsAt: Date }, now: Date): LoanState {
  if (now.getTime() < loan.startsAt.getTime()) return 'PLANNED'
  if (now.getTime() < loan.endsAt.getTime()) return 'RUNNING'
  return 'ENDED'
}

/** Two loans' times overlap (half-open: one may start when the other ends). */
export const loansOverlap = (a: { readonly startsAt: Date; readonly endsAt: Date }, b: { readonly startsAt: Date; readonly endsAt: Date }): boolean =>
  a.startsAt.getTime() < b.endsAt.getTime() && b.startsAt.getTime() < a.endsAt.getTime()

/**
 * Ending a loan early at `at`: a loan that has not begun is removed instead (null), a loan that ended already cannot
 * move, and the end never comes before the start.
 */
export function endLoanRefusal(loan: { readonly startsAt: Date; readonly endsAt: Date }, at: Date, now: Date): string | null {
  const state = loanStateOf(loan, now)
  if (state === 'PLANNED') return 'The loan has not begun: remove it instead.'
  if (state === 'ENDED') return 'The loan has ended already.'
  if (at.getTime() <= loan.startsAt.getTime()) return 'A loan ends after it starts.'
  if (at.getTime() >= loan.endsAt.getTime()) return 'Ending early means before the planned end: change nothing, or make a new loan for more time.'
  return null
}

// ---- the site › area › line › station tree --------------------------------------------------------------------------------

export interface TreeSite { readonly id: string; readonly code: string; readonly name: string; readonly companyId: string; readonly status: string }
export interface TreeArea { readonly id: string; readonly siteId: string; readonly code: string; readonly name: string; readonly sortOrder: number; readonly status: string; readonly version: number }
export interface TreeLine { readonly id: string; readonly siteId: string; readonly areaId: string | null; readonly code: string; readonly name: string; readonly status: string; readonly version: number }
export interface TreeStation { readonly id: string; readonly siteId: string; readonly lineId: string | null; readonly code: string; readonly name: string; readonly status: string }
export interface TreeTeam { readonly id: string; readonly siteId: string; readonly lineId: string | null; readonly code: string; readonly name: string; readonly members: number }

export interface OrgTreeLine extends TreeLine {
  readonly stations: readonly TreeStation[]
  readonly teams: readonly TreeTeam[]
}
export interface OrgTreeArea extends TreeArea {
  readonly lines: readonly OrgTreeLine[]
}
export interface OrgTreeSite extends TreeSite {
  readonly areas: readonly OrgTreeArea[]
  /** Lines in no area yet. */
  readonly linesWithoutArea: readonly OrgTreeLine[]
  /** Stations on no line. */
  readonly stationsWithoutLine: readonly TreeStation[]
  /** Teams on no line. */
  readonly teamsWithoutLine: readonly TreeTeam[]
}

const byCode = <T extends { readonly code: string }>(a: T, b: T) => a.code.localeCompare(b.code)

/** The tree of each site (PLT-005): areas in their order, lines by code, stations and teams under their line. */
export function orgTreeOf(input: { readonly sites: readonly TreeSite[]; readonly areas: readonly TreeArea[]; readonly lines: readonly TreeLine[]; readonly stations: readonly TreeStation[]; readonly teams: readonly TreeTeam[] }): OrgTreeSite[] {
  const lineOf = (line: TreeLine): OrgTreeLine => ({
    ...line,
    stations: input.stations.filter((station) => station.lineId === line.id).sort(byCode),
    teams: input.teams.filter((team) => team.lineId === line.id).sort(byCode),
  })
  return [...input.sites].sort(byCode).map((site) => {
    const lines = input.lines.filter((line) => line.siteId === site.id).sort(byCode)
    const areas = input.areas
      .filter((area) => area.siteId === site.id)
      .sort((a, b) => a.sortOrder - b.sortOrder || byCode(a, b))
      .map((area) => ({ ...area, lines: lines.filter((line) => line.areaId === area.id).map(lineOf) }))
    const known = new Set(areas.map((area) => area.id))
    return {
      ...site,
      areas,
      linesWithoutArea: lines.filter((line) => line.areaId === null || !known.has(line.areaId)).map(lineOf),
      stationsWithoutLine: input.stations.filter((station) => station.siteId === site.id && station.lineId === null).sort(byCode),
      teamsWithoutLine: input.teams.filter((team) => team.siteId === site.id && team.lineId === null).sort(byCode),
    }
  })
}
