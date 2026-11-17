import { ConflictError, ForbiddenError, NotFoundError, ValidationError, type Issue } from '@nexus/factory-domain/core/errors'
import { can, type Permission } from '@nexus/factory-domain/core/permissions'
import type { AllocationRefusal } from '@nexus/factory-domain/production/cutorders/allocation'
import type { PlyRefusal } from '@nexus/factory-domain/production/cutorders/plies'
import type { CutOrderRefusal } from '@nexus/factory-domain/production/cutorders/rules'
import type { TicketRefusal } from '@nexus/factory-domain/production/cutorders/tickets'
import type { CommandCaller } from '../../../core/command'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import type { Prisma } from '@nexus/factory-db'
import { allPartsWhere, reachesWorkOrder, viaCell, workOrderWhere } from '../work-orders/scope' // B-PR-04b
import type { Reader } from './store'

/**
 * Who may do what with cut orders and their tickets (B-W2b-112): each cut order is checked with can() against its company and
 * site; a floor device only at its own site (can() pins it, row-level security too). A rule's refusal is a 409 whose issue is
 * `refusal/<CODE>` with the words (the office's dialogs and the cutting tablet read them; `refusal.<CODE>` in the web's words).
 */

export function officeOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'office') throw new ForbiddenError()
  return context
}

export function workerOf(caller: Pick<CommandCaller, 'factoryContext'>): OfficeContext | FloorContext {
  const context = caller.factoryContext
  if (!context || (context.audience !== 'office' && context.audience !== 'floor')) throw new ForbiddenError()
  return context
}

export function floorOf(caller: Pick<CommandCaller, 'factoryContext'>): FloorContext {
  const context = caller.factoryContext
  if (!context || context.audience !== 'floor') throw new ForbiddenError()
  return context
}

/**
 * May the caller do this on a record of that company and site? A floor device: only at its own site. B-PR-04b (production plan
 * §2, the brand wall): `parties` = the customers of the work orders the record serves (a cut order's cells, a ticket's, a
 * trolley's bundles', a work order's one; `[]` for a record of the site alone, a hide or a site): EVERY one must be reached
 * (../work-orders/scope), so a cut order or trolley of two customers is not found for a person limited to one of them (plan pick
 * problem 2), and one of a work order of no customer only for a person of every customer.
 */
export function may(context: OfficeContext | FloorContext, permission: Permission, record: { readonly companyId: string; readonly siteId: string }, parties: readonly (string | null)[]): boolean {
  if (context.audience === 'floor' && context.siteId !== record.siteId) return false
  if (!can(actorOf(context), permission, { companyId: record.companyId, siteId: record.siteId })) return false
  return parties.every((partyId) => reachesWorkOrder(actorOf(context), permission, { companyId: record.companyId, siteId: record.siteId, partyId }))
}

// ── B-PR-04b (the brand wall) ──
/** How a cell's customer is read (select): its work order's one customer. */
export const CELL_PARTY = { workOrderSize: { select: { workOrder: { select: { partyId: true } } } } } as const

/** The customers of a cut order's cells (its lines, read with CELL_PARTY), each once. */
export const partiesOf = (order: { readonly lines: readonly { readonly workOrderSize: { readonly workOrder: { readonly partyId: string | null } } }[] }): (string | null)[] => [...new Set(order.lines.map((line) => line.workOrderSize.workOrder.partyId))]

/** The cut orders `permission` reaches by the wall: every cell's work order reached (none: no filter). */
export const cutOrderWall = (context: OfficeContext | FloorContext, permission: Permission): Prisma.CutOrderWhereInput => allPartsWhere(actorOf(context), permission, 'lines') as Prisma.CutOrderWhereInput

/** The customers of a cut ticket: its cell's (a recut), else its cut order's cells'. */
export async function ticketParties(db: Reader, ticketId: string): Promise<(string | null)[]> {
  const row = await db.cutTicket.findUnique({ where: { id: ticketId }, select: { ...CELL_PARTY, cutOrder: { select: { lines: { select: CELL_PARTY } } } } })
  if (!row) return []
  return row.workOrderSize ? [row.workOrderSize.workOrder.partyId] : row.cutOrder ? partiesOf(row.cutOrder) : []
}

/** The cut tickets `permission` reaches by the wall: a recut's cell reached, a cut order's every cell reached. */
export function ticketWall(context: OfficeContext | FloorContext, permission: Permission): Prisma.CutTicketWhereInput {
  const reach = workOrderWhere(actorOf(context), permission)
  if (Object.keys(reach).length === 0) return {}
  return { AND: [{ OR: [{ workOrderSizeId: null }, viaCell(actorOf(context), permission) as Prisma.CutTicketWhereInput] }, { OR: [{ cutOrderId: null }, { cutOrder: { is: cutOrderWall(context, permission) } }] }] }
}
// ── end B-PR-04b ──

/** A refusal of these rules, or one of another module's gates this one asks (the floor's readiness: FLOOR_NOT_READY). */
export type Refusal = CutOrderRefusal | AllocationRefusal | TicketRefusal | PlyRefusal | { readonly code: 'FLOOR_NOT_READY'; readonly message: string }

export class CutOrderRefusedError extends ConflictError {
  override name = 'CutOrderRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: Refusal): never => {
  throw new CutOrderRefusedError(refusal)
}

/** A 400 of the body's problems (paths relative to the body). */
export function invalid(problems: readonly Issue[], words: string): never {
  throw new ValidationError(problems.length === 1 ? problems[0]!.message : words, problems.map((problem) => ({ ...problem, path: `body/${problem.path}` })))
}

export const notFound = (what: string): never => {
  throw new NotFoundError(`${what} not found.`)
}
