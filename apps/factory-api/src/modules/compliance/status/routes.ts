import { defineRoutes } from '../../../core/manifest'
import { statusActions, statusBoard, statusCell, statusExpiries } from './board'
import { actionsContract, boardContract, cellContract, expiriesContract } from './contract'
import { manifest } from './manifest'

/**
 * The compliance status board's reads (B-W2b-254; PRD-277, PRD-271): readiness tiles, the style × market matrix, the
 * checklist of a cell, "Needs action", what expires next. The screen is B-W2b-266 (SCR-119); the gate refusals feed and
 * the override are modules/compliance/gates.
 */
export default defineRoutes('compliance.status', manifest, async (app) => {
  app.get('/compliance/status/board', { schema: boardContract }, async (request) => statusBoard(request, request.query))
  app.get('/compliance/status/actions', { schema: actionsContract }, async (request) => statusActions(request, request.query))
  app.get('/compliance/status/cell', { schema: cellContract }, async (request) => statusCell(request, request.query))
  app.get('/compliance/status/expiries', { schema: expiriesContract }, async (request) => statusExpiries(request, request.query))
})
