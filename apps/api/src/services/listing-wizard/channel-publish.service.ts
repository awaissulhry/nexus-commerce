/**
 * Phase J — channel publish dispatcher.
 *
 * One method, `publishToChannel(channelKey, platform, marketplace,
 * payload)`, that hands the prepared payload to a per-platform
 * adapter and reports back. v1 ships every adapter as
 * NOT_IMPLEMENTED with a clear reason — the wizard records the
 * attempt + the prepared payload so the user can see exactly what
 * would go out, and the rebuilt /submit + /retry + /poll endpoints
 * exercise the full flow end-to-end.
 *
 * When the real adapters land (Amazon putListingsItem, Shopify
 * createProduct, etc. — TECH_DEBT #35), they slot in here without
 * changing the wizard surface.
 *
 * DD.4 — eBay branch wired to EbayPublishAdapter (Inventory API).
 * Real call shape, real auth, real error mapping. NOT END-TO-END
 * TESTED — needs eBay developer creds + sandbox seller account +
 * configured policies on ChannelConnection.config.ebayPolicies.
 */

import { AmazonPublishAdapter } from './amazon-publish.adapter.js'
import { EbayPublishAdapter } from './ebay-publish.adapter.js'

export type SubmissionStatus =
  | 'PENDING'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'LIVE'
  | 'FAILED'
  | 'NOT_IMPLEMENTED'

export interface SubmissionEntry {
  channelKey: string
  platform: string
  marketplace: string
  status: SubmissionStatus
  submissionId?: string
  error?: string
  submittedAt: string
  updatedAt: string
  /** Public URL of the listing once LIVE. */
  listingUrl?: string
  /** When status === 'NOT_IMPLEMENTED', a hint at what's missing so
   *  the UI can render an honest banner. */
  notImplementedReason?: string
  /** E.8 — Amazon parent ASIN landed by getListingsItem on or after publish.
   *  Persisted to ChannelListing.externalParentId via SubmissionService.
   *  writeAsinsBack(); kept on the entry too so the wizard UI can render
   *  it without a separate DB read. */
  parentAsin?: string
  /** E.8 — Per-child ASIN map: master SKU → child ASIN. Same persistence
   *  + UI surface logic as parentAsin. */
  childAsinsByMasterSku?: Record<string, string>
}

export interface PublishPayloadInput {
  channelKey: string
  platform: string
  marketplace: string
  payload?: Record<string, unknown>
  unsupported?: boolean
  reason?: string
  /** E.8 — Master Product.id. Threaded through so the publish path can
   *  call SubmissionService.writeAsinsBack() with the right productId
   *  when ASINs land. Optional so callers that don't yet pass it (legacy
   *  paths) still compile; AMAZON branch logs a warning and skips
   *  write-back when missing. */
  productId?: string
}

const NOT_IMPLEMENTED_REASONS: Record<string, string> = {
  AMAZON:
    'Amazon SP-API putListingsItem adapter not yet wired — see TECH_DEBT #35.',
  EBAY: 'eBay listing adapter blocked behind Phase 2A — see TECH_DEBT #35.',
  SHOPIFY:
    'Shopify createProduct exists in apps/api/src/services/marketplaces/shopify.service.ts but is not yet wired into the wizard publish path — see TECH_DEBT #35.',
  WOOCOMMERCE:
    'WooCommerce createProduct not yet implemented — see TECH_DEBT #35.',
}

export class ChannelPublishService {
  private readonly ebayAdapter = new EbayPublishAdapter()
  private readonly amazonAdapter = new AmazonPublishAdapter()

