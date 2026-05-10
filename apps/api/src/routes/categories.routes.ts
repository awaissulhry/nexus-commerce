import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import {
  CategorySchemaService,
  type SupportedChannel,
} from '../services/categories/schema-sync.service.js'
import { ProductTypesService } from '../services/listing-wizard/product-types.service.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'

const amazon = new AmazonService()
const service = new CategorySchemaService(prisma as any, amazon)
// ProductTypesService uses searchDefinitionsProductTypes which is an allowed SP-API operation.
// We instantiate it here to reuse the 24h in-memory cache across requests.
const productTypesService = new ProductTypesService(prisma as any, amazon, service)

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
  // Category search matching Amazon Seller Central's "Choose product type" UI.
  //
  // searchCatalogItems with `keywords` is a RESTRICTED operation (returns
  // "Access denied"). The working approach:
  //
  //   Step 1 — searchDefinitionsProductTypes(keyword) — allowed, powers the
  //            product type picker. Returns matching product type codes.
  //
  //   Step 2 — For each product type (up to 6), find a real ASIN from the DB
  //            (ChannelListing or ListingReconciliation) for a product of that
  //            type, then call searchCatalogItems(ASIN, identifiersType=ASIN,
  //            classifications) — also allowed, used by competitor detection.
  //
  //   Fallback — if no DB ASIN exists for a type, use any ASIN from the
  //              marketplace to get at least one category tree path.
  //
  // Result: each suggestion has { productType, pathParts[], browseNodes[] }.
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

    const keyword = q.keyword.trim()
    const marketplace = (q.marketplace ?? 'IT').toUpperCase()
    const mpId = amazonMarketplaceId(marketplace)

    try {
      // ── Step 1: find matching product types ──────────────────────────
      // Uses searchDefinitionsProductTypes (allowed) or bundled fallback.
      const matchingTypes = await productTypesService.listProductTypes({
        channel: 'AMAZON',
        marketplace,
        search: keyword,
      })

      if (matchingTypes.length === 0) {
        return reply.send({ suggestions: [], keyword })
      }

      const typesToCheck = matchingTypes.slice(0, 6)

      // ── Step 2: for each type, find an ASIN and classify it ──────────
      // We look for a real ASIN from our catalog for products of that type,
      // then call detectProductTypeFromAsin (ASIN identifier lookup, allowed).

      // Preload any ASIN from this marketplace as a last-resort fallback
      const fallbackAsin = (await prisma.channelListing.findFirst({
        where: { channel: 'AMAZON', marketplace, externalListingId: { not: null } },
        select: { externalListingId: true },
      }))?.externalListingId ?? (await prisma.listingReconciliation.findFirst({
        where: { channel: 'AMAZON', marketplace, externalListingId: { not: null } },
        select: { externalListingId: true },
      }))?.externalListingId ?? null

      const suggestions: Array<{
        productType: string
        displayName: string
        pathParts: string[]
        browseNodes: number[]
        count: number
      }> = []

      await Promise.all(typesToCheck.map(async (pt) => {
        try {
          // Find an ASIN whose product has this product type
          const listing = await prisma.channelListing.findFirst({
            where: {
              channel: 'AMAZON',
              marketplace,
              externalListingId: { not: null },
              product: { productType: pt.productType },
            },
            select: { externalListingId: true },
          })

          const asin = listing?.externalListingId ?? fallbackAsin
          if (!asin || !amazon.isConfigured()) return

          const result = await amazon.detectProductTypeFromAsin(asin, mpId)
          if (!result.categoryPath && (!result.browseNodes || result.browseNodes.length === 0)) return

          const pathParts = result.categoryPath
            ? result.categoryPath.split(' › ').map((s) => s.trim()).filter(Boolean)
            : []

          suggestions.push({
            productType: pt.productType,
            displayName: pt.displayName,
            pathParts,
            browseNodes: result.browseNodes ?? [],
            count: listing ? 2 : 1, // prefer types we have in the DB
          })
        } catch {
          // skip this type if classification fails
        }
      }))

      // Sort: DB-matched types first, then alphabetically
      suggestions.sort((a, b) => b.count - a.count || a.productType.localeCompare(b.productType))

      return reply.send({ suggestions: suggestions.slice(0, 12), keyword })
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
