import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'

/**
 * PLT-089 "approve from e-mail" — the person's own switch (apps/factory-api modules/insights/sources/approvals-mail.ts,
 * B-W2b-184): `GET|PUT /approvals/mail-me {on}`. On, the approvals that wait for this person's decision (Home ›
 * Approvals) reach them by e-mail as they come, each with a link that opens it after the office sign-in; nothing is
 * mailed unless the person turned it on (PLT-142). Office only (home.view).
 */

export const mailMeSchema = z.object({ on: z.boolean(), since: z.string().nullable(), lastSentAt: z.string().nullable(), version: z.number() })
export type MailMe = z.infer<typeof mailMeSchema>

export function readMailMe(api: ApiClient, signal?: AbortSignal): Promise<MailMe> {
  return api.get('/approvals/mail-me', { schema: mailMeSchema, signal })
}

export function setMailMe(api: ApiClient, on: boolean): Promise<MailMe> {
  return api.request('PUT', '/approvals/mail-me', { body: { on }, schema: mailMeSchema, idempotencyKey: newIdempotencyKey() })
}
