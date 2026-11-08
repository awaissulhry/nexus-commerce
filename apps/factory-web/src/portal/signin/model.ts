import { issuePath, type ApiError } from '../../lib/api/errors'

/**
 * The portal Sign in's rules without a screen (B-W2b-164, SCR-026; design portal.signin): which portal the address names,
 * where a signed-in person goes, the mailed link's token, and what an API refusal means for the page. Pure: the container
 * (PortalSignIn.tsx) and the tests read it.
 */

// ── which portal ──────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The portal's address as the invitation mail names it (`/p/signin?tenant=<slug>&company=<code>`). */
export interface PortalAddress {
  /** The tenant's slug. */
  readonly tenant: string
  /** The company's code; '' when the tenant has one active company (the API then picks it). */
  readonly company: string
}

/**
 * The portal this device last signed in to, so the frame's "sign in again" (`/p/signin?next=…`, which names no portal)
 * still knows whose page it is. Not secret: the slug and the code are in every invitation mail.
 */
export const PORTAL_ADDRESS_COOKIE = 'factory_portal'

const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const CODE = /^[A-Za-z0-9._-]{1,32}$/

/** A slug and a code as the API takes them, or null. */
export function portalAddress(tenant: string | null | undefined, company: string | null | undefined): PortalAddress | null {
  const slug = (tenant ?? '').trim()
  const code = (company ?? '').trim()
  if (!SLUG.test(slug)) return null
  if (code !== '' && !CODE.test(code)) return null
  return { tenant: slug.toLowerCase(), company: code }
}

/** The cookie's value for an address (`<slug>|<code>`). */
export const addressCookieValue = (address: PortalAddress): string => `${address.tenant}|${address.company}`

/** The address a cookie keeps, or null. */
export function addressFromCookie(value: string | null | undefined): PortalAddress | null {
  if (!value) return null
  const [tenant, company = '', extra] = value.split('|')
  return extra === undefined ? portalAddress(tenant, company) : null
}

/** The page's portal: the address it was opened with wins, else the one this device remembers. */
export const addressOf = (given: PortalAddress | null, remembered: PortalAddress | null): PortalAddress | null => given ?? remembered

// ── the mailed link ───────────────────────────────────────────────────────────────────────────────────────────────────────

const UUID = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
const LINK_TOKEN = new RegExp(`^pl1\\.(${UUID})\\.(${UUID})\\.(${UUID})\\.[A-Za-z0-9_-]{43}$`)

