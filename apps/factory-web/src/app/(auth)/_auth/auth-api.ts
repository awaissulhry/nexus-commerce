import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { isApiError, type ApiError } from '../../../lib/api/errors'
import { fetchOfficeMe, type OfficeMe } from '../../../lib/api/office'
import { companyPrefix } from '../../../lib/session/session'
import { landingCompany } from '../../../lib/session/scope-memory'
import { newPasswordProblem, signInProblem, type AuthProblem } from './auth-model'

/**
 * SCR-001's calls to the office sign-in API (apps/factory-api platform/auth/{office,invitations,sessions}), each turned
 * into what the page does next. Every call goes through the API client (`/api/<route>`, the CSRF header read from the
 * API's cookie); each flow first asks `GET /auth/csrf`, so the double-submit cookie exists before the write. Tokens
 * (reset, invitation) go only in a request body; passwords never leave these calls.
 */

const signInAnswer = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_in') }),
  z.object({ status: z.literal('totp_required') }),
  z.object({ status: z.literal('password_change_required'), resetToken: z.string(), expiresAt: z.string() }),
])
const done = z.object({ status: z.string() })
type MeWithCompanies = Pick<OfficeMe, 'user' | 'tenant' | 'company' | 'mfa'> & { companies?: readonly { code: string }[] }
const invitationPreview = z.object({ tenant: z.object({ name: z.string() }), email: z.string(), displayName: z.string(), expiresAt: z.string() })
export type InvitationPreview = z.infer<typeof invitationPreview>

/** A session is open: where it goes, and the company's sign-in name to remember on this device. */
export interface OpenSession {
  kind: 'open'
  tenantSlug: string
  /** The office's entry (`/w/<company>`): the first page the person may open (shell/office/office-entry.ts). */
  entry: string
  /** The authenticator set-up on the person's profile (`/w/<company>/me#authenticator`). */
  authenticator: string
  /** Where it opens: the set-up while the person's role needs two-factor they have not set up, else the entry. */
  to: string
  mfaRequired: boolean
}

export type Refused = { kind: 'problem'; problem: AuthProblem }
export type SignInOutcome = OpenSession | Refused | { kind: 'code' } | { kind: 'change'; resetToken: string }

const refused = (problem: AuthProblem): Refused => ({ kind: 'problem', problem })

/**
 * Where a new session opens (PLT-003): the company this person last worked in on this device when they may still open
 * it, else the session's own, else the first their roles reach (a tenant of several companies starts a session in none).
 */
export function sessionPlaces(me: MeWithCompanies, scopeCookie: string | null | undefined): OpenSession | Refused {
  const own = me.company?.code ?? null
  const codes = me.companies?.length ? me.companies.map((company) => company.code) : own ? [own] : []
  const company = landingCompany(scopeCookie, { tenantId: me.tenant.id, userId: me.user.id }, own, codes)
  if (!company) return refused('noCompany')
  const entry = companyPrefix(company)
  const authenticator = `${companyPrefix(company)}/me#authenticator`
  const setupFirst = me.mfa.required && !me.mfa.enabled
  return { kind: 'open', tenantSlug: me.tenant.slug, entry, authenticator, to: setupFirst ? authenticator : entry, mfaRequired: me.mfa.required }
}

async function openSession(api: ApiClient, scopeCookie: string | null | undefined): Promise<OpenSession | Refused> {
  return sessionPlaces(await fetchOfficeMe(api), scopeCookie)
}

/** Rethrows anything that is not an API answer (a bug), so it is seen. */
function apiErrorOf(error: unknown): ApiError {
  if (isApiError(error)) return error
  throw error
}

/**
 * Sign-in (PLT-047, PLT-048): company, email and password, and — once the API answered `totp_required` — the same
 * again with a code from the app or a recovery code. The API may instead ask for a new password first (an
 * administrator required one, PLT-070): `change`, with the reset token it gave.
 */
