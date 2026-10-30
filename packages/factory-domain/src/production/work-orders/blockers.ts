import type { Issue } from '../../core/errors'
import type { BusinessDate } from '../../core/time'
import { decimalOf } from '../../product/units/units'
import type { ReadinessWord } from '../../planning/readiness/readiness'
import { materialCheck, type MaterialLine, type ReleaseCheck } from './release'

/**
 * The release's W2a blockers (B-W2a-46; MES-004 "Release check with blockers"; design production.workorders wo-release
 * "material available or expected (W2a readiness)", wo-hold "floor devices refuse to start it and show the reason"),
 * pure. They join THE release check of ./release (the record's checklist and the release command's refusal are one
 * answer), so the screen never says a release would pass that the command refuses:
 *
 *   HOLDS     the work order is not on hold: no ACTIVE quality hold names it (B-W2a-26) and it is not ON_HOLD (a held
 *             DRAFT). Never overridden here: quality releases the hold (quality.holds.release), then the release can go.
 *   MATERIAL  W1's check (usable stock at the site less what the site's other released work orders still need) with the
 *             plan's readiness (B-W2a-22, PLN-086) beside it: a material short on hand now passes when the plan has it
 *             EXPECTED in time (a sent purchase order line arrives before the need) or RECEIVED (reserved for this work
 *             order). Any other short material blocks, in W1's words, and passes only with the planner's override and
 *             its reason (OVERRIDDEN). The readiness of a material the plan does not know (NOT_PLANNED: a repair, an
 *             order that is not planned) leaves W1's answer as it is — NOT_PLANNED is not a blocker by itself.
 *
 * A repair (B-W2a-12) takes HOLDS like any work order; its MATERIAL stays NOT_REQUIRED.
 */

/** An ACTIVE quality hold naming the work order (or the work order's own ON_HOLD state), as the check reads it. */
export interface HoldFact {
  /** The QualityHold's id; null for a work order ON_HOLD whose hold record is not a quality hold (an NCR). */
  readonly holdId: string | null
  /** The reason in words ("Customer request"), else its code. */
  readonly reason: string
  readonly placedAt: string
}

export function holdsCheck(number: string, holds: readonly HoldFact[]): ReleaseCheck {
  if (holds.length === 0) return { code: 'HOLDS', state: 'OK', message: `Work order ${number} is not on hold.`, problems: [] }
  const problems: Issue[] = holds.map((hold) => ({
    path: hold.holdId ? `holds/${hold.holdId}` : 'checks/HOLDS',
    message: `On hold since ${hold.placedAt.slice(0, 10)}: ${hold.reason}. Quality releases the hold first.`,
  }))
  return {
    code: 'HOLDS',
    state: 'BLOCKED',
    message: `Work order ${number} is on hold (${holds.map((hold) => hold.reason).join('; ')}): it is released only after quality releases ${holds.length === 1 ? 'the hold' : `its ${holds.length} holds`}.`,
    problems,
  }
}

/** The plan's word for one material of the work order (factory-domain planning/readiness MaterialReadiness). */
export interface MaterialReadinessFact {
  readonly itemId: string
  readonly itemColourId: string | null
  readonly word: Exclude<ReadinessWord, 'NOT_PLANNED'>
  readonly date: BusinessDate | null
  readonly reason: string
}

/** The words that let a material short on hand now pass: it arrives in time, or it is set aside for this work order. */
export const COVERS_A_SHORTAGE: readonly ReadinessWord[] = Object.freeze(['EXPECTED', 'RECEIVED'])

const keyOf = (line: { readonly itemId: string; readonly itemColourId: string | null }) => `${line.itemId}|${line.itemColourId ?? ''}`

/** Each short material with the plan's word for it (undefined: the plan has none). */
export function shortWithReadiness(lines: readonly MaterialLine[], readiness: readonly MaterialReadinessFact[]): Array<{ line: MaterialLine; readiness: MaterialReadinessFact | undefined }> {
  const byKey = new Map(readiness.map((entry) => [keyOf(entry), entry]))
  return lines.filter((line) => decimalOf(line.short).gt(0)).map((line) => ({ line, readiness: byKey.get(keyOf(line)) }))
}

/** W2a's MATERIAL: W1's check, where the plan's readiness covers a shortage that is expected in time. */
export function materialReadinessCheck(lines: readonly MaterialLine[], readiness: readonly MaterialReadinessFact[] | null, override: { readonly reason: string } | null): ReleaseCheck {
  const w1 = materialCheck(lines, override)
  if (readiness === null || w1.state === 'OK') return w1
  const short = shortWithReadiness(lines, readiness)
  const covered = short.filter((entry) => entry.readiness !== undefined && COVERS_A_SHORTAGE.includes(entry.readiness.word))
  if (short.length === 0 || covered.length < short.length) return w1
  const dates = covered.flatMap((entry) => (entry.readiness!.date ? [entry.readiness!.date] : [])).sort()
  const last = dates.at(-1)
  return {
    code: 'MATERIAL',
    state: 'OK',
    message: `${short.length} material(s) short on hand now are expected in time${last ? ` (the last by ${last})` : ''} or set aside for this work order: ${covered.map((entry) => entry.readiness!.reason).join(' ')}`,
    problems: [],
  }
}
