import { z } from 'zod'
import type { ApiClient } from './client'

/**
 * The office session as `GET /auth/office/me` answers it (apps/factory-api platform/auth/office/contract.ts `meContract`).
 * The web reads only what it uses; unknown fields are ignored, so a new field on the API never breaks a page.
 */
export const officeMeSchema = z.object({
  user: z.object({ id: z.string(), email: z.string(), displayName: z.string(), locale: z.string() }),
  tenant: z.object({ id: z.string(), slug: z.string(), name: z.string() }),
  company: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  /** The active companies the person's live roles reach, by code (before two-factor is proved too). */
  companies: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })).default([]),
  /** B-W2b-05: the screen company's active sites the person's roles reach (the top bar's switcher), and whether that is every site. */
  sites: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })).optional(),
  allSites: z.boolean().optional(),
  session: z.object({
    id: z.string(),
    createdAt: z.string(),
    idleExpiresAt: z.string(),
    absoluteExpiresAt: z.string(),
    stepUpUntil: z.string().nullable(),
  }),
  mfa: z.object({ enabled: z.boolean(), required: z.boolean(), satisfied: z.boolean(), recoveryCodesLeft: z.number() }),
  /** What the session's grants allow; the web hides what is not listed (the API refuses it anyway). */
  permissions: z.array(z.string()),
})
export type OfficeMe = z.infer<typeof officeMeSchema>

/** The person, tenant, company (the `x-factory-company` one, else the session's), session and permissions. */
export function fetchOfficeMe(api: ApiClient, signal?: AbortSignal): Promise<OfficeMe> {
  return api.get('/auth/office/me', { schema: officeMeSchema, signal })
}

/** Ends this browser's office session (the API clears both cookies). Needs the CSRF header: use the browser client. */
export function signOut(api: ApiClient): Promise<unknown> {
  return api.post('/auth/office/sign-out', { body: {} })
}
