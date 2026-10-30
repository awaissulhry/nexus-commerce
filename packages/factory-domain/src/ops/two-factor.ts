import type { Issue } from '../core/errors'
import type { Grain } from '../auth/grains/grains'
import { LOCKOUT } from '../auth/lockout/lockout'
import { templateOf } from '../auth/roles/templates'

/**
 * Two-factor per role (B-W2a-36; PLT-045 "MFA required per role"; design admin.security "Sign-in rules" and admin.roles
 * Role › Scope rules › Two-factor), pure. Role.requireMfa exists since W0 (a role that requires it gives nothing until
 * two-factor is proved on the session); this is the switch, with the rules that keep it safe:
 *
 *   - an office role only (the floor's factors are the device and the PIN);
 *   - a role that sees costs or margins always asks for it (W0 rule), and a ready-made role never asks less than its
 *     template (Owner, Administrator, Finance …): the tenant may ASK it of any other ready-made role, and the template
 *     sync keeps that (platform/auth/roles system-roles.ts);
 *   - nobody changes the rule of a role they hold (separation of duties, as for any role edit);
 *   - never lock the group out: a change that would leave no active administrator able to work now (two-factor set up,
 *     or not asked of them) is refused in words, so somebody can always fix people and roles;
 *   - it applies at each holder's next sign-in, never mid-session: a session that started before the rule was switched
 *     on keeps the role until it ends (the session's own idle and absolute limits); the person is asked to set up
 *     two-factor when they next sign in;
 *   - every change is roles.manage, a step-up permission: it asks for a fresh code, and shows who it affects first.
 */

/** The audit action of a role's two-factor change (the grace rule of platform/auth/sessions reads it). */
export const TWO_FACTOR_ACTION = 'security.setRoleTwoFactor'

export interface TwoFactorRole {
  readonly id: string
  readonly key: string
  readonly system: boolean
  readonly audience: 'office' | 'floor'
  readonly requireMfa: boolean
  readonly grains: readonly (Grain | string)[]
}

/** Why a role's two-factor rule cannot be turned off (a message key's last part), or null when it can. */
export type TwoFactorLock = 'floor' | 'money' | 'template'

export function twoFactorLockOf(role: TwoFactorRole): TwoFactorLock | null {
  if (role.audience === 'floor') return 'floor'
  if (role.grains.some((grain) => grain === 'cost' || grain === 'margin')) return 'money'
  if (role.system && templateOf(role.key)?.requireMfa === true) return 'template'
  return null
}

/** Every refusal of a two-factor change, in words (the web says them in its own; codes travel). */
export const TWO_FACTOR_REFUSALS = Object.freeze({
  floor: "A floor role never asks for two-factor: the tablet and the PIN are the floor's factors.",
  money: 'A role that sees costs or margins always asks for two-factor.',
  template: 'This ready-made role always asks for two-factor.',
  already: 'This role asks for two-factor already.',
  notAsked: 'This role does not ask for two-factor.',
  held: 'You hold this role: ask another administrator to change its two-factor rule.',
  stale: 'This role changed meanwhile: read it again.',
  lockOut: 'Nobody could manage people and roles until they set up two-factor: first, one administrator sets up two-factor on My profile, then ask it of this role.',
})
export type TwoFactorRefusal = keyof typeof TWO_FACTOR_REFUSALS

/** Why asking (or no longer asking) two-factor of this role is refused by its own content, or null. */
export function twoFactorRefusal(role: TwoFactorRole, requireMfa: boolean): TwoFactorRefusal | null {
  if (role.audience === 'floor') return 'floor'
  if (role.requireMfa === requireMfa) return requireMfa ? 'already' : 'notAsked'
  const lock = twoFactorLockOf(role)
  return !requireMfa && lock ? lock : null
}

/** What is wrong with asking (or no longer asking) two-factor of this role (path `changes/<index>`). */
export function twoFactorProblems(role: TwoFactorRole, requireMfa: boolean, index = 0): Issue[] {
  const code = twoFactorRefusal(role, requireMfa)
  return code ? [{ path: `changes/${index}`, message: TWO_FACTOR_REFUSALS[code] }] : []
}

/** An active administrator as the lock-out rule sees them: their two-factor, and the administrator roles they hold. */
export interface AdminSubject {
  readonly userId: string
  /** Two-factor is set up (a confirmed authenticator). */
  readonly twoFactor: boolean
  /** The person's own flag (User.requireMfa). */
  readonly requireMfa: boolean
  /** The roles that make them an administrator (roles.assign over every company). */
  readonly adminRoleIds: readonly string[]
}

/**
 * The administrators who can work now: two-factor set up, or one of their administrator roles does not ask for it (and
 * neither does their own flag). `asks(roleId)` says whether a role asks for two-factor (after the change being weighed).
 */
export function workingAdmins(admins: readonly AdminSubject[], asks: (roleId: string) => boolean): string[] {
  return admins.filter((admin) => admin.twoFactor || (!admin.requireMfa && admin.adminRoleIds.some((roleId) => !asks(roleId)))).map((admin) => admin.userId)
}

/**
 * Never lock the group out: the change is refused when administrators can work before it and none could after it. A
 * group whose administrators all wait for two-factor already is not made worse by it.
 */
export function strandsAdmins(admins: readonly AdminSubject[], before: (roleId: string) => boolean, after: (roleId: string) => boolean): boolean {
  return workingAdmins(admins, before).length > 0 && workingAdmins(admins, after).length === 0
}

export const LOCK_OUT_WORDS = TWO_FACTOR_REFUSALS.lockOut

/** A holder of a role, as "who it affects" lists them. */
export interface TwoFactorHolder {
  readonly userId: string
  readonly name: string
  readonly twoFactor: boolean
}

/** Who a change affects: asking two-factor reaches the holders without it (asked at their next sign-in). */
export function affectedHolders(holders: readonly TwoFactorHolder[], requireMfa: boolean): TwoFactorHolder[] {
  const unique = [...new Map(holders.map((holder) => [holder.userId, holder])).values()]
  return (requireMfa ? unique.filter((holder) => !holder.twoFactor) : unique).sort((a, b) => a.name.localeCompare(b.name))
}

/** The fixed sign-in rules the Security page shows (PLT-047): facts, not settings. */
export const SIGN_IN_RULES = Object.freeze({
  lockout: { afterFailures: LOCKOUT.maxFailures, firstLockMinutes: LOCKOUT.firstLockMs / 60_000, maxLockMinutes: LOCKOUT.maxLockMs / 60_000 },
})
