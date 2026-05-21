import type { FastifyPluginAsync } from 'fastify'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { amazonOrdersService } from '../services/amazon-orders.service.js'
import { amazonInventoryService } from '../services/amazon-inventory.service.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import prisma from '../db.js'
import {
  detectVariationGroups,
  applyGroupings,
  type ApprovedGroup,
} from '../services/pim/auto-detect.service.js'
import { computeAmazonAccountHealth } from '../services/amazon-account-health.service.js'
import {
  getBuyShippingRates,
  purchaseBuyShippingLabel,
} from '../services/amazon-buy-shipping.service.js'

const amazonService = new AmazonService()

const amazonRoutes: FastifyPluginAsync = async (fastify) => {
  // GET /api/amazon/products - Fetch products from Amazon SP-API and sync to database
  fastify.get('/products', async (request, reply) => {
    try {
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({
          success: false,
          error: 'Amazon SP-API credentials are not configured. Required: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN',
        })
      }

      const catalogItems = await amazonService.fetchActiveCatalog()

      if (!catalogItems || catalogItems.length === 0) {
        return { success: true, synced: 0, message: 'No products found on Amazon' }
      }

      // ── Pass 1: Upsert all products ──────────────────────────
      const syncedProducts = []
      for (const item of catalogItems) {
        const product = await prisma.product.upsert({
          where: { sku: item.sku },
          update: {
            name: item.title || item.sku,
            basePrice: item.price || 0,
            totalStock: item.quantity || 0,
            amazonAsin: item.asin,
            status: 'ACTIVE',
            ...(item.parentAsin ? { parentAsin: item.parentAsin } : {}),
            ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
          },
          create: {
            sku: item.sku,
            name: item.title || item.sku,
            basePrice: item.price || 0,
            totalStock: item.quantity || 0,
            amazonAsin: item.asin,
            status: 'ACTIVE',
            syncChannels: ['AMAZON'],
            minMargin: 0,
            ...(item.parentAsin ? { parentAsin: item.parentAsin } : {}),
            ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
          },
        })
        syncedProducts.push(product)
      }

      // ── Pass 2: Build parent/child hierarchy ─────────────────
      const childItems = catalogItems.filter((i) => i.parentAsin)
      let parentsLinked = 0

      if (childItems.length > 0) {
        // Collect unique parent ASINs
        const parentAsinSet = new Set(childItems.map((i) => i.parentAsin!))
        const parentAsinToDbId = new Map<string, string>()

        for (const parentAsin of parentAsinSet) {
          // Find existing product with this ASIN (may already be in DB)
          const existing = await (prisma as any).product.findFirst({
            where: { amazonAsin: parentAsin },
            select: { id: true },
          })

          if (existing) {
            await prisma.product.update({
              where: { id: existing.id },
              data: { isParent: true },
            })
            parentAsinToDbId.set(parentAsin, existing.id)
          } else {
            // Create a non-buyable parent placeholder
            const childItem = childItems.find((i) => i.parentAsin === parentAsin)
            const parentSku = `PARENT-${parentAsin}`
            // Strip trailing variation suffixes from child title for the parent name
            const parentName = (childItem?.title ?? `Parent ${parentAsin}`)
              .replace(/\s*[-–]\s*(size|color|colour|taglia|colore):?\s*\S+/gi, '')
              .trim()

            const parent = await prisma.product.upsert({
              where: { sku: parentSku },
              update: { isParent: true, amazonAsin: parentAsin },
              create: {
                sku: parentSku,
                name: parentName,
                basePrice: 0,
                totalStock: 0,
                isParent: true,
                amazonAsin: parentAsin,
                status: 'ACTIVE',
                syncChannels: ['AMAZON'],
                minMargin: 0,
              },
            })
            parentAsinToDbId.set(parentAsin, parent.id)
          }
        }

        // Link children to their parents
        for (const item of childItems) {
          const parentDbId = parentAsinToDbId.get(item.parentAsin!)
          if (!parentDbId) continue
          await prisma.product.update({
            where: { sku: item.sku },
            data: {
              parentId: parentDbId,
              ...(item.variationTheme ? { variationTheme: item.variationTheme } : {}),
            },
          })
          parentsLinked++
        }

        // Update each parent's totalStock = sum of its children
        for (const [, parentDbId] of parentAsinToDbId) {
          const children = await prisma.product.findMany({
            where: { parentId: parentDbId },
            select: { totalStock: true },
          })
          const totalStock = children.reduce((sum, c) => sum + c.totalStock, 0)
          await prisma.product.update({
            where: { id: parentDbId },
            data: { totalStock },
          })
        }

        fastify.log.info(
          `[Amazon] Linked ${parentsLinked} child(ren) to ${parentAsinSet.size} parent(s)`
        )
      }

      return {
        success: true,
        synced: syncedProducts.length,
        parentsLinked,
        products: syncedProducts,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Amazon product sync failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // GET /api/amazon/products/debug-hierarchy
  fastify.get('/products/debug-hierarchy', async (_request, reply) => {
    try {
      const [parents, children, standalone] = await Promise.all([
        prisma.product.count({ where: { isParent: true } }),
        prisma.product.count({ where: { parentId: { not: null } } }),
        prisma.product.count({ where: { isParent: false, parentId: null } }),
      ])
      const sampleParent = await (prisma as any).product.findFirst({
        where: { isParent: true },
        include: { children: { take: 3 } },
      })
      return {
        total: parents + children + standalone,
        parents,
        children,
        standalone,
        sampleParent,
      }
    } catch (error) {
      return reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // GET /api/amazon/products/:id/children — DEPRECATED ALIAS.
  // Canonical endpoint is GET /api/products/:id/children (channel-agnostic).
  // Kept for backward compat; remove once external callers are migrated.
  fastify.get<{ Params: { id: string } }>('/products/:id/children', async (request, reply) => {
    try {
      const { id } = request.params
      const children = await prisma.product.findMany({
        where: { parentId: id },
        orderBy: { sku: 'asc' },
      })
      const enriched = children.map((c) => {
        const ca = c.categoryAttributes
        const variations =
          ca && typeof ca === 'object' && !Array.isArray(ca) && (ca as any).variations
            ? ((ca as any).variations as Record<string, string>)
            : null
        return { ...c, variations }
      })
      return { success: true, children: enriched }
    } catch (error) {
      return reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // GET /api/amazon/products/count - Quick count + sample for debugging
  fastify.get('/products/count', async (_request, reply) => {
    try {
      const [count, sample] = await Promise.all([
        prisma.product.count(),
        prisma.product.findFirst({ orderBy: { createdAt: 'desc' } }),
      ])
      return { count, sample }
    } catch (error) {
      return reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // GET /api/amazon/products/list - List Amazon-synced products from the database
  // Query params:
  //   ?limit=50        — max rows to return (default: all)
  //   ?offset=0        — skip N rows
  //   ?topLevelOnly=1  — only products where parentId IS NULL; includes childCount per row
  fastify.get('/products/list', async (request, reply) => {
    try {
      const q = request.query as { limit?: string; offset?: string; topLevelOnly?: string }
      const limit = q.limit ? Math.min(parseInt(q.limit, 10) || 50, 500) : undefined
      const offset = q.offset ? parseInt(q.offset, 10) || 0 : undefined
      const topLevelOnly = q.topLevelOnly === '1' || q.topLevelOnly === 'true'

      const where: any = { syncChannels: { has: 'AMAZON' } }
      if (topLevelOnly) where.parentId = null

      const [products, total] = await Promise.all([
        prisma.product.findMany({
          where,
          orderBy: { createdAt: 'desc' },
          ...(limit !== undefined ? { take: limit } : {}),
          ...(offset !== undefined ? { skip: offset } : {}),
        }),
        prisma.product.count({ where: { syncChannels: { has: 'AMAZON' } } }),
      ])

      let enriched: any[] = products
      if (topLevelOnly) {
        // Compute childCount for each returned parent in one query
        const parentIds = products.map((p) => p.id)
        const childRows = await prisma.product.groupBy({
          by: ['parentId'],
          where: { parentId: { in: parentIds } },
          _count: { id: true },
        })
        const childCountMap = new Map<string, number>()
        for (const row of childRows) {
          if (row.parentId) childCountMap.set(row.parentId, row._count.id)
        }
        enriched = products.map((p) => ({ ...p, childCount: childCountMap.get(p.id) ?? 0 }))
      }

      return {
        success: true,
        count: enriched.length,
        total,
        products: enriched,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to list Amazon products')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // POST /api/amazon/products/cleanup-bad-parents
  // Find phantom parents (placeholder PARENT-* SKU, null amazonAsin, or
  // 0 stock + 0 price), unlink their children, and delete them.
  fastify.post('/products/cleanup-bad-parents', async (_request, reply) => {
    try {
      const phantomParents = await prisma.product.findMany({
        where: {
          isParent: true,
          OR: [
            { sku: { contains: 'PARENT-' } },
            { sku: { contains: '-PARENT' } },
            { amazonAsin: null },
            { AND: [{ totalStock: 0 }, { basePrice: 0 }] },
          ],
        },
        include: { children: { select: { id: true, sku: true } } },
      })

      let childrenUnlinked = 0
      for (const parent of phantomParents) {
        const r = await prisma.product.updateMany({
          where: { parentId: parent.id },
          data: { parentId: null, parentAsin: null, isParent: false },
        })
        childrenUnlinked += r.count
      }

      const deleted = await prisma.product.deleteMany({
        where: { id: { in: phantomParents.map((p) => p.id) } },
      })

      return {
        success: true,
        deletedPhantomParents: deleted.count,
        skus: phantomParents.map((p) => p.sku),
        childrenUnlinked,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[cleanup-bad-parents] failed')
      return reply.code(500).send({ success: false, error: error?.message ?? String(error) })
    }
  })

  // POST /api/amazon/products/clear-hierarchy
  // Emergency reset: unlinks all parent/child relationships and deletes phantom
  // PARENT-* placeholder records created by the old /products route.
  fastify.post('/products/clear-hierarchy', async (request, reply) => {
    try {
      // 1. Unlink all children
      const unlinkResult = await prisma.product.updateMany({
        where: { parentId: { not: null } },
        data: { parentId: null, parentAsin: null },
      })
      // 2. Reset all isParent flags and variationTheme
      const resetParents = await prisma.product.updateMany({
        where: { isParent: true },
        data: { isParent: false, variationTheme: null },
      })
      // 3. Delete phantom PARENT-* placeholder records (created by old /products sync)
      const deletePhantoms = await prisma.product.deleteMany({
        where: { sku: { startsWith: 'PARENT-' } },
      })
      // 4. Strip variations from categoryAttributes on all Amazon products
      const allAmazon = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        select: { id: true, categoryAttributes: true },
      })
      let strippedVariations = 0
      for (const p of allAmazon) {
        const ca = p.categoryAttributes
        if (ca && typeof ca === 'object' && !Array.isArray(ca) && (ca as any).variations) {
          const { variations: _drop, ...rest } = ca as any
          await prisma.product.update({
            where: { id: p.id },
            data: { categoryAttributes: rest },
          })
          strippedVariations++
        }
      }
      return {
        success: true,
        childrenUnlinked: unlinkResult.count,
        parentsReset: resetParents.count,
        phantomsDeleted: deletePhantoms.count,
        variationsStripped: strippedVariations,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[clear-hierarchy] failed')
      return reply.code(500).send({ success: false, error: error?.message ?? String(error) })
    }
  })

  // GET /api/amazon/products/verify-amazon-parents?sku_prefix=xevo
  // Calls getListingsItem for every local product matching sku_prefix and shows
  // exactly what Amazon's Listings API returns for parentage_level and parent_sku.
  // Default prefix is empty (all Amazon products). Pass ?sku_prefix=xevo to narrow.
  fastify.get('/products/verify-amazon-parents', async (request, reply) => {
    try {
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
      }
      const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
      if (!sellerId) {
        return reply.code(503).send({ success: false, error: 'AMAZON_SELLER_ID not set' })
      }

      const skuPrefix = ((request.query as any).sku_prefix ?? '') as string

      const where: any = { syncChannels: { has: 'AMAZON' } }
      if (skuPrefix) where.sku = { contains: skuPrefix, mode: 'insensitive' }

      const products = await prisma.product.findMany({
        where,
        select: { id: true, sku: true, amazonAsin: true, name: true, isParent: true, parentId: true },
        orderBy: { sku: 'asc' },
      })

      const sp = await (amazonService as any).getClient()
      const results: any[] = []

      for (const product of products) {
        try {
          const res: any = await sp.callAPI({
            operation: 'getListingsItem',
            endpoint: 'listingsItems',
            path: { sellerId, sku: product.sku },
            query: {
              marketplaceIds: [marketplaceId],
              includedData: ['summaries', 'attributes', 'relationships'],
            },
          })

          const attrs = res.attributes ?? {}
          const parentageLevel: string | null =
            attrs.parentage_level?.[0]?.value ?? attrs.parentage_level?.[0]?.name ?? null
          const variationTheme: string | null = attrs.variation_theme?.[0]?.name ?? null
          const parentSkuFromAmazon: string | null =
            attrs.child_parent_sku_relationship?.[0]?.parent_sku ?? null

          const assessment =
            parentageLevel === 'parent' ? 'AMAZON_PARENT'
            : parentageLevel === 'child' ? `AMAZON_CHILD → parent_sku: ${parentSkuFromAmazon}`
            : parentageLevel ? `UNKNOWN_LEVEL: ${parentageLevel}`
            : 'NO_PARENTAGE (standalone or Amazon returned no parentage_level)'

          results.push({
            sku: product.sku,
            asin: product.amazonAsin,
            localIsParent: product.isParent,
            localHasParent: !!product.parentId,
            amazon: { parentageLevel, variationTheme, parentSku: parentSkuFromAmazon },
            assessment,
          })
        } catch (err: any) {
          const msg = err?.body?.errors?.[0]?.message ?? err?.message ?? String(err)
          const isNotFound = msg.toLowerCase().includes('not found') || msg.includes('NO_SUCH_LISTING')
          results.push({
            sku: product.sku,
            asin: product.amazonAsin,
            localIsParent: product.isParent,
            localHasParent: !!product.parentId,
            amazon: null,
            assessment: isNotFound ? 'STALE — SKU not on Amazon' : `ERROR: ${msg}`,
          })
        }
      }

      return {
        success: true,
        skuPrefix: skuPrefix || '(all)',
        count: results.length,
        results,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[verify-amazon-parents] failed')
      return reply.code(500).send({ success: false, error: error?.message ?? String(error) })
    }
  })

  /**
  /**
   * GET /api/amazon/products/test-catalog-api?asin=XXXXXXXXXX
   * Calls getCatalogItem (v2022-04-01) for an ASIN and returns the raw response or full error.
   * Pass ?asin= to test a specific ASIN; defaults to the first product in the DB.
   */
  fastify.get('/products/test-catalog-api', async (request, reply) => {
    try {
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
      }

      const { asin: queryAsin } = request.query as { asin?: string }
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

      let testAsin = queryAsin
      let testSku = queryAsin ? '(from query param)' : ''

      if (!testAsin) {
        const product = await prisma.product.findFirst({
          where: { amazonAsin: { not: null }, syncChannels: { has: 'AMAZON' } },
          select: { id: true, sku: true, amazonAsin: true },
        })
        if (!product) return { success: false, error: 'No Amazon products in DB' }
        testAsin = product.amazonAsin!
        testSku = product.sku
      }

      fastify.log.info({ asin: testAsin, marketplaceId }, '[test-catalog-api] Calling getCatalogItem v2022-04-01')

      const sp = await (amazonService as any).getClient()

      const callOne = async (includedData: string[]) => {
        try {
          const res = await sp.callAPI({
            operation: 'getCatalogItem',
            endpoint: 'catalogItems',
            version: '2022-04-01',
            path: { asin: testAsin },
            query: { marketplaceIds: [marketplaceId], includedData },
          })
          return { ok: true, data: res, includedData }
        } catch (err: any) {
          return {
            ok: false,
            includedData,
            error: err?.message ?? String(err),
            errorCode: err?.code ?? null,
            errorType: err?.type ?? null,
            // Serialize all enumerable own properties for full visibility
            fullError: JSON.parse(JSON.stringify(err, Object.getOwnPropertyNames(err))),
          }
        }
      }

      // Test 1: summaries only (basic Catalog Items access)
      const summariesResult = await callOne(['summaries'])
      // Test 2: relationships only (requires variation hierarchy access)
      const relationshipsResult = await callOne(['relationships'])

      return {
        asin: testAsin,
        sku: testSku,
        marketplaceId,
        apiVersion: '2022-04-01',
        summariesOnly: summariesResult,
        relationshipsOnly: relationshipsResult,
        // Diagnosis
        diagnosis: !summariesResult.ok
          ? 'CATALOG_ITEMS_API_BLOCKED: even summaries failed — role not granted or refresh token predates role grant'
          : !relationshipsResult.ok
          ? 'RELATIONSHIPS_BLOCKED: summaries OK but relationships denied — may need re-auth or Catalog Items v2 role'
          : 'ALL_OK: both summaries and relationships work',
      }
    } catch (error) {
      return reply.code(500).send({ success: false, error: error instanceof Error ? error.message : 'Unknown error' })
    }
  })

  // GET /api/amazon/test-catalog-api?asin=XXXXXXXXXX
  fastify.get('/test-catalog-api', async (request, reply) => {
    try {
      const asin = (request.query as any).asin || 'B0DYXSQP18'

      if (!amazonService.isConfigured()) {
        return reply.code(503).send({
          success: false,
          error: 'Amazon SP-API client not initialized',
          message: 'Check that all Amazon credentials are configured on Railway',
        })
      }

      console.log('Testing Catalog Items API for ASIN:', asin)
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

      const sp = await (amazonService as any).getClient()

      const result = await sp.callAPI({
        operation: 'getCatalogItem',
        endpoint: 'catalogItems',
        version: '2022-04-01',
        path: { asin },
        query: {
          marketplaceIds: [marketplaceId],
          includedData: ['relationships', 'summaries'],
        },
      })

      console.log('✅ Success! Got catalog data')

      return {
        success: true,
        asin,
        hasRelationships: !!result.relationships,
        parentAsins: result.relationships?.parentAsins || [],
        childAsins: result.relationships?.childAsins || [],
        data: result,
      }
    } catch (error: any) {
      console.error('❌ Catalog Items API Error:', error.message)
      console.error('Response headers:', error.response?.headers)
      console.error('Response data:', error.response?.data)
      console.error('Request ID:', error.response?.headers?.['x-amzn-requestid'] || error.response?.headers?.['x-amzn-request-id'])

      return reply.code(500).send({
        success: false,
        error: error.message,
        requestId: error.response?.headers?.['x-amzn-requestid'] || error.response?.headers?.['x-amzn-request-id'] || 'NOT_CAPTURED',
        timestamp: new Date().toISOString(),
        details: error.response?.data,
      })
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/amazon/products/sync-hierarchy
  //
  // Source-of-truth hierarchy sync: for every Amazon SKU in the DB, calls
  // Listings Items API getListingsItem with includedData=[summaries,
  // attributes, relationships] and persists Amazon's actual data:
  //
  //   - parentage_level                     → isParent
  //   - child_parent_sku_relationship.parent_sku  → parentId (resolved by SKU)
  //   - variation_theme[0].name              → variationTheme (prettified)
  //   - relationships[].variationTheme.attributes → exact attr names per child
  //   - attributes[<name>][0].value          → variation values per child
  //
  // No heuristics. No title parsing. No SKU pattern matching.
  //
  // Query:
  //   ?offset=0&limit=25 → batch over 247 SKUs (5–10 batches typical)
  //   ?reset=1           → before processing, clear ALL existing parent/child
  //                        links and variation-attribute JSON so the sync
  //                        starts from a clean slate.
  //
  // Returns: { processed, parents, children, standalone, orphans, errors,
  //            nextOffset, done }.
  // ────────────────────────────────────────────────────────────────────────
  fastify.post('/products/sync-hierarchy', async (request, reply) => {
    try {
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
      }
      const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
      if (!sellerId) {
        return reply
          .code(503)
          .send({ success: false, error: 'AMAZON_SELLER_ID env var required for Listings API' })
      }
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

      const q = request.query as { offset?: string; limit?: string; reset?: string }
      const offset = parseInt(q.offset ?? '0', 10) || 0
      const limit = Math.min(parseInt(q.limit ?? '25', 10) || 25, 100)
      const reset = (q.reset === '1' || q.reset === 'true') && offset === 0

      // On the very first call (offset=0 + reset=1), wipe prior heuristic
      // groupings so we re-build cleanly from Amazon.
      if (reset) {
        await prisma.product.updateMany({
          where: { syncChannels: { has: 'AMAZON' }, parentId: { not: null } },
          data: { parentId: null, parentAsin: null },
        })
        await prisma.product.updateMany({
          where: { syncChannels: { has: 'AMAZON' }, isParent: true },
          data: { isParent: false, variationTheme: null },
        })
        // Strip the heuristic .variations key from categoryAttributes for
        // every Amazon-synced product so the new sync writes Amazon's data.
        const all = await prisma.product.findMany({
          where: { syncChannels: { has: 'AMAZON' } },
          select: { id: true, categoryAttributes: true },
        })
        for (const p of all) {
          const ca = p.categoryAttributes
          if (ca && typeof ca === 'object' && !Array.isArray(ca) && (ca as any).variations) {
            const { variations: _drop, ...rest } = ca as any
            // Always write back an object (possibly empty) — avoids needing
            // Prisma.JsonNull to nullify a JSON column.
            await prisma.product.update({
              where: { id: p.id },
              data: { categoryAttributes: rest },
            })
          }
        }
      }

      const products = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        select: { id: true, sku: true, amazonAsin: true, totalStock: true },
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit,
      })

      if (products.length === 0) {
        // Roll up child stock to parents now that we're done
        const allParents = await prisma.product.findMany({
          where: { isParent: true },
          select: { id: true },
        })
        for (const parent of allParents) {
          const children = await prisma.product.findMany({
            where: { parentId: parent.id },
            select: { totalStock: true },
          })
          if (children.length > 0) {
            const totalStock = children.reduce((s, c) => s + (c.totalStock ?? 0), 0)
            await prisma.product.update({
              where: { id: parent.id },
              data: { totalStock },
            })
          }
        }
        return { success: true, done: true, processed: 0, message: 'sync complete; stock rolled up' }
      }

      const sp = await (amazonService as any).getClient()

      // Pretty-print: SIZE_NAME → "Size Name", TEAM_NAME → "Team Name"
      const prettyAttrName = (raw: string) =>
        raw
          .toLowerCase()
          .split('_')
          .map((w) => (w.length === 0 ? w : w[0].toUpperCase() + w.slice(1)))
          .join(' ')

      let parentsCount = 0
      let childrenCount = 0
      let standaloneCount = 0
      let orphanCount = 0
      const errors: Array<{ sku: string; error: string }> = []

      for (const product of products) {
        try {
          const res: any = await sp.callAPI({
            operation: 'getListingsItem',
            endpoint: 'listingsItems',
            path: { sellerId, sku: product.sku },
            query: {
              marketplaceIds: [marketplaceId],
              includedData: ['summaries', 'attributes', 'relationships'],
            },
          })

          const attrs = res.attributes ?? {}
          const parentageLevel: string | null =
            attrs.parentage_level?.[0]?.value ?? attrs.parentage_level?.[0]?.name ?? null
          const variationThemeRaw: string | null = attrs.variation_theme?.[0]?.name ?? null
          const variationThemePretty = variationThemeRaw
            ? variationThemeRaw.split('/').map(prettyAttrName).join(' / ')
            : null

          if (parentageLevel === 'parent') {
            // Mark as parent. Children will be linked when they're processed.
            await prisma.product.update({
              where: { id: product.id },
              data: { isParent: true, variationTheme: variationThemePretty },
            })
            parentsCount++
          } else if (parentageLevel === 'child') {
            const cpsr = attrs.child_parent_sku_relationship?.[0]
            const parentSku: string | undefined = cpsr?.parent_sku

            // Find the variation attribute names from relationships (canonical)
            const relGroup = res.relationships?.[0]?.relationships?.[0]
            const themeAttrNames: string[] =
              relGroup?.variationTheme?.attributes ??
              variationThemeRaw?.toLowerCase().split('/') ??
              []

            // Extract per-attribute variation values. Amazon stores size
            // inconsistently across product types: most use top-level
            // `size` / `size_name`, some use nested `apparel_size[0].size`.
            // Same idea for color (`color` vs `color_map[0].name`).
            const extractValue = (key: string): string | undefined => {
              const v = attrs[key]?.[0]
              const direct = v?.value ?? v?.name ?? v?.standardized_values?.[0]
              if (direct) return String(direct)
              if (key === 'size' || key === 'size_name') {
                const ap = attrs.apparel_size?.[0]
                // Amazon's apparel_size uses underscored alpha codes:
                // "m" → "M", "x_l" → "XL", "3x_l" → "3XL", "xx_l" → "XXL"
                if (ap?.size) return String(ap.size).toUpperCase().replace(/_/g, '')
              }
              if (key === 'color' || key === 'color_name') {
                const cm = attrs.color_map?.[0]
                if (cm?.name) return String(cm.name)
              }
              return undefined
            }
            const variations: Record<string, string> = {}
            for (const rawName of themeAttrNames) {
              const val = extractValue(rawName)
              if (val) variations[prettyAttrName(rawName)] = val
            }

            if (!parentSku) {
              // Child but no parent_sku reported — leave it alone, log
              standaloneCount++
              errors.push({ sku: product.sku, error: 'child without parent_sku from Amazon' })
            } else {
              const parent = await prisma.product.findUnique({
                where: { sku: parentSku },
                select: { id: true, amazonAsin: true },
              })
              // Build the update data; skip categoryAttributes when there's
              // nothing to write so we don't need Prisma.JsonNull.
              const updateData: any = {
                isParent: false,
                variationTheme: variationThemePretty,
              }
              if (!parent) {
                // Amazon reports a parent SKU we don't have in DB — orphan
                orphanCount++
                errors.push({
                  sku: product.sku,
                  error: `parent SKU "${parentSku}" not in DB`,
                })
                updateData.parentAsin = null
              } else {
                updateData.parentId = parent.id
                updateData.parentAsin = parent.amazonAsin
                childrenCount++
              }

              if (Object.keys(variations).length > 0) {
                const existing = await prisma.product.findUnique({
                  where: { id: product.id },
                  select: { categoryAttributes: true },
                })
                const baseCa =
                  existing?.categoryAttributes &&
                  typeof existing.categoryAttributes === 'object' &&
                  !Array.isArray(existing.categoryAttributes)
                    ? (existing.categoryAttributes as any)
                    : {}
                updateData.categoryAttributes = { ...baseCa, variations }
              }

              await prisma.product.update({
                where: { id: product.id },
                data: updateData,
              })
            }
          } else {
            // No parentage_level — standalone
            await prisma.product.update({
              where: { id: product.id },
              data: { isParent: false, parentId: null, parentAsin: null },
            })
            standaloneCount++
          }
        } catch (err: any) {
          const msg = err?.body?.errors?.[0]?.message ?? err?.message ?? String(err)
          errors.push({ sku: product.sku, error: msg })
          fastify.log.warn({ sku: product.sku, err }, '[sync-hierarchy] getListingsItem failed')
        }
      }

      const remaining = await prisma.product.count({
        where: { syncChannels: { has: 'AMAZON' } },
      })

      return {
        success: true,
        done: offset + products.length >= remaining,
        processed: products.length,
        parentsCount,
        childrenCount,
        standaloneCount,
        orphanCount,
        nextOffset: offset + products.length,
        totalAmazonProducts: remaining,
        errorCount: errors.length,
        sampleErrors: errors.slice(0, 5),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[sync-hierarchy] failed')
      return reply.code(500).send({
        success: false,
        error: error?.message ?? String(error),
      })
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/amazon/products/probe-listing?sku=XXX
  //
  // Calls getListingsItem on a single SKU with includedData=[
  //   summaries, attributes, relationships, identifiers, productTypes
  // ] and returns a digest highlighting Amazon's real hierarchy fields:
  //   - parentage_level     (parent | child)
  //   - variation_theme     (e.g. "SIZE_NAME/COLOR_NAME")
  //   - child_parent_sku_relationship.parent_sku
  //   - any size_name / color_name / body_type-style attributes
  //
  // This is the source of truth — no heuristics. Use to verify what the
  // sync will see before kicking off a full pass over 247 SKUs.
  // ────────────────────────────────────────────────────────────────────────
  fastify.get('/products/probe-listing', async (request, reply) => {
    try {
      const sku = (request.query as any).sku as string | undefined
      if (!sku) {
        return reply.code(400).send({ success: false, error: 'sku query param required' })
      }
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
      }

      const sellerId = process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
      if (!sellerId) {
        return reply.code(503).send({ success: false, error: 'AMAZON_SELLER_ID not set' })
      }

      const sp = await (amazonService as any).getClient()

      const res: any = await sp.callAPI({
        operation: 'getListingsItem',
        endpoint: 'listingsItems',
        path: { sellerId, sku },
        query: {
          marketplaceIds: [marketplaceId],
          // Documented values for v2021-08-01: summaries, attributes, issues,
          // offers, fulfillmentAvailability, procurement, relationships.
          includedData: ['summaries', 'attributes', 'relationships'],
        },
      })

      // Surface the fields that matter for hierarchy, plus the raw attributes
      // truncated to the keys most likely to carry variation data.
      const attrs = res.attributes ?? {}
      const variationTheme =
        attrs.variation_theme?.[0]?.name ??
        attrs.variation_theme?.[0]?.value ??
        null
      const parentageLevel =
        attrs.parentage_level?.[0]?.value ??
        attrs.parentage_level?.[0]?.name ??
        null

      // child_parent_sku_relationship is the canonical link: when present on
      // a child, its .child_parent_sku_relationship.parent_sku names the parent.
      const cpsr = attrs.child_parent_sku_relationship?.[0] ?? null

      // Hunt for any *_name attribute values — these are typically the
      // variation-axis values (size_name, color_name, body_type, etc.)
      const variationKeys: string[] = []
      const variationValues: Record<string, any> = {}
      for (const k of Object.keys(attrs)) {
        if (
          k.endsWith('_name') ||
          k === 'size_map' ||
          k === 'color_map' ||
          k === 'body_type' ||
          k === 'material'
        ) {
          variationKeys.push(k)
          // Each attr is an array of { value, marketplace_id, language_tag }
          variationValues[k] = attrs[k]?.[0]?.value ?? attrs[k]?.[0]
        }
      }

      return {
        sku,
        sellerId,
        marketplaceId,
        summaries: (res.summaries ?? []).map((s: any) => ({
          asin: s.asin,
          itemName: s.itemName,
          status: s.status,
          productType: s.productType,
          mainImage: s.mainImage?.link,
        })),
        relationships: res.relationships,
        hierarchy: {
          parentageLevel,
          variationTheme,
          childParentSkuRelationship: cpsr,
        },
        variationAttrs: variationValues,
        attributeKeys: Object.keys(attrs).sort(),
        // Full attributes object for first-time inspection — this can be large
        attributesRaw: attrs,
      }
    } catch (error: any) {
      fastify.log.error({ err: error, sku: (request.query as any).sku }, '[probe-listing] failed')
      return reply.code(500).send({
        success: false,
        error: error?.message ?? String(error),
        code: error?.body?.errors?.[0]?.code ?? error?.code,
        details: error?.body ?? null,
      })
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // Manual hierarchy merge — last-resort fallback when Catalog Items API and
  // Reports API both don't expose parent/child info. Lets the operator group
  // products manually via the UI.
  // ────────────────────────────────────────────────────────────────────────
  fastify.post<{
    Body: { parentSku: string; childSkus: string[]; variationTheme?: string }
  }>('/products/merge', async (request, reply) => {
    try {
      const { parentSku, childSkus, variationTheme } = request.body

      if (!parentSku || !Array.isArray(childSkus) || childSkus.length === 0) {
        return reply
          .code(400)
          .send({ success: false, error: 'parentSku and non-empty childSkus[] are required' })
      }

      const parent = await prisma.product.findUnique({ where: { sku: parentSku } })
      if (!parent) {
        return reply.code(404).send({ success: false, error: `Parent SKU not found: ${parentSku}` })
      }

      // Don't allow a parent to also be a child somewhere
      if (childSkus.includes(parentSku)) {
        return reply
          .code(400)
          .send({ success: false, error: 'parentSku cannot also appear in childSkus' })
      }

      await prisma.product.update({
        where: { id: parent.id },
        data: {
          isParent: true,
          variationTheme: variationTheme ?? 'Size',
        },
      })

      const result = await prisma.product.updateMany({
        where: { sku: { in: childSkus } },
        data: {
          parentId: parent.id,
          parentAsin: parent.amazonAsin,
          isParent: false,
        },
      })

      // Roll up child stock to parent (informational total)
      const children = await prisma.product.findMany({
        where: { parentId: parent.id },
        select: { totalStock: true },
      })
      const totalStock = children.reduce((s, c) => s + (c.totalStock ?? 0), 0)
      await prisma.product.update({ where: { id: parent.id }, data: { totalStock } })

      return {
        success: true,
        parentId: parent.id,
        parentSku,
        childrenLinked: result.count,
        rolledUpStock: totalStock,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, 'products/merge failed')
      return reply.code(500).send({ success: false, error: error?.message ?? String(error) })
    }
  })

  // POST /products/unmerge — undo a merge by parent SKU
  fastify.post<{ Body: { parentSku: string } }>('/products/unmerge', async (request, reply) => {
    try {
      const { parentSku } = request.body
      if (!parentSku) {
        return reply.code(400).send({ success: false, error: 'parentSku is required' })
      }
      const parent = await prisma.product.findUnique({ where: { sku: parentSku } })
      if (!parent) {
        return reply.code(404).send({ success: false, error: `Parent SKU not found: ${parentSku}` })
      }

      const result = await prisma.product.updateMany({
        where: { parentId: parent.id },
        data: { parentId: null, parentAsin: null, isParent: false },
      })

      await prisma.product.update({
        where: { id: parent.id },
        data: { isParent: false, variationTheme: null },
      })

      return {
        success: true,
        parentSku,
        childrenUnlinked: result.count,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, 'products/unmerge failed')
      return reply.code(500).send({ success: false, error: error?.message ?? String(error) })
    }
  })

  // ──────────────────────────────────────────────────────────────────────
  // PIM (Product Information Management) endpoints
  // ──────────────────────────────────────────────────────────────────────

  // GET /api/amazon/pim/detect-groups — preview, no DB writes
  fastify.get('/pim/detect-groups', async (_request, reply) => {
    try {
      const result = await detectVariationGroups()
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pim/detect-groups] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/amazon/pim/apply-groups — apply approved groups
  fastify.post<{ Body: { groups: ApprovedGroup[] } }>(
    '/pim/apply-groups',
    async (request, reply) => {
      try {
        const { groups } = request.body
        if (!Array.isArray(groups)) {
          return reply.code(400).send({ error: 'groups array required' })
        }
        const result = await applyGroupings(groups)
        return result
      } catch (error: any) {
        fastify.log.error({ err: error }, '[pim/apply-groups] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // POST /api/amazon/pim/create-group — manually create one master+children
  fastify.post<{
    Body: {
      masterSku: string
      masterName: string
      variationAxes: string[]
      childIds: string[]
      childAttributes?: Record<string, string>[]
    }
  }>('/pim/create-group', async (request, reply) => {
    try {
      const { masterSku, masterName, variationAxes, childIds, childAttributes } = request.body
      if (!masterSku || !masterName || !Array.isArray(childIds) || childIds.length === 0) {
        return reply
          .code(400)
          .send({ error: 'masterSku, masterName, and non-empty childIds required' })
      }
      const result = await applyGroupings([
        {
          masterSku,
          masterName,
          variationAxes: variationAxes ?? [],
          children: childIds.map((id, i) => ({
            productId: id,
            attributes: childAttributes?.[i] ?? {},
          })),
        },
      ])
      return result
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pim/create-group] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/amazon/pim/unlink-child — detach one or many children
  // from their master. C.4 — accepts either {productId} (legacy, kept
  // for back-compat with existing callers) or {productIds: []} (bulk).
  // Bulk runs as a single updateMany so partial-failure semantics are
  // simpler — either the row matches the WHERE or it doesn't. Capped
  // at 200 entries to avoid runaway updates.
  fastify.post<{
    Body: { productId?: string; productIds?: string[] }
  }>('/pim/unlink-child', async (request, reply) => {
    try {
      const body = request.body ?? {}
      const ids = Array.isArray(body.productIds)
        ? body.productIds.filter(
            (id): id is string => typeof id === 'string' && id.length > 0,
          )
        : body.productId
          ? [body.productId]
          : []
      if (ids.length === 0) {
        return reply
          .code(400)
          .send({ error: 'productId or productIds required' })
      }
      if (ids.length > 200) {
        return reply
          .code(400)
          .send({ error: 'Bulk unlink capped at 200 entries.' })
      }
      const result = await prisma.product.updateMany({
        where: { id: { in: ids } },
        data: { parentId: null, variantAttributes: undefined },
      })
      return { success: true, detached: result.count }
    } catch (error: any) {
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // DELETE /api/amazon/pim/master/:masterId — unlink children, delete master
  fastify.delete<{ Params: { masterId: string } }>(
    '/pim/master/:masterId',
    async (request, reply) => {
      try {
        const { masterId } = request.params
        await prisma.product.updateMany({
          where: { parentId: masterId },
          data: { parentId: null },
        })
        await prisma.product.delete({ where: { id: masterId } })
        return { success: true }
      } catch (error: any) {
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // POST /api/amazon/pim/link-amazon — verify ASIN on Amazon, link to product
  fastify.post<{
    Body: { productId: string; asin: string; marketplace?: string }
  }>('/pim/link-amazon', async (request, reply) => {
    try {
      const { productId, asin, marketplace } = request.body
      if (!productId || !asin) {
        return reply.code(400).send({ error: 'productId and asin required' })
      }
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({ error: 'Amazon SP-API not configured' })
      }

      const marketplaceId = marketplace || process.env.AMAZON_MARKETPLACE_ID || 'APJ6JRA9NG5V4'
      const region = (process.env.AMAZON_REGION || 'IT').toUpperCase()
      const sp = await (amazonService as any).getClient()

      const item: any = await sp.callAPI({
        operation: 'getCatalogItem',
        endpoint: 'catalogItems',
        version: '2022-04-01',
        path: { asin },
        query: {
          marketplaceIds: [marketplaceId],
          includedData: ['summaries', 'images'],
        },
      })
      if (!item.asin) {
        return reply.code(404).send({ error: 'ASIN not found on Amazon' })
      }

      const title = item.summaries?.[0]?.itemName ?? null
      const channelMarket = `AMAZON_${region}`

      await prisma.product.update({
        where: { id: productId },
        data: {
          amazonAsin: asin,
          linkedToChannels: { push: 'AMAZON' },
          lastAmazonSync: new Date(),
          amazonSyncStatus: 'LINKED',
        },
      })

      await prisma.channelListing.upsert({
        where: { productId_channelMarket: { productId, channelMarket } },
        create: {
          productId,
          channel: 'AMAZON',
          channelMarket,
          region,
          externalListingId: asin,
          platformProductId: asin,
          isPublished: true,
          title,
          listingStatus: 'ACTIVE',
        },
        update: {
          externalListingId: asin,
          platformProductId: asin,
          isPublished: true,
          lastSyncedAt: new Date(),
        },
      })

      return {
        success: true,
        asin,
        title,
        images: item.images?.[0]?.images ?? [],
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pim/link-amazon] failed')
      return reply.code(500).send({
        error: error?.message ?? String(error),
        details: error?.response?.data,
      })
    }
  })

  // DELETE /api/amazon/pim/products/stale
  // Body: { skus: string[] }
  // For each SKU: call getListingsItem; if Amazon returns "not found" (or
  // equivalent NO_SUCH_LISTING), delete the local Product row. Skip on any
  // other outcome (still on Amazon, transient API error, etc.) — those
  // SKUs stay in the DB and are reported back in skippedReasons.
  fastify.delete<{ Body: { skus: string[] } }>(
    '/pim/products/stale',
    async (request, reply) => {
      try {
        const { skus } = request.body
        if (!Array.isArray(skus) || skus.length === 0) {
          return reply.code(400).send({ error: 'skus array required' })
        }
        if (!amazonService.isConfigured()) {
          return reply.code(503).send({ error: 'Amazon SP-API not configured' })
        }
        const sellerId =
          process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
        const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
        if (!sellerId) {
          return reply.code(503).send({ error: 'AMAZON_SELLER_ID not set' })
        }

        const sp = await (amazonService as any).getClient()
        const deleted: string[] = []
        const skippedReasons: Array<{ sku: string; reason: string }> = []

        for (const sku of skus) {
          // 1. Make sure the row even exists locally
          const local = await prisma.product.findUnique({ where: { sku } })
          if (!local) {
            skippedReasons.push({ sku, reason: 'not in local DB' })
            continue
          }

          // 2. Ask Amazon
          let confirmedAbsent = false
          try {
            await sp.callAPI({
              operation: 'getListingsItem',
              endpoint: 'listingsItems',
              path: { sellerId, sku },
              query: {
                marketplaceIds: [marketplaceId],
                includedData: ['summaries'],
              },
            })
            // Successful call = SKU is on Amazon, do NOT delete
            skippedReasons.push({
              sku,
              reason: 'Amazon listing exists — refusing to delete',
            })
            continue
          } catch (err: any) {
            const msg =
              err?.body?.errors?.[0]?.message ??
              err?.body?.errors?.[0]?.code ??
              err?.message ??
              String(err)
            const lower = msg.toLowerCase()
            if (
              lower.includes('not found') ||
              lower.includes('no_such_listing') ||
              lower.includes('does not exist')
            ) {
              confirmedAbsent = true
            } else {
              skippedReasons.push({
                sku,
                reason: `Amazon API error (refusing to delete): ${msg}`,
              })
              continue
            }
          }

          if (!confirmedAbsent) continue

          // 3. Unlink any children that pointed to this product, then delete.
          // ChannelListing cleanup is best-effort: if the table doesn't
          // exist on this database (schema drift), the cascade would have
          // run on Product.delete anyway, and the row likely has no
          // listings to begin with for these stale local-only SKUs.
          try {
            await prisma.product.updateMany({
              where: { parentId: local.id },
              data: { parentId: null, parentAsin: null },
            })
            try {
              await prisma.channelListing.deleteMany({
                where: { productId: local.id },
              })
            } catch (chErr: any) {
              fastify.log.warn(
                { sku, err: chErr?.message },
                '[stale] channelListing cleanup skipped'
              )
            }
            await prisma.product.delete({ where: { id: local.id } })
            deleted.push(sku)
          } catch (err: any) {
            skippedReasons.push({
              sku,
              reason: `DB delete failed: ${err?.message ?? String(err)}`,
            })
          }
        }

        return {
          success: true,
          requested: skus.length,
          deleted: deleted.length,
          deletedSkus: deleted,
          skippedReasons,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[pim/products/stale] failed')
        return reply.code(500).send({ error: error?.message ?? String(error) })
      }
    }
  )

  // POST /api/amazon/pim/bulk-link-amazon — link every product with an ASIN
  fastify.post('/pim/bulk-link-amazon', async (_request, reply) => {
    try {
      const region = (process.env.AMAZON_REGION || 'IT').toUpperCase()
      const channelMarket = `AMAZON_${region}`

      const unlinked = await prisma.product.findMany({
        where: {
          amazonAsin: { not: null },
          OR: [{ amazonSyncStatus: null }, { amazonSyncStatus: { not: 'LINKED' } }],
        },
      })

      let linked = 0
      const errors: string[] = []

      for (const product of unlinked) {
        try {
          await prisma.product.update({
            where: { id: product.id },
            data: {
              linkedToChannels: { push: 'AMAZON' },
              amazonSyncStatus: 'LINKED',
              lastAmazonSync: new Date(),
            },
          })
          await prisma.channelListing.upsert({
            where: {
              productId_channelMarket: { productId: product.id, channelMarket },
            },
            create: {
              productId: product.id,
              channel: 'AMAZON',
              channelMarket,
              region,
              externalListingId: product.amazonAsin!,
              platformProductId: product.amazonAsin!,
              isPublished: true,
              title: product.name,
              listingStatus: 'ACTIVE',
            },
            update: {
              externalListingId: product.amazonAsin!,
              platformProductId: product.amazonAsin!,
              lastSyncedAt: new Date(),
            },
          })
          linked++
        } catch (err: any) {
          errors.push(`${product.sku}: ${err?.message ?? String(err)}`)
        }
      }

      return { linked, total: unlinked.length, errors }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[pim/bulk-link-amazon] failed')
      return reply.code(500).send({ error: error?.message ?? String(error) })
    }
  })

  // POST /api/amazon/orders/sync — pull orders from SP-API into the
  // Phase-26 unified Order schema. Two cursor modes:
  //   - body { since: ISO-8601 } → incremental poll (LastUpdatedAfter)
  //   - body { daysBack: N }     → backfill (CreatedAfter, default 30 days)
  // Without a body, runs incremental from the latest known purchase
  // date, falling back to a 30-day backfill if no Amazon orders exist
  // yet. Mirrors the cron's auto-cursor behaviour so manual + cron
  // produce identical results.
  //
  // M2: accepts `marketplaceIds?: string[]` (SP-API ids) OR
  // `marketplaceCodes?: string[]` (2-letter codes: IT/DE/FR/…). When
  // either is provided, the route fans out one sync per marketplace
  // sequentially (SP-API rate limits are per-account, parallel risks
  // burst exhaustion) and returns a per-marketplace results array.
  // When neither is provided, defaults to all `isParticipating=true`
  // markets from the Marketplace table.
  fastify.post<{
    Body?: {
      since?: string
      daysBack?: number
      from?: string
      to?: string
      limit?: number
      marketplaceIds?: string[]
      marketplaceCodes?: string[]
    }
  }>('/orders/sync', async (request, reply) => {
    if (!amazonOrdersService.isConfigured()) {
      return reply.code(503).send({
        success: false,
        error:
          'Amazon SP-API credentials are not configured. Required: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN',
      })
    }

    const body = request.body ?? {}

    // M2 — resolve target marketplaces. Priority: explicit ids > codes
    // mapped to ids > all isParticipating from the Marketplace table.
    const { default: prisma } = await import('../db.js')
    let targets: Array<{ id: string; code: string }> = []
    if (body.marketplaceIds && body.marketplaceIds.length > 0) {
      const rows = await prisma.marketplace.findMany({
        where: {
          channel: 'AMAZON',
          marketplaceId: { in: body.marketplaceIds },
        },
        select: { code: true, marketplaceId: true },
      })
      targets = rows
        .filter((r): r is { code: string; marketplaceId: string } => Boolean(r.marketplaceId))
        .map((r) => ({ id: r.marketplaceId, code: r.code }))
    } else if (body.marketplaceCodes && body.marketplaceCodes.length > 0) {
      const rows = await prisma.marketplace.findMany({
        where: {
          channel: 'AMAZON',
          code: { in: body.marketplaceCodes.map((c) => c.toUpperCase()) },
        },
        select: { code: true, marketplaceId: true },
      })
      targets = rows
        .filter((r): r is { code: string; marketplaceId: string } => Boolean(r.marketplaceId))
        .map((r) => ({ id: r.marketplaceId, code: r.code }))
    } else {
      // Default: all participating Amazon markets (set by
      // POST /api/amazon/participations/refresh in M1).
      const { getParticipatingAmazonMarketplaceIds } = await import(
        '../services/amazon-participations.service.js'
      )
      targets = await getParticipatingAmazonMarketplaceIds()
      // Fallback: if no markets are flagged participating (M1 refresh
      // never run), fall back to env default so this route stays
      // backwards-compatible with the IT-only callers.
      if (targets.length === 0) {
        const envId = process.env.AMAZON_MARKETPLACE_ID
        if (envId) {
          targets = [{ id: envId, code: 'IT' }]
        }
      }
    }

    if (targets.length === 0) {
      return reply.code(400).send({
        success: false,
        error: 'No target marketplaces resolved. Either pass marketplaceIds/marketplaceCodes in the body, or POST /api/amazon/participations/refresh first.',
      })
    }

    const fromDate = body.from ? new Date(body.from) : null
    const toDate = body.to ? new Date(body.to) : null
    if ((body.from && fromDate && isNaN(fromDate.getTime())) || (body.to && toDate && isNaN(toDate.getTime()))) {
      return reply.code(400).send({ success: false, error: `Invalid 'from' or 'to' timestamp` })
    }
    const sinceDate = body.since ? new Date(body.since) : null
    if (body.since && sinceDate && isNaN(sinceDate.getTime())) {
      return reply.code(400).send({ success: false, error: `Invalid 'since' timestamp: ${body.since}` })
    }

    // M2 — sequential fan-out. SP-API throttling is per-account, so
    // parallel calls burn the burst budget without speeding anything up.
    type MarketplaceResult = { marketplaceCode: string; marketplaceId: string; summary?: unknown; error?: string }
    const results: MarketplaceResult[] = []
    let anyFailure = false

    for (const target of targets) {
      try {
        let summary
        if (fromDate && toDate) {
          summary = await amazonOrdersService.syncOrdersInRange({
            from: fromDate, to: toDate, limit: body.limit, marketplaceId: target.id,
          })
        } else if (sinceDate) {
          summary = await amazonOrdersService.syncNewOrders(sinceDate, { limit: body.limit, marketplaceId: target.id })
        } else if (typeof body.daysBack === 'number') {
          summary = await amazonOrdersService.syncAllOrders({
            daysBack: body.daysBack, limit: body.limit, marketplaceId: target.id,
          })
        } else {
          // No explicit cursor — for multi-market default, prefer
          // explicit window. Auto-detect (latest purchaseDate) is only
          // meaningful for the single-market path.
          if (targets.length === 1) {
            const latest = await amazonOrdersService.getLatestPurchaseDate()
            summary = latest
              ? await amazonOrdersService.syncNewOrders(latest, { limit: body.limit, marketplaceId: target.id })
              : await amazonOrdersService.syncAllOrders({ limit: body.limit, marketplaceId: target.id })
          } else {
            // Multi-market without a cursor → default 30-day backfill
            // per market (mirrors syncAllOrders default).
            summary = await amazonOrdersService.syncAllOrders({ limit: body.limit, marketplaceId: target.id })
          }
        }
        const fetchFailed = summary.errors.some((e) => e.orderId === 'FETCH')
        if (fetchFailed) anyFailure = true
        results.push({ marketplaceCode: target.code, marketplaceId: target.id, summary })
      } catch (error) {
        anyFailure = true
        const errMsg = error instanceof Error ? error.message : String(error)
        fastify.log.error({ err: error, marketplaceCode: target.code }, '[amazon/orders/sync] per-market failed')
        results.push({ marketplaceCode: target.code, marketplaceId: target.id, error: errMsg })
      }
    }

    // Single-market path returns the legacy shape (flat summary on the
    // root object) so existing callers don't break. Multi-market always
    // returns `results[]`.
    if (targets.length === 1 && results[0]?.summary) {
      return { success: !anyFailure, ...(results[0].summary as object) }
    }
    return {
      success: !anyFailure,
      marketplaceCount: targets.length,
      results,
    }
  })

  // POST /api/amazon/orders/backfill-zero-totals — OX.0 repair pass for
  // orders that were ingested at €0.00 (Amazon withholds OrderTotal
  // for PENDING orders, and a small number can age out of the sync
  // cursor without ever picking up a price update). Uses SP-API
  // getOrder (which returns OrderTotal for every status) per stale row.
  // Body: { limit?: number } (default 100). Idempotent.
  fastify.post<{ Body?: { limit?: number } }>(
    '/orders/backfill-zero-totals',
    async (request, reply) => {
      if (!amazonOrdersService.isConfigured()) {
        return reply.code(503).send({
          success: false,
          error: 'Amazon SP-API credentials are not configured.',
        })
      }
      try {
        const result = await amazonOrdersService.backfillZeroTotals({
          limit: request.body?.limit,
        })
        return { success: true, ...result }
      } catch (error) {
        fastify.log.error({ err: error }, '[amazon/orders/backfill-zero-totals] failed')
        return reply.code(500).send({
          success: false,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    },
  )

  // POST /api/amazon/inventory/sync — pull live FBA inventory from
  // SP-API getInventorySummaries into Product.totalStock. Two modes:
  //   - body { sellerSkus: [...] } → bounded refresh (max 50 SKUs)
  //   - no body OR body { marketplaceId? } → full FBA sweep
  // Critical: SKUs absent from the SP-API response are NOT zeroed.
  // The endpoint covers FBA only; MFN stock is left untouched. See
  // amazon-inventory.service.ts for the full safety contract.
  fastify.post<{
    Body?: { sellerSkus?: string[]; marketplaceId?: string }
  }>('/inventory/sync', async (request, reply) => {
    if (!amazonInventoryService.isConfigured()) {
      return reply.code(503).send({
        success: false,
        error:
          'Amazon SP-API credentials are not configured. Required: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN',
      })
    }

    const body = request.body ?? {}
    try {
      const summary =
        body.sellerSkus && body.sellerSkus.length > 0
          ? await amazonInventoryService.syncFBAInventoryForSkus(body.sellerSkus, {
              marketplaceId: body.marketplaceId,
            })
          : await amazonInventoryService.syncFBAInventory({
              marketplaceId: body.marketplaceId,
            })
      return { success: true, ...summary }
    } catch (error) {
      fastify.log.error({ err: error }, '[amazon/inventory/sync] failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

  // POST /api/amazon/financials/sync — pull financial events for a date
  // window and write FinancialTransaction rows. Body: { start?, end?, daysBack? }
  // Defaults to yesterday if no range given. Safe to re-run (idempotent).
  fastify.post<{
    Body?: { start?: string; end?: string; daysBack?: number; useV0?: boolean; marketplaceId?: string }
  }>('/financials/sync', async (request, reply) => {
    const { syncFinancialEvents, syncYesterdayFinancialEvents, syncFinancialTransactions } = await import('../services/amazon-financial-events.service.js')
    try {
      const body = request.body ?? {}
      // Default to /finances/v0/financialEvents — the original endpoint
      // with mature event-shape parsing (nested ShipmentItemList per order).
      // The 2024-06-19/transactions endpoint is available via useNew=true
      // but the parser hasn't been updated for Amazon's {payload: {...}}
      // wrapper yet; v0 path is the reliable production default.
      const useV0 = body.useV0 !== false
      let summary
      if (body.start && body.end) {
        const start = new Date(body.start)
        let end = new Date(body.end)
        // Same clamp as daysBack path — protects scaffold callers that pass
        // T-23:59:59Z for "today" windows.
        const minAgo = new Date(Date.now() - 180_000)
        if (end > minAgo) end = minAgo
        summary = useV0
          ? await syncFinancialEvents(start, end)
          : await syncFinancialTransactions(start, end, body.marketplaceId)
      } else if (typeof body.daysBack === 'number') {
        // Clamp `end` to now − 3 min (SP-API rejects PostedBefore within
        // its ~2-min data-propagation window).
        const end = new Date(Date.now() - 180_000)
        const start = new Date(end.getTime() - body.daysBack * 24 * 60 * 60 * 1000)
        summary = useV0
          ? await syncFinancialEvents(start, end)
          : await syncFinancialTransactions(start, end, body.marketplaceId)
      } else {
        // Yesterday window
        const end = new Date()
        end.setHours(0, 0, 0, 0)
        const start = new Date(end.getTime() - 24 * 60 * 60 * 1000)
        summary = useV0
          ? await syncYesterdayFinancialEvents()
          : await syncFinancialTransactions(start, end, body.marketplaceId)
      }
      return { success: true, ...summary }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/financials/sync] failed')
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /api/amazon/settlements/sync — Phase 6.B settlement-report ingester.
  // Lists already-published settlement reports in the window, downloads each,
  // parses the summary row, upserts SettlementReport. Idempotent.
  //
  // Body shape — pick one:
  //   { from, to }              — ISO timestamps for createdSince/Until
  //   { daysBack: N }           — last N days (defaults to 14)
  //   {}                        — defaults to last 14 days (one settlement cycle)
  //
  // Optional:
  //   marketplaceIds?: string[] — limit to specific marketplaces; otherwise
  //                               iterates every active AMAZON Marketplace
  //   storeRawBody?: boolean    — default true; set false to skip rawBody
  //                               (saves DB space when only summaries are needed)
  fastify.post<{
    Body?: {
      from?: string
      to?: string
      daysBack?: number
      marketplaceIds?: string[]
      storeRawBody?: boolean
    }
  }>('/settlements/sync', async (request, reply) => {
    const { syncSettlementReports } = await import('../services/amazon-settlements.service.js')
    try {
      const body = request.body ?? {}
      let from: Date
      let to: Date
      if (body.from && body.to) {
        from = new Date(body.from)
        to = new Date(body.to)
        if (isNaN(from.getTime()) || isNaN(to.getTime())) {
          return reply.code(400).send({ success: false, error: `Invalid 'from' or 'to' timestamp` })
        }
      } else {
        const days = typeof body.daysBack === 'number' ? body.daysBack : 14
        to = new Date()
        from = new Date(to.getTime() - days * 24 * 60 * 60 * 1000)
      }
      const summary = await syncSettlementReports({
        from,
        to,
        marketplaceIds: body.marketplaceIds,
        storeRawBody: body.storeRawBody,
      })
      return { success: true, ...summary }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/settlements/sync] failed')
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // GET /api/amazon/reconciliation — channel vs Nexus drift report.
  // Compares SP-API order/revenue/inventory totals against our DB for
  // a configurable window. Operationally surfaces backfill gaps + sync drift.
  fastify.get<{ Querystring: { daysBack?: string; marketplaceId?: string } }>('/reconciliation', async (request, reply) => {
    const { reconcileAmazon } = await import('../services/channel-reconciliation.service.js')
    try {
      const q = request.query
      const daysBack = q.daysBack ? Math.min(180, Math.max(1, parseInt(q.daysBack, 10))) : 30
      const report = await reconcileAmazon({
        marketplaceId: q.marketplaceId,
        daysBack,
      })
      return report
    } catch (err) {
      fastify.log.error({ err }, '[amazon/reconciliation] failed')
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // ── HB-series historical backfill orchestrators ─────────────────────
  //
  // Both routes walk 24 months (configurable via daysBack) in 30-day
  // chunks, fanning out per-marketplace. Synchronous — the caller waits
  // for completion. For Railway gateway timeouts, prefer smaller windows
  // and call repeatedly, or trigger from a long-lived job.

  // POST /api/amazon/returns/backfill — HB.x returns 24mo
  fastify.post<{
    Body?: { daysBack?: number; marketplaceIds?: string[] }
  }>('/returns/backfill', async (request, reply) => {
    const { runReturnsBackfill } = await import('../services/historical-backfill.service.js')
    try {
      const result = await runReturnsBackfill(request.body ?? {})
      return { success: true, ...result }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/returns/backfill] failed')
      return reply.code(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // POST /api/amazon/settlements/backfill — HB.2 settlements 24mo
  fastify.post<{
    Body?: { daysBack?: number; marketplaceIds?: string[]; storeRawBody?: boolean }
  }>('/settlements/backfill', async (request, reply) => {
    const { runSettlementsBackfill } = await import('../services/historical-backfill.service.js')
    try {
      const result = await runSettlementsBackfill(request.body ?? {})
      return { success: true, ...result }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/settlements/backfill] failed')
      return reply.code(500).send({
        success: false,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // POST /api/amazon/participations/refresh — M1. Calls SP-API
  // getMarketplaceParticipations + writes back to our Marketplace table.
  // Records which markets the operator's auth scope actually permits;
  // backfills should fan out across only those flagged isParticipating.
  fastify.post('/participations/refresh', async (_request, reply) => {
    const { refreshAmazonParticipations } = await import('../services/amazon-participations.service.js')
    try {
      const result = await refreshAmazonParticipations()
      return result
    } catch (err) {
      fastify.log.error({ err }, '[amazon/participations/refresh] failed')
      return reply.code(500).send({
        error: err instanceof Error ? err.message : String(err),
      })
    }
  })

  // GET /api/amazon/participations — M1. Current per-marketplace
  // participation status, read straight from our Marketplace table
  // (last persisted snapshot). For a fresh read, POST /refresh first.
  fastify.get('/participations', async (_request, _reply) => {
    const { default: prisma } = await import('../db.js')
    const rows = await prisma.marketplace.findMany({
      where: { channel: 'AMAZON' },
      select: {
        code: true,
        marketplaceId: true,
        currency: true,
        region: true,
        isActive: true,
        isParticipating: true,
        participationStatus: true,
        participationCheckedAt: true,
      },
      orderBy: { code: 'asc' },
    })
    return { marketplaces: rows }
  })

  // GET /api/amazon/reconciliation/all — I11 per-marketplace fan-out.
  // Runs reconcileAmazon across every connected Amazon marketplace and
  // groups revenue drift per native currency. Sequential (not parallel)
  // to respect SP-API per-account rate limits. Daily run target for the
  // operator's morning health check.
  fastify.get<{ Querystring: { daysBack?: string } }>('/reconciliation/all', async (request, reply) => {
    const { reconcileAllAmazonMarketplaces } = await import('../services/channel-reconciliation.service.js')
    try {
      const q = request.query
      const daysBack = q.daysBack ? Math.min(180, Math.max(1, parseInt(q.daysBack, 10))) : 30
      const report = await reconcileAllAmazonMarketplaces({ daysBack })
      return report
    } catch (err) {
      fastify.log.error({ err }, '[amazon/reconciliation/all] failed')
      return reply.code(500).send({ error: err instanceof Error ? err.message : String(err) })
    }
  })

  // POST /api/amazon/aplus/sync — Phase 9 metadata reconciliation.
  // Pulls all A+ Content documents from Amazon for the marketplace and
  // upserts them into APlusContent. Body: { marketplaceId? }.
  fastify.post<{ Body?: { marketplaceId?: string } }>('/aplus/sync', async (request, reply) => {
    const { pullAPlusContentMetadata } = await import('../services/aplus-amazon-pull.service.js')
    try {
      const summary = await pullAPlusContentMetadata({ marketplaceId: request.body?.marketplaceId })
      return { success: true, ...summary }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/aplus/sync] failed')
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // GET /api/amazon/aplus/probe — Phase 9 reconciliation probe.
  // Calls GET /aplus/2020-11-01/contentDocuments to see if Amazon
  // has any A+ Content published for this seller. If 0, Phase 9 is
  // a no-op (nothing to reconcile). If non-zero, we build the pull.
  fastify.get('/aplus/probe', async () => {
    const clientId = process.env.AMAZON_LWA_CLIENT_ID
    const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
    const refreshToken = process.env.AMAZON_REFRESH_TOKEN
    const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
    const region = (process.env.AMAZON_REGION ?? 'eu') as string
    const host = `sellingpartnerapi-${region}.amazon.com`
    if (!clientId || !clientSecret || !refreshToken) return { error: 'creds missing' }
    const tok = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    if (!tok.ok) return { error: `LWA failed: ${await tok.text()}` }
    const { access_token } = await tok.json() as { access_token: string }
    const probes: Array<{ name: string; path: string }> = [
      { name: 'aplus-listDocs', path: `/aplus/2020-11-01/contentDocuments?marketplaceId=${marketplaceId}&pageSize=20` },
      { name: 'aplus-listAsins', path: `/aplus/2020-11-01/contentAsinRelations?marketplaceId=${marketplaceId}&asinSet=B0BMSC91YK` },
    ]
    const results: Array<{ name: string; status: number; sample?: unknown; error?: string }> = []
    for (const p of probes) {
      try {
        const r = await fetch(`https://${host}${p.path}`, {
          headers: { 'x-amz-access-token': access_token },
        })
        const body = await r.text()
        let sample: unknown
        let errMsg: string | undefined
        if (r.status === 200) {
          try {
            const j = JSON.parse(body)
            sample = {
              keys: Object.keys(j),
              contentMetadataRecordsCount: j.contentMetadataRecords?.length ?? j.payload?.contentMetadataRecords?.length,
              asinMetadataSetCount: j.asinMetadataSet?.length ?? j.payload?.asinMetadataSet?.length,
              hasNext: !!j.nextPageToken,
            }
          } catch {}
        } else {
          try { const j = JSON.parse(body); errMsg = j.errors?.[0]?.message ?? j.message ?? body.slice(0, 200) } catch { errMsg = body.slice(0, 200) }
        }
        results.push({ name: p.name, status: r.status, sample, error: errMsg })
      } catch (e) {
        results.push({ name: p.name, status: 0, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { results }
  })

  // POST /api/amazon/returns/sync — Phase 7 returns backfill. Body shape:
  //   { from, to, marketplaceId? }  — explicit window
  //   { hoursBack: N }              — default rolling window (matches cron)
  fastify.post<{
    Body?: { from?: string; to?: string; hoursBack?: number; marketplaceId?: string }
  }>('/returns/sync', async (request, reply) => {
    const { pollAmazonReturns } = await import('../services/amazon-returns/ingest.service.js')
    try {
      const body = request.body ?? {}
      const opts: Parameters<typeof pollAmazonReturns>[0] = {}
      if (body.marketplaceId) opts.marketplaceId = body.marketplaceId
      if (body.from && body.to) {
        const start = new Date(body.from)
        let end = new Date(body.to)
        if (isNaN(start.getTime()) || isNaN(end.getTime())) {
          return reply.code(400).send({ success: false, error: `Invalid 'from'/'to' timestamp` })
        }
        // Clamp end to now-3min (SP-API report quirks)
        const minAgo = new Date(Date.now() - 180_000)
        if (end > minAgo) end = minAgo
        opts.dataStartTime = start
        opts.dataEndTime = end
      } else if (typeof body.hoursBack === 'number') {
        opts.hoursBack = body.hoursBack
      }
      const result = await pollAmazonReturns(opts)
      return { success: true, ...result }
    } catch (err) {
      fastify.log.error({ err }, '[amazon/returns/sync] failed')
      return reply.code(500).send({ success: false, error: err instanceof Error ? err.message : String(err) })
    }
  })

  // GET /api/amazon/finance/probe — diagnostic. Probes 3 Finance + 2 Reports
  // endpoints using the current production refresh token and reports which
  // ones grant access. Used to determine whether Amazon's Finance role grant
  // is partial (some endpoints work, others don't) or fully blocked.
  fastify.get('/finance/probe', async () => {
    const clientId = process.env.AMAZON_LWA_CLIENT_ID
    const clientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
    const refreshToken = process.env.AMAZON_REFRESH_TOKEN
    const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
    const region = (process.env.AMAZON_REGION ?? 'eu') as string
    const host = `sellingpartnerapi-${region}.amazon.com`

    if (!clientId || !clientSecret || !refreshToken) {
      return { error: 'creds missing' }
    }

    // Refresh LWA
    const tokRes = await fetch('https://api.amazon.com/auth/o2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
    })
    if (!tokRes.ok) {
      return { error: `LWA failed: ${await tokRes.text()}` }
    }
    const { access_token: accessToken } = await tokRes.json() as { access_token: string }

    const since = new Date(Date.now() - 30 * 86400_000).toISOString()
    const sinceShort = new Date(Date.now() - 7 * 86400_000).toISOString()
    const endpoints = [
      { name: 'finance-v0-events',     path: `/finances/v0/financialEvents?PostedAfter=${sinceShort}&MaxResultsPerPage=10` },
      { name: 'finance-v0-eventGroups', path: `/finances/v0/financialEventGroups?FinancialEventGroupStartedAfter=${sinceShort}&MaxResultsPerPage=10` },
      { name: 'finance-2024-transactions-with-marketplace', path: `/finances/2024-06-19/transactions?postedAfter=${since}&marketplaceId=${marketplaceId}` },
      { name: 'finance-2024-transactions-no-marketplace', path: `/finances/2024-06-19/transactions?postedAfter=${since}` },
      { name: 'reports-settlement-list', path: `/reports/2021-06-30/reports?reportTypes=GET_V2_SETTLEMENT_REPORT_DATA_FLAT_FILE_V2&pageSize=5` },
      { name: 'reports-merchant-listings', path: `/reports/2021-06-30/reports?reportTypes=GET_MERCHANT_LISTINGS_ALL_DATA&pageSize=5` },
    ]

    const results: Array<{ name: string; status: number; ok: boolean; error?: string; sample?: unknown }> = []
    for (const ep of endpoints) {
      try {
        const r = await fetch(`https://${host}${ep.path}`, {
          headers: { 'x-amz-access-token': accessToken, 'Content-Type': 'application/json' },
        })
        const body = await r.text()
        let errMsg: string | undefined
        let sample: unknown = undefined
        if (r.status !== 200) {
          try {
            const j = JSON.parse(body)
            errMsg = j.errors?.[0]?.message ?? j.message ?? body.slice(0, 200)
          } catch {
            errMsg = body.slice(0, 200)
          }
        } else if (ep.name.includes('finance-2024')) {
          try {
            const j = JSON.parse(body)
            sample = {
              transactionCount: j.transactions?.length ?? 0,
              firstTransaction: j.transactions?.[0],
              hasNextToken: !!j.nextToken,
              rawKeys: Object.keys(j),
            }
          } catch {}
        }
        results.push({ name: ep.name, status: r.status, ok: r.status === 200, error: errMsg, sample })
      } catch (e) {
        results.push({ name: ep.name, status: 0, ok: false, error: e instanceof Error ? e.message : String(e) })
      }
    }
    return { tokenFingerprint: refreshToken.slice(-8), results }
  })

  /**
   * GET /api/amazon/sp-api/health
   *
   * Pre-flight diagnostic for the Listings Items API path the wizard
   * uses. Use this to verify SP-API auth before launching a real
   * publish — surfaces creds-missing / LWA-failed / network issues
   * cleanly so the operator doesn't waste a wizard run debugging a
   * config problem.
   *
   * Tests, in order:
   *   1. Required env vars present.
   *   2. AMAZON_SELLER_ID set (publishes can't run without it).
   *   3. LWA token exchange — proves the refresh token + LWA app
   *      credentials are valid.
   *   4. Optional: getListingsItem against ?sku= to round-trip an
   *      authenticated SP-API call. Useful when a known SKU exists in
   *      the seller's catalog; skipped when ?sku= is absent.
   */
  fastify.get<{ Querystring: { sku?: string; marketplaceId?: string } }>(
    '/sp-api/health',
    async (request) => {
      const checks: Array<{
        name: string
        ok: boolean
        detail?: string
      }> = []

      const requiredEnv = [
        'AMAZON_LWA_CLIENT_ID',
        'AMAZON_LWA_CLIENT_SECRET',
        'AMAZON_REFRESH_TOKEN',
        'AWS_ACCESS_KEY_ID',
        'AWS_SECRET_ACCESS_KEY',
      ] as const
      const missingEnv = requiredEnv.filter((k) => !process.env[k])
      checks.push({
        name: 'env',
        ok: missingEnv.length === 0,
        detail:
          missingEnv.length === 0
            ? 'All required SP-API env vars set'
            : `Missing: ${missingEnv.join(', ')}`,
      })

      const sellerId =
        process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID
      checks.push({
        name: 'sellerId',
        ok: !!sellerId,
        detail: sellerId
          ? 'AMAZON_SELLER_ID set'
          : 'Set AMAZON_SELLER_ID to the SP-API merchant token',
      })

      // LWA token exchange — proves refresh token + client creds.
      // Wrapped in try so a 401 from LWA reports cleanly rather than
      // bubbling up as a 500.
      let lwaOk = false
      let lwaDetail = ''
      if (missingEnv.length === 0) {
        try {
          await amazonSpApiClient.getAccessToken()
          lwaOk = true
          lwaDetail = 'Access token obtained from Login With Amazon'
        } catch (err) {
          lwaDetail = err instanceof Error ? err.message : String(err)
        }
      } else {
        lwaDetail = 'Skipped — required env vars missing'
      }
      checks.push({ name: 'lwa', ok: lwaOk, detail: lwaDetail })

      // Optional round-trip: GET a known SKU. Lets the operator
      // verify SP-API connectivity end-to-end (auth + signing +
      // network). When ?sku= absent we skip — the LWA exchange is
      // proof enough for a baseline health check.
      const probeSku = (request.query?.sku ?? '').trim()
      const probeMarketplace =
        (request.query?.marketplaceId ?? '').trim() ||
        process.env.AMAZON_MARKETPLACE_ID ||
        'APJ6JRA9NG5V4'
      let listingProbe: {
        ran: boolean
        ok: boolean
        sku?: string
        asin?: string | null
        status?: string | null
        error?: string
      } = { ran: false, ok: false }
      if (probeSku && lwaOk && sellerId) {
        try {
          const r = await amazonSpApiClient.getListingsItem({
            sellerId,
            sku: probeSku,
            marketplaceId: probeMarketplace,
            includedData: ['summaries'],
          })
          listingProbe = {
            ran: true,
            ok: r.success,
            sku: probeSku,
            asin: r.asin ?? null,
            status: r.status ?? null,
            error: r.success ? undefined : r.error,
          }
        } catch (err) {
          listingProbe = {
            ran: true,
            ok: false,
            sku: probeSku,
            error: err instanceof Error ? err.message : String(err),
          }
        }
      }

      const overall = checks.every((c) => c.ok)
        ? listingProbe.ran
          ? listingProbe.ok
            ? 'OK'
            : 'PROBE_FAILED'
          : 'OK_NO_PROBE'
        : 'FAILED'

      return {
        overall,
        checks,
        listingProbe,
        config: {
          region: process.env.AMAZON_REGION ?? 'eu-west-1',
          marketplaceId: probeMarketplace,
        },
      }
    },
  )

  // O.16a — Account Health: rolling-30d LSR + VTR computed from
  // local FBM Order data. SP-API GetAccountHealth integration is
  // a separate commit (env-flag-gated for compliance proof when
  // numbers must match the official dashboard exactly).
  fastify.get('/account-health', async (_request, reply) => {
    try {
      const health = await computeAmazonAccountHealth()
      return health
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'failed' })
    }
  })

  // O.16b — Buy Shipping rate quotes (dryRun by default; real path
  // gated behind NEXUS_ENABLE_AMAZON_BUY_SHIPPING=true).
  fastify.post('/orders/:id/buy-shipping/quote', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const result = await getBuyShippingRates(id)
      return result
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'failed' })
    }
  })

  fastify.post('/orders/:id/buy-shipping/purchase', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { serviceId?: string }
      if (!body.serviceId) {
        return reply.code(400).send({ error: 'serviceId required' })
      }
      const result = await purchaseBuyShippingLabel({
        orderId: id,
        serviceId: body.serviceId,
      })
      return result
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'failed' })
    }
  })
}

export default amazonRoutes
