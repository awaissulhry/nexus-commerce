import { closedMarketSet } from '../services/amazon-market-offer.service.js'
import { assertPushAllowed } from '@nexus/shared/push-lock'
import { getAmazonSellerId } from '../lib/amazon-sp-client.js'
import { amazonSpClient } from '../lib/amazon-sp-client.js'
/**
 * AC.12 — Amazon Listing Cockpit publish endpoint.
 *
 *   POST /api/products/:id/publish-amazon
 *     Body: { marketplaces: string[]; dryRun?: boolean }
 *
 * Multi-market submit for a single product. For each marketplace
 * the endpoint:
 *
 *   1. Looks up the active ChannelListing for (product, AMAZON,
 *      marketplace).
 *   2. Builds a single JSON_LISTINGS_FEED row from
 *      listing.platformAttributes + listing.title/description/
 *      bullets/price/quantity + product.brand/sku/productType.
 *   3. Reuses AmazonFlatFileService.buildJsonFeedBody to produce
 *      the SP-API payload — the SAME service the flat-file route
 *      uses, so the row schema and JSON envelope stay in lock-step
 *      without touching /products/amazon-flat-file.
 *   4. Calls SP-API createFeedDocument → upload → createFeed.
 *   5. Returns the feedId so the cockpit can poll the existing
 *      /api/amazon/flat-file/feeds/:feedId endpoint for status.
 *
 * Lives in its own route file so the constraint "zero changes to
 * /products/amazon-flat-file" (which targets the page + its routes
 * file) is unambiguous — we share only the underlying SERVICE.
 */

import type { FastifyInstance } from 'fastify'
import prisma from '../db.js'
import { primaryConnectionIds } from '../services/connection-resolver.service.js'
import { resolveBatch } from '../services/pim/mapping/resolve-batch.service.js'
import { loadAmazonSpec } from '../services/pim/channel-specs/index.js'
import { applyResolvedMappingToAmazonFeed, type AttributePatch } from '../services/amazon/mapping-payload.js'
import { CategorySchemaService } from '../services/categories/schema-sync.service.js'
import { AmazonService } from '../services/marketplaces/amazon.service.js'
import {
  AmazonFlatFileService,
  MARKETPLACE_ID_MAP,
} from '../services/amazon/flat-file.service.js'
import { getAmazonPublishMode } from '../services/amazon-publish-gate.service.js'
import { checkLengthLimits, type LengthColumn } from '../services/listing-preflight.service.js'
import { amazonSpApiClient } from '../clients/amazon-sp-api.client.js'
import { mirrorListingIssues } from '../services/listing-issues.service.js'

const amazon = new AmazonService()
const schemaService = new CategorySchemaService(prisma, amazon)
const flatFileService = new AmazonFlatFileService(prisma, schemaService)

async function getSellerId(): Promise<string> {
  return (await getAmazonSellerId())
}

function getSpClient() { return amazonSpClient() }

interface SubmissionResult {
  marketplace: string
  ok: boolean
  feedId: string | null
  feedDocumentId: string | null
  messageCount: number
  dryRun: boolean
  payload?: unknown
  validation?: 'local-only' | 'verified' | 'unavailable'
  error: string | null
  /** ALA Phase 3 — Amazon VALIDATION_PREVIEW issues array (when the pre-check ran). */
  issues?: unknown
  /** Non-blocking VALIDATION_PREVIEW warnings worth surfacing to the operator. */
  warnings?: Array<{ code: string; message: string; severity: 'WARNING' | 'INFO'; attributeNames?: string[] }>
}

export { buildRow, COCKPIT_EXPANDED_FIELDS } from '../services/amazon/cockpit-publish-row.js'
import { buildRow, COCKPIT_EXPANDED_FIELDS } from '../services/amazon/cockpit-publish-row.js'