  /**
   * Publish a single (channel, marketplace) listing. Returns a
   * SubmissionEntry describing the attempt. Errors at the adapter
   * level become FAILED entries (not thrown) so the parallel-submit
   * orchestrator can complete every channel without one bad
   * adapter sinking the others.
   */
  async publishToChannel(
    input: PublishPayloadInput,
  ): Promise<SubmissionEntry> {
    const now = new Date().toISOString()
    const base = {
      channelKey: input.channelKey,
      platform: input.platform,
      marketplace: input.marketplace,
      submittedAt: now,
      updatedAt: now,
    }

    // Composer flagged this channel as unsupported (e.g. payload
    // shape can't be built for non-Amazon today). Surface it as
    // NOT_IMPLEMENTED with the composer's reason rather than the
    // generic adapter reason.
    if (input.unsupported) {
      return {
        ...base,
        status: 'NOT_IMPLEMENTED',
        notImplementedReason:
          input.reason ??
          NOT_IMPLEMENTED_REASONS[input.platform.toUpperCase()] ??
          'No publish adapter for this platform.',
      }
    }

    const platform = input.platform.toUpperCase()

    // E.8 — Amazon SP-API adapter. Issues PUT /listings for parent + every
    // child, then GET /listings to read back assigned ASINs. Returns FAILED
    // with the SP-API error message until credentials are configured. ASIN
    // write-back to ChannelListing + VariantChannelListing is async and runs
    // through pollStatus(); the immediate publish call captures whatever
    // ASINs landed inline, but Amazon's catalog assignment is typically
    // delayed by minutes-to-hours.
    if (platform === 'AMAZON') {
      try {
        const result = await this.amazonAdapter.publish(
          (input.payload ?? {}) as unknown as Parameters<
            AmazonPublishAdapter['publish']
          >[0],
        )
        if (!result.ok) {
          return {
            ...base,
            status: 'FAILED',
            error: result.error,
          }
        }
        // ASINs that landed in this request — surface them to the caller so
        // it can persist via SubmissionService.writeAsinsBack(). When the
        // immediate read returns null (typical), pollStatus() picks them up
        // on a later check.
        return {
          ...base,
          status: result.parentAsin ? 'LIVE' : 'SUBMITTED',
          submissionId: result.submissionId,
          parentAsin: result.parentAsin,
          childAsinsByMasterSku: result.childAsinsByMasterSku,
        }
      } catch (err) {
        return {
          ...base,
          status: 'FAILED',
          error:
            err instanceof Error
              ? `Amazon publish exception: ${err.message}`
              : 'Amazon publish exception (unknown).',
        }
      }
    }

    // DD.4 — eBay Inventory API adapter. Real wiring, returns FAILED
    // (not NOT_IMPLEMENTED) when the call fails so the user sees the
    // actual eBay error message. Until creds + policies are
    // configured, expect 401/missing-policy errors.
    if (platform === 'EBAY') {
      try {
        const result = await this.ebayAdapter.publish(
          (input.payload ?? {}) as Parameters<
            EbayPublishAdapter['publish']
          >[0],
        )
        if (!result.ok) {
          return {
            ...base,
            status: 'FAILED',
            error: result.error,
          }
        }
        return {
          ...base,
          status: 'LIVE',
          submissionId: result.offerId,
          listingUrl: result.listingUrl,
        }
      } catch (err) {
        return {
          ...base,
          status: 'FAILED',
          error:
            err instanceof Error
              ? `eBay publish exception: ${err.message}`
              : 'eBay publish exception (unknown).',
        }
      }
    }

    const reason =
      NOT_IMPLEMENTED_REASONS[platform] ??
      `No publish adapter for ${platform}.`

    // v1: remaining platforms return NOT_IMPLEMENTED. Keeping the
    // dispatch structure here so when an adapter lands it just
    // replaces this branch.
    return {
      ...base,
      status: 'NOT_IMPLEMENTED',
      notImplementedReason: reason,
    }
  }

  /**
   * Poll a previously-submitted entry for status updates. Mirrors the
   * publish path: NOT_IMPLEMENTED stays NOT_IMPLEMENTED until an
   * adapter lands. SUBMITTED → LIVE | FAILED transitions belong to the
   * adapter once it's wired.
   *
   * E.8 — Amazon polling: re-reads the parent SKU via getListingsItem.
   * When Amazon's catalog assignment lands, the parent ASIN materializes
   * here; the wizard route writes it back to ChannelListing.externalParentId
   * via SubmissionService.writeAsinsBack(). Children are polled in the same
   * pass for symmetry. AMAZON_SELLER_ID env required.
   */
  async pollStatus(
    entry: SubmissionEntry,
    pollContext?: {
      parentSku?: string
      childMasterSkus?: Array<{ masterSku: string; channelSku: string }>
      marketplaceId?: string
    },
  ): Promise<SubmissionEntry> {
    const platform = entry.platform.toUpperCase()
    if (platform !== 'AMAZON' || !pollContext?.parentSku || !pollContext?.marketplaceId) {
      // Bumping updatedAt so the UI can show "checked recently" honestly
      // even when there's nothing to actively poll.
      return { ...entry, updatedAt: new Date().toISOString() }
    }

    const sellerId =
      process.env.AMAZON_SELLER_ID ?? process.env.AMAZON_MERCHANT_ID ?? ''
    if (!sellerId) {
      return { ...entry, updatedAt: new Date().toISOString() }
    }

    const { amazonSpApiClient } = await import(
      '../../clients/amazon-sp-api.client.js'
    )

    const parentRead = await amazonSpApiClient.getListingsItem({
      sellerId,
      sku: pollContext.parentSku,
      marketplaceId: pollContext.marketplaceId,
      includedData: ['summaries'],
    })

    const childAsins: Record<string, string> = entry.childAsinsByMasterSku ?? {}
    if (Array.isArray(pollContext.childMasterSkus)) {
      for (const c of pollContext.childMasterSkus) {
        if (childAsins[c.masterSku]) continue
        const r = await amazonSpApiClient.getListingsItem({
          sellerId,
          sku: c.channelSku,
          marketplaceId: pollContext.marketplaceId,
          includedData: ['summaries'],
        })
        if (r.success && r.asin) {
          childAsins[c.masterSku] = r.asin
        }
      }
    }

    const parentAsin = parentRead.success
      ? parentRead.asin ?? entry.parentAsin
      : entry.parentAsin

    return {
      ...entry,
      status: parentAsin ? 'LIVE' : entry.status,
      parentAsin,
      childAsinsByMasterSku:
        Object.keys(childAsins).length > 0 ? childAsins : entry.childAsinsByMasterSku,
      updatedAt: new Date().toISOString(),
    }
  }
}
