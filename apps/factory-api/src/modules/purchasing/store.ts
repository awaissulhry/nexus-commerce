import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { decimalText } from '@nexus/factory-domain/product/units/units'
import { PURCHASING_VIEW } from '@nexus/factory-domain/purchasing/permissions'
import type { CommandCaller, CommandTools, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'

/**
 * The purchase orders' reads (factory-db supply.prisma PurchaseOrder, PurchaseOrderLine): the columns every read names,
 * who may see and act on an order, and the item, supplier and site facts a line and a send need. Office only: can() on
 * the order's company, delivery site AND supplier, so a role limited to some suppliers or sites reaches only theirs. A
 * reader takes a command's transaction or a scoped client: row-level security decides what it finds.
 */

export type Reader = FactoryClient | CommandTx

export function officeContextOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface OrderScope {
  readonly companyId: string
  readonly siteId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: OrderScope): boolean =>
  can(actorOf(context), permission, { companyId: scope.companyId, siteId: scope.siteId, partyId: scope.partyId })

/** The caller may see the order (purchasing.view, else 404) and do `permission` on it (else 403). */
export function assertMay(context: OfficeContext, permission: Permission, scope: OrderScope | null, what = 'Purchase order'): asserts scope is OrderScope {
  if (!scope || !mayOn(context, PURCHASING_VIEW, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

/** The caller holds the cost grain (A1 §2.6): purchase prices are costs. */
export const seesCost = (context: OfficeContext): boolean => heldGrains(actorOf(context)).has('cost')

export const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

export const ORDER_COLUMNS = {
  id: true,
  companyId: true,
  siteId: true,
  number: true,
  partyId: true,
  contactId: true,
  status: true,
  revision: true,
  currency: true,
  orderDate: true,
  requestedDate: true,
  incoterms: true,
  paymentTerms: true,
  note: true,
  internalNote: true,
  netAmount: true,
  sentAt: true,
  sentById: true,
  confirmedAt: true,
  confirmedVia: true,
  confirmLinkId: true,
  confirmedByName: true,
  supplierRef: true,
  confirmNote: true,
  declinedAt: true,
  declineReason: true,
  closedAt: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.PurchaseOrderSelect
export type OrderRow = Prisma.PurchaseOrderGetPayload<{ select: typeof ORDER_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  purchaseOrderId: true,
  seq: true,
  itemId: true,
  itemColourId: true,
  description: true,
  supplierArticleCode: true,
  supplierColourCode: true,
  quantity: true,
  uom: true,
  baseQuantity: true,
  unitPrice: true,
  netAmount: true,
  needDate: true,
  grade: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  oneDyeBatch: true,
  areaTolerancePct: true,
  estimatedHides: true,
  requiresCrViTest: true,
  note: true,
  confirmedQuantity: true,
  confirmedDate: true,
  version: true,
} as const satisfies Prisma.PurchaseOrderLineSelect
export type LineRow = Prisma.PurchaseOrderLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const ITEM_COLUMNS = {
  id: true,
  companyId: true,
  code: true,
  name: true,
  kind: true,
  status: true,
  baseUom: true,
  purchaseUom: true,
  purchaseFactor: true,
  consumptionUom: true,
  consumptionFactor: true,
  defaultSupplierId: true,
  supplierArticleCode: true,
  leadTimeDays: true,
  minOrderQty: true,
  orderMultiple: true,
  standardCost: true,
  currency: true,
  grade: true,
  thicknessMinMm: true,
  thicknessMaxMm: true,
  requiresCrViTest: true,
} as const satisfies Prisma.ItemSelect
export type ItemRow = Prisma.ItemGetPayload<{ select: typeof ITEM_COLUMNS }>

export const PARTY_COLUMNS = { id: true, companyId: true, code: true, legalName: true, roles: true, status: true, currency: true, language: true, paymentTerms: true, leadTimeDays: true } as const satisfies Prisma.PartySelect
export type PartyRow = Prisma.PartyGetPayload<{ select: typeof PARTY_COLUMNS }>

export const CONTACT_COLUMNS = { id: true, partyId: true, name: true, email: true, roles: true, language: true, status: true } as const satisfies Prisma.PartyContactSelect
export type ContactRow = Prisma.PartyContactGetPayload<{ select: typeof CONTACT_COLUMNS }>

export const SITE_COLUMNS = { id: true, companyId: true, code: true, name: true, address: true, status: true } as const satisfies Prisma.SiteSelect
export type SiteRow = Prisma.SiteGetPayload<{ select: typeof SITE_COLUMNS }>

/** A decimal column as plain text ("5", "1.2"); null stays null. */
export const decimal = (value: { toString(): string } | null): string | null => (value === null ? null : decimalText(value.toString()))
/** A decimal column with four places (a quantity as stored). */
export const quantityText = (value: { toFixed(places: number): string }): string => value.toFixed(4)
/** A Date column of type DATE as YYYY-MM-DD. */
export const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))
/** YYYY-MM-DD as the Date a DATE column takes. */
export const dayValue = (value: string): Date => new Date(`${value}T00:00:00.000Z`)

export const unitsOf = (item: Pick<ItemRow, 'baseUom' | 'purchaseUom' | 'purchaseFactor' | 'consumptionUom' | 'consumptionFactor'>) => ({
  baseUom: item.baseUom,
  purchaseUom: item.purchaseUom,
  purchaseFactor: item.purchaseFactor.toString(),
  consumptionUom: item.consumptionUom,
  consumptionFactor: item.consumptionFactor.toString(),
})

export const readOrder = (db: Reader, id: string): Promise<OrderRow | null> => (isUuid(id) ? db.purchaseOrder.findUnique({ where: { id }, select: ORDER_COLUMNS }) : Promise.resolve(null))

export const readLines = (db: Reader, orderId: string): Promise<LineRow[]> => db.purchaseOrderLine.findMany({ where: { purchaseOrderId: orderId }, orderBy: { seq: 'asc' }, select: LINE_COLUMNS })

/** The order the caller may see, and act on with `permission` (default: see). */
export async function officeOrder(caller: CommandCaller, orderId: string, permission: Permission = PURCHASING_VIEW): Promise<OrderRow> {
  const context = officeContextOf(caller)
  const order = await caller.withClient((client) => readOrder(client, orderId))
  assertMay(context, permission, order)
  return order!
}

/** The office user, as their mail and the thread show them (the company's purchasing desk when they have no user row). */
export async function senderOf(db: Reader, context: OfficeContext) {
  const user = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  return { userId: context.actorId, name: user?.displayName ?? 'Ufficio acquisti', email: user?.email ?? null }
}
