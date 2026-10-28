import type { FastifyReply, FastifyRequest } from 'fastify'

/**
 * The floor cookies (plan A1 §3.10 "Floor"), both `__Host-` (Secure, Path=/, no Domain), HttpOnly and SameSite=Lax:
 *
 *   __Host-factory_device   the device token. Long-lived: 400 days (the most a browser keeps a cookie), set again at
 *                           every sign-in so a device in use never loses it; revoking the device makes it worthless.
 *   __Host-factory_floor    the operator's floor session token, until the session's shift end. A request carrying it
 *                           is a floor request (sessions/office-auth.ts): the floor authenticator decides, never the
 *                           office one.
 * Unsafe floor requests also pass the CSRF double submit of the office (sessions/cookies.ts): the floor app reads the
 * CSRF cookie from GET /auth/csrf and sends it back in `x-csrf-token`.
 */

export const DEVICE_COOKIE = '__Host-factory_device'
export const FLOOR_COOKIE = '__Host-factory_floor'

/** 400 days: browsers cap a cookie's lifetime there. */
export const DEVICE_COOKIE_MAX_AGE_MS = 400 * 24 * 60 * 60_000

const base = { path: '/', secure: true, sameSite: 'lax' as const, httpOnly: true }

const cookieOf = (request: FastifyRequest, name: string): string | null => {
  const value = request.cookies?.[name]
  return typeof value === 'string' && value !== '' ? value : null
}

export const deviceCookieOf = (request: FastifyRequest): string | null => cookieOf(request, DEVICE_COOKIE)
export const floorCookieOf = (request: FastifyRequest): string | null => cookieOf(request, FLOOR_COOKIE)

export function setDeviceCookie(reply: FastifyReply, token: string): void {
  void reply.setCookie(DEVICE_COOKIE, token, { ...base, maxAge: Math.floor(DEVICE_COOKIE_MAX_AGE_MS / 1000) })
}

export function setFloorCookie(reply: FastifyReply, token: string, until: Date, now: Date): void {
  void reply.setCookie(FLOOR_COOKIE, token, { ...base, maxAge: Math.max(0, Math.floor((until.getTime() - now.getTime()) / 1000)) })
}

export function clearFloorCookie(reply: FastifyReply): void {
  void reply.clearCookie(FLOOR_COOKIE, base)
}

export function clearDeviceCookie(reply: FastifyReply): void {
  void reply.clearCookie(DEVICE_COOKIE, base)
}
