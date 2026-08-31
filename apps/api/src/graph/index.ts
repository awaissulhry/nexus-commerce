// PH.3 — the product graph endpoint.
//
// Registered at /graphql, read-only, behind the same gates as everything else:
//
//  - RBAC. The route is mapped to products.view in permissions-manifest.ts.
//    Without that mapping the rbac hook denies it 403 `route_unmapped` — the
//    platform fails closed on unmapped routes, so this endpoint cannot be
//    reached by forgetting to think about it.
//  - Financial fields. financialFilterHook runs as a global preSerialization
//    hook and was VERIFIED to fire on mercurius replies, stripping restricted
//    fields for unauthorised callers and passing them to authorised ones.
//  - Depth. An unbounded graph is a self-inflicted DoS: a query can nest
//    through the schema and multiply work with a few hundred bytes of input.
//
// Row scoping — which products a caller may see AT ALL — does not exist on
// this platform, in REST or here. The graph does not widen that gap (it reads
// the same tables through the same permission) but it does make it easier to
// traverse, and that is worth saying out loud rather than leaving implied.

import type { FastifyInstance } from 'fastify'
import mercurius from 'mercurius'
import { schema } from './schema.js'
import { resolvers } from './resolvers/index.js'
import { createLoaders } from './loaders.js'
import { logger } from '../utils/logger.js'

/** Nesting cap. The schema's deepest legitimate path is ~4 levels. */
const MAX_QUERY_DEPTH = 8

export function registerProductGraph(app: FastifyInstance): void {
  if (process.env.NEXUS_DISABLE_GRAPHQL === '1') {
    logger.warn('product graph: disabled by NEXUS_DISABLE_GRAPHQL=1')
    return
  }

  // Not awaited: Fastify queues plugin registration and loads it during
  // ready(), so awaiting here would only force a top-level await on the caller
  // for no ordering benefit.
  app.register(mercurius, {
    schema,
    resolvers,
    path: '/graphql',
    // Loaders are built per request — a shared loader would cache one
    // caller's rows and serve them to the next.
    context: () => ({ loaders: createLoaders() }),
    queryDepth: MAX_QUERY_DEPTH,
    // The IDE ships an introspection UI. Fine locally, not something to expose
    // on a production surface by default.
    graphiql: process.env.NODE_ENV !== 'production' && process.env.NEXUS_ENABLE_GRAPHIQL === '1',
    // Subscriptions would need their own auth story on the socket; the graph
    // is request/response only. Live updates already have a transport (SSE).
    subscription: false,
  })

  logger.info('product graph: registered', { path: '/graphql', maxQueryDepth: MAX_QUERY_DEPTH })
}
