import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { requireStepUp } from '../../../platform/auth/office/account'
import { officeAuthOf } from '../../../platform/auth/sessions/office-auth'
import { processFiles } from '../../../platform/files/service'
import { cancelContract, countsContract, createContract, getContract, headerContract, listContract, previewContract, receiveContract, safetyContract, shipContract, stageContract } from './contract'
import { createRepair, previewRepair } from './create'
import { listRepairs, repairCounts } from './list'
import { manifest } from './manifest'
import { signSafetyCheck } from './safety'
import { shipRepair } from './ship'
import { cancelRepair, changeRepair, getRepair, moveRepair, receiveRepair } from './stages'

/**
 * Repairs and alterations of B-W2a-57: the list and its tiles (./list.ts), making one from an RMA line, a complaint or by
 * hand (./create.ts), the record, its header, the garment's arrival, the stage moves and the cancel (./stages.ts), the
 * safety check of a repaired protective garment — an e-signature: the office's fresh code, asked after every other
 * check (./safety.ts) — and the way back with its DDT (./ship.ts).
 */
export default defineRoutes('sales.repairs', manifest, async (app) => {
  app.get('/sales/repairs', { schema: listContract }, async (request) => listRepairs(request, request.query))
  app.get('/sales/repairs/counts', { schema: countsContract }, async (request) => repairCounts(request))
  app.post('/sales/repairs/preview', { schema: previewContract }, async (request) => previewRepair(request, request.body))
  app.post('/sales/repairs', { schema: createContract }, async (request, reply) => reply.code(201).send(await createRepair(request, request.body, idempotencyKeyFrom(request))))

  app.get('/sales/repairs/:repairId', { schema: getContract }, async (request) => getRepair(request, request.params.repairId))
  app.patch('/sales/repairs/:repairId', { schema: headerContract }, async (request) => changeRepair(request, request.params.repairId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/:repairId/receive', { schema: receiveContract }, async (request) => receiveRepair(request, request.params.repairId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/:repairId/stage', { schema: stageContract }, async (request) => moveRepair(request, request.params.repairId, request.body, idempotencyKeyFrom(request)))
  app.post('/sales/repairs/:repairId/safety-check', { schema: safetyContract }, async (request) =>
    signSafetyCheck(request, request.params.repairId, request.body, () => requireStepUp(officeAuthOf(app), request), idempotencyKeyFrom(request)),
  )
  app.post('/sales/repairs/:repairId/ship', { schema: shipContract }, async (request) =>
    shipRepair(processFiles(), request, request.params.repairId, request.body, idempotencyKeyFrom(request), (error) => request.log.error({ err: error }, 'the repair DDT is issued; its PDF was not stored')),
  )
  app.post('/sales/repairs/:repairId/cancel', { schema: cancelContract }, async (request) => cancelRepair(request, request.params.repairId, request.body, idempotencyKeyFrom(request)))
})
