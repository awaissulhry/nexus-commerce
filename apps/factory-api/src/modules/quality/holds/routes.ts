import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { countsContract, editContract, getContract, getSettingsContract, listContract, peopleContract, placeContract, previewContract, releaseContract, saveSettingsContract } from './contract'
import { editHold, placeHold, releaseHold } from './holds'
import { manifest } from './manifest'
import { getHold, holdCounts, holdPeople, listHolds, previewHold } from './reads'
import { getHoldSettings, saveHoldSettings } from './settings'
import { affectedContract, askQuarantineContract, confirmQuarantineContract, genealogyContract, nextStepContract, placeGenealogyContract } from './depth-contract'
import { askQuarantine, confirmQuarantine, holdByGenealogy, moveNextStep } from './depth'
import { readAffected, readGenealogy } from './impact'

const flag = (value: 'true' | 'false' | undefined): boolean | undefined => (value === undefined ? undefined : value === 'true')

/**
 * Quality holds of B-W2a-26 (QHS-074, MES-008): the reads (./reads.ts), place, change and release (./holds.ts; a release
 * is an e-signature: the office's step-up first). The hooks that refuse held work at scans, issue and packing are
 * ./checks.ts; held stock in the stock figures ./stock.ts.
 */
export default defineRoutes('quality.holds', manifest, async (app) => {
  app.get('/quality/holds', { schema: listContract }, async (request) => listHolds(request, { ...request.query, overdue: flag(request.query.overdue), system: flag(request.query.system) }))

  app.get('/quality/holds/counts', { schema: countsContract }, async (request) => holdCounts(request, request.query))

  app.get('/quality/holds/people', { schema: peopleContract }, async (request) => holdPeople(request, request.query.siteId))

  // B-W2b-17: who releases a hold (the placer may, by the company's rule; letting them asks the office's step-up).
  app.get('/quality/holds/settings', { schema: getSettingsContract }, async (request) => getHoldSettings(request, request.query))

  app.put('/quality/holds/settings', { schema: saveSettingsContract }, async (request) =>
    saveHoldSettings(request, request.body, { stepUp: () => requireStepUp(officeAuthOf(app), request), idempotencyKey: idempotencyKeyFrom(request) }),
  )

  // B-W2b-114: hold by genealogy (the tree a person ticks; ONE group and a hold per kind and site), before /:holdId.
  app.get('/quality/holds/genealogy', { schema: genealogyContract }, async (request) => readGenealogy(request, request.query))

  app.post('/quality/holds/genealogy', { schema: placeGenealogyContract }, async (request, reply) => reply.code(201).send(await holdByGenealogy(request, request.body, idempotencyKeyFrom(request))))

  app.get('/quality/holds/:holdId/affected', { schema: affectedContract }, async (request) => readAffected(request, request.params.holdId))

  app.post('/quality/holds/:holdId/next-step', { schema: nextStepContract }, async (request) => moveNextStep(request, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/holds/:holdId/quarantine/ask', { schema: askQuarantineContract }, async (request) => askQuarantine(request, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/holds/:holdId/quarantine/confirm', { schema: confirmQuarantineContract }, async (request) => confirmQuarantine(request, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.get('/quality/holds/:holdId', { schema: getContract }, async (request) => getHold(request, request.params.holdId))

  app.post('/quality/holds/preview', { schema: previewContract }, async (request) => previewHold(request, request.body))

  app.post('/quality/holds', { schema: placeContract }, async (request, reply) => reply.code(201).send(await placeHold(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/holds/:holdId', { schema: editContract }, async (request) => editHold(request, request.params.holdId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/holds/:holdId/release', { schema: releaseContract }, async (request) => {
    await requireStepUp(officeAuthOf(app), request)
    return releaseHold(request, request.params.holdId, request.body, idempotencyKeyFrom(request))
  })
})
