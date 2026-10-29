import type { Assignment, Role, User, Worker } from '../../shared/api'
import type { Loaded, Notice, ScopeChoice, ScopeOption, StepUpModel } from '../../shared/model'
import type { RevealModel } from '../../shared/view/OneTimeReveal'

/**
 * SCR-011 a person's record (design 02 admin.users "Record: User"; PLT-019, PLT-032, PLT-070): an office person —
 * Profile, Roles & scope (role × where × when; what they can do in plain words with their money sight), Activity — and
 * a floor worker — Profile, Badge & PIN (badges, the PIN's state and reset, floor roles), Activity. Sessions and the
 * partner organisation come in W2b. Pure: the last-administrator rule, the give-role summary, the worker's form.
 */

export const USER_TABS = ['profile', 'roles', 'activity'] as const
export type UserTab = (typeof USER_TABS)[number]
export const WORKER_TABS = ['profile', 'badge', 'activity'] as const
export type WorkerTab = (typeof WORKER_TABS)[number]

export type UserDialog = 'give-role' | 'end-role' | 'suspend' | 'reactivate' | 'deactivate' | 'password'

export interface UserAbilities {
  suspend: boolean
  reactivate: boolean
  deactivate: boolean
  resetPassword: boolean
  /** roles.assign: give and end roles. */
  assign: boolean
}

export interface UserRecordModel {
  prefix: string
  tab: UserTab
  user: User | null
  problem?: string | null
  /** The signed-in person (nobody changes their own roles or status). */
  me: string
  assignments: Loaded<Assignment>
  roles: readonly Role[] | null
  companies: readonly ScopeOption[]
  can: UserAbilities
  /** This person is the tenant's last administrator (an active person who gives roles over every company). */
  lastAdmin: boolean
  dialog?: UserDialog | null
  /** The assignment an "End" dialog ends. */
  endId?: string | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
  stepUp?: StepUpModel
  dockOpen?: boolean
}

/** The active people who give roles over every company (the tenant must keep one: users/status.ts, roles). */
export function administrators(users: readonly User[], roles: readonly Role[]): string[] {
  const assigning = new Set(roles.filter((role) => role.permissions.includes('roles.assign')).map((role) => role.id))
  return users.filter((user) => user.status === 'ACTIVE' && user.roles.some((held) => held.allCompanies && assigning.has(held.roleId))).map((user) => user.id)
}

export const isLastAdmin = (userId: string, users: readonly User[], roles: readonly Role[]) => {
  const admins = administrators(users, roles)
  return admins.length === 1 && admins[0] === userId
}

/** What a person may do with this record now, each with its reason when not (held, never hidden). */
export function lifecycleHeld(model: Pick<UserRecordModel, 'user' | 'me' | 'lastAdmin' | 'can'>): Record<'suspend' | 'reactivate' | 'deactivate' | 'password' | 'assign', string | null> {
  const self = model.user?.id === model.me
  const status = model.user?.status
  return {
    suspend: !model.can.suspend ? 'right.users_suspend' : self ? 'user.held.self' : status !== 'ACTIVE' ? 'user.held.notActive' : model.lastAdmin ? 'user.held.lastAdmin' : null,
    reactivate: !model.can.reactivate ? 'right.users_reactivate' : status !== 'SUSPENDED' ? 'user.held.notSuspended' : null,
    deactivate: !model.can.deactivate ? 'right.users_deactivate' : self ? 'user.held.self' : status === 'DEACTIVATED' ? 'user.held.deactivated' : model.lastAdmin ? 'user.held.lastAdmin' : null,
    password: !model.can.resetPassword ? 'right.users_resetPassword' : status !== 'ACTIVE' ? 'user.held.notActive' : null,
    assign: !model.can.assign ? 'right.roles_assign' : self ? 'user.held.selfRoles' : status === 'DEACTIVATED' ? 'user.held.deactivated' : null,
  }
}

export interface GiveRoleDraft {
  roleId: string
  scope: ScopeChoice
  validFrom: string
  validTo: string
}

/** Field → message key (empty: ready). Dates are optional; the end after the start. */
export function giveRoleProblems(draft: GiveRoleDraft): Record<string, string> {
  const out: Record<string, string> = {}
  if (!draft.roleId) out.roleId = 'form.required'
  if (!draft.scope.allCompanies && draft.scope.companyIds.length === 0) out.scope = 'users.invite.scopeNeeded'
  if (draft.validFrom && draft.validTo && draft.validTo <= draft.validFrom) out.validTo = 'user.give.endAfterStart'
  return out
}

/** Does the new role give more than the person holds now (the API then asks for a fresh code)? */
export function raises(roleId: string, held: readonly Assignment[], roles: readonly Role[]): boolean {
  const role = roles.find((item) => item.id === roleId)
  if (!role) return true
  const live = held.filter((assignment) => assignment.live).map((assignment) => roles.find((item) => item.id === assignment.roleId))
  const permissions = new Set(live.flatMap((item) => item?.permissions ?? []))
  const grains = new Set(live.flatMap((item) => item?.grains ?? []))
  return role.permissions.some((permission) => !permissions.has(permission)) || role.grains.some((grain) => !grains.has(grain))
}

/** A date input's value (YYYY-MM-DD) as the start or end instant of that day (UTC). */
export const dayStart = (date: string) => (date ? new Date(`${date}T00:00:00.000Z`).toISOString() : undefined)
export const dayEnd = (date: string) => (date ? new Date(`${date}T23:59:59.000Z`).toISOString() : undefined)

// ---- a floor worker ----

export type WorkerDialog = 'badge' | 'lost' | 'pin' | 'roles' | 'deactivate' | 'reactivate'

export interface WorkerAbilities {
  /** workers.manage: name, language, employee number, deactivate. */
  manage: boolean
  /** workers.credentials (step-up): badge and PIN. */
  credentials: boolean
  /** workers.roles (step-up): floor roles. */
  roles: boolean
}

export interface WorkerProfileDraft {
  displayName: string
  locale: string
  employeeCode: string
}

export interface WorkerRecordModel {
  prefix: string
  tab: WorkerTab
  worker: Worker | null
  problem?: string | null
  siteName: string | null
  /** The floor roles (audience floor); null while read. */
  floorRoles: readonly Role[] | null
  me: string
  can: WorkerAbilities
  dialog?: WorkerDialog | null
  busy?: boolean
  dialogProblem?: string | null
  notice?: Notice | null
  /** A secret shown once (a badge code, a PIN). */
  reveal?: RevealModel | null
  stepUp?: StepUpModel
  draft?: WorkerProfileDraft | null
  dockOpen?: boolean
}

export const workerDraft = (worker: Worker): WorkerProfileDraft => ({ displayName: worker.displayName, locale: worker.locale, employeeCode: worker.employeeCode ?? '' })

export function workerProfileProblems(draft: WorkerProfileDraft): Record<string, string> {
  const out: Record<string, string> = {}
  if (draft.displayName.trim() === '') out.displayName = 'form.required'
  if (draft.employeeCode.trim().length > 32) out.employeeCode = 'form.tooLong'
  return out
}

/** Nobody manages the badge, PIN or roles of the worker linked to themselves (the API refuses it too). */
export const ownWorker = (worker: Worker | null, me: string) => !!worker?.userId && worker.userId === me