export default async function amazonCockpitPublishRoutes(
  fastify: FastifyInstance,
) {
  fastify.post<{
    Params: { id: string }
    Body: { marketplaces?: string[]; dryRun?: boolean; channelConnectionId?: string; aliasKey?: string }
  }>('/products/:id/publish-amazon', async (request, reply) => {
    const { id } = request.params
    const body = request.body ?? {}
    const marketplaces = Array.isArray(body.marketplaces)
      ? body.marketplaces
          .map((m) => String(m).toUpperCase().trim())
          .filter(Boolean)
      : []
    const dryRunRequested = body.dryRun === true
    // A1.2 — unified publish gate (master flag + mode) instead of the legacy
    // NEXUS_AMAZON_BATCH_DRYRUN.
    const envDryRun = getAmazonPublishMode() !== 'live'
    const dryRun = dryRunRequested || envDryRun

    if (marketplaces.length === 0) {
      return reply.code(400).send({ error: 'marketplaces[] required' })
    }
    if (marketplaces.length > 10) {
      return reply.code(400).send({
        error: 'Max 10 marketplaces per publish call',
      })
    }

    const primaryAccount = (await primaryConnectionIds(['AMAZON'])).get('AMAZON') ?? null
    const account = body.channelConnectionId ?? primaryAccount
    if (!dryRun && account !== primaryAccount) return reply.code(409).send({ error: 'This publisher supports the primary Amazon account. Use the account-specific publishing workflow for another account.' })
    const sellerId = await getSellerId()
    if (!sellerId && !dryRun) {
      return reply.code(503).send({
        error: 'AMAZON_SELLER_ID not configured (set or use dryRun:true)',
      })
    }

    const product = await prisma.product.findUnique({
      where: { id },
      include: {
        images: {
          select: { url: true, isPrimary: true, sortOrder: true, type: true },
        },
      },
    })
    if (!product) {
      return reply.code(404).send({ error: 'Product not found' })
    }

    // HIGH-4 — resolve the parent's seller SKU once; buildRow needs the SKU, not
    // the internal parentId UUID, for the child→parent variation relationship.
    let parentSku: string | null = null
    if (product.parentId) {
      const parent = await prisma.product.findUnique({
        where: { id: product.parentId },
        select: { sku: true },
      })
      parentSku = parent?.sku ?? null
    }

    // SP-API client is loaded once and reused across markets — the
    // SDK handles per-marketplace request routing via marketplaceIds.
    let sp: any = null
    if (!dryRun) {
      try {
        sp = await getSpClient()
      } catch (err: any) {
        return reply.code(503).send({
          error: err?.message ?? 'SP-API client init failed',
        })
      }
    }

    const submissions: SubmissionResult[] = []

    for (const mp of marketplaces) {
      const marketplaceId =
        MARKETPLACE_ID_MAP[mp] ?? MARKETPLACE_ID_MAP.IT
      let result: SubmissionResult = {
        marketplace: mp,
        ok: false,
        feedId: null,
        feedDocumentId: null,
        messageCount: 0,
        dryRun,
        error: null,
      }

      try {
        let listing = await prisma.channelListing.findFirst({
          where: { productId: id, channel: 'AMAZON', marketplace: mp, channelConnectionId: account, aliasKey: body.aliasKey ?? '' },
        })
        if (!listing) throw new Error('Create the listing for this account and market before publishing.')
        const closed = await closedMarketSet([listing.productId])
        const refusal = assertPushAllowed(listing)
          ?? (closed.has(`${listing.productId}|${listing.marketplace.toUpperCase()}`) ? assertPushAllowed({offerClosedAt:'closed'}) : null)
        if (refusal) throw new Error(`${refusal.code}: ${refusal.sentence}`)
        const isNewListing = !listing.isPublished
        const resolved = await resolveBatch({ channel: 'AMAZON', marketplace: mp, channelConnectionId: listing.channelConnectionId,
          aliasKey: listing.aliasKey, productIds: [id] })
        const row = buildRow({ listing, product, marketplace: mp, parentSku })
        // Mark new listings so the feed uses full UPDATE (not partial-update).
        if (isNewListing) (row as any)._isNew = true
        // HIGH-3 — schema-aware build (enum codes, localized fields, number/bool
        // coercion) + bullet expansion, so cockpit publishes match the flat-file
        // path instead of submitting labels and stray bullet attributes.
        let feedSchema: any = {}
        try {
          feedSchema = await flatFileService.getFeedSchemaHints(mp, String(row.product_type ?? ''))
        } catch (err: any) {
          request.log.warn({ err: err?.message, marketplace: mp }, 'cockpit publish: schema hints unavailable')
        }
        const legacyFeedBody = flatFileService.buildJsonFeedBody(
          [row as any],
          mp,
          sellerId,
          COCKPIT_EXPANDED_FIELDS,
          feedSchema,
        )
        const spec = await loadAmazonSpec(mp, resolved.products[0]?.category.channelCategoryId ?? String(row.product_type ?? ''))
        const feedBody = applyResolvedMappingToAmazonFeed(legacyFeedBody, resolved, spec)
        if (dryRun) {
          submissions.push({ ...result, ok: true, messageCount: 1, payload: JSON.parse(feedBody), validation: 'local-only' })
          continue
        }


        // P0 byte-length gate — Amazon enforces maxUtf8ByteLength (UTF-8 bytes),
        // not characters. An accented IT/DE title within its char limit can still
        // blow the byte cap and get rejected after the feed round-trip. Catch it
        // here and block the submit instead. byteLimits is keyed by base field id;
        // expanded keys (bullet_point_1) resolve back via COCKPIT_EXPANDED_FIELDS.
        const byteLimits = (feedSchema?.byteLimits ?? {}) as Record<string, number>
        const lengthCols: LengthColumn[] = Object.keys(row)
          .filter((k) => typeof (row as Record<string, unknown>)[k] === 'string')
          .map((k): LengthColumn | null => {
            const base = COCKPIT_EXPANDED_FIELDS[k] ?? k
            const cap = byteLimits[base]
            return typeof cap === 'number' ? { id: k, label: base, maxUtf8ByteLength: cap } : null
          })
          .filter((c): c is LengthColumn => c !== null)
        const lengthIssues = checkLengthLimits(row as Record<string, any>, lengthCols)
        if (lengthIssues.some((i) => i.severity === 'error')) {
          result.error = `Byte-length validation failed — ${lengthIssues.map((i) => i.message).join('; ')}`
          submissions.push(result)
          continue
        }

        // ALA Phase 3 — VALIDATION_PREVIEW pre-check. Ask Amazon's OWN validation
        // what's wrong with this payload BEFORE the feed round-trip. Mirror the
        // feed's operationType (PATCH for a partial edit, PUT for a new listing)
        // so an unchanged required attr isn't falsely flagged. Non-mutating; it
        // Publication requires a completed check. Unavailable validation is
        // unverified, and must never be represented as a passing preflight.
        let previewWarnings: SubmissionResult['warnings'] = undefined
        try {
          const feedObj = JSON.parse(feedBody) as {
            messages?: Array<{ operationType?: string; productType?: string; attributes?: Record<string, unknown>; patches?: AttributePatch[] }>
          }
          const msg = feedObj.messages?.[0]
          const attrs = (msg?.attributes ?? {}) as Record<string, unknown>
          const opType = String(msg?.operationType ?? '')
          const pt = String(msg?.productType ?? row.product_type ?? '')
          if (opType !== 'DELETE' && (Object.keys(attrs).length > 0 || msg?.patches?.length)) {
            const preview = opType === 'UPDATE'
              ? await amazonSpApiClient.validateListing({
                  sellerId, sku: String(product.sku), marketplaceId, productType: pt, attributes: attrs,
                })
              : await amazonSpApiClient.validateListing({
                  sellerId, sku: String(product.sku), marketplaceId, productType: pt,
                  patches: msg?.patches ?? Object.entries(attrs).map(([k, v]) => ({ op: 'replace', path: `/attributes/${k}`, value: v })),
                })
            if (!preview.available) {
              result.error = 'Amazon validation is unavailable. Nothing was submitted; retry the pre-check when the connection is available.'
              submissions.push(result)
              continue
            }
            if (preview.available) {
              // ALA Phase 4 — mirror Amazon's verdict into ListingIssue so the
              // Pre-Flight health panel reflects this pre-check (open + resolved).
              try {
                await mirrorListingIssues(
                  prisma,
                  listing.id,
                  (preview.issues ?? []).map((i: any) => ({
                    code: i.code, message: i.message, severity: i.severity,
                    attributeNames: i.attributeNames, categories: i.categories,
                  })),
                  'validation-preview',
                )
              } catch (mErr: any) {
                request.log.warn({ err: mErr?.message, marketplace: mp }, 'cockpit publish: mirrorListingIssues failed')
              }
              previewWarnings = preview.warnings.length > 0 ? preview.warnings : undefined
              if (!preview.ok) {
                result.error = `Amazon validation failed (pre-check) — ${preview.errors}`
                result.issues = preview.issues
                result.warnings = previewWarnings
                submissions.push(result)
                continue
              }
            }
          }
        } catch (vErr: any) {
          request.log.warn(
            { err: vErr?.message, marketplace: mp },
            'cockpit publish: VALIDATION_PREVIEW pre-check failed, submission blocked',
          )
          result.error = 'Amazon validation could not complete. Nothing was submitted; retry the pre-check.'
          submissions.push(result)
          continue
        }

        // Step 1: create feed document.
        const docRes: any = await sp.callAPI({
          operation: 'createFeedDocument',
          endpoint: 'feeds',
          body: { contentType: 'application/json; charset=UTF-8' },
        })

        // Step 2: upload body.
        const uploadRes = await fetch(docRes.url, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json; charset=UTF-8' },
          body: feedBody,
        })
        if (!uploadRes.ok) {
          throw new Error(
            `Feed document upload failed: HTTP ${uploadRes.status}`,
          )
        }

        // Step 3: create feed.
        const feedRes: any = await sp.callAPI({
          operation: 'createFeed',
          endpoint: 'feeds',
          body: {
            feedType: 'JSON_LISTINGS_FEED',
            marketplaceIds: [marketplaceId],
            inputFeedDocumentId: docRes.feedDocumentId,
          },
        })

        // ALA Phase 7 — record the schema version this listing was published
        // against (reproducibility: "published against RELEASE_18.1"). Best-effort,
        // namespaced in platformAttributes — no migration; never fails the publish.
        try {
          const pt = String(row.product_type ?? '').toUpperCase()
          const schemaRow = await prisma.categorySchema.findFirst({
            where: { channel: 'AMAZON', marketplace: mp, productType: pt },
            orderBy: { fetchedAt: 'desc' },
            select: { schemaVersion: true },
          })
          const platform = (listing.platformAttributes ?? {}) as Record<string, unknown>
          await prisma.channelListing.update({
            where: { id: listing.id },
            data: {
              platformAttributes: {
                ...platform,
                __alaPublishMeta: {
                  schemaVersion: schemaRow?.schemaVersion ?? null,
                  feedId: feedRes.feedId ?? null,
                  publishedAt: new Date().toISOString(),
                },
              },
            },
          })
        } catch (metaErr: any) {
          request.log.warn({ err: metaErr?.message, marketplace: mp }, 'cockpit publish: schema-version record failed')
        }

        submissions.push({
          ...result,
          ok: true,
          feedId: feedRes.feedId,
          feedDocumentId: docRes.feedDocumentId,
          messageCount: 1,
          warnings: previewWarnings,
        })
      } catch (err: any) {
        result.error = err?.message ?? String(err)
        submissions.push(result)
        request.log.error(
          { err, productId: id, marketplace: mp },
          'cockpit publish-amazon submission failed',
        )
      }
    }

    return reply.send({
      productId: id,
      dryRun,
      submissions,
    })
  })
}
