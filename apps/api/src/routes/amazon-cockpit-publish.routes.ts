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

interface SubmissionResult {
  marketplace: string
  ok: boolean
  feedId: string | null
  feedDocumentId: string | null
  messageCount: number
  dryRun: boolean
  error: string | null
  /** ALA Phase 3 — Amazon VALIDATION_PREVIEW issues array (when the pre-check ran). */
  issues?: unknown
  /** Non-blocking VALIDATION_PREVIEW warnings worth surfacing to the operator. */
  warnings?: Array<{ code: string; message: string; severity: 'WARNING' | 'INFO'; attributeNames?: string[] }>
}

// Bullets are the only multi-instance columns buildRow emits — map bullet_point_N
// → bullet_point so buildJsonFeedBody reassembles them into the bullet_point array
// instead of emitting stray "bullet_point_1" attributes (HIGH-3).
export const COCKPIT_EXPANDED_FIELDS: Record<string, string> = {
  bullet_point_1: 'bullet_point',
  bullet_point_2: 'bullet_point',
  bullet_point_3: 'bullet_point',
  bullet_point_4: 'bullet_point',
}

/** Build a flat-file row from a ChannelListing + product. Pulls the
 *  same shape the flat-file editor would produce so the SP-API call
 *  receives identical attribute envelopes. */
export function buildRow(args: {
  listing: any
  product: any
  marketplace: string
  parentSku?: string | null
}): Record<string, unknown> {
  const { listing, product, marketplace, parentSku } = args
  const platform = (listing.platformAttributes ?? {}) as Record<string, any>
  const attrs = (platform.attributes ?? {}) as Record<string, any>

  // Extract a "first value" from the SP-API-shaped attribute array.
  const pickFirst = (key: string): string | null => {
    const v = attrs[key]
    if (Array.isArray(v) && v.length > 0) {
      const first = v[0]
      if (first && typeof first === 'object' && 'value' in first) {
        return String(first.value ?? '')
      }
    }
    return null
  }

  const productType = String(
    platform.productType ?? product.productType ?? '',
  ).toUpperCase()

  // Bullets — explicit override array wins; otherwise fall back to
  // the attribute envelope.
  const bullets: string[] = Array.isArray(listing.bulletPointsOverride)
    ? (listing.bulletPointsOverride as unknown[]).filter(
        (b): b is string => typeof b === 'string',
      )
    : Array.isArray(attrs.bullet_point)
      ? (attrs.bullet_point as any[])
          .map((b) => (b && typeof b === 'object' ? String(b.value ?? '') : ''))
          .filter(Boolean)
      : []

  const row: Record<string, unknown> = {
    item_sku: product.sku,
    product_type: productType,
    record_action: 'full_update',
    item_name: listing.title ?? product.name ?? pickFirst('item_name') ?? '',
    brand: product.brand ?? pickFirst('brand') ?? '',
    product_description:
      listing.description ??
      product.description ??
      pickFirst('product_description') ??
      '',
    // The flat-file service reads bullet_point as a single value
    // per row; arrays land via expanded sub-columns. For a one-row
    // submit we pass the first bullet here and the rest as
    // _1.._4 keys so buildJsonFeedBody's expansion path picks them
    // up via the EXPLICIT_KEYS branch.
    bullet_point: bullets[0] ?? '',
  }
  // Mirror remaining bullets into bullet_point_1..bullet_point_4
  // so the flat-file service's expanded-column reassembly catches
  // them. (Index 0 is already at bullet_point above.)
  for (let i = 1; i < bullets.length && i < 5; i += 1) {
    row[`bullet_point_${i}`] = bullets[i]
  }

  // Price + currency.
  const priceRaw = listing.priceOverride ?? listing.price ?? product.basePrice
  if (priceRaw != null && priceRaw !== '') {
    const priceNum =
      typeof priceRaw === 'string' ? parseFloat(priceRaw) : Number(priceRaw)
    if (Number.isFinite(priceNum)) {
      row.purchasable_offer__our_price = priceNum.toFixed(2)
      row.purchasable_offer__currency =
        (platform.currency as string | undefined) ?? 'EUR'
      row.purchasable_offer__condition_type =
        (attrs.condition_type as string | undefined) ?? 'new_new'
    }
  }

  // Sale price (optional).
  if (listing.salePrice != null) {
    const sp =
      typeof listing.salePrice === 'string'
        ? parseFloat(listing.salePrice)
        : Number(listing.salePrice)
    if (Number.isFinite(sp)) {
      row.purchasable_offer__sale_price = sp.toFixed(2)
    }
  }

  // Fulfillment + qty.
  const qtyRaw = listing.quantityOverride ?? listing.quantity
  if (qtyRaw != null) {
    const qty = Number(qtyRaw)
    if (Number.isFinite(qty)) {
      row.fulfillment_availability__quantity = qty
    }
  }
  const fch =
    pickFirst('fulfillment_channel_code') ??
    (platform.fulfillment_channel as string | undefined) ??
    null
  if (fch) row.fulfillment_availability__fulfillment_channel_code = fch

  // Main image.
  const mainImg =
    pickFirst('main_product_image_locator') ??
    (Array.isArray(product.images)
      ? product.images.find((i: any) => i?.isPrimary)?.url ??
        product.images[0]?.url ??
        null
      : null)
  if (mainImg) row.main_product_image_locator = mainImg

  // Variation theme + parent/child relationship.
  const variationTheme =
    (platform.variation_theme as string | undefined) ??
    (platform.variationTheme as string | undefined)
  if (variationTheme) row.variation_theme = variationTheme
  if (product.parentId) {
    row.parentage_level = 'child'
    // HIGH-4 — Amazon needs the parent's seller SKU, not our internal UUID.
    if (parentSku) row.parent_sku = parentSku
  } else if (product.isParent) {
    row.parentage_level = 'parent'
  }

  void marketplace
  return row
}

