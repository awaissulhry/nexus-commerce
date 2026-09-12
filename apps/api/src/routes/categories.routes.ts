import type { FastifyPluginAsync } from 'fastify'
import { Prisma } from '@prisma/client'
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
  fastify.get<{ Querystring: { search?: string; ids?: string; accountId?: string; refresh?: string } }>('/categories/etsy-taxonomy', async (request, reply) => {
    const { search = '', ids, accountId, refresh } = request.query
    const selected = ids ? ids.split(',') : []
    if (selected.length > 200 || selected.some(id => !/^[1-9]\d*$/.test(id)) || search.length > 200) return reply.code(400).send({ error: 'Provide valid seller category IDs or a shorter search.' })
    if (!selected.length && search.trim().length < 2) return { items: [] }
    try {
      const { getEtsyTaxonomy } = await import('../services/etsy/taxonomy.js')
      const taxonomy = await getEtsyTaxonomy(accountId, refresh === '1')
      const terms = search.trim().toLowerCase().split(/\s+/)
      const items = taxonomy.filter(item => selected.length ? selected.includes(item.productType)
        : terms.every(term => `${item.displayName} ${item.productType}`.toLowerCase().includes(term)))
      return { items: selected.length ? items : items.slice(0, 100), total: items.length }
    } catch (error) {
      request.log.warn({ err: error }, 'Etsy category search unavailable')
      return reply.code(503).send({ error: 'Etsy categories are unavailable. Check the connection and try again.' })
    }
  })

  // Independent from the sheet read so a seller-name lookup cannot delay editing.
  fastify.get<{ Querystring: { channel?: string; marketplace?: string; productType?: string; accountId?: string; shipping?: string; browseNodeIds?: string } }>('/categories/reference-labels', async (request, reply) => {
    const { marketplace, productType, accountId, shipping } = request.query
    const channel = (request.query.channel ?? 'AMAZON').toUpperCase()
    const browseNodeIds = [...new Set((request.query.browseNodeIds ?? '').split(',').filter(Boolean))]
    if (browseNodeIds.length > 200 || browseNodeIds.some(id => !/^\d{1,30}$/.test(id))) return reply.code(400).send({ error: 'Provide up to 200 numeric browse-node IDs' })
    if (channel !== 'AMAZON' && channel !== 'EBAY') return reply.code(400).send({ error: 'Unsupported channel' })
    if (!marketplace || !productType || !/^[A-Z0-9_]{1,100}$/i.test(productType)) {
      return reply.code(400).send({ error: 'marketplace and productType are required' })
    }
    const market = await prisma.marketplace.findFirst({ where: { channel, code: marketplace.toUpperCase() }, select: { code: true } })
    if (!market) return reply.code(400).send({ error: 'Unknown marketplace' })
    try {
      const { amazonReferenceLabels, cachedCategoryLabels } = await import('../services/categories/reference-labels.service.js')
      const labels = await cachedCategoryLabels(channel, market.code, productType.toUpperCase())
      if (channel === 'EBAY') return { labels }
      const result = await amazonReferenceLabels({ marketplace: market.code, productType: productType.toUpperCase(), accountId, shipping: shipping === '1', browseNodeIds })
      return { ...result, labels: { ...labels, ...result.labels } }
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode
      return reply.code(status && status >= 400 && status < 500 ? status : 503).send({ error: 'Reference names are unavailable' })
    }
  })

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
      accountId?: string
    }
    if (!q.channel || !q.productType) {
      return reply
        .code(400)
        .send({ error: 'channel and productType are required' })
    }
    const channel = q.channel.toUpperCase() as SupportedChannel
    if (channel !== 'AMAZON' && channel !== 'EBAY' && channel !== 'ETSY') {
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
          accountId: q.accountId,
        },
        { force: q.force === '1' || q.force === 'true' },
      )
      const isLite = q.lite === '1' || q.lite === 'true'
      if (q.force === '1' || q.force === 'true') {
        const { clearSheetColumnCache } = await import('../services/pim/sheet-columns.service.js')
        const { clearStudioColumnCache } = await import('../services/pim/studio-columns.js')
        clearSheetColumnCache(); clearStudioColumnCache()
      }
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
  //   1. Return a cached path from the exact marketplace and product type.
  //   2. Classify an ASIN from that same scope and confirm its live product type.
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
    const listingScope = amazonCategoryListings(marketplace, productType)

    // 1 — Check ChannelListing for a cached detectedCategoryPath
    const listingWithPath = await prisma.channelListing.findFirst({
      where: {
        ...listingScope,
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

    // 2 — Only a typed listing can provide an ASIN for this category.
    if (!(await amazon.isConfigured())) {
      return reply.send({ categoryPath: null, browseNodes: null })
    }

    // First try ChannelListings with a stored externalListingId (ASIN)
    const listingWithAsin = await prisma.channelListing.findFirst({
      where: { ...listingScope, externalListingId: { not: null } },
      select: { externalListingId: true },
    }).catch(() => null)

    const asin = listingWithAsin?.externalListingId

    if (!asin) {
      return reply.send({ categoryPath: null, browseNodes: null })
    }

    try {
      const { amazonMarketplaceId } = await import('../services/categories/marketplace-ids.js')
      const mpId = amazonMarketplaceId(marketplace)
      const result = await amazon.detectProductTypeFromAsin(asin, mpId)
      if (result.productType !== productType) return reply.send({ categoryPath: null, browseNodes: null })
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
  //   Step 2 — For each product type (up to 6), find a real ChannelListing ASIN for a product of that
  //            type, then call searchCatalogItems(ASIN, identifiersType=ASIN,
  //            classifications) — also allowed, used by competitor detection.
  //
  //   Types without a matching ASIN cannot supply a category breadcrumb.
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
              ...amazonCategoryListings(marketplace, pt.productType),
              externalListingId: { not: null },
            },
            select: { externalListingId: true },
          })

          const asin = listing?.externalListingId
          if (!asin || !(await amazon.isConfigured())) return

          const result = await amazon.detectProductTypeFromAsin(asin, mpId)
          if (result.productType !== pt.productType) return
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

/** A listing's channel-specific type wins over Master. Untyped reconciliation
 * rows cannot establish which category a stored ASIN belongs to. */
function amazonCategoryListings(marketplace: string, productType: string): Prisma.ChannelListingWhereInput {
  return {
    channel: 'AMAZON', marketplace, product: { deletedAt: null },
    OR: [
      { platformAttributes: { path: ['productType'], equals: productType } },
      { AND: [
        { platformAttributes: { path: ['productType'], equals: Prisma.AnyNull } },
        { product: { productType } },
      ] },
    ],
  }
}

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
