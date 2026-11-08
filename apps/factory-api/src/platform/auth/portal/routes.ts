import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS, type AuthRateLimit } from '../sessions/office-auth'
import { changeLocale, firstVisit, me, refresh, terms } from './account'
import {
  codeContract,
  companyContract,
  endOthersContract,
  firstVisitContract,
  linkContract,
  linkPreviewContract,
  localeContract,
  meContract,
  profileContract,
  refreshContract,
  sessionsContract,
  signOutContract,
  startContract,
  stepUpContract,
  stepUpStartContract,
  termsContract,
} from './contract'
import { manifest } from './manifest'
import { changeProfile, companyData, endOtherSessions, listSessions } from './self'
import { continueLink, previewLink, signInWithCode, signOut, startSignIn } from './sign-in'
import { startStepUp, stepUp } from './step-up'

/**
 * Portal sign-in (B-W2b-159; PLT-050, PLT-066; design portal.signin; A1 §3.10):
 *
 * POST /portal/signin/start          {tenant, company?, email}: one e-mail with a 6-digit code and a link (the same answer
 *                                    for every address)
 * POST /portal/signin/code           {tenant, company?, email, code}: the code → the portal session cookie
 * POST /portal/signin/link/preview   {token}: what the link landing shows; does NOT use the link (scanner-safe)
 * POST /portal/signin/link           {token}: Continue, the one press that uses the link → the portal session cookie
 * POST /portal/sign-out              ends the portal cookie's session
 * GET  /portal/me                    the person, organisation, company, session, terms, permissions
 * POST /portal/sessions/refresh      "Stay signed in" (the idle end moves now)
 * POST /portal/me/locale             the person's own language (B-W2b-173, the portal's person menu)
 * GET  /portal/terms                 the portal terms in force, in the person's language
 * POST /portal/first-visit           name, language and the acknowledgement of the portal terms (once per version)
 * POST /portal/step-up/start         a step-up code by e-mail
 * POST /portal/step-up               the step-up code → 5 minutes for the sensitive partner acts
 * POST /portal/me/profile            B-W2b-196 (the Account page): the person's own name and language, one command
 * GET  /portal/sessions              B-W2b-196: the person's own live portal sessions (Sign-in and sessions, SAL-066)
 * POST /portal/sessions/end-others   B-W2b-196: signs out every other session of the person
 * GET  /portal/company               B-W2b-196: what the factory holds for invoicing the organisation (read-only)
 *
 * Public routes: the abuse guard (platform/abuse: per address and network, a proof-of-work challenge after suspicious
 * traffic) and, on top, the per-address rate limits of office sign-in (sessions/office-auth.ts).
 */
export default defineRoutes('auth-portal', manifest, async (app) => {
  const limits = app.officeAuth?.rateLimits ?? AUTH_RATE_LIMITS
  const limit = (rate: AuthRateLimit) => ({ rateLimit: { max: rate.max, timeWindow: rate.timeWindowMs } })

  app.post('/portal/signin/start', { schema: startContract, config: limit(limits.signIn) }, (request, reply) => startSignIn(app, request, reply, request.body))
  app.post('/portal/signin/code', { schema: codeContract, config: limit(limits.signIn) }, (request, reply) => signInWithCode(app, request, reply, request.body))
  app.post('/portal/signin/link/preview', { schema: linkPreviewContract, config: limit(limits.tokenUse) }, (request, reply) => previewLink(app, request, reply, request.body))
  app.post('/portal/signin/link', { schema: linkContract, config: limit(limits.tokenUse) }, (request, reply) => continueLink(app, request, reply, request.body))
  app.post('/portal/sign-out', { schema: signOutContract }, (request, reply) => signOut(app, request, reply))

  app.get('/portal/me', { schema: meContract }, async (request) => me(app, request))
  app.post('/portal/sessions/refresh', { schema: refreshContract }, (request) => refresh(app, request))
  app.post('/portal/me/locale', { schema: localeContract }, (request) => changeLocale(app, request, request.body, idempotencyKeyFrom(request)))
  app.get('/portal/terms', { schema: termsContract }, (request) => terms(app, request, request.query))
  app.post('/portal/first-visit', { schema: firstVisitContract }, (request) => firstVisit(app, request, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/step-up/start', { schema: stepUpStartContract, config: limit(limits.codes) }, (request, reply) => startStepUp(app, request, reply))
  app.post('/portal/step-up', { schema: stepUpContract, config: limit(limits.codes) }, (request, reply) => stepUp(app, request, reply, request.body))
  // B-W2b-196: the Account page (self.ts).
  app.post('/portal/me/profile', { schema: profileContract }, (request) => changeProfile(app, request, request.body, idempotencyKeyFrom(request)))
  app.get('/portal/sessions', { schema: sessionsContract }, (request) => listSessions(app, request))
  app.post('/portal/sessions/end-others', { schema: endOthersContract }, (request) => endOtherSessions(app, request, idempotencyKeyFrom(request)))
  app.get('/portal/company', { schema: companyContract }, (request) => companyData(app, request))
})
