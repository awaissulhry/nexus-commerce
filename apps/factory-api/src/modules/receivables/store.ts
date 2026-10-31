import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { heldGrains } from '@nexus/factory-domain/auth/grains/grains'
import { DomainError, ForbiddenError, NotFoundError, UnauthenticatedError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, grantsFor, type Permission } from '@nexus/factory-domain/core/permissions'
import { businessDate, businessDayRange, type BusinessDate, type Clock } from '@nexus/factory-domain/core/time'
import type { ReferenceRate } from '@nexus/factory-domain/receivables/interest'
import { effectiveSettings, type EffectiveSettings, type LateInterestMode, type SettingsRow } from '@nexus/factory-domain/receivables/ladder'
import { instalmentsOf, openInstalments } from '@nexus/factory-domain/receivables/ledger'
import { REMINDER_REFUSALS, type InterestRule, type KnownReminder, type OpenInvoice, type ReminderRefusal, type ReminderStatus } from '@nexus/factory-domain/receivables/reminders'
import { COMMAND_SETTINGS, runCommand, type CommandCaller, type CommandSpec, type CommandTools, type CommandTx } from '../../core/command'
import { actorOf, type OfficeContext, type RequestContext } from '../../core/context'
import { serverClock } from '../../core/time'

/**
 * The receivables module's reads and seams (B-W2a-55; factory-db money.prisma Invoice, Payment, PaymentAllocation;
 * receivables.prisma PaymentReminder, ReceivablesSettings, Refund): who may see and act (office only, can() on the
 * company owed AND the customer), the open invoices with what is open on each instalment, the settings in force, the
 * customer's advisory lock, the clock (tests fix it) and the refusals in words.
 */

export type Reader = FactoryClient | CommandTx

let clock: Clock = serverClock
/** Tests fix the day the ladder and the ageing count on. */
export function useReceivablesClock(next: Clock | undefined): void {
  clock = next ?? serverClock
}
export const receivablesClock = (): Clock => clock
export const today = (): BusinessDate => businessDate(clock.now())

export function receivablesCommand<Result>(caller: CommandCaller, spec: CommandSpec, work: (tools: CommandTools) => Promise<Result>) {
  return runCommand(caller, spec, work, { ...COMMAND_SETTINGS, clock })
}

export function officeContextOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context) throw new UnauthenticatedError()
  if (context.audience !== 'office') throw new ForbiddenError()
  return context
}

export interface CustomerScope {
  readonly companyId: string
  readonly partyId: string
}

export const mayOn = (context: OfficeContext, permission: Permission, scope: CustomerScope): boolean => can(actorOf(context), permission, { companyId: scope.companyId, partyId: scope.partyId })

/** 404 when the reader may not see the customer's receivables at all, 403 when they may see but not do this. */
export function assertMay(context: OfficeContext, see: Permission, permission: Permission, scope: CustomerScope | null, what = 'Customer'): asserts scope is CustomerScope {
  if (!scope || !mayOn(context, see, scope)) throw new NotFoundError(`${what} not found.`)
  if (!mayOn(context, permission, scope)) throw new ForbiddenError()
}

/** May act on the tenant-wide settings: only a grant over every company. */
export function mayEveryCompany(context: OfficeContext, permission: Permission): boolean {
  return grantsFor(actorOf(context), permission).some((grant) => grant.companies === 'all')
}

export const holdsPrice = (context: RequestContext): boolean => context.audience === 'system' || (context.audience === 'office' && heldGrains(actorOf(context)).has('price'))

export const refused = (code: ReminderRefusal, path = `reminder/${code}`, words: string = REMINDER_REFUSALS[code]): DomainError => new DomainError('conflict', words, [{ path, message: words }])

