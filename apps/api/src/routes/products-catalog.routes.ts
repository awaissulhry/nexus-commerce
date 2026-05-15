import type { FastifyPluginAsync } from 'fastify'
import prisma from '../db.js'
import { masterPriceService } from '../services/master-price.service.js'
import { masterStatusService } from '../services/master-status.service.js'
import { applyStockMovement } from '../services/stock-movement.service.js'
import { enqueueContentSyncForProduct } from '../services/content-auto-publish.service.js'
import { listEtag, matches } from '../utils/list-etag.js'
import { computeLocaleCompleteness } from '../services/translation-completeness.service.js'
import { deriveSyncStatus, ACTIVE_CHANNELS } from '../services/sync-status.service.js'

// ─────────────────────────────────────────────────────────────────────
// PRODUCTS REBUILD C.2 — catalog browse extensions
//
// Facets        GET  /api/products/facets        distinct productTypes,
//                                                brands, fulfillment for
//                                                filter chips
// Health        GET  /api/products/:id/health    photos + listings + sync
// Tags          GET  /api/tags                   list + per-product counts
//               POST /api/tags
//               PATCH /api/tags/:id
//               DELETE /api/tags/:id
//               POST /api/products/:id/tags      attach
//               DELETE /api/products/:id/tags/:tagId
//               POST /api/products/bulk-tag      attach to N products
// Bundles       GET  /api/bundles                list with components
//               POST /api/bundles
//               GET  /api/bundles/:id
//               PATCH /api/bundles/:id
//               DELETE /api/bundles/:id
// Saved views   GET  /api/saved-views?surface=products
//               POST /api/saved-views
//               PATCH /api/saved-views/:id
//               DELETE /api/saved-views/:id
//               POST /api/saved-views/:id/set-default
// ─────────────────────────────────────────────────────────────────────

// Single-tenant: derive a stable userId from the request. When auth lands
// this becomes req.user.id. For now everyone shares "default-user".
function userIdFor(_req: any): string {
  return 'default-user'
}

