import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import {
  CategorySchemaService,
  type SupportedChannel,
} from '../services/categories/schema-sync.service.js'

const amazon = new AmazonService()
const service = new CategorySchemaService(prisma as any, amazon)

const categoriesRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/categories/schema?channel=AMAZON&marketplace=IT&productType=OUTERWEAR&force=1
  //
  // Returns the cached or freshly-fetched CategorySchema row. `force=1`
  // bypasses the 24h cache.
  fastify.get('/categories/schema', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      productType?: string
      force?: string
      lite?: string
    }
    if (!q.channel || !q.productType) {
      return reply
        .code(400)
        .send({ error: 'channel and productType are required' })
    }
    const channel = q.channel.toUpperCase() as SupportedChannel
    if (channel !== 'AMAZON' && channel !== 'EBAY') {
      return reply
        .code(400)
        .send({ error: `unsupported channel: ${q.channel}` })
    }
    try {
      const schema = await service.getSchema(
        {
          channel,
          marketplace: q.marketplace ?? null,
          productType: q.productType,
        },
        { force: q.force === '1' || q.force === 'true' },
      )
      const isLite = q.lite === '1' || q.lite === 'true'
      return {
        channel: schema.channel,
        marketplace: schema.marketplace,
        productType: schema.productType,
        schemaVersion: schema.schemaVersion,
        fetchedAt: schema.fetchedAt,
        expiresAt: schema.expiresAt,
        variationThemes: schema.variationThemes,
        // The full schema can be 50–500KB; clients that just need
        // version + variation themes can pass ?lite=1.
        ...(isLite ? {} : { schemaDefinition: schema.schemaDefinition }),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[categories/schema] failed')
      const msg = err?.message ?? String(err)
      const isAuth = /SP-API not configured|credentials|auth/i.test(msg)
      return reply
        .code(isAuth ? 503 : 500)
        .send({ error: msg })
    }
  })

  // GET /api/categories/changes?channel=AMAZON&marketplace=IT&productType=OUTERWEAR&since=ISO
  //
  // Surfaces the SchemaChange log for a given (channel, marketplace,
  // productType). If `since` is omitted, returns the last 30 days.
  fastify.get('/categories/changes', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      productType?: string
      since?: string
      limit?: string
    }
    const since = q.since
      ? new Date(q.since)
      : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
    if (Number.isNaN(since.getTime())) {
      return reply.code(400).send({ error: 'invalid since timestamp' })
    }
    const limit = Math.min(parseInt(q.limit ?? '200', 10) || 200, 1000)

    const where: any = { detectedAt: { gte: since } }
    if (q.channel) where.channel = q.channel.toUpperCase()
    if (q.marketplace) where.marketplace = q.marketplace
    if (q.productType) where.productType = q.productType

    const changes = await prisma.schemaChange.findMany({
      where,
      orderBy: { detectedAt: 'desc' },
      take: limit,
    })
    return { changes, count: changes.length, since }
  })
}

export default categoriesRoutes
