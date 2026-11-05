import type { FastifyReply, FastifyRequest } from 'fastify'
import { CSRF_COOKIE } from '../sessions/cookies'
import { SESSION_LIFETIME } from '../sessions/session-store'

/**
 * The portal cookie (B-W2b-159; A1 §3.10): `__Host-factory_portal` holds the portal session token (auth/portal/token.ts,
 * `ps1.<tenant>.<party>.<user>.<secret>`), HttpOnly, SameSite=Lax, Secure, Path=/, no Domain. A cookie of its own, apart
 * from the office's `__Host-factory_session`, so an office person who opens a partner's portal preview (B-W2b-162) in
 * the same browser keeps their office session, and an office route never reads a portal cookie (sessions/office-auth.ts
 * sends a request to the portal authenticator only for a partner route).
 *
 * The CSRF double submit is the office's (`__Host-factory_csrf` + `x-csrf-token`, GET /auth/csrf before sign-in): one
 * readable token per browser serves both, so a portal sign-in keeps the browser's token (the one the sign-in request just
 * proved) and keeps its office lifetime. Signing out of the portal clears only the portal cookie, so an office tab in the
 * same browser keeps working. (`__Host-` cookies cannot be set by another host: the kept token cannot be planted.)
 */

export const PORTAL_COOKIE = '__Host-factory_portal'

const base = { path: '/', secure: true, sameSite: 'lax' as const }

export function portalCookieOf(request: FastifyRequest): string | null {
  const value = request.cookies?.[PORTAL_COOKIE]
  return typeof value === 'string' && value !== '' ? value : null
}

/** Sets the portal cookie until the session's end, and the CSRF cookie with the office's lifetime (the same token). */
export function setPortalCookies(reply: FastifyReply, token: string, csrfToken: string, maxAgeMs: number): void {
  void reply.setCookie(PORTAL_COOKIE, token, { ...base, httpOnly: true, maxAge: Math.max(0, Math.floor(maxAgeMs / 1000)) })
  void reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge: Math.floor(SESSION_LIFETIME.absoluteMs / 1000) })
}

/** Clears the portal cookie only (an office session in the same browser keeps its CSRF token). */
export function clearPortalCookie(reply: FastifyReply): void {
  void reply.clearCookie(PORTAL_COOKIE, { ...base, httpOnly: true })
}
