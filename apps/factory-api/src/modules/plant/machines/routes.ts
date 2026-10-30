import { idempotencyKeyFrom } from '../../../core/command'
import { defineRoutes } from '../../../core/manifest'
import { createMachineContract, listMachinesContract, machineCountsContract, machineRecordContract, retireMachineContract, updateMachineContract } from '../contract'
import { createMachine, listMachines, machineCounts, machineRecord, retireMachine, updateMachine } from './machines'
import { manifest } from './manifest'

/** The machine and equipment register (B-W2a-35; ./machines.ts). Each write is one command with an Idempotency-Key. */
export default defineRoutes('plant.machines', manifest, async (app) => {
  app.get('/plant/machines', { schema: listMachinesContract }, async (request) => listMachines(request, request.query))

  app.get('/plant/machines/counts', { schema: machineCountsContract }, async (request) => machineCounts(request, request.query))

  app.get('/plant/machines/:machineId', { schema: machineRecordContract }, async (request) => machineRecord(request, request.params.machineId))

  app.post('/plant/machines', { schema: createMachineContract }, async (request, reply) => {
    const { replayed, ...answer } = await createMachine(request, request.body, idempotencyKeyFrom(request))
    return reply.code(replayed ? 200 : 201).send(answer)
  })

  app.patch('/plant/machines/:machineId', { schema: updateMachineContract }, async (request) => updateMachine(request, request.params.machineId, request.body, idempotencyKeyFrom(request)))

  app.post('/plant/machines/:machineId/retire', { schema: retireMachineContract }, async (request) => retireMachine(request, request.params.machineId, request.body, idempotencyKeyFrom(request)))
})
