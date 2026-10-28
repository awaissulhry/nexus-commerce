import { defineMachine } from '../../state/machine'
import type { StyleStatus } from './rules'

/**
 * A style's revisions (plan A1 §2.5), pure: its BOM, routing and garment label belong to a StyleRevision, numbered 1,
 * 2, 3 … per style. DRAFT while edited; RELEASED is frozen for every login (the …_product_guards triggers), so a work
 * order made from it always reads the same specification; OBSOLETE when a newer one is released or a draft is
 * abandoned. A style has at most one RELEASED revision (its current one; a partial unique index): a release obsoletes
 * the previous revision FIRST, then releases the new one, in one command (the BOM and routing steps, B-W1-13/14).
 *
 * This step makes the DRAFT shell (number, change note): one open DRAFT per style at a time, none on an archived style.
 * The BOM and routing steps fill it, copy a released revision into it, and release it.
 */

export const REVISION_STATUSES = ['DRAFT', 'RELEASED', 'OBSOLETE'] as const
export type RevisionStatus = (typeof REVISION_STATUSES)[number]

/** The database's own rule (the …_product_guards trigger), so a refusal is clear before it. */
export const styleRevisionMachine = defineMachine({
  name: 'style revision',
  states: REVISION_STATUSES,
  transitions: { DRAFT: ['RELEASED', 'OBSOLETE'], RELEASED: ['OBSOLETE'] },
})

export interface RevisionSummary {
  readonly revision: number
  readonly status: RevisionStatus
}

/** The next revision number: one more than the highest, 1 for the first. */
export const nextRevisionNumber = (revisions: readonly RevisionSummary[]): number => revisions.reduce((top, entry) => Math.max(top, entry.revision), 0) + 1

/** Why a new DRAFT revision cannot be made now (a 409), or null. */
export function newRevisionRefusal(styleStatus: StyleStatus, revisions: readonly RevisionSummary[]): string | null {
  if (styleStatus === 'ARCHIVED') return 'This style is archived: reactivate it before starting a revision.'
  const open = revisions.find((entry) => entry.status === 'DRAFT')
  if (open) return `Revision ${open.revision} is still a draft: change it, or release or abandon it, before starting another.`
  return null
}

/** The style's current revision: its RELEASED one, if any. */
export const currentRevision = <Revision extends RevisionSummary>(revisions: readonly Revision[]): Revision | null => revisions.find((entry) => entry.status === 'RELEASED') ?? null

/** Where a style stands with its revisions, for the style list: RELEASED, DRAFT (none released yet) or NONE. */
export function revisionState(revisions: readonly RevisionSummary[]): 'RELEASED' | 'DRAFT' | 'NONE' {
  if (revisions.some((entry) => entry.status === 'RELEASED')) return 'RELEASED'
  return revisions.some((entry) => entry.status === 'DRAFT') ? 'DRAFT' : 'NONE'
}
