/**
 * DD.4 — eBay publish adapter (Inventory API).
 *
 * Three-step flow per eBay's modern selling stack:
 *   1. PUT  /sell/inventory/v1/inventory_item/{sku}
 *   2. POST /sell/inventory/v1/offer
 *   3. POST /sell/inventory/v1/offer/{offerId}/publish
 *
 * NOT END-TO-END TESTED — wiring is real but exercising it requires
 * eBay developer credentials + a sandbox/production seller account
 * with policies (payment, return, fulfillment) attached. See
 * TECH_DEBT #35 for the gating items.
 *
 * The adapter never throws; it returns either a success result with
 * the offerId and listingId or a failure result with the eBay error
 * message. The caller (channel-publish.service.ts) maps that into a
 * SubmissionEntry.
 */

import prisma from '../../db.js'
import { ebayAuthService } from '../ebay-auth.service.js'
import { ebayAccountService } from '../ebay-account.service.js'
import { EbayCategoryService } from '../ebay-category.service.js'

const ebayCategoryService = new EbayCategoryService()

export interface EbayPublishResult {
  ok: boolean
  /** eBay InventoryItem.sku — the same one we sent. */
  sku?: string
  /** Created offer id. */
  offerId?: string
  /** eBay item/listing id once the offer is published. */
  listingId?: string
  /** Public marketplace URL. */
  listingUrl?: string
  /** Human-readable error when ok=false. */
  error?: string
  /** Which step failed (createInventory|createOffer|publishOffer). */
  failedStep?: string
}

interface EbayPayload {
  sku?: string
  marketplaceId?: string
  categoryId?: string
  product?: {
    title?: string
    description?: string
    aspects?: Record<string, string[]>
    imageUrls?: string[]
  }
  availability?: {
    shipToLocationAvailability?: { quantity?: number }
  }
  condition?: string
  price?: { value: number; currency: string }
}

export class EbayPublishAdapter {
  async publish(payload: EbayPayload): Promise<EbayPublishResult> {
    if (!payload.sku) {
      return { ok: false, error: 'sku is required for eBay publish.' }
    }
    if (!payload.marketplaceId) {
      return { ok: false, error: 'marketplaceId is required (e.g. EBAY_IT).' }
    }
    if (!payload.categoryId) {
      return { ok: false, error: 'categoryId is required for eBay publish.' }
    }

    // Pick the first active eBay connection. Multi-account support
    // keys off marketplaceId once that lands.
    const connection = await prisma.channelConnection.findFirst({
      where: { channelType: 'EBAY', isActive: true },
      orderBy: { updatedAt: 'desc' },
    })
    if (!connection) {
      return {
        ok: false,
        error:
          'No active eBay connection — link an eBay account in Settings first.',
      }
    }

    let token: string
    try {
      token = await ebayAuthService.getValidToken(connection.id)
    } catch (err) {
      return {
        ok: false,
        error: `Could not obtain eBay token: ${
          err instanceof Error ? err.message : String(err)
        }`,
      }
    }

    const apiBase = process.env.EBAY_API_BASE ?? 'https://api.ebay.com'
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Content-Language': contentLanguageFor(payload.marketplaceId),
      Accept: 'application/json',
    }

    // ── Step 1: createOrReplaceInventoryItem ─────────────────────
    const inventoryBody = {
      product: {
        title: payload.product?.title ?? '',
        description: payload.product?.description ?? '',
        aspects: payload.product?.aspects ?? {},
        imageUrls: payload.product?.imageUrls ?? [],
      },
      condition: payload.condition ?? 'NEW',
      availability: payload.availability ?? {
        shipToLocationAvailability: { quantity: 1 },
      },
    }
    const invRes = await fetch(
      `${apiBase}/sell/inventory/v1/inventory_item/${encodeURIComponent(
        payload.sku,
      )}`,
      {
        method: 'PUT',
        headers,
        body: JSON.stringify(inventoryBody),
      },
    )
    if (!invRes.ok && invRes.status !== 204) {
      const body = await invRes.text().catch(() => '')
      return {
        ok: false,
        sku: payload.sku,
        failedStep: 'createInventory',
        error: `createOrReplaceInventoryItem ${invRes.status}: ${body.slice(
          0,
          500,
        )}`,
      }
    }