export default async function amazonCockpitPublishRoutes(
  fastify: FastifyInstance,
) {
  fastify.post<{
    Params: { id: string }
    Body: { marketplaces?: string[]; dryRun?: boolean }
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

    const sellerId = getSellerId()
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
          where: { productId: id, channel: 'AMAZON', marketplace: mp },
        })
        // B7 — CREATE path: when no ChannelListing exists yet, auto-create a
        // minimal shell so the publish can proceed. The row is flagged _isNew
        // so buildJsonFeedBody emits operationType:'UPDATE' (full create) rather
        // than 'PARTIAL_UPDATE' (which would be rejected for a brand-new SKU).
        // The operator doesn't need to visit the classic editor to bootstrap a
        // listing — one cockpit publish is enough.
        let isNewListing = false
        if (!listing) {
          const productType = String(product.productType ?? '').toUpperCase()
          listing = await prisma.channelListing.create({
            data: {
              productId: id,
              channel: 'AMAZON',
              marketplace: mp,
              channelMarket: `AMAZON_${mp}`,
              region: mp,
              listingStatus: 'DRAFT',
              platformAttributes: productType ? { productType } : {},
            },
          })
          isNewListing = true
          request.log.info({ productId: id, marketplace: mp }, 'cockpit publish-amazon: created new ChannelListing shell (B7)')
        }

        const row = buildRow({ listing, product, marketplace: mp, parentSku })
        // Mark new listings so the feed uses full UPDATE (not partial-update).
        if (isNewListing) (row as any)._isNew = true
        if (dryRun) {
          submissions.push({
            ...result,
            ok: true,
            feedId: `dryrun-cockpit-${mp}-${Date.now()}`,
            feedDocumentId: `dryrun-doc-${mp}-${Date.now()}`,
            messageCount: 1,
          })
          continue
        }

        // HIGH-3 — schema-aware build (enum codes, localized fields, number/bool
        // coercion) + bullet expansion, so cockpit publishes match the flat-file
        // path instead of submitting labels and stray bullet attributes.
        let feedSchema: any = {}
        try {
          feedSchema = await flatFileService.getFeedSchemaHints(mp, String(row.product_type ?? ''))
        } catch (err: any) {
          request.log.warn({ err: err?.message, marketplace: mp }, 'cockpit publish: schema hints unavailable')
        }
        const feedBody = flatFileService.buildJsonFeedBody(
          [row as any],
          mp,
          sellerId,
          COCKPIT_EXPANDED_FIELDS,
          feedSchema,
        )

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
        // blocks the submit only on Amazon-confirmed ERROR issues. A pre-check
        // that can't run (no creds / transport error) never blocks — we proceed.
        let previewWarnings: SubmissionResult['warnings'] = undefined
        try {
          const feedObj = JSON.parse(feedBody) as {
            messages?: Array<{ operationType?: string; productType?: string; attributes?: Record<string, unknown> }>
          }
          const msg = feedObj.messages?.[0]
          const attrs = (msg?.attributes ?? {}) as Record<string, unknown>
          const opType = String(msg?.operationType ?? '')
          const pt = String(msg?.productType ?? row.product_type ?? '')
          if (opType !== 'DELETE' && Object.keys(attrs).length > 0) {
            const preview = opType === 'UPDATE'
              ? await amazonSpApiClient.validateListing({
                  sellerId, sku: String(product.sku), marketplaceId, productType: pt, attributes: attrs,
                })
              : await amazonSpApiClient.validateListing({
                  sellerId, sku: String(product.sku), marketplaceId, productType: pt,
                  patches: Object.entries(attrs).map(([k, v]) => ({ op: 'replace', path: `/attributes/${k}`, value: v })),
                })
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
            'cockpit publish: VALIDATION_PREVIEW pre-check errored, proceeding to submit',
          )
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
