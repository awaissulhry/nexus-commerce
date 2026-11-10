import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { addUseContract, approveContract, choicesContract, countsContract, createContract, editContract, endUseContract, listContract, recordContract, withdrawContract } from './contract'
// The claims' check plugged into the one compliance gate by name (claims.evidence; B-W2b-254's plugGateCheck).
import './gate-plug'
import { manifest } from './manifest'
import { claimChoices, claimCounts, claimRecord, listClaims } from './reads'
import { addUse, approveClaim, createClaim, editClaim, endUse, withdrawClaim } from './writes'

/**
 * Sourcing & claims (B-W2b-264; PRD-380; design compliance.sourcing, SCR-215): the sustainability claims register with words,
 * scope, evidence and expiry (./reads.ts, ./writes.ts); the daily evidence check (./expiry.ts, the scheduler's cron) and the
 * gate's `claims.evidence` check (./gate-plug.ts). Each write is one command with an Idempotency-Key; a repeated key answers
 * from its receipt.
 */
export default defineRoutes('compliance.claims', manifest, async (app) => {
  const stepUpFor = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)

  app.get('/compliance/claims', { schema: listContract }, async (request) => listClaims(request, request.query))
  app.get('/compliance/claims/counts', { schema: countsContract }, async (request) => claimCounts(request))
  app.get('/compliance/claims/choices', { schema: choicesContract }, async (request) => claimChoices(request, request.query))
  app.get('/compliance/claims/:claimId', { schema: recordContract }, async (request) => claimRecord(request, request.params.claimId))
  app.post('/compliance/claims', { schema: createContract }, async (request, reply) => {
    const answer = await createClaim(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.patch('/compliance/claims/:claimId', { schema: editContract }, async (request) => editClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/claims/:claimId/approve', { schema: approveContract }, async (request) =>
    approveClaim(request, request.params.claimId, request.body, { stepUp: stepUpFor(request), idempotencyKey: idempotencyKeyFrom(request) }),
  )
  app.post('/compliance/claims/:claimId/withdraw', { schema: withdrawContract }, async (request) => withdrawClaim(request, request.params.claimId, request.body, idempotencyKeyFrom(request)))
  app.post('/compliance/claims/:claimId/uses', { schema: addUseContract }, async (request, reply) => {
    const answer = await addUse(request, request.params.claimId, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send(answer)
  })
  app.post('/compliance/claims/:claimId/uses/:useId/end', { schema: endUseContract }, async (request) => endUse(request, request.params.claimId, request.params.useId, request.body, idempotencyKeyFrom(request)))
})
