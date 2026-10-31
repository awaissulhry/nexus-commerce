import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { appliedContract, getRenewalsContract, startRenewalContract, successorContract } from './contract'
import { manifest } from './manifest'
import { getRenewals, linkSuccessor, recordApplication, startRenewal } from './renewals'

/**
 * Certificate renewals (B-W2a-66; QHS-105, PRD-283): the Renewals tab of a certificate — the expiry alert stages and their
 * timers, the 12-to-6-month window, Start renewal (a task with the usual steps), the day the application went to the
 * notified body, and the new certificate linked as the successor. The 180- and 90-day stage rules are made by the
 * scheduler (stages.ts, background.ts).
 */
export default defineRoutes('compliance.renewals', manifest, async (app) => {
  app.get('/compliance/certificates/:certificateId/renewals', { schema: getRenewalsContract }, async (request) => ({ renewals: await getRenewals(request, request.params.certificateId) }))

  app.post('/compliance/certificates/:certificateId/renewals/start', { schema: startRenewalContract }, async (request) =>
    startRenewal(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/compliance/certificates/:certificateId/renewals/applied', { schema: appliedContract }, async (request) =>
    recordApplication(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)),
  )

  app.post('/compliance/certificates/:certificateId/renewals/successor', { schema: successorContract }, async (request) =>
    linkSuccessor(request, request.params.certificateId, request.body, idempotencyKeyFrom(request)),
  )
})
