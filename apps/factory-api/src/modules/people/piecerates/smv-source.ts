import type { Issue } from '@nexus/factory-domain/core/errors'
import type { BusinessDate } from '@nexus/factory-domain/core/time'
import { isGoverned } from '@nexus/factory-domain/product/minutes/rules'
import { ratePerPieceOf, type Rate, type RateInput } from '@nexus/factory-domain/people/piecerates/rates'
import { decimalOf, decimalText } from '@nexus/factory-domain/product/units/units'
import { readVersionsOf, smvOnDay, storedMinutesOf, MINUTES_OPERATION_COLUMNS } from '../../product/minutes/store'
import { refuseProblems } from './access'
import type { Db } from './store'

/**
 * Where piece rates take an operation's SMV (B-W2b-215; PRD-113: "the piece-rate tables read the approved version, never a
 * typed number"; c.c. art. 2101: rates follow the method's times). The SMV of a rate version is the one in force on the
 * version's first day:
 *
 *   governed     an operation with an approved SMV version (Products › Operations › Minutes): the approved version in
 *                force that day (else, before its first version's day, the operation's own numbers). A rate that types
 *                another SMV is refused in words; a rate copied from an earlier version takes the SMV of the day, and a
 *                rate on SMV × rate per minute its rate per piece again (the rate per minute is kept).
 *   not governed W1: the operation's typed SMV when the rate leaves it empty, or the rate's own (as B-W2b-34 built it).
 *
 * Read in the office scope (the office reads OperationTimeVersion; the floor never does). Piece pay itself stays behind
 * GATE-PIECE-PAY.
 */

export interface SmvOfDay {
  readonly standardMinutes: string
  readonly governed: boolean
  /** The approved version in force that day, or null (the operation's own numbers). */
  readonly versionNumber: number | null
}

/** The SMV of each operation on a day. */
export async function smvOn(db: Db, operationIds: readonly string[], day: BusinessDate): Promise<Map<string, SmvOfDay>> {
  const ids = [...new Set(operationIds)]
  const operations = ids.length === 0 ? [] : await db.operation.findMany({ where: { id: { in: ids } }, select: MINUTES_OPERATION_COLUMNS })
  const versionsOf = await readVersionsOf(db, ids)
  return new Map(
    operations.map((operation) => {
      const versions = versionsOf.get(operation.id) ?? []
      const { standardMinutes, version } = smvOnDay(storedMinutesOf(operation), versions, day)
      return [operation.id, { standardMinutes, governed: isGoverned(versions), versionNumber: version?.number ?? null }]
    }),
  )
}

const typed = (value: string | null | undefined): value is string => typeof value === 'string' && value.trim() !== ''

/**
 * Typed rates made whole for a version starting `day`: an empty SMV on SMV × rate per minute takes the SMV of the day; a
 * typed SMV of a governed operation must be the approved one (refused in words otherwise). Operations already checked.
 */
export async function withSmvOfDay(db: Db, inputs: readonly RateInput[], day: BusinessDate): Promise<RateInput[]> {
  const smv = await smvOn(
    db,
    inputs.map((input) => input.operationId),
    day,
  )
  const problems: Issue[] = []
  inputs.forEach((input, index) => {
    const of = smv.get(input.operationId)
    if (!of || !of.governed || !typed(input.standardMinutes)) return
    if (!/^\d+(?:\.\d+)?$/.test(input.standardMinutes.trim()) || !decimalOf(input.standardMinutes.trim()).eq(decimalOf(of.standardMinutes))) {
      problems.push({
        path: `rates/${index}/standardMinutes`,
        message: `The operation's approved SMV on ${day} is ${of.standardMinutes}${of.versionNumber === null ? '' : ` (version ${of.versionNumber})`}: leave the SMV empty to take it, or propose an SMV change in Products › Operations.`,
      })
    }
  })
  refuseProblems(problems, 'Some rates type an SMV that is not the approved one.')
  return inputs.map((input) => (input.basis === 'SMV_RATE' && !typed(input.standardMinutes) ? { ...input, standardMinutes: smv.get(input.operationId)?.standardMinutes ?? null } : input))
}

/** Rates copied from an earlier version, for a version starting `day`: a governed operation's SMV becomes the one of that day. */
export async function copiedWithSmvOfDay(db: Db, rates: readonly Rate[], day: BusinessDate): Promise<Rate[]> {
  if (rates.length === 0) return []
  const smv = await smvOn(
    db,
    rates.map((rate) => rate.operationId),
    day,
  )
  return rates.map((rate) => {
    const of = smv.get(rate.operationId)
    if (!of || !of.governed || rate.standardMinutes === null || decimalOf(rate.standardMinutes).eq(decimalOf(of.standardMinutes))) return rate
    const standardMinutes = decimalText(of.standardMinutes)
    return rate.basis === 'SMV_RATE' && rate.ratePerMinute !== null ? { ...rate, standardMinutes, ratePerPiece: ratePerPieceOf(standardMinutes, rate.ratePerMinute) } : { ...rate, standardMinutes }
  })
}
