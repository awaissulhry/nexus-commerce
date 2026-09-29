import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { contentDestination, type ContentScope } from '../../services/shopify/content-workspace.service.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'
import { findColourProducts, readColourProducts } from '../../services/shopify/colour-products/find.service.js'
import { confirmColourProducts } from '../../services/shopify/colour-products/confirm.service.js'
import { readColourProductSettings, saveColourProductSettings } from '../../services/shopify/colour-products/settings.js'

/**
 * Shopify colour products (docs/studies/shopify-linked-variations-PLAN.md, PR 3). Every route resolves the business,
 * the family and the explicit connected store first (`contentDestination`), like the other Shopify routes.
 * `GET ''` the plan and the rows · `POST /find` read Shopify and store proposals (no Shopify write) ·
 * `POST /confirm` adopt the confirmed colours (identity + missing SKUs on Shopify, ids on the size listings) ·
 * `GET|PUT /settings` the store switch.
 */
type Request = { Params: { productId: string }; Querystring: ContentScope; Body: unknown }
export const shopifyColourProductsRoutes: FastifyPluginAsync = async app => {
  for (const [method, suffix] of [['GET', ''], ['POST', '/find'], ['POST', '/confirm'], ['GET', '/settings'], ['PUT', '/settings']] as const) {
    app.route<Request>({ method, url: `/products/:productId/shopify-colour-products${suffix}`, handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      try {
        const { productId } = request.params
        if (suffix === '/find') return await findColourProducts(productId, request.query, request.body)
        if (suffix === '/confirm') return await confirmColourProducts(productId, request.query, request.body)
        if (suffix === '/settings') {
          const destination = await contentDestination(productId, request.query)
          return method === 'PUT' ? await saveColourProductSettings(destination.accountId, request.body) : await readColourProductSettings(destination.accountId)
        }
        return await readColourProducts(productId, request.query)
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(i => i.message).join(' ') })
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        request.log.error({ err: error }, 'Shopify colour products request failed')
        return reply.code(502).send({ error: suffix === '/find' ? 'Shopify could not be read. Check the connected store and retry. Nothing was changed.'
          : suffix === '/confirm' ? 'The confirm stopped. Some colours may be confirmed. Run Find again to see where it stopped, then confirm what is left.' : 'The request could not be completed. Reload and retry.' })
      }
    } })
  }
}
