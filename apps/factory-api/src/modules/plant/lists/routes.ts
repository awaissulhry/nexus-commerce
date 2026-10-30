import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createClassContract, createSymptomContract, listClassesContract, listSymptomsContract, starterContract, updateClassContract, updateSymptomContract } from '../contract'
import { addStarter, createClass, createSymptom, listClasses, listSymptoms, updateClass, updateSymptom } from './lists'
import { manifest } from './manifest'

/**
 * The machine classes and the symptoms the floor reports (B-W2a-35; ./lists.ts). Each write is one command with an
 * Idempotency-Key; a repeated key answers from its receipt.
 */
export default defineRoutes('plant.lists', manifest, async (app) => {
  app.get('/plant/classes', { schema: listClassesContract }, async (request) => listClasses(request, request.query))

  app.post('/plant/classes', { schema: createClassContract }, async (request, reply) => {
    const { replayed, ...answer } = await createClass(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.patch('/plant/classes/:classId', { schema: updateClassContract }, async (request) => updateClass(request, request.params.classId, request.body, idempotencyKeyFrom(request)))

  app.get('/plant/symptoms', { schema: listSymptomsContract }, async (request) => listSymptoms(request, request.query))

  app.post('/plant/symptoms', { schema: createSymptomContract }, async (request, reply) => {
    const { replayed, ...answer } = await createSymptom(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.patch('/plant/symptoms/:symptomId', { schema: updateSymptomContract }, async (request) => updateSymptom(request, request.params.symptomId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/starter', { schema: starterContract }, async (request) => addStarter(request, idempotencyKeyFrom(request)))
})