const productsCatalogRoutes: FastifyPluginAsync = async (fastify) => {
  // ═══════════════════════════════════════════════════════════════════
  // FACETS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/products/facets', async (request, reply) => {
    try {
      // Phase 10b ETag — facets are read by every page load + every
      // filter sidebar mount. The aggregate counts move slowly; the
      // 304 collapses repeat polls to ~50 bytes. Use Product as the
      // dominant freshness signal (most facets come from Product
      // table); ChannelListing-derived `marketplaces` accept up to
      // a Product write of staleness, which the existing 60s
      // Cache-Control already permits.
      const { etag } = await listEtag(prisma, {
        model: 'product',
        filterContext: { kind: 'facets' },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=60')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }
      // F.1 — facets reflect only active (non-soft-deleted) products.
      // The recycle-bin lens shows its own row count separately.
      const [productTypes, brands, fulfillment, statusCounts, marketplaceCounts, marketplaceLookup, channelCounts, hygieneCounts, families, unfamiliedCount, workflowStages, unstagedCount] = await Promise.all([
        prisma.product.groupBy({
          by: ['productType'],
          where: { parentId: null, productType: { not: null }, deletedAt: null },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['brand'],
          where: { parentId: null, brand: { not: null }, deletedAt: null },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['fulfillmentMethod'],
          where: { parentId: null, fulfillmentMethod: { not: null }, deletedAt: null },
          _count: true,
        }),
        prisma.product.groupBy({
          by: ['status'],
          where: { parentId: null, deletedAt: null },
          _count: true,
        }),
        // E.5b — distinct (channel, marketplace) pairs in actual use, with
        // counts of how many ChannelListing rows live there. Single
        // groupBy on the indexed (channel, marketplace) tuple — fast even
        // at 16K+ listing rows.
        prisma.channelListing.groupBy({
          by: ['channel', 'marketplace'],
          _count: true,
        }),
        // Static reference: per-marketplace human label + region. Small
        // table (~17 rows post-seed); cached at the facet response level.
        prisma.marketplace.findMany({
          where: { isActive: true },
          select: { channel: true, code: true, name: true, region: true },
        }),
        // Catalog hygiene rollup — counts of top-level products missing
        // each hygiene-relevant field. Drives the filter sidebar's
        // "234 missing description" hint. Single $queryRaw beats four
        // separate Prisma counts (the latter would each run their own
        // index scan; this one fuses them into a single FILTER pass).
        // P2 #20 — channel counts via unnest of syncChannels[]. One
        // row per (channel, count) so the /products Channels filter
        // can render "AMAZON (3,200)" inline. Top-level products
        // only — children inherit syncChannels from their parent.
        prisma.$queryRaw<Array<{ channel: string; count: bigint }>>`
          SELECT unnest("syncChannels") AS channel, count(*)::bigint AS count
          FROM "Product"
          WHERE "parentId" IS NULL AND "deletedAt" IS NULL
          GROUP BY unnest("syncChannels")
          ORDER BY count DESC
        `,
        prisma.$queryRaw<Array<{
          total: bigint
          missing_photos: bigint
          missing_description: bigint
          missing_brand: bigint
          missing_gtin: bigint
        }>>`
          SELECT
            count(*)::bigint AS total,
            count(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM "Image" i WHERE i."productId" = p.id))::bigint AS missing_photos,
            count(*) FILTER (WHERE p.description IS NULL OR p.description = '')::bigint AS missing_description,
            count(*) FILTER (WHERE p.brand IS NULL OR p.brand = '')::bigint AS missing_brand,
            count(*) FILTER (WHERE p.gtin IS NULL OR p.gtin = '')::bigint AS missing_gtin
          FROM "Product" p
          WHERE p."parentId" IS NULL AND p."deletedAt" IS NULL
        `,
        // W2.12 — Family facet. groupBy familyId on top-level non-soft-deleted
        // rows; null bucket counted separately so the FilterBar can show
        // "no family yet (213)" alongside the per-family rows.
        prisma.product.groupBy({
          by: ['familyId'],
          where: { parentId: null, deletedAt: null, familyId: { not: null } },
          _count: true,
        }),
        prisma.product.count({
          where: { parentId: null, deletedAt: null, familyId: null },
        }),
        // W3.9 — Workflow stage facet. Same shape as families: the
        // null bucket counted separately so "products not on any
        // workflow yet (213)" surfaces alongside per-stage counts.
        prisma.product.groupBy({
          by: ['workflowStageId'],
          where: { parentId: null, deletedAt: null, workflowStageId: { not: null } },
          _count: true,
        }),
        prisma.product.count({
          where: { parentId: null, deletedAt: null, workflowStageId: null },
        }),
      ])

      // W2.12 — fetch labels for the families that actually appear in
      // the facet rollup. Tiny secondary query (only families that have
      // products attached); cached behind the same ETag.
      const familyIds = families
        .map((f) => f.familyId)
        .filter((id): id is string => id !== null)
      const familyLookup = familyIds.length > 0
        ? await prisma.productFamily.findMany({
            where: { id: { in: familyIds } },
            select: { id: true, code: true, label: true },
          })
        : []
      const familyById = new Map(familyLookup.map((f) => [f.id, f]))

      // W3.9 — resolve labels for the workflow stages that appear
      // in the rollup. Joined with their workflow's label so the
      // FilterBar can show "Approved (Standard PIM)".
      const stageIds = workflowStages
        .map((s) => s.workflowStageId)
        .filter((id): id is string => id !== null)
      const stageLookup = stageIds.length > 0
        ? await prisma.workflowStage.findMany({
            where: { id: { in: stageIds } },
            select: {
              id: true,
              code: true,
              label: true,
              workflow: { select: { id: true, label: true } },
            },
          })
        : []
      const stageById = new Map(stageLookup.map((s) => [s.id, s]))

      const labelByKey = new Map(
        marketplaceLookup.map((m) => [`${m.channel}:${m.code}`, { name: m.name, region: m.region }]),
      )

      return {
        productTypes: productTypes
          .filter((p) => p.productType)
          .map((p) => ({ value: p.productType!, count: p._count }))
          .sort((a, b) => b.count - a.count),
        brands: brands
          .filter((b) => b.brand)
          .map((b) => ({ value: b.brand!, count: b._count }))
          .sort((a, b) => b.count - a.count),
        fulfillment: fulfillment
          .filter((f) => f.fulfillmentMethod)
          .map((f) => ({ value: f.fulfillmentMethod!, count: f._count })),
        statuses: statusCounts.map((s) => ({ value: s.status, count: s._count })),
        // P2 #20 — channel counts (top-level products with each
        // value in their syncChannels[] array). One row per channel
        // sorted by descending count.
        channels: channelCounts
          .filter((c) => c.channel)
          .map((c) => ({ value: c.channel, count: Number(c.count) })),
        // E.5b — facet shape mirrors the others: { value, count } plus
        // channel + label so the frontend can group/label without a
        // second roundtrip.
        marketplaces: marketplaceCounts
          .map((m) => {
            const meta = labelByKey.get(`${m.channel}:${m.marketplace}`)
            return {
              value: m.marketplace,
              channel: m.channel,
              label: meta?.name ?? `${m.channel} ${m.marketplace}`,
              region: meta?.region ?? null,
              count: m._count,
            }
          })
          .sort((a, b) => b.count - a.count),
        hygiene: {
          total: Number(hygieneCounts[0]?.total ?? 0),
          missingPhotos: Number(hygieneCounts[0]?.missing_photos ?? 0),
          missingDescription: Number(hygieneCounts[0]?.missing_description ?? 0),
          missingBrand: Number(hygieneCounts[0]?.missing_brand ?? 0),
          missingGtin: Number(hygieneCounts[0]?.missing_gtin ?? 0),
        },
        // W2.12 — Family facet. Per-family count + an "unfamilied"
        // row first so the operator can quickly find the backlog of
        // products that haven't been categorised yet.
        families: [
          {
            value: 'null',
            label: 'No family',
            code: null,
            count: unfamiliedCount,
          } as const,
          ...families
            .filter((f) => f.familyId !== null)
            .map((f) => {
              const meta = familyById.get(f.familyId!)
              return {
                value: f.familyId!,
                label: meta?.label ?? f.familyId!,
                code: meta?.code ?? null,
                count: f._count,
              }
            })
            .sort((a, b) => b.count - a.count),
        ],
        // W3.9 — Workflow stage facet. Same shape: 'null' bucket
        // first ("products not on any workflow yet"), then per-stage
        // rows sorted by descending count. Each row's label includes
        // the workflow name in parentheses so the operator can
        // distinguish "Approved (Standard PIM)" from "Approved (B2B)".
        workflowStages: [
          {
            value: 'null',
            label: 'No workflow',
            workflowLabel: null,
            count: unstagedCount,
          } as const,
          ...workflowStages
            .filter((s) => s.workflowStageId !== null)
            .map((s) => {
              const meta = stageById.get(s.workflowStageId!)
              return {
                value: s.workflowStageId!,
                label: meta
                  ? `${meta.label} (${meta.workflow.label})`
                  : s.workflowStageId!,
                workflowLabel: meta?.workflow.label ?? null,
                count: s._count,
              }
            })
            .sort((a, b) => b.count - a.count),
        ],
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // HEALTH (per product)
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/products/:id/health', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      // Phase 10b ETag — health is polled aggressively (drawer + edit
      // page + status badges all read it). The score depends on the
      // product row + its image / listing counts, so the freshness key
      // tracks the product's updatedAt scoped by id.
      const { etag } = await listEtag(prisma, {
        model: 'product',
        where: { id },
        filterContext: { kind: 'health', id },
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }
      // P.6 — extended select. The /health endpoint is the drawer's only
      // data source today (it was meant to also serve the per-product
      // health badge, but the drawer reuses it as its master fetch).
      // The select below covers BOTH consumers:
      //   - Health badge: score, photoCount, channel/draft/error counts
      //   - Drawer: full master fields, channelListings details, images
      // _count adds translations + relationsFrom (only outgoing — the
      // RelatedTab counts both directions but the badge is "outgoing
      // relations from this product" which matches the operator's
      // mental model of "what does this product link out to").
      // Cast to any after findUnique because the local Prisma client
      // type inference doesn't pick up the select shape correctly under
      // the v6/v7 mismatch (see TECH_DEBT #45). Runtime returns
      // exactly the selected fields including _count, images, and
      // channelListings — the cast just unblocks the local typecheck.
      const p = (await prisma.product.findUnique({
        where: { id },
        select: {
          id: true, sku: true, name: true,
          basePrice: true, costPrice: true,
          totalStock: true, lowStockThreshold: true,
          description: true, bulletPoints: true, keywords: true,
          gtin: true, upc: true, ean: true, brand: true, productType: true,
          status: true, fulfillmentMethod: true,
          weightValue: true, weightUnit: true,
          isParent: true, parentId: true,
          amazonAsin: true, ebayItemId: true,
          createdAt: true, updatedAt: true, version: true,
          _count: {
            select: {
              images: true,
              channelListings: true,
              variations: true,
              translations: true,
              relationsFrom: true,
              // P.8 — count of child Products (parentId self-relation).
              // Drives the Variations tab badge in the drawer for
              // parent products. Distinct from `variations` which
              // counts the deprecated ProductVariation relation.
              children: true,
            },
          },
          images: {
            select: { url: true, type: true },
            orderBy: { createdAt: 'asc' },
          },
          channelListings: {
            select: {
              id: true, channel: true, marketplace: true, listingStatus: true,
              syncStatus: true, lastSyncStatus: true, lastSyncError: true,
              lastSyncedAt: true,
              isPublished: true, validationStatus: true, validationErrors: true,
              // F9 — drift signals. masterPrice/masterQuantity are
              // the snapshots Phase 13 maintains. Compared against
              // price/quantity, these tell us whether the listing has
              // diverged from the master (followMasterPrice=false +
              // values different = drift).
              price: true, masterPrice: true, followMasterPrice: true,
              quantity: true, masterQuantity: true, followMasterQuantity: true,
              externalListingId: true, title: true, description: true,
              platformAttributes: true,
            },
          },
        },
      })) as any
      if (!p) return reply.code(404).send({ error: 'Product not found' })

      // Build a list of issues with severity
      const issues: Array<{ severity: 'error' | 'warning' | 'info'; message: string; channel?: string; marketplace?: string }> = []

      // Master-data warnings
      if (!p.description) issues.push({ severity: 'warning', message: 'Missing description' })
      if (!p.bulletPoints || p.bulletPoints.length === 0) issues.push({ severity: 'warning', message: 'No bullet points' })
      if (!p.gtin && !p.upc && !p.ean) issues.push({ severity: 'warning', message: 'No GTIN/UPC/EAN' })
      if (!p.brand) issues.push({ severity: 'info', message: 'No brand set' })
      if (!p.productType) issues.push({ severity: 'info', message: 'No productType set' })
      if (p._count.images === 0) issues.push({ severity: 'error', message: 'No images uploaded' })
      else if (p._count.images < 3) issues.push({ severity: 'warning', message: `Only ${p._count.images} image(s) — channels typically require 3+` })

      // Stock warnings
      if (p.totalStock === 0) issues.push({ severity: 'error', message: 'Out of stock' })
      else if (p.totalStock <= p.lowStockThreshold) issues.push({ severity: 'warning', message: `Low stock (${p.totalStock} left)` })

      // Per-channel-listing issues
      let liveCount = 0, draftCount = 0, errorCount = 0
      for (const cl of p.channelListings) {
        if (cl.listingStatus === 'ACTIVE' && cl.isPublished) liveCount++
        else if (cl.listingStatus === 'DRAFT') draftCount++
        if (cl.listingStatus === 'ERROR' || cl.lastSyncStatus === 'FAILED' || cl.syncStatus === 'FAILED') {
          errorCount++
          issues.push({
            severity: 'error',
            message: cl.lastSyncError ?? `${cl.channel} sync failed`,
            channel: cl.channel,
            marketplace: cl.marketplace,
          })
        }
        if (cl.validationStatus === 'ERROR' && cl.validationErrors && cl.validationErrors.length > 0) {
          for (const ve of cl.validationErrors.slice(0, 3)) {
            issues.push({ severity: 'warning', message: ve, channel: cl.channel, marketplace: cl.marketplace })
          }
        }
      }

      // Composite score 0..100. Each error -10, each warning -3, each info -1, capped at 0.
      const score = Math.max(
        0,
        100 -
          issues.filter((i) => i.severity === 'error').length * 10 -
          issues.filter((i) => i.severity === 'warning').length * 3 -
          issues.filter((i) => i.severity === 'info').length * 1,
      )

      // P.6 — return shape extended for the drawer. Original health
      // badge consumers still get everything they had (productId, sku,
      // score, *Count fields, issues). Drawer additionally gets the
      // master product fields it was silently missing before this
      // commit — name, description, bullets, channelListings, images,
      // etc. were declared in the drawer's TS type but never returned
      // by this endpoint, so the drawer rendered empty Description /
      // Listings cards on every open. Now they populate.
      return {
        productId: p.id,
        // Backward-compat health-badge fields
        sku: p.sku,
        score,
        photoCount: p._count.images,
        channelCount: p._count.channelListings,
        variantCount: p._count.variations,
        translationCount: p._count.translations,
        relationCount: p._count.relationsFrom,
        liveCount,
        draftCount,
        errorCount,
        issues,
        // Master product fields the drawer needs
        id: p.id,
        name: p.name,
        basePrice: p.basePrice ? p.basePrice.toString() : null,
        costPrice: p.costPrice ? p.costPrice.toString() : null,
        totalStock: p.totalStock,
        lowStockThreshold: p.lowStockThreshold,
        description: p.description,
        bulletPoints: p.bulletPoints,
        keywords: p.keywords,
        gtin: p.gtin,
        upc: p.upc,
        ean: p.ean,
        brand: p.brand,
        productType: p.productType,
        status: p.status,
        fulfillmentMethod: p.fulfillmentMethod,
        weightValue: p.weightValue,
        weightUnit: p.weightUnit,
        isParent: p.isParent,
        parentId: p.parentId,
        amazonAsin: p.amazonAsin,
        ebayItemId: p.ebayItemId,
        createdAt: p.createdAt,
        updatedAt: p.updatedAt,
        version: p.version,
        // Mirror _count for the frontend's `data._count.X` access
        // pattern (the drawer's TS type expects this shape).
        _count: {
          images: p._count.images,
          channelListings: p._count.channelListings,
          variations: p._count.variations,
          translations: p._count.translations,
          relationsFrom: p._count.relationsFrom,
          children: p._count.children,
        },
        images: p.images,
        channelListings: p.channelListings,
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[products/:id/health] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // TAGS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/tags', async (_request, reply) => {
    try {
      const tags = await prisma.tag.findMany({
        orderBy: { name: 'asc' },
        include: { _count: { select: { products: true } } },
      })
      return {
        items: tags.map((t) => ({
          id: t.id,
          name: t.name,
          color: t.color,
          productCount: t._count.products,
          updatedAt: t.updatedAt,
        })),
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/tags', async (request, reply) => {
    try {
      const body = request.body as { name?: string; color?: string }
      if (!body.name?.trim()) return reply.code(400).send({ error: 'name required' })
      const tag = await prisma.tag.create({
        data: { name: body.name.trim(), color: body.color ?? null },
      })
      return tag
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'Tag name already exists' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.patch('/tags/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; color?: string }
      const tag = await prisma.tag.update({
        where: { id },
        data: { name: body.name, color: body.color ?? null },
      })
      return tag
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/tags/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.tag.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/:id/tags', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { tagIds?: string[] }
      const tagIds = Array.isArray(body.tagIds) ? body.tagIds : []
      for (const tagId of tagIds) {
        await prisma.productTag.upsert({
          where: { productId_tagId: { productId: id, tagId } },
          update: {},
          create: { productId: id, tagId },
        })
      }
      const current = await prisma.productTag.findMany({
        where: { productId: id },
        include: { tag: true },
      })
      return { tags: current.map((c) => c.tag) }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/products/:id/tags/:tagId', async (request, reply) => {
    try {
      const { id, tagId } = request.params as { id: string; tagId: string }
      await prisma.productTag.delete({
        where: { productId_tagId: { productId: id, tagId } },
      })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-tag', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[]; tagIds?: string[]; mode?: 'add' | 'remove' }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const tagIds = Array.isArray(body.tagIds) ? body.tagIds : []
      const mode = body.mode === 'remove' ? 'remove' : 'add'
      if (productIds.length === 0 || tagIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] + tagIds[] required' })
      }
      let touched = 0
      for (const productId of productIds) {
        for (const tagId of tagIds) {
          if (mode === 'add') {
            await prisma.productTag.upsert({
              where: { productId_tagId: { productId, tagId } },
              update: {},
              create: { productId, tagId },
            })
          } else {
            await prisma.productTag.deleteMany({
              where: { productId, tagId },
            })
          }
          touched++
        }
      }
      return { ok: true, mode, touched }
    } catch (err: any) {
      fastify.log.error({ err }, '[products/bulk-tag] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BUNDLES
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/bundles', async (_request, reply) => {
    try {
      const bundles = await prisma.bundle.findMany({
        include: {
          components: {
            include: {
              // No FK to Product on BundleComponent — fetch product details manually below
            } as any,
          },
        },
        orderBy: { updatedAt: 'desc' },
      })
      // Hydrate component products
      const allProductIds = new Set<string>()
      for (const b of bundles) {
        allProductIds.add(b.productId)
        for (const c of b.components) allProductIds.add(c.productId)
      }
      const productList = await prisma.product.findMany({
        where: { id: { in: Array.from(allProductIds) } },
        select: { id: true, sku: true, name: true, basePrice: true, totalStock: true },
      })
      const productMap = new Map(productList.map((p) => [p.id, p]))

      return {
        items: bundles.map((b) => ({
          id: b.id,
          productId: b.productId,
          name: b.name,
          description: b.description,
          isActive: b.isActive,
          computedCostCents: b.computedCostCents,
          wrapperProduct: productMap.get(b.productId) ?? null,
          components: b.components.map((c) => ({
            id: c.id,
            productId: c.productId,
            quantity: c.quantity,
            unitCostCents: c.unitCostCents,
            product: productMap.get(c.productId) ?? null,
          })),
          // Computed available stock = min over components of (stock / qty)
          availableStock: b.components.length === 0
            ? 0
            : Math.min(...b.components.map((c) => {
                const p = productMap.get(c.productId)
                return Math.floor((p?.totalStock ?? 0) / Math.max(1, c.quantity))
              })),
          createdAt: b.createdAt,
          updatedAt: b.updatedAt,
        })),
      }
    } catch (err: any) {
      fastify.log.error({ err }, '[bundles list] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/bundles', async (request, reply) => {
    try {
      const body = request.body as {
        productId?: string
        name?: string
        description?: string
        components?: Array<{ productId: string; quantity?: number; unitCostCents?: number }>
      }
      if (!body.productId || !body.name) return reply.code(400).send({ error: 'productId + name required' })
      const components = Array.isArray(body.components) ? body.components : []

      const bundle = await prisma.bundle.create({
        data: {
          productId: body.productId,
          name: body.name,
          description: body.description ?? null,
          components: {
            create: components.map((c) => ({
              productId: c.productId,
              quantity: c.quantity ?? 1,
              unitCostCents: c.unitCostCents ?? null,
            })),
          },
        },
        include: { components: true },
      })
      return bundle
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'Product is already a bundle' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get('/bundles/:id', async (request, reply) => {
    const { id } = request.params as { id: string }
    const bundle = await prisma.bundle.findUnique({
      where: { id },
      include: { components: true },
    })
    if (!bundle) return reply.code(404).send({ error: 'Bundle not found' })
    return bundle
  })

  fastify.patch('/bundles/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as {
        name?: string
        description?: string
        isActive?: boolean
        components?: Array<{ productId: string; quantity?: number; unitCostCents?: number }>
      }
      const updates: any = {}
      if (body.name != null) updates.name = body.name
      if (body.description != null) updates.description = body.description
      if (body.isActive != null) updates.isActive = body.isActive
      if (body.components) {
        // Replace components atomically
        await prisma.bundleComponent.deleteMany({ where: { bundleId: id } })
        updates.components = {
          create: body.components.map((c) => ({
            productId: c.productId,
            quantity: c.quantity ?? 1,
            unitCostCents: c.unitCostCents ?? null,
          })),
        }
      }
      const bundle = await prisma.bundle.update({
        where: { id },
        data: updates,
        include: { components: true },
      })
      return bundle
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/bundles/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      await prisma.bundle.delete({ where: { id } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // SAVED VIEWS
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/saved-views', async (request, reply) => {
    try {
      const q = request.query as { surface?: string }
      const userId = userIdFor(request)
      const views = await prisma.savedView.findMany({
        where: { userId, surface: q.surface ?? 'products' },
        orderBy: [{ isDefault: 'desc' }, { name: 'asc' }],
      })
      // P.3 — attach an alert summary per view so the SavedViewsButton
      // can show "Stockouts (2 alerts)" + a fired-recently dot. One
      // groupBy keeps it cheap (single round-trip, indexed by
      // savedViewId). No N+1.
      let alertSummary = new Map<
        string,
        { active: number; total: number; firedRecently: number }
      >()
      if (views.length > 0) {
        const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000)
        const rows = await prisma.savedViewAlert.findMany({
          where: { savedViewId: { in: views.map((v) => v.id) } },
          select: {
            savedViewId: true,
            isActive: true,
            lastFiredAt: true,
          },
        })
        for (const r of rows) {
          const cur = alertSummary.get(r.savedViewId) ?? {
            active: 0,
            total: 0,
            firedRecently: 0,
          }
          cur.total++
          if (r.isActive) cur.active++
          if (r.lastFiredAt && r.lastFiredAt >= since24h) cur.firedRecently++
          alertSummary.set(r.savedViewId, cur)
        }
      }
      const items = views.map((v) => ({
        ...v,
        alertSummary: alertSummary.get(v.id) ?? {
          active: 0,
          total: 0,
          firedRecently: 0,
        },
      }))
      return { items }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/saved-views', async (request, reply) => {
    try {
      const body = request.body as { name?: string; surface?: string; filters?: any; isDefault?: boolean }
      if (!body.name?.trim()) return reply.code(400).send({ error: 'name required' })
      const userId = userIdFor(request)
      // Setting isDefault clears the previous default for this (user, surface)
      if (body.isDefault) {
        await prisma.savedView.updateMany({
          where: { userId, surface: body.surface ?? 'products' },
          data: { isDefault: false },
        })
      }
      const view = await prisma.savedView.create({
        data: {
          userId,
          surface: body.surface ?? 'products',
          name: body.name.trim(),
          filters: body.filters ?? {},
          isDefault: !!body.isDefault,
        },
      })
      return view
    } catch (err: any) {
      if (err?.code === 'P2002') return reply.code(409).send({ error: 'A view with this name already exists' })
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.patch('/saved-views/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = request.body as { name?: string; filters?: any; isDefault?: boolean }
      const userId = userIdFor(request)
      const existing = await prisma.savedView.findFirst({ where: { id, userId } })
      if (!existing) return reply.code(404).send({ error: 'View not found' })
      if (body.isDefault) {
        await prisma.savedView.updateMany({
          where: { userId, surface: existing.surface, id: { not: id } },
          data: { isDefault: false },
        })
      }
      const view = await prisma.savedView.update({
        where: { id },
        data: {
          name: body.name ?? existing.name,
          filters: body.filters ?? (existing.filters as any),
          isDefault: body.isDefault ?? existing.isDefault,
        },
      })
      return view
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.delete('/saved-views/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const userId = userIdFor(request)
      await prisma.savedView.deleteMany({ where: { id, userId } })
      return { ok: true }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // BULK CATALOG ACTIONS — promote to parent / attach as child / set status
  // (Bulk publish to channels uses /api/listings/bulk-action which already
  // exists; this is for product-level actions.)
  // ═══════════════════════════════════════════════════════════════════
  /**
   * Commit 0 — route through MasterStatusService.
   *
   * Was: raw `prisma.product.updateMany` that silently bypassed the
   * cascade. Listings on Amazon/eBay stayed visible while the seller
   * had marked the products INACTIVE in Nexus — buyers placed orders
   * on rows the seller thought were off-shelf.
   *
   * Now: per-product call to `masterStatusService.update()` inside a
   * single outer `$transaction` so the whole batch is atomic, and
   * each call cascades to ChannelListing.listingStatus + enqueues an
   * OutboundSyncQueue STATUS_UPDATE row + writes an AuditLog. The
   * service auto-skips the post-commit BullMQ enqueue when ctx.tx is
   * supplied (would queue jobs against rolled-back rows otherwise) —
   * the cron drain (~60s) picks up PENDING rows from the DB, which is
   * the source of truth.
   *
   * Per-product errors (terminal listing states, missing rows,
   * etc.) are surfaced in errors[] so the caller's bulk-edit grid
   * can render per-row feedback. The outer tx still commits the
   * successful subset on partial failure — only an exception
   * thrown OUT of the callback rolls back.
   */
  fastify.post('/products/bulk-status', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[]; status?: string }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const status = (body.status ?? '').toUpperCase() as
        | 'ACTIVE'
        | 'DRAFT'
        | 'INACTIVE'
      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] required' })
      }
      if (!['ACTIVE', 'DRAFT', 'INACTIVE'].includes(status)) {
        return reply.code(400).send({ error: 'status must be ACTIVE | DRAFT | INACTIVE' })
      }
      const actor = userIdFor(request)

      const errors: Array<{ id: string; error: string }> = []
      let updated = 0
      let cascadedListings = 0
      const queuedSyncIds: string[] = []

      // Cap N to keep one transaction reasonable. With 50 products at
      // ~5 listings each we're at 250 ChannelListing updates per tx
      // — well within Postgres comfort.
      if (productIds.length > 200) {
        return reply.code(400).send({
          error: `max 200 products per bulk-status call (got ${productIds.length})`,
        })
      }

      await prisma.$transaction(async (tx) => {
        for (const id of productIds) {
          try {
            const r = await masterStatusService.update(id, status, {
              tx,
              actor,
              reason: 'bulk-status',
            })
            if (r.changed) {
              updated++
              cascadedListings += r.cascadedListingIds.length
              queuedSyncIds.push(...r.queuedSyncIds)
            }
          } catch (err) {
            errors.push({
              id,
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      })

      // Cron drain (~60s) picks up the OutboundSyncQueue PENDING rows
      // and pushes to channels. We don't fire BullMQ here because (a)
      // it'd be a separate detached await per queueId and (b) the cron
      // is the source of truth for retries anyway.
      return {
        ok: errors.length === 0,
        updated,
        cascadedListings,
        queuedSyncCount: queuedSyncIds.length,
        errors: errors.length > 0 ? errors : undefined,
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-duplicate', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[] }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      if (productIds.length === 0) return reply.code(400).send({ error: 'productIds[] required' })
      if (productIds.length > 50) return reply.code(400).send({ error: 'Max 50 duplicates per call' })
      const sources = await prisma.product.findMany({ where: { id: { in: productIds } } })
      const cloned = []
      for (const src of sources) {
        const stamp = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 4)}`
        cloned.push(
          await prisma.product.create({
            data: {
              sku: `${src.sku}-COPY-${stamp}`,
              name: `${src.name} (copy)`,
              basePrice: src.basePrice,
              totalStock: 0,
              status: 'DRAFT',
              brand: src.brand,
              productType: src.productType,
              fulfillmentMethod: src.fulfillmentMethod,
              description: src.description,
              bulletPoints: src.bulletPoints,
              keywords: src.keywords,
              categoryAttributes: (src.categoryAttributes as any) ?? null,
            },
          }),
        )
      }
      return { ok: true, created: cloned.length, products: cloned.map((c) => ({ id: c.id, sku: c.sku })) }
    } catch (err: any) {
      fastify.log.error({ err }, '[bulk-duplicate] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // PATCH /api/products/:id — small whitelisted update for inline
  // quick-edit cells in the Grid lens. Avoids re-using the heavy
  // /products/bulk endpoint which is geared at the bulk-operations grid.
  //
  // Phase 13c → P0/B4 — basePrice, totalStock, and direct-field
  // updates all run inside ONE outer $transaction so a request like
  // { basePrice: 100, totalStock: 50, name: "X" } either commits
  // every change or rolls back every change. Previously each call
  // opened its own transaction; a failure on stock left the
  // already-committed basePrice + cascade visible to the next read.
  //
  //   basePrice  → MasterPriceService.update(..., { tx })
  //   totalStock → applyStockMovement({ ..., tx })  (B4 added tx support)
  //   other      → tx.product.update(...)
  //
  // BullMQ enqueue for cascade is suppressed when we pass tx into the
  // services — we add the jobs after the outer commit lands so we
  // never queue work for a transaction that may roll back.
  fastify.patch('/products/:id', async (request, reply) => {
    try {
      const { id } = request.params as { id: string }
      const body = (request.body ?? {}) as any
      const actor = userIdFor(request)
      const reason = 'inline-grid-edit'

      // Prefetch — confirm product exists once, get current totalStock for
      // the stock-delta computation, and surface a clean 404 before any
      // service call mutates anything.
      const current = await prisma.product.findUnique({
        where: { id },
        select: { id: true, totalStock: true, version: true },
      })
      if (!current) {
        return reply.code(404).send({ error: 'Product not found' })
      }

      // Commit 0 — optimistic concurrency. The caller may pass the
      // version they read with via If-Match header (preferred) or
      // body.expectedVersion (fallback for clients that can't set
      // headers). If supplied, we CAS-bump version inside the tx; on
      // mismatch we return 409 with the current version so the
      // client can refresh and retry. Without a hint the server
      // unconditionally bumps version so every successful PATCH
      // moves it forward — keeping the field useful as a freshness
      // signal even for callers that don't yet send If-Match.
      const ifMatch = request.headers['if-match']
      const headerVersion =
        typeof ifMatch === 'string' && /^\d+$/.test(ifMatch)
          ? Number(ifMatch)
          : undefined
      const bodyVersion =
        typeof body.expectedVersion === 'number' &&
        Number.isFinite(body.expectedVersion)
          ? Number(body.expectedVersion)
          : undefined
      const expectedVersion = headerVersion ?? bodyVersion

      // Validate basePrice up front so we fail fast outside the tx.
      let newBasePrice: number | undefined
      if (body.basePrice !== undefined) {
        const v = Number(body.basePrice)
        if (!Number.isFinite(v) || v < 0) {
          return reply
            .code(400)
            .send({ error: 'basePrice must be a non-negative number' })
        }
        newBasePrice = v
      }
      // Compute stock delta up front so the outer tx body is purely write.
      let stockDelta = 0
      if (body.totalStock !== undefined) {
        const newTotal = Math.max(0, Math.floor(Number(body.totalStock) || 0))
        stockDelta = newTotal - (current.totalStock ?? 0)
      }
      // Pre-collect direct field updates so the in-tx code is simple.
      const directFields = [
        'name',
        'lowStockThreshold',
        'status',
        'fulfillmentMethod',
        'brand',
        'productType',
        'description',
      ] as const
      const directData: any = {}
      let directDirty = false
      for (const k of directFields) {
        if (body[k] === undefined) continue
        if (k === 'lowStockThreshold') {
          directData[k] = Math.max(0, Math.floor(Number(body[k]) || 0))
        } else if (k === 'fulfillmentMethod') {
          directData[k] = body[k] || null
        } else {
          directData[k] = body[k]
        }
        directDirty = true
      }
      const hasMutations =
        newBasePrice !== undefined || stockDelta !== 0 || directDirty

      // No-op PATCH (empty body). Return the current state without bumping
      // version — caller may be polling with no actual change to write.
      if (!hasMutations) {
        return {
          id,
          version: current.version,
          basePrice: undefined,
          noop: true,
        }
      }

      // P0/B4 — single outer transaction. masterPriceService and
      // applyStockMovement both honour the supplied tx (and suppress
      // their post-commit BullMQ enqueue when given one — see service
      // docstrings). Version bump owns the lock so the field updates
      // below don't double-increment.
      try {
        await prisma.$transaction(async (tx) => {
          if (expectedVersion !== undefined) {
            // CAS version bump — Prisma throws P2025 if the row whose
            // (id, version) tuple we asked for doesn't exist. We catch
            // and rethrow as VERSION_CONFLICT so the outer handler can
            // map it to a 409 with the fresh version attached.
            try {
              await tx.product.update({
                where: { id, version: expectedVersion },
                data: { version: { increment: 1 } },
              })
            } catch (err: any) {
              if (err?.code === 'P2025') {
                throw Object.assign(
                  new Error(
                    'Product version mismatch — another change landed first',
                  ),
                  { code: 'VERSION_CONFLICT' },
                )
              }
              throw err
            }
          } else {
            // No CAS — still bump version so the field is a useful
            // freshness signal even for callers that don't send If-Match.
            await tx.product.update({
              where: { id },
              data: { version: { increment: 1 } },
            })
          }

          if (newBasePrice !== undefined) {
            await masterPriceService.update(id, newBasePrice, {
              actor,
              reason,
              tx,
            })
          }
          if (stockDelta !== 0) {
            await applyStockMovement({
              productId: id,
              change: stockDelta,
              reason: 'MANUAL_ADJUSTMENT',
              notes: 'inline grid edit',
              actor,
              tx,
            })
          }
          if (directDirty) {
            // Note: NO version increment here — version was bumped at the
            // top of the tx so this update is just the field changes.
            await tx.product.update({
              where: { id },
              data: directData,
            })
          }
        })
      } catch (err: any) {
        if (err?.code === 'VERSION_CONFLICT') {
          // Read the latest version so the client can refresh + retry.
          const latest = await prisma.product.findUnique({
            where: { id },
            select: { version: true, updatedAt: true },
          })
          return reply.code(409).send({
            error: err.message,
            code: 'VERSION_CONFLICT',
            expectedVersion,
            currentVersion: latest?.version ?? null,
            currentUpdatedAt: latest?.updatedAt?.toISOString() ?? null,
          })
        }
        throw err
      }

      // Return the post-update view. Single round-trip, fresh values,
      // matches the prior response shape so frontend callers don't
      // need to change.
      const updated = await prisma.product.findUnique({
        where: { id },
        select: {
          id: true,
          sku: true,
          name: true,
          basePrice: true,
          totalStock: true,
          lowStockThreshold: true,
          status: true,
          fulfillmentMethod: true,
          brand: true,
          productType: true,
          version: true,
          updatedAt: true,
        },
      })
      if (!updated) {
        // Edge case: product deleted between our prefetch and now.
        return reply.code(404).send({ error: 'Product not found' })
      }

      // Content auto-publish: if name or description changed, enqueue
      // FULL_SYNC for listings that follow master title and have auto-publish on.
      if (body.name !== undefined || body.description !== undefined) {
        void enqueueContentSyncForProduct(id)
      }

      return {
        ...updated,
        basePrice: Number(updated.basePrice),
      }
    } catch (err: any) {
      if (err?.code === 'P2025') return reply.code(404).send({ error: 'Product not found' })
      fastify.log.error({ err }, '[PATCH /products/:id] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // F3 — GET /api/products/:id/activity
  // Surfaces the AuditLog timeline for a product. Newest-first,
  // paginated, ETag-cached so the drawer's polling collapses to 304s
  // when nothing has happened.
  //
  // Filters AuditLog rows where entityType='Product' AND entityId=:id.
  // Returns slim before/after diffs (writers already trim to changed
  // fields per AuditLogService's contract) plus metadata + actor +
  // timestamp.
  fastify.get<{
    Params: { id: string }
    Querystring: { limit?: string; offset?: string }
  }>('/products/:id/activity', async (request, reply) => {
    try {
      const { id } = request.params
      const limit = Math.min(
        Math.max(parseInt(request.query.limit ?? '50', 10) || 50, 1),
        200,
      )
      const offset = Math.max(parseInt(request.query.offset ?? '0', 10) || 0, 0)

      // ETag: count + max(createdAt) for this entity. The listEtag
      // helper supports a custom timestamp field for AuditLog (which
      // has only createdAt — no updatedAt).
      const { etag } = await listEtag(prisma, {
        model: 'auditLog',
        where: { entityType: 'Product', entityId: id },
        filterContext: { kind: 'product-activity', id, limit, offset },
        timestampField: 'createdAt',
      })
      reply.header('ETag', etag)
      reply.header('Cache-Control', 'private, max-age=0, must-revalidate')
      if (matches(request, etag)) {
        return reply.code(304).send()
      }

      const [total, rows] = await Promise.all([
        prisma.auditLog.count({
          where: { entityType: 'Product', entityId: id },
        }),
        prisma.auditLog.findMany({
          where: { entityType: 'Product', entityId: id },
          orderBy: { createdAt: 'desc' },
          take: limit,
          skip: offset,
          select: {
            id: true,
            action: true,
            userId: true,
            before: true,
            after: true,
            metadata: true,
            createdAt: true,
          },
        }),
      ])
      return { total, items: rows }
    } catch (err: any) {
      fastify.log.error({ err }, '[products/:id/activity] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // POST /api/products/bulk-set-stock — set absolute totalStock for N
  // products (and/or update lowStockThreshold).
  //
  // P0/B3 — totalStock writes route through applyStockMovement so the
  // StockLevel ledger, ChannelListing cascade (Phase 13b), and audit
  // trail all fire. Previous direct prisma.product.updateMany() left
  // every channel listing's masterQuantity stale, never enqueued an
  // outbound sync, and never wrote a StockMovement audit row. At
  // scale that's silent inventory drift.
  //
  // lowStockThreshold has no cascade — direct updateMany is correct.
  // We separate the two paths so each takes the right route.
  //
  // Per-product partial failures (e.g. negative-stock guard rejecting
  // a single product) are surfaced via the errors[] array rather than
  // collapsing the whole request — the bulk-edit grid relies on this
  // to render per-cell error highlighting.
  fastify.post('/products/bulk-set-stock', async (request, reply) => {
    try {
      const body = request.body as {
        productIds?: string[]
        totalStock?: number
        lowStockThreshold?: number
      }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] required' })
      }
      const actor = userIdFor(request)
      const reason = 'bulk-set-stock'

      const errors: Array<{ id: string; field: string; error: string }> = []
      let stockUpdated = 0
      let thresholdUpdated = 0

      // Threshold path — atomic, cheap, no cascade.
      if (typeof body.lowStockThreshold === 'number') {
        const newThreshold = Math.max(0, Math.floor(body.lowStockThreshold))
        const r = await prisma.product.updateMany({
          where: { id: { in: productIds } },
          data: {
            lowStockThreshold: newThreshold,
            version: { increment: 1 },
          },
        })
        thresholdUpdated = r.count
      }

      // Stock path — one applyStockMovement per product so each gets a
      // StockMovement row + ChannelListing cascade. Read current totals
      // in one findMany; loop computes delta = newTotal - current and
      // skips no-ops. Fails per-product without aborting the batch.
      if (typeof body.totalStock === 'number') {
        const newTotal = Math.max(0, Math.floor(body.totalStock))
        const currentRows = await prisma.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, totalStock: true },
        })
        const currentByid = new Map(currentRows.map((r) => [r.id, r.totalStock ?? 0]))
        // Pre-flight: surface ids that don't exist as errors so callers
        // can highlight them rather than silently dropping.
        for (const id of productIds) {
          if (!currentByid.has(id)) {
            errors.push({ id, field: 'totalStock', error: 'Product not found' })
          }
        }
        for (const id of currentByid.keys()) {
          const current = currentByid.get(id) ?? 0
          const delta = newTotal - current
          if (delta === 0) {
            stockUpdated++ // count as "applied" — caller asked for newTotal, it already matches
            continue
          }
          try {
            await applyStockMovement({
              productId: id,
              change: delta,
              reason: 'MANUAL_ADJUSTMENT',
              notes: 'bulk-set-stock',
              actor,
            })
            stockUpdated++
          } catch (err) {
            errors.push({
              id,
              field: 'totalStock',
              error: err instanceof Error ? err.message : String(err),
            })
          }
        }
      }

      return {
        ok: errors.length === 0,
        updated: Math.max(stockUpdated, thresholdUpdated),
        stockUpdated,
        thresholdUpdated,
        errors: errors.length > 0 ? errors : undefined,
        reason,
      }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // F.1 — SOFT DELETE + RESTORE
  //
  // POST /api/products/bulk-soft-delete  body: { productIds: string[] }
  // POST /api/products/bulk-restore      body: { productIds: string[] }
  //
  // Soft-delete sets Product.deletedAt = now() on each id; restore
  // clears it back to null. Both write AuditLog rows so the recycle
  // bin has a who-deleted-when trail. Cascading channel teardown is
  // intentionally NOT triggered here — operators may restore within
  // minutes; we keep ChannelListings dormant rather than tearing
  // them down + needing to recreate. The hard-purge job
  // (jobs/purge-soft-deleted-products.job.ts) cleans up rows with
  // deletedAt > 30 days old; registered in cron-registry as
  // 'purge-soft-deleted-products'.
  //
  // Cap: 200 ids per call, mirroring bulk-status.
  // ═══════════════════════════════════════════════════════════════════
  const flipDeletedAt = async (
    productIds: string[],
    target: Date | null,
    request: any,
    reply: any,
  ) => {
    if (productIds.length === 0) {
      return reply.code(400).send({ error: 'productIds[] required' })
    }
    if (productIds.length > 200) {
      return reply.code(400).send({
        error: `max 200 products per call (got ${productIds.length})`,
      })
    }
    const actor = userIdFor(request)
    const action = target ? 'soft-delete' : 'restore'

    const result = await prisma.$transaction(async (tx) => {
      // Read the current state so the AuditLog before/after snapshot
      // captures what actually flipped (skips no-op rows where the
      // bin state already matches the target).
      const rows = await tx.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, sku: true, deletedAt: true },
      })
      const eligible = rows.filter((r) =>
        target ? r.deletedAt === null : r.deletedAt !== null,
      )
      if (eligible.length === 0) {
        return { changed: 0, skipped: rows.length }
      }
      const updated = await tx.product.updateMany({
        where: { id: { in: eligible.map((r) => r.id) } },
        data: { deletedAt: target },
      })
      // AuditLog one row per product so the recycle bin can render a
      // per-row "deleted by X at Y" footer cheaply.
      await tx.auditLog.createMany({
        data: eligible.map((r) => ({
          userId: actor,
          entityType: 'Product',
          entityId: r.id,
          action,
          before: { deletedAt: r.deletedAt?.toISOString() ?? null },
          after: { deletedAt: target?.toISOString() ?? null },
          metadata: { sku: r.sku, source: 'products-bulk' },
        })),
      })
      return { changed: updated.count, skipped: rows.length - updated.count }
    })

    return result
  }

  fastify.post('/products/bulk-soft-delete', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[] }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const r = await flipDeletedAt(productIds, new Date(), request, reply)
      // The helper sends its own 400 on validation; if we got here with
      // an undefined return, the reply is already mailed.
      if (r === undefined) return
      return { ok: true, ...r }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.post('/products/bulk-restore', async (request, reply) => {
    try {
      const body = request.body as { productIds?: string[] }
      const productIds = Array.isArray(body.productIds) ? body.productIds : []
      const r = await flipDeletedAt(productIds, null, request, reply)
      if (r === undefined) return
      return { ok: true, ...r }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // F.3 — SCHEDULED PRODUCT CHANGES
  //
  // POST /api/products/:id/scheduled-changes  body: { kind, payload, scheduledFor }
  // GET  /api/products/:id/scheduled-changes
  // POST /api/products/scheduled-changes/:id/cancel
  //
  // The cron worker (`scheduled-changes.cron.ts`, every 60s) picks
  // up PENDING rows whose scheduledFor <= now() and applies them
  // via the same master*Service.update path as live PATCHes.
  //
  // kind === 'STATUS': payload.status ∈ {ACTIVE, DRAFT, INACTIVE}
  // kind === 'PRICE':  payload.basePrice (absolute) OR
  //                    payload.adjustPercent (relative to current)
  //
  // Cancel = soft cancel: sets status=CANCELLED. The row stays in
  // the table for audit. Already-applied rows reject the cancel
  // with 409.
  // ═══════════════════════════════════════════════════════════════════
  fastify.post<{
    Params: { id: string }
    Body: {
      kind?: string
      payload?: Record<string, unknown>
      scheduledFor?: string
    }
  }>('/products/:id/scheduled-changes', async (request, reply) => {
    try {
      const productId = request.params.id
      const body = request.body ?? {}
      const kind = body.kind
      const payload = body.payload
      const scheduledForRaw = body.scheduledFor

      if (kind !== 'STATUS' && kind !== 'PRICE') {
        return reply
          .code(400)
          .send({ error: 'kind must be STATUS or PRICE' })
      }
      if (!payload || typeof payload !== 'object') {
        return reply.code(400).send({ error: 'payload (object) required' })
      }
      if (!scheduledForRaw) {
        return reply
          .code(400)
          .send({ error: 'scheduledFor (ISO timestamp) required' })
      }
      const scheduledFor = new Date(scheduledForRaw)
      if (Number.isNaN(scheduledFor.getTime())) {
        return reply
          .code(400)
          .send({ error: `scheduledFor not a valid date: ${scheduledForRaw}` })
      }
      if (scheduledFor.getTime() <= Date.now()) {
        return reply.code(400).send({
          error:
            'scheduledFor must be in the future (use the live PATCH endpoint to apply now)',
        })
      }

      // Validate payload shape per kind so we surface garbage at submit
      // time instead of cron-time.
      if (kind === 'STATUS') {
        const status = (payload as any).status
        if (!['ACTIVE', 'DRAFT', 'INACTIVE'].includes(status)) {
          return reply.code(400).send({
            error: 'STATUS payload.status must be ACTIVE | DRAFT | INACTIVE',
          })
        }
      } else if (kind === 'PRICE') {
        const { basePrice, adjustPercent } = payload as any
        const hasAbsolute =
          typeof basePrice === 'number' &&
          Number.isFinite(basePrice) &&
          basePrice >= 0
        const hasRelative =
          typeof adjustPercent === 'number' && Number.isFinite(adjustPercent)
        if (!hasAbsolute && !hasRelative) {
          return reply.code(400).send({
            error:
              'PRICE payload requires basePrice (number >= 0) or adjustPercent (number)',
          })
        }
      }

      const product = await prisma.product.findUnique({
        where: { id: productId },
        select: { id: true, deletedAt: true },
      })
      if (!product || product.deletedAt) {
        return reply
          .code(404)
          .send({ error: 'product not found or soft-deleted' })
      }

      const created = await prisma.scheduledProductChange.create({
        data: {
          productId,
          kind,
          payload: payload as any,
          scheduledFor,
          createdBy: userIdFor(request),
        },
      })
      return reply.code(201).send({ ok: true, change: created })
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  fastify.get<{ Params: { id: string } }>(
    '/products/:id/scheduled-changes',
    async (request, reply) => {
      try {
        const productId = request.params.id
        const rows = await prisma.scheduledProductChange.findMany({
          where: { productId },
          orderBy: [{ scheduledFor: 'asc' }, { createdAt: 'desc' }],
          take: 100,
        })
        return { ok: true, changes: rows }
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  fastify.post<{ Params: { id: string } }>(
    '/products/scheduled-changes/:id/cancel',
    async (request, reply) => {
      try {
        const id = request.params.id
        const row = await prisma.scheduledProductChange.findUnique({
          where: { id },
          select: { id: true, status: true },
        })
        if (!row) return reply.code(404).send({ error: 'not found' })
        if (row.status !== 'PENDING') {
          return reply.code(409).send({
            error: `cannot cancel — current status is ${row.status}`,
          })
        }
        const updated = await prisma.scheduledProductChange.update({
          where: { id },
          data: { status: 'CANCELLED' },
        })
        return { ok: true, change: updated }
      } catch (err: any) {
        return reply.code(500).send({ error: err?.message ?? String(err) })
      }
    },
  )

  // ═══════════════════════════════════════════════════════════════════
  // U.28 — BULK SET FIELD
  //
  // POST /api/products/bulk-set-field
  //   Body: { productIds, field, value }
  //
  // Generic single-field bulk update. Closes the loop the
  // HygieneStrip opens: operator filters to "missing brand", selects
  // the page, applies "Xavia" → 100 rows fixed in one shot.
  //
  // Whitelist of editable fields. Each entry maps to a Prisma field
  // and a value coercer; anything outside the whitelist returns 400.
  // Status / totalStock / basePrice are intentionally excluded — they
  // already have dedicated endpoints (bulk-status, bulk-set-stock,
  // master-price) that handle ChannelListing cascades + AuditLog +
  // outbound queue. This endpoint is for "plain field set" with no
  // downstream wiring.
  // ═══════════════════════════════════════════════════════════════════
  fastify.post('/products/bulk-set-field', async (request, reply) => {
    try {
      const body = request.body as {
        productIds?: string[]
        field?: string
        value?: string | number | null
      }
      const productIds = Array.isArray(body.productIds)
        ? body.productIds
        : []
      const field = body.field
      const rawValue = body.value
      if (productIds.length === 0) {
        return reply.code(400).send({ error: 'productIds[] required' })
      }
      if (productIds.length > 200) {
        return reply.code(400).send({
          error: `max 200 products per bulk-set-field call (got ${productIds.length})`,
        })
      }

      const fieldHandlers: Record<
        string,
        (v: unknown) => string | number | null
      > = {
        brand: (v) => {
          if (v === null || v === '' || v === undefined) return null
          if (typeof v !== 'string') throw new Error('brand must be string')
          return v.trim() || null
        },
        productType: (v) => {
          if (v === null || v === '' || v === undefined) return null
          if (typeof v !== 'string')
            throw new Error('productType must be string')
          return v.trim() || null
        },
        manufacturer: (v) => {
          if (v === null || v === '' || v === undefined) return null
          if (typeof v !== 'string')
            throw new Error('manufacturer must be string')
          return v.trim() || null
        },
        description: (v) => {
          if (v === null || v === undefined) return null
          if (typeof v !== 'string')
            throw new Error('description must be string')
          return v
        },
        fulfillmentMethod: (v) => {
          if (v === null || v === '' || v === undefined) return null
          if (v !== 'FBA' && v !== 'FBM')
            throw new Error('fulfillmentMethod must be FBA, FBM, or null')
          return v
        },
        lowStockThreshold: (v) => {
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            throw new Error('lowStockThreshold must be non-negative number')
          return Math.floor(v)
        },
        costPrice: (v) => {
          if (v === null || v === undefined) return null
          if (typeof v !== 'number' || !Number.isFinite(v) || v < 0)
            throw new Error('costPrice must be non-negative number or null')
          return Math.round(v * 100) / 100
        },
        minMargin: (v) => {
          if (v === null || v === undefined) return null
          if (typeof v !== 'number' || !Number.isFinite(v))
            throw new Error('minMargin must be number or null')
          return v
        },
      }
      if (!field || !(field in fieldHandlers)) {
        return reply.code(400).send({
          error: `field must be one of: ${Object.keys(fieldHandlers).join(', ')}`,
        })
      }

      let coerced: string | number | null
      try {
        coerced = fieldHandlers[field](rawValue)
      } catch (err) {
        return reply
          .code(400)
          .send({ error: err instanceof Error ? err.message : String(err) })
      }

      const actor = userIdFor(request)

      const result = await prisma.$transaction(async (tx) => {
        // Snapshot before-values for AuditLog diff per row.
        const rows = await tx.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, sku: true, [field]: true } as any,
        })
        const updated = await tx.product.updateMany({
          where: { id: { in: productIds } },
          data: {
            [field]: coerced as any,
            version: { increment: 1 },
          },
        })
        await tx.auditLog.createMany({
          data: rows.map((r: any) => ({
            userId: actor,
            entityType: 'Product',
            entityId: r.id,
            action: 'update',
            before: { [field]: r[field] ?? null },
            after: { [field]: coerced },
            metadata: { sku: r.sku, source: 'bulk-set-field' },
          })),
        })
        return { changed: updated.count, snapshotted: rows.length }
      })

      return { ok: true, ...result }
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })

  // ═══════════════════════════════════════════════════════════════════
  // COMMAND MATRIX — hierarchical catalog grid
  //
  // GET /api/products/command-matrix
  //
  // Returns master products (parentId=null) with their variant children
  // as `subRows`. Each node includes:
  //   - Core PIM fields (for inline editing parity with /bulk-operations)
  //   - locales: per-locale translation completion % (master only;
  //     variants get null so the grid renders "--")
  //   - channels: derived SyncStatus per active channel (AMAZON DE,
  //     EBAY UK, SHOPIFY); both master and variant rows get per-channel
  //     status; parents roll up on the client side
  // ═══════════════════════════════════════════════════════════════════
  fastify.get('/products/command-matrix', async (request, reply) => {
    try {
      const masters = await prisma.product.findMany({
        where: { parentId: null, deletedAt: null },
        orderBy: [{ updatedAt: 'desc' }],
        select: {
          id: true, sku: true, name: true,
          basePrice: true, totalStock: true, lowStockThreshold: true,
          status: true, isParent: true, parentId: true,
          brand: true, manufacturer: true,
          upc: true, ean: true, gtin: true,
          weightValue: true, weightUnit: true,
          dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
          fulfillmentMethod: true, productType: true,
          categoryAttributes: true,
          amazonAsin: true, ebayItemId: true,
          updatedAt: true,
          costPrice: true,
          minMargin: true,
          minPrice: true,
          maxPrice: true,
          images: {
            where: { type: 'MAIN' },
            select: { url: true },
            take: 1,
          },
          translations: {
            select: { language: true, name: true, description: true, bulletPoints: true },
          },
          channelListings: {
            select: {
              channel: true, region: true, marketplace: true,
              listingStatus: true, lastSyncStatus: true,
              isPublished: true,
              followMasterTitle: true, followMasterDescription: true,
              followMasterPrice: true, followMasterQuantity: true,
              followMasterImages: true, followMasterBulletPoints: true,
            },
          },
          children: {
            where: { deletedAt: null },
            orderBy: { sku: 'asc' },
            select: {
              id: true, sku: true, name: true,
              basePrice: true, totalStock: true, lowStockThreshold: true,
              status: true, isParent: true, parentId: true,
              brand: true, manufacturer: true,
              upc: true, ean: true, gtin: true,
              weightValue: true, weightUnit: true,
              dimLength: true, dimWidth: true, dimHeight: true, dimUnit: true,
              fulfillmentMethod: true, productType: true,
              categoryAttributes: true,
              amazonAsin: true, ebayItemId: true,
              updatedAt: true,
              costPrice: true,
              minMargin: true,
              minPrice: true,
              maxPrice: true,
              images: {
                where: { type: 'MAIN' },
                select: { url: true },
                take: 1,
              },
              // Variants don't have their own translations (masters own the content).
              channelListings: {
                select: {
                  channel: true, region: true, marketplace: true,
                  listingStatus: true, lastSyncStatus: true,
                  isPublished: true,
                  followMasterTitle: true, followMasterDescription: true,
                  followMasterPrice: true, followMasterQuantity: true,
                  followMasterImages: true, followMasterBulletPoints: true,
                },
              },
            },
          },
        },
      })

      function buildChannels(
        channelListings: Array<{
          channel: string; region: string; marketplace: string;
          listingStatus: string; lastSyncStatus: string | null;
          isPublished: boolean;
          followMasterTitle: boolean; followMasterDescription: boolean;
          followMasterPrice: boolean; followMasterQuantity: boolean;
          followMasterImages: boolean; followMasterBulletPoints: boolean;
        }>,
      ) {
        const result: Record<string, string> = {}
        for (const { key, channel, region } of ACTIVE_CHANNELS) {
          const listing = channelListings.find((cl) => {
            if (cl.channel !== channel) return false
            if (region === null) return true // Shopify: any region
            return cl.region === region || cl.marketplace === region
          })
          result[key] = listing ? deriveSyncStatus(listing) : 'UNLISTED'
        }
        return result
      }

      function shapeNode(
        p: any,
        isMaster: boolean,
        subRows?: any[],
      ) {
        return {
          id: p.id,
          isMaster,
          name: p.name,
          sku: p.sku,
          thumbnailUrl: p.images?.[0]?.url ?? null,
          // Core PIM fields (editor surface)
          basePrice: p.basePrice !== undefined ? Number(p.basePrice) : null,
          costPrice: p.costPrice !== undefined ? Number(p.costPrice) : null,
          minMargin: p.minMargin !== undefined ? Number(p.minMargin) : null,
          minPrice: p.minPrice !== undefined ? Number(p.minPrice) : null,
          maxPrice: p.maxPrice !== undefined ? Number(p.maxPrice) : null,
          totalStock: p.totalStock,
          lowStockThreshold: p.lowStockThreshold,
          status: p.status,
          isParent: p.isParent,
          parentId: p.parentId,
          brand: p.brand,
          manufacturer: p.manufacturer,
          upc: p.upc,
          ean: p.ean,
          gtin: p.gtin,
          weightValue: p.weightValue !== undefined && p.weightValue !== null ? Number(p.weightValue) : null,
          weightUnit: p.weightUnit,
          dimLength: p.dimLength !== undefined && p.dimLength !== null ? Number(p.dimLength) : null,
          dimWidth: p.dimWidth !== undefined && p.dimWidth !== null ? Number(p.dimWidth) : null,
          dimHeight: p.dimHeight !== undefined && p.dimHeight !== null ? Number(p.dimHeight) : null,
          dimUnit: p.dimUnit,
          fulfillmentChannel: p.fulfillmentMethod,
          productType: p.productType,
          categoryAttributes: p.categoryAttributes,
          amazonAsin: p.amazonAsin,
          ebayItemId: p.ebayItemId,
          updatedAt: p.updatedAt?.toISOString?.() ?? p.updatedAt,
          syncChannels: [],
          variantAttributes: null,
          // Matrix columns
          locales: isMaster
            ? computeLocaleCompleteness(p.translations ?? [])
            : null, // variants show '--' in locale columns
          channels: buildChannels(p.channelListings ?? []),
          subRows: subRows,
        }
      }

      const tree = masters.map((master) => {
        const variants = (master.children ?? []).map((child: any) =>
          shapeNode(child, false, undefined),
        )
        return shapeNode(master, true, variants.length > 0 ? variants : undefined)
      })

      return reply.send(tree)
    } catch (err: any) {
      fastify.log.error({ err }, '[GET /products/command-matrix] failed')
      return reply.code(500).send({ error: err?.message ?? String(err) })
    }
  })
}

export default productsCatalogRoutes
