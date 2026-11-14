import type { FactoryClient, Prisma } from '@nexus/factory-db'
import { ConflictError, ForbiddenError, ValidationError } from '@nexus/factory-domain/core/errors'
import { events as mailDepthEvents } from '@nexus/factory-domain/mail-depth/events'
import { guardRefusalWords, type WorkChange } from '@nexus/factory-domain/mail-depth/rules'
import { eventFor } from '@nexus/factory-domain/events/define'
import type { CommandCaller, CommandTools, CommandTx } from '../../../core/command'
import type { OfficeContext } from '../../../core/context'

/**
 * What mail in depth's parts share (B-W2b-394; platform/email-in/{capture,team-inbox}, platform/email-out/delivery-status,
 * modules/sales/{inquiries,service}/from-mail.ts): the office caller, the receiving domains of a company, the work event, and
 * the last net for B-W2b-366's guards — a refusal a route reaches in a race is a 409 in words, never a 500.
 */

export type Reader = FactoryClient | CommandTx

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function badBody(path: string, message: string): never {
  throw new ValidationError(message, [{ path: `body/${path}`, message }])
}

type DriverCause = { originalCode?: unknown; originalMessage?: unknown }
const causeOf = (error: unknown): DriverCause | undefined => (error as { meta?: { driverAdapterError?: { cause?: DriverCause } } } | null)?.meta?.driverAdapterError?.cause

/**
 * The last net: B-W2b-366's guards (check_violation `email-in: …`, `email: …`, `sales: …`) and the unique indexes a race may
 * hit (one live capture address per company, a team inbox's name or address twice in a company): a 409 in words. Anything
 * else is thrown as it is.
 */
export function mailRefusal(error: unknown): never {
  const cause = causeOf(error)
  const message = typeof cause?.originalMessage === 'string' ? cause.originalMessage : ''
  if (cause?.originalCode === '23514') {
    const words = guardRefusalWords(message)
    if (words) throw new ConflictError(words)
  }
  if ((error as { code?: unknown } | null)?.code === 'P2002' || cause?.originalCode === '23505') {
    const said = `${message} ${JSON.stringify((error as { meta?: unknown } | null)?.meta ?? null)}`
    if (said.includes('CaptureAddress_one_live')) throw new ConflictError('This company got a new capture address at the same moment: read it again.')
    if (said.includes('localPart')) throw new ConflictError('Another team inbox of this company has this address.')
    if (said.includes('name')) throw new ConflictError('Another team inbox of this company has this name.')
    throw new ConflictError('Someone changed this at the same moment: read it again.')
  }
  throw error
}

/**
 * The domains a company receives mail at: the reply domains of its sending identities (the MX for replies points there). A
 * mail of a tenant-wide account (no company): every identity's of the tenant.
 */
export async function replyDomainsOf(db: Reader, companyId: string | null): Promise<string[]> {
  const rows = await db.emailIdentity.findMany({ where: companyId === null ? {} : { companyId }, select: { replyDomain: true }, distinct: ['replyDomain'] })
  return rows.map((row) => row.replyDomain.trim().toLowerCase())
}

/**
 * The domain a company's addresses are made at (capture address, team inboxes): the reply domain of its default ACTIVE
 * CONVERSATION identity, else of its first ACTIVE one; null: the company sends no mail yet.
 */
export async function receivingDomainOf(db: Reader, companyId: string): Promise<string | null> {
  const identity =
    (await db.emailIdentity.findFirst({ where: { companyId, kind: 'CONVERSATION', isDefault: true, status: 'ACTIVE' }, select: { replyDomain: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] })) ??
    (await db.emailIdentity.findFirst({ where: { companyId, status: 'ACTIVE' }, select: { replyDomain: true }, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }))
  return identity ? identity.replyDomain.trim().toLowerCase() : null
}

/** The company of a reply domain (the identity whose reply domain it is), or null when none or several companies share it. */
export async function companyOfDomain(db: Reader, domain: string): Promise<string | null> {
  const rows = await db.emailIdentity.findMany({ where: { replyDomain: domain }, select: { companyId: true }, distinct: ['companyId'], take: 2 })
  return rows.length === 1 ? rows[0]!.companyId : null
}

const [, , worked] = mailDepthEvents

/** The work event of a mail (email.inbound_worked). */
export function emitWorked(tools: Pick<CommandTools, 'emit'>, mail: { readonly id: string; readonly companyId: string | null }, teamInboxId: string | null, change: WorkChange, assigneeId: string | null, byId: string | null): void {
  tools.emit(eventFor(worked, { subject: mail.id, companyId: mail.companyId, payload: { inboundEmailId: mail.id, teamInboxId, change, assigneeId, byId } }))
}

/** The team-inbox columns of a mail every read of this step names. */
export const WORK_COLUMNS = {
  id: true,
  companyId: true,
  status: true,
  threadId: true,
  teamInboxId: true,
  assigneeId: true,
  assignedAt: true,
  closedAt: true,
  closedById: true,
  snoozedUntil: true,
  followUpUntil: true,
  version: true,
} as const satisfies Prisma.InboundEmailSelect
export type WorkRow = Prisma.InboundEmailGetPayload<{ select: typeof WORK_COLUMNS }>
