import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { countsContract, editContract, getContract, listContract, placeContract, previewContract, releaseContract } from './contract'
import { editHold, placeHold, releaseHold } from './holds'
import { manifest } from './manifest'
import { getHold, holdCounts, listHolds, previewHold } from './reads'

const flag = (value: 'true' | 'false' | undefined): boolean | undefined => (value === undefined ? undefined : value === 'true')

/**
 * Quality holds of B-W2a-26 (QHS-074, MES-008): the reads (./reads.ts), place, change and release (./holds.ts; a release
 * is an e-signature: the office's step-up first). The hooks that refuse held work at scans, issue and packing are
 * ./checks.ts; held stock in the stock figures ./stock.ts.
 */
export default defineRoutes('quality.holds', manifest, async (app) => {
  app.get('/quality/holds', { schema: listContract }, async (request) => listHolds(request, { ...request.query, overdue: flag(request.query.overdue), system: flag(request.query.system) }))

  app.get('/quality/holds/counts', { schema: countsContract }, async (request) => holdCounts(request, request.query))

  app.get('/quality/holds/:holdId', { schema: getContract }, async (request) => getHold(request, request.params.holdId))

  app.post('/quality/holds/preview', { schema: previewContract }, async (request) => previewHold(request, request.body))

  app.post('/quality/holds', { schema: placeContract }, async (request, reply) => reply.code(201).send(await placeHold(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/holds/:holdId', { schema: editContract }, async (request) => editHold(request, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/holds/:holdId/release', { schema: releaseContract }, async (request) => {
    await requireStepUp(officeAuthOf(app), request)
    return releaseHold(request, request.params.holdId, request.body, idempotencyKeyFrom(request))
  })
})
