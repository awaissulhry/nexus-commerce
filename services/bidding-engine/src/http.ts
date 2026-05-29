/**
 * Thin Fastify control surface: health/readiness, on-demand optimize trigger,
 * and a metrics snapshot. The cron that fires `optimizeFromPrimary` on a
 * schedule can call POST /optimize, or run the producer in-process (index.ts).
 */
import Fastify from 'fastify'
import { config } from './config.js'
import { bidQueue, connection } from './queue.js'
import { optimizeFromPrimary, optimizeContexts } from './producer.js'
import { metrics } from './worker.js'
import type { BidContext } from './types.js'

export function buildHttp() {
  const app = Fastify({ logger: { level: config.logLevel } })

  app.get('/health', async () => ({ ok: true, dryRun: config.worker.dryRun }))

  app.get('/ready', async (_req, reply) => {
    const ping = await connection.ping().catch(() => null)
    if (ping !== 'PONG') return reply.code(503).send({ ready: false, redis: false })
    return { ready: true, redis: true }
  })

  app.get('/metrics', async () => {
    const counts = await bidQueue.getJobCounts('waiting', 'active', 'delayed', 'failed', 'completed')
    return { worker: metrics, queue: counts }
  })

  // Pull contexts from the primary app and enqueue (gated by the shared token).
  app.post('/optimize', async (req, reply) => {
    if (req.headers['x-internal-token'] !== config.primary.token) return reply.code(401).send({ error: 'unauthorized' })
    const body = (req.body ?? {}) as { marketplace?: string; limit?: number; contexts?: BidContext[] }
    const result = body.contexts?.length ? await optimizeContexts(body.contexts) : await optimizeFromPrimary(body)
    return result
  })

  return app
}
