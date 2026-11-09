import { DomainError, NotFoundError } from '@nexus/factory-domain/core/errors'
import { isUuid } from '@nexus/factory-domain/core/ids'
import { databaseLockWords, LOCKED_ISSUE, lockedRefusal, type RevisionPart } from '@nexus/factory-domain/product/versions/lock'
import type { CommandTx } from '../../../core/command'

/**
 * Released data is locked (B-W2b-220; PRD-167), for the write paths of a revision's parts:
 *
 *   assertRevisionOpen(tx, styleId, revisionId, part)   inside a command, after the style row's lock (the lock order of
 *       every product write: modules/product/bom/store lockStyleRow): the revision of this style, locked FOR SHARE, and a
 *       409 in words (issue `refusal/REVISION_LOCKED`) when it is not a DRAFT — before the database's own refusal. The
 *       paths on main say the same in their own words already (bom/store, routing/store, pieces/store lockDraft;
 *       compliance/labels assign; planning/leather loss); a later step's write (B-W2b-224 measurement spec, B-W2b-228
 *       alternates, B-W2b-236 pictures and pattern files, B-W2b-210 protector placement) calls this one.
 *   revisionLockGuarded(work)                           the last net: should the database still refuse a write to a
 *       locked revision (W1's part guard or the revision guard), its refusal comes back as the same 409 in words, never a
 *       500 (lead 11-09).
 */

/** A 409 `conflict` in words, with the issue `refusal/REVISION_LOCKED` (a screen may say it in its own words). */
export class RevisionLockedError extends DomainError {
  override name = 'RevisionLockedError'
  constructor(message: string) {
    super('conflict', message, [{ path: LOCKED_ISSUE, message }])
  }
}

/** The revision of this style, FOR SHARE (a release waits for this write; this write sees a release made before it). */
export async function assertRevisionOpen(tx: CommandTx, styleId: string, revisionId: string, part: RevisionPart): Promise<{ readonly id: string; readonly revision: number }> {
  const rows = isUuid(revisionId)
    ? await tx.$queryRaw<{ id: string; styleId: string; revision: number; status: string }[]>`SELECT "id", "styleId", "revision", "status"::text AS "status" FROM "StyleRevision" WHERE "id" = ${revisionId}::uuid FOR SHARE`
    : []
  const row = rows[0]
  if (!row || row.styleId !== styleId) throw new NotFoundError('Revision not found.')
  const refusal = lockedRefusal(row, part)
  if (refusal) throw new RevisionLockedError(refusal)
  return { id: row.id, revision: row.revision }
}

/** The database's refusal of a write to a locked revision, as the 409 above; any other error as it is. */
export function revisionLockRefusal(error: unknown, revisionNumber?: number): unknown {
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } } } | null)?.meta?.driverAdapterError?.cause
  if ((cause?.originalCode !== '23001' && cause?.originalCode !== '23514') || typeof cause.originalMessage !== 'string') return error
  const words = databaseLockWords(cause.originalMessage, revisionNumber)
  return words ? new RevisionLockedError(words.message) : error
}

/** Runs `work`; a database refusal of a locked revision comes back in words (409). */
export async function revisionLockGuarded<T>(work: () => Promise<T>, revisionNumber?: number): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw revisionLockRefusal(error, revisionNumber)
  }
}
