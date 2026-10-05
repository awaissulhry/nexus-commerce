/**
 * Item ID control, step I4 — the product sheet's ASIN cell as a control. An ASIN is one row's own (each market's
 * listing; no main row), and Amazon binds a seller SKU to its ASIN:
 *
 *   A row not on Amazon (a still-draft, or a row whose Delete Amazon accepted: no ASIN, DRAFT or unpublished —
 *   `hasDeletedShape`): typing an ASIN proves it exists in this marketplace (Catalog Items, through the listing's own
 *   account and the channel gateway), then sets `merchant_suggested_asin` for THIS market — the same store the sheet's
 *   "Merchant suggested ASIN" column writes (`overrideData`, `channelValueMutation` with no store). Publish lists the
 *   row on it; until then the cell reads "Lists on B0X at Publish", never as live. Clear removes it.
 *   A live offer: refused with Amazon's reason and the way to do it (Owner D4 = A). Nothing is sent to Amazon here.
 */
import prisma from '../../../db.js'
import { logger } from '../../../utils/logger.js'
import { CHANNEL_SKU_LISTING_SELECT } from '../../listings/channel-sku.js'
import { liveChannelSku, wantedChannelSku } from '../../listings/channel-sku.pure.js'
import { SUGGESTED_ASIN_KEY, suggestedAsinOf, takesSuggestedAsin } from './amazon-suggested.js'
import { announceListingValues } from '../../listing-values-events.js'
import { IdentityFixRefusal, object } from './common.js'

export { SUGGESTED_ASIN_KEY, suggestedAsinOf, takesSuggestedAsin } from './amazon-suggested.js'
/** An ASIN: ten letters or digits (B0… for most products, the ISBN-10 for a book). */
export const ASIN_PATTERN = /^[A-Z0-9]{10}$/
export const normalizeAsin = (raw: string | null | undefined) => String(raw ?? '').replace(/\s+/g, '').toUpperCase()

export const amazonMarket = (market: string) => `Amazon · ${String(market).toUpperCase()}`
/** What the cell says of a draft row's suggested ASIN. */
export const listsOnSentence = (asin: string) => `Lists on ${asin} at Publish`

/** The refusal of an ASIN change on a live offer: Amazon's reason, and the two ways to do it. */
export function amazonLiveRefusal(sellerSku: string, asin: string | null, market: string): string {
  const tie = asin ? `Amazon ties seller SKU ${sellerSku} to ASIN ${asin} on ${amazonMarket(market)}.` : `Amazon ties seller SKU ${sellerSku} to the ASIN it holds on ${amazonMarket(market)} (not read back into Nexus yet).`
  return `${tie} To use another ASIN: Delete (Status), set the ASIN here, Publish — or give this listing a new SKU, which lists as a new offer.`
}

export type { AmazonCatalogRead } from './amazon-catalog.js'
export interface AmazonAsinDeps {
  catalog?: (accountId: string, asin: string, market: string) => Promise<import('./amazon-catalog.js').AmazonCatalogRead>
}

async function readCatalog(accountId: string, asin: string, market: string, deps: AmazonAsinDeps) {
  if (deps.catalog) return deps.catalog(accountId, asin, market)
  const { readAmazonCatalog } = await import('./amazon-catalog.js')
  return readAmazonCatalog(accountId, asin, market)
}

const AMAZON_SELECT = { ...CHANNEL_SKU_LISTING_SELECT, overrideData: true } as const
type AmazonRow = Awaited<ReturnType<typeof loadRow>>
async function loadRow(listingId: string) {
  return prisma.channelListing.findFirst({ where: { id: listingId, channel: 'AMAZON', product: { deletedAt: null } }, select: AMAZON_SELECT })
}

/** The seller SKU this row is on Amazon under (the one Amazon holds), else the one Publish sends. */
export function sellerSkuOfRow(row: NonNullable<AmazonRow>): string {
  const productSku = row.product?.sku ?? null
  return liveChannelSku(row as never, productSku)?.sku ?? wantedChannelSku(row as never, productSku).sku ?? productSku ?? '?'
}


/**
 * What a Clear may do on one Amazon row (one rule: the sheet's Clear and Claude's unlink-channel-id): `refusal` — the
 * row is on Amazon (it holds an ASIN, or it is published), so its ASIN is Amazon's and is never cleared here, in Amazon's
 * words; otherwise the ASIN it lists on at Publish (`suggested`) may be removed. Null: no such Amazon listing.
 */
export async function amazonClearFacts(listingId: string): Promise<{ refusal: string | null; suggested: string | null; sellerSku: string } | null> {
  const row = await loadRow(listingId)
  if (!row) return null
  const sellerSku = sellerSkuOfRow(row)
  const asin = row.externalListingId?.trim() || null
  return { sellerSku, suggested: suggestedAsinOf(row.overrideData), refusal: takesSuggestedAsin(row) ? null : amazonLiveRefusal(sellerSku, asin, row.marketplace) }
}

