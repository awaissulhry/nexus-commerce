import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { businessDate, toUtcIso, type BusinessDate } from '@nexus/factory-domain/core/time'
import { blockHolds, type StoredBlock } from '@nexus/factory-domain/inventory/locations-depth/blocks'
import { INVENTORY_LOCATIONS_VIEW } from '@nexus/factory-domain/inventory/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { mayAt, stockContextOf } from '../ledger/access'
import type { BlockView, PlaceView } from './contract'

/**
 * What the parts of locations in depth share (B-W2b-289): a place's columns and its short view (code, kind, label code,
 * block), the caller's check of one place, and "today" as the database's blocks read it.
 */

export const PLACE_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  parentId: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  partyId: true,
  labelCode: true,
  blockedAt: true,
  blockedById: true,
  blockReason: true,
  blockNote: true,
  blockedUntil: true,
  version: true,
  site: { select: { code: true } },
} as const satisfies Prisma.LocationSelect
export type PlaceRow = Prisma.LocationGetPayload<{ select: typeof PLACE_SELECT }>

/** A stored date column as a business date (YYYY-MM-DD). */
export const dayOf = (value: Date | null): BusinessDate | null => (value ? (value.toISOString().slice(0, 10) as BusinessDate) : null)
/** A business date as a date column. */
export const toDay = (value: BusinessDate): Date => new Date(`${value}T00:00:00.000Z`)

/**
 * Today, Europe/Rome, as the database's block rule reads it (its own clock: `factory_money_rome_day(now())`), so a block
 * the API calls passed is one the database lets moves through, and the other way round.
 */
export const blockToday = (): BusinessDate => businessDate(new Date())

/**
 * When a block is set: the command's time, never after the database's clock (its guard refuses a block "in the future";
 * a test's clock may run ahead of it).
 */
export const blockInstant = (commandNow: Date): Date => {
  const real = new Date()
  return commandNow.getTime() > real.getTime() ? real : commandNow
}

export const storedBlock = (row: Pick<PlaceRow, 'blockedAt' | 'blockReason' | 'blockNote' | 'blockedUntil'>): StoredBlock => ({
  blockedAt: row.blockedAt,
  blockReason: row.blockReason,
  blockNote: row.blockNote,
  blockedUntil: dayOf(row.blockedUntil),
})

const COUNT_MARK = /^Count (\S+) is running here\.$/

export function blockViewOf(row: Pick<PlaceRow, 'blockedAt' | 'blockedById' | 'blockReason' | 'blockNote' | 'blockedUntil'>, today: BusinessDate = blockToday()): BlockView | null {
  if (row.blockedAt === null || row.blockReason === null) return null
  const mark = row.blockReason === 'COUNT' ? COUNT_MARK.exec(row.blockNote ?? '') : null
  return {
    reason: row.blockReason,
    note: row.blockNote,
    until: dayOf(row.blockedUntil),
    at: toUtcIso(row.blockedAt),
    byId: row.blockedById,
    holds: blockHolds(storedBlock(row), today),
    countNumber: mark ? mark[1]! : null,
  }
}

export function placeViewOf(row: PlaceRow, today: BusinessDate = blockToday()): PlaceView {
  return {
    id: row.id,
    companyId: row.companyId,
    siteId: row.siteId,
    siteCode: row.site.code,
    code: row.code,
    name: row.name,
    kind: row.kind,
    status: row.status,
    labelCode: row.labelCode,
    block: blockViewOf(row, today),
    version: row.version,
  }
}

/** A place the caller may see with this permission (a floor device: of its own site), or not found. */
export async function visiblePlace(caller: CommandCaller, locationId: string, permission: Permission = INVENTORY_LOCATIONS_VIEW): Promise<PlaceRow> {
  const context = stockContextOf(caller)
  const row = isUuid(locationId) ? await caller.withClient((client) => client.location.findUnique({ where: { id: locationId }, select: PLACE_SELECT })) : null
  if (!row || !mayAt(context, INVENTORY_LOCATIONS_VIEW, row) || !mayAt(context, permission, row)) throw new NotFoundError('Location not found.')
  return row
}

/** The place inside a command (its row as it is now). */
export const placeIn = (tx: Pick<CommandTx, 'location'>, locationId: string): Promise<PlaceRow> => tx.location.findUniqueOrThrow({ where: { id: locationId }, select: PLACE_SELECT })

/** The codes from the top of the site's tree down to this place. */
export async function pathOf(client: Pick<CommandTx, 'location'>, row: { readonly id: string; readonly siteId: string; readonly code: string }): Promise<string[]> {
  const site = await client.location.findMany({ where: { siteId: row.siteId }, select: { id: true, parentId: true, code: true } })
  const byId = new Map(site.map((entry) => [entry.id, entry]))
  const path: string[] = []
  let current: { id: string; parentId: string | null; code: string } | undefined = byId.get(row.id)
  for (let depth = 0; current && depth < 64; depth++) {
    path.unshift(current.code)
    current = current.parentId ? byId.get(current.parentId) : undefined
  }
  return path.length > 0 ? path : [row.code]
}