/** The sign-in link's token of a `#token=…` fragment (`pl1.<tenant>.<company>.<person>.<secret>`), or null. */
export function linkTokenOf(hash: string | null | undefined): string | null {
  if (!hash) return null
  const token = new URLSearchParams(hash.replace(/^#/, '')).get('token')?.trim() ?? ''
  return LINK_TOKEN.test(token) ? token : null
}

/** The company whose portal a link opens (the token names it): the page heads with its brand before anything is sent. */
export function companyOfLinkToken(token: string): string | null {
  return LINK_TOKEN.exec(token)?.[2]?.toLowerCase() ?? null
}

// ── where a signed-in person goes ─────────────────────────────────────────────────────────────────────────────────────────

const RESERVED = new Set(['signin', 'unsubscribe'])

/**
 * The page the person was going to (the frame sends `/p/signin?next=<path + query + #anchor>`): only a portal address of
 * this site — never another site, never the sign-in page itself. Null for anything else.
 */
export function safeNext(value: string | null | undefined): string | null {
  if (!value || value.length > 2000 || !value.startsWith('/p/') || value.startsWith('//') || /[\\\u0000-\u001f]/.test(value)) return null
  let url: URL
  try {
    url = new URL(value, 'https://portal.invalid')
  } catch {
    return null
  }
  if (url.origin !== 'https://portal.invalid' || !url.pathname.startsWith('/p/')) return null
  const segment = url.pathname.split('/')[2] ?? ''
  if (segment === '' || RESERVED.has(segment.toLowerCase())) return null
  return `${url.pathname}${url.search}${url.hash}`
}

/** The person's portal Home: `/p/<party code>` (the frame also takes the party's id). */
export const homeOf = (party: { readonly id: string; readonly code?: string | null | undefined }): string => `/p/${encodeURIComponent(party.code || party.id)}`

/** Where a signed-in person goes: the page they were going to, else their Home. */
export const destinationOf = (next: string | null, party: { readonly id: string; readonly code?: string | null | undefined }): string => safeNext(next) ?? homeOf(party)

/**
 * The page the person was going to, kept on this device while the e-mail is on its way: the mailed link often opens in
 * a new tab, which has no `next`. A path of this site only, for the 15 minutes the link works.
 */
export const NEXT_KEY = 'fw-portal-next'
export const NEXT_TTL_MS = 15 * 60_000

export function nextToKeep(next: string | null, now: number): string | null {
  const safe = safeNext(next)
  return safe ? JSON.stringify({ next: safe, at: now }) : null
}

export function keptNext(stored: string | null | undefined, now: number): string | null {
  if (!stored) return null
  try {
    const value = JSON.parse(stored) as { next?: unknown; at?: unknown }
    if (typeof value.at !== 'number' || now - value.at > NEXT_TTL_MS || now < value.at - 60_000) return null
    return typeof value.next === 'string' ? safeNext(value.next) : null
  } catch {
    return null
  }
}

/** The work e-mail of this tab's last sign-in (sessionStorage): an ended session prefills step 1 with it. */
export const EMAIL_KEY = 'fw-portal-email'

/** Why the frame sent the person back (`?ended=idle` after 30 minutes without use, `revoked` by the office). */
export type EndedReason = 'idle' | 'revoked'
export const endedOf = (value: string | null | undefined): EndedReason | null => (value === 'idle' || value === 'revoked' ? value : null)

// ── the e-mail ────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** What is wrong with a typed work e-mail (the page's own check, before anything is sent), or null. */
export function emailProblem(value: string): 'required' | 'format' | null {
  const email = value.trim()
  if (email === '') return 'required'
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 320 ? null : 'format'
}

// ── what the API said ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** The abuse guard's policy of each public call (GET /abuse/challenge?policy=…). */
export const POLICIES = { start: 'portal.signin.start', code: 'portal.signin.code', link: 'portal.signin.link' } as const
export type SignInPolicy = (typeof POLICIES)[keyof typeof POLICIES]

const pathsOf = (error: ApiError): string[] => error.issues.map(issuePath)

/** A 429 that asks for a solved challenge first (proof of work, after suspicious traffic). */
export const wantsChallenge = (error: ApiError): boolean => error.kind === 'rate_limited' && pathsOf(error).includes('challenge')

/** How long a 429 says to wait, in ms (the issue `retryAfter` carries seconds); null when it says nothing. */
export function retryAfterMs(error: ApiError): number | null {
  if (error.kind !== 'rate_limited') return null
  const issue = error.issues.find((entry) => issuePath(entry) === 'retryAfter')
  const seconds = Number(issue?.message)
  return Number.isFinite(seconds) && seconds > 0 ? Math.ceil(seconds) * 1000 : 60_000
}

/** The wait in words' units: seconds under a minute, else whole minutes (rounded up). */
export function waitParts(ms: number): { unit: 'seconds' | 'minutes'; count: number } {
  if (ms < 60_000) return { unit: 'seconds', count: Math.max(1, Math.ceil(ms / 1000)) }
  return { unit: 'minutes', count: Math.ceil(ms / 60_000) }
}

export type CodeProblem =
  | { kind: 'wrong'; triesLeft: number | null }
  | { kind: 'triedOut' }
  | { kind: 'expired' }
  | { kind: 'format' }
  | { kind: 'wait'; ms: number }
  | { kind: 'failed' }

/**
 * A refused code in the page's terms: wrong (with the tries the API counted, read from its sentence), tried out, expired,
 * a wait, or our side failing. An access refusal (`access/<PROBLEM>`) is `accessOf`'s.
 */
export function codeProblemOf(error: ApiError): CodeProblem {
  const paths = pathsOf(error)
  if (error.kind === 'signed_out') {
    if (paths.includes('code/TRIED_OUT')) return { kind: 'triedOut' }
    if (paths.includes('code/EXPIRED')) return { kind: 'expired' }
    if (paths.includes('code')) {
      const words = error.issues.find((issue) => issuePath(issue) === 'code')?.message ?? error.message
      const tries = /(\d+)\s+tr(?:y|ies)\s+left/i.exec(words)
      return { kind: 'wrong', triesLeft: tries ? Number(tries[1]) : null }
    }
  }
  if (error.kind === 'invalid' && paths.some((path) => path.endsWith('code'))) return { kind: 'format' }
  const wait = retryAfterMs(error)
  if (wait !== null) return { kind: 'wait', ms: wait }
  return { kind: 'failed' }
}

/** Why a proved sign-in is refused (B-W2b-159 `access/<PROBLEM>`, said only after the code or the link proved the address). */
export type AccessProblem = 'PAUSED' | 'ENDED' | 'INVITATION_ENDED' | 'PORTAL_OFF' | 'TERMS_NOT_PUBLISHED'
const ACCESS: readonly AccessProblem[] = ['PAUSED', 'ENDED', 'INVITATION_ENDED', 'PORTAL_OFF', 'TERMS_NOT_PUBLISHED']

/** The access refusal of a 403, with the end of access when the API's sentence names it (`dd/mm/yyyy`); else null. */
export function accessOf(error: ApiError): { problem: AccessProblem; endedOn: string | null } | null {
  if (error.kind !== 'forbidden') return null
  for (const path of pathsOf(error)) {
    const problem = path.startsWith('access/') ? (path.slice('access/'.length) as AccessProblem) : null
    if (problem && ACCESS.includes(problem)) {
      const date = problem === 'ENDED' ? (/\b(\d{2}\/\d{2}\/\d{4})\b/.exec(error.message)?.[1] ?? null) : null
      return { problem, endedOn: date }
    }
  }
  return null
}

// ── the first visit ───────────────────────────────────────────────────────────────────────────────────────────────────────

/** "E-mail summaries" for non-essential mail (COL-063): order, delivery and invoice mail always arrive as they happen. */
export const SUMMARIES = ['INSTANT', 'DAILY', 'WEEKLY'] as const
export type Summaries = (typeof SUMMARIES)[number]
export const DEFAULT_SUMMARIES: Summaries = 'DAILY'

export interface FirstVisitDraft {
  readonly displayName: string
  readonly accepted: boolean
}

/** The first visit's own check: a name (1 to 120 characters) and the terms accepted; one problem per field. */
export function firstVisitProblems(draft: FirstVisitDraft): { name?: 'required' | 'tooLong'; terms?: 'required' } {
  const name = draft.displayName.trim()
  return {
    ...(name === '' ? { name: 'required' as const } : name.length > 120 ? { name: 'tooLong' as const } : {}),
    ...(draft.accepted ? {} : { terms: 'required' as const }),
  }
}

/**
 * Whether the first visit asks for the summaries: only while the person has chosen none (GET /portal/email-settings, no
 * stored non-essential topic). A person who set them topic by topic (E-mail settings, the unsubscribe link) keeps them:
 * a newer version of the terms brings the first visit back, never a reset of their choice.
 */
export function asksSummaries(topics: readonly { readonly locked: boolean; readonly stored: boolean }[]): boolean {
  return !topics.some((topic) => !topic.locked && topic.stored)
}