export async function signIn(
  api: ApiClient,
  input: { company: string; email: string; password: string; code?: string },
  scopeCookie?: string | null,
): Promise<SignInOutcome> {
  try {
    await api.get('/auth/csrf')
    const body = { tenant: input.company.trim(), email: input.email.trim(), password: input.password, ...(input.code === undefined ? {} : { code: input.code }) }
    const answer = await api.post('/auth/office/sign-in', { body, schema: signInAnswer })
    if (answer.status === 'totp_required') return { kind: 'code' }
    if (answer.status === 'password_change_required') return { kind: 'change', resetToken: answer.resetToken }
    return await openSession(api, scopeCookie)
  } catch (error) {
    return refused(signInProblem(apiErrorOf(error), input.code === undefined ? 'password' : 'code'))
  }
}

/**
 * The new password an administrator required (PLT-070): set with the token the sign-in gave, then signed in with it
 * at once (a code follows when the person has the app). A token that ran out sends the person back to sign-in.
 */
export async function chooseRequiredPassword(
  api: ApiClient,
  input: { resetToken: string; company: string; email: string; password: string },
  scopeCookie?: string | null,
): Promise<SignInOutcome> {
  try {
    await api.get('/auth/csrf')
    await api.post('/auth/office/password/reset', { body: { token: input.resetToken, password: input.password }, schema: done })
  } catch (error) {
    const problem = newPasswordProblem(apiErrorOf(error))
    return refused(problem === 'link-invalid' ? 'changeExpired' : problem)
  }
  return signIn(api, { company: input.company, email: input.email, password: input.password }, scopeCookie)
}

/** A reset link by email (PLT-070). The API answers the same for every address, so the page does too. */
export async function requestReset(api: ApiClient, input: { company: string; email: string }): Promise<{ kind: 'sent' } | Refused> {
  try {
    await api.get('/auth/csrf')
    await api.post('/auth/office/password/reset-request', { body: { tenant: input.company.trim(), email: input.email.trim() }, schema: done })
    return { kind: 'sent' }
  } catch (error) {
    const kind = apiErrorOf(error).kind
    return refused(kind === 'rate_limited' ? 'rateLimited' : kind === 'invalid' ? 'invalid' : 'unavailable')
  }
}

/** The new password from a mailed reset link: every session of the person ends (the API's rule). */
export async function confirmReset(api: ApiClient, input: { token: string; password: string }): Promise<{ kind: 'done' } | { kind: 'link-invalid' } | Refused> {
  try {
    await api.get('/auth/csrf')
    await api.post('/auth/office/password/reset', { body: { token: input.token, password: input.password }, schema: done })
    return { kind: 'done' }
  } catch (error) {
    const problem = newPasswordProblem(apiErrorOf(error))
    return problem === 'link-invalid' ? { kind: 'link-invalid' } : refused(problem)
  }
}

/** What an invitation link opens (PLT-015): one 404 for used, expired, withdrawn or unknown. */
export async function previewInvitation(api: ApiClient, token: string): Promise<{ kind: 'invitation'; invitation: InvitationPreview } | { kind: 'link-invalid' } | Refused> {
  try {
    return { kind: 'invitation', invitation: await api.post('/auth/invitations/preview', { body: { token }, schema: invitationPreview }) }
  } catch (error) {
    const kind = apiErrorOf(error).kind
    if (kind === 'not_found') return { kind: 'link-invalid' }
    return refused(kind === 'rate_limited' ? 'rateLimited' : 'unavailable')
  }
}

/** Accepting sets the password and opens a session at once; the authenticator set-up is offered next. */
export async function acceptInvitation(
  api: ApiClient,
  input: { token: string; displayName: string; password: string },
  scopeCookie?: string | null,
): Promise<OpenSession | { kind: 'link-invalid' } | Refused> {
  try {
    await api.get('/auth/csrf')
    await api.post('/auth/invitations/accept', { body: { token: input.token, password: input.password, displayName: input.displayName.trim() }, schema: done })
  } catch (error) {
    const problem = newPasswordProblem(apiErrorOf(error))
    return problem === 'link-invalid' ? { kind: 'link-invalid' } : refused(problem)
  }
  try {
    return await openSession(api, scopeCookie)
  } catch (error) {
    return refused(signInProblem(apiErrorOf(error), 'password'))
  }
}
