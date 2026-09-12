import type { FastifyPluginAsync } from 'fastify'
import { getContentWorkspace, saveContentWorkspace, contentDestination, type ContentScope } from '../../services/shopify/content-workspace.service.js'
import { previewContentSync, synchronizeContent } from '../../services/shopify/content-sync.service.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'
import { importContentSource } from '../../services/shopify/content-import.service.js'
import { listContentCollections, readCollectionContent, publicCollection, saveCollectionContent, synchronizeCollectionContent } from '../../services/shopify/collection-content.service.js'

type Request = { Params: { productId: string }; Querystring: ContentScope; Body: unknown }
export const shopifyContentRoutes: FastifyPluginAsync = async app => {
  for (const [method, suffix] of [['GET', '/collections'], ['GET', '/collections/:collectionId'], ['PUT', '/collections/:collectionId'], ['POST', '/collections/:collectionId/synchronize']] as const) {
    app.route<{ Params: { productId: string; collectionId?: string }; Querystring: ContentScope; Body: unknown }>({ method, url: `/products/:productId/shopify-content${suffix}`, handler: async (request, reply) => {
      try {
        const destination = await contentDestination(request.params.productId, request.query)
        const id = request.params.collectionId
        if (!id) return await listContentCollections(destination.accountId)
        if (method === 'PUT') return await saveCollectionContent(destination.accountId, id, request.body)
        if (method === 'POST') return await synchronizeCollectionContent(destination.accountId, id, request.body)
        return publicCollection(await readCollectionContent(destination.accountId, id))
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        request.log.error({ err: error }, 'Shopify collection request failed')
        return reply.code(502).send({ error: 'The collection result could not be verified. Reload before retrying; local product content is preserved.' })
      }
    } })
  }
  for (const [method, suffix] of [['GET', ''], ['PUT', ''], ['POST', '/preview'], ['POST', '/import-source'], ['POST', '/synchronize']] as const) {
    app.route<Request>({ method, url: `/products/:productId/shopify-content${suffix}`, handler: async (request, reply) => {
      try {
        const { productId } = request.params
        if (suffix === '/import-source') return await importContentSource(productId, request.query, (request.body as { sourceProductId?: string } | null)?.sourceProductId ?? '')
        if (suffix === '/preview') return await previewContentSync(productId, request.query, (request.body as { remote?: boolean } | null)?.remote === true)
        if (suffix === '/synchronize') return await synchronizeContent(productId, request.query, request.body)
        return method === 'GET' ? await getContentWorkspace(productId, request.query) : await saveContentWorkspace(productId, request.query, request.body)
      } catch (error) {
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        if (typeof (error as { statusCode?: number }).statusCode === 'number') return reply.code((error as { statusCode: number }).statusCode).send({ error: (error as Error).message })
        request.log.error({ err: error }, 'Shopify content request failed')
        return reply.code(500).send({ error: suffix === '/preview' ? 'Shopify could not be read. Check the connected account and retry. Local edits are preserved.' : 'The result could not be confirmed. Keep your edits and reload the saved state before retrying.' })
      }
    } })
  }
}
