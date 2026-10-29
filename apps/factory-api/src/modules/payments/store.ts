import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { toUtcIso } from '@nexus/factory-domain/core/time'
import { asMoney } from '@nexus/factory-domain/money/marked'
import { PAYMENTS_VIEW } from '@nexus/factory-domain/payments/permissions'
import type { CommandCaller, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'

/**
 * The payments module's reads (factory-db money.prisma Payment, PaymentAllocation; sales' DepositRequest): the columns,
 * the views (amounts marked with the price grain), and who may see and act on a payment: office only, can() on its
 * company AND its party.
 */

export type Reader = FactoryClient | CommandTx

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface MoneyScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: MoneyScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

export function assertMay(context: OfficeContext, see: Permission, permission: Permission, scope: MoneyScope | null, what = 'Payment'): asserts scope is MoneyScope {
  if (!scope || !mayOn(context, see, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

export const PAYMENT_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  method: true,
  amount: true,
  currency: true,
  receivedOn: true,
  externalRef: true,
  status: true,
  voidedAt: true,
  voidReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentSelect
export type PaymentRow = Prisma.PaymentGetPayload<{ select: typeof PAYMENT_COLUMNS }>

export const ALLOCATION_COLUMNS = {
  id: true,
  paymentId: true,
  invoiceId: true,
  depositRequestId: true,
  amount: true,
  reversalOfId: true,
  note: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentAllocationSelect
export type AllocationRow = Prisma.PaymentAllocationGetPayload<{ select: typeof ALLOCATION_COLUMNS }>

export async function readPayment(db: Reader, paymentId: string): Promise<PaymentRow | null> {
  if (!isUuid(paymentId)) return null
  return db.payment.findUnique({ where: { id: paymentId }, select: PAYMENT_COLUMNS })
}

/** The payment the office may see (else 404) and act on with `permission` (else 403). */
export async function officePayment(caller: CommandCaller, paymentId: string, permission: Permission = PAYMENTS_VIEW): Promise<PaymentRow> {
  const context = officeContextOf(caller)
  const payment = await caller.withClient((client) => readPayment(client, paymentId))
  assertMay(context, PAYMENTS_VIEW, permission, payment)
  return payment!
}

/** What a payment pays now: the sum of its allocations (reversals included). */
export async function allocatedOf(db: Reader, paymentId: string): Promise<number> {
  return (await db.paymentAllocation.aggregate({ where: { paymentId }, _sum: { amount: true } }))._sum.amount ?? 0
}

export const allocationView = (row: AllocationRow) => ({
  id: row.id,
  target: row.invoiceId ? ('INVOICE' as const) : ('DEPOSIT_REQUEST' as const),
  targetId: (row.invoiceId ?? row.depositRequestId)!,
  amount: asMoney('price', row.amount),
  reversalOfId: row.reversalOfId,
  reversed: false,
  note: row.note,
  createdAt: toUtcIso(row.createdAt),
  createdById: row.createdById,
})

/** The payment record: its facts, its allocations (with which ones are reversed) and what it has left. */
export async function paymentDetail(db: Reader, payment: PaymentRow) {
  const allocations = await db.paymentAllocation.findMany({ where: { paymentId: payment.id }, select: ALLOCATION_COLUMNS, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })
  const party = await db.party.findUnique({ where: { id: payment.partyId }, select: { code: true, legalName: true } })
  const reversed = new Set(allocations.flatMap((row) => (row.reversalOfId ? [row.reversalOfId] : [])))
  const allocated = allocations.reduce((sum, row) => sum + row.amount, 0)
  return {
    id: payment.id,
    version: payment.version,
    companyId: payment.companyId,
    partyId: payment.partyId,
    party: party ?? { code: '', legalName: '' },
    method: payment.method,
    amount: asMoney('price', payment.amount),
    currency: payment.currency,
    receivedOn: payment.receivedOn.toISOString().slice(0, 10),
    externalRef: payment.externalRef,
    status: payment.status,
    voidedAt: payment.voidedAt ? toUtcIso(payment.voidedAt) : null,
    voidReason: payment.voidReason,
    internalNote: payment.internalNote,
    allocated: asMoney('price', allocated),
    unallocated: asMoney('price', payment.status === 'VOIDED' ? 0 : payment.amount - allocated),
    allocations: allocations.map((row) => ({ ...allocationView(row), reversed: reversed.has(row.id) })),
    createdAt: toUtcIso(payment.createdAt),
    createdById: payment.createdById,
  }
}

export type PaymentDetail = Awaited<ReturnType<typeof paymentDetail>>
