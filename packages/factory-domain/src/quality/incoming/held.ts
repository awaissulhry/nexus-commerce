import { Dec } from '../../tax/decimal'
import { HOLD_LIMITS } from '../holds/rules'
import type { UnitDecision } from './rules'

/**
 * B-W2b-GF5 (G367, G369): the hides an incoming inspection did not accept (B-W2b-98's hide-by-hide decision), pure. They are
 * held at once when the inspection is decided (apps/factory-api modules/quality/incoming hold.ts: a system hold whose source
 * is the inspection), and the lab's lot release waits while one of them is still in the lot, neither on hold nor decided by
 * quality since (modules/quality/lab; factory-domain quality/lab releaseChecklist's INCOMING check).
 *
 *   sampled   the hides of the sample decided REJECTED or TO_SORT: named one by one.
 *   outside   the decision counts more not accepted than the sample named (units outside it rejected or to sort): those
 *             hides are not told apart, so every hide of the lot outside the sample is held (the safe side, as a hold by
 *             genealogy ticks everything holdable); quality releases the ones that pass when it sorts them.
 */

export interface NotAcceptedFacts {
  /** The sample's hide results: the hide and what the inspector decided for it. */
  readonly results: readonly { readonly hideId: string; readonly decision: UnitDecision | string | null }[]
  /** Every hide of the inspection's lot, in the sample or not. */
  readonly lotHideIds: readonly string[]
  /** The decision's quantities (decimal text; a hide lot counts whole hides). */
  readonly rejected: string
  readonly toSort: string
}

export interface NotAccepted {
  /** Hides of the sample decided REJECTED or TO_SORT. */
  readonly sampled: readonly string[]
  /** Hides outside the sample held with them (every one, when units outside it were not accepted); else none. */
  readonly outside: readonly string[]
}

export function notAcceptedOf(facts: NotAcceptedFacts): NotAccepted {
  const sampled = facts.results.filter((result) => result.decision === 'REJECTED' || result.decision === 'TO_SORT').map((result) => result.hideId)
  const notAccepted = new Dec(facts.rejected || '0').plus(facts.toSort || '0')
  const beyondSample = notAccepted.minus(sampled.length)
  const inSample = new Set(facts.results.map((result) => result.hideId))
  const outside = beyondSample.greaterThan(0) ? facts.lotHideIds.filter((id) => !inSample.has(id)) : []
  return { sampled, outside }
}

/** The hold's words: the inspection and the hides it holds (the hold's own limit). */
export function incomingHoldNote(number: string, codes: readonly string[]): string {
  const shown = codes.length <= 20 ? codes.join(', ') : `${codes.slice(0, 20).join(', ')} and ${codes.length - 20} more`
  return `Incoming inspection ${number}: ${shown} not accepted (rejected or to sort), held until quality decides.`.slice(0, HOLD_LIMITS.reasonNote)
}

/** The hides of one hold at most (the hold's own limit): a larger set goes in several holds. */
export function holdChunks<T>(items: readonly T[]): T[][] {
  const chunks: T[][] = []
  for (let start = 0; start < items.length; start += HOLD_LIMITS.subjects) chunks.push(items.slice(start, start + HOLD_LIMITS.subjects))
  return chunks
}

/** The HOLD reasons an automatic hold of an inspection's hides takes, the first active one (OTHER asks for the words it has). */
export const INCOMING_HOLD_REASONS = Object.freeze(['QUALITY_CHECK', 'SUPPLIER_CHECK', 'OTHER'] as const)
