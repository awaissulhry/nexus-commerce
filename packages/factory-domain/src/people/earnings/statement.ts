import type { MinorUnits } from '../../core/money'
import { Dec, type Decimal } from '../../tax/decimal'
import type { EarningsKind } from './rules'

/**
 * The worker statement (B-W2b-43; MES-261; c.c. art. 2101 c.3: the quantity of work done and the time taken; design
 * people.piecerates pop-up "Worker statement": pieces per operation · minutes · rates · earnings · make-up · disputes),
 * pure. Built from one person's lines of a period: what the ledger holds, plus what a preview has not booked yet. It is the
 * same statement in the office and on the floor. The amounts are minor units, the rates decimal text.
 *
 *   pieces per operation   the SCAN and TEAM_SPLIT lines by operation, rate and share (a team's share shows the team's pieces)
 *   minutes                the standard minutes earned (pieces × the operation's minutes)
 *   time                   paid time off standard, by code
 *   corrections            adjustments, and work of a locked month paid in this period
 *   bonus                  a standard-minute bonus scheme's figures (B-W2b-84): minutes present, standard minutes earned,
 *                          the threshold, the minutes above it and the BONUS lines' amount. Its pieces show at their rate
 *                          with no amount: they measure the bonus
 *   earnings               everything but the make-up (the bonus included)
 */

export interface PayLine {
  readonly kind: EarningsKind
  readonly operationCode: string | null
  readonly operationName: string | null
  /** Standard minutes per piece at the operation. */
  readonly standardMinutes: string | null
  readonly pieces: number | null
  /** MAKE_UP, OFF_STANDARD: the minutes paid; BONUS: the standard minutes above the threshold. */
  readonly minutes: string | null
  readonly rate: string | null
  readonly sharePct: string | null
  readonly amount: MinorUnits
  /** OFF_STANDARD: the code; else null. */
  readonly code: string | null
  /** A reversal counts against its line; a correction of an earlier month goes under corrections. */
  readonly correctsMonth: string | null
  readonly words: string | null
  /** Pieces a standard-minute bonus scheme does not pay by the piece (B-W2b-84): never added to a line they pay on. */
  readonly measuresBonus?: boolean | undefined
}

export interface StatementFacts {
  readonly currency: string
  readonly lines: readonly PayLine[]
  /** Ordinary minutes and approved overtime; null: the site has no attendance on. */
  readonly attendance: { readonly ordinaryMinutes: number; readonly approvedOvertimeMinutes: number } | null
  readonly makeUp: { readonly minutes: number; readonly ratePerMinute: string; readonly guaranteed: MinorUnits; readonly earned: MinorUnits; readonly amount: MinorUnits } | null
  readonly held: { readonly open: number; readonly counted: number; readonly notPaid: number }
  readonly disputes: { readonly open: number; readonly answered: number }
  /**
   * Pieces scrapped and sent to rework on the person's own scans; `othersScrap`, `othersRework`: of which their reasons put
   * down to others (paid as time, B-W2b-84). The rest follow the scheme's own-fault rule.
   */
  readonly defects: StatementDefects
  /** A standard-minute bonus scheme's figures of the period (amount: what this run computed); null: none applies. */
  readonly bonus: StatementBonus | null
}

export interface StatementDefects {
  readonly scrap: number
  readonly rework: number
  readonly othersScrap: number
  readonly othersRework: number
}

export interface StatementBonus {
  readonly minutesPresent: number
  readonly standardMinutes: string
  readonly thresholdMinutes: string
  readonly efficiencyPct: string
  readonly bonusMinutes: string
  readonly amount: MinorUnits
}

