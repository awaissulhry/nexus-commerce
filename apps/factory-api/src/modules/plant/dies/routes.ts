import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createDieContract, dieChoicesContract, dieStylesContract, listDiesContract, retireDieContract, updateDieContract } from './contract'
import { createDie, dieChoices, dieStyles, listDies, retireDie, updateDie } from './dies'
import { manifest } from './manifest'

/** The clicking-die register (B-W2b-136; ./dies.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('plant.dies', manifest, async (app) => {
  app.get('/plant/dies', { schema: listDiesContract }, async (request) => listDies(request, request.query))

  app.get('/plant/dies/styles', { schema: dieStylesContract }, async (request) => dieStyles(request, request.query))

  app.get('/plant/dies/choices', { schema: dieChoicesContract }, async (request) => dieChoices(request, request.query))

  app.post('/plant/dies', { schema: createDieContract }, async (request, reply) => {
    const { replayed, ...answer } = await createDie(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send({ ...answer, replayed })
  })

  app.patch('/plant/dies/:dieId', { schema: updateDieContract }, async (request) => updateDie(request, request.params.dieId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/dies/:dieId/retire', { schema: retireDieContract }, async (request) => retireDie(request, request.params.dieId, request.body, idempotencyKeyFrom(request)))
})
