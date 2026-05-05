/**
 * E.8 — Amazon publish adapter (SP-API Listings Items v2021-08-01).
 *
 * Flow:
 *   1. PUT  /listings/2021-08-01/items/{sellerId}/{parentSku}    parent
 *   2. PUT  /listings/2021-08-01/items/{sellerId}/{childSku} … N children
 *   3. GET  /listings/2021-08-01/items/{sellerId}/{parentSku}    parent ASIN
 *   4. GET  /listings/2021-08-01/items/{sellerId}/{childSku} … N child ASINs
 *
 * Each child gets its own putListingsItem call with parentage_level=child
 * + child_relationship_type=variation + child_parent_sku_relationship
 * pointing at the parent's marketplace-scoped SKU. The composer
 * (submission.service.ts) doesn't currently emit the wrapped child
 * attribute envelopes — this adapter expands payload.children[] into
 * the SP-API shape inline.
 *
 * NOT END-TO-END TESTED — wiring is real but exercising it requires:
 *   - AMAZON_CLIENT_ID + AMAZON_CLIENT_SECRET + AMAZON_REFRESH_TOKEN env
 *   - AMAZON_SELLER_ID env (the seller's SP-API seller token)
 *   - AMAZON_REGION env matching the marketplace's SP-API region
 *     (eu-west-1 for IT/DE/FR/ES, us-east-1 for US/CA/MX, etc.)
 * Until creds are configured, expect 401/403 from LWA.
 *
 * The adapter never throws; returns ok=false with the SP-API error
 * surface so the wizard's submissions log shows actionable errors.
 */

import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'
import { logger } from '../../utils/logger.js'

interface AmazonPayload {
  productType: string
  marketplaceId: string
  attributes: Record<string, unknown>
  parentSku?: string
  childSkus?: string[]
  children?: Array<{
    masterSku: string
    channelSku: string
    channelProductId: string | null
    variationAttributes: Record<string, unknown>
    price: number | null
    quantity: number | null
  }>
  variationTheme?: string
  variationMapping?: Record<string, string>
  imageUrls?: string[]
}

export interface AmazonPublishResult {
  ok: boolean
  /** Resolved parent SKU sent to SP-API. */
  parentSku?: string
  /** Marketplace-scoped child SKUs sent to SP-API (post-strategy resolution). */
  childSkus?: string[]
  /** SP-API submission id from the parent PUT. */
  submissionId?: string
  /** Per-child submission ids, keyed by master SKU. */
  childSubmissionIds?: Record<string, string>
  /** Parent ASIN if the post-publish getListingsItem returned one. */
  parentAsin?: string
  /** Per-child ASIN keyed by master SKU. */
  childAsinsByMasterSku?: Record<string, string>
  /** Human-readable error when ok=false. */
  error?: string
  /** Which step failed (parentPut|childPut|parentRead|childRead). */
  failedStep?: string
}

