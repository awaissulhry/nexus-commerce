/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, steps I1–I4) — the product sheet's channel id cells,
 * as the signed-in person: Check (prove an id on the channel, writing nothing), Link (write it), Clear (unlink it).
 *
 *   eBay Item ID · Etsy Listing ID · Shopify Product ID — one id carries the whole family, so it is set on the family's
 *     MAIN row only (a variation row says "Set on the main row" and is refused here too). Shopify's main row is the
 *     family's root row in both of its models (one product per family; colour products, where the root is the door to
 *     each colour's product: `channel-id-proofs/shopify.ts`).
 *   Amazon ASIN — one row's own. On a row not on Amazon a typed ASIN becomes the ASIN it lists on at Publish; on a live
 *     offer a change is refused with Amazon's reason and the way to do it (`channel-id-proofs/amazon.ts`).
 *
 * The rules are identity-fix's, the ones Claude's link-channel-id / unlink-channel-id use (one rule, both paths); this
 * file adds only what the sheet needs around them:
 *   - the main-row rule above;
 *   - the fence: the id and the listing version the sheet read (a listing that moved since is refused, nothing changes);
 *     identity-fix re-checks every row it writes on its own id and version inside the transaction;
 *   - no "link it anyway": an item Nexus cannot prove is this account's is refused (Claude's tool asks a person instead);
 *   - an audit row per write (who, which id), besides the snapshots identity-fix keeps.
 * Nothing here is sent to a channel except its reads (through the gateway) — and, in a Shopify colour store, Confirm's
 * identity write, which the Check says before Link. Pushes stay paused after a link.
 */
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import {
  AMAZON_AT_PUBLISH, IdentityFixRefusal, LISTING_CHANGED, checkChannelId, coordinateOf, pushesStayPaused, runLink, runUnlink,
  type ChannelIdCheck, type Coordinate, type LinkDeps,
} from './identity-fix.service.js'
import { wordsOf } from './channel-id-proofs/common.js'
import { listsOnSentence } from './channel-id-proofs/amazon.js'

/** The sentence a variation row's control gives, per channel (the sheet's cell says the same). */
export const MAIN_ROW_ONLY = 'Set on the main row: one eBay Item ID carries the whole variation family.'
export const MAIN_ROW_SENTENCES: Readonly<Record<string, string>> = {
  EBAY: MAIN_ROW_ONLY,
  ETSY: 'Set on the main row: one Etsy listing carries the whole family.',
  SHOPIFY: 'Set on the main row: the family\'s Shopify product (in a colour store, each colour\'s product) is linked there.',
}
export const mainRowOnly = (channel: string) => MAIN_ROW_SENTENCES[String(channel).toUpperCase()] ?? MAIN_ROW_ONLY
/** The channels whose id the sheet changes. */
export const SHEET_ID_CHANNELS = ['EBAY', 'ETSY', 'SHOPIFY', 'AMAZON'] as const
export const UNSUPPORTED_CHANNEL = 'Only an eBay Item ID, an Etsy Listing ID, a Shopify Product ID or an Amazon ASIN can be changed here.'

/** The Clear confirm's words, for the web's dialog and the answer. */
export function unlinkSentence(itemId: string, channel = 'EBAY'): string {
  const ch = String(channel).toUpperCase()
  if (ch === 'ETSY') return `Nexus forgets Etsy listing ${itemId}. Nothing changes on Etsy; it stays live and Nexus stops updating it.`
  if (ch === 'SHOPIFY') return `Nexus forgets Shopify product ${itemId}. Nothing changes on Shopify; the product stays as it is and Nexus stops updating it.`
  if (ch === 'AMAZON') return `Nexus removes ASIN ${itemId} from this row: Publish lists it without an ASIN of your choice. Nothing changes on Amazon.`
  return `Nexus forgets item ${itemId}. Nothing changes on eBay; it stays live and Nexus stops updating it.`
}

export interface ChannelIdFence {
  /** The id the sheet showed for the listing (null: none). Amazon: the row's ASIN, or the ASIN it lists on at Publish. */
  expectedExternalId: string | null
  /** The listing version the sheet read. */
  expectedVersion: number
}

async function sheetCoordinate(listingId: string): Promise<Coordinate> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal('Listing not found', 'not_found')
  if (!(SHEET_ID_CHANNELS as readonly string[]).includes(coordinate.channel)) throw new IdentityFixRefusal(UNSUPPORTED_CHANNEL)
  if (coordinate.channel !== 'AMAZON' && !coordinate.asked.isMain) throw new IdentityFixRefusal(mainRowOnly(coordinate.channel))
  return coordinate
}

