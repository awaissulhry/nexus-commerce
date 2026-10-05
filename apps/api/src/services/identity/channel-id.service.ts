/**
 * Item ID control (docs/sheet-ids-sku-rows/A2-item-id-control.md, step I1) — the product sheet's eBay Item ID cell, as
 * the signed-in person: Check (prove an Item ID on eBay, writing nothing), Link (write it), Clear (unlink it).
 *
 * The rules are identity-fix's, the ones Claude's link-channel-id / unlink-channel-id use (one rule, both paths); this
 * file adds only what the sheet needs around them:
 *   - eBay only in this step, and on the family's MAIN row only: one eBay item carries the whole variation family, so a
 *     variation row says "Set on the main row" and is refused here too;
 *   - the fence: the Item ID and the listing version the sheet read (a listing that moved since is refused, nothing
 *     changes); identity-fix re-checks every row it writes on its own id and version inside the transaction;
 *   - no "link it anyway": an item Nexus cannot prove is this account's is refused (Claude's tool asks a person instead);
 *   - an audit row per write (who, which item), besides the snapshots identity-fix keeps.
 * Nothing here is sent to eBay except the GetItem read (through the gateway). Pushes stay paused after a link.
 */
import prisma from '../../db.js'
import { auditLogService } from '../audit-log.service.js'
import {
  IdentityFixRefusal, PUSHES_STAY_PAUSED, LISTING_CHANGED, checkChannelId, coordinateOf, runLink, runUnlink,
  type ChannelIdCheck, type Coordinate,
} from './identity-fix.service.js'

/** The sentence a variation row's control gives (the sheet's cell says the same). */
export const MAIN_ROW_ONLY = 'Set on the main row: one eBay Item ID carries the whole variation family.'
export const EBAY_ONLY = 'Only an eBay Item ID can be changed here yet.'
/** The Clear confirm's words, for the web's dialog and the answer. */
export const unlinkSentence = (itemId: string) => `Nexus forgets item ${itemId}. Nothing changes on eBay; it stays live and Nexus stops updating it.`

export interface ChannelIdFence {
  /** The Item ID the sheet showed for the listing (null: none). */
  expectedExternalId: string | null
  /** The listing version the sheet read. */
  expectedVersion: number
}

async function sheetCoordinate(listingId: string): Promise<Coordinate> {
  const coordinate = await coordinateOf(listingId)
  if (!coordinate) throw new IdentityFixRefusal('Listing not found', 'not_found')
  if (coordinate.channel !== 'EBAY') throw new IdentityFixRefusal(EBAY_ONLY)
  if (!coordinate.asked.isMain) throw new IdentityFixRefusal(MAIN_ROW_ONLY)
  return coordinate
}

function fence(coordinate: Coordinate, input: ChannelIdFence): void {
  if (coordinate.asked.version !== input.expectedVersion || (coordinate.externalId ?? null) !== (input.expectedExternalId ?? null)) {
    throw new IdentityFixRefusal(LISTING_CHANGED, 'conflict')
  }
}

/** The versions the written rows carry now: the sheet keeps them, so the event its own write sends reads as its own echo. */
async function versionsOf(ids: string[]): Promise<Array<{ listingId: string; version: number }>> {
  if (!ids.length) return []
  const rows = await prisma.channelListing.findMany({ where: { id: { in: ids } }, select: { id: true, version: true } })
  const version = new Map(rows.map((r) => [r.id, r.version]))
  return ids.map((id) => ({ listingId: id, version: version.get(id) ?? 0 }))
}

/** Check: what eBay says of a typed Item ID (or, with none, of the one Nexus holds). Writes nothing. */
export async function checkSheetChannelId(listingId: string, input: { externalId?: string | null }): Promise<ChannelIdCheck> {
  await sheetCoordinate(listingId)
  return checkChannelId(listingId, input)
}