export class AmazonPublishAdapter {
  /**
   * Publish one (channel, marketplace) listing — parent + every selected
   * child — via SP-API. Returns whatever ASINs the immediate post-publish
   * read picked up; the wizard's poll path can re-call this to land late
   * ASIN assignments.
   */
  async publish(payload: AmazonPayload): Promise<AmazonPublishResult> {
    const sellerId =
      process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
    if (!sellerId) {
      return {
        ok: false,
        error:
          'AMAZON_SELLER_ID is not configured. Set the env var to the SP-API merchant token before publishing.',
        failedStep: 'config',
      }
    }
    if (!payload.parentSku) {
      return {
        ok: false,
        error: 'Composed payload is missing parentSku — wizard state has no master product SKU.',
        failedStep: 'config',
      }
    }
    if (!payload.marketplaceId) {
      return {
        ok: false,
        error: 'Composed payload is missing SP-API marketplaceId — Marketplace lookup failed.',
        failedStep: 'config',
      }
    }
    if (!payload.productType) {
      return {
        ok: false,
        error: 'Composed payload is missing productType — Step 3 not completed.',
        failedStep: 'config',
      }
    }

    const parentSku = payload.parentSku
    const children = Array.isArray(payload.children) ? payload.children : []

    // ── Step 1: PUT parent ───────────────────────────────────────────
    const parentResult = await amazonSpApiClient.putListingsItem({
      sellerId,
      sku: parentSku,
      marketplaceId: payload.marketplaceId,
      productType: payload.productType,
      attributes: payload.attributes,
      requirements: 'LISTING',
    })
    if (!parentResult.success) {
      return {
        ok: false,
        parentSku,
        error: parentResult.error ?? 'Parent putListingsItem failed.',
        failedStep: 'parentPut',
      }
    }

    // ── Step 2: PUT each child ──────────────────────────────────────
    const childSkusSent: string[] = []
    const childSubmissionIds: Record<string, string> = {}
    if (children.length > 0 && payload.variationTheme) {
      for (const child of children) {
        const childAttributes = this.buildChildAttributes({
          parentSku,
          marketplaceId: payload.marketplaceId,
          variationTheme: payload.variationTheme,
          variationAttributes: child.variationAttributes,
          variationMapping: payload.variationMapping,
          price: child.price,
          quantity: child.quantity,
        })

        const childResult = await amazonSpApiClient.putListingsItem({
          sellerId,
          sku: child.channelSku,
          marketplaceId: payload.marketplaceId,
          productType: payload.productType,
          attributes: childAttributes,
          requirements: 'LISTING',
        })
        childSkusSent.push(child.channelSku)
        if (!childResult.success) {
          return {
            ok: false,
            parentSku,
            childSkus: childSkusSent,
            submissionId: parentResult.submissionId,
            error: `Child ${child.channelSku} putListingsItem failed: ${childResult.error ?? 'unknown'}`,
            failedStep: 'childPut',
          }
        }
        if (childResult.submissionId) {
          childSubmissionIds[child.masterSku] = childResult.submissionId
        }
      }
    }

    // ── Step 3: read back the parent ASIN ────────────────────────────
    // Amazon assigns ASINs asynchronously after PUT; the immediate read
    // often returns null. Caller polls via the wizard /poll endpoint to
    // pick up the assignment when it lands. The first attempt here lets
    // us surface ASINs that landed in the same request cycle.
    const parentRead = await amazonSpApiClient.getListingsItem({
      sellerId,
      sku: parentSku,
      marketplaceId: payload.marketplaceId,
      includedData: ['summaries'],
    })
    const parentAsin = parentRead.success ? parentRead.asin ?? undefined : undefined

    // ── Step 4: read back each child ASIN (best-effort) ──────────────
    const childAsinsByMasterSku: Record<string, string> = {}
    for (const child of children) {
      const childRead = await amazonSpApiClient.getListingsItem({
        sellerId,
        sku: child.channelSku,
        marketplaceId: payload.marketplaceId,
        includedData: ['summaries'],
      })
      if (childRead.success && childRead.asin) {
        childAsinsByMasterSku[child.masterSku] = childRead.asin
      }
    }

    logger.info('Amazon publish adapter completed', {
      parentSku,
      childCount: children.length,
      parentAsinResolved: !!parentAsin,
      childAsinsResolved: Object.keys(childAsinsByMasterSku).length,
    })

    return {
      ok: true,
      parentSku,
      childSkus: childSkusSent,
      submissionId: parentResult.submissionId,
      childSubmissionIds:
        Object.keys(childSubmissionIds).length > 0 ? childSubmissionIds : undefined,
      parentAsin,
      childAsinsByMasterSku:
        Object.keys(childAsinsByMasterSku).length > 0
          ? childAsinsByMasterSku
          : undefined,
    }
  }

  /**
   * Build the wrapped attribute envelope for a child PUT call. SP-API
   * needs parentage_level + child_parent_sku_relationship + the variation
   * theme axis values, plus a purchasable_offer if we have price/qty.
   *
   * Audit-fix #4 — Axis attribute names come from the per-marketplace
   * `variationMapping` (ChannelListing.variationMapping, e.g.
   * { Size: 'size_name', Color: 'color_name' }). Falls back to a
   * `_name`-suffixed axis name (`size_name`, `color_name`) which is the
   * dominant SP-API convention for fashion / apparel / consumer goods —
   * correct for Xavia's motorcycle-gear catalog. Edge categories (e.g.
   * BAG → `bag_size_name`, ELECTRONICS → `model_name`) need a real entry
   * in variationMapping; without one, SP-API returns a clear "unknown
   * attribute" issue that surfaces on the FAILED submission.
   */
  private buildChildAttributes(args: {
    parentSku: string
    marketplaceId: string
    variationTheme: string
    variationAttributes: Record<string, unknown>
    variationMapping?: Record<string, string>
    price: number | null
    quantity: number | null
  }): Record<string, unknown> {
    const {
      parentSku,
      marketplaceId,
      variationTheme,
      variationAttributes,
      variationMapping,
      price,
    } = args

    const wrap = (value: unknown) => ({ marketplace_id: marketplaceId, value })

    const out: Record<string, unknown> = {
      parentage_level: [wrap('child')],
      child_parent_sku_relationship: [
        {
          marketplace_id: marketplaceId,
          child_relationship_type: 'variation',
          parent_sku: parentSku,
        },
      ],
      variation_theme: [
        { marketplace_id: marketplaceId, name: variationTheme },
      ],
    }

    // Variation axis values — each axis (Size, Color, ...) becomes its own
    // SP-API attribute. Mapping precedence: explicit variationMapping →
    // `<axis>_name` fallback. Original-cased axes (like "Size") are
    // accepted as-is too if mapping omits them and the lowercase form
    // doesn't exist on the productType.
    for (const [axis, value] of Object.entries(variationAttributes)) {
      if (value === undefined || value === null || value === '') continue
      const mapped = variationMapping?.[axis] ?? variationMapping?.[axis.toLowerCase()]
      const attrName = mapped ?? `${axis.toLowerCase()}_name`
      out[attrName] = [wrap(value)]
    }

    // Pricing — purchasable_offer envelope if we have a price.
    if (typeof price === 'number' && price > 0) {
      out.purchasable_offer = [
        {
          marketplace_id: marketplaceId,
          our_price: [{ schedule: [{ value_with_tax: price }] }],
        },
      ]
    }

    return out
  }
}
