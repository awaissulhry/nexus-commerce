import { saveShopifySheetCells, shopifySheetChangesSchema } from '../../services/shopify/channel-sheet.service.js'
import { invalidateShopifyMappingSchema, readShopifyMappingSchema } from '../../services/pim/channel-specs/shopify.js'
import { hasPermission, resolvePermissions } from '../../lib/auth/rbac.js'
import type { FastifyPluginAsync } from 'fastify'
import { z } from 'zod'
import { shopifyLinkedDraftSchema, shopifyProductGid } from '@nexus/shared/shopify-linked-products'
import { contentDestination, type ContentScope } from '../../services/shopify/content-workspace.service.js'
import { shopifyAdmin } from '../../services/shopify/admin-client.js'
import { readLinkedFields, readLinkedOwner, readLinkedProducts, readLinkedStoreSchema, resolveLinkedReferences, searchLinkedReferences } from '../../services/shopify/linked-products-gateway.js'
import { advanceLinkedSync, beginLinkedSync, getLinkedWorkspace, importLinkedFamily, previewLinkedWorkspace, rebaseLinkedWorkspace, saveLinkedWorkspace } from '../../services/shopify/linked-products.service.js'
import { getLinkedEntry, saveLinkedEntry } from '../../services/shopify/linked-metaobjects.service.js'
import { WorkspaceScopeError } from '../../services/pim/workspace-destination.js'

import { discoverLinkedFamily } from '../../services/shopify/linked-discovery.service.js'
import { configureLinkedAutomation, runLinkedAutomation } from '../../services/shopify/linked-automation.service.js'
import { suggestSharedContent } from '../../services/shopify/linked-shared-content.service.js'
import { readInformation } from '../../services/shopify/information-gateway.js'
import { ensureShopifySchemaSubscriptions } from '../../services/shopify/schema-sync.service.js'

const querySchema = z.object({ accountId: z.string().min(1), listingId: z.string().min(1).optional(), market: z.literal('GLOBAL').default('GLOBAL'),
  locale: z.string().min(2).max(35).optional(), refreshConstraints: z.literal('1').optional(),
  ownerId: z.string().optional(), id: z.string().optional(), type: z.string().optional(), query: z.string().max(200).optional(), cursor: z.string().max(2000).optional(), metaobjectType: z.string().optional() }).strict()
