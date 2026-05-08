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
  fastify.post<{
    Body?: { since?: string; daysBack?: number; limit?: number }
  }>('/orders/sync', async (request, reply) => {
    if (!amazonOrdersService.isConfigured()) {
      return reply.code(503).send({
        success: false,
        error:
          'Amazon SP-API credentials are not configured. Required: AMAZON_LWA_CLIENT_ID, AMAZON_LWA_CLIENT_SECRET, AMAZON_REFRESH_TOKEN, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, AWS_ROLE_ARN',
      })
    }

    const body = request.body ?? {}
    try {
      let summary
      if (body.since) {
        const since = new Date(body.since)
        if (isNaN(since.getTime())) {
          return reply.code(400).send({
            success: false,
            error: `Invalid 'since' timestamp: ${body.since}`,
          })
        }
        summary = await amazonOrdersService.syncNewOrders(since, { limit: body.limit })
      } else if (typeof body.daysBack === 'number') {
        summary = await amazonOrdersService.syncAllOrders({
          daysBack: body.daysBack,
          limit: body.limit,
        })
      } else {
        // No explicit cursor — auto-detect.
        const latest = await amazonOrdersService.getLatestPurchaseDate()
        summary = latest
          ? await amazonOrdersService.syncNewOrders(latest, { limit: body.limit })
          : await amazonOrdersService.syncAllOrders({ limit: body.limit })
      }
      return { success: true, ...summary }
    } catch (error) {
      fastify.log.error({ err: error }, '[amazon/orders/sync] failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : String(error),
      })
    }
  })

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
}

export default amazonRoutes
