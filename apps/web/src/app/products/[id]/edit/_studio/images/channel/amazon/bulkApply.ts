/**
 * PES.7 — placing one master image into many matrix cells at once. Pure, tested.
 *
 * This is the shared core of the two surfaces the programme moved into P3: BULK APPLY (pick a
 * picture, pick where it goes) and SCOPED UPLOAD (upload a picture, then pick where it goes). They
 * are the same operation with different entry points, so the targeting is written once.
 *
 * 🔴 **Nothing is overwritten silently.** Every target is classified before anything is written,
 * and the counts are the operator's decision surface. The classes are not cosmetic — they are
 * genuinely different acts:
 *
 *   fill      the cell is empty; the picture is new there
 *   pin       the cell currently INHERITS a picture; writing makes it explicit for this bucket.
 *             Visually it may look unchanged, which is exactly why it is counted separately —
 *             an operator who thinks they filled 6 empties should not have silently pinned 4.
 *   overwrite the cell has a picture of its own, and it will be REPLACED. Named, always.
 *   skip      the slot is read-only in Amazon's schema, or the row is locked. Not written.
 */
import type { ResolvedCell } from './cascade'
import { ownRowAt, placeImage, type CellCoordinate, type ListingUpsert } from './edits'

export type TargetOutcome = 'fill' | 'pin' | 'overwrite' | 'skip'

export interface TargetPlan {
  at: CellCoordinate
  outcome: TargetOutcome
  /** Why a target is skipped, in words, so a silent no-op never happens. */
  reason?: string
}

export interface BulkPlan {
  targets: TargetPlan[]
  counts: Record<TargetOutcome, number>
  /** The upserts to send. Skipped targets contribute nothing. */
  upserts: ListingUpsert[]
  /** One sentence describing what pressing the button does. */
  summary: string
}

export function classifyTarget(args: {
  at: CellCoordinate
  resolved: ResolvedCell
  writable: boolean
}): TargetPlan {
  const { at, resolved, writable } = args
  if (!writable) {
    return { at, outcome: 'skip', reason: 'Amazon marks this slot read-only for this product type' }
  }
  if (resolved.row?.locked) {
    return { at, outcome: 'skip', reason: 'this row is locked' }
  }
  // A row of this coordinate's OWN — including a pictureless one — is a replacement.
  if (ownRowAt(resolved, at)) return { at, outcome: 'overwrite' }

  /*
   * 🔴 Anything with a PICTURE that this coordinate does not own is a PIN, whichever layer it came
   * from. The first version only checked `shared` and `master`, which missed the commonest case:
   * viewing market IT while the picture comes from the all-markets row. `ownRowAt` refuses that row
   * (correctly — editing IT must not change every market), so it fell through to `fill` and the
   * surface said "fill 3 empty slots" about a cell with a picture in it. Caught by using it.
   *
   * The test is simply "is there a picture here?", not which origin produced it — origins can be
   * added and this stays right.
   */
  if (resolved.url) return { at, outcome: 'pin' }
  return { at, outcome: 'fill' }
}

export function buildBulkPlan(args: {
  url: string
  sourceProductImageId?: string | null
  targets: Array<{ at: CellCoordinate; resolved: ResolvedCell; writable: boolean }>
}): BulkPlan {
  const { url, sourceProductImageId = null, targets } = args
  const plans = targets.map((t) => classifyTarget(t))
  const counts: Record<TargetOutcome, number> = { fill: 0, pin: 0, overwrite: 0, skip: 0 }
  for (const p of plans) counts[p.outcome]++

  const upserts = plans
    .map((p, i) => (p.outcome === 'skip'
      ? null
      : placeImage({ at: p.at, url, resolved: targets[i].resolved, sourceProductImageId })))
    .filter((u): u is ListingUpsert => u !== null)

  return { targets: plans, counts, upserts, summary: describe(counts) }
}

/**
 * What the button does, in one sentence.
 *
 * Overwrites lead when there are any: replacing a picture is the consequence an operator most needs
 * to see before pressing, and burying it after two happier numbers is how it gets missed.
 */
export function describe(counts: Record<TargetOutcome, number>): string {
  const total = counts.fill + counts.pin + counts.overwrite
  if (total === 0) {
    return counts.skip > 0
      ? `Nothing to write — all ${counts.skip} selected slot${counts.skip === 1 ? ' is' : 's are'} read-only or locked.`
      : 'No slots selected.'
  }
  const parts: string[] = []
  if (counts.overwrite > 0) parts.push(`REPLACE ${counts.overwrite} existing image${counts.overwrite === 1 ? '' : 's'}`)
  if (counts.fill > 0) parts.push(`fill ${counts.fill} empty slot${counts.fill === 1 ? '' : 's'}`)
  if (counts.pin > 0) parts.push(`pin ${counts.pin} inherited slot${counts.pin === 1 ? '' : 's'}`)
  const tail = counts.skip > 0 ? `, and skip ${counts.skip} read-only or locked.` : '.'
  return `This will ${parts.join(', ')}${tail}`
}
