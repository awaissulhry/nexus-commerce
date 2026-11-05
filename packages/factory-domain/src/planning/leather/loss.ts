import { MAX_WASTAGE_PCT } from '../../product/bom/rules'
import { Dec, HUNDRED, ZERO, type Decimal, type DecimalInput } from '../../tax/decimal'

/**
 * The cutting loss of a style (B-W2b-132; PLN-109; design planning.leather "Planned vs actual yield", pop-up "Change cutting
 * loss for style X"), pure. One meaning everywhere: the LOSS is the share of the hide area cut from that does not become
 * pieces, percent = 100 − yield % (factory-domain production/yield/rules: waste ÷ area used). The plan carries it in two
 * places of a style revision, which a change keeps in step:
 *
 *   planned hide yield   StyleRevision.plannedHideYieldPct = 100 − loss (what cutting compares the real yield with);
 *   leather wastage      each leather BOM line's wastagePct, added ON TOP of the net area: need = net × (1 + w ÷ 100),
 *                        so loss = w ÷ (100 + w) × 100 and w = loss ÷ (100 − loss) × 100 (the plan run and quotes use it).
 *
 * The planned loss of a revision: from its planned hide yield when it sets one (STYLE), else from its leather lines'
 * wastage when they agree (BOM), else unknown. The ACTUAL loss is the cut log's (live entries whose pattern is known).
 *
 * A proposal ("Set loss 12 % → 14 %") needs at least LOSS_MIN_CUTS cuts of the style and an actual loss at least
 * LOSS_DRIFT_POINTS away from the planned one; it proposes the actual loss rounded to a whole percent, never above
 * MAX_LOSS_PCT (the wastage a BOM line may carry). A person accepts it (it goes into the style's draft revision) or
 * dismisses it with a reason: a dismissed proposal stays quiet until it changes or LOSS_MIN_CUTS more cuts came in.
 * Numbers are exact decimals (never a float); percentages have two places.
 */

export const LOSS_MIN_CUTS = 5
export const LOSS_DRIFT_POINTS = '1.00'
/** The loss whose wastage is the BOM's maximum (60 % on top → 37.5 % of the area cut). */
export const MAX_LOSS_PCT = new Dec(MAX_WASTAGE_PCT).times(HUNDRED).div(new Dec(MAX_WASTAGE_PCT).plus(HUNDRED)).toDecimalPlaces(2, Dec.ROUND_DOWN).toFixed(2)
/** How far back the cuts a proposal rests on go, in days. */
export const LOSS_WINDOW_DAYS = 180

const dec = (value: DecimalInput): Decimal => new Dec(value.toString())
const pct2 = (value: Decimal): string => value.toDecimalPlaces(2, Dec.ROUND_HALF_UP).toFixed(2)

/** The loss a leather line's wastage carries: w ÷ (100 + w) × 100, two places. */
export function lossOfWastage(wastagePct: DecimalInput): string {
  const w = dec(wastagePct)
  return pct2(w.times(HUNDRED).div(w.plus(HUNDRED)))
}

/** The wastage a leather line carries for a loss: loss ÷ (100 − loss) × 100, four places (the column's scale). */
export function wastageOfLoss(lossPct: DecimalInput): string {
  const loss = dec(lossPct)
  return loss.times(HUNDRED).div(HUNDRED.minus(loss)).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)
}

/** The planned hide yield for a loss: 100 − loss, four places. */
export const yieldOfLoss = (lossPct: DecimalInput): string => HUNDRED.minus(dec(lossPct)).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4)

/** The loss a yield leaves: 100 − yield, two places. */
export const lossOfYield = (yieldPct: DecimalInput): string => pct2(HUNDRED.minus(dec(yieldPct)))

export const LOSS_SOURCES = ['STYLE', 'BOM'] as const
export type LossSource = (typeof LOSS_SOURCES)[number]

/** A revision's planned loss: its planned hide yield (STYLE), else its leather lines' wastage when they agree (BOM). */
export function plannedLossOf(revision: { readonly plannedHideYieldPct: DecimalInput | null; readonly leatherWastages: readonly DecimalInput[] }): { lossPct: string | null; source: LossSource | null } {
  if (revision.plannedHideYieldPct !== null) return { lossPct: lossOfYield(revision.plannedHideYieldPct), source: 'STYLE' }
  const wastages = [...new Set(revision.leatherWastages.map((value) => dec(value).toFixed(4)))]
  return wastages.length === 1 ? { lossPct: lossOfWastage(wastages[0]!), source: 'BOM' } : { lossPct: null, source: null }
}

