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
  flatFileExportColumns,
} from '../services/amazon/flat-file.service.js'
import { renderExport } from '../services/export/renderers.js'
import { parseCsv, parseXlsx, parseJson, detectFileKind, sniffDelimiter } from '../services/import/parsers.js'
import { suggestFlatFileMapping } from '../services/amazon/flat-file-mapping.js'
import { aiSuggestColumns } from '../services/amazon/flat-file-mapping-ai.js'
import { coerceRowsWithAi } from '../services/amazon/flat-file-coerce-ai.js'
import { planImportMerge, type ImportApplyMode } from '../services/amazon/flat-file-merge.js'
import { translateEnumValues } from '../services/amazon/value-translate.service.js'
import { getAmazonPublishMode } from '../services/amazon-publish-gate.service.js'
import { preflightRow, buildPerTypeValidation, validateImportRows, validateParentChildBatch } from '../services/listing-preflight.service.js'
import {
  resolveComplianceForSkus,
  evaluateCompliance,
  buildAmazonComplianceColumns,
} from '../services/compliance-resolver.service.js'

import { enqueueContentSyncIfEnabled } from '../services/content-auto-publish.service.js'
import { productEventService } from '../services/product-event.service.js'
import { runFlatFileAiInstruction } from '../services/flat-file-ai.service.js'
import {
  startPullPreviewJob,
  getPullPreviewJobStatus,
} from '../services/amazon/flat-file-pull-preview.service.js'
import { TtlCache } from '../utils/ttl-cache.js'
import { ServerTiming } from '../utils/server-timing.js'
import { extractBrowseNodes } from '../services/amazon/browse-nodes.js'
import { amazonMarketplaceId } from '../services/categories/marketplace-ids.js'

const amazon = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazon)
const flatFileService = new AmazonFlatFileService(prisma, schemaService)

// EH.4 — Manifest cache. generateManifest() reads from CategorySchema
// (already 24 h DB-cached) and then runs label/enum/group derivation
// over the schema definition (a few thousand allocations + sorts).
// The end product is identical for any given (marketplace, productType)
// for as long as the underlying schema hasn't rotated, so we cache the
// built manifest in-process for 5 min. force=1 still bypasses both
// caches and re-fetches from SP-API.
const manifestCache = new TtlCache<unknown>({
  ttlMs: 30 * 60_000,
  maxEntries: 200,
})

