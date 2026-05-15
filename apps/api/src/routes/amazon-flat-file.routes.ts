/**
 * Amazon Flat-File Spreadsheet API
 *
 * Endpoints that power the /products/amazon-flat-file page:
 *
 *   GET  /api/amazon/flat-file/product-types    — known product types for marketplace
 *   GET  /api/amazon/flat-file/template         — column manifest from live schema
 *   GET  /api/amazon/flat-file/rows             — existing products as pre-filled rows
 *   POST /api/amazon/flat-file/submit           — rows → JSON_LISTINGS_FEED → feedId
 *   GET  /api/amazon/flat-file/feeds/:id        — poll feed status + processing report
 *   POST /api/amazon/flat-file/parse-tsv        — upload TSV → parsed rows
 *   POST /api/amazon/flat-file/translate-values — cross-market enum value mapping via AI
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import {
  AmazonFlatFileService,
  MARKETPLACE_ID_MAP,
} from '../services/amazon/flat-file.service.js'
import { translateEnumValues } from '../services/amazon/value-translate.service.js'
import { enqueueContentSyncIfEnabled } from '../services/content-auto-publish.service.js'
import { productEventService } from '../services/product-event.service.js'
import { runFlatFileAiInstruction } from '../services/flat-file-ai.service.js'

const amazon = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazon)
const flatFileService = new AmazonFlatFileService(prisma, schemaService)

function getSellerId(): string {
  return process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
}

function getSpClient() {
  const refreshToken = process.env.AMAZON_REFRESH_TOKEN
  const lwaClientId = process.env.AMAZON_LWA_CLIENT_ID
  const lwaClientSecret = process.env.AMAZON_LWA_CLIENT_SECRET
  if (!refreshToken || !lwaClientId || !lwaClientSecret) {
    throw new Error('Amazon SP-API credentials not configured')
  }
  return import('amazon-sp-api').then(({ SellingPartner }) =>
    new (SellingPartner as any)({
      region: (process.env.AMAZON_REGION ?? 'eu') as any,
      refresh_token: refreshToken,
      credentials: {
        SELLING_PARTNER_APP_CLIENT_ID: lwaClientId,
        SELLING_PARTNER_APP_CLIENT_SECRET: lwaClientSecret,
      },
      options: { auto_request_tokens: true, auto_request_throttled: true },
    }),
  )
}

export default async function amazonFlatFileRoutes(fastify: FastifyInstance) {
  // ── GET /api/amazon/flat-file/product-types ─────────────────────────
  // Returns every known Amazon product type for the given marketplace,
  // combining types cached in CategorySchema with types used on products.
  // No SP-API calls — DB-only, sub-10ms.
  fastify.get<{ Querystring: { marketplace?: string } }>(
    '/amazon/flat-file/product-types',
    async (request, reply) => {
      const mp = (request.query.marketplace ?? 'IT').toUpperCase()
      try {
        const [schemaRows, productRows] = await Promise.all([
          // Product types we've fetched a schema for on this marketplace
          prisma.categorySchema.findMany({
            where: { channel: 'AMAZON', marketplace: mp, isActive: true },
            select: { productType: true },
            distinct: ['productType'],
            orderBy: { productType: 'asc' },
          }),
          // Product types actually assigned to products in our catalog
          prisma.product.findMany({
            where: { deletedAt: null, productType: { not: null } },
            select: { productType: true },
            distinct: ['productType'],
          }),
        ])

        const seen = new Set<string>()
        const types: Array<{ value: string; source: 'schema' | 'catalog' | 'both' }> = []

        for (const r of schemaRows) {
          if (r.productType && !seen.has(r.productType)) {
            seen.add(r.productType)
            types.push({ value: r.productType, source: 'schema' })
          }
        }
        for (const r of productRows) {
          if (!r.productType) continue
          if (seen.has(r.productType)) {
            const existing = types.find((t) => t.value === r.productType)
            if (existing) existing.source = 'both'
          } else {
            seen.add(r.productType)
            types.push({ value: r.productType, source: 'catalog' })
          }
        }

        types.sort((a, b) => a.value.localeCompare(b.value))
        return reply.send({ marketplace: mp, types })
      } catch (err: any) {
        request.log.error(err, 'flat-file/product-types failed')
        return reply.code(500).send({ error: err?.message ?? 'Failed to load product types' })
      }
    },
  )

  // ── GET /api/amazon/flat-file/template ──────────────────────────────
  // Returns the column manifest for the requested marketplace + productType.
  // Fetches the schema live from SP-API on cache miss or when force=1.
  fastify.get<{
    Querystring: { marketplace?: string; productType?: string; force?: string }
  }>('/amazon/flat-file/template', async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
    const productType = (request.query.productType ?? '').toUpperCase()
    const force = request.query.force === '1'

    if (!productType) {
      return reply.code(400).send({ error: 'productType is required' })
    }

    try {
      const manifest = await flatFileService.generateManifest(
        marketplace,
        productType,
        force,
      )
      return reply.send(manifest)
    } catch (err: any) {
      request.log.error(err, 'flat-file/template failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to generate manifest' })
    }
  })

  // ── GET /api/amazon/flat-file/rows ──────────────────────────────────
  // Returns existing products pre-filled as flat file rows.
  fastify.get<{
    Querystring: { marketplace?: string; productType?: string; productId?: string }
  }>('/amazon/flat-file/rows', async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
    const productType = request.query.productType?.toUpperCase() ?? undefined
    const productId   = request.query.productId ?? undefined

    try {
      const rows = await flatFileService.getExistingRows(marketplace, productType, productId)
      return reply.send({ rows })
    } catch (err: any) {
      request.log.error(err, 'flat-file/rows failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to load rows' })
    }
  })

  // ── POST /api/amazon/flat-file/submit ───────────────────────────────
  // Accepts an array of rows, submits them as a JSON_LISTINGS_FEED to SP-API.
  fastify.post<{
    Body: { rows: any[]; marketplace?: string; expandedFields?: Record<string, string> }
  }>('/amazon/flat-file/submit', async (request, reply) => {
    const { rows, marketplace = 'IT', expandedFields = {} } = request.body
    const mp = marketplace.toUpperCase()
    const marketplaceId = MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
    const sellerId = getSellerId()

    if (!sellerId) {
      return reply.code(503).send({ error: 'AMAZON_SELLER_ID not configured' })
    }
    if (!rows || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be non-empty' })
    }
    if (rows.length > 2000) {
      return reply.code(400).send({ error: 'Max 2000 rows per submission' })
    }

    const dryRun = process.env.NEXUS_AMAZON_BATCH_DRYRUN === '1'
    if (dryRun) {
      return reply.send({
        feedId: `dryrun-flat-${Date.now()}`,
        feedDocumentId: `dryrun-doc-${Date.now()}`,
        messageCount: rows.length,
        dryRun: true,
      })
    }

    const body = flatFileService.buildJsonFeedBody(rows, mp, sellerId, expandedFields)

    try {
      const sp = await getSpClient()

      // Step 1: create feed document
      const docRes: any = await sp.callAPI({
        operation: 'createFeedDocument',
        endpoint: 'feeds',
        body: { contentType: 'application/json; charset=UTF-8' },
      })

      // Step 2: upload body
      const uploadRes = await fetch(docRes.url, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body,
      })
      if (!uploadRes.ok) {
        throw new Error(`Feed document upload failed: HTTP ${uploadRes.status}`)
      }

      // Step 3: create feed
      const feedRes: any = await sp.callAPI({
        operation: 'createFeed',
        endpoint: 'feeds',
        body: {
          feedType: 'JSON_LISTINGS_FEED',
          marketplaceIds: [marketplaceId],
          inputFeedDocumentId: docRes.feedDocumentId,
        },
      })

      return reply.send({
        feedId: feedRes.feedId,
        feedDocumentId: docRes.feedDocumentId,
        messageCount: rows.length,
        dryRun: false,
      })
    } catch (err: any) {
      request.log.error(err, 'flat-file/submit failed')
      return reply.code(500).send({ error: err?.message ?? 'Submission failed' })
    }
  })

  // ── GET /api/amazon/flat-file/feeds/:feedId ─────────────────────────
  // Polls feed status. When DONE, downloads and parses the processing report.
  fastify.get<{
    Params: { feedId: string }
  }>('/amazon/flat-file/feeds/:feedId', async (request, reply) => {
    const { feedId } = request.params
    const dryRun = process.env.NEXUS_AMAZON_BATCH_DRYRUN === '1'

    if (dryRun || feedId.startsWith('dryrun-')) {
      return reply.send({
        feedId,
        processingStatus: 'DONE',
        resultFeedDocumentId: null,
        results: [],
        dryRun: true,
      })
    }

    try {
      const sp = await getSpClient()

      const feedRes: any = await sp.callAPI({
        operation: 'getFeed',
        endpoint: 'feeds',
        path: { feedId },
      })

      const status: string = feedRes.processingStatus
      const resultDocId: string | null = feedRes.resultFeedDocumentId ?? null

      if (status !== 'DONE' || !resultDocId) {
        return reply.send({
          feedId,
          processingStatus: status,
          resultFeedDocumentId: resultDocId,
          results: [],
        })
      }

      // Download and parse the processing report
      const docRes: any = await sp.callAPI({
        operation: 'getFeedDocument',
        endpoint: 'feeds',
        path: { feedDocumentId: resultDocId },
      })

      let results: Array<{ sku: string; status: string; message: string }> = []
      try {
        const reportText = await fetch(docRes.url).then((r) => r.text())
        // Processing report is JSON: { processingReport: { processingStatus, messagesProcessed, messagesSuccessful, messagesWithError, rows: [...] } }
        const report = JSON.parse(reportText)
        const reportRows: any[] = report?.processingReport?.rows ?? report?.rows ?? []
        results = reportRows.map((r: any) => ({
          sku: r.sku ?? r.messageId ?? '',
          status: r.processingStatus === 'DONE' ? 'success' : 'error',
          message: r.issues?.map((i: any) => i.message).join('; ') ?? '',
        }))
      } catch {
        // Non-fatal — return status without per-row breakdown
      }

      return reply.send({
        feedId,
        processingStatus: status,
        resultFeedDocumentId: resultDocId,
        results,
      })
    } catch (err: any) {
      request.log.error(err, 'flat-file/feeds/:feedId failed')
      return reply.code(500).send({ error: err?.message ?? 'Status poll failed' })
    }
  })

  // ── POST /api/amazon/flat-file/parse-tsv ────────────────────────────
  // Parse an uploaded TSV flat file (Amazon format) into rows.
  fastify.post<{
    Body: { content: string; productType?: string; marketplace?: string }
  }>('/amazon/flat-file/parse-tsv', async (request, reply) => {
    const { content, productType = '', marketplace = 'IT' } = request.body
    if (!content || content.length === 0) {
      return reply.code(400).send({ error: 'content is required' })
    }
    if (content.length > 10_000_000) {
      return reply.code(400).send({ error: 'File too large (max 10 MB)' })
    }
    try {
      const rows = flatFileService.parseTsv(content, productType.toUpperCase())
      return reply.send({ rows, count: rows.length })
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'Parse failed' })
    }
  })

  // ── POST /api/amazon/flat-file/fetch-listings ───────────────────────
  // Pull live listing data from Amazon for a set of SKUs across one or more
  // marketplaces. Currently returns ASIN + listing status per SKU per market.
  // Uses the Listings Items API (2021-08-01).
  fastify.post<{
    Body: { skus: string[]; marketplaces: string[] }
  }>('/amazon/flat-file/fetch-listings', async (request, reply) => {
    const { skus, marketplaces } = request.body
    if (!skus?.length || !marketplaces?.length) {
      return reply.code(400).send({ error: 'skus and marketplaces are required' })
    }
    if (skus.length > 100) {
      return reply.code(400).send({ error: 'Max 100 SKUs per request' })
    }

    const sellerId = getSellerId()
    if (!sellerId) {
      return reply.code(503).send({ error: 'AMAZON_SELLER_ID not configured' })
    }

    const marketplaceIds = marketplaces
      .map((mp) => MARKETPLACE_ID_MAP[mp.toUpperCase()])
      .filter(Boolean)

    if (!marketplaceIds.length) {
      return reply.code(400).send({ error: 'No valid marketplace codes provided' })
    }

    try {
      const sp = await getSpClient()

      // Fetch each SKU in parallel — Listings Items API is per-SKU
      const settled = await Promise.allSettled(
        skus.map(async (sku) => {
          const res: any = await sp.callAPI({
            operation: 'getListingsItem',
            endpoint: 'listingsItems',
            path: { sellerId, sku: encodeURIComponent(sku) },
            query: {
              marketplaceIds,
              includedData: ['summaries'],
            },
          })

          const byMarket: Record<string, { asin?: string; status?: string }> = {}
          for (const summary of res?.summaries ?? []) {
            const mp = Object.entries(MARKETPLACE_ID_MAP).find(
              ([, id]) => id === summary.marketplaceId,
            )?.[0]
            if (!mp) continue
            byMarket[mp] = {
              asin: summary.asin ?? undefined,
              status: Array.isArray(summary.status) ? summary.status[0] : summary.status,
            }
          }
          return { sku, byMarket }
        }),
      )

      // Shape: { results: { IT: { SKU: { asin, status } }, DE: { ... } } }
      const results: Record<string, Record<string, { asin?: string; status?: string }>> = {}
      for (const outcome of settled) {
        if (outcome.status !== 'fulfilled') continue
        const { sku, byMarket } = outcome.value
        for (const [mp, data] of Object.entries(byMarket)) {
          results[mp] = results[mp] ?? {}
          results[mp][sku] = data
        }
      }

      return reply.send({ results })
    } catch (err: any) {
      request.log.error(err, 'flat-file/fetch-listings failed')
      return reply.code(500).send({ error: err?.message ?? 'Fetch failed' })
    }
  })

  // ── POST /api/amazon/flat-file/export-tsv ───────────────────────────
  // Server-side TSV generation (client can also do this locally).
  fastify.post<{
    Body: { manifest: any; rows: any[] }
  }>('/amazon/flat-file/export-tsv', async (request, reply) => {
    const { manifest, rows } = request.body
    if (!manifest || !rows) {
      return reply.code(400).send({ error: 'manifest and rows required' })
    }
    try {
      const tsv = flatFileService.buildTsvExport(manifest, rows)
      reply.header('Content-Type', 'text/tab-separated-values; charset=utf-8')
      reply.header(
        'Content-Disposition',
        `attachment; filename="amazon_flat_file_${manifest.productType}_${manifest.marketplace}_${Date.now()}.txt"`,
      )
      return reply.send(tsv)
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'Export failed' })
    }
  })

  // ── POST /api/amazon/flat-file/fetch-images ─────────────────────────
  // Fetch main product images from SP-API Catalog Items API for a list of ASINs.
  fastify.post<{
    Body: { asins: string[]; marketplace: string }
  }>('/amazon/flat-file/fetch-images', async (request, reply) => {
    const { asins, marketplace } = request.body
    if (!asins?.length) return reply.code(400).send({ error: 'asins required' })
    if (asins.length > 100) return reply.code(400).send({ error: 'Max 100 ASINs per request' })

    const marketplaceId = MARKETPLACE_ID_MAP[(marketplace ?? 'IT').toUpperCase()] ?? MARKETPLACE_ID_MAP.IT

    // If SP-API not configured, return empty gracefully
    const dryRun = process.env.NEXUS_AMAZON_BATCH_DRYRUN === '1'
    if (dryRun) return reply.send({ images: {} })

    try {
      const sp = await getSpClient()
      const images: Record<string, string> = {}

      // Batch in chunks of 20 (API limit)
      const CHUNK = 20
      for (let i = 0; i < asins.length; i += CHUNK) {
        const chunk = asins.slice(i, i + CHUNK)
        try {
          const res: any = await sp.callAPI({
            operation: 'searchCatalogItems',
            endpoint: 'catalogItems',
            version: '2022-04-01',
            query: {
              marketplaceIds: [marketplaceId],
              identifiers: chunk,
              identifierType: 'ASIN',
              includedData: ['images'],
            },
          })
          for (const item of res?.items ?? []) {
            const asin: string = item.asin
            // Find images for the requested marketplace
            const mpImages = item.images?.find((img: any) => img.marketplaceId === marketplaceId)?.images
              ?? item.images?.[0]?.images  // fallback to first marketplace
              ?? []
            const mainImg = mpImages.find((img: any) => img.variant === 'MAIN')
            if (mainImg?.link) images[asin] = mainImg.link
          }
        } catch { /* skip failed chunk */ }
      }

      return reply.send({ images })
    } catch (err: any) {
      request.log.error(err, 'flat-file/fetch-images failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to fetch images' })
    }
  })

  // ── POST /api/amazon/flat-file/sync-rows ───────────────────────────
  // Sync flat-file rows into the platform DB (ChannelListing, StockLevel,
  // Product hierarchy). Called on Save and after a feed is DONE.
  fastify.post<{
    Body: {
      rows: any[]
      marketplace?: string
      productType?: string
      expandedFields?: Record<string, string>
      isPublished?: boolean
    }
  }>('/amazon/flat-file/sync-rows', async (request, reply) => {
    const { rows, marketplace = 'IT', expandedFields = {}, isPublished = false } = request.body
    if (!rows || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be non-empty' })
    }
    if (rows.length > 2000) {
      return reply.code(400).send({ error: 'Max 2000 rows per sync' })
    }
    try {
      const mp = (marketplace ?? 'IT').toUpperCase()
      const result = await flatFileService.syncRowsToPlatform(rows, mp, expandedFields, { isPublished })

      // IS.2b — auto-enqueue qty + price pushes for active listings.
      // Unlike eBay (which enqueues inline), the Amazon service only writes
      // to DB. We enqueue here so the autopilot worker picks them up within
      // ~30s instead of waiting for a manual feed submit.
      void (async () => {
        try {
          const skus = rows.map((r: any) => String(r.item_sku ?? '').trim()).filter(Boolean)
          if (!skus.length) return

          const listings = await prisma.channelListing.findMany({
            where: {
              channel: 'AMAZON',
              marketplace: mp,
              isPublished: true,
              offerActive: true,
              product: { sku: { in: skus } },
            },
            select: {
              id: true,
              productId: true,
              price: true,
              quantity: true,
              externalListingId: true,
              region: true,
            },
          })

          for (const listing of listings) {
            const row = rows.find((r: any) => {
              // match by SKU via listing.productId — simpler: match any changed field
              return true
            })
            if (!listing.productId) continue
            await prisma.outboundSyncQueue.createMany({
              data: [
                {
                  productId: listing.productId,
                  channelListingId: listing.id,
                  targetChannel: 'AMAZON',
                  targetRegion: listing.region ?? mp,
                  syncType: 'QUANTITY_UPDATE',
                  syncStatus: 'PENDING',
                  payload: { quantity: listing.quantity ?? 0, source: 'AMAZON_FLAT_FILE_SAVE' },
                  externalListingId: listing.externalListingId ?? undefined,
                  retryCount: 0,
                  maxRetries: 3,
                  holdUntil: new Date(Date.now() + 30_000),
                },
                ...(listing.price != null ? [{
                  productId: listing.productId,
                  channelListingId: listing.id,
                  targetChannel: 'AMAZON' as const,
                  targetRegion: listing.region ?? mp,
                  syncType: 'PRICE_UPDATE' as const,
                  syncStatus: 'PENDING' as const,
                  payload: { price: Number(listing.price), currency: 'EUR', source: 'AMAZON_FLAT_FILE_SAVE' },
                  externalListingId: listing.externalListingId ?? undefined,
                  retryCount: 0,
                  maxRetries: 3,
                  holdUntil: new Date(Date.now() + 30_000),
                }] : []),
              ] as any,
              skipDuplicates: true,
            })
          }
          // Content auto-publish: enqueue FULL_SYNC for listings
          // that have _autoPublishContent=true in platformAttributes.
          await enqueueContentSyncIfEnabled(listings.map((l) => l.id))

          // ES.2 — emit one FLAT_FILE_IMPORTED event per affected product.
          void productEventService.emitMany(
            listings
              .filter((l) => l.productId)
              .map((l) => ({
                aggregateId: l.productId!,
                aggregateType: 'Product' as const,
                eventType: 'FLAT_FILE_IMPORTED' as const,
                data: {
                  channel: 'AMAZON',
                  marketplace: mp,
                  channelListingId: l.id,
                  price: l.price,
                  quantity: l.quantity,
                },
                metadata: {
                  source: 'FLAT_FILE_IMPORT' as const,
                  flatFileType: 'AMAZON_INVENTORY_LOADER',
                  rowCount: rows.length,
                },
              })),
          )
        } catch (err2) {
          request.log.warn({ err: err2 }, 'amazon flat-file: auto-enqueue failed (non-fatal)')
        }
      })()

      return reply.send(result)
    } catch (err: any) {
      request.log.error(err, 'flat-file/sync-rows failed')
      return reply.code(500).send({ error: err?.message ?? 'Sync failed' })
    }
  })

  // ── POST /api/amazon/flat-file/translate-values ─────────────────────
  // Cross-market enum value mapping via constrained AI translation.
  // Takes a column's source values from one market and finds the
  // semantically equivalent options in each target market's schema.
  fastify.post<{
    Body: {
      sourceMarket: string
      productType: string
      colId: string
      colLabelEn?: string
      values: string[]
      targetMarkets: string[]
    }
  }>('/amazon/flat-file/translate-values', async (request, reply) => {
    const { sourceMarket, productType, colId, colLabelEn, values, targetMarkets } = request.body

    if (!sourceMarket || !productType || !colId) {
      return reply.code(400).send({ error: 'sourceMarket, productType, and colId are required' })
    }
    if (!Array.isArray(values) || values.length === 0) {
      return reply.code(400).send({ error: 'values must be a non-empty array' })
    }
    if (values.length > 50) {
      return reply.code(400).send({ error: 'Max 50 values per request' })
    }
    if (!Array.isArray(targetMarkets) || targetMarkets.length === 0) {
      return reply.code(400).send({ error: 'targetMarkets must be a non-empty array' })
    }

    try {
      const result = await translateEnumValues(prisma, {
        sourceMarket: sourceMarket.toUpperCase(),
        productType: productType.toUpperCase(),
        colId,
        colLabelEn,
        values,
        targetMarkets: targetMarkets.map((m) => m.toUpperCase()),
      })
      return reply.send(result)
    } catch (err: any) {
      request.log.error(err, 'flat-file/translate-values failed')
      return reply.code(500).send({ error: err?.message ?? 'Translation failed' })
    }
  })

  // ── A4.1 — Flat File AI Assistant ──────────────────────────────────────────
  // POST /api/amazon/flat-file/ai-assist
  //
  // Accepts the current flat file rows + a free-form operator instruction.
  // Claude reads the rows and returns structured proposed cell changes.
  // The frontend shows a diff; operator applies selected changes.
  fastify.post<{
    Body: {
      instruction: string
      rows: Array<Record<string, unknown>>
      columnMeta: Array<{ id: string; label: string; description?: string }>
      marketplace?: string
      model?: string
    }
  }>('/amazon/flat-file/ai-assist', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const { instruction, rows, columnMeta, marketplace = 'IT', model } = request.body ?? {}

    if (!instruction || typeof instruction !== 'string' || instruction.trim().length === 0) {
      return reply.code(400).send({ error: 'instruction is required' })
    }
    if (instruction.length > 2000) {
      return reply.code(400).send({ error: 'instruction must be ≤ 2000 characters' })
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      return reply.code(400).send({ error: 'rows must be a non-empty array' })
    }
    if (rows.length > 300) {
      return reply.code(400).send({ error: 'Max 300 rows per request' })
    }

    try {
      const result = await runFlatFileAiInstruction({
        instruction: instruction.trim(),
        rows,
        columnMeta: Array.isArray(columnMeta) ? columnMeta : [],
        marketplace: (marketplace ?? 'IT').toUpperCase(),
        channel: 'AMAZON',
        model: model || undefined,
      })
      return reply.send(result)
    } catch (err: any) {
      request.log.error(err, '[amazon/flat-file/ai-assist] failed')
      return reply.code(500).send({ error: err?.message ?? 'AI assistant failed' })
    }
  })
}
