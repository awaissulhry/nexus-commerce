import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { massApplyContract, massPreviewContract } from './contract'
import { manifest } from './manifest'
import { applyMassUpdate, previewMassUpdate } from './mass'

/**
 * The mass cost update (B-W2b-423; FIN-022): new standard prices of some materials, the cost sheets they touch recomputed and
 * the effect on the margins of open price lists and orders shown first (a read); applying the update the person saw (its
 * preview hash) is a step-up action and takes an Idempotency-Key (a repeat answers from its receipt).
 */
export default defineRoutes('costing.mass-update', manifest, async (app) => {
  app.post('/costing/mass-updates/preview', { schema: massPreviewContract }, async (request) => previewMassUpdate(request, request.body))
  app.post('/costing/mass-updates/apply', { schema: massApplyContract }, async (request) => {
    requireStepUp(officeAuthOf(app), request)
    return applyMassUpdate(request, request.body, idempotencyKeyFrom(request))
  })
})
