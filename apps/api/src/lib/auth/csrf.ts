/**
 * Phase S1 (auth core) — double-submit-cookie CSRF protection.
 *
 * Required because the interim cookie is `SameSite=None` (cross-site),
 * so the browser attaches it to forged cross-site requests. Defense:
 *   • a readable (non-httpOnly) `nexus_csrf` cookie holds a random
 *     token, set alongside the session;
 *   • state-changing auth endpoints require an `x-nexus-csrf` header
 *     equal to that cookie (constant-time compare).
 * A cross-site attacker can neither read our cookie (different origin)
 * nor set a custom header on a simple cross-site request, so a match
 * proves the request came from our own first-party script. Vetted
 * primitives only (randomBytes + timingSafeEqual).
 *
 * Under Option A (SameSite=Lax on a shared parent domain) this becomes
 * belt-and-braces; it stays on because it costs nothing.
 */

import { timingSafeEqual } from 'crypto'
import type { FastifyRequest } from 'fastify'
import { generateToken } from './tokens.js'
import { csrfCookieName } from './cookies.js'

/** Mint a fresh CSRF token (also the cookie value, readable by JS). */
export function issueCsrfToken(): string {
  return generateToken(24)
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== 'string' || typeof b !== 'string') return false
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length || ab.length === 0) return false
  try {
    return timingSafeEqual(ab, bb)
  } catch {
    return false
  }
}

/**
 * Verify the double-submit: header must be present and equal the
 * cookie. Returns false when either is missing or they differ.
 */
export function verifyCsrf(request: FastifyRequest): boolean {
  const cookieVal = (request.cookies as Record<string, string | undefined>)?.[
    csrfCookieName()
  ]
  const headerRaw = request.headers['x-nexus-csrf']
  const headerVal = Array.isArray(headerRaw) ? headerRaw[0] : headerRaw
  if (!cookieVal || !headerVal) return false
  return constantTimeEqual(cookieVal, headerVal)
}