export interface SheetLinkResult {
  ok: true
  listingId: string
  externalId: string
  status: 'ACTIVE' | 'ENDED' | null
  /** The rows written (none when eBay confirms what Nexus already holds). */
  rows: Array<{ listingId: string; version: number }>
  /** Rows moved from another item to this one (eBay showed their SKU on it), as the Check listed them before Link. */
  moved: Array<{ id: string; sku: string; fromItemId: string; sentence: string }>
  kept: Array<{ id: string; sku: string; externalListingId: string; sentence: string }>
  sentence: string
  pushes: string
}

/**
 * Link (or Keep, when the id is the one the listing holds): proven on eBay again, then written fenced on the ids and
 * versions the rows carried. Refused, nothing changed, when the link cannot work.
 */
export async function linkSheetChannelId(listingId: string, input: ChannelIdFence & { externalId: string }, actor: string | null): Promise<SheetLinkResult> {
  const coordinate = await sheetCoordinate(listingId)
  fence(coordinate, input)
  const externalId = input.externalId.trim()
  const record = await runLink(listingId, { externalId, expectedExternalId: externalId, expectedVersion: input.expectedVersion, actor, sheet: true })
  const rows = await versionsOf(record.rows.map((r) => r.id))
  if (rows.length) {
    await auditLogService.write({
      userId: actor, entityType: 'ChannelListing', entityId: listingId, action: 'listing.channel-id.link',
      before: { externalListingId: input.expectedExternalId }, after: { externalListingId: record.externalId, listingStatus: record.status ?? null },
      metadata: { channel: coordinate.channel, marketplace: coordinate.market, accountId: coordinate.accountId, rows: rows.map((r) => r.listingId), snapshots: record.snapshotIds ?? [],
        ...(record.moved?.length ? { moved: record.moved.map((m) => ({ listingId: m.id, from: m.fromItemId })) } : {}) },
    })
  }
  const status = record.status ?? null
  const moved = (record.moved ?? []).map((m) => ({ id: m.id, sku: m.sku, fromItemId: m.fromItemId, sentence: m.sentence }))
  const movedWords = moved.length ? ` ${moved.length} of them moved from another item (${moved.map((m) => m.sku).join(', ')}).` : ''
  const sentence = !rows.length ? `eBay confirms item ${record.externalId}; Nexus already holds it. Nothing changed.`
    : status === 'ENDED' ? `Linked item ${record.externalId} on ${rows.length} row${rows.length === 1 ? '' : 's'}.${movedWords} It has ended on eBay: the rows read Ended, and Relist is offered.`
    : `Linked item ${record.externalId} on ${rows.length} row${rows.length === 1 ? '' : 's'}.${movedWords}`
  return { ok: true, listingId, externalId: record.externalId, status, rows, moved, kept: record.kept ?? [], sentence, pushes: PUSHES_STAY_PAUSED }
}

export interface SheetUnlinkResult {
  ok: true
  listingId: string
  externalId: string
  rows: Array<{ listingId: string; version: number }>
  sentence: string
}

/** Clear: Nexus forgets the item on every row of the family that holds it. Nothing is sent to eBay. */
export async function unlinkSheetChannelId(listingId: string, input: ChannelIdFence, actor: string | null): Promise<SheetUnlinkResult> {
  const coordinate = await sheetCoordinate(listingId)
  fence(coordinate, input)
  if (!input.expectedExternalId) throw new IdentityFixRefusal('This listing holds no Item ID: nothing to clear.')
  const record = await runUnlink(listingId, input.expectedExternalId, actor, { expectedVersion: input.expectedVersion })
  const rows = await versionsOf(record.rows.map((r) => r.id))
  await auditLogService.write({
    userId: actor, entityType: 'ChannelListing', entityId: listingId, action: 'listing.channel-id.unlink',
    before: { externalListingId: record.externalId }, after: { externalListingId: null },
    metadata: { channel: coordinate.channel, marketplace: coordinate.market, accountId: coordinate.accountId, rows: rows.map((r) => r.listingId), snapshots: record.snapshotIds },
  })
  return { ok: true, listingId, externalId: record.externalId, rows, sentence: unlinkSentence(record.externalId) }
}
