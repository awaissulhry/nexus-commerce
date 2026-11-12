import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import { SALES_INQUIRIES_VIEW } from '@nexus/factory-domain/sales/inquiries/permissions'
import { mailTakenRefusal, quoteTakenRefusal, type InquiryFacts, type InquiryRefusal, type InquiryStatus } from '@nexus/factory-domain/sales/inquiries/rules'
import type { CommandCaller, CommandTx } from '../../../core/command'
import { actorOf, type OfficeContext } from '../../../core/context'

/**
 * Inquiries' rows (B-W2b-295; factory-db sales-intake.prisma, B-W2b-279): who may see which, the columns every read names, and
 * the refusal every command throws in words. An inquiry belongs to a company and, when it is from a customer, to that customer:
 * can() checks both (a role limited to some customers sees only their inquiries; a prospect's reaches every role of the company).
 */

export type Reader = FactoryClient | CommandTx

/** An inquiry change refused in words: 409 `conflict` with the issue `refusal/<CODE>`. */
export class InquiryRefusedError extends ConflictError {
  override name = 'InquiryRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: InquiryRefusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: InquiryRefusal | null): void => {
  if (refusal) throw new InquiryRefusedError(refusal)
}

export function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

export function assertNoProblems(problems: readonly Issue[], fallback = 'The inquiry cannot be saved.'): void {
  if (problems.length > 0) throw new ValidationError(problems.length === 1 ? problems[0]!.message : fallback, problems)
}

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause

/**
 * The last net (the lead: "a database refusal never reaches a person as a 500"): the sales intake guard's own refusal
 * (…_sales_intake_w2b_guards: check_violation 'customers: …') when a write reached it past this module's checks (a race), and
 * the one-inquiry-per-mail and one-inquiry-per-quote indexes: a 409 in words. Anything else is thrown as it is.
 */
export function databaseRefusal(error: unknown): never {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (cause?.originalCode === '23514' && message.startsWith('customers: ')) {
    const words = message.slice('customers: '.length)
    throw new ConflictError(`${words.charAt(0).toUpperCase()}${words.slice(1)}.`)
  }
  if ((error as { code?: unknown } | null)?.code === 'P2002' || cause?.originalCode === '23505') {
    const said = `${message} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? null)}`
    if (said.includes('Inquiry_one_per_mail')) throw new InquiryRefusedError(mailTakenRefusal(null))
    if (said.includes('Inquiry_one_per_quote')) throw new InquiryRefusedError(quoteTakenRefusal())
    throw new ConflictError('Someone changed this inquiry at the same moment: read it again.')
  }
  throw error
}

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

/** An inquiry's scope: its company, and its customer when it has one (a prospect's: the company only). */
export const scopeOf = (row: { readonly companyId: string; readonly partyId: string | null }) => ({ companyId: row.companyId, ...(row.partyId ? { partyId: row.partyId } : {}) })

export const may = (context: OfficeContext, permission: Permission, row: { readonly companyId: string; readonly partyId: string | null }): boolean => can(actorOf(context), permission, scopeOf(row))

export const INQUIRY_COLUMNS = {
  id: true,
  companyId: true,
  number: true,
  source: true,
  sourceEmailId: true,
  receivedAt: true,
  partyId: true,
  contactId: true,
  prospectName: true,
  prospectCompany: true,
  prospectEmail: true,
  prospectPhone: true,
  prospectLawfulBasis: true,
  prospectErasedAt: true,
  request: true,
  wantedDate: true,
  targetUnitPrice: true,
  currency: true,
  techPackFileIds: true,
  techPackVersion: true,
  status: true,
  assigneeId: true,
  assignedAt: true,
  quoteId: true,
  declineReason: true,
  closedAt: true,
  closedById: true,
  closeNote: true,
  note: true,
  version: true,
  createdAt: true,
  createdById: true,
} as const satisfies Prisma.InquirySelect
export type InquiryData = Prisma.InquiryGetPayload<{ select: typeof INQUIRY_COLUMNS }>

export const LINE_COLUMNS = { id: true, inquiryId: true, seq: true, styleId: true, colourwayId: true, colourText: true, description: true, sizes: true, quantity: true, note: true } as const satisfies Prisma.InquiryLineSelect
export type LineData = Prisma.InquiryLineGetPayload<{ select: typeof LINE_COLUMNS }>

export async function readInquiryRow(db: Reader, inquiryId: string): Promise<InquiryData | null> {
  return isUuid(inquiryId) ? db.inquiry.findUnique({ where: { id: inquiryId }, select: INQUIRY_COLUMNS }) : null
}

export const factsOf = (row: Pick<InquiryData, 'number' | 'status' | 'assigneeId' | 'partyId'>): InquiryFacts => ({ number: row.number, status: row.status as InquiryStatus, assigneeId: row.assigneeId, partyId: row.partyId })

/** The inquiry the office caller sees (sales.inquiries.view, else not found) and acts on with `permission` (else forbidden). */
export async function officeInquiry(caller: CommandCaller, inquiryId: string, permission: Permission = SALES_INQUIRIES_VIEW): Promise<{ context: OfficeContext; inquiry: InquiryData }> {
  const context = officeOf(caller)
  const inquiry = await caller.withClient((db) => readInquiryRow(db, inquiryId))
  if (!inquiry || !may(context, SALES_INQUIRIES_VIEW, inquiry)) throw new NotFoundError('Inquiry not found.')
  if (!may(context, permission, inquiry)) throw new ForbiddenError('Your role does not keep inquiries for this company or customer (sales.inquiries.manage).')
  return { context, inquiry }
}

/** A @db.Date as its day, and back. */
export const dayOrNull = (value: Date | null): string | null => (value ? value.toISOString().slice(0, 10) : null)
export const asDay = (value: string): Date => new Date(`${value}T00:00:00.000Z`)
/** A Decimal(18,6) as its decimal string (no trailing zeros beyond two places). */
export const priceOrNull = (value: Prisma.Decimal | null): string | null => (value === null ? null : value.toFixed(6))
