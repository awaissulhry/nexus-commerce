import type { FastifyPluginAsync } from 'fastify'

// Placeholder routes — real data wired in Phase 5.
const marketingRoutes: FastifyPluginAsync = async (fastify) => {
  fastify.get('/marketing/promotions', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/marketing/advertising', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/marketing/content', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })

  fastify.get('/marketing/reviews', async (_request, reply) => {
    reply.header('Cache-Control', 'private, max-age=300')
    return { items: [], count: 0 }
  })
}

export default marketingRoutes
