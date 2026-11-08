import { z } from 'zod'
import { portalSignInHead, type PortalSignInHead } from '@nexus/factory-domain/branding/contracts'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { isApiError } from '../../lib/api/errors'
import type { Locale } from '../../lib/i18n/locales'
import { wantsChallenge, type PortalAddress, type SignInPolicy, type Summaries } from './model'
import { solveChallenge } from './pow'

/**
 * SCR-026's calls (B-W2b-164) to the API of B-W2b-159 (apps/factory-api platform/auth/portal), B-W2b-167 (the e-mail
 * settings), B-W2b-161 + this step (the sign-in head, platform/branding portal-head.ts) and W1 (the public privacy notice).
 * Every call goes through the API client (`/api/<route>`; the CSRF header read from the API's cookie, so each flow asks
 * `GET /auth/csrf` first). Codes and link tokens go only in request bodies; nothing here keeps them.
 */

export type SignInHead = PortalSignInHead

const headAnswer = z.object({ head: portalSignInHead })

/** Whose portal this is (by the address of the invitation mail, or by the company of the mailed link). */
export function readHead(api: ApiClient, by: PortalAddress | { companyId: string }): Promise<SignInHead> {
  const query = 'companyId' in by ? { companyId: by.companyId } : { tenant: by.tenant, company: by.company || undefined }
  return api.get('/branding/portal-sign-in', { query, schema: headAnswer }).then((answer) => answer.head)
}

const person = z.object({ id: z.string(), email: z.string(), displayName: z.string(), locale: z.string() })
/** `code` arrives with the portal frame (B-W2b-173); before it the frame takes the party's id. */
const party = z.object({ id: z.string(), name: z.string(), code: z.string().optional() })
const company = z.object({ id: z.string(), code: z.string(), name: z.string() })

/** A portal session as the sign-in page needs it. */
export const signedIn = z.object({ user: person, party, company, termsDue: z.boolean() })
export type SignedIn = z.infer<typeof signedIn>

/** The portal session of this browser (the portal cookie only), or null when there is none. */
export async function readSession(api: ApiClient): Promise<SignedIn | null> {
  try {
    return await api.get('/portal/me', { schema: signedIn })
  } catch (error) {
    if (isApiError(error) && (error.kind === 'signed_out' || error.kind === 'forbidden')) return null
    throw error
  }
}

const sent = z.object({ status: z.literal('sent'), expiresInSeconds: z.number(), resendAfterSeconds: z.number() })
export type Sent = z.infer<typeof sent>
const challenge = z.object({ challenge: z.string(), bits: z.number().int() })

/**
 * A public write under the abuse guard: sent as it is; when the API asks for a solved challenge (429 `challenge`, only
 * after suspicious traffic), the page gets one (`onChecking` tells the screen), solves it and sends again with the proof
 * — once. Anything else is the caller's.
 */
async function guarded<T>(api: ApiClient, policy: SignInPolicy, send: (proof?: { challenge: string; nonce: string }) => Promise<T>, onChecking?: () => void): Promise<T> {
  try {
    return await send()
  } catch (error) {
    if (!isApiError(error) || !wantsChallenge(error)) throw error
    onChecking?.()
    const asked = await api.get('/abuse/challenge', { query: { policy }, schema: challenge })
    const nonce = await solveChallenge(asked.challenge, asked.bits)
    if (nonce === null) throw error
    return send({ challenge: asked.challenge, nonce })
  }
}

/** Step 1: one e-mail with a link and a code — the same answer for every address. */
export async function startSignIn(api: ApiClient, input: PortalAddress & { email: string }, onChecking?: () => void): Promise<Sent> {
  await api.get('/auth/csrf')
  const body = { tenant: input.tenant, ...(input.company ? { company: input.company } : {}), email: input.email.trim() }
  return guarded(api, 'portal.signin.start', (proof) => api.post('/portal/signin/start', { body: { ...body, ...(proof ? { proof } : {}) }, schema: sent }), onChecking)
}

const signedInAnswer = z.object({ status: z.literal('signed_in'), user: person, party, company, termsDue: z.boolean() })

