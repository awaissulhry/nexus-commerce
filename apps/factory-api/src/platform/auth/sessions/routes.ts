import { z } from 'zod'
import { defineContract, instant, output } from '@nexus/factory-domain/core/contracts'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { defineRoutes } from '../../../core/manifest'
import { officeSessionOf } from './authenticator'
import { csrfCookieOf, newCsrfToken, setCsrfCookie } from './cookies'
import { manifest } from './manifest'
import { officeAuthOf } from './office-auth'
import { idleExpiryAt, SESSION_LIFETIME } from './session-store'

const csrfContract = defineContract({ response: { 200: output({ csrfToken: z.string() }) } })
const refreshContract = defineContract({ response: { 200: output({ idleExpiresAt: instant(), absoluteExpiresAt: instant() }) } })

/**
 * GET /auth/csrf           the CSRF token for the double submit (sessions/cookies.ts): the web calls it before
 *                          sign-in, accepting an invitation or signing out. An existing token is kept (open tabs).
 * POST /auth/sessions/refresh  moves the idle expiry of the caller's session now (the web calls it on activity that
 *                          makes no request) and answers both expiries. Bookkeeping: not audited.
 */
export default defineRoutes('auth-sessions', manifest, async (app) => {
  app.get('/auth/csrf', { schema: csrfContract }, async (request, reply) => {
    const token = csrfCookieOf(request) ?? newCsrfToken()
    setCsrfCookie(reply, token, SESSION_LIFETIME.absoluteMs)
    return { csrfToken: token }
  })

  app.post('/auth/sessions/refresh', { schema: refreshContract }, async (request) => {
    const auth = officeAuthOf(app)
    const session = officeSessionOf(request)
    const now = auth.clock.now()
    const idleExpiresAt = idleExpiryAt(now, session.absoluteExpiresAt)
    await request.withClient((client) =>
      client.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } }),
    )
    return { idleExpiresAt: toUtcIso(idleExpiresAt), absoluteExpiresAt: toUtcIso(session.absoluteExpiresAt) }
  })
})