    // ── Step 2: createOffer ──────────────────────────────────────
    // Fulfillment / payment / return policies are required for a
    // publishable offer. Read pre-configured ids from
    // ChannelConnection.connectionMetadata.ebayPolicies first
    // (deterministic — what the user explicitly chose). When any
    // are missing, GG.2 falls back to the seller's first-active
    // policy of each kind from the live Account API so the wizard
    // doesn't hard-fail on a fresh account.
    const meta = (connection.connectionMetadata ?? {}) as Record<
      string,
      unknown
    >
    const configured = ((meta.ebayPolicies ?? {}) as {
      fulfillmentPolicyId?: string
      paymentPolicyId?: string
      returnPolicyId?: string
      merchantLocationKey?: string
    })
    const policies = {
      fulfillmentPolicyId: configured.fulfillmentPolicyId,
      paymentPolicyId: configured.paymentPolicyId,
      returnPolicyId: configured.returnPolicyId,
      merchantLocationKey: configured.merchantLocationKey,
    }
    if (
      !policies.fulfillmentPolicyId ||
      !policies.paymentPolicyId ||
      !policies.returnPolicyId ||
      !policies.merchantLocationKey
    ) {
      try {
        const snapshot = await ebayAccountService.getSnapshot(
          connection.id,
          payload.marketplaceId,
        )
        if (!policies.fulfillmentPolicyId) {
          policies.fulfillmentPolicyId =
            snapshot.fulfillmentPolicies[0]?.id
        }
        if (!policies.paymentPolicyId) {
          policies.paymentPolicyId = snapshot.paymentPolicies[0]?.id
        }
        if (!policies.returnPolicyId) {
          policies.returnPolicyId = snapshot.returnPolicies[0]?.id
        }
        if (!policies.merchantLocationKey) {
          policies.merchantLocationKey = snapshot.locations[0]?.key
        }
      } catch (err) {
        return {
          ok: false,
          sku: payload.sku,
          failedStep: 'createOffer',
          error: `Could not fetch seller policies via Account API: ${
            err instanceof Error ? err.message : String(err)
          }`,
        }
      }
    }
    if (
      !policies.fulfillmentPolicyId ||
      !policies.paymentPolicyId ||
      !policies.returnPolicyId ||
      !policies.merchantLocationKey
    ) {
      const missing: string[] = []
      if (!policies.fulfillmentPolicyId) missing.push('fulfillment')
      if (!policies.paymentPolicyId) missing.push('payment')
      if (!policies.returnPolicyId) missing.push('return')
      if (!policies.merchantLocationKey) missing.push('merchantLocation')
      return {
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: `Seller has no ${missing.join(' / ')} policy/location for ${payload.marketplaceId}. Create one in eBay Seller Hub or set ChannelConnection.connectionMetadata.ebayPolicies.`,
      }
    }

    // GG.1 — validate the picked condition against eBay's live policy
    // for this category. Submitting a condition the category rejects
    // is a hard publish error; better to surface it before the round
    // trip.
    const requestedCondition = payload.condition ?? 'NEW'
    try {
      const allowedConditions =
        await ebayCategoryService.getItemConditionPolicies(
          payload.categoryId,
          payload.marketplaceId,
        )
      if (allowedConditions.length > 0) {
        const ok = allowedConditions.some(
          (c) =>
            c.conditionDescription.toUpperCase().replace(/\s+/g, '_') ===
              requestedCondition.toUpperCase() ||
            c.conditionId === requestedCondition,
        )
        if (!ok) {
          const labels = allowedConditions
            .map((c) => c.conditionDescription)
            .join(', ')
          return {
            ok: false,
            sku: payload.sku,
            failedStep: 'createInventory',
            error: `Condition "${requestedCondition}" not allowed for category ${payload.categoryId} on ${payload.marketplaceId}. Allowed: ${labels}.`,
          }
        }
      }
    } catch {
      // Soft-fail: condition lookup is advisory. Let eBay return the
      // canonical error if it disagrees.
    }

