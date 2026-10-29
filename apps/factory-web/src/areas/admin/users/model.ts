import type { Role, User, UserRole, Worker } from '../shared/api'
import { grainsOf, matches, scopeWords, type Grain, type Loaded, type Notice, type ScopeChoice, type ScopeOption, type StepUpModel } from '../shared/model'

/**
 * SCR-010 Users (design 02 admin.users; PLT-014, PLT-015, PLT-018): everyone who signs in, by kind — office people
 * (invited by e-mail, two-factor, roles with where they apply) and floor workers (no e-mail: a badge and a PIN, floor
 * roles). Pure: the tiles' filters, the rows, what money each person sees, the invite and add-worker checks.
 */

export type Audience = 'office' | 'floor'
export const OFFICE_TILES = ['invited', 'noTwoFactor', 'suspended', 'deactivated'] as const
export const FLOOR_TILES = ['locked', 'noPin', 'noBadge', 'inactive'] as const
export type OfficeTile = (typeof OFFICE_TILES)[number]
export type FloorTile = (typeof FLOOR_TILES)[number]

export interface UsersAbilities {
  viewUsers: boolean
  /** users.invite (step-up). */
  invite: boolean
  /** roles.assign: an invitation may carry roles. */
  assign: boolean
  viewWorkers: boolean
  /** workers.manage: add a floor worker. */
  manageWorkers: boolean
  /** workers.roles (step-up): give a new worker floor roles. */
  workerRoles: boolean
}

export interface SiteOption {
  id: string
  name: string
  companyId: string
}

export type UsersDialog = 'invite' | 'add-worker'

export interface InviteResult {
  email: string
  outcome: 'sent' | 'already_sent' | 'refused'
  /** A refusal in words (a message key). */
  problem?: string
}

export interface UsersViewModel {
  prefix: string
  audience: Audience
  users: Loaded<User>
  workers: Loaded<Worker>
  /** The roles (for names, grains and the invite's cards); null while read or not readable. */
  roles: readonly Role[] | null
  companies: readonly ScopeOption[]
  sites: readonly SiteOption[]
  tile: OfficeTile | FloorTile | null
  query: string
  page: number
  asOf: string | null
  can: UsersAbilities
  notice?: Notice | null
  dialog?: UsersDialog | null
  busy?: boolean
  dialogProblem?: string | null
  inviteResults?: readonly InviteResult[] | null
  /** The worker just added (the dialog shows what to do next). */
  workerMade?: Worker | null
  stepUp?: StepUpModel
}

export function officeTileMatch(tile: OfficeTile, user: User): boolean {
  if (tile === 'invited') return user.status === 'INVITED'
  if (tile === 'noTwoFactor') return user.status === 'ACTIVE' && !user.mfaEnabled
  if (tile === 'suspended') return user.status === 'SUSPENDED'
  return user.status === 'DEACTIVATED'
}

export function floorTileMatch(tile: FloorTile, worker: Worker): boolean {
  if (tile === 'locked') return worker.locked
  if (tile === 'noPin') return worker.status === 'ACTIVE' && !worker.hasPin
  if (tile === 'noBadge') return worker.status === 'ACTIVE' && !worker.badge
  return worker.status === 'INACTIVE'
}

