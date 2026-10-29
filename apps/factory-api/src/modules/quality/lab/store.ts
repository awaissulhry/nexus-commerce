import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, type BusinessDate } from '@nexus/factory-domain/core/time'
import { CR_VI_SCALE, type CrViEvidence, type LotFacts } from '@nexus/factory-domain/quality/lab/rules'
import { Dec } from '@nexus/factory-domain/tax/decimal'
import { QUALITY_LOTS_VIEW } from '@nexus/factory-domain/quality/lab/permissions'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'
import { lockStock } from '../../inventory/ledger/post-moves'

/**
 * The lab step's reads of a lot (factory-db inventory.prisma Lot, GoodsReceiptLine, GoodsReceipt, StockMove; product.prisma
 * Item; compliance.prisma Certificate, CertificateCoverage): the columns every read names, who may see and decide a lot,
 * the certificate that covers a PPE component, and the stock locks of where a lot lies (taken before a lot is blocked,
 * so an issue in flight either lands before the trace is read or is refused by the trigger after). Office only.
 */

export type Reader = FactoryClient | CommandTx

export const LOT_SELECT = {
  id: true,
  companyId: true,
  siteId: true,
  itemId: true,
  itemColourId: true,
  code: true,
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
  version: true,
  createdAt: true,
  createdById: true,
  item: { select: { id: true, code: true, name: true, kind: true, isPpeComponent: true } },
} as const satisfies Prisma.LotSelect
export type LotRow = Prisma.LotGetPayload<{ select: typeof LOT_SELECT }>

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export const mayOn = (context: OfficeContext, permission: Permission, lot: { readonly companyId: string; readonly siteId: string }): boolean =>
  can(actorOf(context), permission, { companyId: lot.companyId, siteId: lot.siteId })

/** A DATE column as its calendar day (Prisma reads it as midnight UTC). */
export const dayOf = (value: Date): BusinessDate => value.toISOString().slice(0, 10)
/** A Decimal(8,3) column as text with its three decimals ("3.000"), or null. */
export const decimalOrNull = (value: { toString(): string } | null): string | null => (value === null ? null : new Dec(value.toString()).toFixed(CR_VI_SCALE))

export async function readLot(client: Reader, lotId: string): Promise<LotRow | null> {
  return isUuid(lotId) ? client.lot.findUnique({ where: { id: lotId }, select: LOT_SELECT }) : null
}

/**
 * The lot as the caller may see it (quality.lots.view, or the permission it acts with, over the lot's company and site),
 * then that it may act: one it may not see is not found, one it sees but may not change is forbidden.
 */
export async function lotFor(caller: CommandCaller, lotId: string, permission: Permission = QUALITY_LOTS_VIEW): Promise<LotRow> {
  const context = officeOf(caller)
  const lot = await caller.withClient((client) => readLot(client, lotId))
  if (!lot || !(mayOn(context, QUALITY_LOTS_VIEW, lot) || mayOn(context, permission, lot))) throw new NotFoundError('Lot not found.')
  if (!mayOn(context, permission, lot)) throw new ForbiddenError(`This needs ${permission} over the lot's company and site.`)
  return lot
}

/** The receiver's hold while in quarantine (receipts keep it in qualityNote; the lab step clears it). */
export const holdNoteOf = (lot: Pick<LotRow, 'qualityStatus' | 'qualityNote'>): string | null => (lot.qualityStatus === 'QUARANTINE' && lot.qualityNote?.trim() ? lot.qualityNote.trim() : null)

export function factsOf(lot: LotRow): LotFacts {
  return {
    code: lot.code,
    qualityStatus: lot.qualityStatus,
    requiresCrViTest: lot.requiresCrViTest,
    crViStatus: lot.crViStatus,
    crViEvidence: (lot.crViEvidence ?? null) as CrViEvidence | null,
    crViMgKg: decimalOrNull(lot.crViMgKg),
    crViLimitMgKg: decimalOrNull(lot.crViLimitMgKg),
    isPpeComponent: lot.item.isPpeComponent,
    holdNote: holdNoteOf(lot),
    receivedById: lot.createdById,
    receivedDay: lot.receivedAt ? businessDate(lot.receivedAt) : null,
  }
}

/** The receipt a lot came with: its number and status (null: opening stock). */
export async function receiptOf(client: Reader, lot: Pick<LotRow, 'receiptLineId'>): Promise<{ id: string; number: string; status: 'OPEN' | 'POSTED' | 'REVERSED' | 'CANCELLED' } | null> {
  if (!lot.receiptLineId) return null
  const line = await client.goodsReceiptLine.findUnique({ where: { id: lot.receiptLineId }, select: { receiptId: true } })
  if (!line) return null
  return client.goodsReceipt.findUnique({ where: { id: line.receiptId }, select: { id: true, number: true, status: true } })
}

/**
 * The certificate in the register that covers a PPE component today (compliance.prisma, B-W1-12): VALID, its validity
 * holding today, an ACTIVE coverage of the item; the company's own or one a brand or supplier holds (no company).
 */
export async function certificateCovering(client: Reader, lot: Pick<LotRow, 'itemId' | 'companyId'>, today: BusinessDate) {
  const day = new Date(`${today}T00:00:00.000Z`)
  const coverage = await client.certificateCoverage.findMany({
    where: {
      itemId: lot.itemId,
      status: 'ACTIVE',
      certificate: { status: 'VALID', validFrom: { lte: day }, validTo: { gte: day }, OR: [{ companyId: null }, { companyId: lot.companyId }] },
    },
    select: { certificate: { select: { id: true, number: true, standard: true, validTo: true } } },
  })
  const best = coverage.map((row) => row.certificate).sort((a, b) => b.validTo.getTime() - a.validTo.getTime() || (a.id < b.id ? -1 : 1))[0]
  return best ? { id: best.id, number: best.number, standard: best.standard, validTo: dayOf(best.validTo) } : null
}

/**
 * The stock locks of every place the lot's stock lies now (the ledger's `factory.stock` keys, per location and hide),
 * inside a command, after the lot's own row. An issue holds the same locks while it posts; once they are ours, an issue
 * that comes after reads the lot's new status in the ledger's trigger (only RELEASED stock is issued).
 */
export async function lockLotStock(tx: CommandTx, tenantId: string, lot: Pick<LotRow, 'id' | 'siteId' | 'itemId' | 'itemColourId'>): Promise<void> {
  const places = await tx.$queryRaw<{ locationId: string; hideId: string | null }[]>`
    SELECT p."locationId"::text AS "locationId", p."hideId"::text AS "hideId"
      FROM (SELECT "toLocationId" AS "locationId", "hideId", "baseQuantity" AS q FROM "StockMove" WHERE "lotId" = ${lot.id}::uuid AND "toLocationId" IS NOT NULL
            UNION ALL
            SELECT "fromLocationId", "hideId", -"baseQuantity" FROM "StockMove" WHERE "lotId" = ${lot.id}::uuid AND "fromLocationId" IS NOT NULL) p
     GROUP BY p."locationId", p."hideId"
    HAVING sum(p.q) > 0`
  await lockStock(
    tx,
    tenantId,
    places.map((place) => ({ siteId: lot.siteId, itemId: lot.itemId, itemColourId: lot.itemColourId, lotId: lot.id, hideId: place.hideId, locationId: place.locationId })),
  )
}
