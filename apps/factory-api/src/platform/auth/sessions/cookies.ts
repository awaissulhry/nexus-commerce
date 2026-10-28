import { randomBytes } from 'node:crypto'
import type { FastifyReply, FastifyRequest } from 'fastify'
import { ForbiddenError } from '@nexus/factory-domain/core/errors'
import { sameSecret } from './secrets'

/**
 * The office cookies (plan A1 §3.10; features PLT-047, PLT-244), ported from Commerce (apps/api/src/lib/auth/cookies.ts
 * and csrf.ts). The web proxies /api to this API (A1 §3.1), so the browser sees one origin and both cookies are
 * first-party, with the `__Host-` prefix (Secure, Path=/, no Domain: no other host can set or read them):
 *
 *   __Host-factory_session  the session token; HttpOnly, SameSite=Lax; its Max-Age is the session's absolute expiry.
 *                           The server checks the idle and absolute expiry itself, the cookie's age is only a hint.
 *   __Host-factory_csrf     the CSRF token, readable by the web's script (not HttpOnly). Double submit: every unsafe
 *                           request (POST, PUT, PATCH, DELETE) of a cookie session sends it back in `x-csrf-token`, and
 *                           the two must match (constant time). Another site can make the browser send the cookies
 *                           but can neither read this one nor set the header. A new token at every sign-in.
 *
 * Browsers accept Secure cookies from http://localhost, so local development works without TLS.
 */

export const SESSION_COOKIE = '__Host-factory_session'
export const CSRF_COOKIE = '__Host-factory_csrf'
export const CSRF_HEADER = 'x-csrf-token'

const CSRF_TOKEN = /^[A-Za-z0-9_-]{43}$/
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/** A new CSRF token (256 random bits, base64url). */
export const newCsrfToken = (): string => randomBytes(32).toString('base64url')

/** The request's CSRF cookie when it is well formed (an existing one is kept, so open tabs keep working). */
export function csrfCookieOf(request: FastifyRequest): string | null {
  const value = request.cookies?.[CSRF_COOKIE]
  return typeof value === 'string' && CSRF_TOKEN.test(value) ? value : null
}

export function sessionCookieOf(request: FastifyRequest): string | null {
  const value = request.cookies?.[SESSION_COOKIE]
  return typeof value === 'string' && value !== '' ? value : null
}

export const isUnsafeMethod = (method: string): boolean => UNSAFE_METHODS.has(method.toUpperCase())

/** The double-submit check. Throws a 403 when the header is missing or differs from the cookie. */
export function assertCsrf(request: FastifyRequest): void {
  const header = request.headers[CSRF_HEADER]
  const cookie = csrfCookieOf(request)
  if (cookie === null || typeof header !== 'string' || !sameSecret(header, cookie)) {
    throw new ForbiddenError('The CSRF token is missing or does not match. Reload the page and try again.')
  }
}

const base = { path: '/', secure: true, sameSite: 'lax' as const }

/** Sets the session cookie and a CSRF cookie with the same lifetime. */
export function setSessionCookies(reply: FastifyReply, sessionToken: string, csrfToken: string, maxAgeMs: number): void {
  const maxAge = Math.max(0, Math.floor(maxAgeMs / 1000))
  void reply.setCookie(SESSION_COOKIE, sessionToken, { ...base, httpOnly: true, maxAge })
  void reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge })
}

/** Sets (or keeps) the CSRF cookie alone, before there is a session. */
export function setCsrfCookie(reply: FastifyReply, csrfToken: string, maxAgeMs: number): void {
  void reply.setCookie(CSRF_COOKIE, csrfToken, { ...base, httpOnly: false, maxAge: Math.floor(maxAgeMs / 1000) })
}

/** Clears both cookies (sign-out, or a cookie that names no live session). */
export function clearSessionCookies(reply: FastifyReply): void {
  void reply.clearCookie(SESSION_COOKIE, { ...base, httpOnly: true })
  void reply.clearCookie(CSRF_COOKIE, { ...base, httpOnly: false })
}
