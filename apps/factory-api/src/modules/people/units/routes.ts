import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  closeUnitContract,
  createUnitContract,
  employeeHistoryContract,
  mergeUnitsContract,
  moveUnitContract,
  readyMadeApplyContract,
  readyMadePreviewContract,
  structureContract,
  unitHistoryContract,
  unitRecordContract,
  updateUnitContract,
} from './contract'
import { employeeHistory, unitHistory } from './history'
import { manifest } from './manifest'
import { mergeUnits } from './merge'
import { structure, unitRecord } from './read'
import { applyReadyMade, previewReadyMade } from './ready-made'
import { closeUnit, createUnit, moveUnit, updateUnit } from './units'

/**
 * The factory structure (owb-ss5 steps 5.2 + 5.3): the reads (./read.ts), the histories (./history.ts), one unit's writes
 * (./units.ts), the merge (./merge.ts) and the ready-made structures (./ready-made.ts). Each write is one command with an
 * Idempotency-Key.
 */
export default defineRoutes('people.units', manifest, async (app) => {
  app.get('/people/structure', { schema: structureContract }, async (request) => structure(request, request.query))
  app.get('/people/units/:unitId', { schema: unitRecordContract }, async (request) => unitRecord(request, request.params.unitId))
  app.get('/people/units/:unitId/history', { schema: unitHistoryContract }, async (request) => unitHistory(request, request.params.unitId))
  app.get('/people/employees/:employeeId/history', { schema: employeeHistoryContract }, async (request) => employeeHistory(request, request.params.employeeId))
  app.post('/people/units', { schema: createUnitContract }, async (request, reply) => {
    const { replayed, ...answer } = await createUnit(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })
  app.patch('/people/units/:unitId', { schema: updateUnitContract }, async (request) => updateUnit(request, request.params.unitId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/units/:unitId/move', { schema: moveUnitContract }, async (request) => moveUnit(request, request.params.unitId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/units/merge', { schema: mergeUnitsContract }, async (request) => mergeUnits(request, request.body, idempotencyKeyFrom(request)))
  app.post('/people/units/:unitId/close', { schema: closeUnitContract }, async (request) => closeUnit(request, request.params.unitId, request.body, idempotencyKeyFrom(request)))
  app.post('/people/units/ready-made/preview', { schema: readyMadePreviewContract }, async (request) => previewReadyMade(request, request.body))
  app.post('/people/units/ready-made/apply', { schema: readyMadeApplyContract }, async (request) => applyReadyMade(request, request.body, idempotencyKeyFrom(request)))
})
