import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { SecondaryRefusal } from '@nexus/factory-domain/production/cutissue/secondary'
import type { TrolleyRefusal } from '@nexus/factory-domain/production/cutissue/trolley'
import type { RecutRefusal } from '@nexus/factory-domain/production/rework/recut'
import { actorOf, type FloorContext, type OfficeContext } from '../../../core/context'
import type { Prisma } from '@nexus/factory-db'
import { may } from '../cutorders/access'
import { allPartsWhere, viaWorkOrder } from '../work-orders/scope' // B-PR-04b
import type { Reader } from './store'

/**
 * Who may do what after the cut (B-W2b-117): each work order (or trolley) is checked with can() against its company and site; a
 * floor device only at its own site (can() pins it, row-level security too). A rule's refusal is a 409 whose issue is
 * `refusal/<CODE>` with the words (the tablets and the office's dialogs read them; the floor queue keeps them as the module's
 * refusal). The office/floor callers and may() are the cut orders' (../cutorders/access).
 */

export { floorOf, invalid, may, officeOf, workerOf } from '../cutorders/access'

/** A refusal of these rules, or the floor's readiness (FLOOR_NOT_READY). */
export type Refusal = RecutRefusal | SecondaryRefusal | TrolleyRefusal | { readonly code: 'FLOOR_NOT_READY'; readonly message: string }

export class CutIssueRefusedError extends ConflictError {
  override name = 'CutIssueRefusedError'
  override readonly issues: readonly Issue[]
  constructor(readonly refusal: Refusal) {
    super(refusal.message)
    this.issues = [{ path: `refusal/${refusal.code}`, message: refusal.message }]
  }
}

export const refuse = (refusal: Refusal): never => {
  throw new CutIssueRefusedError(refusal)
}

/**
 * The record when the caller may act on it with this permission, else a 404 in words (never "it exists elsewhere"). B-PR-04b
 * (the brand wall): `parties` = the customers of the work orders it serves (see ../cutorders/access may): a work order's one
 * (`ofWorkOrder`), a trolley's bundles' (`issueParties`).
 */
export function seen<T extends { readonly companyId: string; readonly siteId: string }>(context: OfficeContext | FloorContext, permission: Permission, record: T | null | undefined, what: string, parties: (record: T) => readonly (string | null)[]): T {
  if (!record || !may(context, permission, record, parties(record))) throw new NotFoundError(`${what} not found.`)
  return record
}

// ── B-PR-04b (the brand wall) ──
/** A work order's (or a row of one work order's) one customer. */
export const ofWorkOrder = (row: { readonly partyId: string | null }): readonly (string | null)[] => [row.partyId]

/** A work order's one customer, read by its id (a row that names only the work order: a replacement). */
export async function workOrderParties(db: Reader, workOrderId: string): Promise<(string | null)[]> {
  const row = await db.workOrder.findUnique({ where: { id: workOrderId }, select: { partyId: true } })
  return row ? [row.partyId] : []
}

/** The customers of a trolley's bundles (their work orders'), each once. */
export async function issueParties(db: Reader, issueId: string): Promise<(string | null)[]> {
  const lines = await db.cutIssueLine.findMany({ where: { cutIssueId: issueId }, select: { bundle: { select: { workOrder: { select: { partyId: true } } } } } })
  return [...new Set(lines.map((line) => line.bundle.workOrder.partyId))]
}

/** The trolleys `permission` reaches by the wall: every bundle's work order reached (none: no filter). */
export const issueWall = (context: OfficeContext | FloorContext, permission: Permission): Prisma.CutIssueWhereInput =>
  allPartsWhere(actorOf(context), permission, 'lines', (actor, held) => ({ bundle: { is: viaWorkOrder(actor, held) } })) as Prisma.CutIssueWhereInput
// ── end B-PR-04b ──
