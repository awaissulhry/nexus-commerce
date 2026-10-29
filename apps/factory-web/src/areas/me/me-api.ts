import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { isApiError, type ApiError } from '../../lib/api/errors'
import { signOut } from '../../lib/api/office'
import type { Locale } from '../../lib/i18n/locales'
import { otherProblem, passwordChangeProblem, totpConfirmProblem, totpDisableProblem, type MeProblem } from './me-model'

/**
 * SCR-007's calls (apps/factory-api platform/auth/office): the person's own language and password, and the
 * authenticator app. The office client sends the CSRF header and the company; each answer becomes what the card shows
 * next, or a problem in the page's words.
 */

export type Answer<T> = { ok: true; value: T } | { ok: false; problem: MeProblem }

async function call<T>(work: () => Promise<T>, problemOf: (error: ApiError) => MeProblem): Promise<Answer<T>> {
  try {
    return { ok: true, value: await work() }
  } catch (error) {
    if (!isApiError(error)) throw error
    return { ok: false, problem: problemOf(error) }
  }
}

const localeAnswer = z.object({ locale: z.string() })
const passwordAnswer = z.object({ status: z.literal('password_changed'), sessionsEnded: z.number() })
const setupAnswer = z.object({ secret: z.string(), otpauthUri: z.string() })
const confirmAnswer = z.object({ recoveryCodes: z.array(z.string()) })
const offAnswer = z.object({ status: z.literal('off') })

/** The person's interface language (PLT-127): the office speaks it from the next page on. */
export const setLocale = (api: ApiClient, locale: Locale) => call(() => api.post('/auth/office/locale', { body: { locale }, schema: localeAnswer }), otherProblem)

/** A new password (the current one first): every other session ends. */
export const changePassword = (api: ApiClient, input: { current: string; password: string }) =>
  call(() => api.post('/auth/office/password', { body: { currentPassword: input.current, password: input.password }, schema: passwordAnswer }), passwordChangeProblem)

/** Starts the set-up: a new secret and its `otpauth://` address for the QR code (nothing is on until confirmed). */
export const startTotpSetup = (api: ApiClient) => call(() => api.post('/auth/office/totp/setup', { body: {}, schema: setupAnswer }), otherProblem)

/** The app's first code switches it on and answers the 10 recovery codes, shown once. */
export const confirmTotp = (api: ApiClient, code: string) => call(() => api.post('/auth/office/totp/confirm', { body: { code }, schema: confirmAnswer }), totpConfirmProblem)

/** Switching the app off needs the password (and is refused when the person's role requires it). */
export const disableTotp = (api: ApiClient, password: string) => call(() => api.post('/auth/office/totp/disable', { body: { password }, schema: offAnswer }), totpDisableProblem)

/** Ends this browser's session (the API clears both cookies). */
export const signOutHere = (api: ApiClient) => call(() => signOut(api), otherProblem)
