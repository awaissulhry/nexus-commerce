import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { createRequirementContract, editRequirementContract, gateMatrixContract, getRequirementContract, listRequirementsContract, switchRequirementContract, writeW1Contract } from './contract'
import { manifest } from './manifest'
import { createRequirement, editRequirement, gateMatrix, getRequirement, listRequirements, switchRequirement, writeW1Requirement } from './requirements'

/**
 * Requirements (B-W2b-254; PRD-271, PRD-272): what is needed per product type, PPE category and market, with its law,
 * which gates it blocks, the law's padlocks, who may override it and for how long, switched on or off with the reason.
 * The screen is B-W2b-265 (Rules & markets › Gates: the matrix, EditModeBar, StepUpModal to loosen); the one gate
 * (modules/compliance/gates) and the status board (modules/compliance/status) read the rows.
 */
export default defineRoutes('compliance.requirements', manifest, async (app) => {
  const stepUpOf = (request: Parameters<typeof requireStepUp>[1]) => () => requireStepUp(officeAuthOf(app), request)
  app.get('/compliance/requirements', { schema: listRequirementsContract }, async (request) => listRequirements(request, request.query))
  app.get('/compliance/requirements/gates', { schema: gateMatrixContract }, async (request) => gateMatrix(request))
  app.post('/compliance/requirements', { schema: createRequirementContract }, async (request, reply) => {
    const answer = await createRequirement(request, request.body, idempotencyKeyFrom(request))
    return reply.code(201).send(answer)
  })
  app.post('/compliance/requirements/w1', { schema: writeW1Contract }, async (request) => writeW1Requirement(request, idempotencyKeyFrom(request)))
  app.get('/compliance/requirements/:code', { schema: getRequirementContract }, async (request) => getRequirement(request, request.params.code))
  app.patch('/compliance/requirements/:code', { schema: editRequirementContract }, async (request) => editRequirement(request, request.params.code, request.body, idempotencyKeyFrom(request), stepUpOf(request)))
  app.put('/compliance/requirements/:code/switch', { schema: switchRequirementContract }, async (request) => switchRequirement(request, request.params.code, request.body, idempotencyKeyFrom(request), stepUpOf(request)))
})