/** What the sheet shows as the id: the held id; on Amazon, else the ASIN a draft lists on at Publish. */
const shownId = (c: Coordinate) => c.externalId ?? (c.channel === 'AMAZON' ? c.suggestedId ?? null : null)

function fence(coordinate: Coordinate, input: ChannelIdFence): void {
  const expected = input.expectedExternalId?.trim() || null
  const shown = shownId(coordinate)
  const same = coordinate.channel === 'AMAZON' ? (shown ?? '').toUpperCase() === (expected ?? '').toUpperCase() : (shown ?? null) === expected
  if (coordinate.asked.version !== input.expectedVersion || !same) throw new IdentityFixRefusal(LISTING_CHANGED, 'conflict')
}

/** The versions the written rows carry now: the sheet keeps them, so the event its own write sends reads as its own echo. */
async function versionsOf(ids: string[]): Promise<Array<{ listingId: string; version: number }>> {
  if (!ids.length) return []
  const rows = await prisma.channelListing.findMany({ where: { id: { in: ids } }, select: { id: true, version: true } })
  const version = new Map(rows.map((r) => [r.id, r.version]))
  return ids.map((id) => ({ listingId: id, version: version.get(id) ?? 0 }))
}

/** Check: what the channel says of a typed id (or, with none, of the one Nexus holds). Writes nothing. */
export async function checkSheetChannelId(listingId: string, input: { externalId?: string | null }, deps: LinkDeps = {}): Promise<ChannelIdCheck> {
  await sheetCoordinate(listingId)
  return checkChannelId(listingId, input, deps)
}

