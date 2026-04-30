import type { FastifyPluginAsync } from 'fastify'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import { detectGroups, type ProductLite } from '../services/variation-parser.service.js'
import prisma from '../db.js'

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

  /**
   * POST /api/amazon/products/group-by-sku
   *
   * Detects parent/child variation groups purely from SKU naming patterns
   * (e.g. GALE-JACKET-BLACK-MEN-XL → child of GALE-JACKET-BLACK-MEN)
   * and writes isParent / parentId / variationTheme to the database.
   *
   * Safe to run multiple times — idempotent.
   */
  fastify.post('/products/group-by-sku', async (_request, reply) => {
    try {
      const SIZE_SUFFIX_RE =
        /[-_](xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|5xl|6xl|one-?size|\d{2,3})$/i

      const allProducts = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        select: { id: true, sku: true, name: true, totalStock: true },
      })

      const skuToId = new Map(allProducts.map((p) => [p.sku.toLowerCase(), p.id]))

      // Group products by the prefix obtained by stripping the size suffix
      const groups = new Map<string, Array<{ id: string; sku: string }>>()
      for (const p of allProducts) {
        const match = p.sku.match(SIZE_SUFFIX_RE)
        if (!match) continue
        const prefix = p.sku.slice(0, p.sku.length - match[0].length)
        const arr = groups.get(prefix.toLowerCase()) ?? []
        arr.push({ id: p.id, sku: p.sku })
        groups.set(prefix.toLowerCase(), arr)
      }

      let parentsCreated = 0
      let parentsFound = 0
      let childrenLinked = 0

      for (const [prefixLower, children] of groups) {
        // Only treat as a group if 2+ children share the same prefix
        if (children.length < 2) continue

        // Find if a product with this exact prefix SKU already exists
        const existingParentId = skuToId.get(prefixLower)

        let parentDbId: string

        if (existingParentId) {
          // Promote existing product to parent
          await prisma.product.update({
            where: { id: existingParentId },
            data: { isParent: true },
          })
          parentDbId = existingParentId
          parentsFound++
        } else {
          // Reconstruct the original-case prefix from one of the children
          const originalPrefix = children[0].sku.replace(SIZE_SUFFIX_RE, '')
          // Pick a representative child for the name
          const refChild = allProducts.find((p) => p.id === children[0].id)!
          const parentName = refChild.name.replace(
            /\s*[-–]?\s*(taglia|misura|size|mis\.)?\s*(xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|5xl|6xl)\b.*/i,
            ''
          ).trim()

          const parent = await prisma.product.upsert({
            where: { sku: originalPrefix },
            update: { isParent: true },
            create: {
              sku: originalPrefix,
              name: parentName || originalPrefix,
              basePrice: 0,
              totalStock: 0,
              isParent: true,
              status: 'ACTIVE',
              syncChannels: ['AMAZON'],
              minMargin: 0,
            },
          })
          parentDbId = parent.id
          parentsCreated++
          // Add to lookup so siblings can find it
          skuToId.set(prefixLower, parentDbId)
        }

        // Link all size-children to this parent
        for (const child of children) {
          await prisma.product.update({
            where: { id: child.id },
            data: {
              parentId: parentDbId,
              variationTheme: 'Size',
            },
          })
          childrenLinked++
        }

        // Roll up stock to parent
        const childStocks = await prisma.product.findMany({
          where: { parentId: parentDbId },
          select: { totalStock: true },
        })
        await prisma.product.update({
          where: { id: parentDbId },
          data: {
            totalStock: childStocks.reduce((s, c) => s + c.totalStock, 0),
          },
        })
      }

      fastify.log.info(
        `[SKU-GROUP] parentsCreated=${parentsCreated} parentsFound=${parentsFound} childrenLinked=${childrenLinked}`
      )

      return {
        success: true,
        parentsCreated,
        parentsFound,
        childrenLinked,
        groupsDetected: [...groups.values()].filter((v) => v.length >= 2).length,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'group-by-sku failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // GET /api/amazon/products/:id/children - Fetch children of a parent product
  // Lifts categoryAttributes.variations to a top-level `variations` field for
  // easy frontend consumption (per-attribute badge rendering).
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
  fastify.get('/products/list', async (request, reply) => {
    try {
      const products = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        orderBy: { createdAt: 'desc' },
      })

      return {
        success: true,
        count: products.length,
        products,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'Failed to list Amazon products')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
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

  /**
   * POST /api/amazon/products/reset-sku-grouping
   * Removes the fake SKU-based parent records and resets parentId on their children.
   * Safe to run: only touches products where isParent=true AND amazonAsin IS NULL
   * (which is the signature of a SKU-generated parent, not a real Amazon parent).
   */
  fastify.post('/products/reset-sku-grouping', async (_request, reply) => {
    try {
      const fakeParents = await prisma.product.findMany({
        where: { isParent: true, amazonAsin: null },
        select: { id: true, sku: true },
      })

      let childrenReset = 0
      for (const fp of fakeParents) {
        const updated = await prisma.product.updateMany({
          where: { parentId: fp.id },
          data: { parentId: null, variationTheme: null },
        })
        childrenReset += updated.count
      }

      const deleted = await prisma.product.deleteMany({
        where: { isParent: true, amazonAsin: null },
      })

      // Also reset the 1 existing product that was promoted to isParent via group-by-sku
      // (it has amazonAsin set but has children pointing to it from SKU grouping).
      // Those children were already reset above via parentId reset.
      // Reset isParent on products that now have 0 children.
      const promotedParents = await prisma.product.findMany({
        where: { isParent: true, amazonAsin: { not: null } },
        select: { id: true },
      })
      for (const pp of promotedParents) {
        const childCount = await prisma.product.count({ where: { parentId: pp.id } })
        if (childCount === 0) {
          await prisma.product.update({ where: { id: pp.id }, data: { isParent: false } })
        }
      }

      return {
        success: true,
        fakeParentsDeleted: deleted.count,
        childrenReset,
        message: `Removed ${deleted.count} SKU-based fake parents, reset ${childrenReset} children`,
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

  /**
   * POST /api/amazon/products/reindex-hierarchy
   *
   * Retroactively builds parent/child relationships for products already in the
   * DB by querying the Catalog Items API with includedData=["relationships"].
   *
   * Processes up to `limit` products per call (default 50) starting at `offset`.
   * Run in batches: POST ?offset=0, then ?offset=50, etc. until `done: true`.
   */
  fastify.post('/products/reindex-hierarchy', async (request, reply) => {
    try {
      if (!amazonService.isConfigured()) {
        return reply.code(503).send({
          success: false,
          error: 'Amazon SP-API credentials are not configured.',
        })
      }

      const query = request.query as { offset?: string; limit?: string }
      const offset = parseInt(query.offset ?? '0', 10) || 0
      const limit = Math.min(parseInt(query.limit ?? '50', 10) || 50, 100)
      const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'

      const products = await (prisma as any).product.findMany({
        where: {
          syncChannels: { has: 'AMAZON' },
          amazonAsin: { not: null },
          parentId: null,
          isParent: false,
        },
        select: { id: true, sku: true, amazonAsin: true, name: true },
        orderBy: { createdAt: 'asc' },
        skip: offset,
        take: limit,
      })

      if (products.length === 0) {
        return { success: true, done: true, processed: 0, linked: 0, message: 'All products already indexed.' }
      }

      const sp = await (amazonService as any).getClient()
      let linked = 0
      let parentsCreated = 0
      const errors: Array<{ asin: string; error: string }> = []

      for (const product of products) {
        try {
          const res: any = await sp.callAPI({
            operation: 'getCatalogItem',
            endpoint: 'catalogItems',
            version: '2022-04-01',
            path: { asin: product.amazonAsin },
            query: {
              marketplaceIds: [marketplaceId],
              includedData: ['relationships', 'summaries'],
            },
          })

          const relationships: any[] = res?.relationships ?? []

          for (const rel of relationships) {
            if (rel.type !== 'VARIATION') continue

            // Child product: has parentAsins
            const parentAsins: string[] = rel.parentAsins ?? []
            if (parentAsins.length > 0) {
              const parentAsin = parentAsins[0]
              const variationTheme: string | null =
                rel.variationTheme?.name ??
                (Array.isArray(rel.variationTheme?.attributes)
                  ? rel.variationTheme.attributes.join('')
                  : null)

              let parentRecord = await (prisma as any).product.findFirst({
                where: { amazonAsin: parentAsin },
                select: { id: true },
              })

              if (!parentRecord) {
                const parentSku = `PARENT-${parentAsin}`
                parentRecord = await prisma.product.upsert({
                  where: { sku: parentSku },
                  update: { isParent: true, amazonAsin: parentAsin },
                  create: {
                    sku: parentSku,
                    name: product.name,
                    basePrice: 0,
                    totalStock: 0,
                    isParent: true,
                    amazonAsin: parentAsin,
                    status: 'ACTIVE',
                    syncChannels: ['AMAZON'],
                    minMargin: 0,
                  },
                })
                parentsCreated++
              } else {
                await prisma.product.update({
                  where: { id: parentRecord.id },
                  data: { isParent: true },
                })
              }

              await prisma.product.update({
                where: { id: product.id },
                data: {
                  parentId: parentRecord.id,
                  parentAsin,
                  ...(variationTheme ? { variationTheme } : {}),
                },
              })
              linked++
              break
            }

            // Parent product: has childAsins
            const childAsins: string[] = rel.childAsins ?? []
            if (childAsins.length > 0) {
              await prisma.product.update({
                where: { id: product.id },
                data: { isParent: true },
              })
              break
            }
          }
        } catch (err: any) {
          const msg = err?.body?.errors?.[0]?.message ?? err?.message ?? String(err)
          errors.push({ asin: product.amazonAsin, error: msg })
          fastify.log.warn({ asin: product.amazonAsin, err }, '[Amazon] reindex-hierarchy: getCatalogItem failed')
        }
      }

      // Roll up stock to any parents that gained children this batch
      if (linked > 0 || parentsCreated > 0) {
        const parents = await (prisma as any).product.findMany({
          where: { isParent: true },
          select: { id: true },
        })
        for (const parent of parents) {
          const children = await prisma.product.findMany({
            where: { parentId: parent.id },
            select: { totalStock: true },
          })
          if (children.length > 0) {
            await prisma.product.update({
              where: { id: parent.id },
              data: { totalStock: children.reduce((s: number, c: any) => s + c.totalStock, 0) },
            })
          }
        }
      }

      const remaining = await (prisma as any).product.count({
        where: { syncChannels: { has: 'AMAZON' }, amazonAsin: { not: null }, parentId: null, isParent: false },
      })

      return {
        success: true,
        done: remaining === 0,
        processed: products.length,
        linked,
        parentsCreated,
        remaining,
        nextOffset: offset + limit,
        // Return first 3 errors so callers can diagnose without reading server logs
        sampleErrors: errors.slice(0, 3),
        totalErrors: errors.length,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'reindex-hierarchy failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // Reports-API-based hierarchy discovery (alternative to Catalog Items API
  // when the SP-API app does not have the Catalog Items role).
  //
  // Each /test-report/:reportType endpoint kicks off a report. Poll status
  // and download the document with /test-report-status/:reportId.
  // ────────────────────────────────────────────────────────────────────────

  const ALLOWED_REPORT_TYPES = new Set([
    'GET_MERCHANT_LISTINGS_DATA',
    'GET_MERCHANT_LISTINGS_ALL_DATA',
    'GET_MERCHANT_LISTINGS_INACTIVE_DATA',
    'GET_FLAT_FILE_OPEN_LISTINGS_DATA',
    'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_LAST_UPDATE_GENERAL',
    'GET_FBA_INVENTORY_PLANNING_DATA',
    'GET_XML_BROWSE_TREE_DATA',
    'GET_AFN_INVENTORY_DATA',
    'GET_RESTOCK_INVENTORY_RECOMMENDATIONS_REPORT',
  ])

  fastify.post<{ Params: { reportType: string } }>(
    '/test-report/:reportType',
    async (request, reply) => {
      try {
        const { reportType } = request.params
        if (!ALLOWED_REPORT_TYPES.has(reportType)) {
          return reply.code(400).send({
            success: false,
            error: `Unknown reportType. Allowed: ${[...ALLOWED_REPORT_TYPES].join(', ')}`,
          })
        }
        if (!amazonService.isConfigured()) {
          return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
        }
        const marketplaceId = process.env.AMAZON_MARKETPLACE_ID ?? 'APJ6JRA9NG5V4'
        const sp = await (amazonService as any).getClient()

        fastify.log.info({ reportType, marketplaceId }, '[test-report] requesting report')

        const res: any = await sp.callAPI({
          operation: 'createReport',
          endpoint: 'reports',
          version: '2021-06-30',
          body: {
            reportType,
            marketplaceIds: [marketplaceId],
          },
        })

        return {
          success: true,
          reportType,
          reportId: res.reportId,
          message: `Report requested. Poll status with GET /api/amazon/test-report-status/${res.reportId}`,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[test-report] failed')
        return reply.code(500).send({
          success: false,
          error: error?.message ?? String(error),
          code: error?.body?.errors?.[0]?.code ?? error?.code,
          details: error?.body ?? null,
        })
      }
    }
  )

  fastify.get<{ Params: { reportId: string } }>(
    '/test-report-status/:reportId',
    async (request, reply) => {
      try {
        const { reportId } = request.params
        if (!amazonService.isConfigured()) {
          return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
        }

        const sp = await (amazonService as any).getClient()

        const status: any = await sp.callAPI({
          operation: 'getReport',
          endpoint: 'reports',
          version: '2021-06-30',
          path: { reportId },
        })

        if (status.processingStatus !== 'DONE') {
          return {
            reportId,
            processingStatus: status.processingStatus,
            createdTime: status.createdTime,
            processingStartTime: status.processingStartTime,
          }
        }

        const docMeta: any = await sp.callAPI({
          operation: 'getReportDocument',
          endpoint: 'reports',
          version: '2021-06-30',
          path: { reportDocumentId: status.reportDocumentId },
        })

        // Download the document — Amazon merchant listings reports are TSV,
        // sometimes gzip-compressed. We need to handle the compressionAlgorithm field.
        const docResp = await fetch(docMeta.url)
        if (!docResp.ok) {
          return reply.code(502).send({
            success: false,
            error: `Failed to download report document: HTTP ${docResp.status}`,
          })
        }

        let text: string
        if (docMeta.compressionAlgorithm === 'GZIP') {
          const buf = Buffer.from(await docResp.arrayBuffer())
          const { gunzipSync } = await import('node:zlib')
          text = gunzipSync(buf).toString('utf8')
        } else {
          text = await docResp.text()
        }

        const lines = text.split(/\r?\n/)
        const header = lines[0] ?? ''
        const sampleRows = lines.slice(0, 6)

        // Highlight any column that looks like it could carry parent/child info
        const hierarchyHints: string[] = []
        const headerCols = header.split('\t')
        for (const col of headerCols) {
          const lc = col.toLowerCase()
          if (
            lc.includes('parent') ||
            lc.includes('relationship') ||
            lc.includes('variation') ||
            lc.includes('asin') ||
            lc.includes('sku')
          ) {
            hierarchyHints.push(col)
          }
        }

        return {
          status: 'DONE',
          reportId,
          reportDocumentId: status.reportDocumentId,
          documentUrlExpiry: docMeta.url ? '(short-lived)' : null,
          compressionAlgorithm: docMeta.compressionAlgorithm ?? null,
          totalRows: lines.length - 1,
          headerRaw: header,
          headerColumns: headerCols,
          hierarchyHints,
          sampleRows,
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[test-report-status] failed')
        return reply.code(500).send({
          success: false,
          error: error?.message ?? String(error),
          code: error?.body?.errors?.[0]?.code ?? error?.code,
          details: error?.body ?? null,
        })
      }
    }
  )

  // ────────────────────────────────────────────────────────────────────────
  // GET /api/amazon/analyze-report/:reportId
  //
  // Downloads an already-generated merchant-listings TSV and probes whether
  // any column secretly carries parent/child info: are there repeating
  // values in asin1/2/3 (suggesting a parent ASIN)?  Any duplicate seller-skus
  // (none expected, but useful as a sanity check).  Detects SKU naming
  // patterns like {prefix}-{size} that imply hierarchy.
  //
  // Response is intentionally compact so it fits in one screen.
  // ────────────────────────────────────────────────────────────────────────
  fastify.get<{ Params: { reportId: string } }>(
    '/analyze-report/:reportId',
    async (request, reply) => {
      try {
        const { reportId } = request.params
        if (!amazonService.isConfigured()) {
          return reply.code(503).send({ success: false, error: 'Amazon SP-API not configured' })
        }
        const sp = await (amazonService as any).getClient()

        const status: any = await sp.callAPI({
          operation: 'getReport',
          endpoint: 'reports',
          version: '2021-06-30',
          path: { reportId },
        })

        if (status.processingStatus !== 'DONE') {
          return reply
            .code(409)
            .send({ success: false, error: `Report not DONE (${status.processingStatus})` })
        }

        const docMeta: any = await sp.callAPI({
          operation: 'getReportDocument',
          endpoint: 'reports',
          version: '2021-06-30',
          path: { reportDocumentId: status.reportDocumentId },
        })
        const docResp = await fetch(docMeta.url)
        if (!docResp.ok) {
          return reply
            .code(502)
            .send({ success: false, error: `Failed to download document: HTTP ${docResp.status}` })
        }

        let text: string
        if (docMeta.compressionAlgorithm === 'GZIP') {
          const buf = Buffer.from(await docResp.arrayBuffer())
          const { gunzipSync } = await import('node:zlib')
          text = gunzipSync(buf).toString('utf8')
        } else {
          text = await docResp.text()
        }

        const lines = text.split(/\r?\n/).filter((l) => l.length > 0)
        const header = lines[0].split('\t')
        const dataRows = lines.slice(1)

        const colIdx = (name: string) => header.findIndex((h) => h.toLowerCase() === name.toLowerCase())
        const skuIdx = colIdx('seller-sku')
        const asin1Idx = colIdx('asin1')
        const asin2Idx = colIdx('asin2')
        const asin3Idx = colIdx('asin3')

        const allCols: string[][] = header.map(() => [])
        for (const row of dataRows) {
          const cells = row.split('\t')
          for (let i = 0; i < header.length; i++) allCols[i].push((cells[i] ?? '').trim())
        }

        const summarizeCol = (idx: number) => {
          if (idx < 0) return null
          const vals = allCols[idx]
          const nonEmpty = vals.filter((v) => v !== '')
          const unique = new Set(nonEmpty)
          // Count duplicates (values that appear more than once)
          const counts = new Map<string, number>()
          for (const v of nonEmpty) counts.set(v, (counts.get(v) ?? 0) + 1)
          const dups = [...counts.entries()].filter(([, c]) => c > 1)
          return {
            column: header[idx],
            totalRows: vals.length,
            nonEmpty: nonEmpty.length,
            empty: vals.length - nonEmpty.length,
            unique: unique.size,
            duplicateValueCount: dups.length,
            sampleDuplicates: dups
              .sort((a, b) => b[1] - a[1])
              .slice(0, 5)
              .map(([v, c]) => ({ value: v, count: c })),
          }
        }

        // SKU naming pattern analysis
        const skus = skuIdx >= 0 ? allCols[skuIdx] : []
        const sizeSuffixRe = /[-_](xxs|xs|s|m|l|xl|xxl|xxxl|3xl|4xl|5xl|6xl|one-?size|\d{2,3})$/i
        const skuPrefixGroups = new Map<string, string[]>()
        for (const sku of skus) {
          const m = sku.match(sizeSuffixRe)
          if (!m) continue
          const prefix = sku.slice(0, sku.length - m[0].length)
          const arr = skuPrefixGroups.get(prefix) ?? []
          arr.push(sku)
          skuPrefixGroups.set(prefix, arr)
        }
        const groupsWithMultipleVariants = [...skuPrefixGroups.entries()]
          .filter(([, arr]) => arr.length >= 2)
          .sort((a, b) => b[1].length - a[1].length)

        return {
          reportId,
          reportType: status.reportType,
          rowCount: dataRows.length,
          columns: header,
          asinAnalysis: {
            asin1: summarizeCol(asin1Idx),
            asin2: summarizeCol(asin2Idx),
            asin3: summarizeCol(asin3Idx),
          },
          skuAnalysis: summarizeCol(skuIdx),
          skuPatternAnalysis: {
            groupsDetected: skuPrefixGroups.size,
            groupsWithMultipleVariants: groupsWithMultipleVariants.length,
            top10Groups: groupsWithMultipleVariants.slice(0, 10).map(([prefix, arr]) => ({
              prefix,
              variantCount: arr.length,
              sampleSkus: arr.slice(0, 5),
            })),
          },
          verdict: (() => {
            const a2 = summarizeCol(asin2Idx)
            const a3 = summarizeCol(asin3Idx)
            if (a2 && a2.duplicateValueCount > 0) {
              return `asin2 has ${a2.duplicateValueCount} repeating values — likely PARENT ASIN.`
            }
            if (a3 && a3.duplicateValueCount > 0) {
              return `asin3 has ${a3.duplicateValueCount} repeating values — likely PARENT ASIN.`
            }
            if (a2 && a2.nonEmpty === 0 && a3 && a3.nonEmpty === 0) {
              return 'asin2 and asin3 are entirely empty — no parent info in this report. Use SKU patterns or manual merge.'
            }
            return 'Inconclusive — inspect asinAnalysis manually.'
          })(),
        }
      } catch (error: any) {
        fastify.log.error({ err: error }, '[analyze-report] failed')
        return reply.code(500).send({
          success: false,
          error: error?.message ?? String(error),
          code: error?.body?.errors?.[0]?.code ?? error?.code,
        })
      }
    }
  )

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
  // POST /api/amazon/products/detect-variations
  //
  // Dry-run preview ONLY. Runs the variation parser against the live DB
  // and returns the inferred grouping plan WITHOUT touching anything.
  // Use this to validate detection before calling /auto-group.
  //
  // Output includes per-child structured variations like:
  //   { "Body Type": "Uomo", "Color": "Nero", "Size": "M" }
  // ────────────────────────────────────────────────────────────────────────
  fastify.post('/products/detect-variations', async (_request, reply) => {
    try {
      const products = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        select: { id: true, sku: true, name: true, amazonAsin: true, totalStock: true },
      })

      const groups = detectGroups(products as ProductLite[])

      const totalChildren = groups.reduce((s, g) => s + g.children.length, 0)
      const matchedGroups = groups.filter((g) => g.parentProduct !== null)
      const orphanGroups = groups.filter((g) => g.parentProduct === null)

      // Theme histogram (which themes show up and how often)
      const themeHistogram: Record<string, number> = {}
      for (const g of groups) {
        const theme = g.attributeNames.join(' / ')
        themeHistogram[theme] = (themeHistogram[theme] ?? 0) + 1
      }

      return {
        dryRun: true,
        summary: {
          totalAmazonProducts: products.length,
          groupsDetected: groups.length,
          groupsWithExistingParent: matchedGroups.length,
          orphanGroups: orphanGroups.length,
          totalChildren,
          themeHistogram,
        },
        // Top 20 by size, with sample child variations
        plan: groups.slice(0, 20).map((g) => ({
          baseName: g.baseName,
          parentSku: g.parentProduct?.sku ?? null,
          parentExists: g.parentProduct !== null,
          attributeNames: g.attributeNames,
          variationTheme: g.attributeNames.join(' / '),
          childCount: g.children.length,
          sampleChildren: g.children.slice(0, 5).map((c) => ({
            sku: c.product.sku,
            variations: c.variations,
          })),
        })),
        orphanGroupSamples: orphanGroups.slice(0, 5).map((g) => ({
          baseName: g.baseName.slice(0, 120),
          attributeNames: g.attributeNames,
          childCount: g.children.length,
          sampleSkus: g.children.slice(0, 3).map((c) => c.product.sku),
        })),
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[detect-variations] failed')
      return reply.code(500).send({
        success: false,
        error: error?.message ?? String(error),
      })
    }
  })

  // ────────────────────────────────────────────────────────────────────────
  // POST /api/amazon/products/auto-group
  //
  // Builds parent/child hierarchy by parsing product names. Variation
  // children are titled identically to the parent + " (attr1, attr2, …)"
  // appended at the end. The variation-parser service classifies each
  // attribute position by majority-vote on values across siblings:
  //   {S,M,L,XL} → "Size"
  //   {Uomo,Donna} → "Body Type"
  //   {Nero,Bianco} → "Color"
  //   {Pelle,Rete} → "Material"
  // Themes can be 1, 2, or 3+ dimensions, e.g. "Body Type / Color / Size".
  //
  // Each child gets its structured variations written to
  // categoryAttributes.variations as { "Body Type": "Uomo", "Color": "Nero",
  // "Size": "M" } so the UI can render per-attribute badges.
  //
  // Query params:
  //   ?dryRun=1   → preview the plan without writing
  //   ?reset=1    → clear existing parentId / isParent first
  // ────────────────────────────────────────────────────────────────────────
  fastify.post('/products/auto-group', async (request, reply) => {
    try {
      const q = request.query as { dryRun?: string; reset?: string }
      const dryRun = q.dryRun === '1' || q.dryRun === 'true'
      const reset = q.reset === '1' || q.reset === 'true'

      if (reset && !dryRun) {
        await prisma.product.updateMany({
          where: { parentId: { not: null } },
          data: { parentId: null, parentAsin: null },
        })
        await prisma.product.updateMany({
          where: { isParent: true },
          data: { isParent: false, variationTheme: null },
        })
      }

      const products = await prisma.product.findMany({
        where: { syncChannels: { has: 'AMAZON' } },
        select: {
          id: true,
          sku: true,
          name: true,
          amazonAsin: true,
          totalStock: true,
          categoryAttributes: true,
        },
      })

      const groups = detectGroups(
        products.map((p) => ({
          id: p.id,
          sku: p.sku,
          name: p.name,
          amazonAsin: p.amazonAsin,
          totalStock: p.totalStock,
        }))
      )

      // Only groups with an existing parent product are auto-applied.
      // Orphan groups (no parent record in DB) are surfaced for manual handling.
      const applicable = groups.filter((g) => g.parentProduct !== null)

      const planView = applicable.map((g) => ({
        baseName: g.baseName,
        parentSku: g.parentProduct!.sku,
        parentId: g.parentProduct!.id,
        parentAsin: g.parentProduct!.amazonAsin,
        attributeNames: g.attributeNames,
        variationTheme: g.attributeNames.join(' / '),
        childCount: g.children.length,
        sampleChildren: g.children.slice(0, 5).map((c) => ({
          sku: c.product.sku,
          variations: c.variations,
        })),
      }))

      const totalChildren = applicable.reduce((s, g) => s + g.children.length, 0)
      const orphanCount = groups.length - applicable.length

      if (dryRun) {
        return {
          dryRun: true,
          summary: {
            totalProducts: products.length,
            groupsDetected: groups.length,
            groupsApplicable: applicable.length,
            orphanGroups: orphanCount,
            childrenToLink: totalChildren,
          },
          plan: planView,
        }
      }

      // Apply
      let parentsUpdated = 0
      let childrenLinked = 0
      for (const g of applicable) {
        const parentId = g.parentProduct!.id
        const parentAsin = g.parentProduct!.amazonAsin
        const theme = g.attributeNames.join(' / ')

        await prisma.product.update({
          where: { id: parentId },
          data: { isParent: true, variationTheme: theme },
        })
        parentsUpdated++

        // Per-child update — categoryAttributes.variations needs a per-child
        // value, so we can't use updateMany.
        for (const child of g.children) {
          // Preserve any existing categoryAttributes keys other than 'variations'
          const existing = (child.product as any).categoryAttributes
          const existingObj =
            existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}
          const newAttrs = { ...existingObj, variations: child.variations }

          await prisma.product.update({
            where: { id: child.product.id },
            data: {
              parentId,
              parentAsin,
              isParent: false,
              variationTheme: theme,
              categoryAttributes: newAttrs,
            },
          })
          childrenLinked++
        }
      }

      // Roll up child stock to parents
      for (const g of applicable) {
        const children = await prisma.product.findMany({
          where: { parentId: g.parentProduct!.id },
          select: { totalStock: true },
        })
        const totalStock = children.reduce((s, c) => s + (c.totalStock ?? 0), 0)
        await prisma.product.update({
          where: { id: g.parentProduct!.id },
          data: { totalStock },
        })
      }

      return {
        applied: true,
        summary: {
          parentsUpdated,
          childrenLinked,
          groupsApplied: applicable.length,
          orphanGroups: orphanCount,
        },
        plan: planView,
      }
    } catch (error: any) {
      fastify.log.error({ err: error }, '[auto-group] failed')
      return reply.code(500).send({
        success: false,
        error: error?.message ?? String(error),
        code: error?.code,
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
}

export default amazonRoutes
