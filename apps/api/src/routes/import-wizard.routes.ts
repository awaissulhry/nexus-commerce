/** Compatibility routes retain history; new imports use the explicit catalog source review. */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify'
import prisma from '../db.js'
import { ImportWizardService } from '../services/import-wizard.service.js'
import { previewCatalogSource } from '../services/pim/catalog-source.service.js'
import { TransferConflict } from '../services/pim/catalog-transfer.service.js'
import { hasPermission } from '../lib/auth/rbac.js'

const service = new ImportWizardService(prisma)
const actor = (r: FastifyRequest) => (r as FastifyRequest & { authUser?: { id?: string } }).authUser?.id ?? null
const importWizardRoutes: FastifyPluginAsync = async fastify => {
  fastify.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET' && process.env.NEXUS_RBAC_MODE === 'enforce' && (!request.__rbacResolved || !hasPermission(request.__rbacResolved, 'products.import'))) return reply.code(403).send({ error: 'Catalog import permission required' })
  })
  fastify.setErrorHandler((error, _request, reply) => reply.code(error instanceof TransferConflict ? 409 : 400).send({ success: false, error: error instanceof Error ? error.message : String(error) }))
  fastify.get('/import-jobs', async request => ({ success: true, jobs: await service.list({ ...request.query as { status?: string }, userId: actor(request) }) }))
  fastify.get('/import-jobs/:id', async (request, reply) => {
    const job = await service.get((request.params as { id: string }).id, actor(request))
    return job ? { success: true, job } : reply.code(404).send({ error: 'Import job not found' })
  })
  fastify.get('/import-jobs/:id/rows', async (request, reply) => {
    const id = (request.params as { id: string }).id
    if (!await service.get(id, actor(request))) return reply.code(404).send({ error: 'Import job not found' })
    const q = request.query as { status?: string; limit?: string; offset?: string }
    return { success: true, rows: await service.listRows(id, { status: q.status, limit: Number(q.limit ?? 50), offset: Number(q.offset ?? 0) }) }
  })
  fastify.post('/import-jobs/preview', async (request, reply) => {
    const body = request.body as Parameters<typeof previewCatalogSource>[0]
    if (!body?.sourceId || !body.mapping) throw new TransferConflict('Upload and map the file at /products/catalog-transfer. Legacy automatic field inference has no reviewed ownership policy.')
    return reply.code(201).send(await previewCatalogSource({ ...body, userId: actor(request) }))
  })
  fastify.post('/import-jobs/:id/apply', async (request, reply) => reply.code(202).send({ success: true, ...await service.apply((request.params as { id: string }).id, (request.body as { reviewToken?: string })?.reviewToken, actor(request)) }))
  fastify.post('/import-jobs/:id/retry-failed', async (request, reply) => reply.code(201).send({ success: true, job: await service.retryFailed((request.params as { id: string }).id, actor(request)) }))
  fastify.post('/import-jobs/:id/rollback', async request => service.rollback((request.params as { id: string }).id))
}
export default importWizardRoutes
