/**
 * The browser's session read, kept free of React so its order can be tested.
 *
 * P2 (2026-09-30, I4-2) — `/auth/csrf` and `/auth/me` used to run one after the other, and every page waited for both
 * before it drew anything. The CSRF token is only needed by the first WRITE, so the two reads now start together.
 */

export interface SessionAnswer {
  csrfToken: string | null
  /** The `/auth/me` body, or `null` when there is no session (or the read failed). */
  me: { user?: unknown; isOwner?: unknown; permissions?: unknown } | null
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/** Read the CSRF token and the session at once. A failed CSRF read never costs the session. */
export async function readSession(base: string, doFetch: FetchLike = fetch): Promise<SessionAnswer> {
  const csrf = doFetch(`${base}/api/auth/csrf`, { credentials: 'include' })
    .then((r) => (r.ok ? r.json() : null))
    .catch(() => null)
  const me = doFetch(`${base}/api/auth/me`, { credentials: 'include' })
    .then(async (r) => (r.ok ? await r.json() : null))
    .catch(() => null)
  const [token, session] = await Promise.all([csrf, me])
  return { csrfToken: typeof token?.csrfToken === 'string' ? token.csrfToken : null, me: session && typeof session === 'object' ? session : null }
}

/**
 * Routes that draw while `/auth/me` is still on its way.
 *
 * The product studio starts its own reads at once (`_studio/studioPrefetch.ts`); the API still refuses every one of them
 * without a session or a permission, and the studio treats an unresolved session as "checking" (no edits, no actions).
 * Only the ORDER changes: nothing is shown that the API would not serve, and an anonymous visitor is still sent to the
 * login page when the answer lands. Every other route keeps the blank frame until the session is known.
 */
export function rendersBeforeSession(pathname: string): boolean {
  return /^\/products\/[^/]+\/edit\/studio(?:\/|$)/.test(pathname)
}
