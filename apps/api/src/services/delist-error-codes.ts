/** Operator sentences travel with the stable queue errorCode (Presence PR.2). */
export const DELIST_OPERATOR_COPY = {
  AMAZON_EMPTY_PATCH_NOT_SENT: 'No supported Amazon changes were present. Nothing was sent to the channel.',
  OUTBOUND_NOT_SENT: 'No channel change was sent. This attempt was skipped; check its reason before trying again.',
  DELIST_NO_EXTERNAL_ID: 'No external listing identity was recorded. Nothing was sent to the channel.',
  DELIST_UNSUPPORTED_CHANNEL: 'This channel has no delist adapter. The listing may still be selling.',
  LIFECYCLE_DISPATCH_REFUSED: 'This queue dispatcher cannot perform listing lifecycle actions. No channel change was sent; use the listing lifecycle worker.',
  AMAZON_UNPUBLISH_NOT_IMPLEMENTED: 'Amazon has no reversible unpublish in this client yet',
  AMAZON_DELIST_NO_SKU: 'No seller SKU was recorded for this offer. The ASIN cannot be used as a seller SKU; nothing was sent.',
  AMAZON_DELIST_NO_REGION: 'The Amazon marketplace is missing. Choose the listing marketplace before removing the offer.',
  AMAZON_DELIST_UNKNOWN_MARKET: 'The Amazon marketplace could not be resolved. Nothing was sent.',
  AMAZON_DELIST_NO_SELLER: 'The Amazon seller account could not be resolved. Nothing was sent.',
  AMAZON_DELIST_UNVERIFIED: 'Amazon did not confirm the removal. The outcome is unknown; verify the listing before trying again.',
  DELIST_TRANSPORT_UNKNOWN: 'The channel connection failed before a result was received. The outcome is unknown; verify the listing before trying again.',
  DELIST_DRY_RUN: 'This was a dry run. No channel change was sent.',
  EBAY_UNPUBLISH_NOT_IMPLEMENTED: 'eBay unpublish is unavailable until the account out-of-stock preference is verified. Ending this ItemID is permanent.',
  EBAY_DELIST_NO_ITEMID: 'No eBay ItemID was recorded. Nothing was sent.',
  EBAY_DELIST_NO_REGION: 'The eBay marketplace is missing. Choose the listing marketplace before ending it.',
  EBAY_UNKNOWN_MARKET: 'The eBay marketplace is not supported. Nothing was sent; check the listing marketplace.',
  EBAY_DELIST_NO_CONNECTION: 'The account that owns this eBay ItemID could not be resolved. Check its account attribution; nothing was sent.',
  EBAY_DELIST_AUTH_ERROR: 'The owning eBay account could not be authenticated. Reconnect that account before trying again.',
  EBAY_DELIST_COULD_NOT_ASK: 'eBay could not let this account access the ItemID. Its listing state is unknown; check the owning account and verify it.',
  EBAY_DELIST_FAILED: 'eBay rejected the end request. Check the channel error before trying again.',
  EBAY_DELIST_UNVERIFIED: 'eBay did not acknowledge the end request. The outcome is unknown; verify the ItemID before trying again.',
  SHOPIFY_DELIST_NOT_IMPLEMENTED: 'Shopify delist is unavailable until the account-bound adapter is implemented. No channel change was sent.',
  SHOPIFY_DELIST_NO_ACCOUNT: 'No Shopify connection was recorded for this listing. Choose its owning webstore; nothing was sent.',
} as const

export type DelistErrorCode = keyof typeof DELIST_OPERATOR_COPY

/**
 * 🔴 PLAN Step 1.2 — the sentence a refused hard delete carries.
 *
 * The danger it names: you pick an action, the product is hard-deleted locally, the adapter then
 * REFUSES, and the listing keeps selling on the channel with no product row left to manage it.
 * The default path produced exactly that — the bulk-delete modal preselects `unpublish` whenever
 * a live listing exists, and Amazon and eBay both refuse `unpublish`.
 *
 * R4, an absent thing is stated: the refusal names the coordinate, the listing id, why it stays
 * live, and the two ways forward. The "why" is `DELIST_OPERATOR_COPY` — the same sentence the queue
 * would have shown after the fact — so the operator reads one wording, not two.
 */
export const HARD_DELETE_NO_CHANNEL_ACTION =
  'No channel action was chosen, so nothing is sent and the listing keeps selling.'

export const HARD_DELETE_NEXT_STEPS =
  'Remove the listing from the channel instead (permanent), or disconnect the listing first.'

/** `reason` for one coordinate that would be left live. `cause` is null when nothing is sent. */
export function hardDeleteOrphanReason(input: {
  channel: string
  marketplace: string | null
  externalListingId: string | null
  cause: DelistErrorCode | null
}): string {
  const where = `${input.channel}${input.marketplace ? ` · ${input.marketplace}` : ''}`
  const which = input.externalListingId ? ` ${input.externalListingId}` : ''
  const why = input.cause ? DELIST_OPERATOR_COPY[input.cause] : HARD_DELETE_NO_CHANNEL_ACTION
  return `${where} listing${which} would stay live. ${why} ${HARD_DELETE_NEXT_STEPS}`
}
