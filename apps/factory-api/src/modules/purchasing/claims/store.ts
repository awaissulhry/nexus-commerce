import type { Prisma } from '@nexus/factory-db'
import { NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import { lotUnitCost } from '@nexus/factory-domain/inventory/ledger/valuation'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { ClaimFacts, ClaimKind, ClaimRemedy, ClaimStatus } from '@nexus/factory-domain/purchasing/claims/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'
import { assertMay, officeContextOf, type Reader } from '../store'

/**
 * The supplier claims' reads (factory-db claims.prisma: SupplierClaim, SupplierClaimLine; B-W2a-44): the columns every
 * read names, who may see and act on a claim (can() on its company, site AND supplier: a role limited to some suppliers
 * reaches only theirs), the facts its rules need, and the cost of a lot's stock. Office only. A reader takes a command's
 * transaction or a scoped client: row-level security decides what it finds.
 */

/** The record type of a claim: its thread, its audit rows, its DDTs' source and the credit note's link (B-W2a-62). */
export const CLAIM_RECORD = 'SupplierClaim'

export const CLAIM_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  partyId: true,
  kind: true,
  goodsReceiptId: true,
  purchaseOrderId: true,
  foundAt: true,
  reason: true,
  remedy: true,
  status: true,
  currency: true,
  expectedCreditAmount: true,
  sentAt: true,
  sentById: true,
  supplierAnswer: true,
  answeredAt: true,
  closedAt: true,
  closeNote: true,
  cancelledAt: true,
  cancelReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SupplierClaimSelect
export type ClaimRow = Prisma.SupplierClaimGetPayload<{ select: typeof CLAIM_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  claimId: true,
  seq: true,
  discrepancyId: true,
  receiptLineId: true,
  itemId: true,
  itemColourId: true,
  lotId: true,
  hideId: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  reason: true,
  unitCost: true,
  creditAmount: true,
  moveId: true,
  ddtId: true,
  note: true,
  version: true,
  createdAt: true,
} as const satisfies Prisma.SupplierClaimLineSelect
export type LineRow = Prisma.SupplierClaimLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const readClaim = (db: Reader, id: string): Promise<ClaimRow | null> => (isUuid(id) ? db.supplierClaim.findUnique({ where: { id }, select: CLAIM_COLUMNS }) : Promise.resolve(null))
export const readLines = (db: Reader, claimId: string): Promise<LineRow[]> => db.supplierClaimLine.findMany({ where: { claimId }, orderBy: [{ seq: 'asc' }, { id: 'asc' }], select: LINE_COLUMNS })

export const claimNotFound = () => new NotFoundError('Supplier claim not found.')

/** The claim the caller may see (purchasing.view, else 404), and act on with `permission` (else 403). */
export async function officeClaim(caller: CommandCaller, claimId: string, permission: Permission = PURCHASING_VIEW): Promise<{ context: OfficeContext; claim: ClaimRow }> {
  const context = officeContextOf(caller)
  const claim = await caller.withClient((client) => readClaim(client, claimId))
  assertMay(context, permission, claim, 'Supplier claim')
  return { context, claim: claim! }
}

/** The facts factory-domain claims' rules decide on. */
export const factsOf = (claim: Pick<ClaimRow, 'number' | 'kind' | 'status' | 'remedy'>, lines: readonly Pick<LineRow, 'id' | 'seq' | 'moveId'>[]): ClaimFacts => ({
  number: claim.number,
  kind: claim.kind as ClaimKind,
  status: claim.status as ClaimStatus,
  remedy: (claim.remedy ?? null) as ClaimRemedy | null,
  lines: lines.map((line) => ({ id: line.id, seq: line.seq, moved: line.moveId !== null })),
})

/**
 * The cost per base unit of a lot's stock at its site (LOT_COST: its valuations' moving average, the receipt's purchase
 * price for a delivery), in the currency it was valued in; null when nothing valued ever came in.
 */
export async function lotCostOf(db: Reader, siteId: string, lotId: string): Promise<{ unitCost: string; currency: string } | null> {
  const rows = await db.stockValuation.findMany({ where: { siteId, lotId }, select: { quantity: true, unitCost: true, currency: true }, orderBy: { id: 'asc' } })
  if (rows.length === 0) return null
  const currency = rows[0]!.currency
  const cost = lotUnitCost(rows.filter((row) => row.currency === currency).map((row) => ({ quantity: row.quantity.toString(), unitCost: row.unitCost.toString() })))
  return cost === null ? null : { unitCost: cost.toFixed(6), currency }
}

/** The claim's advisory lock is its row: every write is ONE command on the SupplierClaim (its version bump). */
export async function claimInCommand(tx: CommandTx, claimId: string): Promise<ClaimRow> {
  const claim = await readClaim(tx, claimId)
  if (!claim) throw claimNotFound()
  return claim
}
