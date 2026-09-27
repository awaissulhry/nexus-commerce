/**
 * Product-sheet create path, step 6 — what the operator is told (the Owner's D1 = A and D2 = A, 2026-09-27;
 * `docs/product-sheet-create-path/RESEARCH-2026-09-27.md` §5 "What the operator sees").
 *
 * The first channel-scope save on a market where the family has no listing starts an inert DRAFT listing (the parent and
 * every variant, `ensureDraftListings` on the API). Nothing is sent to the channel until Publish. This module is the
 * web's one place for those sentences and for the rule that reads a listing as a still-unpublished draft.
 *
 * The still-draft rule is NOT copied here: it is `isStillDraftListing` from `packages/shared/push-lock.ts`, the same
 * function Publish and the API's promotion use, so the chip and the server cannot disagree about which listing is a
 * draft.
 */
import { isStillDraftListing, type DraftListingFacts } from '@nexus/shared/push-lock'
import { isAsinPending } from '@nexus/shared/listing-risk'
import { channelLabel } from '@nexus/shared/channel-label'
import { readinessMeta } from '@/design-system/grid/renderers/readiness'

export { isStillDraftListing }

/** `Amazon · SE` — the coordinate as every sentence here names it. */
export const coordinateName = (channel: string, market: string): string => `${channelLabel(channel)} · ${market}`

/**
 * What the family holds on one coordinate:
 *  - `none`   — no row has a listing here: the first edit starts the draft;
 *  - `draft`  — every listing here is still a Nexus draft (DRAFT, never published, no channel id);
 *  - `listed` — at least one listing has reached the channel, or is not a still-draft by the shared rule.
 * `null` when there are no rows to judge (still loading, or nothing to show).
 */
export type CoordinateListingState = 'none' | 'draft' | 'listed'

export function coordinateListingState(
  rows: ReadonlyArray<{ listing?: DraftListingFacts | null }>,
): CoordinateListingState | null {
  if (rows.length === 0) return null
  const listings = rows.flatMap((row) => (row.listing ? [row.listing] : []))
  if (listings.length === 0) return 'none'
  return listings.every((listing) => isStillDraftListing(listing)) ? 'draft' : 'listed'
}

/** The header on a coordinate with no listing. Replaces "Not listed · 1 listing · 20 variations". */
export function notListedSentence(channel: string, market: string): string {
  return `Not listed on ${coordinateName(channel, market)} yet. Your first edit here starts a draft. Nothing is sent to ${channelLabel(channel)} until you publish.`
}

/** "an Amazon", "an eBay", "a Shopify" — the article the API's refusal uses. */
const withArticle = (label: string) => `${/^[aeiou]/i.test(label) ? 'an' : 'a'} ${label}`

/**
 * With no account there is no draft to start. The API's own refusal (`ensureDraftListings`,
 * `VT_COPY.connectAccount`), word for word, so the header and the refused cell say the same thing.
 */
export function connectAccountSentence(channel: string, market: string): string {
  return `Connect ${withArticle(channelLabel(channel))} account before listing on ${market}.`
}

/** The header chip while every listing on the coordinate is still a draft. */
export const DRAFT_CHIP_LABEL = 'Draft · not published'

export function draftChipDetail(channel: string, market: string): string {
  return `The listing on ${coordinateName(channel, market)} is a Nexus draft. Nothing is sent to ${channelLabel(channel)} until you publish.`
}

/**
 * The listings on a coordinate that Amazon accepted and whose ASIN is not read back yet — the shared rule
 * (`isAsinPending`), so the chip, the sheet's row state and the Variants cell count the same rows.
 */
export function asinPendingCount(rows: ReadonlyArray<{ listing?: DraftListingFacts | null }>, channel: string): number {
  return rows.filter((row) => !!row.listing && isAsinPending({ ...row.listing, channel })).length
}

/** The header chip while listings here wait for their ASIN: the row state's own word. */
export const ASIN_PENDING_CHIP_LABEL = readinessMeta('pending', 'row').label

export function asinPendingChipDetail(count: number, market: string): string {
  return count === 1
    ? `1 listing on ${coordinateName('AMAZON', market)} is published. Its ASIN has not been read back yet; Nexus reads it from Amazon.`
    : `${count} listings on ${coordinateName('AMAZON', market)} are published. Their ASINs have not been read back yet; Nexus reads them from Amazon.`
}

/**
 * The toast after the save that started the draft. `created` is the whole started family as the server reports it
 * (`createdListings`, or the listings a variation-theme save started); the family root is the parent.
 */
export function draftStartedMessage(input: {
  rootSku: string
  familyId: string
  channel: string
  market: string
  created: ReadonlyArray<{ productId: string }>
}): string {
  const parent = input.created.some((row) => row.productId === input.familyId)
  const variants = new Set(input.created.filter((row) => row.productId !== input.familyId).map((row) => row.productId)).size
  const counted = variants === 0 ? '' : `${variants} ${variants === 1 ? 'variant' : 'variants'}`
  const what = parent && counted ? ` (parent + ${counted})` : counted ? ` (${counted})` : ''
  return `Started a draft of ${input.rootSku} on ${coordinateName(input.channel, input.market)}${what}. Nothing was sent to ${channelLabel(input.channel)}.`
}

/** The media galleries' sentence on a coordinate with no listing. */
export function mediaDraftStartSentence(channel: string, market: string): string {
  return `Your first save here starts a draft on ${coordinateName(channel, market)}. Nothing is sent to ${channelLabel(channel)} until you publish.`
}

/** The message after the gallery save that started the draft. */
export function mediaDraftStartedMessage(channel: string, market: string): string {
  return `Started a draft on ${coordinateName(channel, market)} and saved this gallery to it. Nothing was sent to ${channelLabel(channel)}.`
}

/**
 * May a media gallery be edited on this destination?
 *  - `listing`        — a listing is selected: edit it;
 *  - `starts-draft`   — no listing, primary destination, an account: editing is allowed and the first save starts the
 *                       primary listing's draft (the API refuses anything else);
 *  - `choose-listing` — a non-primary alias is named but has no listing: an edit never creates an alias listing;
 *  - `no-account`     — nothing to start a draft under.
 */
export type MediaDestinationGate = 'listing' | 'starts-draft' | 'choose-listing' | 'no-account'

export function mediaDestinationGate(destination: {
  listingId: string | null
  aliasKey?: string | null
  accountId?: string | null
}): MediaDestinationGate {
  if (destination.listingId) return 'listing'
  if (destination.aliasKey) return 'choose-listing'
  if (!destination.accountId) return 'no-account'
  return 'starts-draft'
}