export interface StatementSummary {
  readonly currency: string
  readonly lines: { operationCode: string; operationName: string; pieces: number; minutes: string; rate: string; sharePct: string | null; amount: MinorUnits }[]
  readonly time: { code: string; minutes: string; rate: string; amount: MinorUnits }[]
  readonly corrections: { kind: EarningsKind; month: string | null; words: string | null; amount: MinorUnits }[]
  readonly attendance: StatementFacts['attendance']
  readonly makeUp: StatementFacts['makeUp']
  readonly held: StatementFacts['held']
  readonly disputes: StatementFacts['disputes']
  /** The fault split (B-W2b-84) is absent from a statement made before it: read it as 0. */
  readonly defects: Pick<StatementDefects, 'scrap' | 'rework'> & Partial<Pick<StatementDefects, 'othersScrap' | 'othersRework'>>
  /** B-W2b-84; absent from a statement made before it. */
  readonly bonus?: StatementBonus | null
}

export interface BuiltStatement {
  readonly summary: StatementSummary
  readonly earningsAmount: MinorUnits
  readonly makeUpAmount: MinorUnits
}

const text = (value: Decimal, places: number): string => value.toDecimalPlaces(places, Dec.ROUND_HALF_UP).toFixed(places)

/** The statement of one person's period. */
export function statementOf(facts: StatementFacts): BuiltStatement {
  const pieces = new Map<string, StatementSummary['lines'][number]>()
  const time = new Map<string, StatementSummary['time'][number]>()
  const corrections: StatementSummary['corrections'] = []
  let earningsAmount = 0
  let bonusAmount = 0
  let bonusLines = 0
  for (const line of facts.lines) {
    earningsAmount += line.amount
    if (line.kind === 'ADJUSTMENT' || line.correctsMonth !== null) {
      corrections.push({ kind: line.kind, month: line.correctsMonth, words: line.words, amount: line.amount })
    } else if (line.kind === 'BONUS') {
      // The bonus is its own figure, never a piece line.
      bonusAmount += line.amount
      bonusLines += 1
    } else if (line.kind === 'OFF_STANDARD') {
      const key = `${line.code ?? ''}|${line.rate ?? ''}`
      const before = time.get(key)
      const minutes = new Dec(before?.minutes ?? '0').plus(new Dec(line.minutes ?? '0'))
      time.set(key, { code: line.code ?? '', minutes: text(minutes, 3), rate: line.rate ?? '0', amount: (before?.amount ?? 0) + line.amount })
    } else {
      const key = `${line.operationCode ?? ''}|${line.rate ?? ''}|${line.sharePct ?? ''}|${line.measuresBonus ? 'bonus' : ''}`
      const before = pieces.get(key)
      const count = (before?.pieces ?? 0) + (line.pieces ?? 0)
      const minutes = new Dec(before?.minutes ?? '0').plus(new Dec(line.standardMinutes ?? '0').times(line.pieces ?? 0))
      pieces.set(key, { operationCode: line.operationCode ?? '', operationName: line.operationName ?? '', pieces: count, minutes: text(minutes, 3), rate: line.rate ?? '0', sharePct: line.sharePct, amount: (before?.amount ?? 0) + line.amount })
    }
  }
  // A line that netted out (reported, then undone) is not work done.
  const lines = [...pieces.values()].filter((line) => line.pieces !== 0 || line.amount !== 0).sort((a, b) => a.operationCode.localeCompare(b.operationCode) || new Dec(b.rate).comparedTo(new Dec(a.rate)))
  const timeLines = [...time.values()].filter((line) => line.amount !== 0).sort((a, b) => a.code.localeCompare(b.code))
  const bonus = facts.bonus || bonusLines > 0 ? { ...(facts.bonus ?? { minutesPresent: 0, standardMinutes: '0.000', thresholdMinutes: '0.000', efficiencyPct: '0.00', bonusMinutes: '0.000' }), amount: bonusAmount } : null
  return {
    summary: { currency: facts.currency, lines, time: timeLines, corrections, attendance: facts.attendance, makeUp: facts.makeUp, held: facts.held, disputes: facts.disputes, defects: facts.defects, bonus },
    earningsAmount,
    makeUpAmount: facts.makeUp?.amount ?? 0,
  }
}