    const offerBody: Record<string, unknown> = {
      sku: payload.sku,
      marketplaceId: payload.marketplaceId,
      format: 'FIXED_PRICE',
      categoryId: payload.categoryId,
      listingPolicies: {
        fulfillmentPolicyId: policies.fulfillmentPolicyId,
        paymentPolicyId: policies.paymentPolicyId,
        returnPolicyId: policies.returnPolicyId,
      },
      merchantLocationKey: policies.merchantLocationKey,
      availableQuantity:
        payload.availability?.shipToLocationAvailability?.quantity ?? 1,
    }
    if (payload.price) {
      offerBody.pricingSummary = {
        price: {
          value: String(payload.price.value),
          currency: payload.price.currency,
        },
      }
    }

    const offerRes = await fetch(`${apiBase}/sell/inventory/v1/offer`, {
      method: 'POST',
      headers,
      body: JSON.stringify(offerBody),
    })
    if (!offerRes.ok) {
      const body = await offerRes.text().catch(() => '')
      return {
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: `createOffer ${offerRes.status}: ${body.slice(0, 500)}`,
      }
    }
    const offerJson = (await offerRes.json().catch(() => null)) as {
      offerId?: string
    } | null
    const offerId = offerJson?.offerId
    if (!offerId) {
      return {
        ok: false,
        sku: payload.sku,
        failedStep: 'createOffer',
        error: 'createOffer succeeded but returned no offerId.',
      }
    }

    // ── Step 3: publishOffer ─────────────────────────────────────
    const pubRes = await fetch(
      `${apiBase}/sell/inventory/v1/offer/${encodeURIComponent(
        offerId,
      )}/publish`,
      {
        method: 'POST',
        headers,
      },
    )
    if (!pubRes.ok) {
      const body = await pubRes.text().catch(() => '')
      return {
        ok: false,
        sku: payload.sku,
        offerId,
        failedStep: 'publishOffer',
        error: `publishOffer ${pubRes.status}: ${body.slice(0, 500)}`,
      }
    }
    const pubJson = (await pubRes.json().catch(() => null)) as {
      listingId?: string
    } | null
    const listingId = pubJson?.listingId

    return {
      ok: true,
      sku: payload.sku,
      offerId,
      listingId,
      listingUrl: listingId
        ? marketplaceListingUrl(payload.marketplaceId, listingId)
        : undefined,
    }
  }
}

const MARKETPLACE_LANG: Record<string, string> = {
  EBAY_IT: 'it-IT',
  EBAY_DE: 'de-DE',
  EBAY_FR: 'fr-FR',
  EBAY_ES: 'es-ES',
  EBAY_GB: 'en-GB',
  EBAY_US: 'en-US',
  EBAY_AU: 'en-AU',
  EBAY_CA: 'en-CA',
}

function contentLanguageFor(marketplaceId: string): string {
  return MARKETPLACE_LANG[marketplaceId] ?? 'en-US'
}

const MARKETPLACE_HOST: Record<string, string> = {
  EBAY_IT: 'ebay.it',
  EBAY_DE: 'ebay.de',
  EBAY_FR: 'ebay.fr',
  EBAY_ES: 'ebay.es',
  EBAY_GB: 'ebay.co.uk',
  EBAY_US: 'ebay.com',
  EBAY_AU: 'ebay.com.au',
  EBAY_CA: 'ebay.ca',
}

function marketplaceListingUrl(
  marketplaceId: string,
  listingId: string,
): string {
  const host = MARKETPLACE_HOST[marketplaceId] ?? 'ebay.com'
  return `https://www.${host}/itm/${encodeURIComponent(listingId)}`
}
