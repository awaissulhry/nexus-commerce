import type { FastifyPluginAsync } from 'fastify'
import { taxonomyHistory, listTaxonomySources, readTaxonomyRequirements, requestTaxonomyRefresh, searchTaxonomy } from '../services/taxonomy/repository.js'
import { TaxonomyError } from '../services/taxonomy/model.js'
import { categoryDirectory, categoryAssignments, categoryChangeImpact, applyCategoryCommand, CategoryTreeError, type CategoryCommand } from '../services/taxonomy/category-workspace.js'
import { workspaceContext } from '@nexus/database/workspace-context'

const routes: FastifyPluginAsync = async app => {
  const error = (reply: any, caught: unknown) => {
    if (caught instanceof TaxonomyError) return reply.code(caught.statusCode).send({ error: caught.message })
    if (caught instanceof CategoryTreeError) return reply.code(caught.status).send({ error: caught.message })
    app.log.error({ err: caught }, 'Taxonomy request failed')
    return reply.code(503).send({ error: 'Category data is temporarily unavailable. Retry in a moment.' })
  }
  app.get('/pim/category-workspace', async (_request, reply) => {
    try { return await categoryDirectory() } catch (caught) { return error(reply, caught) }
  })
  app.post<{ Body: CategoryCommand }>('/pim/category-workspace/preview', async (request, reply) => {
    try { return await categoryChangeImpact(request.body ?? {} as CategoryCommand) } catch (caught) { return error(reply, caught) }
  })
  app.post<{ Body: CategoryCommand }>('/pim/category-workspace/apply', async (request, reply) => {
    try { return await applyCategoryCommand(request.body ?? {} as CategoryCommand, workspaceContext()?.actorUserId ?? null) } catch (caught) { return error(reply, caught) }
  })
  app.get<{ Params: { channel: string; market: string } }>('/pim/category-workspace/:channel/:market/assignments', async (request, reply) => {
    try { return await categoryAssignments(request.params.channel.toUpperCase(), request.params.market.toUpperCase()) } catch (caught) { return error(reply, caught) }
  })
  app.get('/pim/taxonomies', async (_request, reply) => {
    try { return { sources: await listTaxonomySources() } } catch (caught) { return error(reply, caught) }
  })
  app.get<{ Params: { channel: string; market: string }; Querystring: { q?: string; page?: string; parentId?: string; snapshotId?: string; assignable?: string } }>('/pim/taxonomies/:channel/:market/nodes', async (request, reply) => {
    try {
      const { q, page, parentId, snapshotId, assignable } = request.query
      if ((q !== undefined && typeof q !== 'string') || (page !== undefined && typeof page !== 'string') || (parentId !== undefined && typeof parentId !== 'string') || (snapshotId !== undefined && (typeof snapshotId !== 'string' || snapshotId.length > 300)) || (q?.length ?? 0) > 200 || (page !== undefined && !/^[1-9]\d{0,5}$/.test(page)) || (parentId?.length ?? 0) > 300) throw new TaxonomyError('Enter a shorter search or a valid page number.')
      return await searchTaxonomy(request.params.channel.toUpperCase(), request.params.market.toUpperCase(), { query: q, page: Number(page || 1), parentId, snapshotId, assignableOnly: assignable === '1' })
    } catch (caught) { return error(reply, caught) }
  })
  app.get<{ Params: { channel: string; market: string }; Querystring: { id?: string } }>('/pim/taxonomies/:channel/:market/requirements', async (request, reply) => {
    try {
      if (typeof request.query.id !== 'string' || !request.query.id || request.query.id.length > 300) throw new TaxonomyError('Choose a category.')
      return await readTaxonomyRequirements(request.params.channel.toUpperCase(), request.params.market.toUpperCase(), request.query.id)
    } catch (caught) { return error(reply, caught) }
  })
  app.post<{ Params: { channel: string; market: string }; Body: { categoryId?: string } }>('/pim/taxonomies/:channel/:market/refresh', async (request, reply) => {
    try {
      const id = request.body?.categoryId
      if (id !== undefined && (typeof id !== 'string' || !id || id.length > 300)) throw new TaxonomyError('Choose a valid category.')
      const source = await requestTaxonomyRefresh(request.params.channel.toUpperCase(), request.params.market.toUpperCase(), id)
      return reply.code(202).send({ sourceId: source.id, state: 'queued' })
    } catch (caught) { return error(reply, caught) }
  })
  app.get<{ Params: { sourceId: string } }>('/pim/taxonomies/:sourceId/history', async (request, reply) => {
    try {
      return { runs: await taxonomyHistory(request.params.sourceId) }
    } catch (caught) { return error(reply, caught) }
  })
}
export default routes
