import { recoveryCodeOf, totpCodeOf } from '@nexus/factory-domain/auth/totp/totp'
import type { ApiError, ApiIssue } from '../../../lib/api/errors'

/**
 * SCR-001's rules without React (PLT-047, PLT-048, PLT-070, PLT-015): what each form asks before it is sent, what an
 * API refusal means for the person (a message key of `auth`, never the API's own words), and the token of a mailed
 * link.
 *
 * Sign-in never says WHICH part was wrong: the API answers an unknown company, an unknown email, a wrong password and a
 * locked account with the same 401, and this page says so in one sentence that names all three and the lock.
 */

/** The page cookie that keeps the company's sign-in name on this device (not secret; PLT-047). */
export const TENANT_COOKIE = 'factory_tenant'

/**
 * The password rules the API applies (factory-domain auth/password `passwordProblems`), mirrored here because that
 * module hashes with node:crypto and cannot reach the browser; `auth-model.vitest.test.ts` holds the mirror to it. The
 * list of well-known passwords stays on the API: its refusal is `problem.passwordRefused`.
 */
export const PASSWORD_RULES = Object.freeze({ min: 12, max: 256, distinct: 4, namePart: 4 })

/** A field's problem: a message key of `auth` (`field.…`) and its parameters. */
export interface FieldProblem {
  key: string
  params?: Readonly<Record<string, string | number>>
}

export type FieldProblems<F extends string> = Partial<Record<F, FieldProblem>>

const problem = (key: string, params?: FieldProblem['params']): FieldProblem => (params ? { key, params } : { key })

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

function emailProblem(email: string): FieldProblem | undefined {
  const value = email.trim()
  if (value === '') return problem('field.emailRequired')
  if (value.length > 320 || !EMAIL.test(value)) return problem('field.emailFormat')
  return undefined
}

const clean = <F extends string>(problems: FieldProblems<F>): FieldProblems<F> =>
  Object.fromEntries(Object.entries(problems).filter(([, value]) => value !== undefined)) as FieldProblems<F>

export function checkSignIn(values: { company: string; email: string; password: string }): FieldProblems<'company' | 'email' | 'password'> {
  return clean({
    company: values.company.trim() === '' ? problem('field.companyRequired') : undefined,
    email: emailProblem(values.email),
    password: values.password === '' ? problem('field.passwordRequired') : undefined,
  })
}

export function checkForgot(values: { company: string; email: string }): FieldProblems<'company' | 'email'> {
  return clean({ company: values.company.trim() === '' ? problem('field.companyRequired') : undefined, email: emailProblem(values.email) })
}

/** A code from the app (6 digits; spaces allowed) or, in recovery mode, a recovery code (`ABCDE-23456`). */
export function codeOf(input: string, recovery: boolean): string | null {
  return recovery ? recoveryCodeOf(input) : totpCodeOf(input)
}

export function checkCode(code: string, recovery: boolean): FieldProblems<'code'> {
  return codeOf(code, recovery) === null ? { code: problem(recovery ? 'field.recoveryFormat' : 'field.codeFormat') } : {}
}

/** A new password as the API will judge it (all but the list of well-known passwords), and its repetition. */
export function checkNewPassword(
  values: { password: string; confirmation: string },
  person: { email?: string | null; displayName?: string | null } = {},
): FieldProblems<'password' | 'confirmation'> {
  const value = values.password.normalize('NFKC')
  const length = [...value].length
  const lower = value.toLowerCase()
  const parts = [person.email?.split('@')[0], person.email, ...(person.displayName?.split(/\s+/) ?? [])]
    .map((part) => part?.trim().toLowerCase() ?? '')
    .filter((part) => part.length >= PASSWORD_RULES.namePart)
  let password: FieldProblem | undefined
  if (length < PASSWORD_RULES.min) password = problem('field.passwordShort', { min: PASSWORD_RULES.min })
  else if (length > PASSWORD_RULES.max) password = problem('field.passwordLong', { max: PASSWORD_RULES.max })
  else if (value.trim() === '' || new Set(lower).size < PASSWORD_RULES.distinct) password = problem('field.passwordSimple')
  else if (parts.some((part) => lower.includes(part))) password = problem('field.passwordName')
  return clean({ password, confirmation: !password && values.confirmation !== values.password ? problem('field.repeatMismatch') : undefined })
}

export function checkInvitation(values: { displayName: string; password: string; confirmation: string }, email: string): FieldProblems<'displayName' | 'password' | 'confirmation'> {
  return clean({
    displayName: values.displayName.trim() === '' ? problem('field.nameRequired') : undefined,
    ...checkNewPassword(values, { email, displayName: values.displayName }),
  })
}

/** The path of an API issue, whichever shape it came in (the API sends a dotted string). */
export function issuePath(issue: ApiIssue | { path?: unknown }): string {
  const path = (issue as { path?: unknown }).path
  return Array.isArray(path) ? path.join('.') : typeof path === 'string' ? path : ''
}

/** An API refusal or a network failure, as the sentence the page shows (`problem.…`). */
export type AuthProblem =
  | 'wrongCredentials'
  | 'wrongCode'
  | 'suspended'
  | 'rateLimited'
  | 'unavailable'
  | 'passwordRefused'
  | 'changeExpired'
  | 'noCompany'
  | 'invalid'

/** Why a sign-in failed, without telling which part was wrong (`stage`: the password form or the code form). */
export function signInProblem(error: ApiError, stage: 'password' | 'code'): AuthProblem {
  switch (error.kind) {
    case 'signed_out':
      return stage === 'code' ? 'wrongCode' : 'wrongCredentials'
    case 'forbidden':
      // 403 after a right password: the account is suspended. (A missing CSRF cookie is re-asked before each try.)
      return 'suspended'
    case 'rate_limited':
      return 'rateLimited'
    case 'invalid':
      return 'invalid'
    default:
      return 'unavailable'
  }
}

/** Why a new password (reset link, forced change, invitation) was refused. */
export function newPasswordProblem(error: ApiError): AuthProblem | 'link-invalid' {
  if (error.kind === 'not_found') return 'link-invalid'
  if (error.kind === 'invalid' && error.issues.some((issue) => issuePath(issue) === 'password')) return 'passwordRefused'
  if (error.kind === 'invalid') return 'invalid'
  if (error.kind === 'rate_limited') return 'rateLimited'
  return 'unavailable'
}

const TOKEN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/i

/**
 * The token of a mailed link (`/reset-password#token=…`, `/accept-invitation#token=…`; the API's `<tenant>.<user>.
 * <secret>`). It travels in the address's fragment, which no server or log sees; the page removes it from the address
 * bar and sends it only in a request body. Null for anything that is not one.
 */
export function tokenFromFragment(hash: string | null | undefined): string | null {
  if (!hash) return null
  const params = new URLSearchParams(hash.replace(/^#/, ''))
  const token = params.get('token')?.trim() ?? ''
  return TOKEN.test(token) ? token : null
}
