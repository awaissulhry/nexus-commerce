import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { officeAuthOf } from '../sessions/office-auth'
import { changeColleague, colleagues, deactivateColleague, inviteColleague, myAccess } from './colleagues'
import {
  changeContract,
  colleagueChangeContract,
  colleagueDeactivateContract,
  colleagueInviteContract,
  colleaguesContract,
  inviteContract,
  myAccessContract,
  organisationsContract,
  portalAccessContract,
  previewContract,
  resendContract,
  revokeContract,
  settingsContract,
  statusContract,
} from './contract'
import { manifest } from './manifest'
import { changePerson, changeSettings, changeStatus, invitePerson, organisations, portalAccess, preview, resendInvitation, revokeInvitation } from './office'

/**
 * Partner organisations, their people and roles (B-W2b-162; PLT-006, PLT-021, PLT-022, SAL-060, SCM-092):
 *
 * GET   /partners                                              the partner organisations (Admin › Users "Partners")
 * GET   /partners/:partyId                                     a party's Portal access: switch, limits, roles, people
 * POST  /partners/:partyId/settings                            portal on/off, people and roles allowed, production progress (C1)
 * POST  /partners/:partyId/people                              invite a person (role, capabilities, end of access)
 * POST  /partners/:partyId/people/:userId/invitation           the invitation again
 * POST  /partners/:partyId/people/:userId/invitation/revoke    the open invitation stops
 * PATCH /partners/:partyId/people/:userId                      role, capabilities, end of access
 * POST  /partners/:partyId/people/:userId/{suspend|reactivate|deactivate}
 * POST  /partners/:partyId/preview                             the party's portal, read-only, in this browser
 * GET   /portal/access                                         "My access"
 * GET   /portal/colleagues                                     the organisation's people
 * POST  /portal/colleagues                                     the admin invites a colleague
 * PATCH /portal/colleagues/:userId                             the admin changes a colleague's role
 * POST  /portal/colleagues/:userId/deactivate                  the admin deactivates a colleague
 */
export default defineRoutes('auth-partners', manifest, async (app) => {
  // Paths stay literal, one call each (scripts/factory/check-route-manifest.mjs reads them).
  const auth = () => officeAuthOf(app)
  app.get('/partners', { schema: organisationsContract }, (request) => organisations(auth(), request))
  app.get('/partners/:partyId', { schema: portalAccessContract }, (request) => portalAccess(auth(), request, request.params.partyId))
  app.post('/partners/:partyId/settings', { schema: settingsContract }, (request) => changeSettings(auth(), request, request.params.partyId, request.body, idempotencyKeyFrom(request)))
  app.post('/partners/:partyId/people', { schema: inviteContract }, (request) => invitePerson(auth(), request, request.params.partyId, request.body, idempotencyKeyFrom(request)))
  app.post('/partners/:partyId/people/:userId/invitation', { schema: resendContract }, (request) => resendInvitation(auth(), request, request.params.partyId, request.params.userId, request.body))
  app.post('/partners/:partyId/people/:userId/invitation/revoke', { schema: revokeContract }, (request) => revokeInvitation(auth(), request, request.params.partyId, request.params.userId, request.body))
  app.patch('/partners/:partyId/people/:userId', { schema: changeContract }, (request) => changePerson(auth(), request, request.params.partyId, request.params.userId, request.body, idempotencyKeyFrom(request)))
  app.post('/partners/:partyId/people/:userId/suspend', { schema: statusContract }, (request) => changeStatus(auth(), request, request.params.partyId, request.params.userId, request.body, 'suspend'))
  app.post('/partners/:partyId/people/:userId/reactivate', { schema: statusContract }, (request) => changeStatus(auth(), request, request.params.partyId, request.params.userId, request.body, 'reactivate'))
  app.post('/partners/:partyId/people/:userId/deactivate', { schema: statusContract }, (request) => changeStatus(auth(), request, request.params.partyId, request.params.userId, request.body, 'deactivate'))
  app.post('/partners/:partyId/preview', { schema: previewContract }, (request, reply) => preview(auth(), request, reply, request.params.partyId, request.body))

  app.get('/portal/access', { schema: myAccessContract }, (request) => myAccess(app, request))
  app.get('/portal/colleagues', { schema: colleaguesContract }, (request) => colleagues(app, request))
  app.post('/portal/colleagues', { schema: colleagueInviteContract }, (request) => inviteColleague(app, request, request.body, idempotencyKeyFrom(request)))
  app.patch('/portal/colleagues/:userId', { schema: colleagueChangeContract }, (request) => changeColleague(app, request, request.params.userId, request.body, idempotencyKeyFrom(request)))
  app.post('/portal/colleagues/:userId/deactivate', { schema: colleagueDeactivateContract }, (request) => deactivateColleague(app, request, request.params.userId, request.body))
})
