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

  // GET /api/categories/browse-path?channel=AMAZON&marketplace=IT&productType=OUTERWEAR
  //
  // Returns the Amazon category breadcrumb (categoryPath) and browse node IDs
  // for a given (channel, marketplace, productType) combination.
  //
  // Strategy (in order):
  //   1. Return a cached path if one was stored on an existing ChannelListing
  //      that belongs to this (channel, marketplace) — fast, no SP-API call.
  //   2. Find any ASIN already stored in a ChannelListing or ListingReconciliation
  //      for this (channel, marketplace) and run searchCatalogItems on it to
  //      get classifications → category path. Cache the result back on the row.
  //   3. If no ASIN is available return null (the UI will ask the user to detect).
  //
  // Response: { categoryPath: string | null, browseNodes: number[] | null }
  fastify.get('/categories/browse-path', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      productType?: string
    }
    if (!q.channel || !q.marketplace || !q.productType) {
      return reply.code(400).send({ error: 'channel, marketplace and productType are required' })
    }

    const channel = q.channel.toUpperCase()
    const marketplace = q.marketplace.toUpperCase()
    const productType = q.productType.toUpperCase()

    if (channel !== 'AMAZON') {
      return reply.send({ categoryPath: null, browseNodes: null })
    }

    // 1 — Check ChannelListing for a cached detectedCategoryPath
    const listingWithPath = await prisma.channelListing.findFirst({
      where: {
        channel,
        marketplace,
        platformAttributes: { path: ['detectedCategoryPath'], not: null },
      },
      select: { platformAttributes: true },
    }).catch(() => null)

    if (listingWithPath?.platformAttributes) {
      const pa = listingWithPath.platformAttributes as Record<string, any>
      if (pa.detectedCategoryPath) {
        const nodes =
          Array.isArray((pa.attributes as any)?.recommended_browse_nodes)
            ? (pa.attributes as any).recommended_browse_nodes as number[]
            : null
        return reply.send({ categoryPath: pa.detectedCategoryPath, browseNodes: nodes })
      }
    }

    // 2 — Find any ASIN for this (channel, marketplace) to look up classifications
    if (!amazon.isConfigured()) {
      return reply.send({ categoryPath: null, browseNodes: null })
    }

    // First try ChannelListings with a stored externalListingId (ASIN)
    const listingWithAsin = await prisma.channelListing.findFirst({
      where: { channel, marketplace, externalListingId: { not: null } },
      select: { externalListingId: true },
    }).catch(() => null)

    const asin = listingWithAsin?.externalListingId ??
      // Fall back to reconciliation rows
      (await prisma.listingReconciliation.findFirst({
        where: { channel, marketplace, externalListingId: { not: null } },
        select: { externalListingId: true },
      }).catch(() => null))?.externalListingId

    if (!asin) {
      return reply.send({ categoryPath: null, browseNodes: null })
    }

    try {
      const { amazonMarketplaceId } = await import('../services/categories/marketplace-ids.js')
      const mpId = amazonMarketplaceId(marketplace)
      const result = await amazon.detectProductTypeFromAsin(asin, mpId)
      return reply.send({
        categoryPath: result.categoryPath,
        browseNodes: result.browseNodes,
      })
    } catch (err: any) {
      fastify.log.warn({ err }, '[categories/browse-path] detection failed')
      return reply.send({ categoryPath: null, browseNodes: null })
    }
  })

  // GET /api/categories/suggestions?channel=AMAZON&marketplace=IT&keyword=moto+jacket
  //
  // Mirrors Amazon Seller Central's "Choose product type" search: returns a
  // deduplicated list of { productType, pathParts[], browseNodes[] } sorted by
  // relevance (number of times that path appeared in catalog results).
  //
  // Implementation: searchCatalogItems with the keyword, pull classifications
  // from each result, deduplicate by the leaf classificationId, and return up
  // to 20 unique paths. Client renders them as selectable category cards.
  fastify.get('/categories/suggestions', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      keyword?: string
    }
    if (!q.keyword?.trim()) {
      return reply.code(400).send({ error: 'keyword is required' })
    }
    if ((q.channel ?? 'AMAZON').toUpperCase() !== 'AMAZON') {
      return reply.send({ suggestions: [] })
    }
    if (!amazon.isConfigured()) {
      return reply.code(503).send({ error: 'Amazon SP-API not configured' })
    }

    try {
      const { amazonMarketplaceId } = await import('../services/categories/marketplace-ids.js')
      const mpId = amazonMarketplaceId(q.marketplace ?? 'IT')
      const sp = await (amazon as any).getClient()

      const res: any = await (sp as any).callAPI({
        operation: 'searchCatalogItems',
        endpoint: 'catalogItems',
        version: '2022-04-01',
        query: {
          keywords: q.keyword.trim(),
          marketplaceIds: [mpId],
          includedData: ['summaries', 'classifications'],
          pageSize: 20,
        },
      })

      const items: any[] = res?.items ?? []

      // Build a deduplicated map of leaf classificationId → suggestion
      const byLeafId = new Map<string, {
        productType: string
        pathParts: string[]
        browseNodes: number[]
        count: number
      }>()

      for (const item of items) {
        const summaries: any[] = item.summaries ?? []
        const classifications: any[] = item.classifications ?? []
        if (!classifications.length) continue

        // Product type from summaries
        const rawPt = summaries[0]?.productTypes?.[0]?.productTypeId
          ?? summaries[0]?.productTypes?.[0]?.productType
          ?? null
        const productType = typeof rawPt === 'string' ? rawPt : 'UNKNOWN'

        // Build path from classifications (walk parent chain per classification)
        for (const cls of classifications) {
          const { pathParts, browseNodes } = buildPath(cls)
          if (!pathParts.length) continue

          const leafId = browseNodes[browseNodes.length - 1]?.toString()
            ?? pathParts.join('|')

          const existing = byLeafId.get(leafId)
          if (existing) {
            existing.count++
          } else {
            byLeafId.set(leafId, { productType, pathParts, browseNodes, count: 1 })
          }
        }
      }

      // Sort by frequency (most common paths first), cap at 20
      const suggestions = Array.from(byLeafId.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 20)

      return reply.send({ suggestions, keyword: q.keyword.trim() })
    } catch (err: any) {
      fastify.log.error({ err }, '[categories/suggestions] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
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

/** Walk a classification node and its parent chain to produce an
 *  ordered path (root → leaf) and a list of browse node IDs. */
function buildPath(node: any): { pathParts: string[]; browseNodes: number[] } {
  const parts: string[] = []
  const nodes: number[] = []

  function walk(n: any, depth = 0) {
    if (!n || depth > 15) return
    if (n.parent) walk(n.parent, depth + 1) // walk to root first
    if (typeof n.displayName === 'string' && n.displayName) parts.push(n.displayName)
    const id = n.classificationId ?? n.id
    if (id != null) {
      const num = typeof id === 'number' ? id : parseInt(String(id), 10)
      if (!isNaN(num)) nodes.push(num)
    }
  }

  walk(node)
  return { pathParts: parts, browseNodes: nodes }
}