export interface SheetLinkResult {
  ok: true
  listingId: string
  externalId: string
  status: 'ACTIVE' | 'ENDED' | 'INACTIVE' | null
  /** The rows written (none when the channel confirms what Nexus already holds). */
  rows: Array<{ listingId: string; version: number }>
  /** Rows moved from another item to this one (the channel showed their SKU on it), as the Check listed them before Link. */
  moved: Array<{ id: string; sku: string; fromItemId: string; sentence: string }>
  kept: Array<{ id: string; sku: string; externalListingId: string; sentence: string }>
  sentence: string
  pushes: string
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/**
 * Link (or Keep, when the id is the one the listing holds): proven on the channel again, then written fenced on the ids
 * and versions the rows carried. Refused, nothing changed, when the link cannot work.
 */
export async function linkSheetChannelId(listingId: string, input: ChannelIdFence & { externalId: string }, actor: string | null, deps: LinkDeps = {}): Promise<SheetLinkResult> {
  const coordinate = await sheetCoordinate(listingId)
  fence(coordinate, input)
  const words = wordsOf(coordinate.channel)
  const externalId = coordinate.channel === 'AMAZON' ? input.externalId.replace(/\s+/g, '').toUpperCase() : input.externalId.trim()
  const record = await runLink(listingId, { externalId, expectedExternalId: externalId, expectedVersion: input.expectedVersion, actor, sheet: true }, deps)
  // The rows it added (an extra listing that had none for those variations) are rows it linked too.
  const rows = await versionsOf([...record.rows, ...record.added ?? []].map((r) => r.id))
  if (rows.length) {
    await auditLogService.write({
      userId: actor, entityType: 'ChannelListing', entityId: listingId, action: record.suggestedAsin ? 'listing.channel-id.suggest' : 'listing.channel-id.link',
      before: { externalListingId: input.expectedExternalId }, after: record.suggestedAsin ? { suggestedAsin: record.externalId } : { externalListingId: record.externalId, listingStatus: record.status ?? null },
      metadata: { channel: coordinate.channel, marketplace: coordinate.market, accountId: coordinate.accountId, rows: rows.map((r) => r.listingId), snapshots: record.snapshotIds ?? [],
        ...(record.moved?.length ? { moved: record.moved.map((m) => ({ listingId: m.id, from: m.fromItemId })) } : {}),
        ...(record.added?.length ? { added: record.added.map((a) => a.id) } : {}),
        ...(record.liveSkus?.length ? { liveChannelSkus: record.liveSkus } : {}),
        ...(record.colour ? { colour: record.colour.name } : {}) },
    })
  }
  if (record.suggestedAsin) {
    const sentence = record.suggestedAsin.changed ? `${coordinate.rows[0]?.sku ?? coordinate.root.sku}: ${listsOnSentence(record.externalId)} on ${coordinate.market}.`
      : `${coordinate.rows[0]?.sku ?? coordinate.root.sku} already ${listsOnSentence(record.externalId).replace(/^Lists/, 'lists')}. Nothing changed.`
    return { ok: true, listingId, externalId: record.externalId, status: null, rows, moved: [], kept: [], sentence, pushes: AMAZON_AT_PUBLISH }
  }
  const status = record.status ?? null
  const moved = (record.moved ?? []).map((m) => ({ id: m.id, sku: m.sku, fromItemId: m.fromItemId, sentence: m.sentence }))
  const added = record.added ?? []
  const rowWords = (moved.length ? ` ${moved.length} of them moved from another ${words.noun} (${moved.map((m) => m.sku).join(', ')}).` : '')
    + (added.length ? ` ${added.length} of them ${added.length === 1 ? 'is' : 'are'} new: this listing had no row for ${added.map((a) => a.sku).join(', ')}.` : '')
  const label = `${words.noun} ${record.externalId}`
  const sentence = !rows.length ? `${words.name} confirms ${label}; Nexus already holds it. Nothing changed.`
    : record.colour ? `Linked "${record.colour.name}" to Shopify product ${record.externalId} on ${plural(rows.length, 'row')}.`
    : status === 'ENDED' ? `Linked ${label} on ${plural(rows.length, 'row')}.${rowWords} It has ended on ${words.name}: the rows read Ended${coordinate.channel === 'EBAY' ? ', and Relist is offered' : ''}.`
    : status === 'INACTIVE' ? `Linked ${label} on ${plural(rows.length, 'row')}.${rowWords} It does not sell on ${words.name} now: the rows read Inactive.`
    : `Linked ${label} on ${plural(rows.length, 'row')}.${rowWords}`
  return { ok: true, listingId, externalId: record.externalId, status, rows, moved, kept: record.kept ?? [], sentence, pushes: pushesStayPaused(words.noun) }
}

export interface SheetUnlinkResult {
  ok: true
  listingId: string
  externalId: string
  rows: Array<{ listingId: string; version: number }>
  sentence: string
}

/**
 * Clear: Nexus forgets the id on every row of the family that holds it (nothing is sent to the channel). Amazon: the
 * ASIN a draft row lists on at Publish is removed; a live offer's ASIN is Amazon's, and Clear is refused with its reason.
 */
export async function unlinkSheetChannelId(listingId: string, input: ChannelIdFence, actor: string | null): Promise<SheetUnlinkResult> {
  const coordinate = await sheetCoordinate(listingId)
  fence(coordinate, input)
  if (!input.expectedExternalId) throw new IdentityFixRefusal(`This listing holds no ${wordsOf(coordinate.channel).idLabel}: nothing to clear.`)
  if (coordinate.channel === 'AMAZON') {
    // The one rule (identity-fix `planUnlink`): a row on Amazon is refused with Amazon's reason; a draft loses the ASIN it lists on at Publish.
    const record = await runUnlink(listingId, shownId(coordinate) ?? input.expectedExternalId, actor, { expectedVersion: input.expectedVersion })
    const rows = await versionsOf(record.rows.map((r) => r.id))
    await auditLogService.write({
      userId: actor, entityType: 'ChannelListing', entityId: listingId, action: 'listing.channel-id.suggest',
      before: { suggestedAsin: record.externalId }, after: { suggestedAsin: null }, metadata: { channel: 'AMAZON', marketplace: coordinate.market, accountId: coordinate.accountId },
    })
    return { ok: true, listingId, externalId: record.externalId, rows, sentence: unlinkSentence(record.externalId, 'AMAZON') }
  }
  const record = await runUnlink(listingId, input.expectedExternalId, actor, { expectedVersion: input.expectedVersion })
  const rows = await versionsOf(record.rows.map((r) => r.id))
  await auditLogService.write({
    userId: actor, entityType: 'ChannelListing', entityId: listingId, action: 'listing.channel-id.unlink',
    before: { externalListingId: record.externalId }, after: { externalListingId: null },
    metadata: { channel: coordinate.channel, marketplace: coordinate.market, accountId: coordinate.accountId, rows: rows.map((r) => r.listingId), snapshots: record.snapshotIds },
  })
  return { ok: true, listingId, externalId: record.externalId, rows, sentence: unlinkSentence(record.externalId, coordinate.channel) }
}
