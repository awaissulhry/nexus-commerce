import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, scopeWhere, type Permission } from '@nexus/factory-domain/core/permissions'
import { PAYABLES_VIEW } from '@nexus/factory-domain/payables/permissions'
import { PREPARING_ACTIONS, preparersOf } from '@nexus/factory-domain/payables/rules'
import type { CommandCaller, CommandTools, CommandTx } from '../../core/command'
import { actorOf, type OfficeContext } from '../../core/context'
import { systemContext } from '../../platform/outbox/system'

/**
 * The supplier invoices' reads (factory-db payables.prisma SupplierInvoice, SupplierInvoiceLine, SupplierInvoiceMatch):
 * the columns every read names, who may see and act on an invoice, and the locks the match takes. Office only: can() on
 * the invoice's company AND its supplier (the party), so a role limited to some suppliers reaches only theirs. A reader
 * takes a command's transaction or a scoped client: row-level security decides what it finds.
 */

export type Reader = FactoryClient | CommandTx
export const RECORD = 'SupplierInvoice'

export function officeOf(caller: CommandCaller): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface InvoiceScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: InvoiceScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

/** The caller may see the invoice (payables.view, else 404) and do `permission` on it (else 403). */
export function assertMay(context: OfficeContext, permission: Permission, scope: InvoiceScope | null): asserts scope is InvoiceScope {
  if (!scope || !mayOn(context, PAYABLES_VIEW, scope)) throw new NotFoundError('Supplier invoice not found.')
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

export const scopeOf = (context: OfficeContext, permission: Permission = PAYABLES_VIEW): Prisma.SupplierInvoiceWhereInput =>
  scopeWhere(actorOf(context), permission, { company: 'companyId', party: 'partyId' }) as Prisma.SupplierInvoiceWhereInput

/** The caller holds the cost grain (A1 §2.6): what a supplier charges is a cost. */
export const seesCost = (context: OfficeContext): boolean => heldGrains(actorOf(context)).has('cost')

export const actorIdOf = (tools: Pick<CommandTools, 'context'>): string | null => (tools.context.audience === 'office' ? tools.context.actorId : null)

/** The request acting as its tenant's system context: SDI's deliveries are registered by nobody of the office. */
export function asSystem(caller: CommandCaller): CommandCaller {
  const context = caller.factoryContext
  if (!context || !('tenantId' in context) || !context.tenantId) throw new ForbiddenError()
  const view = Object.create(caller) as CommandCaller & { factoryContext: CommandCaller['factoryContext'] }
  view.factoryContext = systemContext(context.tenantId, context.requestId)
  return view
}

export const INVOICE_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  source: true,
  kind: true,
  docType: true,
  number: true,
  issueDate: true,
  receivedOn: true,
  sdiIdentifier: true,
  sdiFileName: true,
  currency: true,
  netTotal: true,
  vatTotal: true,
  grossTotal: true,
  withholdingAmount: true,
  stampDutyAmount: true,
  vatSummary: true,
  paymentTerms: true,
  dueDate: true,
  creditOfId: true,
  xmlFileId: true,
  pdfFileId: true,
  // B-W2b-21: the file of several invoices it came in (a lotto) and its body; the claim a credit note settles.
  sdiFileId: true,
  sdiBodyIndex: true,
  claimId: true,
  claimSiteId: true,
  status: true,
  matchStatus: true,
  matchedAt: true,
  approvedAt: true,
  approvedById: true,
  approvalNote: true,
  disputedAt: true,
  disputedById: true,
  disputeReason: true,
  paidOn: true,
  paymentRef: true,
  voidedAt: true,
  voidReason: true,
  internalNote: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  createdById: true,
} as const satisfies Prisma.SupplierInvoiceSelect
export type InvoiceRow = Prisma.SupplierInvoiceGetPayload<{ select: typeof INVOICE_COLUMNS }>

export const LINE_COLUMNS = {
  id: true,
  partyId: true,
  invoiceId: true,
  seq: true,
  kind: true,
  description: true,
  itemCode: true,
  quantity: true,
  uom: true,
  unitPrice: true,
  discountPct: true,
  netAmount: true,
  vatRatePct: true,
  vatNature: true,
  siteId: true,
  purchaseOrderLineId: true,
  subcontractOrderId: true,
  version: true,
} as const satisfies Prisma.SupplierInvoiceLineSelect
export type LineRow = Prisma.SupplierInvoiceLineGetPayload<{ select: typeof LINE_COLUMNS }>

