/**
 * Phase S1 (auth core) — env-driven session/CSRF cookie configuration.
 *
 * This module is the ONLY place cookie attributes are decided, so the
 * web↔api domain topology is a config flip, not a code change (see
 * docs/security/S0-AUDIT.md §2):
 *
 *   • INTERIM (today): web = *.vercel.app, api = *.up.railway.app — two
 *     Public-Suffix-List domains, so no shared parent. The cookie is
 *     host-only on the API origin and MUST be `SameSite=None; Secure`
 *     to ride cross-site XHR/SSE with credentials. `__Host-` prefix is
 *     usable here (host-only + Secure + Path=/, no Domain).
 *   • OPTION A (target): custom apex — app.xavia.it + api.xavia.it. Set
 *     COOKIE_DOMAIN=.xavia.it and the cookie becomes `SameSite=Lax`
 *     with `Domain=.xavia.it` — same-site, immune to 3p-cookie blocking.
 *     `__Host-` is dropped (it forbids a Domain attribute).
 *
 * Env knobs:
 *   COOKIE_DOMAIN    e.g. ".xavia.it" — unset in interim mode.
 *   COOKIE_SAMESITE  "lax" | "strict" | "none" — overrides the default.
 *   COOKIE_SECURE    "false" only for local http dev; default true.
 */

export type SameSite = 'lax' | 'strict' | 'none'

export interface CookieAttrs {
  httpOnly: boolean
  secure: boolean
  sameSite: SameSite
  domain?: string
  path: string
}

// Session lifetimes. Absolute = the cookie maxAge; idle = server-side
// sliding window enforced against UserSession.idleExpiry.
export const SESSION_TTL_ABSOLUTE_MS = 30 * 24 * 60 * 60 * 1000 // 30 days
export const SESSION_TTL_IDLE_MS = 7 * 24 * 60 * 60 * 1000 // 7 days

const BASE_SESSION_NAME = 'nexus_session'
const BASE_CSRF_NAME = 'nexus_csrf'

function cookieDomain(): string | undefined {
  const d = process.env.COOKIE_DOMAIN?.trim()
  return d && d.length > 0 ? d : undefined
}

function cookieSecure(): boolean {
  // Default secure; only an explicit "false" disables it (local http).
  return process.env.COOKIE_SECURE?.trim().toLowerCase() !== 'false'
}

function cookieSameSite(): SameSite {
  const raw = process.env.COOKIE_SAMESITE?.trim().toLowerCase()
  if (raw === 'lax' || raw === 'strict' || raw === 'none') return raw
  // Default: cross-site 'none' in interim (no domain); same-site 'lax'
  // once a shared parent domain exists.
  return cookieDomain() ? 'lax' : 'none'
}

/**
 * Whether `__Host-` prefixing is valid: requires Secure, Path=/, and
 * NO Domain attribute. Only the interim host-only mode qualifies.
 */
function useHostPrefix(): boolean {
  return cookieSecure() && !cookieDomain()
}

export function sessionCookieName(): string {
  return useHostPrefix() ? `__Host-${BASE_SESSION_NAME}` : BASE_SESSION_NAME
}

export function csrfCookieName(): string {
  // CSRF cookie is readable by JS (not httpOnly) → cannot use __Host-
  // in a way the double-submit reader depends on; keep it plain but
  // still Secure + SameSite-aligned.
  return BASE_CSRF_NAME
}

function baseAttrs(httpOnly: boolean): CookieAttrs {
  let secure = cookieSecure()
  const sameSite = cookieSameSite()
  // Browsers reject `SameSite=None` without `Secure`. Force it so a
  // misconfigured COOKIE_SECURE=false + none combo can't silently drop
  // the cookie.
  if (sameSite === 'none' && !secure) secure = true
  return {
    httpOnly,
    secure,
    sameSite,
    domain: cookieDomain(),
    path: '/',
  }
}

/** Options for @fastify/cookie setCookie for the session cookie. */
export function sessionCookieOptions(): CookieAttrs & { maxAge: number } {
  return { ...baseAttrs(true), maxAge: Math.floor(SESSION_TTL_ABSOLUTE_MS / 1000) }
}

/** Options for the readable double-submit CSRF cookie. */
export function csrfCookieOptions(): CookieAttrs & { maxAge: number } {
  return { ...baseAttrs(false), maxAge: Math.floor(SESSION_TTL_ABSOLUTE_MS / 1000) }
}

/** Options to clear a cookie (logout): same attrs, expired. */
export function clearedCookieOptions(httpOnly: boolean): CookieAttrs & { maxAge: number; expires: Date } {
  return { ...baseAttrs(httpOnly), maxAge: 0, expires: new Date(0) }
}