/** The customer's advisory lock (the ladder, a reminder by hand, every reminder move): one writer per company and customer. */
export async function lockCustomer(tx: CommandTx, tenantId: string, scope: CustomerScope): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(concat_ws('|', 'factory.receivables.customer', ${tenantId}::uuid::text, ${scope.companyId}::uuid::text, ${scope.partyId}::uuid::text), 0))`
}

export function tenantIdOf(context: RequestContext): string {
  const tenantId = 'tenantId' in context ? context.tenantId : undefined
  if (!tenantId) throw new Error('receivables: a command outside a tenant')
  return tenantId
}

// ---- the settings in force ---------------------------------------------------------------------------------------------------

export const SETTINGS_COLUMNS = {
  id: true,
  companyId: true,
  version: true,
  remindersEnabled: true,
  ladder: true,
  lateInterestMode: true,
  lateInterestAgreedPct: true,
  recoveryChargeAmount: true,
  minimumAmount: true,
  updatedAt: true,
} as const satisfies Prisma.ReceivablesSettingsSelect
export type SettingsRecord = Prisma.ReceivablesSettingsGetPayload<{ select: typeof SETTINGS_COLUMNS }>

export const settingsRowOf = (row: SettingsRecord): SettingsRow => ({
  id: row.id,
  companyId: row.companyId,
  version: row.version,
  remindersEnabled: row.remindersEnabled,
  ladder: row.ladder,
  lateInterestMode: row.lateInterestMode as LateInterestMode,
  lateInterestAgreedPct: row.lateInterestAgreedPct === null ? null : row.lateInterestAgreedPct.toFixed(4).replace(/\.?0+$/, ''),
  recoveryChargeAmount: row.recoveryChargeAmount,
  minimumAmount: row.minimumAmount,
})

/** The company's row and the tenant-wide one (row-level security keeps them the tenant's). */
export async function settingsRows(db: Reader, companyId: string | null): Promise<{ company: SettingsRecord | null; tenant: SettingsRecord | null }> {
  const rows = await db.receivablesSettings.findMany({ where: { OR: [{ companyId: null }, ...(companyId ? [{ companyId }] : [])] }, select: SETTINGS_COLUMNS })
  return { company: companyId ? (rows.find((row) => row.companyId === companyId) ?? null) : null, tenant: rows.find((row) => row.companyId === null) ?? null }
}

export async function settingsFor(db: Reader, companyId: string): Promise<EffectiveSettings> {
  const rows = await settingsRows(db, companyId)
  return effectiveSettings(rows.company ? settingsRowOf(rows.company) : null, rows.tenant ? settingsRowOf(rows.tenant) : null)
}

/** A Decimal(7,4) percentage as the domain reads it: a plain decimal string, trailing zeros dropped. */
export const pctText = (value: { toFixed(places: number): string }): string => value.toFixed(4).replace(/\.?0+$/, '')

/** The half-year reference rates of statutory interest (B-W2b-21; tenant-wide, row-level security keeps them the tenant's). */
export async function interestRatesOf(db: Reader): Promise<ReferenceRate[]> {
  const rows = await db.interestReferenceRate.findMany({ select: { halfYearStart: true, referenceRatePct: true, addedPointsPct: true }, orderBy: { halfYearStart: 'asc' } })
  return rows.map((row) => ({ halfYearStart: businessDate(row.halfYearStart, 'UTC'), referenceRatePct: pctText(row.referenceRatePct), addedPointsPct: pctText(row.addedPointsPct) }))
}

/** The company's interest rule as the ladder applies it: STATUTORY reads the half-year rates (one query only then). */
export async function interestRuleFor(db: Reader, settings: Pick<EffectiveSettings, 'lateInterestMode' | 'lateInterestAgreedPct'>): Promise<InterestRule> {
  return { mode: settings.lateInterestMode, agreedPct: settings.lateInterestAgreedPct, ...(settings.lateInterestMode === 'STATUTORY' ? { rates: await interestRatesOf(db) } : {}) }
}

// ---- open invoices ---------------------------------------------------------------------------------------------------------

export interface OpenInvoiceRow extends OpenInvoice {
  readonly companyId: string
  readonly partyId: string
  readonly docType: string
  readonly gross: number
  readonly settled: number
  readonly salesOrderId: string | null
  /** The first bank account its payment terms name (for the reminder's text). */
  readonly iban: string | null
}

export interface OpenFilter {
  readonly companyId?: string | null
  readonly partyId?: string | null
  readonly invoiceIds?: readonly string[] | null
  readonly salesOrderId?: string | null
  /** Counted as of the end of this day: credit notes issued and allocations made by then (default today). */
  readonly asOf?: BusinessDate
}

const ibanOf = (terms: unknown): string | null => {
  const installments = terms && typeof terms === 'object' ? (terms as { installments?: unknown }).installments : null
  if (!Array.isArray(installments)) return null
  for (const entry of installments) {
    const iban = entry && typeof entry === 'object' ? (entry as { iban?: unknown }).iban : null
    if (typeof iban === 'string' && iban.trim() !== '') return iban.trim()
  }
  return null
}

/**
 * The issued TD01/TD24 invoices that still ask money as of a day (gross − issued credit notes − allocations, the same
 * sums as payments' open items), oldest first, each with its instalments and what is open on them. Row-level security
 * keeps them the tenant's; the caller filters by its grants (can()).
 *
 * B-W2b-21 (B-W2a-61's note): `depositToCarry` marks an invoice of an order (its own salesOrderId, or the order of one of
 * its lines) that has a PAID deposit request issuing no deposit invoice (NONE: an EU business with a VIES proof) whose
 * allocations still hold money — the deposit is not carried onto an invoice yet (payments' carry reverses the request's
 * allocation and places the same money on the invoice, netting the request to 0). The ladder holds such an invoice.
 */
export async function openInvoices(db: Reader, filter: OpenFilter): Promise<OpenInvoiceRow[]> {
  const asOf = filter.asOf ?? today()
  const end = businessDayRange(asOf).end
  const ids = filter.invoiceIds && filter.invoiceIds.length > 0 ? [...filter.invoiceIds] : null
  const rows = await db.$queryRaw<
    { id: string; companyId: string; partyId: string; number: string | null; docType: string; issueDate: Date; currency: string; grossTotal: number; paymentTerms: unknown; salesOrderId: string | null; lineOrderIds: string[] | null; credited: bigint | null; allocated: bigint | null }[]
  >`
    SELECT i.id, i."companyId", i."buyerPartyId" AS "partyId", i.number, i."docType"::text AS "docType", i."issueDate", i.currency, i."grossTotal", i."paymentTerms", i."salesOrderId",
           ARRAY(SELECT DISTINCT o."orderId" FROM "InvoiceLine" l JOIN "SalesOrderLine" o ON o."tenantId" = l."tenantId" AND o.id = l."salesOrderLineId" WHERE l."invoiceId" = i.id) AS "lineOrderIds",
           c.credited, a.allocated
      FROM "Invoice" i
      LEFT JOIN LATERAL (SELECT sum(cn."grossTotal") AS credited FROM "Invoice" cn
                          WHERE cn."creditOfId" = i.id AND cn."docType" = 'TD04' AND cn.status <> 'DRAFT' AND cn."issueDate" <= ${asOf}::date) c ON true
      LEFT JOIN LATERAL (SELECT sum(pa.amount) AS allocated FROM "PaymentAllocation" pa
                          WHERE pa."invoiceId" = i.id AND pa."createdAt" < ${end}) a ON true
     WHERE i."docType" IN ('TD01', 'TD24') AND i.status <> 'DRAFT' AND i."issueDate" <= ${asOf}::date
       AND (${filter.companyId ?? null}::uuid IS NULL OR i."companyId" = ${filter.companyId ?? null}::uuid)
       AND (${filter.partyId ?? null}::uuid IS NULL OR i."buyerPartyId" = ${filter.partyId ?? null}::uuid)
       AND (${filter.salesOrderId ?? null}::uuid IS NULL OR i."salesOrderId" = ${filter.salesOrderId ?? null}::uuid)
       AND (${ids}::uuid[] IS NULL OR i.id = ANY(${ids}::uuid[]))
       AND i."grossTotal" - coalesce(c.credited, 0) - coalesce(a.allocated, 0) > 0
     ORDER BY i."issueDate", i.number, i.id`
  const carrying = await ordersWithDepositToCarry(db, rows.flatMap((row) => [...(row.salesOrderId ? [row.salesOrderId] : []), ...(row.lineOrderIds ?? [])]))
  return rows.map((row) => {
    const issueDate = businessDate(row.issueDate, 'UTC')
    const settled = Number(row.credited ?? 0n) + Number(row.allocated ?? 0n)
    const { instalments, dueDateKnown } = instalmentsOf(row.paymentTerms, row.grossTotal, issueDate)
    return {
      id: row.id,
      companyId: row.companyId,
      partyId: row.partyId,
      number: row.number ?? '',
      docType: row.docType,
      issueDate,
      currency: row.currency,
      gross: row.grossTotal,
      settled,
      dueDateKnown,
      instalments: openInstalments(instalments, settled),
      salesOrderId: row.salesOrderId,
      iban: ibanOf(row.paymentTerms),
      depositToCarry: [row.salesOrderId, ...(row.lineOrderIds ?? [])].some((orderId) => orderId !== null && carrying.has(orderId)),
    }
  })
}

/** The orders with a PAID NONE deposit request whose allocations still hold money (not carried onto an invoice yet). */
async function ordersWithDepositToCarry(db: Reader, orderIds: readonly string[]): Promise<Set<string>> {
  const wanted = [...new Set(orderIds)]
  if (wanted.length === 0) return new Set()
  // One query at a time: a transaction client runs one statement at a time.
  const requests = await db.depositRequest.findMany({ where: { orderId: { in: wanted }, fiscalDocument: 'NONE', status: 'PAID' }, select: { id: true, orderId: true } })
  if (requests.length === 0) return new Set()
  const held = await db.paymentAllocation.groupBy({ by: ['depositRequestId'], where: { depositRequestId: { in: requests.map((request) => request.id) } }, _sum: { amount: true } })
  const holding = new Set(held.filter((entry) => (entry._sum.amount ?? 0) > 0).map((entry) => entry.depositRequestId!))
  return new Set(requests.filter((request) => holding.has(request.id)).map((request) => request.orderId!))
}

// ---- reminders -------------------------------------------------------------------------------------------------------------

export const REMINDER_COLUMNS = {
  id: true,
  companyId: true,
  partyId: true,
  level: true,
  action: true,
  invoiceIds: true,
  amountDue: true,
  interestAmount: true,
  currency: true,
  oldestDueDate: true,
  language: true,
  subject: true,
  body: true,
  status: true,
  approvedAt: true,
  approvedById: true,
  sentAt: true,
  callNote: true,
  skippedAt: true,
  skippedById: true,
  skipReason: true,
  cancelledAt: true,
  cancelReason: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.PaymentReminderSelect
export type ReminderRow = Prisma.PaymentReminderGetPayload<{ select: typeof REMINDER_COLUMNS }>

export const knownReminderOf = (row: Pick<ReminderRow, 'id' | 'level' | 'status' | 'invoiceIds' | 'amountDue' | 'currency' | 'createdAt' | 'createdById'>): KnownReminder => ({
  id: row.id,
  level: row.level,
  status: row.status as ReminderStatus,
  invoiceIds: row.invoiceIds,
  amountDue: row.amountDue,
  currency: row.currency,
  preparedOn: businessDate(row.createdAt),
  byHand: row.createdById !== null,
})

export async function readReminder(db: Reader, reminderId: string): Promise<ReminderRow | null> {
  if (!isUuid(reminderId)) return null
  return db.paymentReminder.findUnique({ where: { id: reminderId }, select: REMINDER_COLUMNS })
}

/** The reminder the office may see (else 404) and act on with `permission` (else 403). */
export async function officeReminder(caller: CommandCaller, reminderId: string, see: Permission, permission: Permission): Promise<ReminderRow> {
  const context = officeContextOf(caller)
  const row = await caller.withClient((client) => readReminder(client, reminderId))
  assertMay(context, see, permission, row, 'Reminder')
  return row!
}

/** The reminder locked for the command, at the version the caller read (409 when it moved on). */
export async function lockReminder(tx: CommandTx, reminderId: string, expectedVersion: number, path = 'version'): Promise<ReminderRow> {
  await tx.$queryRaw`SELECT id FROM "PaymentReminder" WHERE id = ${reminderId}::uuid FOR UPDATE`
  const row = await tx.paymentReminder.findUnique({ where: { id: reminderId }, select: REMINDER_COLUMNS })
  if (!row) throw new NotFoundError('Reminder not found.')
  if (row.version !== expectedVersion) {
    throw new DomainError('conflict', `This reminder changed since it was read (version ${expectedVersion}); it is now at version ${row.version}. Reload it and try again.`, [{ path, message: `The current version is ${row.version}.` }])
  }
  return row
}

/** The customer's reminders the ladder reads: every open one, and those that name one of its open invoices. */
export async function remindersOf(db: Reader, scope: CustomerScope, invoiceIds: readonly string[]): Promise<ReminderRow[]> {
  return db.paymentReminder.findMany({
    where: { companyId: scope.companyId, partyId: scope.partyId, OR: [{ status: { in: ['PREPARED', 'APPROVED'] } }, ...(invoiceIds.length > 0 ? [{ invoiceIds: { hasSome: [...invoiceIds] } }] : [])] },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: REMINDER_COLUMNS,
  })
}

/** The people named on rows, by id (office users). */
export async function peopleOf(db: Reader, ids: readonly (string | null)[]): Promise<Map<string, string | null>> {
  const wanted = [...new Set(ids.filter((value): value is string => value !== null))]
  if (wanted.length === 0) return new Map()
  const users = await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, displayName: true } })
  return new Map(users.map((user) => [user.id, user.displayName]))
}

/** The customer's contacts that receive invoices, with an address (a statement or reminder e-mail goes to them). */
export async function invoiceContactsOf(db: Reader, partyId: string): Promise<{ name: string; email: string }[]> {
  const contacts = await db.partyContact.findMany({ where: { partyId, status: 'ACTIVE', roles: { has: 'INVOICES' }, email: { not: null } }, orderBy: [{ name: 'asc' }, { id: 'asc' }], select: { name: true, email: true } })
  return contacts.filter((contact) => contact.email && contact.email.trim() !== '').map((contact) => ({ name: contact.name, email: contact.email!.trim() }))
}

export async function senderOf(db: Reader, context: OfficeContext) {
  const user = await db.user.findUnique({ where: { id: context.actorId }, select: { displayName: true, email: true } })
  return { userId: context.actorId, name: user?.displayName ?? 'Amministrazione', email: user?.email ?? null }
}

export const COMPANY_REF = { id: true, code: true, legalName: true, currency: true } as const
export const PARTY_REF = { id: true, code: true, legalName: true, language: true, companyId: true } as const
