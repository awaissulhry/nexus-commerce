/**
 * Amazon Flat-File Spreadsheet API
 *
 * Endpoints that power the /products/amazon-flat-file page:
 *
 *   GET  /api/amazon/flat-file/product-types — known product types for marketplace
 *   GET  /api/amazon/flat-file/template      — column manifest from live schema
 *   GET  /api/amazon/flat-file/rows          — existing products as pre-filled rows
 *   POST /api/amazon/flat-file/submit        — rows → JSON_LISTINGS_FEED → feedId
 *   GET  /api/amazon/flat-file/feeds/:id     — poll feed status + processing report
 *   POST /api/amazon/flat-file/parse-tsv     — upload TSV → parsed rows
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import {
  AmazonFlatFileService,
  MARKETPLACE_ID_MAP,
} from '../services/amazon/flat-file.service.js'

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
    Body: { rows: any[]; marketplace?: string }
  }>('/amazon/flat-file/submit', async (request, reply) => {
    const { rows, marketplace = 'IT' } = request.body
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

    const body = flatFileService.buildJsonFeedBody(rows, mp, sellerId)

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
}
