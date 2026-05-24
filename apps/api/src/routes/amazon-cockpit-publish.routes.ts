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
}

/** Build a flat-file row from a ChannelListing + product. Pulls the
 *  same shape the flat-file editor would produce so the SP-API call
 *  receives identical attribute envelopes. */
function buildRow(args: {
  listing: any
  product: any
  marketplace: string
}): Record<string, unknown> {
  const { listing, product, marketplace } = args
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
    row.parent_sku = product.parentId
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
    const envDryRun = process.env.NEXUS_AMAZON_BATCH_DRYRUN === '1'
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
        const listing = await prisma.channelListing.findFirst({
          where: { productId: id, channel: 'AMAZON', marketplace: mp },
        })
        if (!listing) {
          result.error = `No Amazon ChannelListing for marketplace ${mp} — create it via the classic editor first.`
          submissions.push(result)
          continue
        }

        const row = buildRow({ listing, product, marketplace: mp })
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

        const feedBody = flatFileService.buildJsonFeedBody(
          [row as any],
          mp,
          sellerId,
        )

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

        submissions.push({
          ...result,
          ok: true,
          feedId: feedRes.feedId,
          feedDocumentId: docRes.feedDocumentId,
          messageCount: 1,
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
