/**
 * P1.7 (docs/channel-connections/FINAL-PLAN.md) — no Amazon CONTENT write without Amazon's own dry run.
 *
 * `mode=VALIDATION_PREVIEW` sends the exact same body to the Listings Items API and returns the issues
 * the real write would raise, without changing the listing (the gateway classifies it as a read). The
 * studio and the cockpit already did this; this module is the one rule the other writers share.
 *
 * Fail-closed on purpose: when the preview cannot run at all (no credentials, transport error), nothing
 * is submitted. A write that cannot be checked is the risk this exists for.
 */
import { amazonSpApiClient } from '../../clients/amazon-sp-api.client.js'

/** Patch paths that carry no editorial content: price and stock move through their own guarded lanes. */
const PRICE_OR_STOCK = /^\/attributes\/(purchasable_offer|list_price|fulfillment_availability)(\/|$)/

/**
 * True when a patch set changes anything beyond price and stock — then it is a content write and needs
 * the preview. Inferred from what is actually sent, not from the row's label, so a mixed payload counts
 * as content.
 */
export function isAmazonContentPatchSet(patches?: ReadonlyArray<{ path?: string | null }> | null): boolean {
  if (!patches?.length) return false
  return patches.some((patch) => !PRICE_OR_STOCK.test(String(patch?.path ?? '')))
}

export interface AmazonPreviewInput {
  sellerId: string
  sku: string
  marketplaceId: string
  productType: string
  /** Full attribute set → Amazon validates it as a PUT. */
  attributes?: Record<string, unknown>
  /** JSON Patch ops → Amazon validates them as a PATCH. */
  patches?: Array<{ op: string; path: string; value?: unknown }>
  requirements?: string
}

/**
 * Ask Amazon first. Returns the sentence to report when the write must not go out, or `null` when
 * Amazon accepts it. Warnings are not refusals — Amazon returns them on perfectly valid listings.
 */
export async function amazonContentRefusal(input: AmazonPreviewInput): Promise<string | null> {
  const check = await amazonSpApiClient.validateListing(input)
  if (!check.available) return `Amazon validation is unavailable for ${input.sku}. Nothing was submitted.`
  if (!check.ok) return `Amazon refused this content in its own check (${input.sku}): ${check.errors ?? 'no detail given'}. Nothing was submitted.`
  return null
}
