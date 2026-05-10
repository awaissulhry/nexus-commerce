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
  // Two-step search mirroring Amazon Seller Central's "Choose product type":
  //
  //   Step 1 — searchCatalogItems(keyword) → get up to 10 ASINs + product types.
  //            classifications are NOT reliably returned for keyword searches
  //            across all marketplaces, so we don't rely on them here.
  //
  //   Step 2 — For each unique ASIN (up to 8), call searchCatalogItems(ASIN,
  //            identifiersType=ASIN, includedData=[classifications]) in parallel.
  //            This is the same path that "Detect from competitor" uses and is
  //            known to return full classification trees reliably.
  //
  //   Step 3 — Deduplicate by leaf browse node, sort by frequency, return ≤20.
  fastify.get('/categories/suggestions', async (request, reply) => {
    const q = request.query as {
      channel?: string
      marketplace?: string
      keyword?: string
      debug?: string
    }
    const debugMode = q.debug === '1'
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

      // ── Step 1: keyword search ────────────────────────────────────────
      const searchRes: any = await (sp as any).callAPI({
        operation: 'searchCatalogItems',
        endpoint: 'catalogItems',
        version: '2022-04-01',
        query: {
          keywords: q.keyword.trim(),
          marketplaceIds: [mpId],
          includedData: ['summaries', 'productTypes'],
          pageSize: 10,
        },
      })

      const rawItems: any[] = searchRes?.items ?? []

      if (debugMode) {
        return reply.send({
          debug: true,
          step1_keys: Object.keys(searchRes ?? {}),
          step1_itemCount: rawItems.length,
          step1_firstItem: rawItems[0] ? {
            asin: rawItems[0].asin,
            hasClassifications: !!rawItems[0].classifications,
            classificationCount: rawItems[0].classifications?.length ?? 0,
            summaryKeys: Object.keys(rawItems[0].summaries?.[0] ?? {}),
            productTypes: rawItems[0].summaries?.[0]?.productTypes,
          } : null,
        })
      }

      if (rawItems.length === 0) {
        return reply.send({ suggestions: [], keyword: q.keyword.trim() })
      }

      // Collect unique ASINs and their product types from the search results
      const asinMeta = new Map<string, string>() // asin → productType
      for (const item of rawItems) {
        const asin: string = item.asin
        if (!asin || asinMeta.has(asin)) continue
        const rawPt =
          item.summaries?.[0]?.productTypes?.[0]?.productTypeId ??
          item.summaries?.[0]?.productTypes?.[0]?.productType ??
          item.productTypes?.[0]?.productTypeId ??
          null
        asinMeta.set(asin, typeof rawPt === 'string' ? rawPt : 'UNKNOWN')
      }

      const asins = Array.from(asinMeta.keys()).slice(0, 8)

      // ── Step 2: batch classify each ASIN ─────────────────────────────
      const classified = await Promise.all(
        asins.map(async (asin) => {
          try {
            const r: any = await (sp as any).callAPI({
              operation: 'searchCatalogItems',
              endpoint: 'catalogItems',
              version: '2022-04-01',
              query: {
                marketplaceIds: [mpId],
                identifiers: [asin],
                identifiersType: 'ASIN',
                includedData: ['classifications', 'summaries'],
              },
            })
            const item = Array.isArray(r?.items) && r.items.length > 0 ? r.items[0] : null
            if (!item) return null

            // Prefer productType from this full response, fall back to step-1 value
            const rawPt =
              item.summaries?.[0]?.productTypes?.[0]?.productTypeId ??
              item.summaries?.[0]?.productTypes?.[0]?.productType ??
              asinMeta.get(asin) ?? 'UNKNOWN'

            return {
              asin,
              productType: rawPt,
              classifications: item.classifications ?? [],
            }
          } catch {
            return null
          }
        }),
      )

      // ── Step 3: deduplicate by leaf browse node ───────────────────────
      const byLeafId = new Map<string, {
        productType: string
        pathParts: string[]
        browseNodes: number[]
        count: number
      }>()

      for (const result of classified) {
        if (!result) continue
        const classifications: any[] = result.classifications
        if (!classifications.length) continue

        for (const cls of classifications) {
          const { pathParts, browseNodes } = buildPath(cls)
          if (!pathParts.length) continue

          const leafId = browseNodes[browseNodes.length - 1]?.toString() ?? pathParts.join('|')
          const existing = byLeafId.get(leafId)
          if (existing) {
            existing.count++
          } else {
            byLeafId.set(leafId, {
              productType: result.productType,
              pathParts,
              browseNodes,
              count: 1,
            })
          }
        }
      }

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
