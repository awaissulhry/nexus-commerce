import type { RequirementSource } from '../explode'

/**
 * Order-specific supply (B-W2b-306; PLN-072 "hard-pegged supply for special orders"), pure. A planner keeps a material of
 * the latest plan for ONE order line (MaterialRequirement.orderSpecific with the line and its party); the next runs carry
 * it: that order line's need of the material is a line of its own (planning/explode `orderSpecific`), netted only against
 * what is its own — stock its reservations hold, the purchase lines bought for it, its firm planned order — never free
 * stock or what other orders wait for, and nothing bought for it is counted for another order. A purchase line is "bought
 * for it" when it came from a line planned for that order line alone (all its sources that order line), so a mixed line a
 * planner pegged buys for every order until the next run splits it. The peg ends with the order line's need.
 */

export interface PegLine {
  readonly decision: string
  readonly orderSpecific: boolean
  readonly reservedForLineId: string | null
  readonly sources: readonly Pick<RequirementSource, 'orderLineId' | 'orderNumber' | 'lineSeq'>[]
}

/** Why the line cannot be kept for that order line (or for every order again: null) now; null: it can. */
export function pegProblem(line: PegLine, runStatus: string, orderLineId: string | null): string | null {
  if (runStatus !== 'DONE') return 'A newer plan replaced this line: keep the latest plan\'s line for the order instead.'
  if (line.decision !== 'OPEN') return `It is ${line.decision === 'ORDERED' ? 'ordered' : 'set aside'}: whom it is for is fixed now (its purchase order line says it).`
  if (orderLineId === null) return line.orderSpecific ? null : 'It is for every order already.'
  if (line.orderSpecific && line.reservedForLineId === orderLineId) return 'It is for that order line only already.'
  if (!line.sources.some((source) => source.orderLineId === orderLineId)) return 'That order line does not need this material in this plan: pick one of the orders behind the line.'
  return null
}

/** Whether a line was planned for one order line alone (each of its sources is that line): what it buys serves only it. */
export const plannedForAlone = (line: Pick<PegLine, 'orderSpecific' | 'reservedForLineId' | 'sources'>): boolean =>
  line.orderSpecific && line.reservedForLineId !== null && line.sources.length > 0 && line.sources.every((source) => source.orderLineId === line.reservedForLineId)

/** What the next run does with the peg, in words (the route's answer). */
export function pegWords(line: Pick<PegLine, 'sources'>, orderLineId: string | null): string {
  if (orderLineId === null) return 'The next run plans this material for every order again.'
  const source = line.sources.find((entry) => entry.orderLineId === orderLineId)
  const label = source ? `${source.orderNumber} line ${source.lineSeq}` : 'the order line'
  const others = new Set(line.sources.filter((entry) => entry.orderLineId !== orderLineId).map((entry) => entry.orderLineId)).size
  return others === 0
    ? `This material is planned for ${label} alone: what is bought from this line serves only it.`
    : `The next run plans ${label}'s need of this material on a line of its own (${others} other order ${others === 1 ? 'line needs' : 'lines need'} it too): buy for ${label} from that line.`
}
