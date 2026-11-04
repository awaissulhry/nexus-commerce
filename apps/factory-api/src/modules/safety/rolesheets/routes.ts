import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { personRoleSheet, previewRoleChange, setRoleSheet } from '../../people/employees/role-sheet'
import {
  applySheetContract,
  catalogueContract,
  createSheetContract,
  listSheetsContract,
  personRoleSheetContract,
  previewRoleChangeContract,
  previewSheetContract,
  setRoleSheetContract,
  sheetRecordContract,
  sheetStatusContract,
} from './contract'
import { manifest } from './manifest'
import { addSheet, applySheet, listSheets, previewSheet, setSheetStatus, sheetCatalogue, sheetRecord } from './sheets'

/**
 * The role risk sheets (B-W2b-128; ./sheets.ts) and a person's role (../../people/employees/role-sheet.ts: the HR record's,
 * registered here so the people module's routes file stays its own). Each write is one command with an Idempotency-Key; a
 * repeated key answers from its receipt.
 */
export default defineRoutes('safety.rolesheets', manifest, async (app) => {
  app.get('/safety/rolesheets', { schema: listSheetsContract }, async (request) => listSheets(request, request.query))
  app.get('/safety/rolesheets/catalogue', { schema: catalogueContract }, async (request) => sheetCatalogue(request, request.query))
  app.get('/safety/rolesheets/:roleSheetId', { schema: sheetRecordContract }, async (request) => sheetRecord(request, request.params.roleSheetId))
  app.post('/safety/rolesheets', { schema: createSheetContract }, async (request, reply) => {
    const answer = await addSheet(request, request.body, idempotencyKeyFrom(request))
    return reply.code(answer.replayed ? 200 : 201).send({ roleSheet: answer.roleSheet })
  })
  app.post('/safety/rolesheets/:roleSheetId/preview', { schema: previewSheetContract }, async (request) => previewSheet(request, request.params.roleSheetId, request.body))
  app.post('/safety/rolesheets/:roleSheetId/apply', { schema: applySheetContract }, async (request) => applySheet(request, request.params.roleSheetId, request.body, idempotencyKeyFrom(request)))
  app.post('/safety/rolesheets/:roleSheetId/archive', { schema: sheetStatusContract }, async (request) => setSheetStatus(request, request.params.roleSheetId, 'ARCHIVED', request.body, idempotencyKeyFrom(request)))
  app.post('/safety/rolesheets/:roleSheetId/restore', { schema: sheetStatusContract }, async (request) => setSheetStatus(request, request.params.roleSheetId, 'ACTIVE', request.body, idempotencyKeyFrom(request)))

  app.get('/people/employees/:employeeId/role-sheet', { schema: personRoleSheetContract }, async (request) => personRoleSheet(request, request.params.employeeId))
  app.post('/people/employees/:employeeId/role-sheet/preview', { schema: previewRoleChangeContract }, async (request) => previewRoleChange(request, request.params.employeeId, request.body))
  app.put('/people/employees/:employeeId/role-sheet', { schema: setRoleSheetContract }, async (request) => setRoleSheet(request, request.params.employeeId, request.body, idempotencyKeyFrom(request)))
})
