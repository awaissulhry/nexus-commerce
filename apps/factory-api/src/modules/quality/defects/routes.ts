import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import {
  createDefectContract,
  createDispositionContract,
  deleteDefectContract,
  dispositionsContract,
  editDefectContract,
  editDispositionContract,
  libraryContract,
  pickerContract,
  standardDispositionsContract,
  starterContract,
} from './contract'
import { addStarter, createDefect, deleteDefect, editDefect, readLibrary, readPicker } from './defects'
import { addStandardDispositions, createDisposition, editDisposition, readDispositions } from './dispositions'
import { manifest } from './manifest'

/**
 * The defect library (./defects.ts) and the disposition codes (./dispositions.ts) of B-W2a-26 (QHS-001, QHS-005); the
 * stock move a disposition posts is ./stock.ts (postDispositionInCommand, called by the NCR's decisions).
 */
export default defineRoutes('quality.defects', manifest, async (app) => {
  app.get('/quality/defects', { schema: libraryContract }, async (request) => readLibrary(request, request.query))

  app.get('/quality/defects/picker', { schema: pickerContract }, async (request) => readPicker(request, request.query))

  app.post('/quality/defects', { schema: createDefectContract }, async (request, reply) => reply.code(201).send(await createDefect(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/defects/:defectId', { schema: editDefectContract }, async (request) => editDefect(request, request.params.defectId, request.body, idempotencyKeyFrom(request)))

  app.delete('/quality/defects/:defectId', { schema: deleteDefectContract }, async (request) => deleteDefect(request, request.params.defectId, request.query, idempotencyKeyFrom(request)))

  app.post('/quality/defects/starter', { schema: starterContract }, async (request) => addStarter(request, idempotencyKeyFrom(request)))

  app.get('/quality/dispositions', { schema: dispositionsContract }, async (request) => readDispositions(request))

  app.post('/quality/dispositions', { schema: createDispositionContract }, async (request, reply) => reply.code(201).send(await createDisposition(request, request.body, idempotencyKeyFrom(request))))

  app.patch('/quality/dispositions/:dispositionId', { schema: editDispositionContract }, async (request) => editDisposition(request, request.params.dispositionId, request.body, idempotencyKeyFrom(request)))

  app.post('/quality/dispositions/standard', { schema: standardDispositionsContract }, async (request) => addStandardDispositions(request, idempotencyKeyFrom(request)))
})