/** The office list: deactivated people only under their tile (they keep their name on history). */
export function officeRows(users: readonly User[], tile: OfficeTile | null, query: string): User[] {
  return users
    .filter((user) => (tile ? officeTileMatch(tile, user) : user.status !== 'DEACTIVATED'))
    .filter((user) => matches(query, user.displayName, user.email, ...user.roles.map((role) => role.roleName)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

export function floorRows(workers: readonly Worker[], tile: FloorTile | null, query: string, sites: readonly SiteOption[]): Worker[] {
  const siteName = (id: string) => sites.find((site) => site.id === id)?.name ?? ''
  return workers
    .filter((worker) => (tile ? floorTileMatch(tile, worker) : worker.status === 'ACTIVE'))
    .filter((worker) => matches(query, worker.displayName, worker.employeeCode, siteName(worker.siteId), ...worker.roles.map((role) => role.name)))
    .sort((a, b) => a.displayName.localeCompare(b.displayName))
}

/** What money a person sees: the grains of their live roles (unknown while the roles are not read). */
export function userGrains(user: Pick<User, 'roles'>, roles: readonly Role[] | null): Grain[] | null {
  if (!roles) return null
  return grainsOf(user.roles.map((held) => roles.find((role) => role.id === held.roleId) ?? { grains: [] }))
}

/** Where a person's roles apply, in words ("All companies", "Officina Demo S.r.l. › Plant 1"). */
export function whereWords(roles: readonly UserRole[], companies: readonly ScopeOption[], all: string): string | null {
  if (roles.length === 0) return null
  if (roles.some((role) => role.allCompanies)) return all
  const choice: ScopeChoice = { allCompanies: false, companyIds: [...new Set(roles.flatMap((role) => role.companyIds))], siteIds: [...new Set(roles.flatMap((role) => role.siteIds))] }
  return scopeWords(choice, companies, all) || null
}

/** The tiles' counts (each tile is a saved filter: pressing it filters the list). */
export function tileCounts(model: Pick<UsersViewModel, 'users' | 'workers'>): Record<string, number | null> {
  const users = model.users.items
  const workers = model.workers.items
  return {
    ...Object.fromEntries(OFFICE_TILES.map((tile) => [tile, users ? users.filter((user) => officeTileMatch(tile, user)).length : null])),
    ...Object.fromEntries(FLOOR_TILES.map((tile) => [tile, workers ? workers.filter((worker) => floorTileMatch(tile, worker)).length : null])),
  }
}

// ---- invite people ----

export interface InvitePerson {
  name: string
  email: string
}

export interface InviteDraft {
  people: InvitePerson[]
  roleIds: string[]
  scope: ScopeChoice
  locale: string
}

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

/** A name from an address's local part: "marco.rossi@…" → "Marco Rossi". */
export function nameFromEmail(email: string): string {
  const local = email.split('@')[0] ?? ''
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ')
}

/** Addresses pasted into one field ("a@example.com, b@example.com; c@example.com") as people rows. */
export function peopleFromPaste(text: string): InvitePerson[] {
  return text
    .split(/[\s,;]+/)
    .map((part) => part.trim().replace(/^<|>$/g, ''))
    .filter((part) => EMAIL.test(part))
    .map((email) => ({ email, name: nameFromEmail(email) }))
}

/** Field → message key ("people.0.email": the first person's address). */
export function inviteProblems(draft: InviteDraft, existing: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {}
  const taken = new Set(existing.map((email) => email.toLowerCase()))
  const seen = new Set<string>()
  const people = draft.people.filter((person) => person.name.trim() !== '' || person.email.trim() !== '')
  if (people.length === 0) out.people = 'users.invite.nobody'
  draft.people.forEach((person, index) => {
    if (person.name.trim() === '' && person.email.trim() === '') return
    const email = person.email.trim().toLowerCase()
    if (!EMAIL.test(email)) out[`people.${index}.email`] = 'form.email'
    else if (taken.has(email)) out[`people.${index}.email`] = 'users.invite.exists'
    else if (seen.has(email)) out[`people.${index}.email`] = 'users.invite.twice'
    seen.add(email)
    if (person.name.trim() === '') out[`people.${index}.name`] = 'form.required'
  })
  if (draft.roleIds.length > 0 && !draft.scope.allCompanies && draft.scope.companyIds.length === 0) out.scope = 'users.invite.scopeNeeded'
  return out
}

export const invitees = (draft: InviteDraft) => draft.people.filter((person) => person.email.trim() !== '')

// ---- add a floor worker ----

export interface WorkerDraft {
  displayName: string
  locale: string
  employeeCode: string
  siteId: string
  roleIds: string[]
}

export function workerProblems(draft: WorkerDraft): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.displayName.trim() === '') out.displayName = 'form.required'
  if (!draft.siteId) out.siteId = 'form.required'
  if (draft.employeeCode.trim().length > 32) out.employeeCode = 'form.tooLong'
  return out
}

/** The floor languages a worker may speak on a tablet (PLT-062): the office two and the floor's common ones. */
export const FLOOR_LOCALES = ['it', 'en', 'ro', 'sq', 'ar', 'zh', 'ur', 'bn'] as const
