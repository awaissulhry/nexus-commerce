import { invalidateShopifyMappingSchema } from '../pim/channel-specs/shopify.js'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { shopifyAdmin } from './admin-client.js'
import { collectShopifyPages } from './linked-products-gateway.js'
import { resolveConnection } from '../connection-resolver.service.js'
import { getChannelApp } from '../cx/apps.service.js'
import { shopifyShopDomain } from '../cx/connectors/shopify/auth.js'
import { publishListingEvent } from '../listing-events.service.js'
import { withWorkspace, workspaceIdForQuery } from '../../lib/workspace-context.js'
import { WebhookValidator, type RawBodyRequest } from '../../utils/webhook.js'

const topics = ['METAFIELD_DEFINITIONS_CREATE', 'METAFIELD_DEFINITIONS_UPDATE', 'METAFIELD_DEFINITIONS_DELETE'] as const
const route = '/webhooks/shopify/attributes/:workspaceId/:accountId'

/** Register only this account's schema notifications; never modify another subscription. */
export async function ensureShopifySchemaSubscriptions(accountId: string): Promise<{ live: boolean; reason?: string }> {
  const configured = process.env.NEXUS_PUBLIC_API_URL ?? process.env.PUBLIC_API_URL ?? process.env.RAILWAY_PUBLIC_DOMAIN
  if (!configured) return { live: false, reason: 'A public API address is required for Shopify live notifications.' }
  const base = new URL(configured.startsWith('http') ? configured : `https://${configured}`)
  if (base.protocol !== 'https:' || base.username || base.password) return { live: false, reason: 'Shopify live notifications require a public HTTPS API address.' }
  const callback = `${base.origin}/webhooks/shopify/attributes/${encodeURIComponent(workspaceIdForQuery())}/${encodeURIComponent(accountId)}`
  const { graphql } = await shopifyAdmin(accountId)
  const subscriptions = await collectShopifyPages<{ topic: string; endpoint: { callbackUrl?: string } }>(async after =>
    (await graphql(`query NexusSchemaSubscriptions($after:String) { webhookSubscriptions(first:100,after:$after) { nodes { topic endpoint { ... on WebhookHttpEndpoint { callbackUrl } } } pageInfo { hasNextPage endCursor } } }`, { after })).webhookSubscriptions)
  for (const topic of topics) {
    if (subscriptions.some(s => s.topic === topic && s.endpoint.callbackUrl === callback)) continue
    const { webhookSubscriptionCreate: result } = await graphql(`mutation NexusSchemaSubscription($topic:WebhookSubscriptionTopic!,$subscription:WebhookSubscriptionInput!) { webhookSubscriptionCreate(topic:$topic,webhookSubscription:$subscription) { webhookSubscription { id } userErrors { message } } }`, { topic, subscription: { callbackUrl: callback, format: 'JSON' } })
    if (!result?.webhookSubscription?.id || result.userErrors?.length) throw new Error(result?.userErrors?.map((e: { message: string }) => e.message).join('; ') || 'Shopify did not confirm live attribute notifications.')
  }
  return { live: true }
}

/** The enclosing Shopify route plugin supplies the raw-body JSON parser. */
export function registerShopifySchemaWebhook(app: FastifyInstance): void {
  app.post<{ Params: { workspaceId: string; accountId: string } }>(route, async (request, reply) => {
    const params = z.object({ workspaceId: z.string().regex(/^[a-zA-Z0-9_-]{8,100}$/), accountId: z.string().min(1).max(200) }).safeParse(request.params)
    const topic = request.headers['x-shopify-topic']
    if (!params.success || typeof topic !== 'string' || !['metafield_definitions/create', 'metafield_definitions/update', 'metafield_definitions/delete'].includes(topic)) return reply.code(400).send({ error: 'Invalid Shopify attribute notification.' })
    try {
      // Verify the raw payload before using the caller-supplied business/account address.
      const appCredentials = await getChannelApp('SHOPIFY')
      const signature = request.headers['x-shopify-hmac-sha256']
      if (typeof signature !== 'string' || !WebhookValidator.validateShopifySignature((request as RawBodyRequest).rawBody, signature, appCredentials.clientSecret).isValid) return reply.code(401).send({ error: 'Invalid Shopify signature.' })
      return await withWorkspace({ workspaceId: params.data.workspaceId, actorUserId: null, membershipId: null, roleKeys: [] }, async () => {
        const connection = await resolveConnection({ accountId: params.data.accountId })
        const domain = request.headers['x-shopify-shop-domain']
        if (connection.channelType !== 'SHOPIFY' || !connection.isActive || typeof domain !== 'string' || !shopifyShopDomain(connection.region) || shopifyShopDomain(domain) !== shopifyShopDomain(connection.region)) return reply.code(403).send({ error: 'The notification does not match this connected Shopify store.' })
        // This is an idempotent refresh hint. The UI re-reads the complete store schema;
        // duplicate or out-of-order deliveries never apply a stale field delta.
        invalidateShopifyMappingSchema(connection.id)
        publishListingEvent({ type: 'shopify.schema.changed', accountId: connection.id, ts: Date.now() })
        return reply.send({ success: true })
      })
    } catch (error) {
      request.log.error({ err: error }, 'Shopify attribute notification failed')
      return reply.code(503).send({ error: 'Attribute notification could not be processed. Shopify can retry.' })
    }
  })
}
