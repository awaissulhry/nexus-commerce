import { totpCodeOf } from '@nexus/factory-domain/auth/totp/totp'
import type { ApiError, ApiIssue } from '../../lib/api/errors'
import type { OfficeMe } from '../../lib/api/office'
import { DEFAULT_TIME_ZONE } from '../../lib/i18n/format'
import { localeOf, DEFAULT_LOCALE, type Locale } from '../../lib/i18n/locales'
import type { ThemeMode } from '../../lib/theme/theme'

/**
 * SCR-007's rules without React (PLT-127, PLT-134, PLT-135, PLT-048, PLT-070): the profile's view model from
 * `GET /auth/office/me`, what each form asks before it is sent, and what an API refusal means for the person (a
 * message key of `me`, never the API's own words).
 */

export type MeProblem = 'wrongPassword' | 'wrongCode' | 'locked' | 'rateLimited' | 'passwordRefused' | 'changed' | 'unavailable' | 'signedOut'

/** A field's problem: a message key of `me` (`field.…` or the password rules' `auth:field.…`) and its parameters. */
export interface MeFieldProblem {
  key: string
  params?: Readonly<Record<string, string | number>>
}

export type PasswordCard =
  | { state: 'closed'; done?: { sessionsEnded: number } | null }
  | { state: 'open'; busy?: boolean; problem?: MeProblem | null; fieldErrors?: Readonly<Record<string, MeFieldProblem>> }

export type AuthenticatorCard =
  | { state: 'off'; required: boolean; busy?: boolean; problem?: MeProblem | null; turnedOff?: boolean }
  | { state: 'setup'; secret: string; otpauthUri: string; busy?: boolean; problem?: MeProblem | null; fieldErrors?: Readonly<Record<string, MeFieldProblem>> }
  /** Shown once, right after the app was switched on. */
  | { state: 'codes'; recoveryCodes: readonly string[] }
  | { state: 'on'; required: boolean; recoveryCodesLeft: number; turnedOn?: boolean }
  | { state: 'disable'; busy?: boolean; problem?: MeProblem | null; fieldErrors?: Readonly<Record<string, MeFieldProblem>> }

export interface MyProfileViewModel {
  person: { displayName: string; email: string }
  /** The tenant's name (the company group the person signed in to). */
  tenant: string
  locale: Locale
  theme: ThemeMode
  /** The site's time zone (W0: the default; sites come with SCR-009). */
  timeZone: string
  language?: { busy?: boolean; problem?: MeProblem | null }
  password: PasswordCard
  authenticator: AuthenticatorCard
  /** This browser's session (the API lists no other yet: PLT-064 is a later wave). */
  session: { createdAt: string; idleExpiresAt: string; absoluteExpiresAt: string }
  signOut?: { busy?: boolean; problem?: MeProblem | null }
  /** Put the focus in a form's first field when it opens (the live page; not the design frames). */
  autoFocus?: boolean
}

/** Fewer than this many recovery codes left: the card says so. */
export const RECOVERY_LOW = 3

/** The authenticator card at rest, from `me`. */
export function authenticatorAtRest(mfa: OfficeMe['mfa']): AuthenticatorCard {
  return mfa.enabled ? { state: 'on', required: mfa.required, recoveryCodesLeft: mfa.recoveryCodesLeft } : { state: 'off', required: mfa.required }
}

/** The profile at rest (no form open) for a signed-in person. */
export function profileModel(me: OfficeMe, theme: ThemeMode): MyProfileViewModel {
  return {
    person: { displayName: me.user.displayName, email: me.user.email },
    tenant: me.tenant.name,
    locale: localeOf(me.user.locale) ?? DEFAULT_LOCALE,
    theme,
    timeZone: DEFAULT_TIME_ZONE,
    password: { state: 'closed' },
    authenticator: authenticatorAtRest(me.mfa),
    session: { createdAt: me.session.createdAt, idleExpiresAt: me.session.idleExpiresAt, absoluteExpiresAt: me.session.absoluteExpiresAt },
  }
}

const pathOf = (issue: ApiIssue | { path?: unknown }): string => {
  const path = (issue as { path?: unknown }).path
  return Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : ''
}
const names = (error: ApiError, field: string) => error.issues.some((issue) => pathOf(issue) === field)

/** What every refusal shares: the session ended, too many tries, the API away. */
function common(error: ApiError): MeProblem | null {
  if (error.kind === 'signed_out') return 'signedOut'
  if (error.kind === 'rate_limited') return 'rateLimited'
  if (error.kind === 'conflict') return 'changed'
  if (error.kind === 'unavailable' || error.kind === 'internal' || error.kind === 'contract') return 'unavailable'
  return null
}

/** A new password refused: the current one wrong, the new one too easy, or the account locked (403). */
export function passwordChangeProblem(error: ApiError): MeProblem {
  if (error.kind === 'forbidden') return 'locked'
  if (error.kind === 'invalid') return names(error, 'currentPassword') ? 'wrongPassword' : names(error, 'password') ? 'passwordRefused' : 'unavailable'
  return common(error) ?? 'unavailable'
}

/** The app's first code refused (it does not match the new secret), or the set-up changed meanwhile. */
export function totpConfirmProblem(error: ApiError): MeProblem {
  if (error.kind === 'invalid') return 'wrongCode'
  return common(error) ?? 'unavailable'
}

/** Switching the app off refused: the password wrong, the account locked, or it may not be switched off (409). */
export function totpDisableProblem(error: ApiError): MeProblem {
  if (error.kind === 'forbidden') return 'locked'
  if (error.kind === 'invalid') return 'wrongPassword'
  return common(error) ?? 'unavailable'
}

/** Anything else (the language, starting the set-up, signing out). */
export function otherProblem(error: ApiError): MeProblem {
  return common(error) ?? 'unavailable'
}

export function checkCurrentPassword(current: string): Readonly<Record<string, MeFieldProblem>> {
  return current === '' ? { current: { key: 'field.currentRequired' } } : {}
}

export function checkTotpCode(code: string): Readonly<Record<string, MeFieldProblem>> {
  return totpCodeOf(code) === null ? { code: { key: 'field.codeFormat' } } : {}
}

/** The setup key in groups of four, as authenticator apps show it and people type it. */
export function groupedSecret(secret: string): string {
  return secret.replace(/\s+/g, '').replace(/(.{4})(?=.)/g, '$1 ')
}