// BN.0.3 — browse-node list per (marketplace, productType). Same TTL as the
// manifest cache — the enum list is derived from the same underlying schema.
const browseNodeCache = new TtlCache<unknown>({
  ttlMs: 30 * 60_000,
  maxEntries: 200,
})

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

  // ── GET /api/amazon/flat-file/browse-nodes ─────────────────────────
  // BN.0.3 — returns the list of Amazon browse nodes for a given
  // (marketplace, productType) extracted from the PTD enum in the schema.
  // ?marketplace=IT&productType=COAT[&force=1]
  // Response: { marketplace, productType, nodes: {id,path,label}[], source, fetchedAt }
  fastify.get<{ Querystring: { marketplace?: string; productType?: string; force?: string } }>(
    '/amazon/flat-file/browse-nodes',
    async (request, reply) => {
      const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
      const productType = (request.query.productType ?? '').toUpperCase()
      const force = request.query.force === '1'

      if (!productType) {
        return reply.code(400).send({ error: 'productType is required' })
      }

      const cacheKey = `${marketplace}:${productType}`
      if (!force) {
        const cached = browseNodeCache.get(cacheKey)
        if (cached !== undefined) return reply.send(cached)
      }

      try {
        const schema = await schemaService.getSchema(
          { channel: 'AMAZON', marketplace, productType },
          { force },
        )
        const def = (schema.schemaDefinition ?? {}) as Record<string, unknown>
        const nodes = extractBrowseNodes(def, amazonMarketplaceId(marketplace))
        const payload = {
          marketplace,
          productType,
          nodes: nodes.map((n) => ({ id: n.id, path: n.path, label: n.path })),
          source: nodes.length ? 'schema' : 'none',
          fetchedAt: schema.fetchedAt ? new Date(schema.fetchedAt).toISOString() : new Date().toISOString(),
        }
        if (!force) browseNodeCache.set(cacheKey, payload)
        return reply.send(payload)
      } catch (err: any) {
        request.log.error(err, 'flat-file/browse-nodes failed')
        return reply.code(500).send({ error: err?.message ?? 'Failed to load browse nodes' })
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

    // EH.8 — Server-Timing breakdown. The slow path here is SP-API
    // (~500-2000 ms cold); knowing whether a given request hit the
    // manifest cache, the schema DB cache, or the live SP-API tells
    // us at a glance which layer is the bottleneck on any given tab.
    const tx = new ServerTiming()
    try {
      // EH.4 — Skip the manifest cache on force=1 so the operator's
      // explicit refresh always re-derives from the schema.
      const cacheKey = `${marketplace}:${productType}`
      if (!force) {
        const cached = manifestCache.get(cacheKey)
        if (cached !== undefined) {
          tx.flag('cacheHit')
          const header = tx.toHeader()
          if (header) reply.header('Server-Timing', header)
          return reply.send(cached)
        }
        tx.flag('cacheMiss')
      } else {
        tx.flag('forced')
      }

      const manifest = await tx.measure('generateManifest', () =>
        flatFileService.generateManifest(marketplace, productType, force),
      )

      if (!force) manifestCache.set(cacheKey, manifest)
      const header = tx.toHeader()
      if (header) reply.header('Server-Timing', header)
      return reply.send(manifest)
    } catch (err: any) {
      request.log.error(err, 'flat-file/template failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to generate manifest' })
    }
  })

  // ── GET /api/amazon/flat-file/union-template ────────────────────────
  // MT.1 — UNION column manifest across MULTIPLE product types for one sheet.
  // ?productTypes=JACKET,PANTS (comma-separated). Each column carries
  // applicableProductTypes + requiredForProductTypes so the editor can grey a
  // cell that doesn't apply to a row's type and validate required-ness per row.
  // Additive: the single-type /template endpoint is unchanged.
  fastify.get<{
    Querystring: { marketplace?: string; productTypes?: string; force?: string }
  }>('/amazon/flat-file/union-template', async (request, reply) => {
    const marketplace = (request.query.marketplace ?? 'IT').toUpperCase()
    const types = (request.query.productTypes ?? '')
      .split(',').map((t) => t.trim().toUpperCase()).filter(Boolean)
    const force = request.query.force === '1'
    if (types.length === 0) {
      return reply.code(400).send({ error: 'productTypes is required (comma-separated)' })
    }
    const cacheKey = `union:${marketplace}:${[...types].sort().join(',')}`
    try {
      if (!force) {
        const cached = manifestCache.get(cacheKey)
        if (cached !== undefined) return reply.send(cached)
      }
      const manifest = await flatFileService.generateUnionManifest(marketplace, types, force)
      if (!force) manifestCache.set(cacheKey, manifest)
      return reply.send(manifest)
    } catch (err: any) {
      request.log.error(err, 'flat-file/union-template failed')
      return reply.code(500).send({ error: err?.message ?? 'Failed to generate union manifest' })
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
    Body: { rows: any[]; marketplace?: string; expandedFields?: Record<string, string>; productType?: string; overrideCompliance?: boolean }
  }>('/amazon/flat-file/submit', async (request, reply) => {
    const { rows, marketplace = 'IT', expandedFields = {}, productType, overrideCompliance } = request.body
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

    // A5 — pre-flight: surface missing-required / invalid-GTIN / missing-image as a
    // per-row checklist alongside the feedId (warn, not block). C1 adds the EU
    // compliance issues (PPE/CE/GPSR/hazmat) per row's product+market. Computed
    // before the dry-run gate so the common (dry-run) path returns it too.
    let preflight: Array<{ sku: string; issues: any[] }> = []
    // C1 — resolved once here, reused by the compliance merge below (live path).
    let complianceBySku = new Map<string, any>()
    // MT.2 — per product-type APPLICABLE column sets, so the compliance merge
    // (live path) gates each row against ITS product type, not a batch manifest.
    let applicableByType: Map<string, Set<string>> | null = null
    // C5.2 — block-severity compliance issues (the live-publish gate).
    const complianceBlocks: Array<{ sku: string; messages: string[] }> = []
    // MT.2 — a row's own product type (mixed-category sheet); fall back to the
    // batch-level productType for legacy single-type submits.
    const rowType = (r: any) => String(r.product_type ?? productType ?? '').toUpperCase()
    const batchTypes = [...new Set(rows.map(rowType).filter(Boolean))]
    if (batchTypes.length > 0) {
      try {
        // MT.1 union manifest across every product type in the batch → MT.2
        // per-type required + applicable sets.
        const union = await flatFileService.generateUnionManifest(mp, batchTypes)
        const { requiredByType, applicableByType: appByType, lengthByType } = buildPerTypeValidation(union)
        applicableByType = appByType
        complianceBySku = await resolveComplianceForSkus(rows.map((r: any) => String(r.item_sku ?? '')))
        preflight = rows
          .map((r: any) => {
            // Validate each row against its OWN product type's required columns +
            // byte/char length caps (Amazon enforces maxUtf8ByteLength, not chars).
            const issues = preflightRow(r, requiredByType.get(rowType(r)) ?? [], lengthByType.get(rowType(r)) ?? [])
            const cp = complianceBySku.get(String(r.item_sku ?? ''))
            if (cp) {
              const cIssues = evaluateCompliance(cp, mp, 'AMAZON')
              const blocks = cIssues.filter((ci) => ci.severity === 'block')
              if (blocks.length > 0) complianceBlocks.push({ sku: String(r.item_sku ?? ''), messages: blocks.map((b) => b.message) })
              for (const ci of cIssues) {
                issues.push({ field: 'compliance', severity: ci.severity === 'block' ? 'error' : 'warning', message: ci.message })
              }
            }
            return { sku: String(r.item_sku ?? ''), issues }
          })
          .filter((p) => p.issues.length > 0)
      } catch (err: any) {
        request.log.warn({ err: err?.message }, 'flat-file/submit: preflight unavailable')
      }
    }

    // FFC — one-click: create/sync rows to Nexus BEFORE the publish gate, so a new
    // SKU becomes a real product regardless of publish mode (creating a product in
    // Nexus is a LOCAL action, not an Amazon publish). Runs for live AND dry-run;
    // best-effort, never blocks. The existing per-row sync creates new products
    // (_isNew) + their ChannelListing/StockLevel and updates existing ones.
    let ffcCreated = 0
    let ffcSyncErrors: Array<{ sku: string; error: string }> = []
    try {
      const syncResult = await flatFileService.syncRowsToPlatform(rows, mp, expandedFields, { isPublished: false })
      ffcCreated = syncResult.created
      ffcSyncErrors = syncResult.errors
    } catch (e: any) {
      request.log.warn({ err: e?.message, marketplace: mp }, 'flat-file/submit: pre-publish sync failed (non-fatal)')
    }

    // A1.2 — unified publish gate (master flag + mode) instead of the legacy
    // NEXUS_AMAZON_BATCH_DRYRUN. Only 'live' actually submits a feed.
    const dryRun = getAmazonPublishMode() !== 'live'
    if (dryRun) {
      return reply.send({
        feedId: `dryrun-flat-${Date.now()}`,
        feedDocumentId: `dryrun-doc-${Date.now()}`,
        messageCount: rows.length,
        dryRun: true,
        preflight,
        created: ffcCreated,
        syncErrors: ffcSyncErrors,
      })
    }

    // C5.2 — block a LIVE publish on a blocking compliance issue (PPE Cat II/III
    // on EU with a missing/expired CE certificate). An explicit overrideCompliance
    // bypasses the gate (logged to the audit). Dry-run never reaches here.
    if (complianceBlocks.length > 0) {
      if (!overrideCompliance) {
        return reply.code(422).send({
          error: `Compliance block — ${complianceBlocks.length} SKU(s) cannot be published. Fix the issue(s) or resubmit with overrideCompliance:true.`,
          complianceBlocks,
        })
      }
      request.log.warn({ skus: complianceBlocks.map((b) => b.sku) }, 'flat-file/submit: compliance block OVERRIDDEN by operator')
    }

    // FFA — schema-aware feed build: enum display labels→codes ("Pakistan"→"PK"),
    // number/boolean coercion, and language_tag only on localized fields. Merge
    // hints across every product type in the batch; a missing/failed schema
    // submits values as-is (and tags everything, to never strip a real tag).
    const enumCodeMap: Record<string, Record<string, string>> = {}
    const localizedFields = new Set<string>()
    const numericFields = new Set<string>()
    const booleanFields = new Set<string>()
    try {
      const productTypes = [...new Set(
        rows.map((r) => String(r.product_type ?? productType ?? '').toUpperCase()).filter(Boolean),
      )]
      for (const pt of productTypes) {
        const h = await flatFileService.getFeedSchemaHints(mp, pt)
        Object.assign(enumCodeMap, h.enumCodeMap)
        h.localizedFields.forEach((f) => localizedFields.add(f))
        h.numericFields.forEach((f) => numericFields.add(f))
        h.booleanFields.forEach((f) => booleanFields.add(f))
      }
    } catch (err: any) {
      request.log.warn({ err: err?.message }, 'flat-file/submit: schema hints unavailable — submitting values as-is')
    }

    // C1 — fill EU compliance columns from the master (country of origin,
    // manufacturer, GPSR responsible person) onto each row before serializing.
    // Schema-safe (only a column the product type's manifest defines) AND
    // non-clobbering (an operator-entered value always wins). Best-effort.
    // MT.2 — gate each row's compliance fill against ITS product type's
    // applicable columns (a mixed-category sheet), not one batch manifest.
    if (applicableByType && complianceBySku.size > 0) {
      for (const row of rows as any[]) {
        const cp = complianceBySku.get(String(row.item_sku ?? ''))
        if (!cp) continue
        const applicable = applicableByType.get(rowType(row))
        if (!applicable) continue
        for (const [k, v] of Object.entries(buildAmazonComplianceColumns(cp))) {
          if (!applicable.has(k)) continue
          const cur = row[k]
          if (cur == null || String(cur).trim() === '') row[k] = v
        }
      }
    }

    // FBA-flip guard — REJECT (never silently override) any row that would convert
    // an FBA listing to merchant-fulfilled (FBM): a merchant DEFAULT/MFN channel +
    // a quantity for a SKU that is actually FBA. The operator must clear the
    // quantity / set AMAZON_EU, or convert the SKU in Seller Central first.
    const fbaViolations = await flatFileService.findFbaQtyViolations(rows, mp)
    if (fbaViolations.length > 0) {
      const skuList = fbaViolations.map((v) => v.sku).join(', ')
      request.log.warn({ skus: fbaViolations }, 'flat-file/submit: blocked FBA→FBM merchant-quantity rows')
      return reply.code(400).send({
        error: `Blocked: ${fbaViolations.length} row(s) would flip an FBA listing to merchant-fulfilled (FBM). For these FBA SKUs, clear the quantity or set the fulfillment channel to AMAZON_EU — or convert them in Seller Central first if you intend FBM. SKUs: ${skuList}`,
        code: 'FBA_MERCHANT_QUANTITY_BLOCKED',
        skus: fbaViolations.map((v) => v.sku),
      })
    }

    const body = flatFileService.buildJsonFeedBody(rows, mp, sellerId, expandedFields, {
      enumCodeMap,
      numericFields,
      booleanFields,
      // Only when we actually have schema data — otherwise tag everything (legacy).
      localizedFields: localizedFields.size > 0 ? localizedFields : undefined,
    })

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

      // FFS.1 — durable server-side record so status + the per-SKU report survive
      // a tab close and are visible across sessions/devices. Best-effort: never
      // block the submit, the feed is already accepted by Amazon. nextPollAt=now
      // so the reconcile cron (FFS.3) picks it up on its next tick.
      try {
        const skus = rows
          .map((r: any) => r?.item_sku)
          .filter((s: any): s is string => typeof s === 'string' && s.length > 0)
        await prisma.amazonFlatFileFeedJob.create({
          data: {
            feedId: feedRes.feedId,
            feedDocumentId: docRes.feedDocumentId,
            marketplace: mp,
            productType: productType ?? null,
            status: 'IN_QUEUE',
            skuCount: rows.length,
            skus,
            nextPollAt: new Date(),
          },
        })
      } catch (e: any) {
        request.log.warn({ err: e?.message, feedId: feedRes.feedId }, 'flat-file feed-job persist failed (non-fatal)')
      }

      return reply.send({
        feedId: feedRes.feedId,
        feedDocumentId: docRes.feedDocumentId,
        messageCount: rows.length,
        dryRun: false,
        preflight,
        created: ffcCreated,
        syncErrors: ffcSyncErrors,
      })
    } catch (err: any) {
      request.log.error(err, 'flat-file/submit failed')
      return reply.code(500).send({ error: err?.message ?? 'Submission failed' })
    }
  })

  // ── POST /api/amazon/flat-file/preflight ────────────────────────────
  // A5 — schema-driven pre-flight WITHOUT submitting a feed: per-row checklist of
  // missing-required (90220 class) / invalid-GTIN / missing-image. Warn-only — the
  // editor can show it before the operator commits a submit.
  fastify.post<{
    Body: { rows?: any[]; marketplace?: string; productType?: string }
  }>('/amazon/flat-file/preflight', async (request, reply) => {
    const { rows = [], marketplace = 'IT', productType } = request.body ?? {}
    const mp = String(marketplace).toUpperCase()
    // MT.2 — validate each row against ITS OWN product type (mixed-category sheet).
    const rowType = (r: any) => String(r?.product_type ?? productType ?? '').toUpperCase()
    const batchTypes = [...new Set(rows.map(rowType).filter(Boolean))]
    if (batchTypes.length === 0) return reply.send({ preflight: [], checkedRows: rows.length })
    try {
      const union = await flatFileService.generateUnionManifest(mp, batchTypes)
      const { requiredByType, lengthByType } = buildPerTypeValidation(union)
      // FFC — FBA rows that carry a quantity (Amazon manages FBA stock, so it must
      // not be sent). Merchant-channel+qty = error (would flip FBA→FBM, also hard-
      // blocked at /submit); other channels = warning (qty ignored — clear it).
      const fbaFlags = await flatFileService.findFbaQtyRows(rows)
      const fbaBySku = new Map(fbaFlags.map((f) => [f.sku, f]))
      // Phase 3 (FBA visibility) — deleting/relisting an FBA SKU leaves its units
      // stranded in Amazon's warehouse (still bound to the SKU's FNSKU). Surface a
      // WARNING with the operator-driven next steps; never block, never automate.
      const fbaDeleteSkus = new Set(await flatFileService.findFbaDeleteRows(rows))
      // G.1 — batch parent/child orphan check (a child's parent_sku must point to a
      // parent present in this submission). eBay-parity with the orphan-variant check.
      const orphanFlags = validateParentChildBatch(rows)
      const preflight = rows
        .map((r: any) => {
          const sku = String(r?.item_sku ?? '')
          const issues = preflightRow(r, requiredByType.get(rowType(r)) ?? [], lengthByType.get(rowType(r)) ?? [])
          const fba = fbaBySku.get(sku)
          if (fba) {
            issues.push(
              fba.severity === 'block'
                ? { field: 'fulfillment_availability__quantity', severity: 'error', message: 'FBA product — clear the quantity (a merchant quantity would flip this FBA listing to FBM)' }
                : { field: 'fulfillment_availability__quantity', severity: 'warning', message: 'FBA product — quantity is ignored (Amazon manages FBA stock); clear it to be safe' },
            )
          }
          if (fbaDeleteSkus.has(sku) && String(r?.record_action ?? '').trim().toLowerCase() === 'delete') {
            issues.push({
              field: 'record_action',
              severity: 'warning',
              message: 'FBA inventory present — deleting this listing will NOT remove the units from Amazon’s warehouse; they stay bound to this SKU’s FNSKU and become unfulfillable. In Seller Central, create a removal order or sell through first; if relisting under a new SKU, relabel the units to the new FNSKU.',
            })
          }
          for (const o of orphanFlags) if (o.itemSku === sku) issues.push(o.issue)
          return { sku, issues }
        })
        .filter((p) => p.issues.length > 0)
      return reply.send({ preflight, checkedRows: rows.length, productTypes: batchTypes })
    } catch (err: any) {
      request.log.error(err, 'flat-file/preflight failed')
      return reply.code(500).send({ error: err?.message ?? 'Preflight failed' })
    }
  })

  // ── GET /api/amazon/flat-file/feeds/:feedId ─────────────────────────
  // Polls feed status. When DONE, downloads and parses the processing report.
  fastify.get<{
    Params: { feedId: string }
    Querystring: { refresh?: string }
  }>('/amazon/flat-file/feeds/:feedId', async (request, reply) => {
    const { feedId } = request.params
    // ?refresh=1 forces a live re-fetch past the terminal fast-path — used to
    // re-validate / repair a feed that finalized against a premature empty report.
    const force = request.query?.refresh === '1' || request.query?.refresh === 'true'

    // PD.2 — a dryrun feedId is self-identifying; the legacy global flag is gone
    // (it forced EVERY feed poll to a fake DONE when NEXUS_AMAZON_BATCH_DRYRUN=1,
    // even for real feeds — a way to mask a real feed's true status).
    if (feedId.startsWith('dryrun-')) {
      return reply.send({
        feedId,
        processingStatus: 'DONE',
        resultFeedDocumentId: null,
        results: [],
        dryRun: true,
      })
    }

    try {
      // FFS.2 — delegate to the shared reconcile service: getFeed → on terminal,
      // parse the report robustly (JSON_LISTINGS_FEED issues[]/summary, tri-state
      // per-SKU) and update the durable AmazonFlatFileFeedJob row.
      const { reconcileFeedJob } = await import('../services/amazon-flat-file-feed.service.js')
      const r = await reconcileFeedJob(feedId, { force })
      return reply.send({
        feedId: r.feedId,
        processingStatus: r.processingStatus,
        resultFeedDocumentId: r.resultFeedDocumentId,
        results: r.results,
        summary: r.summary,
        errorMessage: r.errorMessage,
      })
    } catch (err: any) {
      request.log.error(err, 'flat-file/feeds/:feedId failed')
      return reply.code(500).send({ error: err?.message ?? 'Status poll failed' })
    }
  })

  // ── GET /api/amazon/flat-file/feeds — durable submission list (FFS.2) ────
  // Survives tab close / other device: reads the persisted AmazonFlatFileFeedJob
  // rows instead of client localStorage.
  fastify.get<{
    Querystring: { marketplace?: string; productType?: string; status?: string; limit?: string }
  }>('/amazon/flat-file/feeds', async (request, reply) => {
    const q = request.query
    const where: any = {}
    if (q.marketplace) where.marketplace = q.marketplace.toUpperCase()
    if (q.productType) where.productType = q.productType
    if (q.status) where.status = q.status.toUpperCase()
    const limit = Math.min(200, Math.max(1, parseInt(q.limit ?? '50', 10) || 50))
    try {
      const [jobs, total] = await Promise.all([
        prisma.amazonFlatFileFeedJob.findMany({ where, orderBy: { submittedAt: 'desc' }, take: limit }),
        prisma.amazonFlatFileFeedJob.count({ where }),
      ])
      return reply.send({ jobs, total })
    } catch (err: any) {
      request.log.error(err, 'flat-file/feeds list failed')
      return reply.code(500).send({ error: err?.message ?? 'List failed' })
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

  // ── POST /api/amazon/flat-file/parse ────────────────────────────────
  // FX.2 — parse an uploaded EXTERNAL file (CSV / TSV / XLSX / JSON) into raw
  // { headers, rows }. Unlike /parse-tsv (which strips Amazon's metadata header
  // and normalizes to Amazon column ids), this returns the file's OWN headers
  // untouched — the raw external shape the FX.3 smart-mapper maps onto flat-file
  // columns. Text formats (csv/tsv/json) send `text`; xlsx sends base64 `bytesBase64`.
  fastify.post<{
    Body: { filename?: string; text?: string; bytesBase64?: string }
  }>('/amazon/flat-file/parse', async (request, reply) => {
    const { filename, text, bytesBase64 } = request.body
    if (!text && !bytesBase64) {
      return reply.code(400).send({ error: 'Provide file content (text or bytesBase64)' })
    }
    if ((text?.length ?? 0) > 15_000_000 || (bytesBase64?.length ?? 0) > 20_000_000) {
      return reply.code(400).send({ error: 'File too large (max ~15 MB)' })
    }
    try {
      const kind = detectFileKind(filename) // csv | xlsx | json (.tsv/.txt → csv family)
      let parsed
      if (kind === 'xlsx') {
        if (!bytesBase64) return reply.code(400).send({ error: 'xlsx upload requires bytesBase64' })
        parsed = await parseXlsx(new Uint8Array(Buffer.from(bytesBase64, 'base64')))
      } else if (kind === 'json') {
        if (text == null) return reply.code(400).send({ error: 'json upload requires text' })
        parsed = parseJson(text)
      } else {
        if (text == null) return reply.code(400).send({ error: 'csv/tsv upload requires text' })
        parsed = parseCsv(text, sniffDelimiter(filename, text)) // sniff comma vs tab
      }
      return reply.send({ kind, headers: parsed.headers, rows: parsed.rows, count: parsed.rows.length })
    } catch (err: any) {
      return reply.code(400).send({ error: err?.message ?? 'Parse failed' })
    }
  })

  // ── POST /api/amazon/flat-file/suggest-mapping ──────────────────────
  // FX.3 — given the raw headers of an uploaded external file (FX.2 /parse) +
  // the target market/product type(s), suggest the best flat-file column for
  // each header with a confidence + source. Manifest-aware (accurate per market
  // + product type) and MT-union aware (maps across a mixed Jacket+Pants sheet).
  // Deterministic; the AI tail for ambiguous headers lands in FX.4.
  fastify.post<{
    Body: { headers: string[]; marketplace?: string; productType?: string; productTypes?: string[] }
  }>('/amazon/flat-file/suggest-mapping', async (request, reply) => {
    const { headers, marketplace = 'IT', productType, productTypes } = request.body
    if (!Array.isArray(headers) || headers.length === 0) {
      return reply.code(400).send({ error: 'headers (non-empty array) required' })
    }
    const types = (productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean)
    const pt = String(productType ?? '').toUpperCase()
    if (!pt && types.length === 0) {
      return reply.code(400).send({ error: 'productType or productTypes required' })
    }
    try {
      const manifest = types.length > 1
        ? await flatFileService.generateUnionManifest(marketplace, types)
        : await flatFileService.generateManifest(marketplace, pt || types[0])
      const columns = manifest.groups
        .flatMap((g) => g.columns)
        .map((c) => ({ id: c.id, labelEn: c.labelEn, labelLocal: c.labelLocal }))
      const result = suggestFlatFileMapping(headers, columns)
      return reply.send({
        ...result,
        marketplace: manifest.marketplace,
        productType: manifest.productType,
        columnCount: columns.length,
      })
    } catch (err: any) {
      request.log.error(err, 'flat-file/suggest-mapping failed')
      return reply.code(500).send({ error: err?.message ?? 'Mapping failed' })
    }
  })

  // ── POST /api/amazon/flat-file/suggest-columns-ai ───────────────────
  // FX.7 — AI tail for the headers FX.3's heuristic couldn't map. Send the
  // unmatched headers (+ a sample value each); get a constrained best-guess
  // flat-file column id per header (or null). The wizard applies these as
  // reviewable "AI" matches.
  fastify.post<{
    Body: { headers: string[]; samples?: Record<string, string>; marketplace?: string; productType?: string; productTypes?: string[] }
  }>('/amazon/flat-file/suggest-columns-ai', async (request, reply) => {
    const { headers, samples = {}, marketplace = 'IT', productType, productTypes } = request.body
    if (!Array.isArray(headers) || headers.length === 0) {
      return reply.code(400).send({ error: 'headers (non-empty array) required' })
    }
    const types = (productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean)
    const pt = String(productType ?? '').toUpperCase()
    if (!pt && types.length === 0) {
      return reply.code(400).send({ error: 'productType or productTypes required' })
    }
    try {
      const manifest = types.length > 1
        ? await flatFileService.generateUnionManifest(marketplace, types)
        : await flatFileService.generateManifest(marketplace, pt || types[0])
      const columns = manifest.groups
        .flatMap((g) => g.columns)
        .map((c) => ({ id: c.id, labelEn: c.labelEn, labelLocal: c.labelLocal }))
      const suggestions = await aiSuggestColumns(headers, columns, samples)
      return reply.send({ suggestions })
    } catch (err: any) {
      request.log.error(err, 'flat-file/suggest-columns-ai failed')
      return reply.code(500).send({ error: err?.message ?? 'AI mapping failed' })
    }
  })

  // ── POST /api/amazon/flat-file/coerce ───────────────────────────────
  // FX.4 — coerce already-mapped import rows ({ columnId: value }) to each
  // column's type/enum/limits: enum exact→normalized→(ai) semantic match, EU
  // locale numbers, booleans, max-length flagging. Returns the coerced rows +
  // per-cell issues (coerced / flagged) for the FX.5 preview. ai=true rescues
  // unmatched enum values via a constrained AI pass.
  fastify.post<{
    Body: { rows: Record<string, unknown>[]; marketplace?: string; productType?: string; productTypes?: string[]; ai?: boolean }
  }>('/amazon/flat-file/coerce', async (request, reply) => {
    const { rows, marketplace = 'IT', productType, productTypes, ai = false } = request.body
    if (!Array.isArray(rows)) {
      return reply.code(400).send({ error: 'rows (array) required' })
    }
    const types = (productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean)
    const pt = String(productType ?? '').toUpperCase()
    if (!pt && types.length === 0) {
      return reply.code(400).send({ error: 'productType or productTypes required' })
    }
    try {
      const manifest = types.length > 1
        ? await flatFileService.generateUnionManifest(marketplace, types)
        : await flatFileService.generateManifest(marketplace, pt || types[0])
      const cols = manifest.groups.flatMap((g) => g.columns)
      const columns = cols.map((c) => ({ id: c.id, kind: c.kind, options: c.options, maxLength: c.maxLength }))
      const colLabels = new Map(cols.map((c) => [c.id, c.labelEn]))
      const result = await coerceRowsWithAi(rows, columns, { ai: !!ai, colLabels })
      return reply.send(result)
    } catch (err: any) {
      request.log.error(err, 'flat-file/coerce failed')
      return reply.code(500).send({ error: err?.message ?? 'Coercion failed' })
    }
  })

  // ── POST /api/amazon/flat-file/plan-import ──────────────────────────
  // FX.5 — plan how mapped+coerced import rows would merge into the current grid
  // rows (matched by item_sku): which become new rows, which update existing,
  // and per cell from→to + willApply under the chosen mode (fill-missing |
  // overwrite) + column allowlist. Pure diff; the client renders it, toggles
  // cells locally, and applies the willApply cells. No DB.
  fastify.post<{
    Body: {
      existing: Record<string, unknown>[]
      incoming: Record<string, unknown>[]
      mode?: ImportApplyMode
      columns?: string[] | null
      matchKey?: string
      addNewRows?: boolean
    }
  }>('/amazon/flat-file/plan-import', async (request, reply) => {
    const { existing, incoming, mode = 'fill-missing', columns, matchKey, addNewRows } = request.body
    if (!Array.isArray(existing) || !Array.isArray(incoming)) {
      return reply.code(400).send({ error: 'existing and incoming (arrays) required' })
    }
    if (mode !== 'fill-missing' && mode !== 'overwrite') {
      return reply.code(400).send({ error: `Unsupported mode "${mode}"` })
    }
    try {
      const plan = planImportMerge(existing, incoming, { mode, columns, matchKey, addNewRows })
      return reply.send(plan)
    } catch (err: any) {
      request.log.error(err, 'flat-file/plan-import failed')
      return reply.code(500).send({ error: err?.message ?? 'Plan failed' })
    }
  })

  // ── POST /api/amazon/flat-file/validate-rows ────────────────────────
  // FX.6 — pre-flight import rows before apply: per-row missing-required +
  // invalid GTIN + missing-image, checked against each row's OWN product type.
  // Reuses A5 preflightRow + MT.2 buildPerTypeValidation. Returns rows w/ issues.
  fastify.post<{
    Body: { rows: Record<string, any>[]; marketplace?: string; productType?: string; productTypes?: string[] }
  }>('/amazon/flat-file/validate-rows', async (request, reply) => {
    const { rows, marketplace = 'IT', productType, productTypes } = request.body
    if (!Array.isArray(rows)) {
      return reply.code(400).send({ error: 'rows (array) required' })
    }
    const reqTypes = (productTypes ?? []).map((t) => String(t).toUpperCase()).filter(Boolean)
    const pt = String(productType ?? '').toUpperCase()
    if (!pt && reqTypes.length === 0) {
      return reply.code(400).send({ error: 'productType or productTypes required' })
    }
    try {
      // Cover every product type present in the rows (+ the requested one) so each
      // row validates against its own type's required set (MT.2).
      const rowTypes = rows.map((r) => String(r.product_type ?? '').toUpperCase()).filter(Boolean)
      const allTypes = [...new Set([...reqTypes, ...(pt ? [pt] : []), ...rowTypes])]
      const manifest = allTypes.length > 1
        ? await flatFileService.generateUnionManifest(marketplace, allTypes)
        : await flatFileService.generateManifest(marketplace, allTypes[0] ?? pt)
      const { requiredByType, lengthByType } = buildPerTypeValidation(manifest)
      const fallbackRequired = manifest.groups
        .flatMap((g) => g.columns)
        .filter((c) => c.required)
        .map((c) => ({ id: c.id, label: c.labelEn }))
      const results = validateImportRows(rows, requiredByType, fallbackRequired, 'item_sku', lengthByType)
      return reply.send({ results, rowsWithIssues: results.length, total: rows.length })
    } catch (err: any) {
      request.log.error(err, 'flat-file/validate-rows failed')
      return reply.code(500).send({ error: err?.message ?? 'Validation failed' })
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

  // ── POST /api/amazon/flat-file/export ───────────────────────────────
  // FX.1 — export the current grid to a downloadable file. Three formats:
  //   • tsv  → Amazon flat-file template (metadata + 4 header rows) for
  //            Seller Central manual upload + a lossless self round-trip.
  //   • csv  → clean single-header CSV (English labels) for external tools.
  //   • xlsx → clean single-header Excel workbook.
  // The caller sends the (possibly union/multi-category) manifest + the rows it
  // wants to export (all, or a selected subset), so partial export is just a
  // smaller `rows`.
  fastify.post<{
    Body: { manifest: any; rows: any[]; format?: 'tsv' | 'csv' | 'xlsx' }
  }>('/amazon/flat-file/export', async (request, reply) => {
    const { manifest, rows, format = 'tsv' } = request.body
    if (!manifest || !rows) {
      return reply.code(400).send({ error: 'manifest and rows required' })
    }
    const pt = String(manifest.productType ?? 'flat_file')
    const mp = String(manifest.marketplace ?? '')
    const stamp = Date.now()
    try {
      if (format === 'tsv') {
        const tsv = flatFileService.buildTsvExport(manifest, rows)
        reply.header('Content-Type', 'text/tab-separated-values; charset=utf-8')
        reply.header('Content-Disposition', `attachment; filename="amazon_${pt}_${mp}_${stamp}.txt"`)
        return reply.send(tsv)
      }
      if (format !== 'csv' && format !== 'xlsx') {
        return reply.code(400).send({ error: `Unsupported export format "${format}"` })
      }
      // Amazon flat-file values are single-line; collapse any embedded newline/tab
      // inside a cell to a space so one record never splits across physical lines
      // (the thing that makes Numbers/Excel show "missing"/misaligned columns).
      // Mirrors buildTsvExport's behaviour for parity.
      const flatRows = (rows as Record<string, unknown>[]).map((r) => {
        const o: Record<string, unknown> = {}
        for (const k of Object.keys(r)) {
          const v = r[k]
          o[k] = typeof v === 'string' ? v.replace(/[\t\r\n]+/g, ' ').replace(/ {2,}/g, ' ').trim() : v
        }
        return o
      })
      const { bytes, contentType } = await renderExport({
        format,
        columns: flatFileExportColumns(manifest),
        rows: flatRows,
        filename: `amazon_${pt}_${mp}`,
      })
      let outBytes = bytes
      if (format === 'csv') {
        // UTF-8 BOM so a double-click opens as UTF-8 in Numbers/Excel and Italian
        // accents (à, è, ò…) render correctly. Re-import strips it (FX.6a BOM strip).
        const bom = new Uint8Array([0xef, 0xbb, 0xbf])
        outBytes = new Uint8Array(bom.length + bytes.length)
        outBytes.set(bom)
        outBytes.set(bytes, bom.length)
      }
      reply.header('Content-Type', format === 'csv' ? 'text/csv; charset=utf-8' : contentType)
      reply.header('Content-Disposition', `attachment; filename="amazon_${pt}_${mp}_${stamp}.${format}"`)
      return reply.send(Buffer.from(outBytes))
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

    // PD.2 — fetch-images is a READ (searchCatalogItems); skip only when the
    // Amazon integration is fully gated (publishing disabled). Reads are safe in
    // dry-run/sandbox/live. Was the legacy NEXUS_AMAZON_BATCH_DRYRUN flag.
    if (getAmazonPublishMode() === 'gated') return reply.send({ images: {} })

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
            // FFA.6 — enqueue from the listing's own (already-synced) qty/price; the
            // dead `rows.find(()=>true)` placeholder was removed (it matched the
            // first row regardless of SKU and was never used).
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

  // ── POST /api/amazon/flat-file/pull-preview/start ───────────────────
  // In-editor variant of the reconciliation pull. Calls SP-API
  // getListingsItem per SKU, builds expanded flat-file rows in memory,
  // and returns them via the job status endpoint. Does NOT write to the
  // database — the editor merges the rows into its local state where the
  // user can review, undo (Cmd+Z), and save on their own terms.
  fastify.post<{
    Body: { marketplace?: string; productType?: string; skus?: string[] }
  }>('/amazon/flat-file/pull-preview/start', async (request, reply) => {
    const { marketplace = 'IT', productType = '', skus } = request.body ?? {}
    if (!productType?.trim()) {
      return reply.code(400).send({ error: 'productType is required' })
    }
    const jobId = startPullPreviewJob({
      marketplace,
      productType,
      skus: Array.isArray(skus) && skus.length > 0 ? skus : undefined,
    })
    return reply.send({ jobId })
  })

  // ── GET /api/amazon/flat-file/pull-preview/status/:jobId ────────────
  fastify.get<{ Params: { jobId: string } }>(
    '/amazon/flat-file/pull-preview/status/:jobId',
    async (request, reply) => {
      const job = getPullPreviewJobStatus(request.params.jobId)
      if (!job) return reply.code(404).send({ error: 'Job not found or expired' })
      return reply.send(job)
    },
  )

  // ── POST /api/amazon/flat-file/pull-preview/apply ───────────────────
  // Audit-log endpoint. Called by the editor's diff-preview modal after
  // the operator confirms what to merge. Records the result of the pull
  // — does NOT itself touch product or listing data; those writes go
  // through the editor's normal Save flow.
  fastify.post<{
    Body: {
      jobId?: string
      marketplace?: string
      productType?: string
      skusRequested?: string[]
      skusReturned?: number
      columnsApplied?: string[]
      rowsApplied?: number
      fieldsApplied?: number
      operatorNote?: string
    }
  }>('/amazon/flat-file/pull-preview/apply', async (request, reply) => {
    const {
      jobId,
      marketplace = 'IT',
      productType = '',
      skusRequested = [],
      skusReturned = 0,
      columnsApplied = [],
      rowsApplied = 0,
      fieldsApplied = 0,
      operatorNote,
    } = request.body ?? {}

    if (!productType.trim()) {
      return reply.code(400).send({ error: 'productType is required' })
    }

    try {
      const record = await prisma.flatFilePullRecord.create({
        data: {
          channel: 'AMAZON',
          marketplace: marketplace.toUpperCase(),
          productType: productType.toUpperCase(),
          jobId: jobId ?? null,
          skusRequested,
          skusReturned,
          columnsApplied,
          rowsApplied,
          fieldsApplied,
          appliedAt: new Date(),
          operatorNote: operatorNote ?? null,
        },
        select: { id: true, pulledAt: true, appliedAt: true },
      })
      return reply.send({ ok: true, id: record.id })
    } catch (err: any) {
      request.log.error(err, '[amazon/flat-file/pull-preview/apply] failed')
      return reply.code(500).send({ error: err?.message ?? 'Audit write failed' })
    }
  })
}
