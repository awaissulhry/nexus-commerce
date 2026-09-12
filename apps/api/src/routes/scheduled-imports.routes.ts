import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import { ScheduledImportService, type CreateScheduledImportInput } from '../services/scheduled-import.service.js'
import { TransferConflict } from '../services/pim/catalog-transfer.service.js'
import prisma from '../db.js'

const service = new ScheduledImportService(prisma)
const actor = (r: FastifyRequest) => (r as FastifyRequest & { authUser?: { id?: string } }).authUser?.id ?? null
const scheduledImportsRoutes: FastifyPluginAsync = async fastify => {
  fastify.setErrorHandler((error, _request, reply) => reply.code(error instanceof TransferConflict ? 409 : 400).send({ success: false, error: error instanceof Error ? error.message : String(error) }))
  const owned = async (request: FastifyRequest) => {
    const row = await service.get((request.params as { id: string }).id)
    if (!row || row.createdBy !== actor(request)) throw new TransferConflict('Schedule not found')
    return row
  }
  fastify.get('/scheduled-imports', async request => ({ success: true, schedules: await service.list({ userId: actor(request) }) }))
  fastify.get('/scheduled-imports/:id', async request => ({ success: true, schedule: await owned(request) }))
  fastify.post('/scheduled-imports', async (request, reply) => reply.code(201).send({ success: true, schedule: await service.create({ ...request.body as CreateScheduledImportInput, createdBy: actor(request) }) }))
  fastify.patch('/scheduled-imports/:id/enabled', async request => {
    const row = await owned(request), body = request.body as { enabled?: boolean; version?: string }
    if (typeof body?.enabled !== 'boolean') throw new Error('Choose whether the schedule is enabled')
    return { success: true, schedule: await service.setEnabled(row.id, body.enabled, body.version) }
  })
  fastify.delete('/scheduled-imports/:id', async request => {
    await service.deleteOwned((request.params as { id: string }).id, actor(request), (request.query as { version?: string }).version)
    return { success: true }
  })
  fastify.post('/scheduled-imports/:id/run', async request => {
    const row = await owned(request), version = (request.body as { version?: string })?.version
    if (version !== row.updatedAt.toISOString()) throw new TransferConflict('Schedule changed; reload it')
    const result = await service.fireOnce(row)
    await service.markFired(row.id, { jobId: result.jobId, status: result.status })
    return { success: true, ...result }
  })
  fastify.post('/scheduled-imports/tick', async () => { throw new TransferConflict('Run one selected schedule with its current version; background ticks are automatic') })
}
export default scheduledImportsRoutes
