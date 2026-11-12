import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { INVENTORY_STOCK_VIEW } from '@nexus/factory-domain/inventory/permissions'
import { ledgerFacts, type LedgerFacts, type LedgerMove } from '@nexus/factory-domain/inventory/lots-depth/lifecycle'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { mayAt, officeContextOf } from '../ledger/access'

/**
 * What the lots-in-depth module reads of a lot (B-W2b-313): the lot with its item, colour and family links, the caller's
 * right to see it (inventory.stock.view on its company and site, else not found) and to change it (the permission asked,
 * else forbidden), and the ledger facts its lifecycle rests on. Every read runs on the caller's client (row-level security).
 */

export const LOT_SELECT = {
  id: true,
  code: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  supplierId: true,
  supplierLotRef: true,
  dyeBatch: true,
  shade: true,
  receiptLineId: true,
  receivedAt: true,
  qualityStatus: true,
  qualityNote: true,
  qualityDecidedAt: true,
  qualityDecidedById: true,
  requiresCrViTest: true,
  crViLimitMgKg: true,
  crViStatus: true,
  crViMgKg: true,
  crViEvidence: true,
  crViTestedAt: true,
  lifecycle: true,
  parentLotId: true,
  attributes: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
  item: { select: { id: true, code: true, name: true, kind: true, tracking: true, baseUom: true } },
  itemColour: { select: { id: true, code: true, name: true } },
} as const satisfies Prisma.LotSelect
export type LotData = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

export type Reader = Pick<FactoryClient, 'lot' | 'stockMove'> | Pick<CommandTx, 'lot' | 'stockMove'>

export async function readLot(db: Pick<FactoryClient, 'lot'> | Pick<CommandTx, 'lot'>, lotId: string): Promise<LotData | null> {
  return isUuid(lotId) ? db.lot.findUnique({ where: { id: lotId }, select: LOT_SELECT }) : null
}

/** The lot as the office caller may see it (404 otherwise); with `permission`, the caller must also hold it there (403). */
export async function lotFor(caller: CommandCaller, lotId: string, permission?: Permission): Promise<{ lot: LotData; context: OfficeContext }> {
  const context = officeContextOf(caller)
  const lot = await caller.withClient((client) => readLot(client, lotId))
  if (!lot || !mayAt(context, INVENTORY_STOCK_VIEW, lot)) throw new NotFoundError('Lot not found.')
  if (permission && !mayAt(context, permission, lot)) throw new ForbiddenError()
  return { lot, context }
}

const MOVE_SELECT = { lotId: true, reason: true, baseQuantity: true, reversalOfId: true, fromLocationId: true, toLocationId: true } as const

/** Every move of these lots at their site, as the lifecycle reads them. */
export async function movesOf(db: Pick<FactoryClient, 'stockMove'> | Pick<CommandTx, 'stockMove'>, lotIds: readonly string[]): Promise<Map<string, LedgerMove[]>> {
  const byLot = new Map<string, LedgerMove[]>(lotIds.map((lotId) => [lotId, []]))
  if (lotIds.length === 0) return byLot
  const rows = await db.stockMove.findMany({ where: { lotId: { in: [...lotIds] } }, select: MOVE_SELECT })
  for (const row of rows) {
    byLot.get(row.lotId!)?.push({ reason: row.reason, baseQuantity: row.baseQuantity.toString(), reversalOfId: row.reversalOfId, fromLocationId: row.fromLocationId, toLocationId: row.toLocationId })
  }
  return byLot
}

/** The ledger facts of these lots (lot id → facts). */
export async function factsOf(db: Pick<FactoryClient, 'stockMove'> | Pick<CommandTx, 'stockMove'>, lotIds: readonly string[]): Promise<Map<string, LedgerFacts>> {
  const moves = await movesOf(db, lotIds)
  return new Map([...moves].map(([lotId, list]) => [lotId, ledgerFacts(list)]))
}

/** The family a lot belongs to: the lot that is no child (itself, or its parent) and the lots split from it. */
export async function familyOf(db: Pick<FactoryClient, 'lot'> | Pick<CommandTx, 'lot'>, lot: Pick<LotData, 'id' | 'parentLotId'>): Promise<{ parent: LotData; children: LotData[] }> {
  const parentId = lot.parentLotId ?? lot.id
  // One after the other: inside a command's transaction they share one connection.
  const parent = await db.lot.findUnique({ where: { id: parentId }, select: LOT_SELECT })
  const children = await db.lot.findMany({ where: { parentLotId: parentId }, select: LOT_SELECT, orderBy: [{ code: 'asc' }, { id: 'asc' }] })
  if (!parent) throw new NotFoundError('Lot not found.')
  return { parent, children }
}

/** The office users' names (inside one lot's record only). */
export async function namesOf(db: Pick<FactoryClient, 'user'> | Pick<CommandTx, 'user'>, ids: readonly (string | null | undefined)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => typeof value === 'string' && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}