export const shopifyLinkedProductsRoutes: FastifyPluginAsync = async app => {
  const routes = [['GET', ''], ['PUT', ''], ['POST', '/cells'], ['GET', '/schema'], ['POST', '/schema-subscriptions'], ['GET', '/information'], ['GET', '/owner'], ['GET', '/references'], ['POST', '/reference-names'],
    ['POST', '/discover'], ['POST', '/suggest-sharing'], ['POST', '/automation'], ['POST', '/automation-check'], ['POST', '/products'], ['POST', '/read-links'], ['POST', '/field-values'], ['POST', '/import'], ['POST', '/preview'], ['POST', '/rebase'], ['POST', '/synchronize'], ['POST', '/advance'], ['GET', '/entry'], ['POST', '/entry']] as const
  for (const [method, suffix] of routes) app.route<{ Params: { productId: string }; Querystring: ContentScope; Body: unknown }>({
    method, url: `/products/:productId/shopify-linked${suffix}`, bodyLimit: 10 * 1024 * 1024,
    handler: async (request, reply) => {
      reply.header('Cache-Control', 'private, no-store')
      try {
        const query = querySchema.parse(request.query), id = request.params.productId
        // Every route resolves the business, family and explicit connected store before any remote access.
        const destination = await contentDestination(id, query)
        if ((!suffix && method === 'PUT') || suffix === '/synchronize' || suffix === '/advance') {
          const workspace = await getLinkedWorkspace(id, query)
          const proposed = !suffix ? (request.body as { draft?: { mediaEdits?: unknown } })?.draft?.mediaEdits ?? [] : workspace.draft.mediaEdits ?? []
          if (!suffix ? JSON.stringify(proposed) !== JSON.stringify(workspace.draft.mediaEdits ?? []) : workspace.draft.mediaEdits?.length) {
            const permissions = request.__rbacResolved ?? (request.authUser ? await resolvePermissions(request.authUser) : null)
            if (!permissions || !hasPermission(permissions, 'products.images.edit')) throw new WorkspaceScopeError('Gallery changes require the Nexus products.images.edit permission.', 403)
          }
        }
        if (suffix === '/synchronize' || suffix === '/advance') {
          const workspace = await getLinkedWorkspace(id, query)
          const hasMedia = suffix === '/advance' ? workspace.operation?.includesSheetMedia : workspace.hasSheetMedia && (await previewLinkedWorkspace(id, query)).plan.sheetGalleries?.length
          if (hasMedia) {
            const permissions = request.__rbacResolved ?? (request.authUser ? await resolvePermissions(request.authUser) : null)
            if (!permissions || !hasPermission(permissions, 'products.images.edit')) throw new WorkspaceScopeError('Gallery synchronization requires the Nexus products.images.edit permission.', 403)
          }
          if (workspace.draft.nativeEdits?.some(e => e.field === 'inventory')) {
            const permissions = request.__rbacResolved ?? (request.authUser ? await resolvePermissions(request.authUser) : null)
            if (!permissions || !hasPermission(permissions, 'inventory.adjust')) throw new WorkspaceScopeError('Inventory adjustments require the Nexus inventory.adjust permission.', 403)
          }
        }
        if (suffix === '/cells') {
          const input = shopifySheetChangesSchema.parse(request.body)
          const permissions = request.__rbacResolved ?? (request.authUser ? await resolvePermissions(request.authUser) : null)
          for (const [field, permission] of [['media', 'products.images.edit'], ['inventory', 'inventory.adjust']] as const) {
            if (input.cells.some(c => c.fieldId === field) && (!permissions || !hasPermission(permissions, permission))) throw new WorkspaceScopeError(`This edit requires ${permission} permission.`, 403)
          }
          return await saveShopifySheetCells(id, query, input, request.authUser?.id ?? null)
        }
        if (suffix === '/schema-subscriptions') return await ensureShopifySchemaSubscriptions(destination.accountId)
        if (!suffix) return method === 'GET' ? await getLinkedWorkspace(id, query) : await saveLinkedWorkspace(id, query, request.body, request.authUser?.id ?? null)
        if (suffix === '/automation') return await configureLinkedAutomation(id, query, request.body)
        if (suffix === '/automation-check') return await runLinkedAutomation(id, query)
        if (suffix === '/preview') return await previewLinkedWorkspace(id, query)
        if (suffix === '/synchronize') return await beginLinkedSync(id, query, request.body, 'MANUAL', request.authUser?.id ?? null)
        if (suffix === '/advance') return await advanceLinkedSync(id, query, z.object({ operationId: z.string().uuid() }).parse(request.body).operationId, false, request.authUser?.id ?? null)
        if (suffix === '/rebase') return await rebaseLinkedWorkspace(id, query, z.object({ expectedRevision: z.string() }).parse(request.body).expectedRevision)
        const { graphql } = await shopifyAdmin(destination.accountId)
        if (suffix === '/information') {
          const workspace = await getLinkedWorkspace(id, query)
          return await readInformation(graphql, workspace.draft.members.length ? workspace.draft.members.map(m => m.id) : workspace.suggestedProductIds, await readShopifyMappingSchema(destination.accountId), query.locale)
        }
        if (suffix === '/suggest-sharing') {
          const input = z.object({ draft: shopifyLinkedDraftSchema }).strict().parse(request.body)
          return await suggestSharedContent(graphql, input.draft, await readLinkedStoreSchema(graphql))
        }
        if (suffix === '/discover') {
          const input = z.object({ sourceId: shopifyProductGid.optional(), relationship: z.object({ namespace: z.string().min(1), key: z.string().min(1), includeSelf: z.boolean() }).nullable().optional() }).strict().parse(request.body)
          const workspace = await getLinkedWorkspace(id, query)
          return await discoverLinkedFamily(graphql, input.sourceId ? [input.sourceId] : workspace.suggestedProductIds, input.relationship ?? workspace.draft.relationship)
        }
        if (suffix === '/schema') {
          if (query.refreshConstraints === '1') invalidateShopifyMappingSchema(destination.accountId)
          return await readShopifyMappingSchema(destination.accountId, true)
        }
        if (suffix === '/owner') return await readLinkedOwner(graphql, query.ownerId ?? '')
        if (suffix === '/references') return await searchLinkedReferences(graphql, { type: query.type ?? '', query: query.query, cursor: query.cursor, metaobjectType: query.metaobjectType })
        if (suffix === '/reference-names') return await resolveLinkedReferences(graphql, z.object({ ids: z.array(z.string()).max(100) }).parse(request.body).ids)
        if (suffix === '/products') return await readLinkedProducts(graphql, z.object({ ids: z.array(shopifyProductGid).max(2048) }).parse(request.body).ids)
        if (suffix === '/field-values') return await readLinkedFields(graphql, z.object({ addresses: z.array(z.object({ ownerId: shopifyProductGid, namespace: z.string().min(1), key: z.string().min(1) })).max(2048) }).parse(request.body).addresses)
        if (suffix === '/read-links') {
          const input = z.object({ ids: z.array(shopifyProductGid).max(4096), namespace: z.string().min(1), key: z.string().min(1) }).parse(request.body)
          return (await readLinkedFields(graphql, input.ids.map(ownerId => ({ ownerId, namespace: input.namespace, key: input.key })))).map(f => ({ ...f, type: f.type || 'list.product_reference' }))
        }
        if (suffix === '/import') {
          const input = z.object({ sourceId: shopifyProductGid, relationship: z.object({ namespace: z.string().min(1), key: z.string().min(1), includeSelf: z.boolean() }).nullable() }).strict().parse(request.body)
          return shopifyLinkedDraftSchema.parse(await importLinkedFamily(graphql, input.sourceId, input.relationship))
        }
        if (suffix === '/entry') return method === 'GET' ? await getLinkedEntry(graphql, query.id ?? '') : await saveLinkedEntry(graphql, request.body)
      } catch (error) {
        if (error instanceof z.ZodError) return reply.code(400).send({ error: error.issues.map(i => i.message).join(' ') })
        if (error instanceof WorkspaceScopeError) return reply.code(error.statusCode).send({ error: error.message })
        request.log.error({ err: error }, 'Shopify linked-product operation failed')
        return reply.code(502).send({ error: error instanceof Error ? error.message : 'Shopify could not be reached. Saved drafts and synchronization progress are preserved.' })
      }
    },
  })
}
