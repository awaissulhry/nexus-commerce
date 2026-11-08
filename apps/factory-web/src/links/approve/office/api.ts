import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { fetchOfficeMe, type OfficeMe } from '../../../lib/api/office'

/**
 * PLT-089 — an office approval opened from its e-mail (`/l/approve#key=am1…`; apps/factory-api modules/insights/sources/
 * approvals-mail.ts, B-W2b-184). The key names ONE notification of ONE person and grants nothing: the page asks for the
 * office sign-in (the office's own, with its two-factor rule), then `POST /approvals/mail-open {key}` answers where the
 * approval opens (the record and the notification's anchor) and whether it still waits. The decision itself is taken on
 * the office's own page, behind the person's grants and grains (the mail carries no figure). Another person's key, a
 * forwarded mail or a forged key gets the one 404.
 */

export const signInAnswerSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('signed_in') }),
  z.object({ status: z.literal('totp_required') }),
  z.object({ status: z.literal('password_change_required'), resetToken: z.string(), expiresAt: z.string() }),
])
export type SignInAnswer = z.infer<typeof signInAnswerSchema>

export const mailOpenSchema = z.object({
  record: z.object({ type: z.string(), id: z.string(), label: z.string() }),
  companyId: z.string().nullable(),
  anchor: z.string().nullable(),
  messageKey: z.string(),
  waiting: z.boolean(),
})
export type MailOpen = z.infer<typeof mailOpenSchema>

/** The office session, if there is one (a 401 means none). */
export function readOfficeMe(api: ApiClient): Promise<OfficeMe> {
  return fetchOfficeMe(api)
}

/** The office sign-in (`GET /auth/csrf` first, so the double-submit cookie exists before the write). */
export async function officeSignIn(api: ApiClient, input: { company: string; email: string; password: string; code?: string }): Promise<SignInAnswer> {
  await api.get('/auth/csrf')
  const body = { tenant: input.company.trim(), email: input.email.trim(), password: input.password, ...(input.code === undefined ? {} : { code: input.code }) }
  return api.post('/auth/office/sign-in', { body, schema: signInAnswerSchema })
}

/** Where the mailed approval opens, for its own person only. */
export function openFromMail(api: ApiClient, key: string): Promise<MailOpen> {
  return api.post('/approvals/mail-open', { body: { key }, schema: mailOpenSchema })
}

/** Ends this browser's office session (another person signs in on this device). */
export function officeSignOut(api: ApiClient): Promise<unknown> {
  return api.post('/auth/office/sign-out', { body: {} })
}
