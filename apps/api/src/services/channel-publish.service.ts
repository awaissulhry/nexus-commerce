/**
 * MC.12 — Per-channel image publish service.
 *
 * Sandbox-stub by default per the engagement directive. Each
 * channel lights up its own real-call branch in MC.12.1–12.4 once
 * the credential infrastructure exists. Set
 * CHANNEL_PUBLISH_MODE=live (or CHANNEL_PUBLISH_<CHANNEL>=live) to
 * flip a specific channel.
 *
 * Per-channel functions all return the same shape so the dispatch
 * endpoint can be channel-agnostic. Result rows persist as
 * AuditLog entries today; promoting to a dedicated
 * ChannelImagePublish model is an MC.12-followup once we want
 * "what's currently live on Amazon for this asset?" queries
 * across the catalogue.
 */

export type ChannelPublishMode = 'sandbox' | 'live'
export type ChannelKey = 'AMAZON' | 'EBAY' | 'SHOPIFY' | 'WOOCOMMERCE'

export function channelPublishMode(channel: ChannelKey): ChannelPublishMode {
  const channelEnv = process.env[`CHANNEL_PUBLISH_${channel}`]
  if (channelEnv === 'live') return 'live'
  if (channelEnv === 'sandbox') return 'sandbox'
  return process.env.CHANNEL_PUBLISH_MODE === 'live' ? 'live' : 'sandbox'
}

export interface PublishResult {
  ok: boolean
  channel: ChannelKey
  mode: ChannelPublishMode
  /// Channel-side image identifier when the publish succeeded —
  /// e.g. Amazon's mediaUploadId, eBay's PictureURL, Shopify's
  /// MediaImage gid, Woo's WP attachment id.
  channelImageId: string | null
  rawResponse: Record<string, unknown> | null
  error: string | null
}

interface PublishInput {
  assetUrl: string
  /// Operator-set identifier for the destination listing. Shape
  /// varies by channel (ASIN for Amazon, ItemID for eBay, etc.).
  destinationId: string
  /// Optional per-channel overrides (image type, gallery slot, etc.)
  options?: Record<string, unknown>
}

// ── eBay EPS — MC.12.2 ────────────────────────────────────────────
//
// Real call (live, future):
//   POST UploadSiteHostedPictures via the eBay Trading API XML
//   endpoint. eBay also accepts URL-based uploads (PictureURL on
//   AddItem / ReviseItem) — we'd use EPS for guaranteed persistence
//   + zoom support.
//
// Sandbox returns a fake PictureURL hosted at the eBay EPS host.
export async function publishToEbay(
  input: PublishInput,
): Promise<PublishResult> {
  const mode = channelPublishMode('EBAY')
  if (mode === 'sandbox') {
    const fakePicId = `eps-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    return {
      ok: true,
      channel: 'EBAY',
      mode: 'sandbox',
      channelImageId: fakePicId,
      rawResponse: {
        sandbox: true,
        itemId: input.destinationId,
        pictureURL: `https://i.ebayimg.com/00/s/sandbox/${fakePicId}.jpg`,
        pictureSetMember: input.options?.gallerySlot ?? '0',
        sourceImage: input.assetUrl,
      },
      error: null,
    }
  }
  return {
    ok: false,
    channel: 'EBAY',
    mode: 'live',
    channelImageId: null,
    rawResponse: null,
    error:
      'Live eBay EPS upload is not yet wired. Set CHANNEL_PUBLISH_EBAY=sandbox or wait for the eBay credential integration.',
  }
}

// ── Amazon SP-API ────────────────────────────────────────────────
//
// Real call sequence (live mode, future):
//   1. POST /aplus/2020-11-01/uploadDestinations  →  uploadUrl + headers
//   2. PUT  uploadUrl  body=image bytes  headers=signed
//   3. POST /listings/2021-08-01/items/{seller}/{sku}/images  →
//      attaches the upload destination to the listing
//
// Sandbox mode generates a fake mediaUploadId in Amazon's format
// (10-char alphanumeric, AMZN-prefixed) so the operator sees a
// realistic shape in the audit log.
export async function publishToAmazon(
  input: PublishInput,
): Promise<PublishResult> {
  const mode = channelPublishMode('AMAZON')
  if (mode === 'sandbox') {
    return {
      ok: true,
      channel: 'AMAZON',
      mode: 'sandbox',
      channelImageId: `AMZN${Math.random()
        .toString(36)
        .slice(2, 10)
        .toUpperCase()}`,
      rawResponse: {
        sandbox: true,
        seller: 'sandbox-seller',
        asin: input.destinationId,
        uploadDestinationId: `dest-${Date.now()}`,
        contentMD5: 'sandbox-md5',
        imageUrl: input.assetUrl,
      },
      error: null,
    }
  }
  return {
    ok: false,
    channel: 'AMAZON',
    mode: 'live',
    channelImageId: null,
    rawResponse: null,
    error:
      'Live Amazon SP-API image publish is not yet wired. Set CHANNEL_PUBLISH_MODE=sandbox or wait for the SP-API credential integration.',
  }
}
