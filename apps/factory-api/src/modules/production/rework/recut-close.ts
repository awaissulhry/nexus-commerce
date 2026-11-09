import type { Prisma } from '@nexus/factory-db'
import type { FloorContext } from '../../../core/context'
import { command, type CommandCaller, type CommandTools, type CommandTx } from '../../../core/command'
import { asTenantSystem } from '../bundles/codes'
import { inWords } from '../settings/cutting-rules'

/**
 * A fabric recut closes its request (B-W2b-219; MES-044; the follow-up of B-W2b-117 on B-W2b-204's guard): a RECUT
 * ReplacementRequest is DONE once its recut ticket is DONE (cut on the ticket, with no cut log entry), and a request whose
 * named ticket was VOIDED takes a new one while it is OPEN (the database: factory_replacement_request_guard).
 *
 *   closeRecutRequest       after the table's finish scan (POST /production/recut-tickets/finish): the OPEN RECUT request
 *                           naming the DONE ticket → DONE (doneAt, no cutLogId), audited `production.doneReplacement`
 *                           (after.recutTicketId), production.replacement_changed. The floor has no grant on
 *                           ReplacementRequest (the tablet never reads an office request): it runs as the tenant's system
 *                           caller, after the finish, keyed by the device's key (a resent finish closes it once).
 *   doneByTicket            the office's "done" of a RECUT without a cut log entry (POST /production/replacements/:id/done
 *                           with no cutLogId): its ticket must be DONE (requests whose ticket finished before this step).
 *   liveRecutTicketId       the ticket a request still has: a VOID one counts as none, so a new ticket may be made for it.
 */

/** The OPEN RECUT request a recut ticket answers, locked (null: none, or it is closed already). */
async function openRequestOf(tx: CommandTx, ticketId: string): Promise<{ id: string; workOrderId: string; companyId: string; siteId: string; version: number } | null> {
  const found = await tx.replacementRequest.findFirst({ where: { recutTicketId: ticketId, kind: 'RECUT', status: 'OPEN' }, select: { id: true } })
  if (!found) return null
  await tx.$queryRaw`SELECT "id" FROM "ReplacementRequest" WHERE "id" = ${found.id}::uuid FOR UPDATE`
  return tx.replacementRequest.findFirst({ where: { id: found.id, status: 'OPEN' }, select: { id: true, workOrderId: true, companyId: true, siteId: true, version: true } })
}

/** Inside a command: the request answered by this DONE ticket → DONE, audited and told. The request's id, or null (none open). */
export async function closeByTicketInCommand(tools: CommandTools, ticket: { readonly id: string; readonly number: string }): Promise<string | null> {
  const { tx, now } = tools
  const state = await tx.cutTicket.findUnique({ where: { id: ticket.id }, select: { status: true } })
  if (state?.status !== 'DONE') return null
  const request = await openRequestOf(tx, ticket.id)
  if (!request) return null
  await tx.replacementRequest.update({ where: { id: request.id }, data: { status: 'DONE', doneAt: now, version: { increment: 1 }, updatedAt: now }, select: { id: true } })
  const order = await tx.workOrder.findUnique({ where: { id: request.workOrderId }, select: { number: true } })
  const scope = { companyId: request.companyId, siteId: request.siteId }
  tools.audit({ action: 'production.doneReplacement', recordType: 'ReplacementRequest', recordId: request.id, ...scope, before: { status: 'OPEN' }, after: { status: 'DONE', recutTicketId: ticket.id, recutTicket: ticket.number } })
  tools.emit({
    type: 'production.replacement_changed',
    subject: request.workOrderId,
    ...scope,
    payload: { workOrderId: request.workOrderId, number: order?.number ?? '', replacementId: request.id, kind: 'RECUT', status: 'DONE', cutLogId: null },
  })
  return request.id
}

/**
 * After a tablet's finish scan: the request the ticket answers is closed as the tenant's system caller (the floor has no
 * grant on ReplacementRequest). Nothing open: no command, no audit. Never throws: the finish is done whatever happens here;
 * a request left OPEN beside its DONE ticket is closed by the office ("done" with no cut log entry, doneByTicketRefusal).
 */
export async function closeRecutRequest(caller: CommandCaller, context: FloorContext, ticket: { readonly id: string; readonly number: string }, idempotencyKey: string | undefined): Promise<string | null> {
  try {
    const system = asTenantSystem(caller, context)
    const open = await system.withClient((client) => client.replacementRequest.findFirst({ where: { recutTicketId: ticket.id, kind: 'RECUT', status: 'OPEN' }, select: { id: true } }))
    if (!open) return null
    const key = idempotencyKey ? `${context.deviceId}.${idempotencyKey}.close`.slice(0, 128) : undefined
    const { result } = await inWords(() => command(system, { name: 'production.closeRecutRequest', idempotencyKey: key, input: { ticketId: ticket.id } }, async (tools) => ({ replacementId: await closeByTicketInCommand(tools, ticket) })))
    return result.replacementId
  } catch {
    return null
  }
}

/** The office's done of a RECUT by its ticket (no cut log entry): refused in words unless the ticket is DONE. */
export async function doneByTicketRefusal(tx: CommandTx, row: { readonly id: string; readonly kind: string; readonly status: string }): Promise<string | null> {
  if (row.kind !== 'RECUT') return 'Only a recut is done; a reduction is approved or refused.'
  if (row.status !== 'OPEN') return `This request is ${row.status.toLowerCase()}: it is not done again.`
  const named = await tx.replacementRequest.findUnique({ where: { id: row.id }, select: { recutTicket: { select: { number: true, status: true } } } })
  const ticket = named?.recutTicket
  if (!ticket) return 'Name the cut log entry that cut the recut: this request has no recut ticket.'
  if (ticket.status !== 'DONE') return `Recut ticket ${ticket.number} is ${ticket.status.toLowerCase()}: the request is done once its ticket is done, or name the cut log entry that cut it.`
  return null
}

/** The ticket a request still has for the make rule: its named ticket, or null when there is none or it is VOID (replaced). */
export async function liveRecutTicketId(db: Pick<CommandTx, 'replacementRequest'>, replacementId: string): Promise<string | null> {
  const row = await db.replacementRequest.findUnique({ where: { id: replacementId }, select: { recutTicketId: true, recutTicket: { select: { status: true } } } })
  if (!row?.recutTicketId) return null
  return row.recutTicket?.status === 'VOID' ? null : row.recutTicketId
}

/** The open RECUT requests that may take a ticket: none named, or the named one VOID. */
export const takesTicket: Prisma.ReplacementRequestWhereInput = { OR: [{ recutTicketId: null }, { recutTicket: { status: 'VOID' } }] }
