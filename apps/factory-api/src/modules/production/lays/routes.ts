import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { addRollContract, changeRollContract, countLayContract, fabricUsedContract, readLayContract, reconcileContract, reconciliationContract, startLayContract, undoRollContract } from './contract'
import { confirmFabricUsed, readLay } from './fabric'
import { manifest } from './manifest'
import { readReconciliation, reconcileCutOrder } from './reconcile'
import { addRoll, changeRoll, countLay, startSpread, undoRoll } from './spread'

/**
 * Lays at the table and the reconciliation of a cut order (B-W2b-116; MES-038 the spreading report, MES-039 the ply count at both
 * ends, MES-046 the fabric used at cut finish, MES-045 cut against ordered): the table reads a lay, starts it, spreads its rolls,
 * corrects or undoes one, counts both ends (./spread.ts) and confirms the fabric used, which issues it to the work orders
 * (./fabric.ts); the office reconciles a cut order once it is cut (./reconcile.ts). Every write is ONE command.
 */
export default defineRoutes('production.lays', manifest, async (app) => {
  app.get('/production/lays/:layId', { schema: readLayContract }, async (request) => readLay(request, request.params.layId))
  app.post('/production/lays/:layId/spread', { schema: startLayContract }, async (request) => startSpread(request, request.params.layId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/lays/:layId/rolls', { schema: addRollContract }, async (request, reply) => reply.code(201).send(await addRoll(request, request.params.layId, request.body, idempotencyKeyFrom(request))))
  app.post('/production/lays/:layId/rolls/undo', { schema: undoRollContract }, async (request) => undoRoll(request, request.params.layId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/lays/:layId/rolls/:layRollId', { schema: changeRollContract }, async (request) => changeRoll(request, request.params.layId, request.params.layRollId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/lays/:layId/count', { schema: countLayContract }, async (request) => countLay(request, request.params.layId, request.body, idempotencyKeyFrom(request)))
  app.post('/production/lays/:layId/fabric-used', { schema: fabricUsedContract }, async (request) => confirmFabricUsed(request, request.params.layId, request.body, idempotencyKeyFrom(request)))

  app.get('/production/cut-orders/:cutOrderId/reconciliation', { schema: reconciliationContract }, async (request) => readReconciliation(request, request.params.cutOrderId))
  app.post('/production/cut-orders/:cutOrderId/reconcile', { schema: reconcileContract }, async (request) => reconcileCutOrder(request, request.params.cutOrderId, request.body, idempotencyKeyFrom(request)))
})
