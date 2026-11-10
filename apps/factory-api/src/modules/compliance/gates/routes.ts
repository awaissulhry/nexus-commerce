import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeSessionOf } from '../../../platform/auth/sessions/authenticator'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { checkContract, feedContract, overrideContract } from './contract'
import { checkGateNow, gateFeed, overrideRefusalOf } from './events'
import { manifest } from './manifest'

/**
 * The one compliance gate's office routes (B-W2b-254; PRD-272): the Gate refusals feed with "cleared by / still
 * blocked", an override for one subject (named roles, a written reason, step-up, at most the requirement's days), and the
 * gate's answer now. The steps that refuse (work-order release, label print, final release, shipment) call the gate in
 * their own commands (./at-steps). Screens: B-W2b-266 (status board), B-W2b-265 (Rules & markets › Gates).
 */
export default defineRoutes('compliance.gates', manifest, async (app) => {
  app.get('/compliance/gates/events', { schema: feedContract }, async (request) => gateFeed(request, request.query))
  app.post('/compliance/gates/events/:eventId/override', { schema: overrideContract }, async (request, reply) => {
    const answer = await overrideRefusalOf(request, request.params.eventId, request.body, {
      stepUp: () => requireStepUp(officeAuthOf(app), request),
      stepUpAt: () => officeSessionOf(request).stepUpAt,
      idempotencyKey: idempotencyKeyFrom(request),
    })
    return reply.code(201).send(answer)
  })
  app.get('/compliance/gates/check', { schema: checkContract }, async (request) => checkGateNow(request, request.query))
})