/** Step 2: the code from the e-mail. */
export async function signInWithCode(api: ApiClient, input: PortalAddress & { email: string; code: string }, onChecking?: () => void): Promise<SignedIn> {
  await api.get('/auth/csrf')
  const body = { tenant: input.tenant, ...(input.company ? { company: input.company } : {}), email: input.email.trim(), code: input.code }
  return guarded(api, 'portal.signin.code', (proof) => api.post('/portal/signin/code', { body: { ...body, ...(proof ? { proof } : {}) }, schema: signedInAnswer }), onChecking)
}

const preview = z.object({ company: z.object({ code: z.string(), name: z.string() }), email: z.string() })
export type LinkPreview = z.infer<typeof preview>

/** The mailed link, read WITHOUT using it (a mail scanner that opens it first burns nothing). */
export function previewLink(api: ApiClient, token: string, onChecking?: () => void): Promise<LinkPreview> {
  return guarded(api, 'portal.signin.link', (proof) => api.post('/portal/signin/link/preview', { body: { token, ...(proof ? { proof } : {}) }, schema: preview }), onChecking)
}

/** Continue: the one press that uses the link. */
export async function continueLink(api: ApiClient, token: string, onChecking?: () => void): Promise<SignedIn> {
  await api.get('/auth/csrf')
  return guarded(api, 'portal.signin.link', (proof) => api.post('/portal/signin/link', { body: { token, ...(proof ? { proof } : {}) }, schema: signedInAnswer }), onChecking)
}

const terms = z.object({
  notice: z
    .object({ id: z.string(), label: z.string(), versionNo: z.number(), locale: z.string(), body: z.string(), sha256: z.string(), languageReady: z.boolean() })
    .nullable(),
  acknowledged: z.boolean(),
})
export type PortalTerms = z.infer<typeof terms>

/** The portal terms in force, in a language (the first visit shows them; their SHA-256 goes back with the yes). */
export const readTerms = (api: ApiClient, locale: Locale): Promise<PortalTerms> => api.get('/portal/terms', { query: { locale }, schema: terms })

const settings = z.object({ topics: z.array(z.object({ topic: z.string(), frequency: z.string(), locked: z.boolean(), stored: z.boolean() })) })

/** The person's e-mail settings (their own; they work before the first visit). */
export const readEmailSettings = (api: ApiClient) => api.get('/portal/email-settings', { schema: settings })

/** The first visit's summaries: one frequency for every non-essential topic (COL-063). */
export async function saveSummaries(api: ApiClient, summaries: Summaries): Promise<void> {
  await api.request('PUT', '/portal/email-settings', { body: { nonEssential: summaries }, schema: settings, idempotencyKey: newIdempotencyKey() })
}

/** The first visit: name, language and the terms shown, acknowledged once per version (ONE command). */
export async function saveFirstVisit(api: ApiClient, input: { displayName: string; locale: Locale; terms: { id: string; locale: string; sha256: string } }): Promise<void> {
  await api.post('/portal/first-visit', {
    body: { displayName: input.displayName.trim(), locale: input.locale, noticeId: input.terms.id, noticeLocale: input.terms.locale, sha256: input.terms.sha256 },
    schema: z.object({ acknowledged: z.literal(true) }),
    idempotencyKey: newIdempotencyKey(),
  })
}

const notice = z.object({
  company: z.object({ id: z.string(), name: z.string() }),
  notice: z.object({ label: z.string(), locale: z.string(), body: z.string(), languageReady: z.boolean() }),
})
export type PublicNotice = z.infer<typeof notice>

/** The company's public privacy notice (GDPR arts. 13, 14); null when none is published. */
export async function readPrivacyNotice(api: ApiClient, companyId: string, locale: Locale): Promise<PublicNotice | null> {
  try {
    return await api.get(`/privacy/public/${encodeURIComponent(companyId)}`, { query: { locale }, schema: notice })
  } catch (error) {
    if (isApiError(error) && error.kind === 'not_found') return null
    throw error
  }
}
