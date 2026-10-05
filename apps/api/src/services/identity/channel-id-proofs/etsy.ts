/**
 * Item ID control, step I2 — prove an Etsy Listing ID for a family, as THIS business's own Etsy account. Reads only.
 *
 * One Etsy listing carries a whole family (market GLOBAL), so the id is set on the family's main row. The proof, each
 * step a plain refusal when the link cannot work:
 *   - the id is a number, and no other family of this business holds it on this account;
 *   - Etsy has the listing (`GET /listings/:id`, through the account's reader and the channel gateway: `etsyReader`);
 *   - its `shop_id` is this account's shop (an Etsy listing of another shop — another business's — is never linked);
 *   - its state is one Nexus can record: active / sold out (Active), inactive (Inactive), expired / removed (Ended);
 *     an Etsy draft does not sell yet and is refused;
 *   - its inventory SKUs (`GET /listings/:id/inventory`) include this family's channel SKUs on this account (`channel-sku.ts`).
 * The rows it carries follow the one rule of `common.ts` (moved and kept rows included).
 */
import { logger } from '../../../utils/logger.js'
import {
  carryRows, channelSkusOf, emptyProof, familyRowsOf, heldByAnotherFamily, matchedSkusOf, ownSkuOn, where,
  type ChannelItemProof, type Coordinate, type LinkStatus,
} from './common.js'

type EtsyGet = <T>(path: string) => Promise<T>
export interface EtsyReadDeps { reader?: (accountId: string) => Promise<{ get: EtsyGet; shopId: string | number }> }

/** Etsy's listing states → what a linked row reads (the refresh job's map, `etsy-content-refresh.job.ts`); draft is refused. */
export const ETSY_LINK_STATUS: Readonly<Record<string, LinkStatus>> = { active: 'ACTIVE', sold_out: 'ACTIVE', inactive: 'INACTIVE', expired: 'ENDED', removed: 'ENDED' }

/** An Etsy Listing ID: the digits in the listing's web address. */
export const ETSY_LISTING_ID = /^[1-9]\d{0,19}$/

interface EtsyListing { listing_id?: unknown; shop_id?: unknown; state?: unknown; title?: unknown; skus?: unknown }
interface EtsyInventory { products?: Array<{ sku?: unknown; is_deleted?: unknown }> }

async function openReader(accountId: string, deps: EtsyReadDeps) {
  if (deps.reader) return deps.reader(accountId)
  const { etsyReader } = await import('../../etsy/read-client.js')
  return etsyReader(accountId)
}

const statusOf = (error: unknown) => (error && typeof error === 'object' && typeof (error as { status?: unknown }).status === 'number' ? (error as { status: number }).status : null)