export const MATCH_COLUMNS = {
  id: true,
  siteId: true,
  invoiceLineId: true,
  purchaseOrderLineId: true,
  goodsReceiptLineId: true,
  subcontractOrderId: true,
  invoicedQuantity: true,
  receivedQuantity: true,
  orderedUnitPrice: true,
  invoicedUnitPrice: true,
  differenceAmount: true,
  quantityTolerancePct: true,
  priceTolerancePct: true,
  withinTolerance: true,
  acceptedAt: true,
  acceptedById: true,
  acceptNote: true,
  version: true,
} as const satisfies Prisma.SupplierInvoiceMatchSelect
export type MatchRow = Prisma.SupplierInvoiceMatchGetPayload<{ select: typeof MATCH_COLUMNS }>

export async function readInvoice(db: Reader, invoiceId: string): Promise<InvoiceRow | null> {
  if (!isUuid(invoiceId)) return null
  return db.supplierInvoice.findUnique({ where: { id: invoiceId }, select: INVOICE_COLUMNS })
}

export const readLines = (db: Reader, invoiceId: string): Promise<LineRow[]> => db.supplierInvoiceLine.findMany({ where: { invoiceId }, select: LINE_COLUMNS, orderBy: { seq: 'asc' } })
export const readMatches = (db: Reader, invoiceId: string): Promise<MatchRow[]> => db.supplierInvoiceMatch.findMany({ where: { invoiceId }, select: MATCH_COLUMNS, orderBy: { id: 'asc' } })

/**
 * Who of the office prepared the invoice for approval (four eyes, B-W2a-F7: factory-domain payables/rules preparersOf):
 * its lines' and match rows' writers and accepters, and its audit rows of a mapping or an acceptance (office ones only:
 * the SDI pickup and the worker's match are the system's).
 */
export async function preparationOf(db: Reader, invoiceId: string): Promise<{ mappedByIds: string[]; acceptedByIds: string[] }> {
  const lines = await db.supplierInvoiceLine.findMany({ where: { invoiceId }, select: { createdById: true } })
  const matches = await db.supplierInvoiceMatch.findMany({ where: { invoiceId }, select: { createdById: true, acceptedById: true } })
  const audit = await db.auditLog.findMany({ where: { recordType: RECORD, recordId: invoiceId, audience: 'OFFICE', action: { in: [...PREPARING_ACTIONS] } }, select: { action: true, actorId: true, before: true, after: true } })
  return preparersOf({ lines, matches, audit })
}

/** The invoice the caller may see and act on, read in its scope (404 / 403 as assertMay). */
export async function officeInvoice(caller: CommandCaller, invoiceId: string, permission: Permission = PAYABLES_VIEW): Promise<{ context: OfficeContext; invoice: InvoiceRow }> {
  const context = officeOf(caller)
  const invoice = await caller.withClient((client) => readInvoice(client, invoiceId))
  assertMay(context, permission, invoice)
  return { context, invoice: invoice! }
}

export async function invoiceInCommand(tx: CommandTx, invoiceId: string): Promise<InvoiceRow> {
  const invoice = await readInvoice(tx, invoiceId)
  if (!invoice) throw new NotFoundError('Supplier invoice not found.')
  return invoice
}

/**
 * The match's locks, held to the end of the transaction: one per order line and subcontract order the invoice's lines
 * bill (sorted), so two invoices of the same goods are matched one after the other and each sees what the other bills.
 * Taken after the invoice's own row (its version bump, or FOR UPDATE).
 */
export async function lockOrders(tx: CommandTx, tenantId: string, keys: readonly string[]): Promise<void> {
  for (const key of [...new Set(keys)].sort()) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.payables-match', ${tenantId}::text, ${key}::text), 0))`
  }
}

/** The invoice row FOR UPDATE (a system command that changes no version: the match after a receipt). */
export async function lockInvoiceRow(tx: CommandTx, invoiceId: string): Promise<void> {
  await tx.$executeRaw`SELECT 1 FROM "SupplierInvoice" WHERE id = ${invoiceId}::uuid FOR UPDATE`
}

/** The people named on the records, by id (their display name). */
export async function peopleNames(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null && isUuid(value)))]
  if (wanted.length === 0) return new Map()
  const rows = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(rows.map((row) => [row.id, row.displayName]))
}

export const dayOf = (value: Date | null): string | null => (value === null ? null : value.toISOString().slice(0, 10))
export const dayDate = (day: string): Date => new Date(`${day}T00:00:00.000Z`)
