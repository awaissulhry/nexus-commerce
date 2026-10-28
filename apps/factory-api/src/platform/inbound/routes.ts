import { z } from 'zod'
import { defineContract, id, input, output } from '@nexus/factory-domain/core/contracts'
import { defineRoutes } from '../../core/manifest'
import { BODY_LIMIT_BYTES } from '../../core/security'
import { manifest } from './manifest'
import { inboundRuntime } from './providers'
import { PROVIDER_SLUGS, receiveInbound, type ProviderSlug } from './receive'

/**
 * The inbound ledger (platform part, feature PLT-194): `POST /inbound/<provider>/<tenantId>/<accountId>`, the URL each
 * account's webhook is registered with at the provider. The body is read as raw bytes (every content type, at most
 * 1 MiB), because the signature is over the exact bytes; receive.ts verifies, stores the receipt and answers at once.
 */

export const inboundContract = defineContract({
  params: input({
    provider: z.enum(Object.keys(PROVIDER_SLUGS) as [ProviderSlug, ...ProviderSlug[]]),
    tenantId: id(),
    accountId: id(),
  }),
  response: { 200: output({ status: z.enum(['received', 'duplicate']), receiptId: id() }) },
})

const headerValue = (value: string | string[] | undefined): string | undefined => (Array.isArray(value) ? value.join(',') : value)

export default defineRoutes('inbound', manifest, async (app) => {
  // Raw bytes for every content type, in this plugin only (the rest of the API keeps its JSON parser).
  app.removeAllContentTypeParsers()
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: BODY_LIMIT_BYTES }, (_request, body, done) => done(null, body))

  app.post('/inbound/:provider/:tenantId/:accountId', { schema: inboundContract }, async (request) => {
    const headers = Object.fromEntries(Object.entries(request.headers).map(([name, value]) => [name.toLowerCase(), headerValue(value)]))
    return receiveInbound(
      request,
      {
        provider: PROVIDER_SLUGS[request.params.provider],
        tenantId: request.params.tenantId.toLowerCase(),
        accountId: request.params.accountId.toLowerCase(),
        rawBody: Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0),
        contentType: headerValue(request.headers['content-type']) ?? null,
        headers,
      },
      inboundRuntime(),
    )
  })
})
