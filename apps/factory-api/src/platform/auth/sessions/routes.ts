import { z } from 'zod'
import { idleEndAfter, sessionLengthsMs } from '@nexus/factory-domain/auth/sessions/lengths'
import { defineContract, instant, output } from '@nexus/factory-domain/core/contracts'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { defineRoutes } from '../../../core/manifest'
import { officeSessionOf } from './authenticator'
import {
  endMySessionContract,
  endOtherSessionsContract,
  endUserSessionsContract,
  mySessionsContract,
  securitySettingsContract,
  sessionLengthsContract,
  stepUpRulesContract,
  userSessionsContract,
} from './contract'
import { csrfCookieOf, newCsrfToken, setCsrfCookie } from './cookies'
import { endMyOtherSessions, endMySession, endUserSessions, mySessions, userSessions } from './list'
import { manifest } from './manifest'
import { officeAuthOf } from './office-auth'
import { SESSION_LIFETIME } from './session-store'
import { getSecuritySettings, saveSessionLengths, saveStepUpRules } from './settings'

const csrfContract = defineContract({ response: { 200: output({ csrfToken: z.string() }) } })
const refreshContract = defineContract({ response: { 200: output({ idleExpiresAt: instant(), absoluteExpiresAt: instant() }) } })

/**
 * GET /auth/csrf           the CSRF token for the double submit (sessions/cookies.ts): the web calls it before
 *                          sign-in, accepting an invitation or signing out. An existing token is kept (open tabs).
 * POST /auth/sessions/refresh  moves the idle expiry of the caller's session now (the web calls it on activity that
 *                          makes no request) and answers both expiries. Bookkeeping: not audited.
 * B-W2b-404 (PLT-064, PLT-068, PLT-063):
 * GET  /auth/sessions                     my live sessions: device, browser, place, started, last used, this browser
 * POST /auth/sessions/:sessionId/end      ends one of my other sessions (ENDED_BY_USER)
 * POST /auth/sessions/end-others          signs out everywhere else (ENDED_BY_USER); this browser goes on
 * GET  /auth/users/:userId/sessions       a person's live sessions (users.sessions.manage)
 * POST /auth/users/:userId/sessions/end   ends every session of a person (ENDED_BY_ADMIN)
 * GET  /auth/security-settings            session lengths per audience (the floor's per site) and the actions that ask
 *                                         for a fresh code, with the lock rule
 * PUT  /auth/security-settings/sessions   the office and portal lengths (version; longer asks for a fresh code)
 * PUT  /auth/security-settings/step-up    the actions switched off and the lock rule (version; wider asks for a fresh code)
 */
export default defineRoutes('auth-sessions', manifest, async (app) => {
  const auth = () => officeAuthOf(app)
  app.get('/auth/csrf', { schema: csrfContract }, async (request, reply) => {
    const token = csrfCookieOf(request) ?? newCsrfToken()
    setCsrfCookie(reply, token, SESSION_LIFETIME.absoluteMs)
    return { csrfToken: token }
  })

  app.post('/auth/sessions/refresh', { schema: refreshContract }, async (request) => {
    const now = auth().clock.now()
    const session = officeSessionOf(request)
    const idleExpiresAt = idleEndAfter(now, session.absoluteExpiresAt, sessionLengthsMs(session.security).office.idleMs)
    await request.withClient((client) =>
      client.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastSeenAt: now, idleExpiresAt } }),
    )
    return { idleExpiresAt: toUtcIso(idleExpiresAt), absoluteExpiresAt: toUtcIso(session.absoluteExpiresAt) }
  })

  app.get('/auth/sessions', { schema: mySessionsContract }, (request) => mySessions(auth(), request))
  app.post('/auth/sessions/:sessionId/end', { schema: endMySessionContract }, (request) => endMySession(auth(), request, request.params.sessionId))
  app.post('/auth/sessions/end-others', { schema: endOtherSessionsContract }, (request) => endMyOtherSessions(auth(), request))
  app.get('/auth/users/:userId/sessions', { schema: userSessionsContract }, (request) => userSessions(auth(), request, request.params.userId))
  app.post('/auth/users/:userId/sessions/end', { schema: endUserSessionsContract }, (request) => endUserSessions(auth(), request, request.params.userId, request.body))
  app.get('/auth/security-settings', { schema: securitySettingsContract }, (request) => getSecuritySettings(request))
  app.put('/auth/security-settings/sessions', { schema: sessionLengthsContract }, (request) => saveSessionLengths(auth(), request, request.body))
  app.put('/auth/security-settings/step-up', { schema: stepUpRulesContract }, (request) => saveStepUpRules(auth(), request, request.body))
})