export interface AmazonAsinProof {
  asin: string
  ok: boolean
  /** The ASIN is already this row's suggestion (Keep: nothing to change). */
  unchanged: boolean
  refusal: string | null
  /** What Amazon's catalog said, in plain sentences. */
  found: string[]
  sellerSku: string
  /** The ASIN the row holds on Amazon, or its suggestion: what the sheet shows (the fence). */
  current: string | null
  version: number
}

/** Prove a typed ASIN for one Amazon row (never writes). Refusals are returned. */
export async function proveAmazonAsin(listingId: string, typed: string, deps: AmazonAsinDeps = {}): Promise<AmazonAsinProof> {
  const row = await loadRow(listingId)
  if (!row) throw new IdentityFixRefusal('Listing not found', 'not_found')
  const asin = normalizeAsin(typed)
  const sellerSku = sellerSkuOfRow(row)
  const suggested = suggestedAsinOf(row.overrideData)
  const current = row.externalListingId?.trim() || suggested
  const base: AmazonAsinProof = { asin, ok: false, unchanged: false, refusal: null, found: [], sellerSku, current, version: row.version }
  if (!takesSuggestedAsin(row)) return { ...base, refusal: amazonLiveRefusal(sellerSku, row.externalListingId?.trim() || null, row.marketplace) }
  if (!ASIN_PATTERN.test(asin)) return { ...base, refusal: 'An ASIN is 10 letters or digits (for example B0ABC12345).' }
  if (!row.channelConnectionId) return { ...base, refusal: `This ${amazonMarket(row.marketplace)} listing names no account: set its account first.` }
  let read: import('./amazon-catalog.js').AmazonCatalogRead
  try {
    read = await readCatalog(row.channelConnectionId, asin, row.marketplace, deps)
  } catch (error) {
    logger.warn('[identity-fix] ASIN: the Amazon catalog cannot be read', { error: error instanceof Error ? error.message : String(error) })
    return { ...base, refusal: `Amazon's catalog could not be read for ${amazonMarket(row.marketplace)} (${error instanceof Error ? error.message : String(error)}). Nothing changed.` }
  }
  if (read.error) return { ...base, refusal: `Amazon's catalog could not be read for ${amazonMarket(row.marketplace)} (${read.error}). Nothing changed.` }
  if (!read.found) return { ...base, refusal: `Amazon has no ASIN ${asin} on ${amazonMarket(row.marketplace)}. Nothing changed.` }
  const found = [`Amazon has ASIN ${asin} on ${amazonMarket(row.marketplace)}${read.title ? `: "${read.title}"` : ''}${read.brand ? ` (brand ${read.brand})` : ''}.`,
    `Publish lists seller SKU ${sellerSku} on it, as a new offer. Nothing is sent to Amazon now.`]
  return { ...base, ok: true, unchanged: suggested === asin, found }
}

/**
 * Write (or, with `asin` null, remove) a draft row's suggested ASIN — fenced on the version the sheet read and on the
 * ASIN it showed. Refused on a row on Amazon (its ASIN is Amazon's). Returns the listing's new version.
 */
export async function writeSuggestedAsin(listingId: string, input: { asin: string | null; expectedAsin: string | null; expectedVersion: number }): Promise<{ version: number; previous: string | null; changed: boolean }> {
  const row = await loadRow(listingId)
  if (!row) throw new IdentityFixRefusal('Listing not found', 'not_found')
  const previous = suggestedAsinOf(row.overrideData)
  const shown = row.externalListingId?.trim().toUpperCase() || previous
  if (row.version !== input.expectedVersion || (shown ?? null) !== (input.expectedAsin ? normalizeAsin(input.expectedAsin) : null)) {
    throw new IdentityFixRefusal('This listing changed after it was read. Nothing changed: read it again, then try again.', 'conflict')
  }
  if (!takesSuggestedAsin(row)) throw new IdentityFixRefusal(amazonLiveRefusal(sellerSkuOfRow(row), row.externalListingId?.trim() || null, row.marketplace))
  const next = input.asin ? normalizeAsin(input.asin) : null
  if (next === previous) return { version: row.version, previous, changed: false }
  const bag = { ...object(row.overrideData) }
  if (next) bag[SUGGESTED_ASIN_KEY] = next
  else delete bag[SUGGESTED_ASIN_KEY]
  const written = await prisma.channelListing.updateMany({ where: { id: row.id, version: row.version }, data: { overrideData: bag as never, version: { increment: 1 } } })
  if (written.count !== 1) throw new IdentityFixRefusal('This listing changed after it was read. Nothing changed: read it again, then try again.', 'conflict')
  announceListingValues([row.id], ['externalListingId'], next ? 'channel-id-suggest' : 'channel-id-suggest-clear')
  return { version: row.version + 1, previous, changed: true }
}