/** A loss someone types or accepts: 0 to MAX_LOSS_PCT, at most two places; the problem in words, or null. */
export function lossProblem(value: string): string | null {
  if (!/^\d{1,3}(\.\d{1,2})?$/.test(value)) return 'A cutting loss is a percentage with at most two decimals.'
  const loss = dec(value)
  if (loss.isNegative() || loss.gt(MAX_LOSS_PCT)) return `A cutting loss is 0 to ${MAX_LOSS_PCT} % (the wastage a BOM line may carry is at most ${MAX_WASTAGE_PCT} %).`
  return null
}

export const LOSS_DECISIONS = ['ACCEPTED', 'DISMISSED'] as const
export type LossDecision = (typeof LOSS_DECISIONS)[number]

export interface LossDecisionFacts {
  readonly decision: LossDecision
  readonly toPct: string
  /** The cuts the decided proposal rested on. */
  readonly cuts: number
}

export const PROPOSAL_STATES = ['TOO_FEW', 'IN_LINE', 'PROPOSED', 'DISMISSED', 'ACCEPTED'] as const
export type ProposalState = (typeof PROPOSAL_STATES)[number]

export interface LossProposal {
  readonly state: ProposalState
  /** The planned loss now (null: unknown). */
  readonly fromPct: string | null
  /** What the cuts say, rounded to a whole percent (null with too few cuts). */
  readonly toPct: string | null
  /** The cuts it rests on. */
  readonly cuts: number
}

/**
 * What the yield grid proposes for one style (rules in the header). `last` is the latest decision about the style at the
 * site: ACCEPTED keeps the row quiet while the proposal is the same (the change waits for a released revision); DISMISSED
 * until the proposal changes or LOSS_MIN_CUTS more cuts came in.
 */
export function lossProposal(input: { readonly cuts: number; readonly actualLossPct: DecimalInput | null; readonly plannedLossPct: DecimalInput | null; readonly last: LossDecisionFacts | null }): LossProposal {
  const fromPct = input.plannedLossPct === null ? null : pct2(dec(input.plannedLossPct))
  if (input.cuts < LOSS_MIN_CUTS || input.actualLossPct === null) return { state: 'TOO_FEW', fromPct, toPct: null, cuts: input.cuts }
  const actual = dec(input.actualLossPct)
  const whole = Dec.min(dec(MAX_LOSS_PCT), Dec.max(ZERO, actual.toDecimalPlaces(0, Dec.ROUND_HALF_UP)))
  const toPct = whole.toFixed(2)
  const inLine = fromPct !== null && (actual.minus(fromPct).abs().lt(LOSS_DRIFT_POINTS) || dec(fromPct).toDecimalPlaces(0, Dec.ROUND_HALF_UP).eq(whole))
  if (inLine) return { state: 'IN_LINE', fromPct, toPct, cuts: input.cuts }
  const last = input.last
  if (last && dec(last.toPct).eq(whole)) {
    if (last.decision === 'ACCEPTED') return { state: 'ACCEPTED', fromPct, toPct, cuts: input.cuts }
    if (input.cuts < last.cuts + LOSS_MIN_CUTS) return { state: 'DISMISSED', fromPct, toPct, cuts: input.cuts }
  }
  return { state: 'PROPOSED', fromPct, toPct, cuts: input.cuts }
}

/** The proposal a decision is about still stands as the person saw it (same loss, same cuts), else it moved. */
export const proposalStands = (proposal: LossProposal, seen: { readonly toPct: string; readonly cuts: number }): boolean =>
  (proposal.state === 'PROPOSED' || proposal.state === 'DISMISSED' || proposal.state === 'ACCEPTED') && proposal.toPct !== null && dec(proposal.toPct).eq(seen.toPct) && proposal.cuts === seen.cuts

/** A dismissal's reason: 3 to 500 characters; the problem in words, or null. */
export function dismissReasonProblem(reason: string | null | undefined): string | null {
  const text = (reason ?? '').trim()
  if (text.length < 3) return 'Say why, in at least 3 characters.'
  if (text.length > 500) return 'At most 500 characters.'
  return null
}
