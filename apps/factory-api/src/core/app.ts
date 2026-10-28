import Fastify, { type FastifyInstance, type FastifyServerOptions } from 'fastify'

/**
 * The factory API application. Skeleton: one route, `/health` (the process is up). Readiness (database, Redis), the
 * request context, contracts and the route manifest come with the API core step.
 */
export function buildApp(options: Pick<FastifyServerOptions, 'logger'> = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false })
  app.get('/health', async () => ({ status: 'ok' }))
  return app
}
