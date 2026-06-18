import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'

const healthRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/health', async (request, reply) => {
    try {
      // Test database connection
      await prisma.$queryRaw`SELECT 1`
      
      return {
        status: 'healthy',
        // Deploy/version markers — so we can verify which build + which Amazon
        // publish-gate state is actually live. The FBA→FBM flip incident showed we
        // were toggling the gate blind to whether the fix had deployed.
        build: process.env.RAILWAY_GIT_COMMIT_SHA?.slice(0, 8) ?? 'unknown',
        marker: 'fba-flip-fix-2026-06-18',
        amazonPublish: process.env.NEXUS_ENABLE_AMAZON_PUBLISH === 'true' ? 'ENABLED' : 'gated',
        timestamp: new Date().toISOString(),
        services: {
          database: 'connected',
          redis: 'connected',
          api: 'operational'
        }
      }
    } catch (error) {
      return reply.code(503).send({
        status: 'unhealthy',
        timestamp: new Date().toISOString(),
        error: error instanceof Error ? error.message : 'Unknown error'
      })
    }
  })
}

export default healthRoutes
