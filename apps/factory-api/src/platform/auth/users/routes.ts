import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../sessions/office-auth'
import { listUsersContract, userChangeContract } from './contract'
import { changeUser, listUsers } from './lifecycle'
import { manifest } from './manifest'

/**
 * GET  /auth/users                                   the tenant's users, with status, two-factor and open invitation
 * POST /auth/users/:userId/suspend                   sessions end at once
 * POST /auth/users/:userId/reactivate
 * POST /auth/users/:userId/deactivate                credentials cleared, the row kept for history
 * POST /auth/users/:userId/require-password-reset    sessions end; the next sign-in asks for a new password
 */
export default defineRoutes('auth-users', manifest, async (app) => {
  app.get('/auth/users', { schema: listUsersContract }, (request) => listUsers(request))

  // Paths stay literal, one call each (scripts/factory/check-route-manifest.mjs reads them).
  const auth = () => officeAuthOf(app)
  app.post('/auth/users/:userId/suspend', { schema: userChangeContract }, (request) =>
    changeUser(auth(), request, request.params.userId, request.body, 'suspend'),
  )
  app.post('/auth/users/:userId/reactivate', { schema: userChangeContract }, (request) =>
    changeUser(auth(), request, request.params.userId, request.body, 'reactivate'),
  )
  app.post('/auth/users/:userId/deactivate', { schema: userChangeContract }, (request) =>
    changeUser(auth(), request, request.params.userId, request.body, 'deactivate'),
  )
  app.post('/auth/users/:userId/require-password-reset', { schema: userChangeContract }, (request) =>
    changeUser(auth(), request, request.params.userId, request.body, 'require-password-reset'),
  )
})