/** Prove an Etsy listing for a coordinate. Never writes; refusals are returned (`refusal`). */
export async function proveEtsyListing(coordinate: Coordinate, rawId: string, input: { acknowledgeUnverifiable?: boolean; mcp?: boolean }, deps: EtsyReadDeps = {}): Promise<ChannelItemProof> {
  const itemId = String(rawId ?? '').trim()
  const proof = emptyProof('ETSY', itemId)
  if (!ETSY_LISTING_ID.test(itemId)) return { ...proof, reason: 'An Etsy Listing ID is a number.', refusal: `${where(coordinate)}: an Etsy Listing ID is a number (the digits in the listing's web address, etsy.com/listing/…).` }
  if (!coordinate.accountId) return { ...proof, refusal: `${where(coordinate)} names no account: set its account first.` }
  const other = await heldByAnotherFamily(coordinate, itemId)
  if (other) return { ...proof, verdict: 'rejected', reason: `Already linked to another product (${other}).`, refusal: `${where(coordinate)}: Etsy listing ${itemId} is already linked to another product here (${other}). Nothing changed.` }

  let reader: { get: EtsyGet; shopId: string | number }
  try {
    reader = await openReader(coordinate.accountId, deps)
  } catch (error) {
    logger.warn('[identity-fix] link: the Etsy account cannot be read', { error: error instanceof Error ? error.message : String(error) })
    return { ...proof, refusal: `${where(coordinate)}: its Etsy account has no verified shop or working sign-in in Nexus, so the Listing ID cannot be checked on Etsy. Reconnect the account in Nexus (Settings, Channels), then check again.` }
  }
  let listing: EtsyListing
  let inventory: EtsyInventory
  try {
    listing = await reader.get<EtsyListing>(`/listings/${itemId}`)
    inventory = await reader.get<EtsyInventory>(`/listings/${itemId}/inventory`)
  } catch (error) {
    if (statusOf(error) === 404) return { ...proof, verdict: 'rejected', reason: 'Etsy has no such listing.', refusal: `${where(coordinate)}: Etsy has no listing ${itemId} that this account can read. Nothing changed.` }
    return { ...proof, refusal: `${where(coordinate)}: Etsy could not be read (${error instanceof Error ? error.message : String(error)}). Nothing changed.` }
  }
  const shop = String(reader.shopId)
  const listingShop = listing.shop_id == null ? '' : String(listing.shop_id)
  const state = typeof listing.state === 'string' ? listing.state.trim().toLowerCase() : ''
  const skus = [...new Set((inventory.products ?? []).filter((p) => p.is_deleted !== true).map((p) => (typeof p.sku === 'string' ? p.sku.trim() : '')).filter(Boolean))]
  proof.title = typeof listing.title === 'string' && listing.title.trim() ? listing.title.trim() : null
  proof.channelStatus = state || null
  proof.liveSkus = skus
  if (listingShop !== shop) {
    return { ...proof, verdict: 'rejected', reason: `Listed by Etsy shop ${listingShop || 'unknown'}.`,
      refusal: `${where(coordinate)}: Etsy listing ${itemId} belongs to Etsy shop ${listingShop || '(none named)'}, not this account's shop ${shop}. A listing of another shop is never linked here. Nothing changed.` }
  }
  if (state === 'draft') return { ...proof, verdict: 'rejected', reason: 'An Etsy draft.', refusal: `${where(coordinate)}: Etsy reports listing ${itemId} as a draft: it does not sell yet, so Nexus cannot record it as listed. Publish it on Etsy, then link it. Nothing changed.` }
  proof.status = ETSY_LINK_STATUS[state] ?? null
  if (!proof.status) return { ...proof, verdict: 'rejected', reason: `Etsy state "${state}".`, refusal: `${where(coordinate)}: Etsy reports listing ${itemId} as ${state ? `"${state}"` : 'nothing (no state)'}, so Nexus cannot record whether it sells. Nothing changed.` }

  const family = await familyRowsOf(coordinate)
  const skusByRow = new Map(family.map((row) => [row.id, channelSkusOf(row)]))
  proof.matchedSkus = matchedSkusOf(family, skusByRow, skus)
  if (!skus.length) {
    proof.verdict = 'unverifiable'
    proof.reason = 'The listing reports no SKUs on Etsy.'
    if (input.acknowledgeUnverifiable !== true) {
      return { ...proof, refusal: input.mcp
        ? `${where(coordinate)}: Etsy listing ${itemId} reports no SKUs, so Nexus cannot prove it is this listing's. Ask again with acknowledgeUnverifiable to link it anyway.`
        : `${where(coordinate)}: Etsy listing ${itemId} reports no SKUs, so Nexus cannot prove it is this listing's. Give its variations their SKUs on Etsy, then check again.` }
    }
  } else if (!proof.matchedSkus.length) {
    return { ...proof, verdict: 'rejected', reason: 'No SKU of this family on the listing.',
      refusal: `${where(coordinate)}: none of the ${skus.length} SKU(s) on Etsy listing ${itemId} (${skus.slice(0, 5).join(', ')}${skus.length > 5 ? ', …' : ''}) belong to this family on this account. Nothing changed.` }
  } else {
    proof.verdict = 'verified'
    proof.reason = `Listed by this account's Etsy shop ${shop}; ${proof.matchedSkus.length} of its SKUs are this family's.`
  }

  carryRows(coordinate, family, proof, (row) => ownSkuOn(row, skusByRow, skus))
  if (!proof.rows.length) return { ...proof, refusal: `${where(coordinate)}: Etsy listing ${itemId} carries none of this listing's rows here. Nothing changed.` }
  const byId = new Map(family.map((row) => [row.id, row]))
  proof.unchanged = proof.rows.every((row) => row.externalListingId?.trim() === itemId && row.listingStatus === proof.status && row.isPublished
    && byId.get(row.id)?.lastSyncStatus !== 'MISSING')
  return proof
}

/** The plain sentences of an Etsy proof (before the rows a link writes). */
export function etsyFoundSentences(proof: ChannelItemProof): string[] {
  const out: string[] = []
  if (proof.title) out.push(`Etsy listing ${proof.itemId}: "${proof.title}".`)
  if (proof.channelStatus) {
    out.push(proof.status === 'ENDED' ? `Etsy reports it as ${proof.channelStatus}: Nexus records it as Ended.`
      : proof.status === 'INACTIVE' ? `Etsy reports it as ${proof.channelStatus}: it is listed and does not sell now.`
      : proof.status === 'ACTIVE' ? `Etsy reports it as ${proof.channelStatus === 'sold_out' ? 'sold out (listed, quantity 0)' : 'active'}.` : `Etsy reports it as ${proof.channelStatus}.`)
  }
  if (proof.verdict === 'verified') out.push('Listed by this account\'s Etsy shop.')
  return out
}

