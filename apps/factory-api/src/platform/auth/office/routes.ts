import { defineRoutes } from '../../../core/manifest'
import { AUTH_RATE_LIMITS, officeAuthOf, type AuthRateLimit } from '../sessions/office-auth'
import { changePassword, confirmTotp, disableTotp, me, setLocale, startTotpSetup, stepUp } from './account'
import {
  localeContract,
  meContract,
  passwordChangeContract,
  resetContract,
  resetRequestContract,
  signInContract,
  signOutContract,
  stepUpContract,
  totpConfirmContract,
  totpDisableContract,
  totpSetupContract,
} from './contract'
import { manifest } from './manifest'
import { confirmPasswordReset, requestPasswordReset } from './password-reset'
import { signIn, signOut } from './sign-in'

/**
 * POST /auth/office/sign-in                 email + password (+ code) → session cookies; totp_required; or a forced reset
 * POST /auth/office/sign-out                ends the cookie's session, clears the cookies
 * POST /auth/office/password/reset-request  a reset link by email (the same answer for every address)
 * POST /auth/office/password/reset          token + new password; every session ends
 * GET  /auth/office/me                      the person, tenant, company (and the companies they may open), session,
 *                                           two-factor state and permissions
 * POST /auth/office/step-up                 a fresh TOTP code opens risky actions for 5 minutes
 * POST /auth/office/totp/setup|confirm|disable  two-factor on this account (recovery codes shown once at confirm)
 * POST /auth/office/password                the signed-in person's new password (the current one first); other sessions end
 * POST /auth/office/locale                  the signed-in person's interface language
 *
 * The routes that take a secret have their own, lower rate limit per client address (sessions/office-auth.ts).
 */
export default defineRoutes('auth-office', manifest, async (app) => {
  const limits = app.officeAuth?.rateLimits ?? AUTH_RATE_LIMITS
  const limit = (rate: AuthRateLimit) => ({ rateLimit: { max: rate.max, timeWindow: rate.timeWindowMs } })

  app.post('/auth/office/sign-in', { schema: signInContract, config: limit(limits.signIn) }, (request, reply) =>
    signIn(officeAuthOf(app), request, reply, request.body),
  )
  app.post('/auth/office/sign-out', { schema: signOutContract }, (request, reply) => signOut(officeAuthOf(app), request, reply))
  app.post('/auth/office/password/reset-request', { schema: resetRequestContract, config: limit(limits.resetRequest) }, async (request) =>
    requestPasswordReset(officeAuthOf(app), request, request.body),
  )
  app.post('/auth/office/password/reset', { schema: resetContract, config: limit(limits.tokenUse) }, (request) =>
    confirmPasswordReset(officeAuthOf(app), request, request.body),
  )

  app.get('/auth/office/me', { schema: meContract }, (request) => me(officeAuthOf(app), request))
  app.post('/auth/office/step-up', { schema: stepUpContract, config: limit(limits.codes) }, (request) => stepUp(officeAuthOf(app), request, request.body.code))
  app.post('/auth/office/totp/setup', { schema: totpSetupContract }, (request) => startTotpSetup(officeAuthOf(app), request))
  app.post('/auth/office/totp/confirm', { schema: totpConfirmContract, config: limit(limits.codes) }, (request) =>
    confirmTotp(officeAuthOf(app), request, request.body.code),
  )
  app.post('/auth/office/totp/disable', { schema: totpDisableContract, config: limit(limits.codes) }, (request) =>
    disableTotp(officeAuthOf(app), request, request.body.password),
  )
  app.post('/auth/office/password', { schema: passwordChangeContract, config: limit(limits.codes) }, (request) =>
    changePassword(officeAuthOf(app), request, request.body),
  )
  app.post('/auth/office/locale', { schema: localeContract }, (request) => setLocale(officeAuthOf(app), request, request.body.locale))
})
