import { ConflictError, NotFoundError, type Issue } from '@nexus/factory-domain/core/errors'
import type { Permission } from '@nexus/factory-domain/core/permissions'
import type { SecondaryRefusal } from '@nexus/factory-domain/production/cutissue/secondary'
import type { TrolleyRefusal } from '@nexus/factory-domain/production/cutissue/trolley'
import type { RecutRefusal } from '@nexus/factory-domain/production/rework/recut'
import type { FloorContext, OfficeContext } from '../../../core/context'
import { may } from '../cutorders/access'

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

/** The record when the caller may act on it with this permission, else a 404 in words (never "it exists elsewhere"). */
export function seen<T extends { readonly companyId: string; readonly siteId: string }>(context: OfficeContext | FloorContext, permission: Permission, record: T | null | undefined, what: string): T {
  if (!record || !may(context, permission, record)) throw new NotFoundError(`${what} not found.`)
  return record
}
