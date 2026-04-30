import type { FastifyPluginAsync } from 'fastify'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
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

      // Fetch the batch of products that still lack hierarchy data
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

      for (const product of products) {
        try {
          const res: any = await sp.callAPI({
            operation: 'getCatalogItem',
            endpoint: 'catalogItems',
            path: { asin: product.amazonAsin },
            query: {
              marketplaceIds: [marketplaceId],
              includedData: ['relationships', 'summaries'],
            },
          })

          const relationships: any[] = res?.relationships ?? []

          for (const rel of relationships) {
            if (rel.type !== 'VARIATION') continue

            // This product is a CHILD — it has a parentAsin
            const parentAsins: string[] = rel.parentAsins ?? []
            if (parentAsins.length > 0) {
              const parentAsin = parentAsins[0]
              const variationTheme: string | null =
                rel.variationTheme?.name ?? rel.variationTheme?.attributes?.join('') ?? null

              // Find or create the parent product
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
                  ...(variationTheme ? { variationTheme } : {}),
                },
              })
              linked++
              break
            }

            // This product is a PARENT — it has childAsins
            const childAsins: string[] = rel.childAsins ?? []
            if (childAsins.length > 0) {
              await prisma.product.update({
                where: { id: product.id },
                data: { isParent: true },
              })
              break
            }
          }
        } catch (err) {
          fastify.log.warn(
            { asin: product.amazonAsin, err },
            '[Amazon] reindex-hierarchy: getCatalogItem failed, skipping'
          )
        }
      }

      // Update totalStock on any parents that gained children
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

      const remaining = await (prisma as any).product.count({
        where: { syncChannels: { has: 'AMAZON' }, amazonAsin: { not: null }, parentId: null, isParent: false },
      })

      return {
        success: true,
        done: remaining === 0,
        processed: products.length,
        linked,
        remaining,
        nextOffset: offset + limit,
      }
    } catch (error) {
      fastify.log.error({ err: error }, 'reindex-hierarchy failed')
      return reply.code(500).send({
        success: false,
        error: error instanceof Error ? error.message : 'Unknown error',
      })
    }
  })
}

export default amazonRoutes
