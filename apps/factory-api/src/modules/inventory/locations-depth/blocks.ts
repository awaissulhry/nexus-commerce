import type { Prisma } from '@nexus/factory-db'
import { ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { scopeWhere } from '@nexus/factory-domain/core/permissions'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import {
  blockHolds,
  blockProblems,
  countBlockNote,
  countBlocksPlaces,
  placesToBlock,
  placesToRelease,
  unblockProblems,
  type BlockReason,
} from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { subtreeIds } from '@nexus/factory-domain/inventory/locations-depth/tree'
import { INVENTORY_LOCATIONS_MANAGE, INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { command, type CommandCaller, type CommandTools } from '../../../core/command'
import { actorOf } from '../../../core/context'
import { officeContextOf, siteFor, stockContextOf } from '../ledger/access'
import type { PlaceView } from './contract'
import { blockInstant, blockToday, dayOf, PLACE_SELECT, placeIn, placeViewOf, storedBlock, toDay, visiblePlace, type PlaceRow } from './places'

/**
 * Block and unblock a location (B-W2b-289; SCM-181; design warehouse.locations row ⋯ "Block location": reason (count,
 * damage, clean-up) · until date). Office, inventory.locations.manage; one command each, on the location's version:
 *
 *   POST /inventory/locations/:locationId/block     {version, reason, note?, until?}: blocks it, or changes its block
 *   POST /inventory/locations/:locationId/unblock   {version}: clears the five columns
 *   GET  /inventory/locations/blocked?siteId=       the blocked places the caller sees (a floor device: its site's), with
 *                                                   their block (holds false once the until-day passed)
 *
 * While a block holds, every move in or out but a count's COUNT is refused: by postMoves first in words (409, issue
 * warehouse/LOCATION_BLOCKED), by the database as the last word. A count blocks its locations while it runs
 * (`blockForCount`, `releaseForCount`, called by modules/inventory/counts inside its own commands; factory-domain
 * inventory/locations-depth blocks.ts says which). Event inventory.location_blocked for each place.
 */

function refuse(issues: readonly Issue[], prefix = 'body'): never {
  throw new ValidationError(issues.length === 1 ? issues[0]!.message : 'The block is not valid.', issues.map((issue) => ({ path: issue.path === 'location' ? 'location' : `${prefix}/${issue.path}`, message: issue.message })))
}

function blocked(emit: CommandTools['emit'], row: PlaceRow, change: 'BLOCKED' | 'CHANGED' | 'UNBLOCKED', countId: string | null): void {
  emit({
    type: 'inventory.location_blocked',
    subject: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    payload: { locationId: row.id, code: row.code, change, reason: change === 'UNBLOCKED' ? null : row.blockReason, until: change === 'UNBLOCKED' ? null : dayOf(row.blockedUntil), countId },
  })
}

const audited = (row: PlaceRow) => ({ blockedAt: row.blockedAt?.toISOString() ?? null, blockedById: row.blockedById, blockReason: row.blockReason, blockNote: row.blockNote, blockedUntil: dayOf(row.blockedUntil) })

export interface BlockBody {
  readonly version: number
  readonly reason: BlockReason
  readonly note?: string | null | undefined
  readonly until?: BusinessDate | null | undefined
}

/** inventory.locations.block: blocks a place (or changes its block: reason, words, until-day). */
export async function blockLocation(caller: CommandCaller, locationId: string, body: BlockBody, idempotencyKey?: string): Promise<PlaceView> {
  const context = officeContextOf(caller)
  const before = await visiblePlace(caller, locationId, INVENTORY_LOCATIONS_MANAGE)
  const today = blockToday()
  const first = blockProblems({ ...before, ...storedBlock(before) }, body, today)
  if (first.length > 0) refuse(first)
  const { result } = await command(
    caller,
    { name: 'inventory.locations.block', idempotencyKey, input: { locationId, ...body }, record: { type: 'Location', id: locationId, expectedVersion: body.version } },
    async ({ tx, audit, emit, now }) => {
      // The row is locked now (command()'s version bump): its block as it is.
      const current = await placeIn(tx, locationId)
      const problems = blockProblems({ ...current, ...storedBlock(current) }, body, today)
      if (problems.length > 0) refuse(problems)
      const wasBlocked = blockHolds(storedBlock(current), today)
      const note = body.note?.trim() ? body.note.trim() : null
      const row = await tx.location.update({
        where: { id: locationId },
        data: {
          // A changed block keeps when it started; a new one (or one whose day passed) starts now.
          blockedAt: wasBlocked ? current.blockedAt : blockInstant(now),
          blockedById: wasBlocked ? current.blockedById : context.actorId,
          blockReason: body.reason,
          blockNote: note,
          blockedUntil: body.until ? toDay(body.until) : null,
        },
        select: PLACE_SELECT,
      })
      audit({ recordType: 'Location', recordId: locationId, companyId: row.companyId, siteId: row.siteId, before: audited(current), after: audited(row) })
      blocked(emit, row, wasBlocked ? 'CHANGED' : 'BLOCKED', null)
      return placeViewOf(row, today)
    },
  )
  return result
}

/** inventory.locations.unblock: the place takes moves again. */
export async function unblockLocation(caller: CommandCaller, locationId: string, body: { readonly version: number }, idempotencyKey?: string): Promise<PlaceView> {
  officeContextOf(caller)
  const before = await visiblePlace(caller, locationId, INVENTORY_LOCATIONS_MANAGE)
  const first = unblockProblems({ code: before.code, ...storedBlock(before) })
  if (first.length > 0) refuse(first)
  const { result } = await command(
    caller,
    { name: 'inventory.locations.unblock', idempotencyKey, input: { locationId, ...body }, record: { type: 'Location', id: locationId, expectedVersion: body.version } },
    async ({ tx, audit, emit }) => {
      const current = await placeIn(tx, locationId)
      const problems = unblockProblems({ code: current.code, ...storedBlock(current) })
      if (problems.length > 0) refuse(problems)
      const row = await tx.location.update({ where: { id: locationId }, data: { blockedAt: null, blockedById: null, blockReason: null, blockNote: null, blockedUntil: null }, select: PLACE_SELECT })
      audit({ recordType: 'Location', recordId: locationId, companyId: row.companyId, siteId: row.siteId, before: audited(current), after: audited(row) })
      blocked(emit, current, 'UNBLOCKED', null)
      return placeViewOf(row)
    },
  )
  return result
}

/** GET /inventory/locations/blocked: the blocked places the caller sees, by site and code. */
export async function blockedLocations(caller: CommandCaller, query: { readonly siteId?: string | undefined }): Promise<{ locations: PlaceView[] }> {
  const context = stockContextOf(caller)
  if (query.siteId) await siteFor(caller, query.siteId, INVENTORY_LOCATIONS_VIEW, 'siteId')
  const where: Prisma.LocationWhereInput = {
    AND: [
      context.audience === 'system' ? {} : (scopeWhere(actorOf(context), INVENTORY_LOCATIONS_VIEW, { company: 'companyId', site: 'siteId' }) as Prisma.LocationWhereInput),
      query.siteId ? { siteId: query.siteId } : {},
      { blockedAt: { not: null } },
    ],
  }
  const rows = await caller.withClient((client) => client.location.findMany({ where, select: PLACE_SELECT, orderBy: [{ siteId: 'asc' }, { code: 'asc' }, { id: 'asc' }], take: 1000 }))
  const today = blockToday()
  return { locations: rows.map((row) => placeViewOf(row, today)) }
}

// ---- a count blocks its locations while it runs ------------------------------------------------------------------------------

/** A count as its block reads it. */
export interface CountForBlock {
  readonly id: string
  readonly number: string
  readonly siteId: string
  readonly locationId: string | null
  readonly itemId: string | null
  readonly lotId: string | null
  readonly itemKind: string | null
}

/**
 * Inside the count's command as it starts counting (or counts again after a send-back): a count of a place blocks that
 * place and the places inside it (reason COUNT, the count's mark in the words), except the ones blocked already. Returns
 * the codes it blocked.
 */
export async function blockForCount(tools: CommandTools, count: CountForBlock): Promise<string[]> {
  if (!countBlocksPlaces(count)) return []
  const { tx, now, context, audit, emit } = tools
  const site = await tx.location.findMany({ where: { siteId: count.siteId }, select: { id: true, parentId: true, code: true } })
  const ids = subtreeIds(site, count.locationId!)
  const places = await tx.location.findMany({ where: { id: { in: ids } }, select: PLACE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const today = blockToday()
  const chosen = placesToBlock(places.map((row) => ({ ...row, ...storedBlock(row) })), today)
  const at = blockInstant(now)
  const by = context.audience === 'office' ? context.actorId : null
  const note = countBlockNote(count.number)
  for (const place of chosen) {
    const before = places.find((row) => row.id === place.id)!
    const row = await tx.location.update({
      where: { id: place.id },
      data: { blockedAt: at, blockedById: by, blockReason: 'COUNT', blockNote: note, blockedUntil: null, version: { increment: 1 } },
      select: PLACE_SELECT,
    })
    audit({ action: 'inventory.locations.countBlock', recordType: 'Location', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: audited(before), after: { ...audited(row), countId: count.id } })
    blocked(emit, row, 'BLOCKED', count.id)
  }
  return chosen.map((place) => places.find((row) => row.id === place.id)!.code)
}

/** Inside the count's command as its counting ends (submitted, cancelled): unblocks the places carrying its own block. */
export async function releaseForCount(tools: CommandTools, count: Pick<CountForBlock, 'id' | 'number' | 'siteId'>): Promise<string[]> {
  const { tx, audit, emit } = tools
  const places = await tx.location.findMany({ where: { siteId: count.siteId, blockReason: 'COUNT', blockNote: countBlockNote(count.number) }, select: PLACE_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  const chosen = placesToRelease(places.map((row) => ({ ...row, ...storedBlock(row) })), count.number)
  for (const place of chosen) {
    const before = places.find((row) => row.id === place.id)!
    const row = await tx.location.update({
      where: { id: place.id },
      data: { blockedAt: null, blockedById: null, blockReason: null, blockNote: null, blockedUntil: null, version: { increment: 1 } },
      select: PLACE_SELECT,
    })
    audit({ action: 'inventory.locations.countUnblock', recordType: 'Location', recordId: row.id, companyId: row.companyId, siteId: row.siteId, before: audited(before), after: { ...audited(row), countId: count.id } })
    blocked(emit, before, 'UNBLOCKED', count.id)
  }
  return chosen.map((place) => places.find((row) => row.id === place.id)!.code)
}
