import type { LineQuality } from '@nexus/factory-domain/production/boards/board'
import { lineDhu } from '@nexus/factory-domain/quality/inprocess/rules'
import type { CommandTx } from '../../../core/command'

/**
 * The line's quality of a day (B-W2b-99; QHS-042; design floor.display "Quality: DHU today for the line", floor.inline
 * header "DHU today (line)"): from the line's decided END-OF-LINE checks, defects per 100 pieces looked at. It replaces the
 * W2b-1 estimate (B-W2b-50: scrap and rework garments of the line's scans over its good and scrap) as soon as the line has
 * one end-of-line check that day; until then the board keeps the estimate and says so (`source`). Line totals only, never
 * a person (Statuto art. 4; Owner answer F2).
 */

export type QualitySource = 'END_OF_LINE' | 'ESTIMATE'

export interface LineDayQuality extends LineQuality {
  /** Where the DHU comes from: the line's end-of-line checks, or the W2b-1 estimate from scrap and rework. */
  readonly source: QualitySource
}

/** The line's end-of-line checks decided in the day's range: defects, pieces, checks and the DHU. */
export async function endOfLineDhu(db: Pick<CommandTx, 'inProcessCheck'>, lineId: string, range: { readonly start: Date; readonly end: Date }) {
  const checks = await db.inProcessCheck.findMany({
    where: { lineId, kind: 'END_OF_LINE', status: 'DECIDED', decidedAt: { gte: range.start, lt: range.end } },
    select: { kind: true, status: true, pieces: true, defects: true },
  })
  return lineDhu(checks)
}

/** The board's quality: the end-of-line DHU when the line has a check that day, else the estimate it had. */
export async function lineQualityOf(db: Pick<CommandTx, 'inProcessCheck'>, lineId: string, range: { readonly start: Date; readonly end: Date }, estimate: LineQuality): Promise<LineDayQuality> {
  const measured = await endOfLineDhu(db, lineId, range)
  if (measured.checks === 0) return { ...estimate, source: 'ESTIMATE' }
  return { defects: measured.defects, units: measured.pieces, dhu: measured.dhu, source: 'END_OF_LINE' }
}
